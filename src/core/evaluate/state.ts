import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';

import {
  PostRow,
  ContentType,
  ReviewerType,
  EvaluationRow,
  EvaluationSynthesisRow,
  Verdict,
} from '../db/types.js';
import { advancePhase } from '../research/state.js';
import {
  Issue,
  ReviewerOutput,
  parseReviewerOutput,
  validateReviewerOutput,
  normalizeText,
} from './reviewer.js';
import { synthesize, SynthesisResult, SynthesisClusterIdentity, crossReviewerFingerprint } from './synthesize.js';
import { renderSynthesisReport } from './report.js';

export type CycleEndedReason = 'passed' | 'rejected';

export interface EvaluationCycle {
  started_at: string;
  // Monotonic floor IDs captured at cycle start. Rows with id > floor belong
  // to this cycle. Clock-precision independent.
  evaluation_id_floor: number;
  synthesis_id_floor: number;
  // Maximum evaluation row id that was included in the last synthesis within
  // this cycle. Set by runSynthesis; consumed by completeEvaluation to reject
  // a pass verdict that predates newer reviewer records (within-cycle stale
  // pass guard).
  last_synthesis_eval_id?: number;
  // SHA-256 hashes of every artifact reviewed at synthesis time — draft MDX,
  // benchmark results, autocheck lint sidecar. completeEvaluation recomputes
  // and refuses to advance if any artifact drifted after synthesis. Without
  // this pin, an operator could edit the draft between synthesize and
  // complete and ship unreviewed content.
  reviewed_artifact_hashes?: Record<string, string>;
  // Per-reviewer artifact-hash snapshot captured at recordReview time. Each
  // reviewer's judgment is bound to the exact file contents they reviewed;
  // runSynthesis asserts every reviewer saw the same artifact set AND that
  // set matches current disk. This closes the "edit draft between record and
  // synthesize" bypass where reviewers judge D0 but synthesis pins D1.
  reviewer_artifact_hashes?: Record<ReviewerType, Record<string, string>>;
  ended_at?: string;
  ended_reason?: CycleEndedReason;
  // Phase 7: explicit flag that this cycle is a Phase 7 update-review
  // (launched by `blog update evaluate`). `recordReview` reads this value
  // and sets `is_update_review=1` on every inserted row — replacing the
  // pre-Phase-7 `manifest.cycles.length > 1` inference that falsely tagged
  // reject-retry cycles as updates. Defaults to false when absent
  // (back-compat for pre-Phase-7 manifests).
  is_update_cycle?: boolean;
}

export interface EvaluationManifest {
  slug: string;
  content_type: ContentType;
  expected_reviewers: ReviewerType[];
  initialized_at: string;
  cycle_started_at: string;
  cycles: EvaluationCycle[];
}

// Keys used in manifest.reviewed_artifact_hashes. Stable so drift detection is
// deterministic. Files that don't exist at synthesis time are recorded with
// the literal value "<absent>" so a later addition of the file at complete
// time is caught as drift (rather than a silent no-op).
export const ARTIFACT_ABSENT = '<absent>';

function fileHash(path: string): string {
  if (!existsSync(path)) return ARTIFACT_ABSENT;
  // Reject symlinks on hash computation. `readFileSync` follows symlinks by
  // default, so a symlink swap between synthesis and completeEvaluation
  // could serve different content with the same hash only if contents
  // coincidentally matched — but an attacker with workspace write access
  // could still point a pinned path at a controlled target. lstat-first
  // ensures we never trust indirection for artifact integrity.
  const lst = lstatSync(path, { throwIfNoEntry: false });
  if (lst && !lst.isFile()) {
    throw new Error(`Reviewed artifact is not a regular file: ${path} (type=${lst.isSymbolicLink() ? 'symlink' : lst.isDirectory() ? 'directory' : 'special'}).`);
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Slug-scoped cooperative lock. Serializes CLI operations that mutate
// evaluation state (recordReview, runSynthesis, completeEvaluation,
// rejectEvaluation, initEvaluation on cycle roll) so two concurrent `blog
// evaluate ...` processes on the same slug cannot race across the
// FS-check-then-DB-flip window. Not a kernel flock — external processes
// (text editors, scripts that don't use this helper) are unaffected; that
// limitation is acknowledged in the threat model.
//
// Sync spin-wait via Atomics.wait (available in Node 20+). The lock file
// holds the PID so stale locks left by a crashed process can be reclaimed.
export function acquireEvaluateLock(evaluationsDir: string, slug: string, timeoutMs = 10_000): () => void {
  const workspaceDir = join(evaluationsDir, slug);
  mkdirSync(workspaceDir, { recursive: true });
  const lockPath = join(workspaceDir, '.evaluate.lock');
  const deadline = Date.now() + timeoutMs;
  const sharedBuf = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { unlinkSync(lockPath); } catch { /* already released */ } };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw err;
      // Reclaim stale lock if holder PID is dead.
      try {
        const heldPid = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
        if (Number.isFinite(heldPid) && heldPid > 0) {
          try {
            process.kill(heldPid, 0);
          } catch (killErr) {
            if ((killErr as NodeJS.ErrnoException).code === 'ESRCH') {
              try { unlinkSync(lockPath); } catch { /* raced */ }
              continue;
            }
          }
        }
      } catch { /* lockfile unreadable — transient, retry */ }
      if (Date.now() > deadline) {
        throw new Error(
          `Could not acquire evaluate lock for '${slug}' within ${timeoutMs}ms at ${lockPath}. ` +
          `Another 'blog evaluate' process holds it. If that process crashed, delete the lock file manually.`,
        );
      }
      // Short sleep (50ms) without blocking the event loop forever. Atomics.wait
      // on a zeroed shared int returns 'timed-out' after the delay.
      Atomics.wait(sharedBuf, 0, 0, 50);
    }
  }
}

export interface SynthesisArtifactPaths {
  draftsDir: string;
  benchmarkDir: string;
  // evaluationsDir is implicit — the autocheck sidecar lives inside the
  // evaluation workspace, so it is resolved via evaluationDir() directly.
}

// Synthesis receipt: a tamper-detection sidecar that pins the exact state
// runSynthesis saw. completeEvaluation recomputes and verifies. An operator
// raising manifest.last_synthesis_eval_id or mutating reviewer_artifact_hashes
// to stage a stale pass would also need to forge a consistent receipt — the
// receipt's own hash covers all those fields, so any inconsistency between
// manifest and receipt is rejected. Not cryptographically unforgeable (no
// keys), but raises the tamper bar from "edit one JSON field" to "coordinate
// edits across two files + recompute SHA-256". Under the full-FS-write threat
// model, a topology-preserving re-record with forged receipt is still feasible
// — the receipt is defense-in-depth, not the sole trust root (DB-authoritative
// re-derivation + cluster-identity comparison is the load-bearing check).
interface SynthesisReceiptBody {
  pin: number;
  verdict: Verdict;
  reviewed_artifact_hashes: Record<string, string>;
  reviewer_artifact_hashes: Record<string, Record<string, string>>;
  synthesis_row_id: number;
  // Per-bucket cluster representative fingerprints. completeEvaluation's
  // DB re-derivation compares this identity set against the re-derived
  // clusters — closes the "post-synthesis re-record with different issues
  // but same count distribution" bypass where stored counts and re-derived
  // counts coincide.
  cluster_identity: SynthesisClusterIdentity;
}

function synthesisReceiptPath(workspaceDir: string): string {
  return join(workspaceDir, 'synthesis.receipt.json');
}

function canonicalReceiptJson(body: SynthesisReceiptBody): string {
  // Stable JSON: sort all object keys for byte-identical re-serialization.
  const stringify = (val: unknown): string => {
    if (val === null || typeof val !== 'object') return JSON.stringify(val);
    if (Array.isArray(val)) return `[${val.map(stringify).join(',')}]`;
    const keys = Object.keys(val as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stringify((val as Record<string, unknown>)[k])}`).join(',')}}`;
  };
  return stringify(body as unknown);
}

function receiptHash(body: SynthesisReceiptBody): string {
  return createHash('sha256').update(canonicalReceiptJson(body)).digest('hex');
}

