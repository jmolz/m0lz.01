import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { initResearchPost } from '../src/core/research/state.js';
import { writeResearchDocument, ResearchDocument } from '../src/core/research/document.js';
import {
  getBenchmarkPost,
  getBenchmarkRequirement,
  initBenchmark,
  skipBenchmark,
  createBenchmarkRun,
  updateBenchmarkStatus,
  listBenchmarkRuns,
  completeBenchmark,
} from '../src/core/benchmark/state.js';
import { BlogConfig } from '../src/core/config/types.js';

let tempDir: string | undefined;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'bench-state-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function createResearchPost(
  dbPath: string,
  researchDir: string,
  slug: string,
  benchmarkTargets: string = '- Target A\n- Target B',
): void {
  const db = getDatabase(dbPath);
  try {
    initResearchPost(db, slug, 'test topic', 'directed', 'technical-deep-dive');
  } finally {
    closeDatabase(db);
  }
  mkdirSync(researchDir, { recursive: true });
  const doc: ResearchDocument = {
    slug,
    topic: 'test topic',
    mode: 'directed',
    content_type: 'technical-deep-dive',
    created_at: new Date().toISOString(),
    thesis: 'Test thesis',
    findings: 'Test findings',
    sources_list: 'Test sources',
    data_points: 'Test data',
    open_questions: 'Test questions',
    benchmark_targets: benchmarkTargets,
    repo_scope: 'Test scope',
  };
  writeResearchDocument(researchDir, doc, { force: true });
}

