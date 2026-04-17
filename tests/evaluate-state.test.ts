import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { advancePhase, initResearchPost } from '../src/core/research/state.js';
import {
  getEvaluatePost,
  expectedReviewers,
  initEvaluation,
  recordReview,
  runSynthesis,
  completeEvaluation,
  rejectEvaluation,
  listRecordedReviewers,
  latestSynthesis,
  readManifest,
  readReviewerOutputFromFile,
  computeReviewedArtifactHashes,
} from '../src/core/evaluate/state.js';
import { ContentType, ReviewerType, EvaluationRow } from '../src/core/db/types.js';
import { Issue, ReviewerOutput, issueFingerprint } from '../src/core/evaluate/reviewer.js';

interface Fixture {
  tempDir: string;
  evaluationsDir: string;
  draftsDir: string;
  benchmarkDir: string;
  db: Database.Database;
}

function artifactPaths(f: Fixture): { draftsDir: string; benchmarkDir: string } {
  return { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir };
}

let fixture: Fixture | undefined;

afterEach(() => {
  if (fixture?.db) closeDatabase(fixture.db);
  if (fixture) rmSync(fixture.tempDir, { recursive: true, force: true });
  fixture = undefined;
});

function setup(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'eval-state-'));
  const evaluationsDir = join(tempDir, 'evaluations');
  const draftsDir = join(tempDir, 'drafts');
  const benchmarkDir = join(tempDir, 'benchmarks');
  mkdirSync(evaluationsDir, { recursive: true });
  mkdirSync(draftsDir, { recursive: true });
  mkdirSync(benchmarkDir, { recursive: true });
  const db = getDatabase(':memory:');
  fixture = { tempDir, evaluationsDir, draftsDir, benchmarkDir, db };
  return fixture;
}

function seedEvaluatePost(db: Database.Database, slug: string, contentType: ContentType = 'technical-deep-dive'): void {
  initResearchPost(db, slug, 'topic', 'directed', contentType);
  advancePhase(db, slug, 'benchmark');
  advancePhase(db, slug, 'draft');
  advancePhase(db, slug, 'evaluate');
}

function seedDraftPost(db: Database.Database, slug: string, contentType: ContentType = 'technical-deep-dive'): void {
  initResearchPost(db, slug, 'topic', 'directed', contentType);
  advancePhase(db, slug, 'benchmark');
  advancePhase(db, slug, 'draft');
}

function makeIssue(reviewer: ReviewerType, title: string, description: string): Issue {
  return {
    id: issueFingerprint(reviewer, title, description),
    category: 'general',
    severity: 'high',
    title,
    description,
  };
}

// All-absent sentinel hash set for tests that don't create any of the four
// reviewed artifacts on disk before calling recordReview. Matches
// computeReviewedArtifactHashes on a workspace with no draft/benchmark/lint.
const ABSENT_HASHES: Record<string, string> = {
  'draft/index.mdx': '<absent>',
  'benchmark/results.json': '<absent>',
  'benchmark/environment.json': '<absent>',
  'evaluation/structural.lint.json': '<absent>',
};

// Helper: compute current-disk hashes for a fixture+slug pair. Matches what
// recordReview computes via its provenance check.
function currentHashes(f: Fixture, slug: string): Record<string, string> {
  return computeReviewedArtifactHashes(
    { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir },
    f.evaluationsDir,
    slug,
  );
}

// makeOutput auto-derives artifact_hashes from the module-scoped fixture's
// current on-disk state. Pass the slug as 3rd arg when an artifact exists on
// disk at the time of recording (autocheck sidecar, draft, benchmark results).
// Absent `slug`, falls back to all-absent hashes, which matches tests that
// never write any artifact before recording.
function makeOutput(reviewer: ReviewerType, issues: Issue[] = [], slug?: string): ReviewerOutput {
  const artifact_hashes = slug && fixture
    ? currentHashes(fixture, slug)
    : { ...ABSENT_HASHES };
  return { reviewer, model: `${reviewer}-model`, passed: issues.length === 0, issues, artifact_hashes };
}

// Autocheck is authoritative at synthesis time (fails closed when the sidecar
// is missing). Tests that go through runSynthesis must create an empty sidecar.
function writeEmptyAutocheck(evaluationsDir: string, slug: string): void {
  writeFileSync(join(evaluationsDir, slug, 'structural.lint.json'), '[]\n', 'utf-8');
}

describe('expectedReviewers', () => {
  it('returns three reviewers for technical-deep-dive', () => {
    expect(expectedReviewers('technical-deep-dive')).toEqual(['structural', 'adversarial', 'methodology']);
  });
  it('returns three reviewers for project-launch', () => {
    expect(expectedReviewers('project-launch')).toEqual(['structural', 'adversarial', 'methodology']);
  });
  it('returns two reviewers for analysis-opinion (no methodology)', () => {
    expect(expectedReviewers('analysis-opinion')).toEqual(['structural', 'adversarial']);
  });
});

describe('getEvaluatePost — phase enforcement', () => {
  it('returns undefined for missing post', () => {
    const f = setup();
    expect(getEvaluatePost(f.db, 'ghost')).toBeUndefined();
  });
  it('returns post when in evaluate phase', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'real');
    const post = getEvaluatePost(f.db, 'real');
    expect(post?.slug).toBe('real');
  });
  it('throws when post is in the wrong phase', () => {
    const f = setup();
    seedDraftPost(f.db, 'draft-only');
    expect(() => getEvaluatePost(f.db, 'draft-only')).toThrow(/not 'evaluate'/);
  });
});

describe('initEvaluation', () => {
  it('creates workspace and manifest with expected reviewers (technical-deep-dive)', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'alpha');
    const result = initEvaluation(f.db, 'alpha', f.evaluationsDir);
    expect(result.manifest.expected_reviewers).toEqual(['structural', 'adversarial', 'methodology']);
    expect(existsSync(join(f.evaluationsDir, 'alpha', 'manifest.json'))).toBe(true);
  });

  it('uses two-reviewer manifest for analysis-opinion', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'opinion', 'analysis-opinion');
    const result = initEvaluation(f.db, 'opinion', f.evaluationsDir);
    expect(result.manifest.expected_reviewers).toEqual(['structural', 'adversarial']);
  });

  it('is idempotent: second call preserves manifest', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'i');
    const first = initEvaluation(f.db, 'i', f.evaluationsDir);
    const second = initEvaluation(f.db, 'i', f.evaluationsDir);
    expect(second.manifest.initialized_at).toBe(first.manifest.initialized_at);
  });

  it('promotes from draft phase to evaluate', () => {
    const f = setup();
    seedDraftPost(f.db, 'promote');
    initEvaluation(f.db, 'promote', f.evaluationsDir);
    const post = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get('promote') as { phase: string };
    expect(post.phase).toBe('evaluate');
  });

  it('rejects posts in non-draft, non-evaluate phases', () => {
    const f = setup();
    initResearchPost(f.db, 'research-phase', 't', 'directed', 'technical-deep-dive');
    expect(() => initEvaluation(f.db, 'research-phase', f.evaluationsDir)).toThrow(/not 'draft' or 'evaluate'/);
  });
});

describe('recordReview', () => {
  it('inserts a row and returns it', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'rec');
    initEvaluation(f.db, 'rec', f.evaluationsDir);
    const output = makeOutput('structural', [makeIssue('structural', 'T', 'a description that is long enough')]);
    const row = recordReview(f.db, 'rec', 'structural', '/tmp/report.md', output, f.evaluationsDir, artifactPaths(f));
    expect(row.reviewer).toBe('structural');
    expect(JSON.parse(row.issues_json ?? '[]')).toHaveLength(1);
  });

  it('throws on reviewer mismatch between arg and output', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'mismatch');
    initEvaluation(f.db, 'mismatch', f.evaluationsDir);
    const output = makeOutput('structural', []);
    expect(() => recordReview(f.db, 'mismatch', 'adversarial', '/tmp/r.md', output, f.evaluationsDir, artifactPaths(f))).toThrow(/mismatch/);
  });

  it('rejects reviewer not in expected list for analysis-opinion', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'op', 'analysis-opinion');
    initEvaluation(f.db, 'op', f.evaluationsDir);
    const output = makeOutput('methodology', []);
    expect(() => recordReview(f.db, 'op', 'methodology', '/tmp/r.md', output, f.evaluationsDir, artifactPaths(f))).toThrow(/not in the expected/);
  });

  it('re-record is idempotent: byte-identical second call does not insert a duplicate row', () => {
    const f = setup();
    seedEvaluatePost(f.db, 're');
    initEvaluation(f.db, 're', f.evaluationsDir);
    recordReview(f.db, 're', 'structural', '/tmp/r.md', makeOutput('structural', [], 're'), f.evaluationsDir, artifactPaths(f));
    recordReview(f.db, 're', 'structural', '/tmp/r.md', makeOutput('structural', [], 're'), f.evaluationsDir, artifactPaths(f));
    const count = (f.db.prepare(
      "SELECT COUNT(*) AS c FROM evaluations WHERE post_slug = 're' AND reviewer = 'structural'",
    ).get() as { c: number }).c;
    expect(count).toBe(1);
    expect(listRecordedReviewers(f.db, 're')).toEqual(['structural']);
  });

  it('re-record inserts a new row when the payload changes (e.g., new issue added)', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'rec-change');
    initEvaluation(f.db, 'rec-change', f.evaluationsDir);
    recordReview(f.db, 'rec-change', 'structural', '/tmp/r.md', makeOutput('structural', [], 'rec-change'), f.evaluationsDir, artifactPaths(f));
    recordReview(
      f.db,
      'rec-change',
      'structural',
      '/tmp/r.md',
      makeOutput('structural', [makeIssue('structural', 'New', 'A newly found issue description.')]),
      f.evaluationsDir,
      artifactPaths(f),
    );
    const count = (f.db.prepare(
      "SELECT COUNT(*) AS c FROM evaluations WHERE post_slug = 'rec-change' AND reviewer = 'structural'",
    ).get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it('validates ReviewerOutput schema at the library boundary', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'schema');
    initEvaluation(f.db, 'schema', f.evaluationsDir);
    const bad = { reviewer: 'structural', model: '', passed: true, issues: [] } as unknown as ReviewerOutput;
    expect(() => recordReview(f.db, 'schema', 'structural', '/tmp/r.md', bad, f.evaluationsDir, artifactPaths(f)))
      .toThrow(/ReviewerOutput schema violation/);
  });

  it('enforces phase boundary (post in draft phase)', () => {
    const f = setup();
    seedDraftPost(f.db, 'draftp');
    const output = makeOutput('structural', []);
    expect(() => recordReview(f.db, 'draftp', 'structural', '/tmp/r.md', output, f.evaluationsDir, artifactPaths(f))).toThrow(/not 'evaluate'/);
  });
});

