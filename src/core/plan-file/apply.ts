import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type Database from 'better-sqlite3';

import { closeDatabase, getDatabase } from '../db/database.js';
import { PACKAGE_ROOT } from '../paths.js';
import { acquireApplyLock } from './apply-lock.js';
import type { PlanFile, PlanStep } from './schema.js';

const BLOG_ENTRY = resolve(PACKAGE_ROOT, 'dist/cli/index.js');
const TAIL_BYTES = 2048;

export interface StepReceipt {
  step_number: number;
  command: string;
  args: string[];
  status: 'completed' | 'failed' | 'skipped';
  exit_code: number;
  stdout_tail: string;
  stderr_tail: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
}

export interface Receipt {
  plan_id: string;
  // Hash of the plan that wrote this receipt. Authoritative copy lives in
  // `agent_plan_runs.plan_payload_hash`; this field is a pure MIRROR. Neither
  // step-skip authority (which reads `agent_plan_steps`) nor conflict
  // detection (which queries `agent_plan_runs.completed_at`) consults the
  // JSON. Tampering with it is a no-op; the receipt is overwriteable audit.
  plan_payload_hash: string;
  slug: string;
  workspace_root: string;
  applied_at: string;
  completed_at: string | null;
  overall_exit: number;
  steps: StepReceipt[];
}

export type ApplyErrorCode =
  | 'UNKNOWN_COMMAND'
  | 'STEP_FAILED'
  | 'RECEIPT_CONFLICT'
  | 'RECEIPT_HASH_MISMATCH'
  | 'CRASH_RECOVERY_REQUIRED';

export class ApplyError extends Error {
  constructor(public readonly code: ApplyErrorCode, message: string) {
    super(message);
    this.name = 'ApplyError';
  }
}

export interface ApplyOptions {
  restart?: boolean;
  receiptPath?: string;
  // Binary to spawn. Defaults to `node dist/cli/index.js` resolved from the
  // package root. Overridable for tests running against a different entry.
  binOverride?: { cmd: string; prefixArgs: string[] };
  // Workspace DB path. Defaults to `<plan.workspace_root>/.blog-agent/state.db`.
  // Override lets tests point at an isolated DB without touching the live one.
  dbPath?: string;
  // Plan-apply lock path. Defaults to
  // `<workspace>/.blog-agent/plans/.<slug>.apply.lock` (slug-scoped, not
  // plan_id-scoped) so different plans for the same slug serialize instead
  // of racing. Override lets tests verify lock contention without racing
  // real processes.
  lockPath?: string;
}

export interface ApplyResult {
  receipt: Receipt;
  overall_exit: number;
}

function tail(bytes: Buffer, n: number): string {
  if (bytes.length <= n) return bytes.toString('utf8');
  return bytes.subarray(bytes.length - n).toString('utf8');
}

// Convert a PlanStep into the argv for the `blog` binary. The `command` field
// is the full command path ("blog research finalize"); we strip the leading
// "blog " and append the step's positional args.
export function stepToArgv(step: PlanStep): string[] {
  if (!step.command.startsWith('blog')) {
    throw new ApplyError(
      'UNKNOWN_COMMAND',
      `step command must start with "blog " (got ${JSON.stringify(step.command)})`,
    );
  }
  const afterBlog = step.command.slice('blog'.length).trim();
  const commandWords = afterBlog.length === 0 ? [] : afterBlog.split(/\s+/);
  return [...commandWords, ...step.args];
}

function writeReceiptAtomic(path: string, receipt: Receipt): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(receipt, null, 2) + '\n');
  // Rename is atomic on POSIX; approximates atomic on Windows.
  renameSync(tmp, path);
}

// Default receipt path: `.blog-agent/plans/<slug>.receipt.json` relative to the
// workspace root. Callers can override via opts.receiptPath (tests).
export function defaultReceiptPath(workspaceRoot: string, slug: string): string {
  return resolve(workspaceRoot, '.blog-agent', 'plans', `${slug}.receipt.json`);
}

function defaultDbPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, '.blog-agent', 'state.db');
}

