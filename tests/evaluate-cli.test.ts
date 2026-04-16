import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
import {
  runEvaluateInit,
  runEvaluateAutocheck,
  runEvaluateRecord,
  runEvaluateShow,
  runEvaluateSynthesize,
  runEvaluateComplete,
  runEvaluateReject,
  EvaluatePaths,
} from '../src/cli/evaluate.js';
import { ContentType, ReviewerType } from '../src/core/db/types.js';
import { Issue, ReviewerOutput, issueFingerprint } from '../src/core/evaluate/reviewer.js';
import { computeReviewedArtifactHashes } from '../src/core/evaluate/state.js';

interface Fixture {
  tempDir: string;
  dbPath: string;
  evaluationsDir: string;
  draftsDir: string;
  benchmarkDir: string;
}

let fixture: Fixture | undefined;

afterEach(() => {
  if (fixture) rmSync(fixture.tempDir, { recursive: true, force: true });
  fixture = undefined;
  const saved = process.exitCode;
  process.exitCode = saved === undefined ? undefined : 0;
  vi.restoreAllMocks();
});

function setupFixture(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'eval-cli-'));
  const dbPath = join(tempDir, 'state.db');
  const evaluationsDir = join(tempDir, 'evaluations');
  const draftsDir = join(tempDir, 'drafts');
  const benchmarkDir = join(tempDir, 'benchmarks');
  mkdirSync(evaluationsDir, { recursive: true });
  mkdirSync(draftsDir, { recursive: true });
  mkdirSync(benchmarkDir, { recursive: true });

  // Initialize DB with schema.
  const db = getDatabase(dbPath);
  closeDatabase(db);

  fixture = { tempDir, dbPath, evaluationsDir, draftsDir, benchmarkDir };
  return fixture;
}

function paths(f: Fixture): EvaluatePaths {
  return {
    dbPath: f.dbPath,
    evaluationsDir: f.evaluationsDir,
    draftsDir: f.draftsDir,
    benchmarkDir: f.benchmarkDir,
  };
}

function seedEvaluateSlug(f: Fixture, slug: string, contentType: ContentType = 'technical-deep-dive'): void {
  const db = getDatabase(f.dbPath);
  try {
    initResearchPost(db, slug, 'topic', 'directed', contentType);
    advancePhase(db, slug, 'benchmark');
    advancePhase(db, slug, 'draft');
    advancePhase(db, slug, 'evaluate');
  } finally {
    closeDatabase(db);
  }
}

function seedDraftSlug(f: Fixture, slug: string, contentType: ContentType = 'technical-deep-dive'): void {
  const db = getDatabase(f.dbPath);
  try {
    initResearchPost(db, slug, 'topic', 'directed', contentType);
    advancePhase(db, slug, 'benchmark');
    advancePhase(db, slug, 'draft');
  } finally {
    closeDatabase(db);
  }
}

function writeDraftFile(f: Fixture, slug: string, body = 'Body text.'): void {
  const dir = join(f.draftsDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'index.mdx'),
    `---\ntitle: "Real"\ndescription: "Real"\ndate: "2026-04-14"\ntags: ["t"]\npublished: false\n---\n\n${body}`,
    'utf-8',
  );
}

function captureLogs(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((msg: unknown) => { logs.push(String(msg)); });
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => { errors.push(String(msg)); });
  return { logs, errors };
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

function makeOutput(reviewer: ReviewerType, issues: Issue[] = [], hashes?: Record<string, string>): ReviewerOutput {
  const artifact_hashes = hashes ?? {
    'draft/index.mdx': '<absent>',
    'benchmark/results.json': '<absent>',
    'benchmark/environment.json': '<absent>',
    'evaluation/structural.lint.json': '<absent>',
  };
  return { reviewer, model: `${reviewer}-model`, passed: issues.length === 0, issues, artifact_hashes };
}