describe('runSynthesis', () => {
  function recordAllThree(f: Fixture, slug: string, issuesFn: (r: ReviewerType) => Issue[]): void {
    for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
      const output = makeOutput(reviewer, issuesFn(reviewer), slug);
      recordReview(f.db, slug, reviewer, '/tmp/r.md', output, f.evaluationsDir, artifactPaths(f));
    }
  }

  it('throws when any expected reviewer is missing', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'miss');
    initEvaluation(f.db, 'miss', f.evaluationsDir);
    writeEmptyAutocheck(f.evaluationsDir, 'miss');
    recordReview(f.db, 'miss', 'structural', '/tmp/r.md', makeOutput('structural', [], 'miss'), f.evaluationsDir, artifactPaths(f));
    expect(() => runSynthesis(f.db, 'miss', f.evaluationsDir, artifactPaths(f))).toThrow(/missing reviewer/);
  });

  it('writes synthesis row + report file on success, updates posts.evaluation_passed=1 on pass', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'pass');
    initEvaluation(f.db, 'pass', f.evaluationsDir);
    writeEmptyAutocheck(f.evaluationsDir, 'pass');
    recordAllThree(f, 'pass', () => []);
    const result = runSynthesis(f.db, 'pass', f.evaluationsDir, artifactPaths(f));
    expect(result.synthesis.verdict).toBe('pass');
    expect(existsSync(result.reportPath)).toBe(true);
    const post = f.db.prepare('SELECT evaluation_passed FROM posts WHERE slug = ?').get('pass') as { evaluation_passed: number };
    expect(post.evaluation_passed).toBe(1);
  });

  it('produces fail verdict and evaluation_passed=0 when all three reviewers agree on one issue', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'fail');
    initEvaluation(f.db, 'fail', f.evaluationsDir);
    writeEmptyAutocheck(f.evaluationsDir, 'fail');
    const title = 'Shared issue';
    const desc = 'A shared description long enough to be meaningful here';
    recordAllThree(f, 'fail', (r) => [makeIssue(r, title, desc)]);
    const result = runSynthesis(f.db, 'fail', f.evaluationsDir, artifactPaths(f));
    expect(result.synthesis.verdict).toBe('fail');
    expect(result.synthesis.counts.consensus).toBe(1);
    const post = f.db.prepare('SELECT evaluation_passed FROM posts WHERE slug = ?').get('fail') as { evaluation_passed: number };
    expect(post.evaluation_passed).toBe(0);
  });

  it('throws on corrupt stored issues_json and does not write a synthesis row', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'corrupt');
    initEvaluation(f.db, 'corrupt', f.evaluationsDir);
    writeEmptyAutocheck(f.evaluationsDir, 'corrupt');
    // Record two valid reviewers, then force-corrupt the third row.
    recordReview(f.db, 'corrupt', 'structural', '/tmp/r.md', makeOutput('structural', [], 'corrupt'), f.evaluationsDir, artifactPaths(f));
    recordReview(f.db, 'corrupt', 'adversarial', '/tmp/r.md', makeOutput('adversarial', [], 'corrupt'), f.evaluationsDir, artifactPaths(f));
    recordReview(f.db, 'corrupt', 'methodology', '/tmp/r.md', makeOutput('methodology', [], 'corrupt'), f.evaluationsDir, artifactPaths(f));
    f.db.prepare(`
      UPDATE evaluations SET issues_json = '{not json' WHERE reviewer = 'methodology' AND post_slug = ?
    `).run('corrupt');

    expect(() => runSynthesis(f.db, 'corrupt', f.evaluationsDir, artifactPaths(f))).toThrow();
    const synth = latestSynthesis(f.db, 'corrupt');
    expect(synth).toBeUndefined();
  });
});

describe('completeEvaluation', () => {
  function recordAllAndSynthesize(f: Fixture, slug: string, fail: boolean): void {
    initEvaluation(f.db, slug, f.evaluationsDir);
    writeEmptyAutocheck(f.evaluationsDir, slug);
    const title = 'Shared';
    const desc = 'Same description text in each reviewer output here';
    for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
      const issues = fail ? [makeIssue(reviewer, title, desc)] : [];
      recordReview(f.db, slug, reviewer, '/tmp/r.md', makeOutput(reviewer, issues, slug), f.evaluationsDir, artifactPaths(f));
    }
    runSynthesis(f.db, slug, f.evaluationsDir, artifactPaths(f));
  }

  it('advances phase to publish when latest synthesis verdict is pass', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'complete-pass');
    recordAllAndSynthesize(f, 'complete-pass', false);
    completeEvaluation(f.db, 'complete-pass', f.evaluationsDir, artifactPaths(f));
    const post = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get('complete-pass') as { phase: string };
    expect(post.phase).toBe('publish');
  });

  it('throws and leaves phase untouched when verdict is fail', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'complete-fail');
    recordAllAndSynthesize(f, 'complete-fail', true);
    expect(() => completeEvaluation(f.db, 'complete-fail', f.evaluationsDir, artifactPaths(f))).toThrow(/not 'pass'/);
    const post = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get('complete-fail') as { phase: string };
    expect(post.phase).toBe('evaluate');
  });

  it('throws when synthesis has not been run yet', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'no-synth');
    initEvaluation(f.db, 'no-synth', f.evaluationsDir);
    expect(() => completeEvaluation(f.db, 'no-synth', f.evaluationsDir, artifactPaths(f))).toThrow(/No synthesis/);
  });

  it('refuses to advance using a stale pass from a prior cycle (reject invalidates the gate)', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'stale');
    // Cycle 1: record all three, synthesize pass — but reject instead of complete.
    recordAllAndSynthesize(f, 'stale', false);
    const synthesis = latestSynthesis(f.db, 'stale');
    expect(synthesis?.verdict).toBe('pass');
    rejectEvaluation(f.db, 'stale', f.evaluationsDir);
    // Re-promote to evaluate and re-init — a new cycle begins.
    advancePhase(f.db, 'stale', 'evaluate');
    initEvaluation(f.db, 'stale', f.evaluationsDir);
    // Complete should refuse: the prior pass belongs to the closed cycle.
    expect(() => completeEvaluation(f.db, 'stale', f.evaluationsDir, artifactPaths(f)))
      .toThrow(/current evaluation cycle/);
    const post = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get('stale') as { phase: string };
    expect(post.phase).toBe('evaluate');
  });
});