function writeSynthesisReceipt(workspaceDir: string, body: SynthesisReceiptBody): void {
  const payload = { body, hash: receiptHash(body) };
  writeFileSync(synthesisReceiptPath(workspaceDir), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

// Loads, parses, verifies the receipt's self-hash, and cross-checks that the
// receipt body fields we know from other sources (manifest pin + hashes, DB
// synthesis row id + verdict) agree with the receipt. Returns the verified
// body so callers can consume additional fields (e.g. cluster_identity) that
// are receipt-only. The receipt is the coverage identity anchor: forging it
// requires re-deriving SHA-256 over the full canonical body, including
// cluster fingerprints that a tamper attack would have to keep consistent
// with the stored synthesis counts AND the DB-authoritative re-derivation.
function loadAndVerifySynthesisReceipt(
  workspaceDir: string,
  expected: Omit<SynthesisReceiptBody, 'cluster_identity'>,
): SynthesisReceiptBody {
  const path = synthesisReceiptPath(workspaceDir);
  if (!existsSync(path)) {
    throw new Error(
      `Synthesis receipt missing: ${path}. ` +
      `The last synthesis did not complete cleanly, or the receipt was deleted. ` +
      `Re-run 'blog evaluate synthesize' before completing.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(`Synthesis receipt is not valid JSON (${path}): ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Synthesis receipt must be an object: ${path}`);
  }
  const { body, hash } = raw as { body?: SynthesisReceiptBody; hash?: string };
  if (!body || typeof hash !== 'string') {
    throw new Error(`Synthesis receipt missing 'body' or 'hash': ${path}`);
  }
  if (hash !== receiptHash(body)) {
    throw new Error(`Synthesis receipt hash does not match its body — receipt has been tampered: ${path}`);
  }
  if (!body.cluster_identity
    || !Array.isArray(body.cluster_identity.consensus)
    || !Array.isArray(body.cluster_identity.majority)
    || !Array.isArray(body.cluster_identity.single)) {
    throw new Error(
      `Synthesis receipt is missing 'cluster_identity' fingerprint sets (${path}). ` +
      `Re-run 'blog evaluate synthesize' to regenerate a receipt including cluster identity.`,
    );
  }
  const manifestCrosscheck: SynthesisReceiptBody = { ...expected, cluster_identity: body.cluster_identity };
  if (receiptHash(body) !== receiptHash(manifestCrosscheck)) {
    throw new Error(
      `Synthesis receipt does not match manifest state for ${path}. ` +
      `The manifest's pin / artifact hashes / reviewer hashes diverge from what synthesis committed. ` +
      `Re-run 'blog evaluate synthesize' to regenerate a consistent receipt.`,
    );
  }
  return body;
}

function manifestVersionStamp(evaluationsDir: string, slug: string): string {
  const path = manifestPath(evaluationsDir, slug);
  if (!existsSync(path)) return ARTIFACT_ABSENT;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function computeReviewedArtifactHashes(
  paths: SynthesisArtifactPaths,
  evaluationsDir: string,
  slug: string,
): Record<string, string> {
  const draftPath = join(paths.draftsDir, slug, 'index.mdx');
  const benchmarkResultsPath = join(paths.benchmarkDir, slug, 'results.json');
  const benchmarkEnvPath = join(paths.benchmarkDir, slug, 'environment.json');
  const lintPath = join(evaluationDir(evaluationsDir, slug), 'structural.lint.json');
  return {
    'draft/index.mdx': fileHash(draftPath),
    'benchmark/results.json': fileHash(benchmarkResultsPath),
    'benchmark/environment.json': fileHash(benchmarkEnvPath),
    'evaluation/structural.lint.json': fileHash(lintPath),
  };
}

// Canonical serialization for dedupe: sort each issue's keys alphabetically
// and sort the issues array by id. Makes the comparison robust against
// key-order and array-order variations in reviewer output.
function canonicalIssuesJson(issues: Issue[]): string {
  const sorted = [...issues].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify(sorted.map((issue) => {
    const keys = Object.keys(issue).sort();
    const obj: Record<string, unknown> = {};
    for (const k of keys) obj[k] = (issue as unknown as Record<string, unknown>)[k];
    return obj;
  }));
}

// Millisecond-precision "now" taken from the DB's own clock so cycle boundaries
// compare apples-to-apples with run_at/synthesized_at that we also write with
// the same format. CURRENT_TIMESTAMP is second-precision and would alias rows
// recorded in the same second as cycle start with rows from the prior cycle.
function dbNow(db: Database.Database): string {
  const row = db.prepare("SELECT strftime('%Y-%m-%d %H:%M:%f', 'now') AS t").get() as { t: string };
  return row.t;
}

export function getEvaluatePost(
  db: Database.Database,
  slug: string,
  options?: { allowPublished?: boolean },
): PostRow | undefined {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
  if (!post) return undefined;
  // Phase 7: when the current evaluation cycle is an update-review (started
  // by `blog update evaluate`), the post is in 'published' not 'evaluate'.
  // Callers pass allowPublished=true after reading the manifest's current
  // cycle's is_update_cycle flag; keeps the default strict for the Phase 5
  // path.
  const ok =
    post.phase === 'evaluate' ||
    (options?.allowPublished === true && post.phase === 'published');
  if (!ok) {
    const expected = options?.allowPublished
      ? `'evaluate' or 'published'`
      : `'evaluate'`;
    throw new Error(
      `Post '${slug}' is in phase '${post.phase}', not ${expected}. ` +
      `Evaluate commands only operate on posts in these phases.`,
    );
  }
  return post;
}

// Phase 7: helper that peeks at the workspace manifest to decide whether
// the current evaluation cycle is an update-review, and returns the post
// with the appropriate phase allowance. Callers that already read the
// manifest can pass it explicitly to avoid a redundant read.
export function getEvaluateOrUpdatePost(
  db: Database.Database,
  slug: string,
  manifest: EvaluationManifest | null,
): PostRow | undefined {
  const cycle = manifest && manifest.cycles.length > 0
    ? manifest.cycles[manifest.cycles.length - 1]
    : undefined;
  const allowPublished = cycle?.is_update_cycle === true;
  return getEvaluatePost(db, slug, { allowPublished });
}

export function expectedReviewers(contentType: ContentType): ReviewerType[] {
  if (contentType === 'analysis-opinion') {
    return ['structural', 'adversarial'];
  }
  return ['structural', 'adversarial', 'methodology'];
}

export function evaluationDir(evaluationsDir: string, slug: string): string {
  return join(evaluationsDir, slug);
}

export function manifestPath(evaluationsDir: string, slug: string): string {
  return join(evaluationDir(evaluationsDir, slug), 'manifest.json');
}

export function readManifest(evaluationsDir: string, slug: string): EvaluationManifest | null {
  const path = manifestPath(evaluationsDir, slug);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<EvaluationManifest> & Record<string, unknown>;
  // Back-compat normalization: pre-cycle manifests had only initialized_at.
  const cycle_started_at = typeof raw.cycle_started_at === 'string' ? raw.cycle_started_at : raw.initialized_at as string;
  const rawCycles = Array.isArray(raw.cycles) ? raw.cycles as Array<Partial<EvaluationCycle>> : [];
  const cycles: EvaluationCycle[] = rawCycles.length > 0
    ? rawCycles.map((c) => {
      // Floors must be numeric. Silent coercion to 0 would either hide all rows
      // (when a stored floor is non-numeric after a restore) or re-expose stale
      // rows (when it defaults to 0). Fail loudly instead.
      if (c.started_at === undefined) {
        throw new Error(`Manifest cycle missing 'started_at': ${JSON.stringify(c)}`);
      }
      if (typeof c.evaluation_id_floor !== 'number' || !Number.isFinite(c.evaluation_id_floor)) {
        throw new Error(`Manifest cycle has invalid evaluation_id_floor: ${JSON.stringify(c)}`);
      }
      if (typeof c.synthesis_id_floor !== 'number' || !Number.isFinite(c.synthesis_id_floor)) {
        throw new Error(`Manifest cycle has invalid synthesis_id_floor: ${JSON.stringify(c)}`);
      }
      if (c.last_synthesis_eval_id !== undefined && (typeof c.last_synthesis_eval_id !== 'number' || !Number.isFinite(c.last_synthesis_eval_id))) {
        throw new Error(`Manifest cycle has invalid last_synthesis_eval_id: ${JSON.stringify(c)}`);
      }
      let hashes: Record<string, string> | undefined;
      if (c.reviewed_artifact_hashes !== undefined) {
        if (typeof c.reviewed_artifact_hashes !== 'object' || c.reviewed_artifact_hashes === null || Array.isArray(c.reviewed_artifact_hashes)) {
          throw new Error(`Manifest cycle has invalid reviewed_artifact_hashes: ${JSON.stringify(c)}`);
        }
        hashes = {};
        for (const [k, v] of Object.entries(c.reviewed_artifact_hashes)) {
          if (typeof v !== 'string' || v.length === 0) {
            throw new Error(`Manifest reviewed_artifact_hashes['${k}'] must be a non-empty string`);
          }
          hashes[k] = v;
        }
      }
      let reviewerHashes: Record<ReviewerType, Record<string, string>> | undefined;
      if (c.reviewer_artifact_hashes !== undefined) {
        if (typeof c.reviewer_artifact_hashes !== 'object' || c.reviewer_artifact_hashes === null || Array.isArray(c.reviewer_artifact_hashes)) {
          throw new Error(`Manifest cycle has invalid reviewer_artifact_hashes: ${JSON.stringify(c)}`);
        }
        reviewerHashes = {} as Record<ReviewerType, Record<string, string>>;
        for (const [reviewerKey, inner] of Object.entries(c.reviewer_artifact_hashes)) {
          if (!['structural', 'adversarial', 'methodology'].includes(reviewerKey)) {
            throw new Error(`Manifest reviewer_artifact_hashes has invalid reviewer key '${reviewerKey}'`);
          }
          if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) {
            throw new Error(`Manifest reviewer_artifact_hashes['${reviewerKey}'] must be an object`);
          }
          const innerHashes: Record<string, string> = {};
          for (const [k, v] of Object.entries(inner as Record<string, unknown>)) {
            if (typeof v !== 'string' || v.length === 0) {
              throw new Error(`Manifest reviewer_artifact_hashes['${reviewerKey}']['${k}'] must be a non-empty string`);
            }
            innerHashes[k] = v;
          }
          reviewerHashes[reviewerKey as ReviewerType] = innerHashes;
        }
      }
      // is_update_cycle: must be boolean if present; coercion to false on
      // absence is back-compat for pre-Phase-7 manifests. Silent coercion on
      // a non-boolean value would mask tampering, so we reject with the same
      // loud-fail policy used for other cycle fields.
      if (c.is_update_cycle !== undefined && typeof c.is_update_cycle !== 'boolean') {
        throw new Error(`Manifest cycle has invalid is_update_cycle: ${JSON.stringify(c)}`);
      }
      return {
        started_at: c.started_at,
        evaluation_id_floor: c.evaluation_id_floor,
        synthesis_id_floor: c.synthesis_id_floor,
        last_synthesis_eval_id: c.last_synthesis_eval_id,
        reviewed_artifact_hashes: hashes,
        reviewer_artifact_hashes: reviewerHashes,
        ended_at: c.ended_at,
        ended_reason: c.ended_reason,
        is_update_cycle: c.is_update_cycle === true ? true : undefined,
      };
    })
    : [{ started_at: cycle_started_at, evaluation_id_floor: 0, synthesis_id_floor: 0 }];

  // Monotonic floor enforcement: MAX(id) on a non-deleting audit table only
  // grows, so each cycle's floors must be >= the previous cycle's floors.
  // A tampered manifest that lowers a floor to re-expose pre-reject rows is
  // rejected here, before any gate function trusts the manifest. Additionally,
  // a new cycle must start at or after the previous cycle's `last_synthesis_eval_id`
  // — otherwise a tamper could restage a pre-reject pass synthesis as visible
  // to the new cycle's `latestSynthesisInCycle(synthesis_id_floor)`.
  for (let i = 1; i < cycles.length; i++) {
    const prev = cycles[i - 1];
    const cur = cycles[i];
    if (cur.evaluation_id_floor < prev.evaluation_id_floor) {
      throw new Error(
        `Manifest floors are not monotonic: cycles[${i}].evaluation_id_floor (${cur.evaluation_id_floor}) < cycles[${i - 1}].evaluation_id_floor (${prev.evaluation_id_floor}).`,
      );
    }
    if (cur.synthesis_id_floor < prev.synthesis_id_floor) {
      throw new Error(
        `Manifest floors are not monotonic: cycles[${i}].synthesis_id_floor (${cur.synthesis_id_floor}) < cycles[${i - 1}].synthesis_id_floor (${prev.synthesis_id_floor}).`,
      );
    }
    if (prev.last_synthesis_eval_id !== undefined && cur.evaluation_id_floor < prev.last_synthesis_eval_id) {
      throw new Error(
        `Manifest is tampered: cycles[${i}].evaluation_id_floor (${cur.evaluation_id_floor}) is below cycles[${i - 1}].last_synthesis_eval_id (${prev.last_synthesis_eval_id}). A new cycle cannot re-expose the prior cycle's pinned synthesis.`,
      );
    }
  }
  // Shape validation of the top-level manifest fields. readManifest is the
  // single choke point for manifest trust — every downstream consumer
  // (runEvaluateShow, validateManifestAgainstDb, recordReview/synth/complete)
  // treats these fields as typed. Without this, a tampered manifest with
  // `"expected_reviewers": "string"` would crash show's `.join(', ')` with a
  // raw TypeError stack trace.
  if (typeof raw.slug !== 'string' || raw.slug.length === 0) {
    throw new Error(`Manifest 'slug' must be a non-empty string: ${JSON.stringify(raw.slug)}`);
  }
  const VALID_CONTENT_TYPES: readonly string[] = ['project-launch', 'technical-deep-dive', 'analysis-opinion'];
  if (typeof raw.content_type !== 'string' || !VALID_CONTENT_TYPES.includes(raw.content_type)) {
    throw new Error(`Manifest 'content_type' must be one of ${VALID_CONTENT_TYPES.join(', ')}: ${JSON.stringify(raw.content_type)}`);
  }
  if (typeof raw.initialized_at !== 'string' || raw.initialized_at.length === 0) {
    throw new Error(`Manifest 'initialized_at' must be a non-empty string: ${JSON.stringify(raw.initialized_at)}`);
  }
  if (!Array.isArray(raw.expected_reviewers) || raw.expected_reviewers.length === 0) {
    throw new Error(`Manifest 'expected_reviewers' must be a non-empty array: ${JSON.stringify(raw.expected_reviewers)}`);
  }
  const VALID_REVIEWERS: readonly string[] = ['structural', 'adversarial', 'methodology'];
  for (const r of raw.expected_reviewers as unknown[]) {
    if (typeof r !== 'string' || !VALID_REVIEWERS.includes(r)) {
      throw new Error(`Manifest 'expected_reviewers' contains invalid reviewer: ${JSON.stringify(r)}. Valid: ${VALID_REVIEWERS.join(', ')}`);
    }
  }
  return {
    slug: raw.slug,
    content_type: raw.content_type as ContentType,
    expected_reviewers: raw.expected_reviewers as ReviewerType[],
    initialized_at: raw.initialized_at,
    cycle_started_at,
    cycles,
  };
}

// Two separate prepared-statement patterns instead of string-interpolating the
// table name. SQLite does not support parameterized table names, and the
// project's absolute rule is "never string interpolation for SQL".
function maxId(db: Database.Database, table: 'evaluations' | 'evaluation_synthesis', slug: string): number {
  const stmt = table === 'evaluations'
    ? db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM evaluations WHERE post_slug = ?')
    : db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM evaluation_synthesis WHERE post_slug = ?');
  const row = stmt.get(slug) as { m: number };
  return row.m;
}

// Cross-check manifest trust boundaries against the live database. The
// manifest is a plain JSON file on disk — its fields are authoritative for
// cycle bookkeeping only after this validator confirms they are consistent
// with what the DB actually contains. Every gate function (recordReview,
// runSynthesis, completeEvaluation, rejectEvaluation) must call this before
// trusting the manifest's reviewers, floors, or pin.
//
// Fails loudly on:
// - expected_reviewers diverging from expectedReviewers(post.content_type)
//   (duplicates, omissions, reordering, or invalid enum values)
// - any floor exceeding live MAX(id) (DB/workspace restore skew)
// - any cycle's last_synthesis_eval_id exceeding live MAX(evaluations.id)
//   (pin-tamper-upward, which would defeat the within-cycle stale-pass guard)
function validateManifestAgainstDb(
  db: Database.Database,
  slug: string,
  manifest: EvaluationManifest,
  post: PostRow,
): void {
  if (!post.content_type) {
    throw new Error(`Post '${slug}' has no content_type — cannot validate manifest expected_reviewers.`);
  }
  const canonical = expectedReviewers(post.content_type);
  const observed = manifest.expected_reviewers;
  const mismatch = observed.length !== canonical.length
    || observed.some((r, i) => r !== canonical[i]);
  if (mismatch) {
    throw new Error(
      `Manifest expected_reviewers ${JSON.stringify(observed)} does not match content_type '${post.content_type}' contract ${JSON.stringify(canonical)}. ` +
      `Refusing to trust a manifest whose reviewer gate diverges from the DB-authoritative content_type.`,
    );
  }
  const dbMaxEval = maxId(db, 'evaluations', slug);
  const dbMaxSynth = maxId(db, 'evaluation_synthesis', slug);
  for (const c of manifest.cycles) {
    if (c.evaluation_id_floor > dbMaxEval) {
      throw new Error(
        `Manifest evaluation_id_floor (${c.evaluation_id_floor}) exceeds current DB MAX(id) (${dbMaxEval}) for '${slug}'. ` +
        `The evaluation workspace and database are out of sync.`,
      );
    }
    if (c.synthesis_id_floor > dbMaxSynth) {
      throw new Error(
        `Manifest synthesis_id_floor (${c.synthesis_id_floor}) exceeds current DB MAX(id) (${dbMaxSynth}) for '${slug}'. ` +
        `The evaluation workspace and database are out of sync.`,
      );
    }
    if (c.last_synthesis_eval_id !== undefined && c.last_synthesis_eval_id > dbMaxEval) {
      throw new Error(
        `Manifest last_synthesis_eval_id (${c.last_synthesis_eval_id}) exceeds current DB MAX(evaluations.id) (${dbMaxEval}) for '${slug}'. ` +
        `Tampering detected — a pin cannot reference rows that do not exist.`,
      );
    }
  }
}

function writeManifest(evaluationsDir: string, manifest: EvaluationManifest): void {
  writeFileSync(manifestPath(evaluationsDir, manifest.slug), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

export interface InitEvaluationResult {
  manifest: EvaluationManifest;
  workspaceDir: string;
}

export interface InitEvaluationOptions {
  // Phase 7: when true, this invocation is from `blog update evaluate`. The
  // function (a) accepts `post.phase === 'published'` (instead of the usual
  // draft/evaluate gate), (b) leaves the phase unchanged (no advancePhase),
  // and (c) tags the newly-opened cycle's manifest entry with
  // `is_update_cycle: true` so recordReview sets `is_update_review=1`
  // explicitly — no inference from cycles.length.
  isUpdateReview?: boolean;
}

export function initEvaluation(
  db: Database.Database,
  slug: string,
  evaluationsDir: string,
  options?: InitEvaluationOptions,
): InitEvaluationResult {
  const isUpdateReview = options?.isUpdateReview === true;
  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }
  if (isUpdateReview) {
    if (post.phase !== 'published') {
      throw new Error(
        `Post '${slug}' is in phase '${post.phase}', not 'published'. ` +
        `Update-review initialization requires the post to already be published.`,
      );
    }
  } else if (post.phase !== 'draft' && post.phase !== 'evaluate') {
    throw new Error(
      `Post '${slug}' is in phase '${post.phase}', not 'draft' or 'evaluate'. ` +
      `Evaluation can only be initialized from one of these phases.`,
    );
  }
  const contentType = post.content_type;
  if (!contentType) {
    throw new Error(`Post '${slug}' has no content_type — cannot determine expected reviewers.`);
  }

  const workspaceDir = evaluationDir(evaluationsDir, slug);
  mkdirSync(workspaceDir, { recursive: true });

  const reviewers = expectedReviewers(contentType);
  const now = dbNow(db);

  // Cycle-aware init:
  // - Fresh workspace: create manifest with initialized_at = now and a single open cycle.
  // - Active cycle (last cycle has no ended_reason): no-op — preserve timestamps.
  // - Closed cycle (last cycle has ended_reason): roll a new cycle, advance cycle_started_at,
  //   clear the `.rejected_at` marker if present (cycle advanced).
  let manifest = readManifest(evaluationsDir, slug);
  // Fix 5: restore-sanity. If the manifest's floors are above the current DB
  // MAX(id), the workspace and DB are out of sync (backup restore or manual
  // mutation) and every cycle query would silently hide rows. Fail loudly.
  if (manifest) {
    validateManifestAgainstDb(db, slug, manifest, post);
  }
  // Fix 6: serialize cycle open under a DB transaction. better-sqlite3's
  // transaction holds an immediate (reserved/exclusive) lock, so two concurrent
  // initEvaluation calls on the same slug cannot both capture MAX(id) and
  // double-open a cycle. The manifest write happens inside the txn; if another
  // process opens a cycle first we re-read the manifest and no-op.
  const openCycle = db.transaction(() => {
    const fresh = readManifest(evaluationsDir, slug);
    if (!fresh) {
      const created: EvaluationManifest = {
        slug,
        content_type: contentType,
        expected_reviewers: reviewers,
        initialized_at: now,
        cycle_started_at: now,
        cycles: [{
          started_at: now,
          evaluation_id_floor: maxId(db, 'evaluations', slug),
          synthesis_id_floor: maxId(db, 'evaluation_synthesis', slug),
          is_update_cycle: isUpdateReview ? true : undefined,
        }],
      };
      writeManifest(evaluationsDir, created);
      return created;
    }
    const last = fresh.cycles[fresh.cycles.length - 1];
    // Force-close the current cycle when a reject sentinel is present but
    // the cycle is still marked open. This handles the crash-recovery window
    // where rejectEvaluation's DB commit succeeded but the cycle-close
    // manifest write didn't land. Without this check, initEvaluation would
    // reuse the pre-reject cycle intact (pin + hashes preserved) and
    // completeEvaluation could advance a rejected post to publish.
    const sentinelPresent = existsSync(rejectMarkerPath(evaluationsDir, slug));
    if (!last.ended_reason && sentinelPresent) {
      last.ended_at = now;
      last.ended_reason = 'rejected';
    }
    if (last.ended_reason) {
      fresh.cycles.push({
        started_at: now,
        evaluation_id_floor: maxId(db, 'evaluations', slug),
        synthesis_id_floor: maxId(db, 'evaluation_synthesis', slug),
        is_update_cycle: isUpdateReview ? true : undefined,
      });
      fresh.cycle_started_at = now;
      writeManifest(evaluationsDir, fresh);
      const marker = rejectMarkerPath(evaluationsDir, slug);
      if (existsSync(marker)) rmSync(marker, { force: true });
      // Purge stale reviewer artifacts so the prior cycle's files cannot be
      // replayed by accident (or by re-invoking `blog evaluate record` with
      // the same filename). DB rows are preserved for audit via monotonic
      // row-id floors — only the on-disk reviewer JSON/MD files rotate.
      purgeCycleArtifacts(workspaceDir);
    }
    return fresh;
  });
  manifest = openCycle();

  // Phase advance semantics:
  //   - standard (!isUpdateReview): draft → evaluate when entering eval flow
  //   - update-review (isUpdateReview): phase stays 'published'; the update
  //     cycle is tracked separately in update_cycles and does NOT rewind the
  //     post's lifecycle phase (plan: "posts.phase stays published throughout
  //     an update")
  if (!isUpdateReview && post.phase === 'draft') {
    advancePhase(db, slug, 'evaluate');
  }

  return { manifest, workspaceDir };
}

function rejectMarkerPath(evaluationsDir: string, slug: string): string {
  return join(evaluationDir(evaluationsDir, slug), '.rejected_at');
}

// Files that belong to a single evaluation cycle. When a new cycle opens after
// a closed prior cycle, these must not persist — otherwise a reviewer JSON /
// report / autocheck sidecar from a pre-reject draft could be re-recorded into
// the new cycle and spoof a clean review of a changed draft. The manifest and
// `.rejected_at` marker survive; they are cycle-aware metadata, not reviewer
// artifacts.
const CYCLE_ARTIFACT_FILES: readonly string[] = [
  'structural.json',
  'adversarial.json',
  'methodology.json',
  'structural.md',
  'adversarial.md',
  'methodology.md',
  'structural.lint.json',
  'synthesis.md',
  'synthesis.receipt.json',
] as const;

function purgeCycleArtifacts(workspaceDir: string): void {
  for (const name of CYCLE_ARTIFACT_FILES) {
    const p = join(workspaceDir, name);
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

function closeCurrentCycle(
  db: Database.Database,
  evaluationsDir: string,
  slug: string,
  reason: CycleEndedReason,
): void {
  const manifest = readManifest(evaluationsDir, slug);
  if (!manifest) return;
  const last = manifest.cycles[manifest.cycles.length - 1];
  if (last.ended_reason) return;
  last.ended_at = dbNow(db);
  last.ended_reason = reason;
  writeManifest(evaluationsDir, manifest);
}

export function recordReview(
  db: Database.Database,
  slug: string,
  reviewer: ReviewerType,
  reportPath: string,
  output: ReviewerOutput,
  evaluationsDir: string,
  artifactPaths: SynthesisArtifactPaths,
): EvaluationRow {
  // Defense in depth: validate schema here too, so programmatic callers that
  // skip the CLI's parseReviewerOutput cannot insert malformed data.
  const validation = validateReviewerOutput(output);
  if (!validation.ok) {
    throw new Error(`ReviewerOutput schema violation:\n  - ${validation.errors.join('\n  - ')}`);
  }

  // Acquire slug-scoped lock for the duration of record. Serializes against
  // concurrent record/synthesize/complete/reject on the same slug so the
  // FS provenance check + DB insert + manifest hash write cannot be
  // interleaved with another process mutating the same files.
  const releaseLock = acquireEvaluateLock(evaluationsDir, slug);
  try {
    return recordReviewLocked(db, slug, reviewer, reportPath, output, evaluationsDir, artifactPaths);
  } finally {
    releaseLock();
  }
}

function recordReviewLocked(
  db: Database.Database,
  slug: string,
  reviewer: ReviewerType,
  reportPath: string,
  output: ReviewerOutput,
  evaluationsDir: string,
  artifactPaths: SynthesisArtifactPaths,
): EvaluationRow {
  // Phase 7: peek at manifest first so the phase guard allows 'published'
  // when the current cycle is an update-review.
  const earlyManifest = readManifest(evaluationsDir, slug);
  const post = getEvaluateOrUpdatePost(db, slug, earlyManifest);
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }
  if (output.reviewer !== reviewer) {
    throw new Error(
      `Reviewer mismatch: --reviewer '${reviewer}' but JSON contains reviewer '${output.reviewer}'.`,
    );
  }
  const manifest = readManifest(evaluationsDir, slug);
  if (!manifest) {
    throw new Error(`Evaluation workspace not initialized for '${slug}'. Run 'blog evaluate init' first.`);
  }
  validateManifestAgainstDb(db, slug, manifest, post);
  if (!manifest.expected_reviewers.includes(reviewer)) {
    throw new Error(
      `Reviewer '${reviewer}' is not in the expected reviewer list for content_type='${post.content_type}'. ` +
      `Allowed: ${manifest.expected_reviewers.join(', ')}.`,
    );
  }
  // Refuse writes to a closed cycle. This covers the crash-recovery window
  // where rejectEvaluation marked the cycle `ended_reason='rejected'` but the
  // DB phase update did not commit, leaving the post in `evaluate` with a
  // closed current cycle. Without this guard, a record here would land a row
  // tagged against the closed cycle's floor and become visible to the next
  // synthesize as if it were a valid in-cycle review.
  const cycle = currentCycle(manifest);
  if (cycle.ended_reason !== undefined) {
    throw new Error(
      `Current evaluation cycle for '${slug}' is closed (${cycle.ended_reason}). ` +
      `Run 'blog evaluate init' to open a new cycle before recording.`,
    );
  }
  // Pin the artifact hashes this reviewer actually saw. runSynthesis asserts
  // every reviewer's pin matches, so an edit to drafts/benchmarks between
  // recording reviewer A on D0 and reviewer B on D1 is detected — D0 and D1
  // hashes differ, synthesis refuses. Also serves as the "reviewers saw the
  // current state" anchor for completeEvaluation.
  const recordedArtifactHashes = computeReviewedArtifactHashes(artifactPaths, evaluationsDir, slug);
  // Reviewer provenance check. `artifact_hashes` is a REQUIRED field (schema
  // validator rejects outputs that omit it), so every reviewer commits to the
  // exact file set it judged. Closes the "generate reviewer JSON against D0 →
  // edit draft to D1 → record stale JSON" bypass — a stale JSON either
  // declares D0 hashes (mismatch with live D1 → rejected) or declares D1
  // hashes it never saw (forgery, but still requires the attacker to compute
  // the new hash set, and the reviewer's actual judgment still applies to D0
  // content they have to pretend they reviewed).
  const mismatches: string[] = [];
  for (const key of Object.keys(recordedArtifactHashes)) {
    const claimed = output.artifact_hashes[key];
    if (claimed === undefined) {
      mismatches.push(`${key}: reviewer did not declare a hash for this artifact`);
    } else if (claimed !== recordedArtifactHashes[key]) {
      mismatches.push(`${key}: reviewer pinned ${claimed}, disk has ${recordedArtifactHashes[key]}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Reviewer artifact provenance mismatch for '${slug}' / '${reviewer}':\n  - ${mismatches.join('\n  - ')}\n` +
      `The reviewer JSON was produced against a different artifact version than what is on disk now. ` +
      `Either re-run the reviewer against the current draft/benchmark/lint, or revert the workspace to the reviewed state.`,
    );
  }

  // Phase 7: is_update_review is driven by the explicit is_update_cycle flag
  // on the current cycle (set by `initEvaluation` when invoked by
  // `blog update evaluate`). Replaces the pre-Phase-7 `cycles.length > 1`
  // inference, which falsely tagged reject-retry cycles as updates and
  // couldn't fire until the first reject. First-cycle records are 0 unless
  // explicitly tagged.
  const isUpdate = cycle.is_update_cycle === true ? 1 : 0;

  const issuesJson = JSON.stringify(output.issues);
  const canonicalIssues = canonicalIssuesJson(output.issues);
  const normalizedReportPath = resolve(reportPath);

  const selectStmt = db.prepare('SELECT * FROM evaluations WHERE id = ?');
  const insert = db.prepare(`
    INSERT INTO evaluations (post_slug, reviewer, model, passed, issues_json, report_path, is_update_review)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Dedupe check + INSERT + per-reviewer-hash manifest write wrapped in a
  // single transaction. better-sqlite3 holds a reserved write lock for the
  // duration so concurrent recordReview for different reviewers on the same
  // slug cannot RMW-race on manifest.reviewer_artifact_hashes. Byte-identical
  // payload dedups to a single row AND re-pins the hashes (covers manifest
  // corruption recovery where the DB row exists but the manifest slot is
  // missing). The manifest is re-read inside the txn to pick up any external
  // writes that landed between our own readManifest() and the txn body.
  const tx = db.transaction((): { row: EvaluationRow; inserted: boolean } => {
    const existing = latestPerReviewerInCycle(db, slug, reviewer, cycle.evaluation_id_floor);
    let row: EvaluationRow;
    let inserted: boolean;
    if (
      existing
      && existing.model === output.model
      && (existing.passed === 1) === output.passed
      && canonicalIssuesJson(JSON.parse(existing.issues_json ?? '[]') as Issue[]) === canonicalIssues
      && resolve(existing.report_path) === normalizedReportPath
    ) {
      row = existing;
      inserted = false;
    } else {
      const info = insert.run(
        slug,
        reviewer,
        output.model,
        output.passed ? 1 : 0,
        issuesJson,
        reportPath,
        isUpdate,
      );
      row = selectStmt.get(info.lastInsertRowid) as EvaluationRow;
      inserted = true;
    }
    // Always re-pin the reviewer artifact hashes — even on dedup — so a
    // recovery from manifest corruption completes. Re-read manifest inside
    // the txn to serialize against concurrent record of a different reviewer.
    const freshManifest = readManifest(evaluationsDir, slug);
    if (freshManifest) {
      const freshCycle = currentCycle(freshManifest);
      if (!freshCycle.ended_reason) {
        if (!freshCycle.reviewer_artifact_hashes) freshCycle.reviewer_artifact_hashes = {} as Record<ReviewerType, Record<string, string>>;
        freshCycle.reviewer_artifact_hashes[reviewer] = recordedArtifactHashes;
        writeManifest(evaluationsDir, freshManifest);
      }
    }
    return { row, inserted };
  });
  const { row } = tx();
  return row;
}

function currentCycle(manifest: EvaluationManifest): EvaluationCycle {
  return manifest.cycles[manifest.cycles.length - 1];
}

function latestPerReviewerInCycle(
  db: Database.Database,
  slug: string,
  reviewer: ReviewerType,
  evaluationIdFloor: number,
): EvaluationRow | undefined {
  return db.prepare(`
    SELECT *
    FROM evaluations
    WHERE post_slug = ? AND reviewer = ? AND id > ?
    ORDER BY id DESC
    LIMIT 1
  `).get(slug, reviewer, evaluationIdFloor) as EvaluationRow | undefined;
}

export function listRecordedReviewers(db: Database.Database, slug: string): ReviewerType[] {
  const rows = db.prepare(`
    SELECT reviewer
    FROM evaluations
    WHERE post_slug = ?
    GROUP BY reviewer
  `).all(slug) as Array<{ reviewer: ReviewerType }>;
  return rows.map((r) => r.reviewer);
}

// Cycle-scoped counterpart to listRecordedReviewers. Only rows with id above
// the cycle's evaluation_id_floor count — so immediately after a reject+re-init,
// `blog evaluate show` correctly reports every reviewer as pending even though
// the prior cycle's rows still live in the DB for audit.
export function listRecordedReviewersInCycle(
  db: Database.Database,
  slug: string,
  evaluationIdFloor: number,
): ReviewerType[] {
  const rows = db.prepare(`
    SELECT reviewer
    FROM evaluations
    WHERE post_slug = ? AND id > ?
    GROUP BY reviewer
  `).all(slug, evaluationIdFloor) as Array<{ reviewer: ReviewerType }>;
  return rows.map((r) => r.reviewer);
}

// Immutable artifact snapshot captured once per synthesis. Every downstream
// consumer (autocheck union, autocheck fingerprint set, reviewed-artifact-hash
// pin) operates on these frozen bytes — NOT on the mutable filesystem. This
// closes the mid-synthesis swap race: an operator swapping
// structural.lint.json to `[]` between the union-read and the fingerprint-
// read cannot drop counts.autocheck to 0, and swapping index.mdx between
// hash validation and post-commit pin cannot authorize an unreviewed draft.
interface SynthesisSnapshot {
  // Raw bytes of each reviewed artifact, read once. Missing files are
  // represented as `null` — the keys match computeReviewedArtifactHashes.
  bytes: Record<string, Buffer | null>;
  // SHA-256 over the above bytes (or ARTIFACT_ABSENT when missing). Used as
  // both the "reviewers saw this" check and the completeEvaluation drift pin.
  hashes: Record<string, string>;
  // Parsed autocheck lint issues — fail-closed on missing/corrupt sidecar.
  lint: Issue[];
  // Precomputed autocheck fingerprint set from `lint`.
  lintFingerprints: Set<string>;
}

function readArtifactBytes(path: string): Buffer | null {
  if (!existsSync(path)) return null;
  const lst = lstatSync(path, { throwIfNoEntry: false });
  if (lst && !lst.isFile()) {
    throw new Error(`Reviewed artifact is not a regular file: ${path} (type=${lst.isSymbolicLink() ? 'symlink' : lst.isDirectory() ? 'directory' : 'special'}).`);
  }
  return readFileSync(path);
}

function bytesHash(b: Buffer | null): string {
  if (b === null) return ARTIFACT_ABSENT;
  return createHash('sha256').update(b).digest('hex');
}

function captureSynthesisSnapshot(
  artifactPaths: SynthesisArtifactPaths,
  evaluationsDir: string,
  slug: string,
): SynthesisSnapshot {
  const workspaceDir = evaluationDir(evaluationsDir, slug);
  const paths: Record<string, string> = {
    'draft/index.mdx': join(artifactPaths.draftsDir, slug, 'index.mdx'),
    'benchmark/results.json': join(artifactPaths.benchmarkDir, slug, 'results.json'),
    'benchmark/environment.json': join(artifactPaths.benchmarkDir, slug, 'environment.json'),
    'evaluation/structural.lint.json': join(workspaceDir, 'structural.lint.json'),
  };
  const bytes: Record<string, Buffer | null> = {};
  const hashes: Record<string, string> = {};
  for (const [key, path] of Object.entries(paths)) {
    bytes[key] = readArtifactBytes(path);
    hashes[key] = bytesHash(bytes[key]);
  }
  // Lint is fail-closed: the sidecar MUST exist and parse as an array at
  // synthesis time. Parse once from the snapshot bytes so a concurrent swap
  // cannot show different content to different consumers.
  const lintKey = 'evaluation/structural.lint.json';
  const lintBuf = bytes[lintKey];
  if (lintBuf === null) {
    throw new Error(
      `Autocheck artifact missing: ${paths[lintKey]}. ` +
      `Run 'blog evaluate structural-autocheck <slug>' before synthesizing.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lintBuf.toString('utf-8'));
  } catch (e) {
    throw new Error(`Autocheck artifact is not valid JSON (${paths[lintKey]}): ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Autocheck artifact must be a JSON array (${paths[lintKey]}).`);
  }
  const lint: Issue[] = [];
  const lintFingerprints = new Set<string>();
  for (const ac of parsed as Issue[]) {
    if (!ac || typeof ac.title !== 'string' || typeof ac.description !== 'string') {
      throw new Error(`Autocheck artifact contains a malformed issue (missing title/description) at ${paths[lintKey]}.`);
    }
    lint.push(ac);
    lintFingerprints.add(crossReviewerFingerprint(ac.title, ac.description));
  }
  return { bytes, hashes, lint, lintFingerprints };
}

function unionAutocheckFromSnapshot(issues: Issue[], snapshot: SynthesisSnapshot): Issue[] {
  // Upgrade any reviewer-authored issue whose fingerprint matches an autocheck
  // finding so the source tag reflects authority. Authoritative blocking still
  // flows from snapshot.lintFingerprints; this rewrite is cosmetic for report
  // rendering.
  const reviewerFingerprints = new Set<string>();
  const merged: Issue[] = issues.map((i) => {
    const fp = crossReviewerFingerprint(i.title, i.description);
    reviewerFingerprints.add(fp);
    if (snapshot.lintFingerprints.has(fp)) {
      return { ...i, source: 'autocheck' };
    }
    return i;
  });
  for (const ac of snapshot.lint) {
    const fp = crossReviewerFingerprint(ac.title, ac.description);
    if (!reviewerFingerprints.has(fp)) {
      merged.push({ ...ac, source: 'autocheck' });
      reviewerFingerprints.add(fp);
    }
  }
  return merged;
}

export interface RunSynthesisResult {
  synthesis: SynthesisResult;
  reportPath: string;
  row: EvaluationSynthesisRow;
}

export function runSynthesis(
  db: Database.Database,
  slug: string,
  evaluationsDir: string,
  artifactPaths: SynthesisArtifactPaths,
): RunSynthesisResult {
  const releaseLock = acquireEvaluateLock(evaluationsDir, slug);
  try {
    return runSynthesisLocked(db, slug, evaluationsDir, artifactPaths);
  } finally {
    releaseLock();
  }
}

function runSynthesisLocked(
  db: Database.Database,
  slug: string,
  evaluationsDir: string,
  artifactPaths: SynthesisArtifactPaths,
): RunSynthesisResult {
  // Phase 7: read manifest first to surface the update-cycle phase
  // allowance; the original dispatch (post → manifest) rejected 'published'
  // posts unconditionally.
  const earlyManifest = readManifest(evaluationsDir, slug);
  const post = getEvaluateOrUpdatePost(db, slug, earlyManifest);
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }
  const manifest = readManifest(evaluationsDir, slug);
  if (!manifest) {
    throw new Error(`Evaluation workspace not initialized for '${slug}'. Run 'blog evaluate init' first.`);
  }
  validateManifestAgainstDb(db, slug, manifest, post);
  const cycleAtStart = currentCycle(manifest);
  if (cycleAtStart.ended_reason !== undefined) {
    throw new Error(
      `Current evaluation cycle for '${slug}' is closed (${cycleAtStart.ended_reason}). ` +
      `Run 'blog evaluate init' to open a new cycle before synthesizing.`,
    );
  }
  // Manifest version stamp — hash of the raw on-disk manifest bytes taken
  // BEFORE the synthesis transaction. After the txn commits we re-read the
  // manifest and compare; if a concurrent reject/init ran while synthesis was
  // in flight, the stamp diverges and we refuse to write back a stale
  // snapshot. Prevents last-writer-wins clobbering of `ended_reason` or a
  // freshly-opened cycle.
  const manifestStampBefore = manifestVersionStamp(evaluationsDir, slug);

  const expected = manifest.expected_reviewers;
  const workspaceDir = evaluationDir(evaluationsDir, slug);
  const reportPath = join(workspaceDir, 'synthesis.md');

  // Capture an immutable artifact snapshot ONCE. All downstream consumers
  // (autocheck union, fingerprint blocking, drift pin) use these frozen
  // bytes. A concurrent FS swap cannot affect the gate mid-synthesis.
  const snapshot = captureSynthesisSnapshot(artifactPaths, evaluationsDir, slug);

  const insertSynthesis = db.prepare(`
    INSERT INTO evaluation_synthesis
      (post_slug, consensus_issues, majority_issues, single_issues, verdict, report_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const updatePost = db.prepare(`
    UPDATE posts
    SET evaluation_passed = ?, evaluation_score = ?, updated_at = CURRENT_TIMESTAMP
    WHERE slug = ?
  `);
  const selectSynth = db.prepare('SELECT * FROM evaluation_synthesis WHERE id = ?');

  // Wrap reviewer reads, autocheck union, MAX(id) capture, INSERT, and UPDATE
  // in a single DB transaction. better-sqlite3 holds an immediate (reserved)
  // write lock for the duration of the txn, so a concurrent recordReview on
  // the same DB connection pool is serialized before or after — it cannot slip
  // a new row in between the reviewer reads and the pin. If the txn fails
  // mid-way, neither evaluation_synthesis nor posts.evaluation_passed are
  // mutated — the gate flip is atomic.
  const tx = db.transaction((): { synthesis: SynthesisResult; outputs: ReviewerOutput[]; row: EvaluationSynthesisRow; maxEvalIdAtSynthesis: number } => {
    const cycle = currentCycle(manifest);
    const outputs: ReviewerOutput[] = [];
    const missing: ReviewerType[] = [];
    for (const reviewer of expected) {
      // Only rows in the current cycle satisfy the gate. Prior-cycle rows
      // persist for audit behind the monotonic id floor.
      const row = latestPerReviewerInCycle(db, slug, reviewer, cycle.evaluation_id_floor);
      if (!row) {
        missing.push(reviewer);
        continue;
      }
      let issues: ReviewerOutput['issues'];
      try {
        issues = JSON.parse(row.issues_json ?? '[]') as ReviewerOutput['issues'];
      } catch (e) {
        throw new Error(`Stored issues_json for reviewer '${reviewer}' is not valid JSON: ${(e as Error).message}`);
      }
      if (!Array.isArray(issues)) {
        throw new Error(`Stored issues_json for reviewer '${reviewer}' is not an array.`);
      }
      if (reviewer === 'structural') {
        issues = unionAutocheckFromSnapshot(issues, snapshot);
      }
      outputs.push({
        reviewer: row.reviewer,
        model: row.model,
        passed: row.passed === 1,
        issues,
        report_path: row.report_path,
        // Hydrate from manifest — reviewer pinned these hashes at record time.
        // Used by synthesis for cross-reviewer artifact binding + drift pin.
        artifact_hashes: cycle.reviewer_artifact_hashes?.[row.reviewer] ?? {},
      });
    }
    if (missing.length > 0) {
      throw new Error(
        `Cannot synthesize: missing reviewer outputs for ${missing.join(', ')}. ` +
        `Run 'blog evaluate record' for each before synthesizing.`,
      );
    }

    // Per-reviewer artifact binding: every reviewer must have pinned the same
    // artifact hashes at record time, AND those hashes must match the frozen
    // synthesis snapshot. Without this, a reviewer could judge D0, someone
    // edits the draft to D1, and synthesis would pin D1 — the gate would ship
    // content reviewers never saw. Compared against snapshot.hashes (not the
    // live FS) so a swap during synthesis cannot change the reference.
    const reviewerHashes = cycle.reviewer_artifact_hashes ?? {} as Record<ReviewerType, Record<string, string>>;
    for (const reviewer of expected) {
      const pinned = reviewerHashes[reviewer];
      if (!pinned) {
        throw new Error(
          `Missing reviewer_artifact_hashes for '${reviewer}' in the current cycle of '${slug}'. ` +
          `Re-record the reviewer to pin the artifact snapshot.`,
        );
      }
      for (const key of Object.keys(snapshot.hashes)) {
        if (pinned[key] !== snapshot.hashes[key]) {
          throw new Error(
            `Artifact '${key}' drifted between reviewer '${reviewer}' recording it (${pinned[key]}) and synthesis (${snapshot.hashes[key]}). ` +
            `Reviewers judged a different file set than what exists now — re-record every reviewer against the current artifacts.`,
          );
        }
      }
    }

    const synthesis = synthesize(outputs, expected, snapshot.lintFingerprints);
    const total = synthesis.counts.total;
    const score = 1 - (synthesis.counts.consensus * 2 + synthesis.counts.majority) / Math.max(1, total);

    // MAX(id) captured INSIDE the txn — the reserved lock held above ensures
    // no concurrent recordReview can land a new row between the reviewer reads
    // and this sample. The pin therefore covers exactly the rows synthesized.
    const maxEvalIdAtSynthesis = maxId(db, 'evaluations', slug);

    const info = insertSynthesis.run(
      slug,
      synthesis.counts.consensus,
      synthesis.counts.majority,
      synthesis.counts.single,
      synthesis.verdict,
      reportPath,
    );
    updatePost.run(synthesis.verdict === 'pass' ? 1 : 0, score, slug);
    const row = selectSynth.get(info.lastInsertRowid) as EvaluationSynthesisRow;
    return { synthesis, outputs, row, maxEvalIdAtSynthesis };
  });
  const { synthesis, outputs, row, maxEvalIdAtSynthesis } = tx();

  // Render + persist the report and manifest pin AFTER the DB tx commits.
  // The report file is advisory (synthesis row in DB is authoritative). The
  // manifest pin is also advisory — if the write fails after DB commit, the
  // pin stays undefined and completeEvaluation will fail-closed:
  // operators must re-run synthesize to reattach a pin before completing.
  const report = renderSynthesisReport(slug, synthesis, outputs);
  writeFileSync(reportPath, report, 'utf-8');

  // Optimistic concurrency check: re-stamp the manifest immediately before
  // writing the pin. If a concurrent rejectEvaluation or initEvaluation
  // mutated the manifest while our synthesis txn was in flight, the stamp
  // diverges and we refuse to write back a stale snapshot. Without this
  // check, last-writer-wins would erase `ended_reason` or a freshly-opened
  // cycle, re-exposing prior-cycle rows to the gate.
  const manifestStampAfter = manifestVersionStamp(evaluationsDir, slug);
  if (manifestStampAfter !== manifestStampBefore) {
    throw new Error(
      `Manifest changed on disk while synthesis was in flight for '${slug}'. ` +
      `A concurrent reject/init modified the cycle state. Re-run 'blog evaluate synthesize' to observe the current manifest. ` +
      `(The DB synthesis row is committed and will be the authoritative latest; completeEvaluation will still fail-closed on the missing pin.)`,
    );
  }
  const cycle = currentCycle(manifest);
  cycle.last_synthesis_eval_id = maxEvalIdAtSynthesis;
  // Pin the reviewed artifacts from the snapshot — NOT from a fresh
  // filesystem read. Using snapshot.hashes means the same bytes that drove
  // the autocheck union and fingerprint-blocking also drive the drift pin;
  // no window for a concurrent swap to change the reference after validation.
  cycle.reviewed_artifact_hashes = { ...snapshot.hashes };
  // Fix 4 (pin tamper-upward defense in depth): also write a synthesis
  // receipt sidecar. The receipt hashes verdict + pin + artifact hashes +
  // reviewer hashes and completeEvaluation recomputes and verifies. An
  // operator raising `last_synthesis_eval_id` in the manifest without a real
  // re-synthesis would need to also forge a consistent receipt.
  writeSynthesisReceipt(workspaceDir, {
    pin: maxEvalIdAtSynthesis,
    verdict: synthesis.verdict,
    reviewed_artifact_hashes: snapshot.hashes,
    reviewer_artifact_hashes: cycle.reviewer_artifact_hashes ?? {},
    synthesis_row_id: row.id,
    cluster_identity: synthesis.cluster_identity,
  });
  writeManifest(evaluationsDir, manifest);

  return { synthesis, reportPath, row };
}

export function latestSynthesis(db: Database.Database, slug: string): EvaluationSynthesisRow | undefined {
  return db.prepare(`
    SELECT *
    FROM evaluation_synthesis
    WHERE post_slug = ?
    ORDER BY datetime(synthesized_at) DESC, id DESC
    LIMIT 1
  `).get(slug) as EvaluationSynthesisRow | undefined;
}

export function latestSynthesisInCycle(
  db: Database.Database,
  slug: string,
  synthesisIdFloor: number,
): EvaluationSynthesisRow | undefined {
  return db.prepare(`
    SELECT *
    FROM evaluation_synthesis
    WHERE post_slug = ? AND id > ?
    ORDER BY id DESC
    LIMIT 1
  `).get(slug, synthesisIdFloor) as EvaluationSynthesisRow | undefined;
}

export function completeEvaluation(
  db: Database.Database,
  slug: string,
  evaluationsDir: string,
  artifactPaths: SynthesisArtifactPaths,
): void {
  const releaseLock = acquireEvaluateLock(evaluationsDir, slug);
  try {
    completeEvaluationLocked(db, slug, evaluationsDir, artifactPaths);
  } finally {
    releaseLock();
  }
}

function completeEvaluationLocked(
  db: Database.Database,
  slug: string,
  evaluationsDir: string,
  artifactPaths: SynthesisArtifactPaths,
): void {
  // Phase 7: read manifest first so update-cycle posts in 'published' are
  // accepted. The original getEvaluatePost → readManifest order rejected
  // 'published' before the update-review branch could evaluate.
  const earlyManifest = readManifest(evaluationsDir, slug);
  const post = getEvaluateOrUpdatePost(db, slug, earlyManifest);
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }
  const manifest = readManifest(evaluationsDir, slug);
  if (!manifest) {
    throw new Error(`Evaluation workspace not initialized for '${slug}'.`);
  }
  validateManifestAgainstDb(db, slug, manifest, post);
  // Only a synthesis produced in the current cycle authorizes advancement.
  // A stale pass from a pre-reject cycle does not qualify.
  const cycle = currentCycle(manifest);
  // Refuse to advance a closed cycle. Covers the reject-crash window where the
  // cycle is closed in the manifest but the phase update did not commit, and
  // any post-reject paradigm where the operator tries to `complete` without
  // running `init` to open a fresh cycle first.
  if (cycle.ended_reason !== undefined) {
    throw new Error(
      `Current evaluation cycle for '${slug}' is closed (${cycle.ended_reason}). ` +
      `A closed cycle cannot authorize phase advancement. Run 'blog evaluate init' to open a new cycle.`,
    );
  }
  const synthesis = latestSynthesisInCycle(db, slug, cycle.synthesis_id_floor);
  if (!synthesis) {
    throw new Error(
      `No synthesis recorded for '${slug}' in the current evaluation cycle. ` +
      `Run 'blog evaluate synthesize' first.`,
    );
  }
  if (synthesis.verdict !== 'pass') {
    throw new Error(
      `Latest synthesis verdict is '${synthesis.verdict}', not 'pass'. ` +
      `Address consensus and majority issues, then re-record reviewers and re-synthesize.`,
    );
  }
  // Within-cycle stale-pass guard. If any evaluation row was recorded after
  // synthesis ran, the pass is out of date — the reviewer may have added new
  // blocking issues. Require re-synthesis.
  //
  // A missing pin means the prior synthesis did not persist its manifest pin
  // (crash between DB commit and manifest write, or manual manifest edit).
  // Fail closed: we cannot verify coverage, so we refuse to advance. A fresh
  // synthesize run reattaches the pin and unblocks the gate without side-
  // stepping the coverage check.
  const currentMaxEval = maxId(db, 'evaluations', slug);
  const pin = cycle.last_synthesis_eval_id;
  if (pin === undefined) {
    throw new Error(
      `Synthesis pin is missing for '${slug}' — the last synthesis did not complete cleanly. ` +
      `Re-run 'blog evaluate synthesize' before completing.`,
    );
  }
  if (currentMaxEval > pin) {
    throw new Error(
      `Evaluation rows were recorded after the last synthesis (synthesis covered up to eval id ${pin}, ` +
      `current max is ${currentMaxEval}). Re-run 'blog evaluate synthesize' before completing.`,
    );
  }
  if (!cycle.reviewed_artifact_hashes) {
    throw new Error(
      `Reviewed artifact hashes are missing for '${slug}' — the last synthesis did not complete cleanly. ` +
      `Re-run 'blog evaluate synthesize' before completing.`,
    );
  }

  // Synthesis receipt cross-check. Raises the bar for manifest-only pin
  // tampering: an operator raising `last_synthesis_eval_id` without a real
  // re-synthesis would also need to forge a consistent receipt. The receipt
  // also anchors the cluster-identity fingerprint set that the DB-
  // authoritative re-derivation below compares against — closing the
  // "re-record with different issues but same count distribution" bypass.
  const receiptBody = loadAndVerifySynthesisReceipt(evaluationDir(evaluationsDir, slug), {
    pin,
    verdict: synthesis.verdict,
    reviewed_artifact_hashes: cycle.reviewed_artifact_hashes,
    reviewer_artifact_hashes: cycle.reviewer_artifact_hashes ?? {},
    synthesis_row_id: synthesis.id,
  });

  // Drift check + DB-authoritative re-derivation + cycle close + phase advance
  // INSIDE one transaction. The reserved write lock held by db.transaction
  // blocks concurrent record/synthesize calls from racing between hash recompute
  // and phase flip; the slug-scoped FS lock serializes cooperative CLI callers
  // against each other. lstat-first in fileHash also rejects symlink-redirected
  // artifacts on recomputation.
  const completeTx = db.transaction(() => {
    // Capture an immutable snapshot of the reviewed artifacts once — all
    // downstream consumers (drift pin check, re-derivation autocheck
    // fingerprint set) read from the same frozen bytes. A concurrent FS swap
    // between drift compare and re-derivation cannot show different content.
    const completeSnapshot = captureSynthesisSnapshot(artifactPaths, evaluationsDir, slug);
    const currentHashes = completeSnapshot.hashes;
    const pinnedHashes = cycle.reviewed_artifact_hashes!;
    const drifted: string[] = [];
    for (const [k, pinnedHash] of Object.entries(pinnedHashes)) {
      if (currentHashes[k] !== pinnedHash) drifted.push(k);
    }
    for (const k of Object.keys(currentHashes)) {
      if (!(k in pinnedHashes)) drifted.push(k);
    }
    if (drifted.length > 0) {
      throw new Error(
        `Reviewed artifacts changed after synthesis: ${drifted.join(', ')}. ` +
        `Re-run 'blog evaluate synthesize' to pin the current content before completing.`,
      );
    }

    // DB-authoritative synthesis re-derivation. The stored synthesis row is a
    // materialized view of evaluations; re-running synthesize() on the current
    // latest-per-reviewer rows in cycle MUST produce identical counts and
    // verdict, otherwise a reviewer re-recorded between synthesis and
    // complete. The manifest pin (`last_synthesis_eval_id`) is a cache — this
    // re-derivation is the load-bearing check. It survives a pin-tamper bypass
    // (attacker raises the pin to match currentMaxEval) because the re-derive
    // uses the DB's live rows, not the manifest.
    const expectedReviewersInCycle = manifest.expected_reviewers;
    const rederiveOutputs: ReviewerOutput[] = [];
    for (const reviewerType of expectedReviewersInCycle) {
      const row = latestPerReviewerInCycle(db, slug, reviewerType, cycle.evaluation_id_floor);
      if (!row) {
        throw new Error(
          `Cannot re-derive synthesis at complete time — missing reviewer '${reviewerType}' in current cycle. ` +
          `Evaluation state is inconsistent; re-run 'blog evaluate synthesize'.`,
        );
      }
      let issues: Issue[];
      try {
        issues = JSON.parse(row.issues_json ?? '[]') as Issue[];
      } catch (e) {
        throw new Error(`Stored issues_json for '${reviewerType}' is not valid JSON: ${(e as Error).message}`);
      }
      if (!Array.isArray(issues)) {
        throw new Error(`Stored issues_json for '${reviewerType}' is not an array.`);
      }
      if (reviewerType === 'structural') {
        issues = unionAutocheckFromSnapshot(issues, completeSnapshot);
      }
      rederiveOutputs.push({
        reviewer: row.reviewer,
        model: row.model,
        passed: row.passed === 1,
        issues,
        report_path: row.report_path,
        artifact_hashes: cycle.reviewer_artifact_hashes?.[reviewerType] ?? {},
      });
    }
    const rederived = synthesize(rederiveOutputs, expectedReviewersInCycle, completeSnapshot.lintFingerprints);
    const mismatches: string[] = [];
    if (rederived.verdict !== synthesis.verdict) {
      mismatches.push(`verdict (stored='${synthesis.verdict}', re-derived='${rederived.verdict}')`);
    }
    if (rederived.counts.consensus !== synthesis.consensus_issues) {
      mismatches.push(`consensus (stored=${synthesis.consensus_issues}, re-derived=${rederived.counts.consensus})`);
    }
    if (rederived.counts.majority !== synthesis.majority_issues) {
      mismatches.push(`majority (stored=${synthesis.majority_issues}, re-derived=${rederived.counts.majority})`);
    }
    if (rederived.counts.single !== synthesis.single_issues) {
      mismatches.push(`single (stored=${synthesis.single_issues}, re-derived=${rederived.counts.single})`);
    }
    // Cluster-identity comparison. Even when counts coincide (attacker
    // re-records with different issues but the same bucket distribution),
    // the representative fingerprint sets must match — each synthesis-time
    // cluster is pinned by its content hash in the receipt. Different issues
    // produce different fingerprints, so a count-preserving re-record is
    // still caught.
    const pinnedIdentity = receiptBody.cluster_identity;
    const bucketIdentityMismatch = (bucket: 'consensus' | 'majority' | 'single'): boolean => {
      const pinned = pinnedIdentity[bucket];
      const now = rederived.cluster_identity[bucket];
      if (pinned.length !== now.length) return true;
      for (let i = 0; i < pinned.length; i++) {
        if (pinned[i] !== now[i]) return true;
      }
      return false;
    };
    for (const bucket of ['consensus', 'majority', 'single'] as const) {
      if (bucketIdentityMismatch(bucket)) {
        mismatches.push(
          `${bucket} cluster identity (pinned=[${pinnedIdentity[bucket].join(',')}], re-derived=[${rederived.cluster_identity[bucket].join(',')}])`,
        );
      }
    }
    if (mismatches.length > 0) {
      throw new Error(
        `DB state drifted since synthesis for '${slug}': ${mismatches.join(', ')}. ` +
        `A reviewer was re-recorded after synthesis ran. Re-run 'blog evaluate synthesize' before completing — ` +
        `the manifest pin alone is not authoritative.`,
      );
    }

    closeCurrentCycle(db, evaluationsDir, slug, 'passed');
    // Phase 7: update-review cycles do NOT advance the post's phase — the
    // post stays 'published' throughout an update. The pipeline runner for
    // `blog update publish` reads the fresh pass verdict from
    // evaluation_synthesis directly.
    if (cycle.is_update_cycle !== true) {
      advancePhase(db, slug, 'publish');
    }
  });
  completeTx();
}

export function rejectEvaluation(
  db: Database.Database,
  slug: string,
  evaluationsDir: string,
): void {
  const releaseLock = acquireEvaluateLock(evaluationsDir, slug);
  try {
    rejectEvaluationLocked(db, slug, evaluationsDir);
  } finally {
    releaseLock();
  }
}

function rejectEvaluationLocked(
  db: Database.Database,
  slug: string,
  evaluationsDir: string,
): void {
  // Phase 7: peek at manifest so update-cycle posts in 'published' pass
  // the phase guard; their cycle is closed without a phase rewind.
  const earlyManifest = readManifest(evaluationsDir, slug);
  const post = getEvaluateOrUpdatePost(db, slug, earlyManifest);
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }
  const manifest = readManifest(evaluationsDir, slug);
  if (manifest) validateManifestAgainstDb(db, slug, manifest, post);
  mkdirSync(evaluationDir(evaluationsDir, slug), { recursive: true });

  const currentCycleEntry = manifest ? currentCycle(manifest) : undefined;
  const isUpdateReviewReject = currentCycleEntry?.is_update_cycle === true;

  // Write the reject sentinel BEFORE the DB commit. If the DB commit lands
  // and any later FS write fails, the sentinel is already on disk — the next
  // initEvaluation detects it and refuses to reuse the pre-reject cycle.
  // If the DB commit fails, the sentinel exists without a phase flip; that
  // is recoverable because any subsequent operation (record/synthesize/
  // complete/reject) calls validateManifestAgainstDb → unchanged, and
  // rejectEvaluation can be retried idempotently (sentinel overwritten).
  writeFileSync(rejectMarkerPath(evaluationsDir, slug), dbNow(db), 'utf-8');

  // Phase 7: update-review rejects DO NOT rewind phase — the post stays
  // 'published'. The eval cycle closes so a subsequent `blog update draft`
  // + `blog update evaluate` opens a fresh update-review cycle. The
  // reject sentinel still serializes the "init reuses cycle intact"
  // bypass check in initEvaluation.
  const tx = db.transaction(() => {
    if (!isUpdateReviewReject) {
      advancePhase(db, slug, 'draft');
    }
  });
  tx();

  // Cycle-close manifest write. If this fails, the sentinel already holds,
  // and initEvaluation's sentinel check will force a fresh cycle instead
  // of reusing the pre-reject one.
  closeCurrentCycle(db, evaluationsDir, slug, 'rejected');
}

export function readReviewerOutputFromFile(filePath: string): ReviewerOutput {
  if (!existsSync(filePath)) {
    throw new Error(`Reviewer output file not found: ${filePath}`);
  }
  return parseReviewerOutput(readFileSync(filePath, 'utf-8'));
}

export type { Verdict };
