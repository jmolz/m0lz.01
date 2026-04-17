import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

import { closeDatabase, getDatabase } from '../src/core/db/database.js';
import { advancePhase, initResearchPost } from '../src/core/research/state.js';
import {
  completePublish,
  completePublishUnderLock,
  getPublishPost,
  initPublishFromEvaluate,
  persistPublishUrls,
} from '../src/core/publish/phase.js';
import {
  allStepsComplete,
  createPipelineSteps,
  getNextPendingStep,
  getPipelineSteps,
  markStepCompleted,
  markStepFailed,
  markStepRunning,
  markStepSkipped,
  reclaimStaleRunning,
  reconcilePipelineSteps,
} from '../src/core/publish/steps-crud.js';
import { acquirePublishLock } from '../src/core/publish/lock.js';
import { PUBLISH_STEP_NAMES, PostRow } from '../src/core/publish/types.js';
import { BlogConfig } from '../src/core/config/types.js';

// Shared config fixture. Tests that need to override a flag clone and tweak.
function makeConfig(overrides?: Partial<BlogConfig['publish']>): BlogConfig {
  const publish: BlogConfig['publish'] = {
    devto: true,
    medium: true,
    substack: true,
    github_repos: true,
    social_drafts: true,
    research_pages: true,
    ...overrides,
  };
  return {
    site: { repo_path: '/tmp/site', base_url: 'https://m0lz.dev', content_dir: 'content/posts', research_dir: 'content/research' },
    author: { name: 'Tester', github: 'jmolz' },
    ai: {
      primary: 'claude-code',
      reviewers: { structural: 'claude-code', adversarial: 'codex-cli', methodology: 'codex-cli' },
      codex: { adversarial_effort: 'high', methodology_effort: 'xhigh' },
    },
    content_types: {
      'project-launch': { benchmark: 'optional', companion_repo: 'existing', social_prefix: 'Show HN:' },
      'technical-deep-dive': { benchmark: 'required', companion_repo: 'new', social_prefix: '' },
      'analysis-opinion': { benchmark: 'skip', companion_repo: 'optional', social_prefix: '' },
    },
    benchmark: { capture_environment: true, methodology_template: true, preserve_raw_data: true, multiple_runs: 3 },
    publish,
    social: { platforms: ['linkedin', 'hackernews'], timing_recommendations: true },
    evaluation: {
      require_pass: true, min_sources: 3, max_reading_level: 12, three_reviewer_panel: true,
      consensus_must_fix: true, majority_should_fix: true, single_advisory: true,
      verify_benchmark_claims: true, methodology_completeness: true,
    },
    updates: { preserve_original_data: true, update_notice: true, update_crosspost: true },
  };
}

interface Fixture {
  tempDir: string;
  publishDir: string;
  db: Database.Database;
}

let fixture: Fixture | undefined;

afterEach(() => {
  if (fixture?.db) closeDatabase(fixture.db);
  if (fixture) rmSync(fixture.tempDir, { recursive: true, force: true });
  fixture = undefined;
});

function setup(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'publish-state-'));
  const publishDir = join(tempDir, 'publish');
  mkdirSync(publishDir, { recursive: true });
  const db = getDatabase(':memory:');
  fixture = { tempDir, publishDir, db };
  return fixture;
}

// Seed a post in the publish phase with a passing evaluation. Used by
// completePublish and getPublishPost tests that need a valid starting state.
function seedPublishPost(
  db: Database.Database,
  slug: string,
  contentType: 'project-launch' | 'technical-deep-dive' | 'analysis-opinion' = 'technical-deep-dive',
): void {
  initResearchPost(db, slug, 'topic', 'directed', contentType);
  advancePhase(db, slug, 'benchmark');
  advancePhase(db, slug, 'draft');
  advancePhase(db, slug, 'evaluate');
  db.prepare('UPDATE posts SET evaluation_passed = 1 WHERE slug = ?').run(slug);
  advancePhase(db, slug, 'publish');
}

