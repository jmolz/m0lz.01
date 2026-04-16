import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

import { closeDatabase, getDatabase } from '../src/core/db/database.js';
import { advancePhase, initResearchPost } from '../src/core/research/state.js';
import {
  createPipelineSteps,
  getPipelineSteps,
  markStepCompleted,
  markStepFailed,
} from '../src/core/publish/steps-crud.js';
import { PUBLISH_STEP_NAMES, PipelineStepRow } from '../src/core/publish/types.js';
import type { PipelineContext, StepDefinition, StepResult } from '../src/core/publish/pipeline-types.js';
import { BlogConfig } from '../src/core/config/types.js';

// Mock the pipeline registry so runPipeline executes whichever step table we
// push in from the mock stash. `vi.mock` is hoisted by vitest ahead of the
// imports below, so the dynamic array lives on a module-level ref we mutate
// per test via a `setSteps(...)` helper.
const mockRegistryState = {
  steps: [] as StepDefinition[],
};

vi.mock('../src/core/publish/pipeline-registry.js', () => ({
  get PIPELINE_STEPS(): StepDefinition[] {
    return mockRegistryState.steps;
  },
}));

// Import AFTER vi.mock so the runner resolves against the stubbed module.
// eslint-disable-next-line import/first
import { runPipeline } from '../src/core/publish/pipeline-runner.js';

function setSteps(steps: StepDefinition[]): void {
  mockRegistryState.steps = steps;
}

function makeConfig(): BlogConfig {
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
  config: BlogConfig;
}

let fixture: Fixture | undefined;

function setup(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'publish-pipeline-'));
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

// Seed a post directly into the publish phase with a passing evaluation.
function seedPublishPost(db: Database.Database, slug: string): void {
  initResearchPost(db, slug, 'topic', 'directed', 'technical-deep-dive');
  advancePhase(db, slug, 'benchmark');
  advancePhase(db, slug, 'draft');
  advancePhase(db, slug, 'evaluate');
  db.prepare('UPDATE posts SET evaluation_passed = 1 WHERE slug = ?').run(slug);
  advancePhase(db, slug, 'publish');
}

// Build a context bound to the fixture. paths.publishDir is the only path
// that matters for these tests (lock placement + completePublish).
function makeContext(f: Fixture, slug: string): PipelineContext {
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
  };
}

// Build 11 step definitions with customizable per-name executors. Names that
// are not overridden fall back to a default completed-outcome step. This lets
// tests target a specific step without repeating boilerplate for the other 10.
function buildRegistry(
  overrides: Partial<Record<(typeof PUBLISH_STEP_NAMES)[number], StepDefinition['execute']>>,
): StepDefinition[] {
  return PUBLISH_STEP_NAMES.map((name, idx) => ({
    number: idx + 1,
    name,
    execute: overrides[name] ?? (async (): Promise<StepResult> => ({ outcome: 'completed', message: `${name} ok` })),
  }));
}

// Capture console output so we can assert messages were emitted without
// polluting test runner output.
function silenceConsole(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  return { logs, errors };
}

describe('runPipeline — ordering', () => {
  it('runs steps in step_number order', async () => {
    const f = setup();
    seedPublishPost(f.db, 'order');
    createPipelineSteps(f.db, 'order', 'technical-deep-dive', f.config);
    silenceConsole();
    const calls: string[] = [];
    setSteps(
      buildRegistry(
        Object.fromEntries(
          PUBLISH_STEP_NAMES.map((name) => [
            name,
            async (): Promise<StepResult> => {
              calls.push(name);
              return { outcome: 'completed', message: 'ok' };
            },
          ]),
        ),
      ),
    );

    const result = await runPipeline(makeContext(f, 'order'));
    expect(result.completed).toBe(true);
    expect(calls).toEqual([...PUBLISH_STEP_NAMES]);
  });
});

describe('runPipeline — resume semantics', () => {
  it('skips already-completed steps on resume', async () => {
    const f = setup();
    seedPublishPost(f.db, 'resume');
    createPipelineSteps(f.db, 'resume', 'technical-deep-dive', f.config);
    // Pre-mark step 1 completed so the runner skips it.
    markStepCompleted(f.db, 'resume', 'verify');
    silenceConsole();
    const calls: string[] = [];
    setSteps(
      buildRegistry({
        verify: () => {
          calls.push('verify');
          return { outcome: 'completed', message: 'should not run' };
        },
      }),
    );

    await runPipeline(makeContext(f, 'resume'));
    expect(calls).not.toContain('verify');
  });

  it('re-runs failed steps on resume', async () => {
    const f = setup();
    seedPublishPost(f.db, 'retry');
    createPipelineSteps(f.db, 'retry', 'technical-deep-dive', f.config);
    // Mark step 1 failed so the runner retries it.
    markStepFailed(f.db, 'retry', 'verify', 'earlier failure');
    silenceConsole();
    const calls: string[] = [];
    setSteps(
      buildRegistry({
        verify: () => {
          calls.push('verify');
          return { outcome: 'completed', message: 'retry ok' };
        },
      }),
    );

    await runPipeline(makeContext(f, 'retry'));
    expect(calls[0]).toBe('verify');
    // After retry, step is completed.
    const row = getPipelineSteps(f.db, 'retry').find((r: PipelineStepRow) => r.step_name === 'verify')!;
    expect(row.status).toBe('completed');
  });
});

