import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

// Mock the unpublish step modules so runUnpublishPipeline never hits the
// network/disk — we only care that it contends with publish on the
// shared lock. Mirrors tests/unpublish-pipeline.test.ts's approach.
vi.mock('../src/core/unpublish/devto.js', () => ({
  unpublishFromDevTo: vi.fn().mockResolvedValue({ id: 42, url: 'u' }),
}));
vi.mock('../src/core/unpublish/medium.js', () => ({
  generateMediumRemovalInstructions: vi.fn().mockReturnValue({ path: '/tmp/medium.md' }),
}));
vi.mock('../src/core/unpublish/substack.js', () => ({
  generateSubstackRemovalInstructions: vi.fn().mockReturnValue({ path: '/tmp/substack.md' }),
}));
vi.mock('../src/core/unpublish/site.js', () => ({
  createSiteRevertPR: vi.fn().mockReturnValue({ prNumber: 1, prUrl: 'u', branchName: 'b' }),
  checkUnpublishPreviewGate: vi.fn().mockReturnValue({ merged: true }),
}));
vi.mock('../src/core/unpublish/readme.js', () => ({
  revertProjectReadmeLink: vi.fn().mockReturnValue({ reverted: true }),
}));

// Mock the publish registry so runPipeline uses a test-controlled step
// set. One of the steps blocks on a promise that we control from the
// test, forcing a hold on the publish lock.
let blockResolve: (() => void) | null = null;
const blockStarted = { value: false };
const stepsStore = {
  steps: [
    {
      number: 1,
      name: 'verify',
      execute: async () => ({ outcome: 'completed' as const, message: 'ok' }),
    },
    {
      number: 2,
      name: 'research-page',
      execute: async () => {
        // This step BLOCKS until the test releases. During the block,
        // the publish runner holds the slug-scoped lock. A concurrent
        // unpublish on the same slug will time out trying to acquire it.
        blockStarted.value = true;
        await new Promise<void>((resolve) => { blockResolve = resolve; });
        return { outcome: 'completed' as const, message: 'ok' };
      },
    },
    {
      number: 3,
      name: 'site-pr',
      execute: async () => ({ outcome: 'completed' as const, message: 'ok' }),
    },
    {
      number: 4,
      name: 'preview-gate',
      execute: async () => ({ outcome: 'completed' as const, message: 'ok' }),
    },
    {
      number: 5,
      name: 'crosspost-devto',
      execute: async () => ({ outcome: 'completed' as const, message: 'ok' }),
    },
    {
      number: 6,
      name: 'paste-medium',
      execute: async () => ({ outcome: 'completed' as const, message: 'ok' }),
    },
    {
      number: 7,
      name: 'paste-substack',
      execute: async () => ({ outcome: 'completed' as const, message: 'ok' }),
    },
    {
      number: 8,
      name: 'companion-repo',
      execute: async () => ({ outcome: 'skipped' as const, message: 'skipped' }),
    },
    {
      number: 9,
      name: 'update-frontmatter',
      execute: async () => ({ outcome: 'completed' as const, message: 'ok' }),
    },
    {
      number: 10,
      name: 'update-readme',
      execute: async () => ({ outcome: 'skipped' as const, message: 'skipped' }),
    },
    {
      number: 11,
      name: 'social-text',
      execute: async () => ({ outcome: 'completed' as const, message: 'ok' }),
    },
  ],
};

vi.mock('../src/core/publish/pipeline-registry.js', () => ({
  get PIPELINE_STEPS() {
    return stepsStore.steps;
  },
}));

// eslint-disable-next-line import/first
import { closeDatabase, getDatabase } from '../src/core/db/database.js';
// eslint-disable-next-line import/first
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
// eslint-disable-next-line import/first
import { createPipelineSteps } from '../src/core/publish/steps-crud.js';
// eslint-disable-next-line import/first
import { runPipeline } from '../src/core/publish/pipeline-runner.js';
// eslint-disable-next-line import/first
import { initUnpublish } from '../src/core/unpublish/state.js';
// eslint-disable-next-line import/first
import { runUnpublishPipeline } from '../src/core/unpublish/runner.js';
// eslint-disable-next-line import/first
import { BlogConfig } from '../src/core/config/types.js';

