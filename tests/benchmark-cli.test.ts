import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { initResearchPost } from '../src/core/research/state.js';
import { writeResearchDocument, ResearchDocument } from '../src/core/research/document.js';
import {
  runBenchmarkInit,
  runBenchmarkEnv,
  runBenchmarkRun,
  runBenchmarkShow,
  runBenchmarkSkip,
  runBenchmarkComplete,
  runBenchmarkRepair,
  BenchmarkPaths,
} from '../src/cli/benchmark.js';
import { readResults } from '../src/core/benchmark/results.js';

interface Fixture {
  tempDir: string;
  dbPath: string;
  benchmarkDir: string;
  reposDir: string;
  researchDir: string;
  configPath: string;
}

let fixture: Fixture | undefined;

function setupFixture(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'bench-cli-'));
  const dbPath = join(tempDir, 'state.db');
  const benchmarkDir = join(tempDir, 'benchmarks');
  const reposDir = join(tempDir, 'repos');
  const researchDir = join(tempDir, 'research');
  const configPath = join(tempDir, '.blogrc.yaml');

  mkdirSync(benchmarkDir, { recursive: true });
  mkdirSync(reposDir, { recursive: true });
  mkdirSync(researchDir, { recursive: true });

  const db = getDatabase(dbPath);
  closeDatabase(db);

  writeFileSync(configPath, `
site:
  repo_path: "./site"
  base_url: "https://m0lz.dev"
  content_dir: "content/posts"
author:
  name: "Tester"
  github: "tester"
content_types:
  project-launch:
    benchmark: "optional"
    companion_repo: "existing"
    social_prefix: "Show HN:"
  technical-deep-dive:
    benchmark: "required"
    companion_repo: "new"
    social_prefix: ""
  analysis-opinion:
    benchmark: "skip"
    companion_repo: "optional"
    social_prefix: ""
evaluation:
  min_sources: 1
`);

  fixture = { tempDir, dbPath, benchmarkDir, reposDir, researchDir, configPath };
  return fixture;
}

function paths(f: Fixture): BenchmarkPaths {
  return {
    dbPath: f.dbPath,
    benchmarkDir: f.benchmarkDir,
    reposDir: f.reposDir,
    researchDir: f.researchDir,
    configPath: f.configPath,
  };
}

function createResearchPost(f: Fixture, slug: string, contentType: string = 'technical-deep-dive'): void {
  const db = getDatabase(f.dbPath);
  try {
    const projectId = contentType === 'project-launch' ? 'test.01' : null;
    initResearchPost(db, slug, 'test topic', 'directed', contentType as any, projectId);
  } finally {
    closeDatabase(db);
  }
  const doc: ResearchDocument = {
    slug,
    topic: 'test topic',
    mode: 'directed',
    content_type: contentType as any,
    created_at: new Date().toISOString(),
    thesis: 'Thesis',
    findings: 'Findings',
    sources_list: 'Sources',
    data_points: 'Data',
    open_questions: 'Questions',
    benchmark_targets: '- Target A\n- Target B',
    repo_scope: 'Scope',
  };
  writeResearchDocument(f.researchDir, doc, { force: true });
}

function writeValidResultsFile(f: Fixture, slug: string): string {
  const resultsFile = join(f.tempDir, `${slug}-results.json`);
  writeFileSync(resultsFile, JSON.stringify({
    slug,
    timestamp: new Date().toISOString(),
    targets: ['Target A'],
    data: { target_a: { mean: 42 } },
  }), 'utf-8');
  return resultsFile;
}

afterEach(() => {
  if (fixture) {
    rmSync(fixture.tempDir, { recursive: true, force: true });
    fixture = undefined;
  }
  const saved = process.exitCode;
  process.exitCode = saved === undefined ? undefined : 0;
  vi.restoreAllMocks();
});

function captureLogs(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((msg: unknown) => { logs.push(String(msg)); });
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => { errors.push(String(msg)); });
  return { logs, errors };
}