function writeReviewerJson(dir: string, reviewer: ReviewerType, output: ReviewerOutput): string {
  const filePath = join(dir, `${reviewer}.json`);
  writeFileSync(filePath, JSON.stringify(output), 'utf-8');
  return filePath;
}

function recordThreeReviewers(f: Fixture, slug: string, fail: boolean): void {
  const workspace = join(f.evaluationsDir, slug);
  // Autocheck is fail-closed at synthesis time; the canonical skill workflow
  // runs structural-autocheck before record. Emit an empty sidecar here.
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'structural.lint.json'), '[]\n', 'utf-8');
  // A draft file must exist at synthesis time for artifact-hash pinning.
  // completeEvaluation re-hashes and refuses drift; tests that go through
  // synthesize→complete need a stable draft on disk.
  const draftDir = join(f.draftsDir, slug);
  mkdirSync(draftDir, { recursive: true });
  if (!existsSync(join(draftDir, 'index.mdx'))) {
    writeFileSync(join(draftDir, 'index.mdx'), '---\ntitle: test\n---\nbody', 'utf-8');
  }
  const title = 'Shared issue';
  const desc = 'Shared description long enough to be meaningful across reviewers';
  // Hashes derived from current disk: lint is the 3-byte "[]\n" sidecar, draft
  // is the 6-byte body written above, benchmarks legitimately absent.
  const diskHashes = computeReviewedArtifactHashes(
    { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir },
    f.evaluationsDir,
    slug,
  );
  for (const reviewer of ['structural', 'adversarial', 'methodology'] as ReviewerType[]) {
    const output = makeOutput(reviewer, fail ? [makeIssue(reviewer, title, desc)] : [], diskHashes);
    const issuesPath = writeReviewerJson(workspace, reviewer, output);
    runEvaluateRecord(slug, { reviewer, report: '/tmp/r.md', issues: issuesPath }, paths(f));
  }
}

describe('runEvaluateInit', () => {
  it('creates manifest with three reviewers for technical-deep-dive', () => {
    const f = setupFixture();
    seedEvaluateSlug(f, 'alpha');
    const { logs } = captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateInit('alpha', paths(f));
      expect(process.exitCode).not.toBe(1);
      expect(logs.join('\n')).toContain('Evaluation initialized');
      const manifest = JSON.parse(readFileSync(join(f.evaluationsDir, 'alpha', 'manifest.json'), 'utf-8'));
      expect(manifest.expected_reviewers).toEqual(['structural', 'adversarial', 'methodology']);
    } finally {
      process.exitCode = saved;
    }
  });

  it('creates manifest with two reviewers for analysis-opinion', () => {
    const f = setupFixture();
    seedEvaluateSlug(f, 'op', 'analysis-opinion');
    captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateInit('op', paths(f));
      const manifest = JSON.parse(readFileSync(join(f.evaluationsDir, 'op', 'manifest.json'), 'utf-8'));
      expect(manifest.expected_reviewers).toEqual(['structural', 'adversarial']);
    } finally {
      process.exitCode = saved;
    }
  });

  it('promotes a draft-phase post to evaluate', () => {
    const f = setupFixture();
    seedDraftSlug(f, 'promote');
    captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateInit('promote', paths(f));
      const db = getDatabase(f.dbPath);
      try {
        const post = db.prepare('SELECT phase FROM posts WHERE slug = ?').get('promote') as { phase: string };
        expect(post.phase).toBe('evaluate');
      } finally {
        closeDatabase(db);
      }
    } finally {
      process.exitCode = saved;
    }
  });

  it('sets exitCode=1 for invalid slug', () => {
    const f = setupFixture();
    captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateInit('BAD_SLUG!', paths(f));
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = saved;
    }
  });
});