function defaultLockPath(workspaceRoot: string, slug: string): string {
  return resolve(workspaceRoot, '.blog-agent', 'plans', `.${slug}.apply.lock`);
}

// Pre-spawn sentinel path for crash recovery. Written BEFORE spawning a
// step, deleted AFTER the DB record commits. If a sentinel exists for a
// step that has no completed DB row at resume time, the parent process
// died between child exit and recordStep — the child may have mutated
// domain state successfully, but the parent cannot tell. Rerunning
// blindly is unsafe (non-idempotent commands duplicate state or hard-fail
// on re-entry). The presence of a sentinel forces the operator to use
// --restart and consciously discard the prior run (Codex Pass-7 High).
function attemptSentinelPath(
  workspaceRoot: string,
  planId: string,
  stepNumber: number,
): string {
  return resolve(
    workspaceRoot,
    '.blog-agent',
    'plans',
    `.${planId}.attempt-${stepNumber}`,
  );
}

// -- DB helpers --------------------------------------------------------------

interface AgentPlanRunRow {
  plan_id: string;
  plan_payload_hash: string;
  slug: string;
  workspace_root: string;
  applied_at: string;
  completed_at: string | null;
  overall_exit: number;
}

interface AgentPlanStepRow {
  plan_id: string;
  step_number: number;
  command: string;
  args_json: string;
  status: 'completed' | 'failed' | 'skipped';
  exit_code: number;
  stdout_tail: string;
  stderr_tail: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
}

function loadRun(db: Database.Database, planId: string): AgentPlanRunRow | null {
  const row = db
    .prepare('SELECT * FROM agent_plan_runs WHERE plan_id = ?')
    .get(planId) as AgentPlanRunRow | undefined;
  return row ?? null;
}

function clearRun(db: Database.Database, planId: string): void {
  // FK ON DELETE CASCADE on agent_plan_steps wipes the dependent rows.
  db.prepare('DELETE FROM agent_plan_runs WHERE plan_id = ?').run(planId);
}

// Called during --restart. Deletes every OPEN run for the slug — including
// rows from OTHER plan_ids — so a crashed prior plan doesn't leave
// RECEIPT_CONFLICT debt that permanently blocks every future plan on that
// slug (Codex Pass 2, High). Completed rows are preserved as audit history.
function clearOpenRunsForSlug(db: Database.Database, slug: string): void {
  db.prepare(
    'DELETE FROM agent_plan_runs WHERE slug = ? AND completed_at IS NULL',
  ).run(slug);
}

function insertRun(
  db: Database.Database,
  plan: PlanFile,
  planPayloadHash: string,
  appliedAt: string,
): void {
  db.prepare(
    `INSERT INTO agent_plan_runs
       (plan_id, plan_payload_hash, slug, workspace_root, applied_at, completed_at, overall_exit)
     VALUES (?, ?, ?, ?, ?, NULL, 0)`,
  ).run(plan.plan_id, planPayloadHash, plan.slug, plan.workspace_root, appliedAt);
}

function updateRunOverall(db: Database.Database, planId: string, overallExit: number): void {
  db.prepare('UPDATE agent_plan_runs SET overall_exit = ? WHERE plan_id = ?').run(
    overallExit,
    planId,
  );
}

function finalizeRun(db: Database.Database, planId: string, completedAt: string): void {
  db.prepare(
    'UPDATE agent_plan_runs SET completed_at = ?, overall_exit = 0 WHERE plan_id = ?',
  ).run(completedAt, planId);
}

function loadCompletedStepNumbers(db: Database.Database, planId: string): Set<number> {
  const rows = db
    .prepare(
      "SELECT step_number FROM agent_plan_steps WHERE plan_id = ? AND status = 'completed'",
    )
    .all(planId) as { step_number: number }[];
  return new Set(rows.map((r) => r.step_number));
}

function loadAllSteps(db: Database.Database, planId: string): AgentPlanStepRow[] {
  return db
    .prepare('SELECT * FROM agent_plan_steps WHERE plan_id = ? ORDER BY step_number ASC')
    .all(planId) as AgentPlanStepRow[];
}