// Seed a post stopped in the evaluate phase. The second argument controls
// the evaluation_passed column so callers can test both pass and fail gates.
function seedEvaluatePost(
  db: Database.Database,
  slug: string,
  evaluationPassed: 0 | 1 = 1,
  contentType: 'project-launch' | 'technical-deep-dive' | 'analysis-opinion' = 'technical-deep-dive',
): void {
  initResearchPost(db, slug, 'topic', 'directed', contentType);
  advancePhase(db, slug, 'benchmark');
  advancePhase(db, slug, 'draft');
  advancePhase(db, slug, 'evaluate');
  db.prepare('UPDATE posts SET evaluation_passed = ? WHERE slug = ?').run(evaluationPassed, slug);
}

describe('getPublishPost — phase enforcement', () => {
  it('throws when slug is missing', () => {
    const f = setup();
    expect(() => getPublishPost(f.db, 'ghost')).toThrow('Post not found: ghost');
  });

  it('throws when post is in draft phase', () => {
    const f = setup();
    initResearchPost(f.db, 'alpha', 'topic', 'directed', 'technical-deep-dive');
    advancePhase(f.db, 'alpha', 'benchmark');
    advancePhase(f.db, 'alpha', 'draft');
    expect(() => getPublishPost(f.db, 'alpha')).toThrow(/not 'publish'/);
  });

  it('throws when post is in evaluate phase', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'beta');
    expect(() => getPublishPost(f.db, 'beta')).toThrow(/not 'publish'/);
  });

  it('returns post row when phase is publish', () => {
    const f = setup();
    seedPublishPost(f.db, 'gamma');
    const post = getPublishPost(f.db, 'gamma');
    expect(post.slug).toBe('gamma');
    expect(post.phase).toBe('publish');
  });
});

describe('initPublishFromEvaluate — phase promotion', () => {
  it('advances phase from evaluate to publish when evaluation_passed = 1', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'promote', 1);
    initPublishFromEvaluate(f.db, 'promote');
    const post = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get('promote') as { phase: string };
    expect(post.phase).toBe('publish');
  });

  it('throws when post is in a non-evaluate phase (research)', () => {
    const f = setup();
    initResearchPost(f.db, 'premature', 'topic', 'directed', 'technical-deep-dive');
    expect(() => initPublishFromEvaluate(f.db, 'premature')).toThrow(/not 'evaluate'/);
  });

  it('throws when evaluation_passed = 0', () => {
    const f = setup();
    seedEvaluatePost(f.db, 'failing', 0);
    expect(() => initPublishFromEvaluate(f.db, 'failing')).toThrow(/has not passed evaluation/);
  });

  it('is idempotent when post is already in publish phase', () => {
    const f = setup();
    seedPublishPost(f.db, 'already');
    const before = f.db.prepare('SELECT phase, updated_at FROM posts WHERE slug = ?').get('already') as {
      phase: string;
      updated_at: string;
    };
    // Should not throw, should not change the phase.
    initPublishFromEvaluate(f.db, 'already');
    const after = f.db.prepare('SELECT phase, updated_at FROM posts WHERE slug = ?').get('already') as {
      phase: string;
      updated_at: string;
    };
    expect(after.phase).toBe('publish');
    expect(after.phase).toBe(before.phase);
  });
});