describe('runEvaluateAutocheck', () => {
  it('writes structural.lint.json and is byte-equal across reruns', () => {
    const f = setupFixture();
    seedEvaluateSlug(f, 'det');
    writeDraftFile(f, 'det', 'Body with [broken](/writing/nope).');
    captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateAutocheck('det', paths(f));
      const out1 = readFileSync(join(f.evaluationsDir, 'det', 'structural.lint.json'), 'utf-8');
      runEvaluateAutocheck('det', paths(f));
      const out2 = readFileSync(join(f.evaluationsDir, 'det', 'structural.lint.json'), 'utf-8');
      expect(out1).toBe(out2);
    } finally {
      process.exitCode = saved;
    }
  });
});

describe('runEvaluateRecord', () => {
  it('records a valid reviewer output', () => {
    const f = setupFixture();
    seedEvaluateSlug(f, 'r');
    runEvaluateInit('r', paths(f));
    const workspace = join(f.evaluationsDir, 'r');
    const issuesPath = writeReviewerJson(workspace, 'structural', makeOutput('structural', []));
    const { logs } = captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateRecord('r', { reviewer: 'structural', report: '/tmp/r.md', issues: issuesPath }, paths(f));
      expect(process.exitCode).not.toBe(1);
      expect(logs.join('\n')).toContain('Recorded structural review');
    } finally {
      process.exitCode = saved;
    }
  });

  it('rejects malformed JSON with descriptive error', () => {
    const f = setupFixture();
    seedEvaluateSlug(f, 'bad');
    runEvaluateInit('bad', paths(f));
    const badPath = join(f.tempDir, 'bad.json');
    writeFileSync(badPath, '{not json', 'utf-8');
    const { errors } = captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateRecord('bad', { reviewer: 'structural', report: '/tmp/r.md', issues: badPath }, paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toMatch(/Invalid JSON/);
    } finally {
      process.exitCode = saved;
    }
  });

  it('rejects reviewer not in expected list (methodology for analysis-opinion)', () => {
    const f = setupFixture();
    seedEvaluateSlug(f, 'op', 'analysis-opinion');
    runEvaluateInit('op', paths(f));
    const workspace = join(f.evaluationsDir, 'op');
    const issuesPath = writeReviewerJson(workspace, 'methodology', makeOutput('methodology', []));
    const { errors } = captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateRecord('op', { reviewer: 'methodology', report: '/tmp/r.md', issues: issuesPath }, paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toMatch(/not in the expected/);
    } finally {
      process.exitCode = saved;
    }
  });

  it('rejects invalid reviewer enum value', () => {
    const f = setupFixture();
    seedEvaluateSlug(f, 'enum');
    runEvaluateInit('enum', paths(f));
    const issuesPath = join(f.tempDir, 'whatever.json');
    writeFileSync(issuesPath, '{}', 'utf-8');
    const { errors } = captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateRecord('enum', { reviewer: 'nonsense', report: '/tmp/r.md', issues: issuesPath }, paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toMatch(/Invalid reviewer/);
    } finally {
      process.exitCode = saved;
    }
  });
});

