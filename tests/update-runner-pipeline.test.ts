import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

import { closeDatabase, getDatabase } from '../src/core/db/database.js';
import { advancePhase, initResearchPost } from '../src/core/research/state.js';
import { createPipelineSteps } from '../src/core/publish/steps-crud.js';
import { UPDATE_STEP_NAMES } from '../src/core/publish/types.js';
import { openUpdateCycle } from '../src/core/update/cycles.js';
import type { PipelineContext, StepDefinition, StepResult } from '../src/core/publish/pipeline-types.js';
import { BlogConfig } from '../src/core/config/types.js';

// Swap the pipeline registry for a test-controlled step table keyed on
// update-mode names. Same pattern publish-pipeline.test.ts uses; here the
// step set must exactly match UPDATE_STEP_NAMES because the runner's
// dispatch finds step definitions by name, and createPipelineSteps seeds
// rows keyed on UPDATE_STEP_NAMES in update mode.
const mockRegistryState = {
  steps: [] as StepDefinition[],
};

vi.mock('../src/core/publish/pipeline-registry.js', () => ({
  get PIPELINE_STEPS(): StepDefinition[] {
    return mockRegistryState.steps;
  },
}));

// eslint-disable-next-line import/first
import { runPipeline } from '../src/core/publish/pipeline-runner.js';

function setSteps(steps: StepDefinition[]): void {
  mockRegistryState.steps = steps;
}

function makeConfig(): BlogConfig {
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

interface Fixture {
  tempDir: string;
  publishDir: string;
  db: Database.Database;
  config: BlogConfig;
}

let fixture: Fixture | undefined;

function setup(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'update-runner-'));
  const publishDir = join(tempDir, 'publish');
  mkdirSync(publishDir, { recursive: true });
  const db = getDatabase(':memory:');
  fixture = { tempDir, publishDir, db, config: makeConfig() };
  return fixture;
}

afterEach(() => {
  if (fixture?.db) closeDatabase(fixture.db);
  if (fixture) rmSync(fixture.tempDir, { recursive: true, force: true });
  fixture = undefined;
  setSteps([]);
  vi.restoreAllMocks();
});

function seedPublishedPost(db: Database.Database, slug: string): void {
  initResearchPost(db, slug, 'topic', 'directed', 'technical-deep-dive');
  advancePhase(db, slug, 'benchmark');
  advancePhase(db, slug, 'draft');
  advancePhase(db, slug, 'evaluate');
  db.prepare('UPDATE posts SET evaluation_passed = 1 WHERE slug = ?').run(slug);
  advancePhase(db, slug, 'publish');
  advancePhase(db, slug, 'published');
}

function makeContext(f: Fixture, slug: string, cycleId: number): PipelineContext {
  return {
    db: f.db,
    slug,
    config: f.config,
    paths: {
      dbPath: join(f.tempDir, 'state.db'),
      configPath: join(f.tempDir, '.blogrc.yaml'),
      draftsDir: join(f.tempDir, 'drafts'),
      benchmarkDir: join(f.tempDir, 'benchmarks'),
      evaluationsDir: join(f.tempDir, 'evaluations'),
      researchDir: join(f.tempDir, 'research'),
      reposDir: join(f.tempDir, 'repos'),
      socialDir: join(f.tempDir, 'social'),
      researchPagesDir: join(f.tempDir, 'research-pages'),
      publishDir: f.publishDir,
      templatesDir: join(f.tempDir, 'templates'),
    },
    urls: {},
    publishMode: 'update',
    cycleId,
  };
}

// Build an UPDATE_STEP_NAMES-sized step registry where every step returns
// a completed outcome. Overrides let individual tests inject behavior
// (URL updates, pauses, failures) without repeating the 9-entry
// boilerplate.
function buildUpdateRegistry(
  overrides: Partial<Record<(typeof UPDATE_STEP_NAMES)[number], StepDefinition['execute']>>,
): StepDefinition[] {
  return UPDATE_STEP_NAMES.map((name, idx) => ({
    number: idx + 1,
    name,
    execute: overrides[name] ?? (async (): Promise<StepResult> => ({ outcome: 'completed', message: `${name} ok` })),
  }));
}

function silenceConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('runPipeline — update mode (E2E via shared runner)', () => {
  it('runs every UPDATE_STEP_NAMES step in order, finalizes via completeUpdateUnderLock, phase stays published, emits update_completed metric', async () => {
    const f = setup();
    seedPublishedPost(f.db, 'alpha');
    const { id: cycleId } = openUpdateCycle(f.db, 'alpha', 'summary');

    // Seed pipeline_steps for the update cycle. Same codepath
    // runUpdatePublish uses; testing the runner end-to-end means
    // exercising the real seeding + the real step table.
    createPipelineSteps(f.db, 'alpha', 'technical-deep-dive', f.config, undefined, cycleId, 'update');

    setSteps(buildUpdateRegistry({
      'site-update': async (): Promise<StepResult> => ({
        outcome: 'completed',
        message: 'site PR opened',
        urlUpdates: { site_url: 'https://m0lz.dev/writing/alpha' },
      }),
      'crosspost-devto': async (): Promise<StepResult> => ({
        outcome: 'completed',
        message: 'dev.to PUT',
        urlUpdates: { devto_url: 'https://dev.to/u/alpha' },
      }),
    }));

    silenceConsole();

    const result = await runPipeline(makeContext(f, 'alpha', cycleId));
    expect(result.completed).toBe(true);
    expect(result.stepsRun).toBe(UPDATE_STEP_NAMES.length);
    expect(result.totalSteps).toBe(UPDATE_STEP_NAMES.length);

    // Every pipeline_steps row for this cycle is terminal.
    const rows = f.db
      .prepare(`SELECT step_name, status FROM pipeline_steps WHERE post_slug = ? AND cycle_id = ? ORDER BY step_number`)
      .all('alpha', cycleId) as Array<{ step_name: string; status: string }>;
    expect(rows.map((r) => r.step_name)).toEqual([...UPDATE_STEP_NAMES]);
    for (const r of rows) {
      expect(['completed', 'skipped']).toContain(r.status);
    }

    // update_cycles row closed with ended_reason='completed'.
    const cycleRow = f.db
      .prepare(`SELECT closed_at, ended_reason FROM update_cycles WHERE id = ?`)
      .get(cycleId) as { closed_at: string | null; ended_reason: string | null };
    expect(cycleRow.closed_at).not.toBeNull();
    expect(cycleRow.ended_reason).toBe('completed');

    // posts row: phase stays 'published', update_count incremented,
    // last_updated_at set, URLs persisted from step urlUpdates.
    const post = f.db
      .prepare(`SELECT phase, update_count, last_updated_at, site_url, devto_url FROM posts WHERE slug = ?`)
      .get('alpha') as {
      phase: string;
      update_count: number;
      last_updated_at: string | null;
      site_url: string | null;
      devto_url: string | null;
    };
    expect(post.phase).toBe('published');
    expect(post.update_count).toBe(1);
    expect(post.last_updated_at).not.toBeNull();
    expect(post.site_url).toBe('https://m0lz.dev/writing/alpha');
    expect(post.devto_url).toBe('https://dev.to/u/alpha');

    // Metrics row for update_completed present with value=cycleId.
    const metricEvents = f.db
      .prepare(`SELECT event, value FROM metrics WHERE post_slug = ? ORDER BY id`)
      .all('alpha') as Array<{ event: string; value: string | null }>;
    const events = metricEvents.map((m) => m.event);
    expect(events).toContain('update_opened');
    expect(events).toContain('update_completed');
    const completed = metricEvents.find((m) => m.event === 'update_completed');
    expect(completed?.value).toBe(String(cycleId));
  });

  it('preserves cycle_id on every pipeline_steps row (no cycle_id=0 leakage in update mode)', async () => {
    const f = setup();
    seedPublishedPost(f.db, 'cycled');
    const { id: cycleId } = openUpdateCycle(f.db, 'cycled', 'summary');
    createPipelineSteps(f.db, 'cycled', 'technical-deep-dive', f.config, undefined, cycleId, 'update');

    setSteps(buildUpdateRegistry({}));
    silenceConsole();

    await runPipeline(makeContext(f, 'cycled', cycleId));

    const rows = f.db
      .prepare(`SELECT DISTINCT cycle_id FROM pipeline_steps WHERE post_slug = ?`)
      .all('cycled') as Array<{ cycle_id: number }>;
    expect(rows.map((r) => r.cycle_id)).toEqual([cycleId]);
    // No row with cycle_id=0 — initial-publish rows don't leak into update cycle.
  });

  it('pause/resume under update mode: paused step reverts to pending, re-run picks up from there', async () => {
    const f = setup();
    seedPublishedPost(f.db, 'paused-update');
    const { id: cycleId } = openUpdateCycle(f.db, 'paused-update', 'summary');
    createPipelineSteps(f.db, 'paused-update', 'technical-deep-dive', f.config, undefined, cycleId, 'update');

    let previewGateCalls = 0;
    setSteps(buildUpdateRegistry({
      'preview-gate': async (): Promise<StepResult> => {
        previewGateCalls += 1;
        // First invocation pauses (PR not merged). Second completes.
        if (previewGateCalls === 1) {
          return { outcome: 'paused', message: 'PR not merged yet' };
        }
        return { outcome: 'completed', message: 'PR merged' };
      },
    }));

    silenceConsole();

    const first = await runPipeline(makeContext(f, 'paused-update', cycleId));
    expect(first.completed).toBe(false);
    expect(first.pausedStep).toBe('preview-gate');

    // Second run should complete.
    const second = await runPipeline(makeContext(f, 'paused-update', cycleId));
    expect(second.completed).toBe(true);
    expect(previewGateCalls).toBe(2);

    // Cycle still closed + phase still published.
    const cycleRow = f.db
      .prepare(`SELECT closed_at FROM update_cycles WHERE id = ?`)
      .get(cycleId) as { closed_at: string | null };
    expect(cycleRow.closed_at).not.toBeNull();

    const post = f.db
      .prepare(`SELECT phase FROM posts WHERE slug = ?`)
      .get('paused-update') as { phase: string };
    expect(post.phase).toBe('published');
  });
});
