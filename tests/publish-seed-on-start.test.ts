import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock the pipeline runner so tests exercise only the seed-on-start path
// without needing a full fake site repo / gh CLI.
const { mockRunPipeline } = vi.hoisted(() => ({ mockRunPipeline: vi.fn() }));
vi.mock('../src/core/publish/pipeline-runner.js', () => ({
  runPipeline: mockRunPipeline,
}));

// eslint-disable-next-line import/first
import { closeDatabase, getDatabase } from '../src/core/db/database.js';
// eslint-disable-next-line import/first
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
// eslint-disable-next-line import/first
import { getPipelineSteps } from '../src/core/publish/steps-crud.js';
// eslint-disable-next-line import/first
import { runPublishStart, PublishCliPaths } from '../src/cli/publish.js';

interface Fixture {
  tempDir: string;
  dbPath: string;
  configPath: string;
  paths: PublishCliPaths;
}

let fixture: Fixture | undefined;

const CONFIG_YAML = `site:
  repo_path: "./site"
  base_url: "https://m0lz.dev"
  content_dir: "content/posts"
  research_dir: "content/research"
author:
  name: "Tester"
  github: "jmolz"
`;

function setup(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'publish-seed-'));
  const dbPath = join(tempDir, 'state.db');
  const configPath = join(tempDir, '.blogrc.yaml');

  const db = getDatabase(dbPath);
  closeDatabase(db);
  writeFileSync(configPath, CONFIG_YAML);
  mkdirSync(join(tempDir, 'publish'), { recursive: true });

  fixture = {
    tempDir,
    dbPath,
    configPath,
    paths: {
      dbPath,
      configPath,
      draftsDir: join(tempDir, 'drafts'),
      benchmarkDir: join(tempDir, 'benchmarks'),
      evaluationsDir: join(tempDir, 'evaluations'),
      researchDir: join(tempDir, 'research'),
      reposDir: join(tempDir, 'repos'),
      socialDir: join(tempDir, 'social'),
      researchPagesDir: join(tempDir, 'research-pages'),
      publishDir: join(tempDir, 'publish'),
      templatesDir: join(tempDir, 'templates'),
    },
  };
  return fixture;
}

afterEach(() => {
  if (fixture) {
    rmSync(fixture.tempDir, { recursive: true, force: true });
    fixture = undefined;
  }
  process.exitCode = 0;
  mockRunPipeline.mockReset();
  vi.restoreAllMocks();
});

function captureLogs(): { logs: string[]; errors: string[] } {
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

// Drive a post into phase=publish WITHOUT running `blog evaluate complete`'s
// seeding path — matches the production bug where completeEvaluation
// advanced the phase but never seeded pipeline_steps. Uses raw DB
// mutations to reach the zero-rows-at-phase-publish state.
function seedUnseededPublishPost(dbPath: string, slug: string): void {
  const db = getDatabase(dbPath);
  try {
    initResearchPost(db, slug, 'topic', 'directed', 'technical-deep-dive');
    advancePhase(db, slug, 'benchmark');
    advancePhase(db, slug, 'draft');
    advancePhase(db, slug, 'evaluate');
    db.prepare('UPDATE posts SET evaluation_passed = 1 WHERE slug = ?').run(slug);
    advancePhase(db, slug, 'publish');
  } finally {
    closeDatabase(db);
  }
}

describe('runPublishStart seeds pipeline_steps on phase=publish', () => {
  it('seeds 11 rows when phase=publish and pipeline_steps is empty', async () => {
    const f = setup();
    seedUnseededPublishPost(f.dbPath, 'alpha');

    // Verify the precondition: zero rows before the call.
    {
      const db = getDatabase(f.dbPath);
      try {
        expect(getPipelineSteps(db, 'alpha').length).toBe(0);
      } finally {
        closeDatabase(db);
      }
    }

    mockRunPipeline.mockResolvedValue({
      completed: false,
      stepsRun: 0,
      totalSteps: 11,
      pausedStep: 'preview-gate',
    });
    const { logs } = captureLogs();

    await runPublishStart('alpha', f.paths);

    const db = getDatabase(f.dbPath);
    try {
      const steps = getPipelineSteps(db, 'alpha');
      expect(steps.length).toBe(11);
    } finally {
      closeDatabase(db);
    }
    expect(logs.some((l) => /seeded \d+ pipeline_steps for alpha/.test(l))).toBe(true);
    expect(process.exitCode).not.toBe(1);
  });

  it('is idempotent: second call does not add rows or re-log seeded count', async () => {
    const f = setup();
    seedUnseededPublishPost(f.dbPath, 'beta');

    mockRunPipeline.mockResolvedValue({
      completed: false,
      stepsRun: 0,
      totalSteps: 11,
      pausedStep: 'preview-gate',
    });
    captureLogs();

    await runPublishStart('beta', f.paths);

    const db = getDatabase(f.dbPath);
    const firstCount = getPipelineSteps(db, 'beta').length;
    closeDatabase(db);
    expect(firstCount).toBe(11);

    // Second invocation — phase is already `publish`, rows already exist.
    const { logs: secondLogs } = captureLogs();
    await runPublishStart('beta', f.paths);

    const db2 = getDatabase(f.dbPath);
    try {
      expect(getPipelineSteps(db2, 'beta').length).toBe(11);
    } finally {
      closeDatabase(db2);
    }
    // No fresh seed log on the idempotent re-run (countBefore === countAfter).
    expect(secondLogs.some((l) => /seeded \d+ pipeline_steps/.test(l))).toBe(false);
  });

  it('works on phase=evaluate (original path) too — promotes + seeds', async () => {
    const f = setup();
    const db = getDatabase(f.dbPath);
    try {
      initResearchPost(db, 'gamma', 'topic', 'directed', 'technical-deep-dive');
      advancePhase(db, 'gamma', 'benchmark');
      advancePhase(db, 'gamma', 'draft');
      advancePhase(db, 'gamma', 'evaluate');
      db.prepare('UPDATE posts SET evaluation_passed = 1 WHERE slug = ?').run('gamma');
    } finally {
      closeDatabase(db);
    }

    mockRunPipeline.mockResolvedValue({
      completed: false,
      stepsRun: 0,
      totalSteps: 11,
      pausedStep: 'preview-gate',
    });
    captureLogs();

    await runPublishStart('gamma', f.paths);

    const db2 = getDatabase(f.dbPath);
    try {
      const post = db2.prepare('SELECT phase FROM posts WHERE slug = ?').get('gamma') as {
        phase: string;
      };
      expect(post.phase).toBe('publish');
      expect(getPipelineSteps(db2, 'gamma').length).toBe(11);
    } finally {
      closeDatabase(db2);
    }
  });

  it('rejects phase=published with actionable error', async () => {
    const f = setup();
    const db = getDatabase(f.dbPath);
    try {
      initResearchPost(db, 'delta', 'topic', 'directed', 'technical-deep-dive');
      advancePhase(db, 'delta', 'benchmark');
      advancePhase(db, 'delta', 'draft');
      advancePhase(db, 'delta', 'evaluate');
      db.prepare('UPDATE posts SET evaluation_passed = 1 WHERE slug = ?').run('delta');
      advancePhase(db, 'delta', 'publish');
      advancePhase(db, 'delta', 'published');
    } finally {
      closeDatabase(db);
    }

    const { errors } = captureLogs();
    await runPublishStart('delta', f.paths);

    expect(process.exitCode).toBe(1);
    const combined = errors.join('\n');
    expect(combined).toContain('delta');
    expect(combined).toContain('already published');
    // The pipeline runner should NOT have been invoked.
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });
});
