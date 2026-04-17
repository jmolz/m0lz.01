import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

// Mock the step modules BEFORE importing the runner so the runner's top-
// level imports resolve to the mocks. Each function returns a minimal
// happy-path shape.
vi.mock('../src/core/unpublish/devto.js', () => ({
  unpublishFromDevTo: vi.fn().mockResolvedValue({ id: 42, url: 'https://dev.to/u/x' }),
}));
vi.mock('../src/core/unpublish/medium.js', () => ({
  generateMediumRemovalInstructions: vi.fn().mockReturnValue({ path: '/tmp/medium.md' }),
}));
vi.mock('../src/core/unpublish/substack.js', () => ({
  generateSubstackRemovalInstructions: vi.fn().mockReturnValue({ path: '/tmp/substack.md' }),
}));
vi.mock('../src/core/unpublish/site.js', () => ({
  createSiteRevertPR: vi.fn().mockReturnValue({
    prNumber: 17, prUrl: 'https://github.com/jmolz/m0lz.00/pull/17', branchName: 'unpublish/a',
  }),
  checkUnpublishPreviewGate: vi.fn().mockReturnValue({ merged: true }),
}));
vi.mock('../src/core/unpublish/readme.js', () => ({
  revertProjectReadmeLink: vi.fn().mockReturnValue({ reverted: true }),
}));

// eslint-disable-next-line import/first
import { closeDatabase, getDatabase } from '../src/core/db/database.js';
// eslint-disable-next-line import/first
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
// eslint-disable-next-line import/first
import { initUnpublish } from '../src/core/unpublish/state.js';
// eslint-disable-next-line import/first
import { runUnpublishPipeline } from '../src/core/unpublish/runner.js';
// eslint-disable-next-line import/first
import { acquirePublishLock } from '../src/core/publish/lock.js';
// eslint-disable-next-line import/first
import { UNPUBLISH_STEP_NAMES } from '../src/core/unpublish/steps-registry.js';
// eslint-disable-next-line import/first
import { BlogConfig } from '../src/core/config/types.js';

interface Fx { tempDir: string; publishDir: string; socialDir: string; configPath: string; db: Database.Database; config: BlogConfig }
let fx: Fx | undefined;

function mkConfig(): BlogConfig {
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
    publish: { devto: true, medium: true, substack: true, github_repos: true, social_drafts: true, research_pages: true },
    social: { platforms: [], timing_recommendations: true },
    evaluation: { require_pass: true, min_sources: 3, max_reading_level: 12, three_reviewer_panel: true, consensus_must_fix: true, majority_should_fix: true, single_advisory: true, verify_benchmark_claims: true, methodology_completeness: true },
    updates: { preserve_original_data: true, update_notice: true, update_crosspost: true, devto_update: true, refresh_paste_files: true, notice_template: 'x', require_summary: true, site_update_mode: 'pr' },
    unpublish: { devto: true, medium: true, substack: true, readme: true },
  };
}

function setup(): Fx {
  const tempDir = mkdtempSync(join(tmpdir(), 'unpub-pipe-'));
  const publishDir = join(tempDir, 'publish');
  const socialDir = join(tempDir, 'social');
  mkdirSync(publishDir, { recursive: true });
  mkdirSync(socialDir, { recursive: true });
  const configPath = join(tempDir, '.blogrc.yaml');
  writeFileSync(configPath, '');
  const db = getDatabase(':memory:');
  fx = { tempDir, publishDir, socialDir, configPath, db, config: mkConfig() };
  return fx;
}

function seedPublishedPost(db: Database.Database, slug: string): void {
  initResearchPost(db, slug, 'topic', 'directed', 'technical-deep-dive');
  advancePhase(db, slug, 'benchmark');
  advancePhase(db, slug, 'draft');
  advancePhase(db, slug, 'evaluate');
  db.prepare('UPDATE posts SET evaluation_passed = 1 WHERE slug = ?').run(slug);
  advancePhase(db, slug, 'publish');
  advancePhase(db, slug, 'published');
}

afterEach(() => {
  if (fx?.db) closeDatabase(fx.db);
  if (fx) rmSync(fx.tempDir, { recursive: true, force: true });
  fx = undefined;
  vi.clearAllMocks();
});