function recordStep(
  db: Database.Database,
  planId: string,
  step: StepReceipt,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO agent_plan_steps
       (plan_id, step_number, command, args_json, status, exit_code,
        stdout_tail, stderr_tail, started_at, completed_at, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    planId,
    step.step_number,
    step.command,
    JSON.stringify(step.args),
    step.status,
    step.exit_code,
    step.stdout_tail,
    step.stderr_tail,
    step.started_at,
    step.completed_at,
    step.duration_ms,
  );
}

function buildReceiptFromDb(db: Database.Database, planId: string): Receipt | null {
  const run = loadRun(db, planId);
  if (!run) return null;
  const rows = loadAllSteps(db, planId);
  const steps: StepReceipt[] = rows.map((r) => ({
    step_number: r.step_number,
    command: r.command,
    args: JSON.parse(r.args_json) as string[],
    status: r.status,
    exit_code: r.exit_code,
    stdout_tail: r.stdout_tail,
    stderr_tail: r.stderr_tail,
    started_at: r.started_at,
    completed_at: r.completed_at,
    duration_ms: r.duration_ms,
  }));
  return {
    plan_id: run.plan_id,
    plan_payload_hash: run.plan_payload_hash,
    slug: run.slug,
    workspace_root: run.workspace_root,
    applied_at: run.applied_at,
    completed_at: run.completed_at,
    overall_exit: run.overall_exit,
    steps,
  };
}

// -- main runner -------------------------------------------------------------