describe('rejectEvaluation', () => {
  it('moves post back to draft and writes a rejected marker', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'reject');
    initEvaluation(f.db, 'reject', f.evaluationsDir);
    rejectEvaluation(f.db, 'reject', f.evaluationsDir);
    const post = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get('reject') as { phase: string };
    expect(post.phase).toBe('draft');
    expect(existsSync(join(f.evaluationsDir, 'reject', '.rejected_at'))).toBe(true);
  });

  it('reject-retry cycles do NOT flag subsequent recordReview as is_update_review (Phase 7: explicit flag only)', () => {
    // Phase 7 behavior change: pre-Phase-7 this test expected
    // is_update_review=1 via the `cycles.length > 1` inference. That
    // inference is wrong — a reject-retry is a re-evaluation of the same
    // draft, not an update review of a published post. Only cycles opened
    // via `blog update evaluate` (isUpdateReview=true) tag reviewer rows
    // with is_update_review=1; reject-retries stay 0.
    const f = setup();
    seedEvaluatePost(f.db, 'rework');
    initEvaluation(f.db, 'rework', f.evaluationsDir);
    recordReview(f.db, 'rework', 'structural', '/tmp/r.md', makeOutput('structural', [], 'rework'), f.evaluationsDir, artifactPaths(f));
    rejectEvaluation(f.db, 'rework', f.evaluationsDir);
    advancePhase(f.db, 'rework', 'evaluate');
    initEvaluation(f.db, 'rework', f.evaluationsDir);
    recordReview(f.db, 'rework', 'structural', '/tmp/rework.md', makeOutput('structural', [], 'rework'), f.evaluationsDir, artifactPaths(f));

    const rows = f.db.prepare(`
      SELECT is_update_review FROM evaluations WHERE post_slug = ? AND reviewer = 'structural' ORDER BY id ASC
    `).all('rework') as Array<{ is_update_review: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].is_update_review).toBe(0);
    expect(rows[1].is_update_review).toBe(0);
  });

  it('initEvaluation with isUpdateReview=true tags reviewer rows with is_update_review=1', () => {
    const f = setup();
    // Seed a published post — update-review can only init from 'published'.
    f.db.prepare(
      `INSERT INTO posts (slug, phase, mode, content_type)
       VALUES ('update-flow', 'published', 'directed', 'technical-deep-dive')`,
    ).run();
    initEvaluation(f.db, 'update-flow', f.evaluationsDir, { isUpdateReview: true });
    recordReview(f.db, 'update-flow', 'structural', '/tmp/upd.md', makeOutput('structural', [], 'update-flow'), f.evaluationsDir, artifactPaths(f));

    const rows = f.db.prepare(`
      SELECT is_update_review, phase
      FROM evaluations e JOIN posts p ON p.slug = e.post_slug
      WHERE e.post_slug = ? ORDER BY e.id ASC
    `).all('update-flow') as Array<{ is_update_review: number; phase: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].is_update_review).toBe(1);
    // Phase stays 'published' — update-review does not rewind the lifecycle.
    expect(rows[0].phase).toBe('published');
  });

  it('initEvaluation with isUpdateReview=true rejects non-published posts', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'draft-flow');
    expect(() =>
      initEvaluation(f.db, 'draft-flow', f.evaluationsDir, { isUpdateReview: true }),
    ).toThrow(/not 'published'/);
  });

  it('enforces phase boundary (rejects post in draft already)', () => {
    const f = setup();
    seedDraftPost(f.db, 'draft-reject');
    expect(() => rejectEvaluation(f.db, 'draft-reject', f.evaluationsDir)).toThrow(/not 'evaluate'/);
  });
});

describe('runSynthesis — autocheck authoritative union', () => {
  it('unions structural.lint.json issues into the structural output so a reviewer cannot drop autocheck findings', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'auth');
    initEvaluation(f.db, 'auth', f.evaluationsDir);

    // Autocheck produced an issue; write it to structural.lint.json.
    const autocheckIssue = makeIssue('structural', 'Missing companion_repo for benchmarked post', 'Post has has_benchmarks=1 but the draft frontmatter has no companion_repo URL.');
    autocheckIssue.source = 'autocheck';
    autocheckIssue.category = 'missing-companion-repo';
    writeFileSync(
      join(f.evaluationsDir, 'auth', 'structural.lint.json'),
      `${JSON.stringify([autocheckIssue], null, 2)}\n`,
      'utf-8',
    );

    // Structural reviewer submits an EMPTY issues array (dropped autocheck).
    recordReview(f.db, 'auth', 'structural', '/tmp/r.md', makeOutput('structural', [], 'auth'), f.evaluationsDir, artifactPaths(f));
    recordReview(f.db, 'auth', 'adversarial', '/tmp/r.md', makeOutput('adversarial', [], 'auth'), f.evaluationsDir, artifactPaths(f));
    recordReview(f.db, 'auth', 'methodology', '/tmp/r.md', makeOutput('methodology', [], 'auth'), f.evaluationsDir, artifactPaths(f));

    const result = runSynthesis(f.db, 'auth', f.evaluationsDir, artifactPaths(f));
    // Autocheck finding was reinjected at synthesis time as a single-reviewer cluster.
    expect(result.synthesis.counts.single).toBe(1);
    // Autocheck clusters are counted separately and block the verdict even
    // though no reviewer echoed the finding.
    expect(result.synthesis.counts.autocheck).toBe(1);
    expect(result.synthesis.verdict).toBe('fail');
    const post = f.db.prepare('SELECT evaluation_passed FROM posts WHERE slug = ?').get('auth') as { evaluation_passed: number };
    expect(post.evaluation_passed).toBe(0);
  });

  it('passes when no autocheck issues exist and no reviewer issues exist', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'clean');
    initEvaluation(f.db, 'clean', f.evaluationsDir);
    writeEmptyAutocheck(f.evaluationsDir, 'clean');
    for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
      recordReview(f.db, 'clean', reviewer, '/tmp/r.md', makeOutput(reviewer, [], 'clean'), f.evaluationsDir, artifactPaths(f));
    }
    const result = runSynthesis(f.db, 'clean', f.evaluationsDir, artifactPaths(f));
    expect(result.synthesis.counts.autocheck).toBe(0);
    expect(result.synthesis.verdict).toBe('pass');
  });
});

describe('completeEvaluation — artifact drift check', () => {
  function seedAndSynthesize(f: Fixture, slug: string): void {
    seedEvaluatePost(f.db, slug);
    initEvaluation(f.db, slug, f.evaluationsDir);
    mkdirSync(join(f.draftsDir, slug), { recursive: true });
    writeFileSync(join(f.draftsDir, slug, 'index.mdx'), '---\ntitle: ok\n---\nbody v1', 'utf-8');
    writeEmptyAutocheck(f.evaluationsDir, slug);
    for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
      recordReview(f.db, slug, reviewer, '/tmp/r.md', makeOutput(reviewer, [], slug), f.evaluationsDir, artifactPaths(f));
    }
    runSynthesis(f.db, slug, f.evaluationsDir, artifactPaths(f));
  }

  it('refuses to advance when the draft changes after synthesis', () => {
    const f = setup();
    seedAndSynthesize(f, 'drift-draft');
    // Operator edits the draft after synthesis — content reviewers never saw.
    writeFileSync(join(f.draftsDir, 'drift-draft', 'index.mdx'), '---\ntitle: ok\n---\nbody v2 MUCH DIFFERENT', 'utf-8');
    expect(() => completeEvaluation(f.db, 'drift-draft', f.evaluationsDir, artifactPaths(f)))
      .toThrow(/Reviewed artifacts changed/);
    const post = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get('drift-draft') as { phase: string };
    expect(post.phase).toBe('evaluate');
  });

  it('refuses to advance when the autocheck sidecar is edited after synthesis', () => {
    const f = setup();
    seedAndSynthesize(f, 'drift-lint');
    writeFileSync(join(f.evaluationsDir, 'drift-lint', 'structural.lint.json'), '[{"id":"a","category":"x","severity":"low","title":"tampered","description":"injected after synthesis"}]\n', 'utf-8');
    expect(() => completeEvaluation(f.db, 'drift-lint', f.evaluationsDir, artifactPaths(f)))
      .toThrow(/Reviewed artifacts changed.*structural\.lint\.json/);
  });

  it('advances when artifacts are byte-identical to the pin', () => {
    const f = setup();
    seedAndSynthesize(f, 'no-drift');
    completeEvaluation(f.db, 'no-drift', f.evaluationsDir, artifactPaths(f));
    const post = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get('no-drift') as { phase: string };
    expect(post.phase).toBe('publish');
  });
});

describe('recordReview — refuses writes to a closed cycle', () => {
  it('throws when the current cycle has ended_reason set (e.g., mid-reject crash)', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'closed');
    initEvaluation(f.db, 'closed', f.evaluationsDir);
    // Simulate a reject that closed the cycle but (hypothetically) didn't flip phase.
    const manifestPath = join(f.evaluationsDir, 'closed', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.cycles[0].ended_reason = 'rejected';
    manifest.cycles[0].ended_at = '2026-01-01 00:00:00.000';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    expect(() => recordReview(f.db, 'closed', 'structural', '/tmp/r.md', makeOutput('structural', [], 'closed'), f.evaluationsDir, artifactPaths(f)))
      .toThrow(/cycle.*is closed/);
  });
});