describe('completePublish — gate + phase advance + URL coalesce', () => {
  it('throws when any pipeline step is still pending/running/failed', () => {
    const f = setup();
    seedPublishPost(f.db, 'blocked');
    createPipelineSteps(f.db, 'blocked', 'technical-deep-dive', makeConfig());
    // All steps left in default state (pending) for anything not pre-skipped.
    expect(() => completePublish(f.db, 'blocked', {}, f.publishDir)).toThrow(
      /not every pipeline step is completed or skipped/,
    );
  });

  it('advances to published and writes URLs when all steps complete or skipped', () => {
    const f = setup();
    seedPublishPost(f.db, 'happy', 'analysis-opinion');
    // analysis-opinion pre-skips companion-repo; hasResearchArtifact=false pre-skips research-page.
    createPipelineSteps(f.db, 'happy', 'analysis-opinion', makeConfig(), { hasResearchArtifact: false });
    // Mark all remaining non-skipped rows as completed.
    for (const step of getPipelineSteps(f.db, 'happy')) {
      if (step.status === 'pending') {
        markStepCompleted(f.db, 'happy', step.step_name);
      }
    }
    completePublish(
      f.db,
      'happy',
      {
        site_url: 'https://m0lz.dev/writing/happy',
        devto_url: 'https://dev.to/jmolz/happy-xyz',
        medium_url: 'https://medium.com/@jmolz/happy-abc',
        substack_url: 'https://jmolz.substack.com/p/happy',
        repo_url: 'https://github.com/jmolz/m0lz.happy',
      },
      f.publishDir,
    );
    const post = f.db.prepare('SELECT * FROM posts WHERE slug = ?').get('happy') as PostRow;
    expect(post.phase).toBe('published');
    expect(post.site_url).toBe('https://m0lz.dev/writing/happy');
    expect(post.devto_url).toBe('https://dev.to/jmolz/happy-xyz');
    expect(post.medium_url).toBe('https://medium.com/@jmolz/happy-abc');
    expect(post.substack_url).toBe('https://jmolz.substack.com/p/happy');
    expect(post.repo_url).toBe('https://github.com/jmolz/m0lz.happy');
    expect(post.published_at).not.toBeNull();
  });

  it('preserves previously-written URLs when called with a partial bundle (COALESCE)', () => {
    const f = setup();
    seedPublishPost(f.db, 'partial', 'analysis-opinion');
    createPipelineSteps(f.db, 'partial', 'analysis-opinion', makeConfig(), { hasResearchArtifact: false });
    for (const step of getPipelineSteps(f.db, 'partial')) {
      if (step.status === 'pending') {
        markStepCompleted(f.db, 'partial', step.step_name);
      }
    }
    // Simulate a prior runner writing site_url directly on the posts row.
    f.db.prepare('UPDATE posts SET site_url = ? WHERE slug = ?').run(
      'https://m0lz.dev/writing/partial',
      'partial',
    );
    // Now complete with only devto_url — site_url must be preserved.
    completePublish(
      f.db,
      'partial',
      { devto_url: 'https://dev.to/jmolz/partial-zzz' },
      f.publishDir,
    );
    const post = f.db.prepare('SELECT site_url, devto_url FROM posts WHERE slug = ?').get('partial') as {
      site_url: string;
      devto_url: string;
    };
    expect(post.site_url).toBe('https://m0lz.dev/writing/partial');
    expect(post.devto_url).toBe('https://dev.to/jmolz/partial-zzz');
  });
});