describe('runPipeline — failure handling', () => {
  it('stops on {outcome: failed}, marks step failed with the returned message', async () => {
    const f = setup();
    seedPublishPost(f.db, 'fail');
    createPipelineSteps(f.db, 'fail', 'technical-deep-dive', f.config);
    silenceConsole();
    setSteps(
      buildRegistry({
        'research-page': () => ({ outcome: 'failed', message: 'boom' }),
      }),
    );

    const result = await runPipeline(makeContext(f, 'fail'));
    expect(result.completed).toBe(false);
    expect(result.failedStep).toBe('research-page');

    const row = getPipelineSteps(f.db, 'fail').find((r) => r.step_name === 'research-page')!;
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('boom');
    // Downstream steps were never reached.
    const sitePr = getPipelineSteps(f.db, 'fail').find((r) => r.step_name === 'site-pr')!;
    expect(sitePr.status).toBe('pending');
  });

  it('stops on a thrown exception, marks step failed with the exception message', async () => {
    const f = setup();
    seedPublishPost(f.db, 'throw');
    createPipelineSteps(f.db, 'throw', 'technical-deep-dive', f.config);
    silenceConsole();
    setSteps(
      buildRegistry({
        'research-page': () => {
          throw new Error('kaboom');
        },
      }),
    );

    const result = await runPipeline(makeContext(f, 'throw'));
    expect(result.completed).toBe(false);
    expect(result.failedStep).toBe('research-page');
    const row = getPipelineSteps(f.db, 'throw').find((r) => r.step_name === 'research-page')!;
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('kaboom');
  });
});

describe('runPipeline — pause handling', () => {
  it('stops on paused outcome, leaves step pending with started_at null', async () => {
    const f = setup();
    seedPublishPost(f.db, 'pause');
    createPipelineSteps(f.db, 'pause', 'technical-deep-dive', f.config);
    silenceConsole();
    setSteps(
      buildRegistry({
        'research-page': () => ({ outcome: 'paused', message: 'waiting for PR merge' }),
      }),
    );

    const result = await runPipeline(makeContext(f, 'pause'));
    expect(result.completed).toBe(false);
    expect(result.pausedStep).toBe('research-page');

    const row = getPipelineSteps(f.db, 'pause').find((r) => r.step_name === 'research-page')!;
    // A paused step is reverted to pending so the next runPipeline picks it up.
    expect(row.status).toBe('pending');
    expect(row.started_at).toBeNull();
  });
});

describe('runPipeline — URL propagation', () => {
  it('merges urlUpdates from a completed step into ctx.urls', async () => {
    const f = setup();
    seedPublishPost(f.db, 'urls');
    createPipelineSteps(f.db, 'urls', 'technical-deep-dive', f.config);
    silenceConsole();
    const ctx = makeContext(f, 'urls');
    setSteps(
      buildRegistry({
        'research-page': () => ({
          outcome: 'completed',
          message: 'ok',
          urlUpdates: { devto_url: 'https://dev.to/example' },
        }),
      }),
    );

    await runPipeline(ctx);
    expect(ctx.urls.devto_url).toBe('https://dev.to/example');
  });

  it('subsequent steps see accumulated URLs on ctx.urls', async () => {
    const f = setup();
    seedPublishPost(f.db, 'accum');
    createPipelineSteps(f.db, 'accum', 'technical-deep-dive', f.config);
    silenceConsole();
    const ctx = makeContext(f, 'accum');
    let seenDevtoUrl: string | undefined;
    setSteps(
      buildRegistry({
        'research-page': () => ({
          outcome: 'completed',
          message: 'writes url',
          urlUpdates: { devto_url: 'https://dev.to/seed' },
        }),
        'site-pr': (inner) => {
          seenDevtoUrl = inner.urls.devto_url;
          return { outcome: 'completed', message: 'reads url' };
        },
      }),
    );

    await runPipeline(ctx);
    expect(seenDevtoUrl).toBe('https://dev.to/seed');
  });
});