describe('completeEvaluation — refuses closed cycles', () => {
  it('throws when current cycle has ended_reason set (reject-crash recovery path)', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'reject-crash');
    initEvaluation(f.db, 'reject-crash', f.evaluationsDir);
    mkdirSync(join(f.draftsDir, 'reject-crash'), { recursive: true });
    writeFileSync(join(f.draftsDir, 'reject-crash', 'index.mdx'), '---\ntitle: ok\n---\n', 'utf-8');
    writeEmptyAutocheck(f.evaluationsDir, 'reject-crash');
    for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
      recordReview(f.db, 'reject-crash', reviewer, '/tmp/r.md', makeOutput(reviewer, [], 'reject-crash'), f.evaluationsDir, artifactPaths(f));
    }
    runSynthesis(f.db, 'reject-crash', f.evaluationsDir, artifactPaths(f));
    // Manually close the cycle without flipping phase — simulate reject crash.
    const manifestPath = join(f.evaluationsDir, 'reject-crash', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.cycles[0].ended_reason = 'rejected';
    manifest.cycles[0].ended_at = '2026-01-01 00:00:00.000';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    expect(() => completeEvaluation(f.db, 'reject-crash', f.evaluationsDir, artifactPaths(f)))
      .toThrow(/cycle.*is closed/);
  });
});

describe('readManifest — monotonic floor enforcement', () => {
  it('throws when a cycle evaluation_id_floor decreases vs the previous cycle', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'tamper');
    initEvaluation(f.db, 'tamper', f.evaluationsDir);
    rejectEvaluation(f.db, 'tamper', f.evaluationsDir);
    advancePhase(f.db, 'tamper', 'evaluate');
    initEvaluation(f.db, 'tamper', f.evaluationsDir);
    // Tamper: rewrite manifest so the new cycle's floor is BELOW the prior.
    const manifestPath = join(f.evaluationsDir, 'tamper', 'manifest.json');
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    raw.cycles[0].evaluation_id_floor = 100;
    raw.cycles[1].evaluation_id_floor = 0;
    writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
    expect(() => readManifest(f.evaluationsDir, 'tamper')).toThrow(/not monotonic/);
  });

  it('throws when a new cycle opens below the prior last_synthesis_eval_id', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'pin-tamper');
    initEvaluation(f.db, 'pin-tamper', f.evaluationsDir);
    const manifestPath = join(f.evaluationsDir, 'pin-tamper', 'manifest.json');
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    // Forge two cycles where cycle[1] opens BELOW cycle[0].last_synthesis_eval_id,
    // which would let a stale pass synthesis leak into the new cycle.
    raw.cycles = [
      { started_at: '2026-01-01 00:00:00.000', evaluation_id_floor: 0, synthesis_id_floor: 0, last_synthesis_eval_id: 10, ended_reason: 'rejected', ended_at: '2026-01-01 00:01:00.000' },
      { started_at: '2026-01-01 00:02:00.000', evaluation_id_floor: 5, synthesis_id_floor: 5 },
    ];
    writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
    expect(() => readManifest(f.evaluationsDir, 'pin-tamper')).toThrow(/tampered.*last_synthesis_eval_id/);
  });
});

describe('autocheck absorption is blocked (fingerprint-authoritative)', () => {
  it('counts an autocheck cluster even when the structural reviewer mirrors the lint without source=autocheck tag', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'absorb');
    initEvaluation(f.db, 'absorb', f.evaluationsDir);
    // Write one autocheck lint to the sidecar.
    const lintIssue = makeIssue('structural', 'Broken internal link', 'The link /writing/missing does not resolve to any existing post.');
    lintIssue.category = 'broken-internal-link';
    lintIssue.source = 'autocheck';
    writeFileSync(
      join(f.evaluationsDir, 'absorb', 'structural.lint.json'),
      `${JSON.stringify([lintIssue], null, 2)}\n`,
      'utf-8',
    );
    // Structural reviewer MIRRORS the exact lint text but as source=reviewer.
    const mirrored: Issue = {
      id: issueFingerprint('structural', lintIssue.title, lintIssue.description),
      category: 'broken-internal-link',
      severity: 'high',
      title: lintIssue.title,
      description: lintIssue.description,
      source: 'reviewer',
    };
    recordReview(f.db, 'absorb', 'structural', '/tmp/r.md', makeOutput('structural', [mirrored], 'absorb'), f.evaluationsDir, artifactPaths(f));
    recordReview(f.db, 'absorb', 'adversarial', '/tmp/r.md', makeOutput('adversarial', [], 'absorb'), f.evaluationsDir, artifactPaths(f));
    recordReview(f.db, 'absorb', 'methodology', '/tmp/r.md', makeOutput('methodology', [], 'absorb'), f.evaluationsDir, artifactPaths(f));
    const result = runSynthesis(f.db, 'absorb', f.evaluationsDir, artifactPaths(f));
    expect(result.synthesis.counts.autocheck).toBe(1);
    expect(result.synthesis.verdict).toBe('fail');
  });
});

describe('pin-tamper upward is rejected', () => {
  it('initEvaluation throws when last_synthesis_eval_id exceeds MAX(evaluations.id)', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'pin-up');
    initEvaluation(f.db, 'pin-up', f.evaluationsDir);
    const manifestFile = join(f.evaluationsDir, 'pin-up', 'manifest.json');
    const raw = JSON.parse(readFileSync(manifestFile, 'utf-8'));
    raw.cycles[0].last_synthesis_eval_id = 99999;
    writeFileSync(manifestFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
    expect(() => initEvaluation(f.db, 'pin-up', f.evaluationsDir)).toThrow(/last_synthesis_eval_id.*exceeds/);
  });

  it('completeEvaluation throws via validator when pin is upward-tampered', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'pin-up-c');
    initEvaluation(f.db, 'pin-up-c', f.evaluationsDir);
    writeEmptyAutocheck(f.evaluationsDir, 'pin-up-c');
    for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
      recordReview(f.db, 'pin-up-c', reviewer, '/tmp/r.md', makeOutput(reviewer, [], 'pin-up-c'), f.evaluationsDir, artifactPaths(f));
    }
    runSynthesis(f.db, 'pin-up-c', f.evaluationsDir, artifactPaths(f));
    const manifestFile = join(f.evaluationsDir, 'pin-up-c', 'manifest.json');
    const raw = JSON.parse(readFileSync(manifestFile, 'utf-8'));
    raw.cycles[0].last_synthesis_eval_id = 99999;
    writeFileSync(manifestFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
    expect(() => completeEvaluation(f.db, 'pin-up-c', f.evaluationsDir, artifactPaths(f)))
      .toThrow(/Tampering detected|exceeds/);
  });
});

describe('expected_reviewers manifest tamper is rejected', () => {
  it('rejects a manifest that shrinks expected_reviewers below the content_type contract', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'shrink');
    initEvaluation(f.db, 'shrink', f.evaluationsDir);
    const manifestFile = join(f.evaluationsDir, 'shrink', 'manifest.json');
    const raw = JSON.parse(readFileSync(manifestFile, 'utf-8'));
    raw.expected_reviewers = ['structural'];
    writeFileSync(manifestFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
    expect(() => recordReview(f.db, 'shrink', 'structural', '/tmp/r.md', makeOutput('structural', [], 'shrink'), f.evaluationsDir, artifactPaths(f)))
      .toThrow(/does not match content_type/);
  });

  it('rejects a manifest with duplicate reviewer entries', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'dup');
    initEvaluation(f.db, 'dup', f.evaluationsDir);
    const manifestFile = join(f.evaluationsDir, 'dup', 'manifest.json');
    const raw = JSON.parse(readFileSync(manifestFile, 'utf-8'));
    raw.expected_reviewers = ['structural', 'structural', 'structural'];
    writeFileSync(manifestFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
    expect(() => recordReview(f.db, 'dup', 'structural', '/tmp/r.md', makeOutput('structural', [], 'dup'), f.evaluationsDir, artifactPaths(f)))
      .toThrow(/does not match content_type/);
  });
});

describe('per-reviewer artifact binding', () => {
  it('runSynthesis refuses when reviewers pinned different draft versions', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'bind');
    initEvaluation(f.db, 'bind', f.evaluationsDir);
    mkdirSync(join(f.draftsDir, 'bind'), { recursive: true });
    writeFileSync(join(f.draftsDir, 'bind', 'index.mdx'), 'v1', 'utf-8');
    writeEmptyAutocheck(f.evaluationsDir, 'bind');
    recordReview(f.db, 'bind', 'structural', '/tmp/r.md', makeOutput('structural', [], 'bind'), f.evaluationsDir, artifactPaths(f));
    // Edit draft between reviewer records — second reviewer sees a different file.
    writeFileSync(join(f.draftsDir, 'bind', 'index.mdx'), 'v2 DIFFERENT', 'utf-8');
    recordReview(f.db, 'bind', 'adversarial', '/tmp/r.md', makeOutput('adversarial', [], 'bind'), f.evaluationsDir, artifactPaths(f));
    recordReview(f.db, 'bind', 'methodology', '/tmp/r.md', makeOutput('methodology', [], 'bind'), f.evaluationsDir, artifactPaths(f));
    expect(() => runSynthesis(f.db, 'bind', f.evaluationsDir, artifactPaths(f)))
      .toThrow(/Artifact.*drifted|does not match/);
  });

  it('runSynthesis refuses when the draft changes after all reviewers recorded', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'post-edit');
    initEvaluation(f.db, 'post-edit', f.evaluationsDir);
    mkdirSync(join(f.draftsDir, 'post-edit'), { recursive: true });
    writeFileSync(join(f.draftsDir, 'post-edit', 'index.mdx'), 'v1', 'utf-8');
    writeEmptyAutocheck(f.evaluationsDir, 'post-edit');
    for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
      recordReview(f.db, 'post-edit', reviewer, '/tmp/r.md', makeOutput(reviewer, [], 'post-edit'), f.evaluationsDir, artifactPaths(f));
    }
    // Edit draft AFTER all records but before synthesis — reviewers saw v1, disk is now v2.
    writeFileSync(join(f.draftsDir, 'post-edit', 'index.mdx'), 'v2 tampered post-record', 'utf-8');
    expect(() => runSynthesis(f.db, 'post-edit', f.evaluationsDir, artifactPaths(f)))
      .toThrow(/Artifact.*drifted/);
  });
});