describe('createPipelineSteps — row seeding + pre-skip routing', () => {
  it('creates exactly 11 rows matching PUBLISH_STEP_NAMES in order', () => {
    const f = setup();
    seedPublishPost(f.db, 'seeded');
    createPipelineSteps(f.db, 'seeded', 'technical-deep-dive', makeConfig());
    const rows = getPipelineSteps(f.db, 'seeded');
    expect(rows).toHaveLength(PUBLISH_STEP_NAMES.length);
    expect(rows.length).toBe(11);
    rows.forEach((row, idx) => {
      expect(row.step_number).toBe(idx + 1);
      expect(row.step_name).toBe(PUBLISH_STEP_NAMES[idx]);
    });
  });

  it('is idempotent on re-run — no duplicates', () => {
    const f = setup();
    seedPublishPost(f.db, 'once');
    createPipelineSteps(f.db, 'once', 'technical-deep-dive', makeConfig());
    createPipelineSteps(f.db, 'once', 'technical-deep-dive', makeConfig());
    const rows = getPipelineSteps(f.db, 'once');
    expect(rows).toHaveLength(11);
  });

  it('analysis-opinion pre-skips companion-repo and research-page (with hasResearchArtifact=false)', () => {
    const f = setup();
    seedPublishPost(f.db, 'opinion', 'analysis-opinion');
    createPipelineSteps(f.db, 'opinion', 'analysis-opinion', makeConfig(), { hasResearchArtifact: false });
    const byName = Object.fromEntries(getPipelineSteps(f.db, 'opinion').map((r) => [r.step_name, r]));
    expect(byName['companion-repo'].status).toBe('skipped');
    expect(byName['companion-repo'].error_message).toMatch(/do not scaffold companion repos/);
    expect(byName['research-page'].status).toBe('skipped');
    expect(byName['research-page'].error_message).toMatch(/Analysis-opinion without research artifacts/);
  });

  it('project-launch pre-skips companion-repo', () => {
    const f = setup();
    seedPublishPost(f.db, 'launch', 'project-launch');
    createPipelineSteps(f.db, 'launch', 'project-launch', makeConfig());
    const companionRepo = getPipelineSteps(f.db, 'launch').find((r) => r.step_name === 'companion-repo');
    expect(companionRepo?.status).toBe('skipped');
    expect(companionRepo?.error_message).toMatch(/existing companion repo/);
  });

  it('technical-deep-dive does NOT pre-skip companion-repo when config.publish is fully enabled', () => {
    const f = setup();
    seedPublishPost(f.db, 'deepdive', 'technical-deep-dive');
    createPipelineSteps(f.db, 'deepdive', 'technical-deep-dive', makeConfig());
    const rows = getPipelineSteps(f.db, 'deepdive');
    // Every row should start pending (nothing pre-skipped for full-config + technical-deep-dive).
    for (const row of rows) {
      expect(row.status).toBe('pending');
    }
  });

  it('config.publish.devto = false pre-skips crosspost-devto', () => {
    const f = setup();
    seedPublishPost(f.db, 'nodevto');
    createPipelineSteps(f.db, 'nodevto', 'technical-deep-dive', makeConfig({ devto: false }));
    const row = getPipelineSteps(f.db, 'nodevto').find((r) => r.step_name === 'crosspost-devto');
    expect(row?.status).toBe('skipped');
    expect(row?.error_message).toMatch(/publish\.devto=false/);
  });

  it('config.publish.medium = false pre-skips paste-medium', () => {
    const f = setup();
    seedPublishPost(f.db, 'nomedium');
    createPipelineSteps(f.db, 'nomedium', 'technical-deep-dive', makeConfig({ medium: false }));
    const row = getPipelineSteps(f.db, 'nomedium').find((r) => r.step_name === 'paste-medium');
    expect(row?.status).toBe('skipped');
    expect(row?.error_message).toMatch(/publish\.medium=false/);
  });

  it('config.publish.substack = false pre-skips paste-substack', () => {
    const f = setup();
    seedPublishPost(f.db, 'nosubstack');
    createPipelineSteps(f.db, 'nosubstack', 'technical-deep-dive', makeConfig({ substack: false }));
    const row = getPipelineSteps(f.db, 'nosubstack').find((r) => r.step_name === 'paste-substack');
    expect(row?.status).toBe('skipped');
    expect(row?.error_message).toMatch(/publish\.substack=false/);
  });
});