describe('runPipeline — completion + phase transition', () => {
  it('calls completePublish and advances phase to published when all steps reach a terminal state', async () => {
    const f = setup();
    seedPublishPost(f.db, 'finish');
    createPipelineSteps(f.db, 'finish', 'technical-deep-dive', f.config);
    silenceConsole();
    setSteps(buildRegistry({}));
    const result = await runPipeline(makeContext(f, 'finish'));
    expect(result.completed).toBe(true);
    const post = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get('finish') as { phase: string };
    expect(post.phase).toBe('published');
  });

  it('does NOT call completePublish on failure — phase stays publish', async () => {
    const f = setup();
    seedPublishPost(f.db, 'fail-no-advance');
    createPipelineSteps(f.db, 'fail-no-advance', 'technical-deep-dive', f.config);
    silenceConsole();
    setSteps(
      buildRegistry({
        verify: () => ({ outcome: 'failed', message: 'nope' }),
      }),
    );
    const result = await runPipeline(makeContext(f, 'fail-no-advance'));
    expect(result.completed).toBe(false);
    const post = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get('fail-no-advance') as { phase: string };
    expect(post.phase).toBe('publish');
  });

  it('does NOT call completePublish on pause — phase stays publish', async () => {
    const f = setup();
    seedPublishPost(f.db, 'pause-no-advance');
    createPipelineSteps(f.db, 'pause-no-advance', 'technical-deep-dive', f.config);
    silenceConsole();
    setSteps(
      buildRegistry({
        verify: () => ({ outcome: 'paused', message: 'hold' }),
      }),
    );
    const result = await runPipeline(makeContext(f, 'pause-no-advance'));
    expect(result.completed).toBe(false);
    const post = f.db.prepare('SELECT phase FROM posts WHERE slug = ?').get('pause-no-advance') as { phase: string };
    expect(post.phase).toBe('publish');
  });
});

describe('runPipeline — lock + result shape', () => {
  it('releases the FS lock after success — a subsequent acquire does not block', async () => {
    const f = setup();
    seedPublishPost(f.db, 'lockrelease-ok');
    createPipelineSteps(f.db, 'lockrelease-ok', 'technical-deep-dive', f.config);
    silenceConsole();
    setSteps(buildRegistry({}));
    await runPipeline(makeContext(f, 'lockrelease-ok'));
    // After runPipeline, the lock should be released. Another synchronous
    // acquire with a short timeout must succeed (not throw).
    const { acquirePublishLock } = await import('../src/core/publish/lock.js');
    const release = acquirePublishLock(f.publishDir, 'lockrelease-ok', 200);
    release();
  });

  it('releases the FS lock after failure path as well', async () => {
    const f = setup();
    seedPublishPost(f.db, 'lockrelease-fail');
    createPipelineSteps(f.db, 'lockrelease-fail', 'technical-deep-dive', f.config);
    silenceConsole();
    setSteps(
      buildRegistry({
        verify: () => ({ outcome: 'failed', message: 'drop me' }),
      }),
    );
    await runPipeline(makeContext(f, 'lockrelease-fail'));
    const { acquirePublishLock } = await import('../src/core/publish/lock.js');
    const release = acquirePublishLock(f.publishDir, 'lockrelease-fail', 200);
    release();
  });

  it('returns { completed: true, stepsRun: 11 } on a full run', async () => {
    const f = setup();
    seedPublishPost(f.db, 'full');
    createPipelineSteps(f.db, 'full', 'technical-deep-dive', f.config);
    silenceConsole();
    setSteps(buildRegistry({}));
    const result = await runPipeline(makeContext(f, 'full'));
    expect(result).toEqual({ completed: true, stepsRun: 11, totalSteps: 11 });
  });

  it('returns { completed: false, failedStep: "research-page" } on a step failure', async () => {
    const f = setup();
    seedPublishPost(f.db, 'short');
    createPipelineSteps(f.db, 'short', 'technical-deep-dive', f.config);
    silenceConsole();
    setSteps(
      buildRegistry({
        'research-page': () => ({ outcome: 'failed', message: 'stop' }),
      }),
    );
    const result = await runPipeline(makeContext(f, 'short'));
    expect(result.completed).toBe(false);
    expect(result.failedStep).toBe('research-page');
    // stepsRun counts steps that reached a terminal state; step 1 (verify) succeeded.
    expect(result.stepsRun).toBe(1);
    expect(result.totalSteps).toBe(11);
  });
});

describe('runPipeline — empty / stuck states', () => {
  it('with zero pipeline_steps rows seeded, returns { completed: false } and logs a warning', async () => {
    const f = setup();
    seedPublishPost(f.db, 'empty');
    // Intentionally do NOT createPipelineSteps — the table is empty.
    const captured = silenceConsole();
    setSteps(buildRegistry({}));
    const result = await runPipeline(makeContext(f, 'empty'));
    expect(result.completed).toBe(false);
    // The defensive branch at the bottom of runPipeline logs a warning about
    // no pending steps + incomplete pipeline.
    expect(captured.errors.some((line) => line.includes('no pending steps but is not fully complete'))).toBe(true);
  });
});