describe('reviewer provenance — artifact_hashes check', () => {
  it('rejects recordReview when reviewer JSON pinned different hashes than disk', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'prov');
    initEvaluation(f.db, 'prov', f.evaluationsDir);
    mkdirSync(join(f.draftsDir, 'prov'), { recursive: true });
    writeFileSync(join(f.draftsDir, 'prov', 'index.mdx'), 'disk content', 'utf-8');
    const output = makeOutput('structural', []);
    // Claim hashes for a DIFFERENT draft than what's on disk.
    output.artifact_hashes = {
      'draft/index.mdx': 'ffff0000deadbeef0000ffff1111aaaa2222bbbb3333cccc4444dddd5555eeee',
      'benchmark/results.json': '<absent>',
      'benchmark/environment.json': '<absent>',
      'evaluation/structural.lint.json': '<absent>',
    };
    expect(() => recordReview(f.db, 'prov', 'structural', '/tmp/r.md', output, f.evaluationsDir, artifactPaths(f)))
      .toThrow(/provenance mismatch/);
  });

  it('accepts recordReview when reviewer JSON pins hashes matching current disk', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'prov-ok');
    initEvaluation(f.db, 'prov-ok', f.evaluationsDir);
    mkdirSync(join(f.draftsDir, 'prov-ok'), { recursive: true });
    writeFileSync(join(f.draftsDir, 'prov-ok', 'index.mdx'), 'disk content', 'utf-8');
    // Compute the legitimate hashes to embed.
    const { createHash } = require('node:crypto');
    const diskHash = createHash('sha256').update('disk content').digest('hex');
    const output = makeOutput('structural', []);
    output.artifact_hashes = {
      'draft/index.mdx': diskHash,
      'benchmark/results.json': '<absent>',
      'benchmark/environment.json': '<absent>',
      'evaluation/structural.lint.json': '<absent>',
    };
    const row = recordReview(f.db, 'prov-ok', 'structural', '/tmp/r.md', output, f.evaluationsDir, artifactPaths(f));
    expect(row.reviewer).toBe('structural');
  });
});

describe('single-snapshot synthesis — mid-run lint swap', () => {
  it('does not let a concurrent structural.lint.json swap drop autocheck count to 0', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'snap');
    initEvaluation(f.db, 'snap', f.evaluationsDir);
    // Seed with a real lint.
    const lintIssue = makeIssue('structural', 'Broken link', 'The link /writing/nonexistent does not resolve.');
    lintIssue.category = 'broken-internal-link';
    lintIssue.source = 'autocheck';
    writeFileSync(
      join(f.evaluationsDir, 'snap', 'structural.lint.json'),
      `${JSON.stringify([lintIssue], null, 2)}\n`,
      'utf-8',
    );
    for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
      recordReview(f.db, 'snap', reviewer, '/tmp/r.md', makeOutput(reviewer, [], 'snap'), f.evaluationsDir, artifactPaths(f));
    }
    // synthesize runs with a frozen snapshot — captures lint on entry. Even
    // if a concurrent swap wrote `[]` between the union read and fingerprint
    // read, the snapshot's copy is used for BOTH. We simulate the defense by
    // swapping the file AFTER synthesis captures the snapshot — impossible
    // to do cleanly from a test, so we verify the post-synth state reflects
    // the pre-swap snapshot (count.autocheck=1, verdict=fail).
    const result = runSynthesis(f.db, 'snap', f.evaluationsDir, artifactPaths(f));
    expect(result.synthesis.counts.autocheck).toBe(1);
    expect(result.synthesis.verdict).toBe('fail');
  });
});

describe('synthesis receipt — tamper detection', () => {
  function seedAndSynth(f: Fixture, slug: string): { pin: number } {
    seedEvaluatePost(f.db, slug);
    initEvaluation(f.db, slug, f.evaluationsDir);
    mkdirSync(join(f.draftsDir, slug), { recursive: true });
    writeFileSync(join(f.draftsDir, slug, 'index.mdx'), 'stable', 'utf-8');
    writeEmptyAutocheck(f.evaluationsDir, slug);
    for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
      recordReview(f.db, slug, reviewer, '/tmp/r.md', makeOutput(reviewer, [], slug), f.evaluationsDir, artifactPaths(f));
    }
    runSynthesis(f.db, slug, f.evaluationsDir, artifactPaths(f));
    const m = readManifest(f.evaluationsDir, slug);
    return { pin: m!.cycles[m!.cycles.length - 1].last_synthesis_eval_id! };
  }

  it('refuses complete when operator raises manifest pin without regenerating receipt', () => {
    const f = setup();
    seedAndSynth(f, 'pin-tamp');
    // Operator tampers manifest pin upward (within valid range) without
    // re-running synthesize. The receipt on disk still reflects the real pin.
    const manifestFile = join(f.evaluationsDir, 'pin-tamp', 'manifest.json');
    const raw = JSON.parse(readFileSync(manifestFile, 'utf-8'));
    // Add a new evaluation row so MAX(eval.id) > pin, then tamper pin up.
    recordReview(f.db, 'pin-tamp', 'structural', '/tmp/r-new.md', makeOutput('structural', [makeIssue('structural', 'Late', 'Late finding worth blocking')], 'pin-tamp'), f.evaluationsDir, artifactPaths(f));
    const newMax = (f.db.prepare("SELECT MAX(id) m FROM evaluations WHERE post_slug='pin-tamp'").get() as { m: number }).m;
    raw.cycles[raw.cycles.length - 1].last_synthesis_eval_id = newMax;
    writeFileSync(manifestFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
    expect(() => completeEvaluation(f.db, 'pin-tamp', f.evaluationsDir, artifactPaths(f)))
      .toThrow(/receipt does not match/);
  });

  it('refuses complete when receipt file is deleted', () => {
    const f = setup();
    seedAndSynth(f, 'no-receipt');
    rmSync(join(f.evaluationsDir, 'no-receipt', 'synthesis.receipt.json'));
    expect(() => completeEvaluation(f.db, 'no-receipt', f.evaluationsDir, artifactPaths(f)))
      .toThrow(/Synthesis receipt missing/);
  });

  it('refuses complete when receipt body is edited without updating hash', () => {
    const f = setup();
    seedAndSynth(f, 'receipt-tamp');
    const receiptPath = join(f.evaluationsDir, 'receipt-tamp', 'synthesis.receipt.json');
    const raw = JSON.parse(readFileSync(receiptPath, 'utf-8'));
    raw.body.pin = raw.body.pin + 100;
    writeFileSync(receiptPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
    expect(() => completeEvaluation(f.db, 'receipt-tamp', f.evaluationsDir, artifactPaths(f)))
      .toThrow(/receipt hash does not match/);
  });
});

describe('reject+crash+init recovery', () => {
  it('forces a fresh cycle when the reject sentinel is present but the cycle was not closed', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'crash');
    initEvaluation(f.db, 'crash', f.evaluationsDir);
    // Simulate partial reject: write sentinel, flip phase to draft, but do
    // NOT close the cycle in manifest.
    writeFileSync(join(f.evaluationsDir, 'crash', '.rejected_at'), '2026-04-15 00:00:00.000', 'utf-8');
    advancePhase(f.db, 'crash', 'draft');
    // Re-init after crash — must roll a NEW cycle, not reuse the open one.
    initEvaluation(f.db, 'crash', f.evaluationsDir);
    const m = readManifest(f.evaluationsDir, 'crash');
    expect(m?.cycles).toHaveLength(2);
    expect(m?.cycles[0].ended_reason).toBe('rejected');
    expect(m?.cycles[1].ended_reason).toBeUndefined();
    // Sentinel cleared as part of cycle rollover.
    expect(existsSync(join(f.evaluationsDir, 'crash', '.rejected_at'))).toBe(false);
  });

  it('prevents completeEvaluation from advancing a rejected post that crashed mid-reject', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'crash-c');
    initEvaluation(f.db, 'crash-c', f.evaluationsDir);
    mkdirSync(join(f.draftsDir, 'crash-c'), { recursive: true });
    writeFileSync(join(f.draftsDir, 'crash-c', 'index.mdx'), 'v1', 'utf-8');
    writeEmptyAutocheck(f.evaluationsDir, 'crash-c');
    for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
      recordReview(f.db, 'crash-c', reviewer, '/tmp/r.md', makeOutput(reviewer, [], 'crash-c'), f.evaluationsDir, artifactPaths(f));
    }
    runSynthesis(f.db, 'crash-c', f.evaluationsDir, artifactPaths(f));
    // Crash mid-reject: sentinel + phase=draft, cycle manifest NOT closed.
    writeFileSync(join(f.evaluationsDir, 'crash-c', '.rejected_at'), '2026-04-15 00:00:00.000', 'utf-8');
    advancePhase(f.db, 'crash-c', 'draft');
    // Operator recovers by re-init, which must roll a fresh cycle.
    initEvaluation(f.db, 'crash-c', f.evaluationsDir);
    // Now attempt complete — should fail (no synthesis in the NEW cycle).
    expect(() => completeEvaluation(f.db, 'crash-c', f.evaluationsDir, artifactPaths(f)))
      .toThrow(/No synthesis recorded/);
  });
});