describe('pipeline step CRUD — next/mark/all-complete', () => {
  it('getNextPendingStep returns the first pending row in step_number order', () => {
    const f = setup();
    seedPublishPost(f.db, 'ordering');
    createPipelineSteps(f.db, 'ordering', 'technical-deep-dive', makeConfig());
    // Complete steps 1 and 2, verify next is step 3.
    markStepCompleted(f.db, 'ordering', 'verify');
    markStepCompleted(f.db, 'ordering', 'research-page');
    const next = getNextPendingStep(f.db, 'ordering');
    expect(next?.step_number).toBe(3);
    expect(next?.step_name).toBe('site-pr');
  });

  it('getNextPendingStep includes failed rows and returns null when none remain', () => {
    const f = setup();
    seedPublishPost(f.db, 'retry');
    createPipelineSteps(f.db, 'retry', 'technical-deep-dive', makeConfig());
    // Mark every row completed except one which we fail.
    for (const step of PUBLISH_STEP_NAMES) {
      if (step === 'site-pr') markStepFailed(f.db, 'retry', step, 'boom');
      else markStepCompleted(f.db, 'retry', step);
    }
    // getNextPendingStep should find the failed row for retry.
    const next = getNextPendingStep(f.db, 'retry');
    expect(next?.step_name).toBe('site-pr');
    expect(next?.status).toBe('failed');
    // After completing it, no more pending/failed rows.
    markStepCompleted(f.db, 'retry', 'site-pr');
    expect(getNextPendingStep(f.db, 'retry')).toBeNull();
  });

  it('markStepRunning/Completed/Failed/Skipped each transition status and set timestamps', () => {
    const f = setup();
    seedPublishPost(f.db, 'mutate');
    createPipelineSteps(f.db, 'mutate', 'technical-deep-dive', makeConfig());

    markStepRunning(f.db, 'mutate', 'verify');
    const running = getPipelineSteps(f.db, 'mutate').find((r) => r.step_name === 'verify')!;
    expect(running.status).toBe('running');
    expect(running.started_at).not.toBeNull();
    expect(running.completed_at).toBeNull();

    markStepCompleted(f.db, 'mutate', 'verify');
    const completed = getPipelineSteps(f.db, 'mutate').find((r) => r.step_name === 'verify')!;
    expect(completed.status).toBe('completed');
    expect(completed.completed_at).not.toBeNull();
    expect(completed.error_message).toBeNull();

    markStepFailed(f.db, 'mutate', 'site-pr', 'network error');
    const failed = getPipelineSteps(f.db, 'mutate').find((r) => r.step_name === 'site-pr')!;
    expect(failed.status).toBe('failed');
    expect(failed.error_message).toBe('network error');
    expect(failed.completed_at).not.toBeNull();

    markStepSkipped(f.db, 'mutate', 'paste-medium', 'disabled by config');
    const skipped = getPipelineSteps(f.db, 'mutate').find((r) => r.step_name === 'paste-medium')!;
    expect(skipped.status).toBe('skipped');
    expect(skipped.error_message).toBe('disabled by config');
    expect(skipped.completed_at).not.toBeNull();
  });

  it('getPipelineSteps returns all 11 rows ordered by step_number', () => {
    const f = setup();
    seedPublishPost(f.db, 'ordered');
    createPipelineSteps(f.db, 'ordered', 'technical-deep-dive', makeConfig());
    const rows = getPipelineSteps(f.db, 'ordered');
    expect(rows).toHaveLength(11);
    for (let i = 0; i < rows.length; i += 1) {
      expect(rows[i].step_number).toBe(i + 1);
    }
  });

  it('allStepsComplete returns false when any step is pending/running/failed; true when all completed or skipped', () => {
    const f = setup();
    seedPublishPost(f.db, 'gate');
    createPipelineSteps(f.db, 'gate', 'technical-deep-dive', makeConfig());
    expect(allStepsComplete(f.db, 'gate')).toBe(false);
    // Complete everything except one running row.
    for (const step of PUBLISH_STEP_NAMES) markStepCompleted(f.db, 'gate', step);
    expect(allStepsComplete(f.db, 'gate')).toBe(true);
    // Flip one back to running — should go false again.
    markStepRunning(f.db, 'gate', 'verify');
    expect(allStepsComplete(f.db, 'gate')).toBe(false);
    // Failed state is also non-terminal for the gate.
    markStepFailed(f.db, 'gate', 'verify', 'retry me');
    expect(allStepsComplete(f.db, 'gate')).toBe(false);
    // Skipped counts as terminal.
    markStepSkipped(f.db, 'gate', 'verify', 'manual override');
    expect(allStepsComplete(f.db, 'gate')).toBe(true);
  });
});

describe('reconcilePipelineSteps — toggle optional destinations at resume (Codex Pass 6 regression)', () => {
  it('downgrades pending rows to skipped when current config disables the destination', () => {
    const f = setup();
    seedPublishPost(f.db, 'togglemedium');
    // Initial seed with medium ENABLED: paste-medium starts pending.
    createPipelineSteps(f.db, 'togglemedium', 'technical-deep-dive', makeConfig({ medium: true }));
    let mediumRow = getPipelineSteps(f.db, 'togglemedium').find((r) => r.step_name === 'paste-medium')!;
    expect(mediumRow.status).toBe('pending');

    // Operator disables medium in config. Reconcile on resume.
    const changed = reconcilePipelineSteps(
      f.db,
      'togglemedium',
      'technical-deep-dive',
      makeConfig({ medium: false }),
    );
    expect(changed).toBe(1);
    mediumRow = getPipelineSteps(f.db, 'togglemedium').find((r) => r.step_name === 'paste-medium')!;
    expect(mediumRow.status).toBe('skipped');
    expect(mediumRow.error_message).toMatch(/publish\.medium=false/);
  });

  it('downgrades failed rows too — operator can disable a broken destination mid-pipeline', () => {
    const f = setup();
    seedPublishPost(f.db, 'togglefailed');
    createPipelineSteps(f.db, 'togglefailed', 'technical-deep-dive', makeConfig({ devto: true }));
    markStepFailed(f.db, 'togglefailed', 'crosspost-devto', 'network error');

    const changed = reconcilePipelineSteps(
      f.db,
      'togglefailed',
      'technical-deep-dive',
      makeConfig({ devto: false }),
    );
    expect(changed).toBe(1);
    const row = getPipelineSteps(f.db, 'togglefailed').find((r) => r.step_name === 'crosspost-devto')!;
    expect(row.status).toBe('skipped');
  });

  it('does NOT upgrade skipped rows back to pending when config re-enables them', () => {
    // Re-enabling a skipped destination risks re-running something the
    // operator deliberately disabled in an earlier cycle. The current
    // policy is "skips are sticky within a cycle"; re-enabling requires
    // rejecting the evaluation and starting a new publish cycle.
    const f = setup();
    seedPublishPost(f.db, 'nowake');
    createPipelineSteps(f.db, 'nowake', 'technical-deep-dive', makeConfig({ medium: false }));
    const mediumBefore = getPipelineSteps(f.db, 'nowake').find((r) => r.step_name === 'paste-medium')!;
    expect(mediumBefore.status).toBe('skipped');

    // Operator flips medium back to true.
    const changed = reconcilePipelineSteps(
      f.db,
      'nowake',
      'technical-deep-dive',
      makeConfig({ medium: true }),
    );
    expect(changed).toBe(0);
    const mediumAfter = getPipelineSteps(f.db, 'nowake').find((r) => r.step_name === 'paste-medium')!;
    expect(mediumAfter.status).toBe('skipped');
  });

  it('is a no-op when no rows need reconciliation', () => {
    const f = setup();
    seedPublishPost(f.db, 'unchanged');
    createPipelineSteps(f.db, 'unchanged', 'technical-deep-dive', makeConfig());
    const changed = reconcilePipelineSteps(f.db, 'unchanged', 'technical-deep-dive', makeConfig());
    expect(changed).toBe(0);
  });
});