function makeConfig(): BlogConfig {
  return {
    site: { repo_path: '/tmp/site', base_url: 'https://m0lz.dev', content_dir: 'content/posts' },
    author: { name: 'Tester', github: 'tester' },
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

describe('initBenchmark', () => {
  it('transitions research post to benchmark and returns parsed targets', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const benchmarkDir = join(dir, 'benchmarks');
    const researchDir = join(dir, 'research');

    createResearchPost(dbPath, researchDir, 'alpha');

    const db = getDatabase(dbPath);
    try {
      const result = initBenchmark(db, 'alpha', benchmarkDir, researchDir);
      expect(result.targets).toEqual(['Target A', 'Target B']);
      expect(result.benchmarkPath).toContain('alpha');

      const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get('alpha') as { phase: string };
      expect(post.phase).toBe('benchmark');
    } finally {
      closeDatabase(db);
    }
  });

  it('throws for non-research post', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const benchmarkDir = join(dir, 'benchmarks');
    const researchDir = join(dir, 'research');

    createResearchPost(dbPath, researchDir, 'beta');

    const db = getDatabase(dbPath);
    try {
      db.prepare("UPDATE posts SET phase = 'draft' WHERE slug = 'beta'").run();
      expect(() => initBenchmark(db, 'beta', benchmarkDir, researchDir)).toThrow(/not 'research'/);
    } finally {
      closeDatabase(db);
    }
  });

  it('throws for missing post', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const db = getDatabase(dbPath);
    try {
      expect(() => initBenchmark(db, 'nonexistent', join(dir, 'b'), join(dir, 'r'))).toThrow(/not found/);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('getBenchmarkPost', () => {
  it('returns post in benchmark phase', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const researchDir = join(dir, 'research');
    const benchmarkDir = join(dir, 'benchmarks');

    createResearchPost(dbPath, researchDir, 'gamma');

    const db = getDatabase(dbPath);
    try {
      initBenchmark(db, 'gamma', benchmarkDir, researchDir);
      const post = getBenchmarkPost(db, 'gamma');
      expect(post).toBeDefined();
      expect(post!.phase).toBe('benchmark');
    } finally {
      closeDatabase(db);
    }
  });

  it('returns undefined for missing slug', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const db = getDatabase(dbPath);
    try {
      expect(getBenchmarkPost(db, 'missing')).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  it('throws for non-benchmark phase', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const researchDir = join(dir, 'research');

    createResearchPost(dbPath, researchDir, 'delta');

    const db = getDatabase(dbPath);
    try {
      expect(() => getBenchmarkPost(db, 'delta')).toThrow(/not 'benchmark'/);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('skipBenchmark', () => {
  it('transitions research post to draft with has_benchmarks=0', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const researchDir = join(dir, 'research');

    createResearchPost(dbPath, researchDir, 'epsilon');

    const db = getDatabase(dbPath);
    try {
      skipBenchmark(db, 'epsilon');
      const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get('epsilon') as {
        phase: string; has_benchmarks: number;
      };
      expect(post.phase).toBe('draft');
      expect(post.has_benchmarks).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('throws for non-research post', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const researchDir = join(dir, 'research');

    createResearchPost(dbPath, researchDir, 'zeta');

    const db = getDatabase(dbPath);
    try {
      db.prepare("UPDATE posts SET phase = 'benchmark' WHERE slug = 'zeta'").run();
      expect(() => skipBenchmark(db, 'zeta')).toThrow(/not 'research'/);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('createBenchmarkRun and updateBenchmarkStatus', () => {
  it('inserts row with pending status', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const researchDir = join(dir, 'research');
    const benchmarkDir = join(dir, 'benchmarks');

    createResearchPost(dbPath, researchDir, 'eta');

    const db = getDatabase(dbPath);
    try {
      initBenchmark(db, 'eta', benchmarkDir, researchDir);
      const runId = createBenchmarkRun(db, 'eta', '{}', '/tmp/results.json');
      expect(runId).toBeGreaterThan(0);

      const row = db.prepare('SELECT * FROM benchmarks WHERE id = ?').get(runId) as { status: string };
      expect(row.status).toBe('pending');
    } finally {
      closeDatabase(db);
    }
  });

  it('transitions pending -> running -> completed', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const researchDir = join(dir, 'research');
    const benchmarkDir = join(dir, 'benchmarks');

    createResearchPost(dbPath, researchDir, 'theta');

    const db = getDatabase(dbPath);
    try {
      initBenchmark(db, 'theta', benchmarkDir, researchDir);
      const runId = createBenchmarkRun(db, 'theta', '{}', '/tmp/results.json');

      updateBenchmarkStatus(db, runId, 'running');
      let row = db.prepare('SELECT * FROM benchmarks WHERE id = ?').get(runId) as { status: string };
      expect(row.status).toBe('running');

      updateBenchmarkStatus(db, runId, 'completed');
      row = db.prepare('SELECT * FROM benchmarks WHERE id = ?').get(runId) as { status: string };
      expect(row.status).toBe('completed');
    } finally {
      closeDatabase(db);
    }
  });
});

describe('listBenchmarkRuns', () => {
  it('returns runs in insertion order', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const researchDir = join(dir, 'research');
    const benchmarkDir = join(dir, 'benchmarks');

    createResearchPost(dbPath, researchDir, 'iota');

    const db = getDatabase(dbPath);
    try {
      initBenchmark(db, 'iota', benchmarkDir, researchDir);
      createBenchmarkRun(db, 'iota', '{"run":1}', '/tmp/r1.json');
      createBenchmarkRun(db, 'iota', '{"run":2}', '/tmp/r2.json');

      const runs = listBenchmarkRuns(db, 'iota');
      expect(runs).toHaveLength(2);
      expect(runs[0].id).toBeLessThan(runs[1].id);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('completeBenchmark', () => {
  it('sets has_benchmarks=1 and advances to draft', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const researchDir = join(dir, 'research');
    const benchmarkDir = join(dir, 'benchmarks');

    createResearchPost(dbPath, researchDir, 'kappa');

    const db = getDatabase(dbPath);
    try {
      initBenchmark(db, 'kappa', benchmarkDir, researchDir);
      completeBenchmark(db, 'kappa');

      const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get('kappa') as {
        phase: string; has_benchmarks: number;
      };
      expect(post.phase).toBe('draft');
      expect(post.has_benchmarks).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  it('throws for non-benchmark post', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const researchDir = join(dir, 'research');

    createResearchPost(dbPath, researchDir, 'lambda');

    const db = getDatabase(dbPath);
    try {
      expect(() => completeBenchmark(db, 'lambda')).toThrow(/not 'benchmark'/);
    } finally {
      closeDatabase(db);
    }
  });

  it('throws for missing post', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const db = getDatabase(dbPath);
    try {
      expect(() => completeBenchmark(db, 'nonexistent')).toThrow(/not found/);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('getBenchmarkRequirement', () => {
  it('returns correct values for each content type', () => {
    const config = makeConfig();
    expect(getBenchmarkRequirement('technical-deep-dive', config)).toBe('required');
    expect(getBenchmarkRequirement('project-launch', config)).toBe('optional');
    expect(getBenchmarkRequirement('analysis-opinion', config)).toBe('skip');
  });
});