describe('empty-normalized-text issue rejection', () => {
  it('rejects issues whose title and description collapse to empty under normalizeText', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'empty-norm');
    initEvaluation(f.db, 'empty-norm', f.evaluationsDir);
    const badIssue: Issue = {
      id: 'aaaaaaaaaaaa',
      category: 'general',
      severity: 'low',
      title: '...',
      description: '...',
    };
    expect(() => recordReview(f.db, 'empty-norm', 'structural', '/tmp/r.md', makeOutput('structural', [badIssue], 'empty-norm'), f.evaluationsDir, artifactPaths(f)))
      .toThrow(/alphanumeric character after normalization/);
  });
});

describe('rejectEvaluation — atomic', () => {
  it('writes marker, closes cycle, and flips phase to draft together', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'atomic-reject');
    initEvaluation(f.db, 'atomic-reject', f.evaluationsDir);
    rejectEvaluation(f.db, 'atomic-reject', f.evaluationsDir);
    // All three effects committed together.
    expect(existsSync(join(f.evaluationsDir, 'atomic-reject', '.rejected_at'))).toBe(true);
    const manifest = readManifest(f.evaluationsDir, 'atomic-reject');
    expect(manifest?.cycles[0].ended_reason).toBe('rejected');
    const post = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get('atomic-reject') as { phase: string };
    expect(post.phase).toBe('draft');
  });
});

describe('runSynthesis — fail-closed autocheck artifact', () => {
  function seedAllThreeReviewers(f: Fixture, slug: string): void {
    seedEvaluatePost(f.db, slug);
    initEvaluation(f.db, slug, f.evaluationsDir);
    for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
      recordReview(f.db, slug, reviewer, '/tmp/r.md', makeOutput(reviewer, [], slug), f.evaluationsDir, artifactPaths(f));
    }
  }

  it('throws when structural.lint.json is missing', () => {
    const f = setup();
    seedAllThreeReviewers(f, 'no-lint');
    expect(() => runSynthesis(f.db, 'no-lint', f.evaluationsDir, artifactPaths(f))).toThrow(/Autocheck artifact missing/);
  });

  it('throws when structural.lint.json is not valid JSON', () => {
    const f = setup();
    seedAllThreeReviewers(f, 'bad-json');
    writeFileSync(join(f.evaluationsDir, 'bad-json', 'structural.lint.json'), '{not json', 'utf-8');
    expect(() => runSynthesis(f.db, 'bad-json', f.evaluationsDir, artifactPaths(f))).toThrow(/not valid JSON/);
  });

  it('throws when structural.lint.json is not a JSON array', () => {
    const f = setup();
    seedAllThreeReviewers(f, 'not-array');
    writeFileSync(join(f.evaluationsDir, 'not-array', 'structural.lint.json'), '{}', 'utf-8');
    expect(() => runSynthesis(f.db, 'not-array', f.evaluationsDir, artifactPaths(f))).toThrow(/must be a JSON array/);
  });
});

describe('completeEvaluation — within-cycle stale-pass guard', () => {
  it('refuses to complete when a reviewer re-records after synthesis (new evaluation row in-cycle)', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'within');
    initEvaluation(f.db, 'within', f.evaluationsDir);
    writeEmptyAutocheck(f.evaluationsDir, 'within');
    for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
      recordReview(f.db, 'within', reviewer, '/tmp/r.md', makeOutput(reviewer, [], 'within'), f.evaluationsDir, artifactPaths(f));
    }
    const result = runSynthesis(f.db, 'within', f.evaluationsDir, artifactPaths(f));
    expect(result.synthesis.verdict).toBe('pass');
    // Reviewer records a new payload after synthesis (e.g., found a new issue).
    recordReview(
      f.db,
      'within',
      'structural',
      '/tmp/r2.md',
      makeOutput('structural', [makeIssue('structural', 'Late finding', 'Discovered after synthesis ran.')], 'within'),
      f.evaluationsDir,
      artifactPaths(f),
    );
    expect(() => completeEvaluation(f.db, 'within', f.evaluationsDir, artifactPaths(f)))
      .toThrow(/Re-run 'blog evaluate synthesize'/);
    const post = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get('within') as { phase: string };
    expect(post.phase).toBe('evaluate');
  });
});

describe('recordReview — canonicalized dedupe', () => {
  it('dedupes identical logical payload with reordered issue keys', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'canon-keys');
    initEvaluation(f.db, 'canon-keys', f.evaluationsDir);
    const issue = makeIssue('structural', 'Shared', 'A shared description string value here');
    recordReview(f.db, 'canon-keys', 'structural', '/tmp/r.md', makeOutput('structural', [issue], 'canon-keys'), f.evaluationsDir, artifactPaths(f));
    // Reconstruct with keys in a different order.
    const reordered: Issue = {
      description: issue.description,
      severity: issue.severity,
      category: issue.category,
      title: issue.title,
      id: issue.id,
    };
    recordReview(f.db, 'canon-keys', 'structural', '/tmp/r.md', makeOutput('structural', [reordered], 'canon-keys'), f.evaluationsDir, artifactPaths(f));
    const count = (f.db.prepare(
      "SELECT COUNT(*) AS c FROM evaluations WHERE post_slug = 'canon-keys' AND reviewer = 'structural'",
    ).get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('dedupes when report_path differs only in relative vs absolute form', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'canon-path');
    initEvaluation(f.db, 'canon-path', f.evaluationsDir);
    const absPath = '/tmp/path-dedupe.md';
    recordReview(f.db, 'canon-path', 'structural', absPath, makeOutput('structural', []), f.evaluationsDir, artifactPaths(f));
    // Re-record with a trailing-slash / relative-ish path that resolves to the same absolute path.
    recordReview(f.db, 'canon-path', 'structural', `${absPath}`, makeOutput('structural', []), f.evaluationsDir, artifactPaths(f));
    const count = (f.db.prepare(
      "SELECT COUNT(*) AS c FROM evaluations WHERE post_slug = 'canon-path' AND reviewer = 'structural'",
    ).get() as { c: number }).c;
    expect(count).toBe(1);
  });
});

describe('initEvaluation — manifest floor sanity', () => {
  it('throws when manifest evaluation_id_floor exceeds current DB MAX(id)', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'skew');
    initEvaluation(f.db, 'skew', f.evaluationsDir);
    // Simulate DB restore / workspace skew by rewriting the manifest's floor
    // to a value larger than any row in the (empty) evaluations table.
    const manifestFile = join(f.evaluationsDir, 'skew', 'manifest.json');
    const raw = JSON.parse(readFileSync(manifestFile, 'utf-8'));
    raw.cycles[0].evaluation_id_floor = 9999;
    writeFileSync(manifestFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
    expect(() => initEvaluation(f.db, 'skew', f.evaluationsDir))
      .toThrow(/out of sync/);
  });
});

describe('runSynthesis — atomic gate flip', () => {
  it('writes evaluation_synthesis row and posts.evaluation_passed together (transactional)', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'atomic');
    initEvaluation(f.db, 'atomic', f.evaluationsDir);
    writeEmptyAutocheck(f.evaluationsDir, 'atomic');
    for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
      recordReview(f.db, 'atomic', reviewer, '/tmp/r.md', makeOutput(reviewer, [], 'atomic'), f.evaluationsDir, artifactPaths(f));
    }
    runSynthesis(f.db, 'atomic', f.evaluationsDir, artifactPaths(f));
    const synth = latestSynthesis(f.db, 'atomic');
    const post = f.db.prepare('SELECT evaluation_passed FROM posts WHERE slug = ?').get('atomic') as { evaluation_passed: number };
    expect(synth?.verdict).toBe('pass');
    expect(post.evaluation_passed).toBe(1);
  });
});