export function applyPlan(plan: PlanFile, opts: ApplyOptions = {}): ApplyResult {
  // applyPlan is only reachable via validatePlanForApply, which guarantees a
  // non-null payload_hash. Assert defensively — an unhashed plan reaching
  // this code is a gate bypass and the DB's hash-binding property would
  // silently degrade.
  if (plan.payload_hash === null) {
    throw new ApplyError(
      'RECEIPT_HASH_MISMATCH',
      'plan.payload_hash is null — applyPlan must only run approved plans (run `blog agent approve` first).',
    );
  }
  const planHash = plan.payload_hash;

  const receiptPath = opts.receiptPath ?? defaultReceiptPath(plan.workspace_root, plan.slug);
  const dbPath = opts.dbPath ?? defaultDbPath(plan.workspace_root);
  const lockPath = opts.lockPath ?? defaultLockPath(plan.workspace_root, plan.slug);

  // Acquire the plan-scoped exclusive lock BEFORE opening the DB and holding
  // it for the entire apply run. Without this, two concurrent
  // `blog agent apply` processes on the same plan both observe the same
  // starting DB state, both spawn `blog` for the remaining steps, and race
  // to write back — duplicate side effects, last-writer-wins receipt
  // (Codex adversarial review, High #2).
  const releaseLock = acquireApplyLock(lockPath);
  let db: Database.Database | null = null;
  try {
    db = getDatabase(dbPath);

    // Under a single write transaction: reconcile any existing run row with
    // the current plan's hash, honor --restart, and seed a new run if
    // needed. Holding the write lock here means the DB conflict check
    // below doesn't race with another apply process (though the apply lock
    // already serializes us at a coarser granularity).
    const reconcile = db.transaction(() => {
      const existing = loadRun(db!, plan.plan_id);

      // DB-authoritative conflict check: is there an OPEN run for this
      // slug with a DIFFERENT plan_id? If so, refusing prevents a new plan
      // from silently overwriting an in-flight one's audit trail. The
      // receipt JSON is NOT consulted here — it's audit-only, and a
      // hand-edited receipt cannot force a false RECEIPT_CONFLICT
      // (Codex adversarial review, Medium).
      if (!opts.restart) {
        const otherOpen = db!
          .prepare(
            `SELECT plan_id FROM agent_plan_runs
             WHERE slug = ? AND plan_id != ? AND completed_at IS NULL`,
          )
          .get(plan.slug, plan.plan_id) as { plan_id: string } | undefined;
        if (otherOpen) {
          throw new ApplyError(
            'RECEIPT_CONFLICT',
            `slug=${plan.slug} has an open run for plan_id=${otherOpen.plan_id} ` +
              `in agent_plan_runs, but this plan is plan_id=${plan.plan_id}. ` +
              `Finish or --restart the other plan first, or --restart this one to discard it.`,
          );
        }
      }

      if (opts.restart) {
        // Wipe every open run for this slug before inserting the fresh one —
        // including rows owned by other plan_ids (crashed prior plans). This
        // makes `blog agent apply --restart` the documented recovery path
        // from arbitrary stuck slug state, instead of accumulating
        // RECEIPT_CONFLICT debt on every subsequent plan.
        clearOpenRunsForSlug(db!, plan.slug);
        clearRun(db!, plan.plan_id);
        insertRun(db!, plan, planHash, new Date().toISOString());
      } else if (existing) {
        if (existing.plan_payload_hash !== planHash) {
          // The ONLY path to RECEIPT_HASH_MISMATCH under DB authority:
          // same plan_id has been re-approved with different content. The
          // stored completions reference a different plan shape; resuming
          // would skip steps the operator has since rewritten.
          throw new ApplyError(
            'RECEIPT_HASH_MISMATCH',
            `plan_id=${plan.plan_id} was previously applied at payload_hash=${existing.plan_payload_hash}, ` +
              `but the current plan has payload_hash=${planHash}. The plan was re-approved with different content. ` +
              `Use --restart to discard the prior run state.`,
          );
        }
      } else {
        insertRun(db!, plan, planHash, new Date().toISOString());
      }
    });
    reconcile();

    // Derive skip authority from the DB, not the receipt JSON.
    const completedStepNumbers = loadCompletedStepNumbers(db, plan.plan_id);
    const run = loadRun(db, plan.plan_id);
    if (!run) {
      // Defensive — should be unreachable; insertRun() was just called.
      throw new Error(`internal: agent_plan_runs row missing for plan_id=${plan.plan_id}`);
    }

    // Crash-recovery check: if any step has a pre-spawn sentinel but NO
    // completed DB row, the prior parent died between child exit and
    // recordStep. The child may have mutated domain state successfully
    // (non-idempotent commands like `blog update start` or `blog publish
    // start` cannot be blindly re-run). Force operator to --restart so
    // they consciously discard the prior run instead of silently
    // duplicating work (Codex Pass-7 High).
    if (!opts.restart) {
      for (let i = 0; i < plan.steps.length; i++) {
        const stepNumber = i + 1;
        const sentinelPath = attemptSentinelPath(plan.workspace_root, plan.plan_id, stepNumber);
        if (existsSync(sentinelPath) && !completedStepNumbers.has(stepNumber)) {
          throw new ApplyError(
            'CRASH_RECOVERY_REQUIRED',
            `step ${stepNumber} has an attempt sentinel (${sentinelPath}) but no ` +
              `completed DB row. The prior apply crashed between child exit and ` +
              `completion record — the child may have succeeded against domain state. ` +
              `Re-running blindly is unsafe for non-idempotent commands. ` +
              `Inspect workspace state, then re-run with --restart to discard the prior run.`,
          );
        }
      }
    } else {
      // --restart path: clean up any lingering sentinels so they don't
      // trip the next non-restart run.
      for (let i = 0; i < plan.steps.length; i++) {
        const sentinelPath = attemptSentinelPath(plan.workspace_root, plan.plan_id, i + 1);
        try {
          unlinkSync(sentinelPath);
        } catch {
          /* absent — fine */
        }
      }
    }

    let overallExit = 0;
    const bin = opts.binOverride ?? { cmd: process.execPath, prefixArgs: [BLOG_ENTRY] };

    for (let i = 0; i < plan.steps.length; i++) {
      const stepNumber = i + 1;
      const step = plan.steps[i];
      if (completedStepNumbers.has(stepNumber)) continue;

      // Write the pre-spawn sentinel BEFORE spawning. If the parent dies
      // while the child is running (or between child exit and
      // recordStep), the sentinel survives and the next apply will trip
      // the CRASH_RECOVERY_REQUIRED check above.
      const sentinelPath = attemptSentinelPath(plan.workspace_root, plan.plan_id, stepNumber);
      mkdirSync(dirname(sentinelPath), { recursive: true });
      writeFileSync(sentinelPath, new Date().toISOString());

      const argv = stepToArgv(step);
      // Pin the spawned child to plan.workspace_root at BOTH levels:
      //  (1) prepend `--workspace <plan.workspace_root>` to argv so the
      //      child's startup shim takes the override path with highest
      //      precedence.
      //  (2) scrub BLOG_WORKSPACE from child env so even if the shim
      //      behavior regresses, the env-var fallback can't redirect the
      //      child to a different workspace.
      // Without this, a parent invocation like
      //   BLOG_WORKSPACE=/other blog --workspace /plan-ws agent apply ...
      // would pass parent validation (parent sees /plan-ws) but spawn
      // every step with the inherited BLOG_WORKSPACE, so the child's
      // startup shim could chdir to /other — mutating a different
      // workspace than the plan's hash binds to (Codex Pass-6 High).
      const pinnedArgv = ['--workspace', plan.workspace_root, ...argv];
      const pinnedEnv: NodeJS.ProcessEnv = { ...process.env };
      delete pinnedEnv.BLOG_WORKSPACE;

      const t0 = Date.now();
      const started_at = new Date(t0).toISOString();
      const result = spawnSync(bin.cmd, [...bin.prefixArgs, ...pinnedArgv], {
        cwd: plan.workspace_root,
        env: pinnedEnv,
        encoding: 'buffer',
      });
      const t1 = Date.now();

      const exitCode = result.status ?? (result.signal ? 128 : 1);
      const stdout_tail = tail(result.stdout ?? Buffer.alloc(0), TAIL_BYTES);
      const stderr_tail = tail(result.stderr ?? Buffer.alloc(0), TAIL_BYTES);

      const stepReceipt: StepReceipt = {
        step_number: stepNumber,
        command: step.command,
        args: step.args,
        status: exitCode === 0 ? 'completed' : 'failed',
        exit_code: exitCode,
        stdout_tail,
        stderr_tail,
        started_at,
        completed_at: new Date(t1).toISOString(),
        duration_ms: t1 - t0,
      };

      // Record the step atomically in the DB first, THEN refresh the
      // receipt mirror. If a crash happens between the two writes, the DB
      // remains authoritative on next resume — the receipt is best-effort
      // audit and may briefly lag.
      recordStep(db, plan.plan_id, stepReceipt);

      // Delete the pre-spawn sentinel AFTER the DB record commits. If we
      // crashed between spawn and this line, the sentinel survives and
      // the next resume trips CRASH_RECOVERY_REQUIRED. Non-fatal on
      // unlink failure — resume-time check will revert to the "exists
      // but no DB row" branch if the sentinel lingers.
      try {
        unlinkSync(sentinelPath);
      } catch {
        /* already gone — fine */
      }

      if (exitCode !== 0) {
        overallExit = exitCode;
        updateRunOverall(db, plan.plan_id, overallExit);
        const partial = buildReceiptFromDb(db, plan.plan_id);
        if (partial) writeReceiptAtomic(receiptPath, partial);
        throw new ApplyError(
          'STEP_FAILED',
          `step ${stepNumber} (${step.command}) exited ${exitCode}. Receipt: ${receiptPath}`,
        );
      }

      // Refresh receipt mirror on every successful step — resumers reading
      // the JSON see live progress.
      const mid = buildReceiptFromDb(db, plan.plan_id);
      if (mid) writeReceiptAtomic(receiptPath, mid);
    }

    finalizeRun(db, plan.plan_id, new Date().toISOString());
    const final = buildReceiptFromDb(db, plan.plan_id);
    if (!final) {
      throw new Error(`internal: agent_plan_runs row vanished for plan_id=${plan.plan_id}`);
    }
    writeReceiptAtomic(receiptPath, final);
    return { receipt: final, overall_exit: overallExit };
  } finally {
    if (db) closeDatabase(db);
    releaseLock();
  }
}