describe('runBenchmarkInit', () => {
  it('transitions to benchmark phase and prints targets', () => {
    const f = setupFixture();
    createResearchPost(f, 'alpha');
    const { logs } = captureLogs();
    const savedExitCode = process.exitCode;

    try {
      runBenchmarkInit('alpha', paths(f));

      expect(process.exitCode).not.toBe(1);
      const combined = logs.join('\n');
      expect(combined).toContain('Benchmark phase initialized');
      expect(combined).toContain('Target A');
      expect(combined).toContain('Target B');
      expect(combined).toContain('Companion repo scaffolded');

      const db = getDatabase(f.dbPath);
      try {
        const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get('alpha') as { phase: string };
        expect(post.phase).toBe('benchmark');
      } finally {
        closeDatabase(db);
      }

      expect(existsSync(join(f.benchmarkDir, 'alpha'))).toBe(true);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('rejects non-research post with exitCode=1', () => {
    const f = setupFixture();
    createResearchPost(f, 'beta');
    const db = getDatabase(f.dbPath);
    try {
      db.prepare("UPDATE posts SET phase = 'draft' WHERE slug = 'beta'").run();
    } finally {
      closeDatabase(db);
    }

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runBenchmarkInit('beta', paths(f));

      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain("not 'research'");
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('rejects skip content type with exitCode=1', () => {
    const f = setupFixture();
    createResearchPost(f, 'gamma', 'analysis-opinion');

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runBenchmarkInit('gamma', paths(f));

      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('does not require benchmarks');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('warns optional but proceeds for project-launch content type', () => {
    const f = setupFixture();
    createResearchPost(f, 'delta', 'project-launch');

    const { logs } = captureLogs();
    const savedExitCode = process.exitCode;
    try {
      runBenchmarkInit('delta', paths(f));

      expect(process.exitCode).not.toBe(1);
      const combined = logs.join('\n');
      expect(combined).toContain('optional');
      expect(combined).toContain('Benchmark phase initialized');

      const db = getDatabase(f.dbPath);
      try {
        const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get('delta') as { phase: string };
        expect(post.phase).toBe('benchmark');
      } finally {
        closeDatabase(db);
      }
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('runBenchmarkEnv', () => {
  it('captures environment and writes file', () => {
    const f = setupFixture();
    createResearchPost(f, 'alpha');
    captureLogs();
    runBenchmarkInit('alpha', paths(f));

    const { logs } = captureLogs();
    const savedExitCode = process.exitCode;
    try {
      runBenchmarkEnv('alpha', paths(f));

      expect(process.exitCode).not.toBe(1);
      expect(existsSync(join(f.benchmarkDir, 'alpha', 'environment.json'))).toBe(true);
      expect(logs.join('\n')).toContain('Environment captured');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('rejects non-benchmark post with exitCode=1', () => {
    const f = setupFixture();
    createResearchPost(f, 'beta');

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runBenchmarkEnv('beta', paths(f));

      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain("not 'benchmark'");
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('runBenchmarkRun', () => {
  it('stores results from file and marks run completed', () => {
    const f = setupFixture();
    createResearchPost(f, 'alpha');
    captureLogs();
    runBenchmarkInit('alpha', paths(f));
    runBenchmarkEnv('alpha', paths(f));

    const resultsFile = writeValidResultsFile(f, 'alpha');

    const { logs } = captureLogs();
    const savedExitCode = process.exitCode;
    try {
      runBenchmarkRun('alpha', { resultsFile }, paths(f));

      expect(process.exitCode).not.toBe(1);
      expect(logs.join('\n')).toContain('completed');

      const db = getDatabase(f.dbPath);
      try {
        const row = db.prepare('SELECT * FROM benchmarks WHERE post_slug = ?').get('alpha') as {
          id: number;
          status: string;
        };
        expect(row.status).toBe('completed');
        expect(readResults(f.benchmarkDir, 'alpha')?.run_id).toBe(row.id);
      } finally {
        closeDatabase(db);
      }
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('rejects when environment not captured', () => {
    const f = setupFixture();
    createResearchPost(f, 'beta');
    captureLogs();
    runBenchmarkInit('beta', paths(f));

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runBenchmarkRun('beta', {}, paths(f));

      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('environment');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('rejects environment.json as benchmark results', () => {
    const f = setupFixture();
    createResearchPost(f, 'envfile');
    captureLogs();
    runBenchmarkInit('envfile', paths(f));
    runBenchmarkEnv('envfile', paths(f));

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runBenchmarkRun(
        'envfile',
        { resultsFile: join(f.benchmarkDir, 'envfile', 'environment.json') },
        paths(f),
      );

      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('Invalid benchmark results file');
      expect(errors.join('\n')).toContain('environment.json');

      const db = getDatabase(f.dbPath);
      try {
        const row = db.prepare('SELECT * FROM benchmarks WHERE post_slug = ?').get('envfile') as {
          status: string;
        };
        expect(row.status).toBe('failed');
      } finally {
        closeDatabase(db);
      }
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('rejects results for a different slug', () => {
    const f = setupFixture();
    createResearchPost(f, 'alpha');
    captureLogs();
    runBenchmarkInit('alpha', paths(f));
    runBenchmarkEnv('alpha', paths(f));
    const resultsFile = writeValidResultsFile(f, 'other');

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runBenchmarkRun('alpha', { resultsFile }, paths(f));

      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain("field 'slug' must be 'alpha'");
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('does not overwrite existing canonical results after a bad import', () => {
    const f = setupFixture();
    createResearchPost(f, 'stable');
    captureLogs();
    runBenchmarkInit('stable', paths(f));
    runBenchmarkEnv('stable', paths(f));
    runBenchmarkRun('stable', { resultsFile: writeValidResultsFile(f, 'stable') }, paths(f));
    const before = readResults(f.benchmarkDir, 'stable');

    const badFile = join(f.tempDir, 'bad-results.json');
    writeFileSync(badFile, JSON.stringify({ slug: 'other', timestamp: new Date().toISOString(), targets: [], data: {} }));

    const savedExitCode = process.exitCode;
    try {
      captureLogs();
      process.exitCode = 0;
      runBenchmarkRun('stable', { resultsFile: badFile }, paths(f));

      expect(process.exitCode).toBe(1);
      expect(readResults(f.benchmarkDir, 'stable')).toEqual(before);
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('runBenchmarkShow', () => {
  it('displays benchmark state with run count', () => {
    const f = setupFixture();
    createResearchPost(f, 'alpha');
    captureLogs();
    runBenchmarkInit('alpha', paths(f));
    runBenchmarkEnv('alpha', paths(f));

    const resultsFile = writeValidResultsFile(f, 'alpha');
    runBenchmarkRun('alpha', { resultsFile }, paths(f));

    const { logs } = captureLogs();
    const savedExitCode = process.exitCode;
    try {
      runBenchmarkShow('alpha', paths(f));

      const combined = logs.join('\n');
      expect(combined).toContain('phase:');
      expect(combined).toContain('benchmark');
      expect(combined).toContain('content_type:');
      expect(combined).toContain('benchmark_req:');
      expect(combined).toContain('runs:');
      expect(combined).toContain('1');
      expect(combined).toContain('env_captured:');
      expect(combined).toContain('yes');
      expect(combined).toContain('results_path:');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('reports invalid canonical results without hiding other state', () => {
    const f = setupFixture();
    createResearchPost(f, 'invalid-show');
    captureLogs();
    runBenchmarkInit('invalid-show', paths(f));
    runBenchmarkEnv('invalid-show', paths(f));
    const slugDir = join(f.benchmarkDir, 'invalid-show');
    writeFileSync(join(slugDir, 'results.json'), JSON.stringify({
      slug: 'invalid-show',
      timestamp: new Date().toISOString(),
      targets: ['Target A'],
      data: {},
    }), 'utf-8');

    const { logs } = captureLogs();
    runBenchmarkShow('invalid-show', paths(f));

    const combined = logs.join('\n');
    expect(combined).toContain('phase:');
    expect(combined).toContain('benchmark');
    expect(combined).toContain('results_path:    (invalid:');
    expect(combined).toContain('run_id');
  });
});

describe('runBenchmarkSkip', () => {
  it('advances analysis-opinion post to draft with has_benchmarks=0', () => {
    const f = setupFixture();
    createResearchPost(f, 'alpha', 'analysis-opinion');

    const { logs } = captureLogs();
    const savedExitCode = process.exitCode;
    try {
      runBenchmarkSkip('alpha', paths(f));

      expect(process.exitCode).not.toBe(1);
      expect(logs.join('\n')).toContain('Skipped benchmarks');

      const db = getDatabase(f.dbPath);
      try {
        const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get('alpha') as {
          phase: string; has_benchmarks: number;
        };
        expect(post.phase).toBe('draft');
        expect(post.has_benchmarks).toBe(0);
      } finally {
        closeDatabase(db);
      }
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('refuses to skip required benchmarks with exitCode=1', () => {
    const f = setupFixture();
    createResearchPost(f, 'beta', 'technical-deep-dive');

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runBenchmarkSkip('beta', paths(f));

      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('required');
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('runBenchmarkComplete', () => {
  it('advances benchmark post to draft with has_benchmarks=1', () => {
    const f = setupFixture();
    createResearchPost(f, 'alpha');
    captureLogs();
    runBenchmarkInit('alpha', paths(f));
    runBenchmarkEnv('alpha', paths(f));
    runBenchmarkRun('alpha', { resultsFile: writeValidResultsFile(f, 'alpha') }, paths(f));

    const { logs } = captureLogs();
    const savedExitCode = process.exitCode;
    try {
      runBenchmarkComplete('alpha', paths(f));

      expect(process.exitCode).not.toBe(1);
      expect(logs.join('\n')).toContain('Benchmarks completed');

      const db = getDatabase(f.dbPath);
      try {
        const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get('alpha') as {
          phase: string; has_benchmarks: number;
        };
        expect(post.phase).toBe('draft');
        expect(post.has_benchmarks).toBe(1);
      } finally {
        closeDatabase(db);
      }
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('rejects benchmark completion before results are imported', () => {
    const f = setupFixture();
    createResearchPost(f, 'empty');
    captureLogs();
    runBenchmarkInit('empty', paths(f));

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runBenchmarkComplete('empty', paths(f));

      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('No benchmark results found');

      const db = getDatabase(f.dbPath);
      try {
        const post = db.prepare('SELECT phase FROM posts WHERE slug = ?').get('empty') as { phase: string };
        expect(post.phase).toBe('benchmark');
      } finally {
        closeDatabase(db);
      }
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('rejects non-benchmark post with exitCode=1', () => {
    const f = setupFixture();
    createResearchPost(f, 'beta');

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runBenchmarkComplete('beta', paths(f));

      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain("not 'benchmark'");
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('invalid slug rejection', () => {
  it('rejects path traversal slug for all handlers', () => {
    const f = setupFixture();
    const savedExitCode = process.exitCode;

    try {
      for (const handler of [
        () => runBenchmarkInit('../etc/passwd', paths(f)),
        () => runBenchmarkEnv('../etc/passwd', paths(f)),
        () => runBenchmarkRun('../etc/passwd', {}, paths(f)),
        () => runBenchmarkShow('../etc/passwd', paths(f)),
        () => runBenchmarkSkip('../etc/passwd', paths(f)),
        () => runBenchmarkComplete('../etc/passwd', paths(f)),
        () => runBenchmarkRepair('../etc/passwd', { skipOptional: true, reason: 'bad run' }, paths(f)),
      ]) {
        const { errors } = captureLogs();
        process.exitCode = 0;
        handler();
        expect(process.exitCode).toBe(1);
        expect(errors.join('\n')).toContain('Invalid slug');
      }
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});