function mkConfig(): BlogConfig {
  return {
    site: { repo_path: '/tmp/site', base_url: 'https://m0lz.dev', content_dir: 'content/posts', research_dir: 'content/research', github_repo: 'jmolz/m0lz.00' },
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

interface Fx { tempDir: string; publishDir: string; configPath: string; socialDir: string; db: Database.Database }
let fx: Fx | undefined;

function setup(): Fx {
  const tempDir = mkdtempSync(join(tmpdir(), 'cross-flow-lock-'));
  const publishDir = join(tempDir, 'publish');
  const socialDir = join(tempDir, 'social');
  mkdirSync(publishDir, { recursive: true });
  mkdirSync(socialDir, { recursive: true });
  const configPath = join(tempDir, '.blogrc.yaml');
  const db = getDatabase(':memory:');
  fx = { tempDir, publishDir, configPath, socialDir, db };
  return fx;
}

function seedPublishPhasePost(db: Database.Database, slug: string): void {
  initResearchPost(db, slug, 'topic', 'directed', 'technical-deep-dive');
  advancePhase(db, slug, 'benchmark');
  advancePhase(db, slug, 'draft');
  advancePhase(db, slug, 'evaluate');
  db.prepare('UPDATE posts SET evaluation_passed = 1 WHERE slug = ?').run(slug);
  advancePhase(db, slug, 'publish');
}

function seedPublishedPost(db: Database.Database, slug: string): void {
  seedPublishPhasePost(db, slug);
  advancePhase(db, slug, 'published');
}

beforeEach(async () => {
  // Re-apply mock implementations for every test so vi.restoreAllMocks
  // in a prior afterEach can't leave stubs returning undefined. The
  // vi.mock() factory runs once at module load; restoring spies erases
  // the mockResolvedValue/mockReturnValue config, so we re-apply here.
  const devto = await import('../src/core/unpublish/devto.js');
  (devto.unpublishFromDevTo as unknown as ReturnType<typeof vi.fn>)
    .mockResolvedValue({ id: 42, url: 'u' });
  const medium = await import('../src/core/unpublish/medium.js');
  (medium.generateMediumRemovalInstructions as unknown as ReturnType<typeof vi.fn>)
    .mockReturnValue({ path: '/tmp/medium.md' });
  const substack = await import('../src/core/unpublish/substack.js');
  (substack.generateSubstackRemovalInstructions as unknown as ReturnType<typeof vi.fn>)
    .mockReturnValue({ path: '/tmp/substack.md' });
  const site = await import('../src/core/unpublish/site.js');
  (site.createSiteRevertPR as unknown as ReturnType<typeof vi.fn>)
    .mockReturnValue({ prNumber: 1, prUrl: 'u', branchName: 'b' });
  (site.checkUnpublishPreviewGate as unknown as ReturnType<typeof vi.fn>)
    .mockReturnValue({ merged: true });
  const readme = await import('../src/core/unpublish/readme.js');
  (readme.revertProjectReadmeLink as unknown as ReturnType<typeof vi.fn>)
    .mockReturnValue({ reverted: true });
});

afterEach(() => {
  if (fx?.db) closeDatabase(fx.db);
  if (fx) rmSync(fx.tempDir, { recursive: true, force: true });
  fx = undefined;
  blockResolve = null;
  blockStarted.value = false;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('cross-flow lock contention (publish ↔ unpublish on same slug)', () => {
  it('publish holding the lock causes a concurrent unpublish start on the SAME slug to fail with contention', async () => {
    const f = setup();
    // Post needs to be BOTH in publish phase (so runPipeline accepts it)
    // AND seeded with unpublish steps for the second flow. Simpler to use
    // two different slugs? No — the whole point is SAME slug. Use one
    // slug, seed publish steps, then also seed unpublish steps; the
    // unpublish runner just attempts to acquire the same lock, which is
    // what we want to prove mutually exclusive.
    //
    // Workflow:
    //   1. Seed 'alpha' in 'publish' phase + pipeline_steps.
    //   2. Start runPipeline (publish) in the background — it blocks on step 2.
    //   3. Once it's holding the lock, advance to 'published' + seed
    //      unpublish_steps + call runUnpublishPipeline with a short
    //      lock timeout by stubbing acquirePublishLock via vi.doMock —
    //      easier: just wait a moment and observe the lockfile exists
    //      under the publish run, then attempt unpublish. The real
    //      runner's 10s timeout would block the test — use the lock
    //      helper directly as the proof surrogate.
    //
    // Actually simpler: fire runPipeline in the background. Once it's
    // holding the lock (blockStarted === true), assert that the lockfile
    // exists at the expected slug path. Then release the block and let
    // publish finish. Parallel to that: mock acquirePublishLock timeout
    // isn't needed — we're proving the publish runner DOES hold the lock
    // for the duration of step execution.
    seedPublishPhasePost(f.db, 'alpha');
    createPipelineSteps(f.db, 'alpha', 'technical-deep-dive', mkConfig(), undefined, 0, 'initial');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const ctx = {
      db: f.db,
      slug: 'alpha',
      config: mkConfig(),
      paths: {
        dbPath: join(f.tempDir, 'state.db'),
        configPath: f.configPath,
        draftsDir: join(f.tempDir, 'drafts'),
        benchmarkDir: join(f.tempDir, 'benchmarks'),
        evaluationsDir: join(f.tempDir, 'evaluations'),
        researchDir: join(f.tempDir, 'research'),
        reposDir: join(f.tempDir, 'repos'),
        socialDir: f.socialDir,
        researchPagesDir: join(f.tempDir, 'research-pages'),
        publishDir: f.publishDir,
        templatesDir: join(f.tempDir, 'templates'),
      },
      urls: {},
      publishMode: 'initial' as const,
      cycleId: 0,
    };

    // Start publish in the background. It'll get to step 2 and block.
    const publishPromise = runPipeline(ctx);

    // Wait until step 2 is executing (polling pattern with a cap).
    const deadline = Date.now() + 2000;
    while (!blockStarted.value && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(blockStarted.value).toBe(true);

    // Assert the lockfile exists at the publish runner's expected path.
    const lockPath = join(f.publishDir, 'alpha', '.publish.lock');
    expect(existsSync(lockPath)).toBe(true);
    // And contains our PID (proof the runner acquired the lock, not a
    // leftover from a crashed prior run).
    const stored = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
    expect(stored).toBe(process.pid);

    // Now attempt a concurrent lock acquire using the same helper the
    // unpublish runner uses. Short timeout => fast failure.
    const { acquirePublishLock } = await import('../src/core/publish/lock.js');
    expect(() => acquirePublishLock(f.publishDir, 'alpha', 100))
      .toThrow(/Could not acquire publish lock for 'alpha'/);

    // Release publish and wait for it to finish cleanly so the lock
    // releases too.
    if (blockResolve) blockResolve();
    const result = await publishPromise;
    expect(result.completed).toBe(true);

    // After release, a new acquire succeeds.
    const release2 = acquirePublishLock(f.publishDir, 'alpha', 500);
    release2();
  });

  it('runUnpublishPipeline(alpha) vs held runPipeline(alpha) — true same-slug cross-flow contention via lockTimeoutMs injection', async () => {
    // Closes Codex Pass 3 Minor #4: Pass 2's test only proved the lock
    // primitive. Pass 3 adds a `lockTimeoutMs` injection seam on both
    // runners so this test can ACTUALLY call runUnpublishPipeline on
    // the same slug while publish holds the lock and assert the runner
    // surfaces contention as a thrown error.
    const f = setup();
    seedPublishPhasePost(f.db, 'samelane');
    createPipelineSteps(f.db, 'samelane', 'technical-deep-dive', mkConfig(), undefined, 0, 'initial');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const publishCtx = {
      db: f.db,
      slug: 'samelane',
      config: mkConfig(),
      paths: {
        dbPath: join(f.tempDir, 'state.db'),
        configPath: f.configPath,
        draftsDir: join(f.tempDir, 'drafts'),
        benchmarkDir: join(f.tempDir, 'benchmarks'),
        evaluationsDir: join(f.tempDir, 'evaluations'),
        researchDir: join(f.tempDir, 'research'),
        reposDir: join(f.tempDir, 'repos'),
        socialDir: f.socialDir,
        researchPagesDir: join(f.tempDir, 'research-pages'),
        publishDir: f.publishDir,
        templatesDir: join(f.tempDir, 'templates'),
      },
      urls: {},
      publishMode: 'initial' as const,
      cycleId: 0,
    };

    const publishPromise = runPipeline(publishCtx);
    const deadline = Date.now() + 2000;
    while (!blockStarted.value && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(blockStarted.value).toBe(true);

    // Seed published state + unpublish steps for the SAME slug so the
    // runUnpublishPipeline call passes its own initUnpublish gate
    // (which we simulate by calling initUnpublish even though phase is
    // actually 'publish' — override the phase via direct UPDATE since
    // the lock test is only about the acquire path, not the step
    // execution below it).
    f.db.prepare(`UPDATE posts SET phase = 'published' WHERE slug = ?`).run('samelane');
    const { initUnpublish } = await import('../src/core/unpublish/state.js');
    initUnpublish(f.db, 'samelane', mkConfig());

    // TRUE cross-flow: call runUnpublishPipeline on the SAME slug with a
    // short lockTimeoutMs. The runner MUST surface the contention as a
    // thrown error (acquirePublishLock throws on timeout).
    await expect(runUnpublishPipeline({
      db: f.db,
      slug: 'samelane',
      config: mkConfig(),
      paths: { configPath: f.configPath, publishDir: f.publishDir, socialDir: f.socialDir },
      lockTimeoutMs: 100,
    })).rejects.toThrow(/Could not acquire publish lock for 'samelane'/);

    // Release publish, verify cleanup; now unpublish can acquire.
    if (blockResolve) blockResolve();
    const publishResult = await publishPromise;
    expect(publishResult.completed).toBe(true);

    // After release, unpublish on the same slug completes cleanly.
    const afterResult = await runUnpublishPipeline({
      db: f.db,
      slug: 'samelane',
      config: mkConfig(),
      paths: { configPath: f.configPath, publishDir: f.publishDir, socialDir: f.socialDir },
      lockTimeoutMs: 500,
    });
    expect(afterResult.completed).toBe(true);
  });

  it('different slugs are NOT contended: publish(alpha) + unpublish(beta) both progress', async () => {
    const f = setup();
    seedPublishPhasePost(f.db, 'alpha');
    createPipelineSteps(f.db, 'alpha', 'technical-deep-dive', mkConfig(), undefined, 0, 'initial');
    seedPublishedPost(f.db, 'beta');
    initUnpublish(f.db, 'beta', mkConfig());

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const ctx = {
      db: f.db,
      slug: 'alpha',
      config: mkConfig(),
      paths: {
        dbPath: join(f.tempDir, 'state.db'),
        configPath: f.configPath,
        draftsDir: join(f.tempDir, 'drafts'),
        benchmarkDir: join(f.tempDir, 'benchmarks'),
        evaluationsDir: join(f.tempDir, 'evaluations'),
        researchDir: join(f.tempDir, 'research'),
        reposDir: join(f.tempDir, 'repos'),
        socialDir: f.socialDir,
        researchPagesDir: join(f.tempDir, 'research-pages'),
        publishDir: f.publishDir,
        templatesDir: join(f.tempDir, 'templates'),
      },
      urls: {},
      publishMode: 'initial' as const,
      cycleId: 0,
    };

    const publishPromise = runPipeline(ctx);

    const deadline = Date.now() + 2000;
    while (!blockStarted.value && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Unpublish on 'beta' should NOT be blocked by publish on 'alpha'.
    // Its lockfile lives at publishDir/beta/.publish.lock — disjoint.
    const unpublishResult = await runUnpublishPipeline({
      db: f.db,
      slug: 'beta',
      config: mkConfig(),
      paths: { configPath: f.configPath, publishDir: f.publishDir, socialDir: f.socialDir },
    });
    expect(unpublishResult.completed).toBe(true);

    if (blockResolve) blockResolve();
    const publishResult = await publishPromise;
    expect(publishResult.completed).toBe(true);
  });
});