describe('runEvaluateShow', () => {
  it('prints reviewer status table', () => {
    const f = setupFixture();
    seedEvaluateSlug(f, 's');
    runEvaluateInit('s', paths(f));
    const { logs } = captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateShow('s', paths(f));
      const combined = logs.join('\n');
      expect(combined).toContain('structural');
      expect(combined).toContain('pending');
    } finally {
      process.exitCode = saved;
    }
  });

  it('prints verdict when synthesis exists', () => {
    const f = setupFixture();
    seedEvaluateSlug(f, 'sh');
    runEvaluateInit('sh', paths(f));
    recordThreeReviewers(f, 'sh', false);
    runEvaluateSynthesize('sh', paths(f));
    const { logs } = captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateShow('sh', paths(f));
      expect(logs.join('\n')).toMatch(/verdict:\s+pass/);
    } finally {
      process.exitCode = saved;
    }
  });

  it('tolerates a tampered/malformed manifest — prints best-effort historical view, no raw stack trace', () => {
    const f = setupFixture();
    seedEvaluateSlug(f, 'tamper');
    runEvaluateInit('tamper', paths(f));
    // Corrupt the manifest so readManifest throws. runEvaluateShow must catch
    // and degrade gracefully — informational commands cannot leak stack traces.
    writeFileSync(join(f.evaluationsDir, 'tamper', 'manifest.json'), '{"content_type":"technical-deep-dive","cycles":[{"started_at":"x","evaluation_id_floor":"NOT_A_NUMBER"}]}', 'utf-8');
    const { logs, errors } = captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateShow('tamper', paths(f));
      // Exit code must stay 0 — display is best-effort for broken state.
      expect(process.exitCode ?? 0).toBe(saved ?? 0);
      const combined = `${logs.join('\n')}\n${errors.join('\n')}`;
      expect(combined).toMatch(/manifest:\s+\(unreadable:/);
      // Core post state still shown even when manifest is broken.
      expect(combined).toContain('tamper');
      expect(combined).toContain('evaluate');
      // No raw "at Object.readManifest" stack traces.
      expect(combined).not.toMatch(/\n\s+at /);
    } finally {
      process.exitCode = saved;
    }
  });

  it('tolerates manifest with non-array expected_reviewers — no TypeError stack trace (E2 bypass)', () => {
    const f = setupFixture();
    seedEvaluateSlug(f, 'bad-er-show');
    runEvaluateInit('bad-er-show', paths(f));
    // Exact E2 attack: structurally valid JSON, but expected_reviewers is a
    // string. Pre-R8 this crashed `manifest.expected_reviewers.join(', ')`
    // with a raw Node stack trace. Post-R8 readManifest throws with a
    // descriptive message, show catches it, and prints a best-effort line.
    const manifestPath = join(f.evaluationsDir, 'bad-er-show', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.expected_reviewers = 'not-an-array';
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');

    const { logs, errors } = captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateShow('bad-er-show', paths(f));
      const combined = `${logs.join('\n')}\n${errors.join('\n')}`;
      expect(combined).toMatch(/manifest:\s+\(unreadable:.*expected_reviewers/);
      expect(combined).not.toMatch(/TypeError/);
      expect(combined).not.toMatch(/\n\s+at /);
    } finally {
      process.exitCode = saved;
    }
  });

  it('cycle-scoped: after reject+re-init, prior-cycle recorded reviewers render as pending and the old verdict is not shown as current', () => {
    const f = setupFixture();
    seedEvaluateSlug(f, 'cyc');
    runEvaluateInit('cyc', paths(f));
    // Cycle 1: record all three, synthesize — a pass lives in the DB.
    recordThreeReviewers(f, 'cyc', false);
    runEvaluateSynthesize('cyc', paths(f));
    // Reject and roll a new cycle.
    runEvaluateReject('cyc', paths(f));
    const db = getDatabase(f.dbPath);
    try {
      advancePhase(db, 'cyc', 'evaluate');
    } finally {
      closeDatabase(db);
    }
    runEvaluateInit('cyc', paths(f));

    const { logs } = captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateShow('cyc', paths(f));
      const combined = logs.join('\n');
      // Every expected reviewer must appear as pending in the new cycle.
      expect(combined).toMatch(/structural\s*:\s*pending/);
      expect(combined).toMatch(/adversarial\s*:\s*pending/);
      expect(combined).toMatch(/methodology\s*:\s*pending/);
      // The cycle-current verdict must not mis-report the prior pass.
      expect(combined).toMatch(/verdict:\s+\(not synthesized in current cycle\)/);
      // Prior cycle is visible as historical metadata.
      expect(combined).toMatch(/prior cycles:\s+0 passed, 1 rejected/);
      // Cycle count and status are surfaced.
      expect(combined).toMatch(/cycle:\s+2 \(open/);
    } finally {
      process.exitCode = saved;
    }
  });
});