describe('reclaimStaleRunning — recover from crashed prior run', () => {
  it('demotes `running` rows back to `pending` and returns the count', () => {
    const f = setup();
    seedPublishPost(f.db, 'reclaim');
    createPipelineSteps(f.db, 'reclaim', 'technical-deep-dive', makeConfig());
    // Simulate a crashed prior runner: two steps stuck in running.
    markStepRunning(f.db, 'reclaim', 'verify');
    markStepRunning(f.db, 'reclaim', 'research-page');
    const reclaimed = reclaimStaleRunning(f.db, 'reclaim');
    expect(reclaimed).toBe(2);
    const rows = getPipelineSteps(f.db, 'reclaim');
    const byName = Object.fromEntries(rows.map((r) => [r.step_name, r]));
    expect(byName.verify.status).toBe('pending');
    expect(byName.verify.started_at).toBeNull();
    expect(byName['research-page'].status).toBe('pending');
  });

  it('returns 0 when no rows are running', () => {
    const f = setup();
    seedPublishPost(f.db, 'clean');
    createPipelineSteps(f.db, 'clean', 'technical-deep-dive', makeConfig());
    expect(reclaimStaleRunning(f.db, 'clean')).toBe(0);
  });

  it('does not affect completed/failed/skipped/pending rows', () => {
    const f = setup();
    seedPublishPost(f.db, 'mixed');
    createPipelineSteps(f.db, 'mixed', 'technical-deep-dive', makeConfig());
    markStepCompleted(f.db, 'mixed', 'verify');
    markStepFailed(f.db, 'mixed', 'research-page', 'boom');
    markStepSkipped(f.db, 'mixed', 'paste-medium', 'disabled');
    markStepRunning(f.db, 'mixed', 'site-pr');
    expect(reclaimStaleRunning(f.db, 'mixed')).toBe(1);
    const rows = getPipelineSteps(f.db, 'mixed');
    const byName = Object.fromEntries(rows.map((r) => [r.step_name, r]));
    expect(byName.verify.status).toBe('completed');
    expect(byName['research-page'].status).toBe('failed');
    expect(byName['paste-medium'].status).toBe('skipped');
    expect(byName['site-pr'].status).toBe('pending');
  });
});