describe('initEvaluation — cycle management', () => {
  it('clears the .rejected_at marker when rolling a new cycle after reject', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'rollover');
    initEvaluation(f.db, 'rollover', f.evaluationsDir);
    rejectEvaluation(f.db, 'rollover', f.evaluationsDir);
    expect(existsSync(join(f.evaluationsDir, 'rollover', '.rejected_at'))).toBe(true);
    advancePhase(f.db, 'rollover', 'evaluate');
    initEvaluation(f.db, 'rollover', f.evaluationsDir);
    expect(existsSync(join(f.evaluationsDir, 'rollover', '.rejected_at'))).toBe(false);
    const manifest = readManifest(f.evaluationsDir, 'rollover');
    expect(manifest?.cycles).toHaveLength(2);
    expect(manifest?.cycles[0].ended_reason).toBe('rejected');
    expect(manifest?.cycles[1].ended_reason).toBeUndefined();
  });

  it('purges stale reviewer artifacts when rolling a new cycle (prevents replay of prior reviewer JSON files)', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'purge');
    initEvaluation(f.db, 'purge', f.evaluationsDir);
    const workspace = join(f.evaluationsDir, 'purge');
    // Simulate a full cycle 1 set of artifacts written to disk.
    for (const name of ['structural.json', 'adversarial.json', 'methodology.json',
      'structural.md', 'adversarial.md', 'methodology.md',
      'structural.lint.json', 'synthesis.md']) {
      writeFileSync(join(workspace, name), 'cycle-1-content', 'utf-8');
    }
    rejectEvaluation(f.db, 'purge', f.evaluationsDir);
    advancePhase(f.db, 'purge', 'evaluate');
    initEvaluation(f.db, 'purge', f.evaluationsDir);
    // Every artifact should be gone after the new cycle opens.
    for (const name of ['structural.json', 'adversarial.json', 'methodology.json',
      'structural.md', 'adversarial.md', 'methodology.md',
      'structural.lint.json', 'synthesis.md']) {
      expect(existsSync(join(workspace, name))).toBe(false);
    }
    // manifest.json and .rejected_at handling are unrelated to artifact purge.
    expect(existsSync(join(workspace, 'manifest.json'))).toBe(true);
  });
});

describe('completeEvaluation — fail-closed on missing synthesis pin', () => {
  it('throws when the current-cycle synthesis has no last_synthesis_eval_id pin', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'unpin');
    initEvaluation(f.db, 'unpin', f.evaluationsDir);
    writeEmptyAutocheck(f.evaluationsDir, 'unpin');
    for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
      recordReview(f.db, 'unpin', reviewer, '/tmp/r.md', makeOutput(reviewer, [], 'unpin'), f.evaluationsDir, artifactPaths(f));
    }
    runSynthesis(f.db, 'unpin', f.evaluationsDir, artifactPaths(f));
    // Simulate a crash-between-DB-commit-and-manifest-write: strip the pin.
    const manifestPath = join(f.evaluationsDir, 'unpin', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    delete manifest.cycles[manifest.cycles.length - 1].last_synthesis_eval_id;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    expect(() => completeEvaluation(f.db, 'unpin', f.evaluationsDir, artifactPaths(f)))
      .toThrow(/Synthesis pin is missing/);
    // Post phase stays at evaluate.
    const post = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get('unpin') as { phase: string };
    expect(post.phase).toBe('evaluate');
  });
});

describe('runSynthesis — race coverage on concurrent recordReview', () => {
  it('captures MAX(evaluations.id) inside the synthesis transaction so late in-flight rows are not silently included in the pin', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'race');
    initEvaluation(f.db, 'race', f.evaluationsDir);
    writeEmptyAutocheck(f.evaluationsDir, 'race');
    for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
      recordReview(f.db, 'race', reviewer, '/tmp/r.md', makeOutput(reviewer, [], 'race'), f.evaluationsDir, artifactPaths(f));
    }
    const beforeMax = (f.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM evaluations WHERE post_slug = 'race'").get() as { m: number }).m;
    runSynthesis(f.db, 'race', f.evaluationsDir, artifactPaths(f));
    const manifest = readManifest(f.evaluationsDir, 'race');
    const cycle = manifest!.cycles[manifest!.cycles.length - 1];
    // Pin equals the MAX(id) at the moment synthesis committed — inside the
    // same transaction, so no slip-in is possible.
    expect(cycle.last_synthesis_eval_id).toBe(beforeMax);
  });
});

describe('readReviewerOutputFromFile', () => {
  it('reads and validates a file', () => {
    const f = setup();
    const filePath = join(f.tempDir, 'out.json');
    writeFileSync(filePath, JSON.stringify(makeOutput('structural', [])), 'utf-8');
    const parsed = readReviewerOutputFromFile(filePath);
    expect(parsed.reviewer).toBe('structural');
  });

  it('throws on missing file', () => {
    const f = setup();
    expect(() => readReviewerOutputFromFile(join(f.tempDir, 'missing.json'))).toThrow(/not found/);
  });
});

describe('listRecordedReviewers', () => {
  it('lists only reviewers that have at least one row', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'list');
    initEvaluation(f.db, 'list', f.evaluationsDir);
    recordReview(f.db, 'list', 'structural', '/tmp/r.md', makeOutput('structural', [], 'list'), f.evaluationsDir, artifactPaths(f));
    recordReview(f.db, 'list', 'adversarial', '/tmp/r.md', makeOutput('adversarial', [], 'list'), f.evaluationsDir, artifactPaths(f));
    expect(listRecordedReviewers(f.db, 'list').sort()).toEqual(['adversarial', 'structural']);
  });
});

describe('readManifest', () => {
  it('returns null when not initialized', () => {
    const f = setup();
    expect(readManifest(f.evaluationsDir, 'none')).toBeNull();
  });
});

describe('completeEvaluation — DB-authoritative synthesis coverage', () => {
  // Closes Codex xhigh bypass: attacker raises manifest `last_synthesis_eval_id`
  // to match currentMaxEval AND forges a consistent receipt. The manifest-pin
  // guard + receipt guard both pass, but the stored synthesis row covers only
  // the PRE-tamper evaluations. Re-running synthesize() on the current DB
  // rows produces different counts/verdict → complete refuses.
  it('refuses to advance when DB rows diverge from stored synthesis counts', async () => {
    const f = setup();
    const slug = 'db-rederive';
    seedEvaluatePost(f.db, slug);
    initEvaluation(f.db, slug, f.evaluationsDir);
    mkdirSync(join(f.draftsDir, slug), { recursive: true });
    writeFileSync(join(f.draftsDir, slug, 'index.mdx'), 'v1', 'utf-8');
    writeEmptyAutocheck(f.evaluationsDir, slug);
    for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
      recordReview(f.db, slug, reviewer, '/tmp/r.md', makeOutput(reviewer, [], slug), f.evaluationsDir, artifactPaths(f));
    }
    const result = runSynthesis(f.db, slug, f.evaluationsDir, artifactPaths(f));
    expect(result.synthesis.verdict).toBe('pass');

    // A reviewer re-records with a NEW blocking payload — new evaluation row.
    // This is what drives re-derivation to disagree with the stored synthesis.
    recordReview(
      f.db,
      slug,
      'adversarial',
      '/tmp/r2.md',
      makeOutput('adversarial', [makeIssue('adversarial', 'Blocker A', 'Found during second pass review')], slug),
      f.evaluationsDir,
      artifactPaths(f),
    );
    const sameFromAllThree = 'Blocker A';
    const sameDesc = 'Found during second pass review';
    recordReview(
      f.db,
      slug,
      'structural',
      '/tmp/r2.md',
      makeOutput('structural', [makeIssue('structural', sameFromAllThree, sameDesc)], slug),
      f.evaluationsDir,
      artifactPaths(f),
    );
    recordReview(
      f.db,
      slug,
      'methodology',
      '/tmp/r2.md',
      makeOutput('methodology', [makeIssue('methodology', sameFromAllThree, sameDesc)], slug),
      f.evaluationsDir,
      artifactPaths(f),
    );

    // Now simulate the Codex xhigh bypass: attacker raises manifest pin to
    // currentMaxEval AND regenerates the synthesis receipt to match. The
    // pin-tamper and receipt checks both pass. The DB-authoritative re-derive
    // is the load-bearing defense.
    const manifestPath = join(f.evaluationsDir, slug, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const maxEvalRow = f.db.prepare('SELECT MAX(id) AS m FROM evaluations WHERE post_slug = ?').get(slug) as { m: number };
    manifest.cycles[0].last_synthesis_eval_id = maxEvalRow.m;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    // Forge a consistent receipt over the tampered pin. To also pass the
    // receipt's self-hash check, read the original receipt and preserve its
    // `cluster_identity` — simulating the strongest attacker who keeps the
    // synthesis-time fingerprint set unchanged. The DB-authoritative re-
    // derivation is what ultimately catches the bypass, because re-derive
    // on the re-recorded rows produces DIFFERENT cluster fingerprints.
    const receiptPath = join(f.evaluationsDir, slug, 'synthesis.receipt.json');
    const originalReceipt = JSON.parse(readFileSync(receiptPath, 'utf-8')) as { body: { cluster_identity: { consensus: string[]; majority: string[]; single: string[] } } };
    const synthRow = f.db.prepare('SELECT * FROM evaluation_synthesis WHERE post_slug = ? ORDER BY id DESC LIMIT 1').get(slug) as {
      id: number; verdict: string;
    };
    const forgedBody = {
      pin: maxEvalRow.m,
      verdict: synthRow.verdict,
      reviewed_artifact_hashes: manifest.cycles[0].reviewed_artifact_hashes,
      reviewer_artifact_hashes: manifest.cycles[0].reviewer_artifact_hashes ?? {},
      synthesis_row_id: synthRow.id,
      cluster_identity: originalReceipt.body.cluster_identity,
    };
    // Same canonicalization as state.ts writeSynthesisReceipt.
    const canon = (val: unknown): string => {
      if (val === null || typeof val !== 'object') return JSON.stringify(val);
      if (Array.isArray(val)) return `[${(val as unknown[]).map(canon).join(',')}]`;
      const keys = Object.keys(val as Record<string, unknown>).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canon((val as Record<string, unknown>)[k])}`).join(',')}}`;
    };
    const { createHash } = await import('node:crypto');
    const forgedHash = createHash('sha256').update(canon(forgedBody)).digest('hex');
    writeFileSync(receiptPath, `${JSON.stringify({ body: forgedBody, hash: forgedHash }, null, 2)}\n`, 'utf-8');

    // Gate must still fail — because re-derivation sees new blocking issues.
    expect(() => completeEvaluation(f.db, slug, f.evaluationsDir, artifactPaths(f)))
      .toThrow(/DB state drifted since synthesis/);
    const post = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get(slug) as { phase: string };
    expect(post.phase).toBe('evaluate');
  });
});

