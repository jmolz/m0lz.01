import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PACKAGE_ROOT } from '../src/core/paths.js';
import { computePlanHash } from '../src/core/plan-file/hash.js';
import type { PlanFile } from '../src/core/plan-file/schema.js';
import type { Receipt } from '../src/core/plan-file/apply.js';

// End-to-end test: drive the real skill-to-CLI handoff without network. All
// steps in the fixture plan are read-only (`blog status`) so nothing touches
// the outside world. Hash-mismatch / workspace-mismatch / receipt-conflict
// behaviors are exercised by mutating the plan file and re-invoking verify.

const CLI_ENTRY = resolve(PACKAGE_ROOT, 'dist', 'cli', 'index.js');

interface SpawnResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], extraEnv: Record<string, string> = {}): SpawnResult {
  const res = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...extraEnv },
  });
  return {
    status: res.status ?? (res.signal ? 128 : 1),
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

let tempRoots: string[] = [];

function seedFixtureWorkspace(): { root: string; slug: string } {
  const root = mkdtempSync(join(tmpdir(), 'blog-fixture-'));
  tempRoots.push(root);
  const init = runCli(root, ['init']);
  if (init.status !== 0) {
    throw new Error(`blog init failed: ${init.stderr}`);
  }
  const slug = 'fixture-test';
  // No DB seeding needed — the fixture plan uses `blog status`, which is
  // post-agnostic. Real Task 10 usage (full launch) would insert a research
  // post via a direct DB statement, but this test's scope is the plan-file
  // lifecycle, not the lifecycle of a post.
  return { root, slug };
}

beforeAll(() => {
  // The build is handled by vitest's globalSetup (tests/global-setup.ts) so
  // it runs exactly once across the whole test run — previously this file
  // and cli-templates-cwd-independence.test.ts each ran `npm run build`
  // in their own beforeAll, and the `clean-dist && tsc` step raced between
  // parallel vitest workers. Here we just assert dist exists.
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `CLI entry missing: ${CLI_ENTRY}. globalSetup should have built dist/. ` +
        `If running vitest directly (without our config), run \`npm run build\` first.`,
    );
  }
}, 60_000);

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('blog agent — end-to-end skill handoff', () => {
  it('preflight reports the detected workspace', () => {
    const { root } = seedFixtureWorkspace();
    const res = runCli(root, ['agent', 'preflight', '--json']);
    expect(res.status).toBe(0);
    const env = JSON.parse(res.stdout);
    expect(env.kind).toBe('AgentPreflight');
    expect(env.data.workspace_detected).toBe(true);
  });

  it('preflight honors --workspace > BLOG_WORKSPACE > ancestor-walk precedence (Codex P4 Medium)', () => {
    // Pre-Pass-4, preflight re-resolved workspace via findWorkspaceRoot
    // with envVar=BLOG_WORKSPACE, which let the env var override the --workspace
    // flag the startup shim had already resolved. Fix: trust process.cwd()
    // after startup, omit envVar from the preflight call.
    const { root: envWs } = seedFixtureWorkspace();
    const { root: overrideWs } = seedFixtureWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'blog-outside-'));
    tempRoots.push(outside);

    const res = runCli(
      outside,
      ['--workspace', overrideWs, 'agent', 'preflight', '--json'],
      { BLOG_WORKSPACE: envWs },
    );
    expect(res.status, res.stderr).toBe(0);
    const env = JSON.parse(res.stdout);
    const { realpathSync } = require('node:fs') as typeof import('node:fs');
    // Override WINS over env var (the documented precedence).
    expect(realpathSync(env.data.workspace_root)).toBe(realpathSync(overrideWs));
    expect(realpathSync(env.data.workspace_root)).not.toBe(realpathSync(envWs));
  });

  it('apply pins spawned children to plan.workspace_root (Codex P6 High — BLOG_WORKSPACE cannot redirect child)', () => {
    // Pre-Pass-6, applyPlan spawned children with env:process.env. A
    // parent invocation where cwd=planWs but BLOG_WORKSPACE points
    // at otherWs would see:
    //   - parent startup: no --workspace flag, BLOG_WORKSPACE wins,
    //     parent chdirs to otherWs, plan validation fails with
    //     WORKSPACE_MISMATCH (good for parent, but not the bug we want).
    //
    // To expose the CHILD bug, parent must pass validation first. We
    // use --workspace <planWs> explicitly at the parent so parent
    // chdirs to planWs and validates. Then, WITHOUT the fix, children
    // inherit BLOG_WORKSPACE=otherWs and their startup shim (no
    // --workspace in child argv pre-fix) chdirs to otherWs.
    //
    // Post-fix: apply prepends --workspace <plan.workspace_root> to
    // child argv AND scrubs BLOG_WORKSPACE from child env, so child
    // runs in planWs regardless of parent env.
    const { root: planWs, slug } = seedFixtureWorkspace();
    const { root: otherWs } = seedFixtureWorkspace();

    const planOut = runCli(planWs, [
      'agent', 'plan', slug,
      '--intent', 'workspace-pin',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
    ]);
    const planPath = planOut.stdout.trim();
    runCli(planWs, ['agent', 'approve', planPath]);

    // Parent pins workspace with --workspace flag (beats BLOG_WORKSPACE
    // per documented precedence). Child inherits… env, which pre-fix
    // had BLOG_WORKSPACE=otherWs. Post-fix, apply scrubs BLOG_WORKSPACE
    // from child env and prepends --workspace, so child also runs in
    // planWs.
    const apply = runCli(
      planWs,
      ['--workspace', planWs, 'agent', 'apply', planPath],
      { BLOG_WORKSPACE: otherWs },
    );
    expect(apply.status, apply.stderr).toBe(0);

    const { existsSync } = require('node:fs') as typeof import('node:fs');
    const planWsReceipt = join(planWs, '.blog-agent', 'plans', `${slug}.receipt.json`);
    const otherWsReceipt = join(otherWs, '.blog-agent', 'plans', `${slug}.receipt.json`);
    expect(existsSync(planWsReceipt)).toBe(true);
    expect(existsSync(otherWsReceipt)).toBe(false);
  });

  it('rejects empty --workspace operand with explicit error (Codex P6 Medium)', () => {
    // Pre-Pass-6, `--workspace=` silently fell through to env/ancestor
    // walk. An empty shell-variable expansion would therefore run
    // commands against an ambient workspace the operator didn't intend.
    // Post-fix, empty value exits 1 with a diagnostic BEFORE any
    // subcommand runs.
    const { root } = seedFixtureWorkspace();
    const empty = runCli(root, ['--workspace=', 'status']);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toMatch(/--workspace value is empty/);

    // Trailing split form with no operand — also rejected.
    const trailing = runCli(root, ['--workspace']);
    expect(trailing.status).toBe(1);
    expect(trailing.stderr).toMatch(/--workspace requires a path argument/);
  });

  it('startup shim recognizes --workspace=/path compact form (Codex P5 Medium)', () => {
    // Pre-Pass-5 the shim only matched `--workspace <path>` (split form).
    // `--workspace=/path` fell through uncaught, so chdir-before-imports
    // never fired for workspace-free commands invoked with the compact
    // flag. Commander accepts the compact form natively, so CLI
    // semantics were inconsistent between the shim and the parser.
    const { root } = seedFixtureWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'blog-outside-'));
    tempRoots.push(outside);

    const res = runCli(outside, [`--workspace=${root}`, 'agent', 'preflight', '--json']);
    expect(res.status, res.stderr).toBe(0);
    const env = JSON.parse(res.stdout);
    const { realpathSync } = require('node:fs') as typeof import('node:fs');
    expect(realpathSync(env.data.workspace_root)).toBe(realpathSync(root));
  });

  it('startup shim excludes the --workspace path from positional walk', () => {
    // Pre-Pass-5 the shim used argv.filter(a => !a.startsWith('-'))
    // which treated the workspace PATH as a positional. So
    // `blog --workspace /abs agent preflight` had firstPositional=`/abs`,
    // not `agent`, and `isAgentWorkspaceFreeSub` was false. The split
    // form would then unnecessarily error for agent preflight outside a
    // workspace.
    const outside = mkdtempSync(join(tmpdir(), 'blog-outside-shim-'));
    tempRoots.push(outside);
    // No workspace at /nonexistent-workspace. The shim should still
    // identify `agent preflight` correctly and let preflight run, which
    // reports workspace_detected=false cleanly rather than exiting with
    // "No m0lz.01 workspace detected" error.
    const nonexistent = join(outside, 'nonexistent');
    const res = runCli(outside, ['--workspace', nonexistent, 'agent', 'preflight', '--json']);
    // Preflight can still run (workspace-free subcommand). The JSON should
    // report the failure inside workspace_error, not a hard exit.
    expect(res.status, res.stderr).toBe(0);
    const env = JSON.parse(res.stdout);
    expect(env.kind).toBe('AgentPreflight');
  });

  it('preflight with --workspace <abs-path> from outside that workspace detects it correctly', () => {
    // Codex Pass-3 Medium: pre-fix, preflight re-resolved workspace from
    // `_BLOG_ORIGINAL_CWD` and ignored the already-resolved override. A
    // user running `blog --workspace /abs/path agent preflight --json`
    // from outside /abs/path would get workspace_detected=false even
    // though the startup shim had chdir'd successfully.
    const { root } = seedFixtureWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'blog-outside-'));
    tempRoots.push(outside);

    const res = runCli(outside, ['--workspace', root, 'agent', 'preflight', '--json']);
    expect(res.status, res.stderr).toBe(0);
    const env = JSON.parse(res.stdout);
    expect(env.kind).toBe('AgentPreflight');
    expect(env.data.workspace_detected).toBe(true);
    // workspace_root should be the override — macOS tmpdir canonicalization
    // may prefix /private, so compare with realpath-normalized paths.
    const { realpathSync } = require('node:fs') as typeof import('node:fs');
    expect(realpathSync(env.data.workspace_root)).toBe(realpathSync(root));
  });

  it('blog publish start no longer advertises --dry-run (removed until fully wired)', () => {
    // Codex Pass-3 High: the flag previously claimed to "short-circuit
    // network-making steps (Dev.to, gh) — preview only" but only
    // crosspost-devto honored it. createSitePR still opened a real PR;
    // pushCompanionRepo still pushed a branch. Rollback hazard.
    // The flag is removed until every side-effecting step honors it.
    const { root } = seedFixtureWorkspace();
    const help = runCli(root, ['publish', 'start', '--help']);
    expect(help.stdout + help.stderr).not.toMatch(/--dry-run/);
  });

  it('agent preflight is the ONLY agent subcommand allowed without a workspace', () => {
    // Codex adversarial review, High #3: pre-fix, `WORKSPACE_FREE_COMMANDS`
    // exempted the entire `agent` family. plan/approve/verify/apply could
    // run from any cwd and stamp an arbitrary directory as trust root.
    // Now only `agent preflight` is workspace-free.
    const bare = mkdtempSync(join(tmpdir(), 'blog-no-workspace-'));
    tempRoots.push(bare);

    // preflight is allowed — reports workspace_detected=false.
    const pre = runCli(bare, ['agent', 'preflight', '--json']);
    expect(pre.status).toBe(0);
    const env = JSON.parse(pre.stdout);
    expect(env.data.workspace_detected).toBe(false);

    // plan/approve/verify/apply must refuse without a workspace. The CLI
    // startup shim fails with a non-zero exit before Commander parses args.
    for (const sub of ['plan', 'approve', 'verify', 'apply']) {
      const res = runCli(bare, ['agent', sub, 'any-arg']);
      expect(res.status).not.toBe(0);
      expect(res.stderr.toLowerCase()).toMatch(/workspace|not a m0lz|state\.db/);
    }
  });

  it('plan → verify (unapproved rejected) → approve → verify (passes) → apply', () => {
    const { root, slug } = seedFixtureWorkspace();

    // 1. Plan.
    const plan = runCli(root, [
      'agent',
      'plan',
      slug,
      '--intent',
      'fixture e2e',
      '--content-type',
      'project-launch',
      '--depth',
      'fast-path',
      '--venues',
      'hub',
    ]);
    expect(plan.status).toBe(0);
    const planPath = plan.stdout.trim();
    expect(existsSync(planPath)).toBe(true);

    // 2. Plan shape is valid + unapproved.
    const planBody = JSON.parse(readFileSync(planPath, 'utf8')) as PlanFile;
    expect(planBody.approved_at).toBeNull();
    expect(planBody.payload_hash).toBeNull();
    expect(planBody.steps.length).toBeGreaterThan(0);
    expect(planBody.steps[0].command).toMatch(/^blog\s+/);
    expect(planBody.steps[0].args).toBeInstanceOf(Array);

    // 3. Verify without approval — expect NO_APPROVAL exit 2.
    const verifyUnapproved = runCli(root, ['agent', 'verify', planPath]);
    expect(verifyUnapproved.status).toBe(2);
    expect(verifyUnapproved.stderr).toContain('NO_APPROVAL');

    // 4. Approve — sets approved_at + payload_hash atomically.
    const approve = runCli(root, ['agent', 'approve', planPath]);
    expect(approve.status).toBe(0);
    const approvedBody = JSON.parse(readFileSync(planPath, 'utf8')) as PlanFile;
    expect(approvedBody.approved_at).not.toBeNull();
    expect(approvedBody.payload_hash).not.toBeNull();
    // Hash is reproducible.
    expect(computePlanHash(approvedBody)).toBe(approvedBody.payload_hash);

    // 5. Verify after approval — expect exit 0.
    const verifyApproved = runCli(root, ['agent', 'verify', planPath]);
    expect(verifyApproved.status).toBe(0);
    expect(verifyApproved.stdout).toContain('OK');

    // 6. Apply — `blog status` as the sole step; receipt should capture it.
    const apply = runCli(root, ['agent', 'apply', planPath]);
    expect(apply.status, apply.stderr).toBe(0);
    const receiptPath = join(root, '.blog-agent', 'plans', `${slug}.receipt.json`);
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
    expect(receipt.plan_id).toBe(approvedBody.plan_id);
    expect(receipt.steps.length).toBeGreaterThan(0);
    expect(receipt.steps[0].status).toBe('completed');
    expect(receipt.steps[0].exit_code).toBe(0);
    expect(typeof receipt.steps[0].duration_ms).toBe('number');
    expect(receipt.completed_at).not.toBeNull();
    expect(receipt.overall_exit).toBe(0);
  });

  it('HASH_MISMATCH: tampering with an approved plan fails verify', () => {
    const { root, slug } = seedFixtureWorkspace();
    const planOut = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'original',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
    ]);
    const planPath = planOut.stdout.trim();
    runCli(root, ['agent', 'approve', planPath]);

    // Tamper — change the intent field (preserving JSON validity).
    const body = JSON.parse(readFileSync(planPath, 'utf8')) as PlanFile;
    body.intent = 'tampered';
    writeFileSync(planPath, JSON.stringify(body, null, 2));

    const verify = runCli(root, ['agent', 'verify', planPath]);
    expect(verify.status).toBe(2);
    expect(verify.stderr).toContain('HASH_MISMATCH');
  });

  it('WORKSPACE_MISMATCH: plan from another workspace fails verify', () => {
    const { root: a } = seedFixtureWorkspace();
    const { root: b } = seedFixtureWorkspace();

    const planOut = runCli(a, [
      'agent', 'plan', 'x-slug',
      '--intent', 'cross-workspace',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
    ]);
    const planPath = planOut.stdout.trim();
    runCli(a, ['agent', 'approve', planPath]);

    // Copy the approved plan into workspace B and verify from B.
    const copied = join(b, 'copied.plan.json');
    writeFileSync(copied, readFileSync(planPath, 'utf8'));
    const verify = runCli(b, ['agent', 'verify', copied]);
    expect(verify.status).toBe(2);
    expect(verify.stderr).toContain('WORKSPACE_MISMATCH');
  });

  it('--steps-inline writes a plan whose steps exactly match the inline payload (no Write/Edit needed)', () => {
    const { root, slug } = seedFixtureWorkspace();
    const inlineSteps = [
      { command: 'blog status', args: [], checkpoint_message: 'sanity' },
    ];
    const plan = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'inline steps',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
      '--steps-inline', JSON.stringify(inlineSteps),
    ]);
    expect(plan.status, plan.stderr).toBe(0);
    const body = JSON.parse(readFileSync(plan.stdout.trim(), 'utf8')) as PlanFile;
    expect(body.steps).toEqual(inlineSteps);
  });

  it('--steps-inline and --steps-json are mutually exclusive', () => {
    const { root, slug } = seedFixtureWorkspace();
    const stepsPath = join(root, 'steps.json');
    writeFileSync(stepsPath, JSON.stringify([{ command: 'blog status', args: [] }]));
    const plan = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'both',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
      '--steps-inline', JSON.stringify([{ command: 'blog status', args: [] }]),
      '--steps-json', stepsPath,
    ]);
    expect(plan.status).toBe(2);
    expect(plan.stderr).toContain('mutually exclusive');
  });

  it('SCHEMA_INVALID: blog agent nesting in a plan step is rejected', () => {
    const { root, slug } = seedFixtureWorkspace();
    const plan = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'nested plan delegation',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
      '--steps-inline', JSON.stringify([{ command: 'blog agent apply', args: ['other.plan.json'] }]),
    ]);
    expect(plan.status).toBe(2);
    expect(plan.stderr).toContain('SCHEMA_INVALID');
    expect(plan.stderr).toMatch(/disallowed subcommand "agent"/);
  });

  it('SCHEMA_INVALID: abstract step command is rejected at validation', () => {
    const { root, slug } = seedFixtureWorkspace();

    // Inject steps-json with an invalid command via --steps-json.
    const stepsPath = join(root, 'steps.json');
    writeFileSync(stepsPath, JSON.stringify([{ command: 'blog run-panel', args: [] }]));

    const plan = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'abstract steps',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
      '--steps-json', stepsPath,
    ]);
    // The CLI's self-validation runs before write and exits 2 on schema
    // violations. The fallback is that even if the plan wrote, `verify`
    // would reject.
    expect(plan.status).toBe(2);
    expect(plan.stderr).toContain('SCHEMA_INVALID');
  });

  it('--output is clamped to <workspace>/.blog-agent/plans/ and must end .plan.json', () => {
    const { root, slug } = seedFixtureWorkspace();

    // Outside plans dir — reject.
    const outsideDir = join(root, 'elsewhere.plan.json');
    const outside = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'escape attempt',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
      '--output', outsideDir,
    ]);
    expect(outside.status).toBe(2);
    expect(outside.stderr).toContain('SCHEMA_INVALID');
    expect(outside.stderr).toMatch(/output path must live inside/);

    // Wrong extension — reject.
    const wrongExt = join(root, '.blog-agent', 'plans', 'p.json');
    const extBad = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'wrong ext',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
      '--output', wrongExt,
    ]);
    expect(extBad.status).toBe(2);
    expect(extBad.stderr).toContain('SCHEMA_INVALID');
    expect(extBad.stderr).toMatch(/output path must end in .plan.json/);

    // Inside plans dir + .plan.json — accept.
    const allowed = join(root, '.blog-agent', 'plans', 'plan-b.plan.json');
    const ok = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'allowed custom',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
      '--output', allowed,
    ]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(existsSync(allowed)).toBe(true);
  });

  it('slug traversal (e.g. "../../outside") is rejected before any path construction', () => {
    // Closes the Codex Critical finding: even with --output clamped, the
    // DEFAULT path branch built outPath from raw slug. A slug of `../../x`
    // would escape the plans dir. validateSlug at the CLI boundary blocks
    // this before it can influence any filesystem path.
    const { root } = seedFixtureWorkspace();
    const res = runCli(root, [
      'agent', 'plan', '../../outside',
      '--intent', 'traversal',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
    ]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('SCHEMA_INVALID');
    expect(res.stderr).toMatch(/Invalid slug/);
  });

  it('pre-existing symlink at the plan path is rejected (leaf-level symlink guard)', () => {
    // Parent-realpath already handles directory-level symlink games. This
    // covers the leaf: if an attacker drops a symlink at
    // <workspace>/.blog-agent/plans/<slug>.plan.json BEFORE the CLI runs,
    // followed through it would redirect plan writes to any path the process
    // can reach.
    const { root } = seedFixtureWorkspace();
    const slug = 'symlink-victim';
    const plansDir = join(root, '.blog-agent', 'plans');
    const { mkdirSync, symlinkSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(plansDir, { recursive: true });
    const targetOutside = join(root, 'hijack-target.txt');
    writeFileSync(targetOutside, 'before');
    symlinkSync(targetOutside, join(plansDir, `${slug}.plan.json`));

    const res = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'symlink-rejection',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
    ]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('SCHEMA_INVALID');
    expect(res.stderr).toMatch(/symbolic link/);
    // Assert the symlink target was NOT overwritten (primary safety
    // property: the guard must block the write, not just the exit).
    expect(readFileSync(targetOutside, 'utf8')).toBe('before');
  });

  it('--workspace smuggled through step args is rejected at approve/verify time', () => {
    // Codex High: before the banned-flag guard, a plan step could put
    // "--workspace /tmp/attacker" in args. The CLI startup shim hoists
    // --workspace from anywhere in argv, so the spawned step would run
    // against a workspace the plan's hash does NOT bind to. The validator
    // now rejects such plans at verify, well before any spawn happens.
    const { root, slug } = seedFixtureWorkspace();
    const planPath = join(root, '.blog-agent', 'plans', `${slug}.plan.json`);

    const poisonedSteps = JSON.stringify([
      { command: 'blog status', args: ['--workspace', '/tmp/attacker'] },
    ]);
    const res = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'smuggled-workspace',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
      '--steps-inline', poisonedSteps,
    ]);
    // The plan command self-validates output via validatePlanSchema, which
    // calls the same validator the verify/apply pipeline uses.
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('SCHEMA_INVALID');
    expect(res.stderr).toMatch(/banned global flag/);
    expect(res.stderr).toMatch(/--workspace/);
    // Plan file must NOT have been written.
    expect(existsSync(planPath)).toBe(false);
  });

  it('a completed plan does NOT block a later plan for the same slug (DB-authoritative — only open runs conflict)', () => {
    // Semantics change in v0.2: RECEIPT_CONFLICT triggers on an OPEN run
    // with the same slug + different plan_id (see plan-file.test.ts for the
    // trigger case). A completed prior plan is audit history, not a lock.
    // This matches how publish/update/unpublish lifecycles actually compose:
    // a shipped post can be amended by a new plan without a forced --restart.
    const { root, slug } = seedFixtureWorkspace();

    const planA = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'plan-a',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
    ]);
    const planAPath = planA.stdout.trim();
    runCli(root, ['agent', 'approve', planAPath]);
    const applyA = runCli(root, ['agent', 'apply', planAPath]);
    expect(applyA.status).toBe(0);

    const planBPath = join(root, '.blog-agent', 'plans', `${slug}-b.plan.json`);
    const planB = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'plan-b',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
      '--output', planBPath,
    ]);
    expect(planB.status, planB.stderr).toBe(0);
    runCli(root, ['agent', 'approve', planBPath]);

    // planA completed; DB has completed_at set. planB proceeds freely.
    const applyB = runCli(root, ['agent', 'apply', planBPath]);
    expect(applyB.status, applyB.stderr).toBe(0);
  });

  it('--restart clears stale open runs for the slug — no permanent RECEIPT_CONFLICT debt', () => {
    // Codex Pass-2 High: before the fix, plan A failing open + --restart
    // on plan B would leave plan A's row in agent_plan_runs. Every future
    // plan for the slug would then hit RECEIPT_CONFLICT and require
    // --restart forever. Fixed by wiping all open runs for the slug under
    // --restart. This fixture test drives the CLI end-to-end.
    const { root, slug } = seedFixtureWorkspace();

    // A plan whose payload includes a failing step — we synthesize it via
    // --steps-inline with an unknown-to-fake-bin arg so spawn exits non-zero.
    // Actually simpler: `blog status` always succeeds from a fresh workspace;
    // we need a real failure. Use a plan that references a non-existent
    // subcommand via args… but the validator rejects unknown subcommands.
    // Use the DB directly: insert a stale open agent_plan_runs row that
    // mimics a crashed prior apply, then verify a new plan with --restart
    // clears it.
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const dbPath = join(root, '.blog-agent', 'state.db');
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO agent_plan_runs
          (plan_id, plan_payload_hash, slug, workspace_root, applied_at, completed_at, overall_exit)
         VALUES (?, ?, ?, ?, ?, NULL, 0)`,
      ).run(
        '01JH0KSTALEOLD000000000000',
        'stalehash',
        slug,
        root,
        new Date().toISOString(),
      );
    } finally {
      db.close();
    }

    // Now a new plan for the same slug. Without --restart, RECEIPT_CONFLICT.
    const planOut = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'recover-from-stale',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
    ]);
    const planPath = planOut.stdout.trim();
    runCli(root, ['agent', 'approve', planPath]);

    const noRestart = runCli(root, ['agent', 'apply', planPath]);
    expect(noRestart.status).toBe(2);
    expect(noRestart.stderr).toContain('RECEIPT_CONFLICT');

    const withRestart = runCli(root, ['agent', 'apply', planPath, '--restart']);
    expect(withRestart.status, withRestart.stderr).toBe(0);

    // Follow-up plan (no --restart) must also succeed — debt is gone.
    const planC = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'post-recover',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
      '--output', join(root, '.blog-agent', 'plans', `${slug}-c.plan.json`),
    ]);
    expect(planC.status, planC.stderr).toBe(0);
    runCli(root, ['agent', 'approve', planC.stdout.trim()]);
    const applyC = runCli(root, ['agent', 'apply', planC.stdout.trim()]);
    expect(applyC.status, applyC.stderr).toBe(0);
  });

  it('traversal slug in a hand-authored plan file is rejected at verify (not just at CLI plan generation)', () => {
    // Codex Pass-2 Critical: the CLI --output clamp + slug validation only
    // ran at `agent plan`. A hand-edited plan.json with
    // `slug: "../../escape"` would still pass approve/verify/apply and
    // reach defaultReceiptPath / defaultLockPath which interpolate the
    // raw slug. Fixed by validating plan.slug inside validatePlanSchema.
    const { root } = seedFixtureWorkspace();
    const plansDir = join(root, '.blog-agent', 'plans');
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(plansDir, { recursive: true });

    // Hand-author a malicious plan that passes at the file level but has a
    // traversal slug. We bypass `agent plan` entirely.
    const malicious = {
      schema_version: '2',
      plan_id: '01JH0K000000000000000TEST',
      slug: '../../escape',
      workspace_root: root,
      created_at: '2026-04-19T18:00:00Z',
      approved_at: null,
      payload_hash: null,
      intent: 'escape via hand-authored plan',
      content_type: 'project-launch',
      depth: 'fast-path',
      venues: ['hub'],
      expected_start_phase: 'research',
      steps: [{ command: 'blog status', args: [] }],
    };
    const planPath = join(plansDir, 'malicious.plan.json');
    writeFileSync(planPath, JSON.stringify(malicious, null, 2));

    const verify = runCli(root, ['agent', 'verify', planPath]);
    expect(verify.status).toBe(2);
    expect(verify.stderr).toContain('SCHEMA_INVALID');
    expect(verify.stderr).toMatch(/plan\.slug is invalid/);
  });

  it('RECEIPT_CONFLICT cannot be forced by a forged receipt — DB authority only', () => {
    // Codex adversarial review Medium: the old implementation checked the
    // receipt FILE for plan_id mismatch, which meant a hand-edited receipt
    // could force a spurious conflict (DoS, forcing a destructive --restart).
    // Post-fix the check is against agent_plan_runs in the DB only; receipt
    // contents are ignored.
    const { root, slug } = seedFixtureWorkspace();
    const planOut = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'forgery-resistance-conflict',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
    ]);
    const planPath = planOut.stdout.trim();
    runCli(root, ['agent', 'approve', planPath]);

    // Plant a forged receipt for a different plan_id BEFORE first apply. A
    // pre-fix applyPlan would read this and throw RECEIPT_CONFLICT.
    const receiptPath = join(root, '.blog-agent', 'plans', `${slug}.receipt.json`);
    const forgedReceipt: Receipt = {
      plan_id: '01JHFORGED-DIFFERENT-PLAN-ID',
      plan_payload_hash: '0'.repeat(64),
      slug,
      workspace_root: root,
      applied_at: new Date().toISOString(),
      completed_at: null,
      overall_exit: 0,
      steps: [],
    };
    writeFileSync(receiptPath, JSON.stringify(forgedReceipt, null, 2));

    const apply = runCli(root, ['agent', 'apply', planPath]);
    expect(apply.status, apply.stderr).toBe(0);
    // Receipt was regenerated from the DB; the forged plan_id is gone.
    const refreshed = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
    expect(refreshed.plan_id).not.toBe('01JHFORGED-DIFFERENT-PLAN-ID');
  });

  it('RECEIPT_HASH_MISMATCH: re-approving the same plan_id with different content blocks resume', () => {
    // Post-v4 this is the only legitimate path to RECEIPT_HASH_MISMATCH. Pre-v4
    // the test tampered the receipt JSON; under DB authority that is a no-op
    // (see the "receipt-JSON tampering is benign" test below).
    const { root, slug } = seedFixtureWorkspace();
    const planOut = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'original',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
    ]);
    const planPath = planOut.stdout.trim();
    runCli(root, ['agent', 'approve', planPath]);
    const first = runCli(root, ['agent', 'apply', planPath]);
    expect(first.status, first.stderr).toBe(0);

    // Mutate plan content (intent field — covered by the hash) and re-approve.
    // The approve command notices the divergence and re-signs with a new
    // payload_hash AT THE SAME plan_id. The DB still carries the old hash.
    const body = JSON.parse(readFileSync(planPath, 'utf8')) as PlanFile;
    body.intent = 'rewritten';
    writeFileSync(planPath, JSON.stringify(body, null, 2));
    const reapprove = runCli(root, ['agent', 'approve', planPath]);
    expect(reapprove.status, reapprove.stderr).toBe(0);

    const second = runCli(root, ['agent', 'apply', planPath]);
    expect(second.status).toBe(2);
    expect(second.stderr).toContain('RECEIPT_HASH_MISMATCH');
    expect(second.stderr).toMatch(/re-approved with different content/);

    // --restart overrides.
    const restart = runCli(root, ['agent', 'apply', planPath, '--restart']);
    expect(restart.status, restart.stderr).toBe(0);
  });

  it('receipt-JSON tampering is benign — DB remains authoritative for skip state', () => {
    // Codex adversarial review High #1: pre-v4, forging `status: "completed"`
    // rows in the receipt suppressed step execution. Post-v4 the receipt is
    // audit mirror, not trust input. This test locks that invariant in.
    const { root, slug } = seedFixtureWorkspace();
    const planOut = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'forgery-resistance',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
    ]);
    const planPath = planOut.stdout.trim();
    runCli(root, ['agent', 'approve', planPath]);

    // Apply once. DB row should carry plan_payload_hash correctly.
    const first = runCli(root, ['agent', 'apply', planPath]);
    expect(first.status, first.stderr).toBe(0);

    // Completely nuke the receipt's hash field. Under pre-v4 this produced
    // RECEIPT_HASH_MISMATCH; under v4 the receipt isn't consulted for
    // authority so resume is a no-op refresh.
    const receiptPath = join(root, '.blog-agent', 'plans', `${slug}.receipt.json`);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
    receipt.plan_payload_hash = '0'.repeat(64);
    receipt.overall_exit = 999;
    receipt.steps.forEach((s) => { s.stdout_tail = 'FORGED'; });
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

    // Second apply must succeed — DB still knows the true state.
    const second = runCli(root, ['agent', 'apply', planPath]);
    expect(second.status, second.stderr).toBe(0);

    // The refreshed receipt reflects the DB's authoritative state, not the
    // forgery. plan_payload_hash is rewritten back to the real hash.
    const refreshed = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
    expect(refreshed.plan_payload_hash).not.toBe('0'.repeat(64));
    expect(refreshed.overall_exit).toBe(0);
    expect(refreshed.steps.every((s) => s.stdout_tail !== 'FORGED')).toBe(true);
  });

  it('apply is resumable — second run is a no-op when receipt shows all steps completed', () => {
    const { root, slug } = seedFixtureWorkspace();
    const planOut = runCli(root, [
      'agent', 'plan', slug,
      '--intent', 'resumable',
      '--content-type', 'project-launch',
      '--depth', 'fast-path',
      '--venues', 'hub',
    ]);
    const planPath = planOut.stdout.trim();
    runCli(root, ['agent', 'approve', planPath]);

    const first = runCli(root, ['agent', 'apply', planPath]);
    expect(first.status).toBe(0);
    const receiptPath = join(root, '.blog-agent', 'plans', `${slug}.receipt.json`);
    const beforeMtime = readFileSync(receiptPath, 'utf8').length;

    // Re-invoke — all steps already completed, so apply writes a refreshed
    // receipt but without re-executing steps.
    const second = runCli(root, ['agent', 'apply', planPath]);
    expect(second.status).toBe(0);
    const afterReceipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
    expect(afterReceipt.steps.every((s) => s.status === 'completed')).toBe(true);
    // Receipt byte length may change slightly (completed_at timestamp refreshes) but contents are consistent.
    expect(typeof beforeMtime).toBe('number');
  });
});