describe('persistPublishUrls — per-step URL persistence with first-writer-wins', () => {
  it('writes URLs onto the posts row when the columns are currently NULL', () => {
    const f = setup();
    seedPublishPost(f.db, 'first');
    persistPublishUrls(f.db, 'first', {
      site_url: 'https://m0lz.dev/writing/first',
      devto_url: 'https://dev.to/jmolz/first',
    });
    const post = f.db
      .prepare('SELECT site_url, devto_url, medium_url FROM posts WHERE slug = ?')
      .get('first') as { site_url: string; devto_url: string; medium_url: string | null };
    expect(post.site_url).toBe('https://m0lz.dev/writing/first');
    expect(post.devto_url).toBe('https://dev.to/jmolz/first');
    expect(post.medium_url).toBeNull();
  });

  it('does NOT overwrite an already-set URL (COALESCE keeps existing)', () => {
    const f = setup();
    seedPublishPost(f.db, 'wins');
    persistPublishUrls(f.db, 'wins', { devto_url: 'https://dev.to/jmolz/v1' });
    // Second writer tries to overwrite with a different URL.
    persistPublishUrls(f.db, 'wins', { devto_url: 'https://dev.to/jmolz/v2' });
    const post = f.db
      .prepare('SELECT devto_url FROM posts WHERE slug = ?')
      .get('wins') as { devto_url: string };
    expect(post.devto_url).toBe('https://dev.to/jmolz/v1');
  });

  it('ignores fields that are undefined in the partial bundle', () => {
    const f = setup();
    seedPublishPost(f.db, 'partial');
    // First write sets only site_url.
    persistPublishUrls(f.db, 'partial', { site_url: 'https://m0lz.dev/writing/partial' });
    // Second write sets only medium_url — must not clobber site_url.
    persistPublishUrls(f.db, 'partial', { medium_url: 'https://medium.com/@jmolz/partial' });
    const post = f.db
      .prepare('SELECT site_url, medium_url FROM posts WHERE slug = ?')
      .get('partial') as { site_url: string; medium_url: string };
    expect(post.site_url).toBe('https://m0lz.dev/writing/partial');
    expect(post.medium_url).toBe('https://medium.com/@jmolz/partial');
  });
});

describe('completePublishUnderLock — lock ownership guardrail + idempotency', () => {
  function writeOwnLockfile(publishDir: string, slug: string): void {
    const slugDir = join(publishDir, slug);
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, '.publish.lock'), String(process.pid), 'utf-8');
  }

  it('is a no-op when the post is already in the published phase', () => {
    const f = setup();
    seedPublishPost(f.db, 'already', 'analysis-opinion');
    createPipelineSteps(f.db, 'already', 'analysis-opinion', makeConfig(), { hasResearchArtifact: false });
    for (const step of getPipelineSteps(f.db, 'already')) {
      if (step.status === 'pending') markStepCompleted(f.db, 'already', step.step_name);
    }
    // Simulate the caller holding the lock by writing a lockfile stamped
    // with our PID (matching the runtime guardrail's contract).
    writeOwnLockfile(f.publishDir, 'already');
    // First caller wins and sets URLs.
    completePublishUnderLock(f.db, 'already', {
      site_url: 'https://m0lz.dev/writing/already',
      devto_url: 'https://dev.to/jmolz/already',
    }, f.publishDir);
    const firstPhase = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get('already') as { phase: string };
    expect(firstPhase.phase).toBe('published');
    // Second caller with empty URL bundle — must NOT throw, must NOT clobber the URLs.
    expect(() => completePublishUnderLock(f.db, 'already', {}, f.publishDir)).not.toThrow();
    const post = f.db
      .prepare('SELECT phase, site_url, devto_url FROM posts WHERE slug = ?')
      .get('already') as { phase: string; site_url: string; devto_url: string };
    expect(post.phase).toBe('published');
    expect(post.site_url).toBe('https://m0lz.dev/writing/already');
    expect(post.devto_url).toBe('https://dev.to/jmolz/already');
  });

  it('throws when called without a lockfile present (caller did not acquire the lock)', () => {
    const f = setup();
    seedPublishPost(f.db, 'nolock', 'analysis-opinion');
    createPipelineSteps(f.db, 'nolock', 'analysis-opinion', makeConfig(), { hasResearchArtifact: false });
    for (const step of getPipelineSteps(f.db, 'nolock')) {
      if (step.status === 'pending') markStepCompleted(f.db, 'nolock', step.step_name);
    }
    // No writeOwnLockfile — lockfile is absent.
    expect(() => completePublishUnderLock(f.db, 'nolock', {}, f.publishDir)).toThrow(
      /requires the publish lock to be held/,
    );
    // Phase was NOT advanced — the runtime guardrail fired before any UPDATE.
    const phase = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get('nolock') as { phase: string };
    expect(phase.phase).toBe('publish');
  });

  it('throws when the lockfile holds a different PID (another process owns the lock)', () => {
    const f = setup();
    seedPublishPost(f.db, 'otherpid', 'analysis-opinion');
    createPipelineSteps(f.db, 'otherpid', 'analysis-opinion', makeConfig(), { hasResearchArtifact: false });
    for (const step of getPipelineSteps(f.db, 'otherpid')) {
      if (step.status === 'pending') markStepCompleted(f.db, 'otherpid', step.step_name);
    }
    // Write a lockfile with a PID that is NOT ours. The guardrail must
    // refuse: this process did not acquire the lock, even though some
    // other process apparently did.
    const slugDir = join(f.publishDir, 'otherpid');
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, '.publish.lock'), String(process.pid + 1), 'utf-8');
    expect(() => completePublishUnderLock(f.db, 'otherpid', {}, f.publishDir)).toThrow(
      /lock to be held by this process/,
    );
  });
});