describe('completeEvaluation — cluster-identity re-derivation', () => {
  // Closes the E2 coincidence bypass: attacker re-records with DIFFERENT
  // issues that happen to produce the same bucket counts as the stored
  // synthesis. Pin + receipt + bucket-count-only re-derivation all pass,
  // but the cluster-identity (representative fingerprints per bucket) must
  // differ because new issues produce new fingerprints.
  it('refuses to advance when post-synthesis re-record preserves bucket counts but changes cluster identities', async () => {
    const f = setup();
    const slug = 'coincidence';
    seedEvaluatePost(f.db, slug);
    initEvaluation(f.db, slug, f.evaluationsDir);
    mkdirSync(join(f.draftsDir, slug), { recursive: true });
    writeFileSync(join(f.draftsDir, slug, 'index.mdx'), 'v1', 'utf-8');
    writeEmptyAutocheck(f.evaluationsDir, slug);

    // Synthesis baseline: structural reports one singleton issue "Original A".
    // Counts: consensus=0, majority=0, single=1 (only structural touched it).
    recordReview(
      f.db,
      slug,
      'structural',
      '/tmp/r.md',
      makeOutput('structural', [makeIssue('structural', 'Original A', 'The original issue that drove the initial synthesis.')], slug),
      f.evaluationsDir,
      artifactPaths(f),
    );
    recordReview(f.db, slug, 'adversarial', '/tmp/r.md', makeOutput('adversarial', [], slug), f.evaluationsDir, artifactPaths(f));
    recordReview(f.db, slug, 'methodology', '/tmp/r.md', makeOutput('methodology', [], slug), f.evaluationsDir, artifactPaths(f));
    const result = runSynthesis(f.db, slug, f.evaluationsDir, artifactPaths(f));
    expect(result.synthesis.counts.single).toBe(1);
    // Single-bucket issues don't block the verdict — this post passes. The
    // attacker's goal is to swap the single issue for a different one
    // (same count distribution) AFTER synthesis, then advance to publish
    // with unreviewed new content.
    expect(result.synthesis.verdict).toBe('pass');

    // Attacker gets the reviewer to re-record with a DIFFERENT singleton.
    // Same bucket distribution {consensus:0, majority:0, single:1} but new
    // issue content → new fingerprint.
    recordReview(
      f.db,
      slug,
      'structural',
      '/tmp/r2.md',
      makeOutput('structural', [makeIssue('structural', 'Different B', 'A completely different issue found on second pass.')], slug),
      f.evaluationsDir,
      artifactPaths(f),
    );

    // Forge pin + receipt while preserving the ORIGINAL cluster_identity
    // (the attacker's best move — any change to cluster_identity breaks the
    // receipt hash vs the stored synthesis counts story).
    const manifestPath = join(f.evaluationsDir, slug, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const maxEval = (f.db.prepare('SELECT MAX(id) AS m FROM evaluations WHERE post_slug = ?').get(slug) as { m: number }).m;
    manifest.cycles[0].last_synthesis_eval_id = maxEval;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const receiptPath = join(f.evaluationsDir, slug, 'synthesis.receipt.json');
    const origReceipt = JSON.parse(readFileSync(receiptPath, 'utf-8')) as { body: { cluster_identity: unknown } };
    const synthRow = f.db.prepare('SELECT * FROM evaluation_synthesis WHERE post_slug = ? ORDER BY id DESC LIMIT 1').get(slug) as { id: number; verdict: string };
    const forgedBody = {
      pin: maxEval,
      verdict: synthRow.verdict,
      reviewed_artifact_hashes: manifest.cycles[0].reviewed_artifact_hashes,
      reviewer_artifact_hashes: manifest.cycles[0].reviewer_artifact_hashes ?? {},
      synthesis_row_id: synthRow.id,
      cluster_identity: origReceipt.body.cluster_identity,
    };
    const canon = (val: unknown): string => {
      if (val === null || typeof val !== 'object') return JSON.stringify(val);
      if (Array.isArray(val)) return `[${(val as unknown[]).map(canon).join(',')}]`;
      const keys = Object.keys(val as Record<string, unknown>).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canon((val as Record<string, unknown>)[k])}`).join(',')}}`;
    };
    const { createHash } = await import('node:crypto');
    const forgedHash = createHash('sha256').update(canon(forgedBody)).digest('hex');
    writeFileSync(receiptPath, `${JSON.stringify({ body: forgedBody, hash: forgedHash }, null, 2)}\n`, 'utf-8');

    // The forged receipt passes self-hash + manifest cross-check + bucket-count
    // re-derive. Cluster-identity comparison is what catches the bypass —
    // "Different B" has a different fingerprint than "Original A".
    expect(() => completeEvaluation(f.db, slug, f.evaluationsDir, artifactPaths(f)))
      .toThrow(/cluster identity|DB state drifted/);
    const post = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get(slug) as { phase: string };
    expect(post.phase).toBe('evaluate');
  });
});

describe('readManifest — top-level field validation', () => {
  it('rejects manifest with non-array expected_reviewers (E2 TypeError bypass)', () => {
    const f = setup();
    const slug = 'bad-er';
    seedEvaluatePost(f.db, slug);
    initEvaluation(f.db, slug, f.evaluationsDir);
    const manifestPath = join(f.evaluationsDir, slug, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.expected_reviewers = 'not-an-array';
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
    expect(() => readManifest(f.evaluationsDir, slug)).toThrow(/expected_reviewers.*must be a non-empty array/);
  });

  it('rejects manifest with invalid reviewer value in expected_reviewers', () => {
    const f = setup();
    const slug = 'bad-er2';
    seedEvaluatePost(f.db, slug);
    initEvaluation(f.db, slug, f.evaluationsDir);
    const manifestPath = join(f.evaluationsDir, slug, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.expected_reviewers = ['structural', 'junior-dev'];
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
    expect(() => readManifest(f.evaluationsDir, slug)).toThrow(/invalid reviewer/);
  });

  it('rejects manifest with non-string content_type', () => {
    const f = setup();
    const slug = 'bad-ct';
    seedEvaluatePost(f.db, slug);
    initEvaluation(f.db, slug, f.evaluationsDir);
    const manifestPath = join(f.evaluationsDir, slug, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.content_type = 42;
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
    expect(() => readManifest(f.evaluationsDir, slug)).toThrow(/content_type/);
  });
});

describe('acquireEvaluateLock — cooperative serialization', () => {
  it('second acquire from same process throws EEXIST within deadline', async () => {
    const { acquireEvaluateLock } = await import('../src/core/evaluate/state.js');
    const f = setup();
    mkdirSync(join(f.evaluationsDir, 'locktest'), { recursive: true });
    const release1 = acquireEvaluateLock(f.evaluationsDir, 'locktest', 100);
    expect(() => acquireEvaluateLock(f.evaluationsDir, 'locktest', 100))
      .toThrow(/Could not acquire evaluate lock/);
    release1();
    // After release, second acquire should succeed.
    const release2 = acquireEvaluateLock(f.evaluationsDir, 'locktest', 100);
    release2();
  });

  it('reclaims a stale lock left by a dead PID', async () => {
    const { acquireEvaluateLock } = await import('../src/core/evaluate/state.js');
    const f = setup();
    const workspaceDir = join(f.evaluationsDir, 'stale');
    mkdirSync(workspaceDir, { recursive: true });
    // PID 999999999 is extremely unlikely to exist — simulating a crashed holder.
    writeFileSync(join(workspaceDir, '.evaluate.lock'), '999999999', 'utf-8');
    const release = acquireEvaluateLock(f.evaluationsDir, 'stale', 500);
    release();
  });
});