describe('runUnpublishPipeline — happy path E2E', () => {
  it('executes all 7 steps and advances phase to unpublished; metrics event=unpublished written', async () => {
    const f = setup();
    seedPublishedPost(f.db, 'alpha');
    initUnpublish(f.db, 'alpha', f.config);

    const result = await runUnpublishPipeline({
      db: f.db,
      slug: 'alpha',
      config: f.config,
      paths: { configPath: f.configPath, publishDir: f.publishDir, socialDir: f.socialDir },
    });

    expect(result.completed).toBe(true);
    expect(result.stepsRun).toBe(UNPUBLISH_STEP_NAMES.length);
    expect(result.totalSteps).toBe(UNPUBLISH_STEP_NAMES.length);

    // All 7 persisted steps terminal.
    const rows = f.db
      .prepare(`SELECT step_name, status FROM unpublish_steps WHERE post_slug = ? ORDER BY step_number`)
      .all('alpha') as Array<{ step_name: string; status: string }>;
    expect(rows).toHaveLength(UNPUBLISH_STEP_NAMES.length);
    for (const r of rows) {
      expect(['completed', 'skipped']).toContain(r.status);
    }

    // posts.phase advanced + unpublished_at set + 'unpublished' metrics event.
    const post = f.db
      .prepare(`SELECT phase, unpublished_at FROM posts WHERE slug = ?`)
      .get('alpha') as { phase: string; unpublished_at: string | null };
    expect(post.phase).toBe('unpublished');
    expect(post.unpublished_at).not.toBeNull();

    const metricEvents = f.db
      .prepare(`SELECT event FROM metrics WHERE post_slug = ? ORDER BY id`)
      .all('alpha') as Array<{ event: string }>;
    expect(metricEvents.map((m) => m.event)).toEqual(['unpublish_started', 'unpublished']);
  });

  it('shares per-slug lock with publish/update: a held lock causes contention on acquire', () => {
    // Direct test of the lock used by BOTH runUnpublishPipeline and
    // runPipeline (publish) and the update variant. The contract criterion
    // is "mutual exclusion across flows" — proven by (a) all three flows
    // acquiring the same slug-scoped lock helper and (b) a second acquire
    // on a live lock throwing lock-contention. The runner's default 10s
    // timeout makes an end-to-end contention test too slow; using a
    // short timeout here tests the same lock primitive directly.
    const f = setup();
    const release = acquirePublishLock(f.publishDir, 'beta', 10_000);
    try {
      // Second acquire with 100 ms timeout — live PID means reclaim path
      // does not delete, deadline fires, throws with the same message the
      // runner would surface.
      expect(() => acquirePublishLock(f.publishDir, 'beta', 100))
        .toThrow(/Could not acquire publish lock for 'beta'/);
    } finally {
      release();
    }
  });

  it('runUnpublishPipeline goes through acquirePublishLock (trust-boundary proof)', () => {
    // Grep-based check that runner.ts imports from publish/lock.ts so future
    // refactors cannot silently drop the mutual-exclusion guard that
    // publish/update/unpublish share.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const src = readFileSync(
      new URL('../src/core/unpublish/runner.ts', import.meta.url),
      'utf-8',
    );
    expect(src).toMatch(/from ['"]\.\.\/publish\/lock\.js['"]/);
    expect(src).toMatch(/acquirePublishLock\(/);
  });
});

describe('runUnpublishPipeline — failure handling', () => {
  it('stops + marks failed when a step throws; phase stays published', async () => {
    const f = setup();
    seedPublishedPost(f.db, 'fails');
    initUnpublish(f.db, 'fails', f.config);

    // Override the devto mock to throw — the runner should mark the step
    // failed and return completed:false.
    const devtoMod = await import('../src/core/unpublish/devto.js');
    (devtoMod.unpublishFromDevTo as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('dev.to 500'));

    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runUnpublishPipeline({
      db: f.db,
      slug: 'fails',
      config: f.config,
      paths: { configPath: f.configPath, publishDir: f.publishDir, socialDir: f.socialDir },
    });

    expect(result.completed).toBe(false);
    expect(result.failedStep).toBe('devto-unpublish');

    const post = f.db
      .prepare(`SELECT phase FROM posts WHERE slug = ?`)
      .get('fails') as { phase: string };
    expect(post.phase).toBe('published');
  });
});