describe('acquirePublishLock — cooperative serialization', () => {
  it('creates the lockfile with the current PID stamped inside', () => {
    const f = setup();
    const release = acquirePublishLock(f.publishDir, 'pid-check', 100);
    try {
      const lockPath = join(f.publishDir, 'pid-check', '.publish.lock');
      expect(existsSync(lockPath)).toBe(true);
      const contents = readFileSync(lockPath, 'utf-8').trim();
      expect(contents).toBe(String(process.pid));
    } finally {
      release();
    }
  });

  it('throws when lock is held by a live process (same-process second acquire)', () => {
    const f = setup();
    const release = acquirePublishLock(f.publishDir, 'contend', 200);
    try {
      expect(() => acquirePublishLock(f.publishDir, 'contend', 200)).toThrow(
        /Could not acquire publish lock/,
      );
    } finally {
      release();
    }
  });

  it('reclaims a stale lock whose stored PID is dead', () => {
    const f = setup();
    const workspaceDir = join(f.publishDir, 'stale');
    mkdirSync(workspaceDir, { recursive: true });
    const stalePid = 999999;
    // Confirm the fake PID is actually dead — signal 0 probes liveness; ESRCH = dead.
    let pidIsDead = false;
    try {
      process.kill(stalePid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') pidIsDead = true;
    }
    expect(pidIsDead).toBe(true);

    writeFileSync(join(workspaceDir, '.publish.lock'), String(stalePid), 'utf-8');
    const release = acquirePublishLock(f.publishDir, 'stale', 500);
    // Lock should have been reclaimed; contents now stamped with current PID.
    const contents = readFileSync(join(workspaceDir, '.publish.lock'), 'utf-8').trim();
    expect(contents).toBe(String(process.pid));
    release();
  });

  it('release is idempotent — calling twice is a no-op', () => {
    const f = setup();
    const release = acquirePublishLock(f.publishDir, 'double-release', 100);
    release();
    // Second call must not throw even though the file is already gone.
    expect(() => release()).not.toThrow();
  });

  it('reclaims an empty lockfile (prior writer crashed between open and writeSync)', () => {
    const f = setup();
    const workspaceDir = join(f.publishDir, 'empty');
    mkdirSync(workspaceDir, { recursive: true });
    // Simulate a corrupt lockfile: file exists but is empty. Without the
    // empty-file reclaim, the lock would spin to timeout and throw a
    // misleading "another process holds it" error.
    writeFileSync(join(workspaceDir, '.publish.lock'), '', 'utf-8');
    const release = acquirePublishLock(f.publishDir, 'empty', 500);
    const contents = readFileSync(join(workspaceDir, '.publish.lock'), 'utf-8').trim();
    expect(contents).toBe(String(process.pid));
    release();
  });

  it('reclaims a lockfile containing non-numeric garbage', () => {
    const f = setup();
    const workspaceDir = join(f.publishDir, 'garbage');
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, '.publish.lock'), 'not-a-pid', 'utf-8');
    const release = acquirePublishLock(f.publishDir, 'garbage', 500);
    const contents = readFileSync(join(workspaceDir, '.publish.lock'), 'utf-8').trim();
    expect(contents).toBe(String(process.pid));
    release();
  });
});