describe('runEvaluateSynthesize', () => {
  it('refuses to run when reviewers are missing', () => {
    const f = setupFixture();
    seedEvaluateSlug(f, 'nope');
    runEvaluateInit('nope', paths(f));
    // Seed the autocheck sidecar so synthesis reaches the reviewer-missing
    // check. Without this, synthesis fails earlier on the missing lint
    // (correct but not what this test is exercising).
    writeFileSync(join(f.evaluationsDir, 'nope', 'structural.lint.json'), '[]\n', 'utf-8');
    const { errors } = captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateSynthesize('nope', paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toMatch(/missing reviewer/);
    } finally {
      process.exitCode = saved;
    }
  });

  it('prints pass verdict after all three reviewers record empty issues', () => {
    const f = setupFixture();
    seedEvaluateSlug(f, 'okk');
    runEvaluateInit('okk', paths(f));
    recordThreeReviewers(f, 'okk', false);
    const { logs } = captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateSynthesize('okk', paths(f));
      expect(logs.join('\n')).toMatch(/Verdict: pass/);
      expect(existsSync(join(f.evaluationsDir, 'okk', 'synthesis.md'))).toBe(true);
    } finally {
      process.exitCode = saved;
    }
  });
});

describe('runEvaluateComplete', () => {
  it('advances to publish when verdict is pass', () => {
    const f = setupFixture();
    seedEvaluateSlug(f, 'adv');
    runEvaluateInit('adv', paths(f));
    recordThreeReviewers(f, 'adv', false);
    runEvaluateSynthesize('adv', paths(f));
    captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateComplete('adv', paths(f));
      const db = getDatabase(f.dbPath);
      try {
        const post = db.prepare('SELECT phase FROM posts WHERE slug = ?').get('adv') as { phase: string };
        expect(post.phase).toBe('publish');
      } finally {
        closeDatabase(db);
      }
    } finally {
      process.exitCode = saved;
    }
  });

  it('sets exitCode=1 when verdict is fail', () => {
    const f = setupFixture();
    seedEvaluateSlug(f, 'fc');
    runEvaluateInit('fc', paths(f));
    recordThreeReviewers(f, 'fc', true);
    runEvaluateSynthesize('fc', paths(f));
    const { errors } = captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateComplete('fc', paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toMatch(/not 'pass'/);
    } finally {
      process.exitCode = saved;
    }
  });
});

describe('runEvaluateReject', () => {
  it('moves post back to draft (visible via direct DB query)', () => {
    const f = setupFixture();
    seedEvaluateSlug(f, 'rej');
    runEvaluateInit('rej', paths(f));
    captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateReject('rej', paths(f));
      const db = getDatabase(f.dbPath);
      try {
        const post = db.prepare('SELECT phase FROM posts WHERE slug = ?').get('rej') as { phase: string };
        expect(post.phase).toBe('draft');
      } finally {
        closeDatabase(db);
      }
    } finally {
      process.exitCode = saved;
    }
  });

  it('enforces phase boundary when post is already in draft', () => {
    const f = setupFixture();
    seedDraftSlug(f, 'd');
    const { errors } = captureLogs();
    const saved = process.exitCode;
    try {
      runEvaluateReject('d', paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toMatch(/not 'evaluate'/);
    } finally {
      process.exitCode = saved;
    }
  });
});

describe('slug validation', () => {
  it('all seven handlers reject invalid slugs with exitCode=1', () => {
    const f = setupFixture();
    const handlers = [
      () => runEvaluateInit('BAD!', paths(f)),
      () => runEvaluateAutocheck('BAD!', paths(f)),
      () => runEvaluateRecord('BAD!', { reviewer: 'structural', report: '/tmp/r.md', issues: '/tmp/nope.json' }, paths(f)),
      () => runEvaluateShow('BAD!', paths(f)),
      () => runEvaluateSynthesize('BAD!', paths(f)),
      () => runEvaluateComplete('BAD!', paths(f)),
      () => runEvaluateReject('BAD!', paths(f)),
    ];
    for (const handler of handlers) {
      const saved = process.exitCode;
      try {
        captureLogs();
        handler();
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = saved;
      }
    }
  });
});
