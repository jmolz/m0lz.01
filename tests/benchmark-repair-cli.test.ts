import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
import { writeResearchDocument, ResearchDocument } from '../src/core/research/document.js';
import {
  runBenchmarkInit,
  runBenchmarkEnv,
  runBenchmarkRepair,
  BenchmarkPaths,
} from '../src/cli/benchmark.js';
import { readResults } from '../src/core/benchmark/results.js';

interface Fixture {
  tempDir: string;
  dbPath: string;
  benchmarkDir: string;
  draftsDir: string;
  reposDir: string;
  researchDir: string;
  configPath: string;
}

let fixture: Fixture | undefined;

function setupFixture(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'bench-repair-'));
  const dbPath = join(tempDir, 'state.db');
  const benchmarkDir = join(tempDir, 'benchmarks');
  const draftsDir = join(tempDir, 'drafts');
  const reposDir = join(tempDir, 'repos');
  const researchDir = join(tempDir, 'research');
  const configPath = join(tempDir, '.blogrc.yaml');

  mkdirSync(benchmarkDir, { recursive: true });
  mkdirSync(draftsDir, { recursive: true });
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

  fixture = { tempDir, dbPath, benchmarkDir, draftsDir, reposDir, researchDir, configPath };
  return fixture;
}

function paths(f: Fixture): BenchmarkPaths {
  return {
    dbPath: f.dbPath,
    benchmarkDir: f.benchmarkDir,
    draftsDir: f.draftsDir,
    reposDir: f.reposDir,
    researchDir: f.researchDir,
    configPath: f.configPath,
  };
}

function createResearchPost(
  f: Fixture,
  slug: string,
  contentType: 'project-launch' | 'technical-deep-dive' | 'analysis-opinion' = 'project-launch',
): void {
  const db = getDatabase(f.dbPath);
  try {
    initResearchPost(
      db,
      slug,
      'test topic',
      'directed',
      contentType,
      contentType === 'project-launch' ? 'test.01' : null,
    );
  } finally {
    closeDatabase(db);
  }
  const doc: ResearchDocument = {
    slug,
    topic: 'test topic',
    mode: 'directed',
    content_type: contentType,
    created_at: new Date().toISOString(),
    thesis: 'Thesis',
    findings: 'Findings',
    sources_list: 'Sources',
    data_points: 'Data',
    open_questions: 'Questions',
    benchmark_targets: '- Target A',
    repo_scope: 'Scope',
  };
  writeResearchDocument(f.researchDir, doc, { force: true });
}

function writeResultsInput(f: Fixture, slug: string): string {
  const file = join(f.tempDir, `${slug}-input-results.json`);
  writeFileSync(file, JSON.stringify({
    slug,
    run_id: 999,
    timestamp: new Date().toISOString(),
    targets: ['Target A'],
    data: { target_a: { mean: 42 } },
    summary: 'replacement results',
  }), 'utf-8');
  return file;
}

function captureLogs(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((msg: unknown) => { logs.push(String(msg)); });
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => { errors.push(String(msg)); });
  return { logs, errors };
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

describe('runBenchmarkRepair --results-file', () => {
  it('repairs draft-phase canonical results with DB-authoritative run_id and receipt', () => {
    const f = setupFixture();
    createResearchPost(f, 'draft-repair');
    captureLogs();
    runBenchmarkInit('draft-repair', paths(f));
    runBenchmarkEnv('draft-repair', paths(f));
    const db = getDatabase(f.dbPath);
    try {
      advancePhase(db, 'draft-repair', 'draft');
    } finally {
      closeDatabase(db);
    }

    const saved = process.exitCode;
    try {
      const { logs } = captureLogs();
      process.exitCode = 0;
      runBenchmarkRepair('draft-repair', { resultsFile: writeResultsInput(f, 'draft-repair') }, paths(f));

      expect(process.exitCode).not.toBe(1);
      expect(logs.join('\n')).toContain('Benchmark results repaired');
      const results = readResults(f.benchmarkDir, 'draft-repair');
      expect(results?.run_id).not.toBe(999);
      expect(results?.summary).toBe('replacement results');
      const receipt = JSON.parse(readFileSync(join(f.benchmarkDir, 'draft-repair', 'repair.json'), 'utf-8')) as {
        action: string;
        previous_phase: string;
        phase_after: string;
      };
      expect(receipt.action).toBe('results-file');
      expect(receipt.previous_phase).toBe('draft');
      expect(receipt.phase_after).toBe('draft');
    } finally {
      process.exitCode = saved;
    }
  });

  it('requires environment provenance unless explicit repair capture is allowed', () => {
    const f = setupFixture();
    createResearchPost(f, 'needs-env');
    captureLogs();
    runBenchmarkInit('needs-env', paths(f));

    const saved = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runBenchmarkRepair('needs-env', { resultsFile: writeResultsInput(f, 'needs-env') }, paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('No environment captured');

      captureLogs();
      process.exitCode = 0;
      runBenchmarkRepair(
        'needs-env',
        {
          resultsFile: writeResultsInput(f, 'needs-env'),
          allowCaptureRepairEnvironment: true,
        },
        paths(f),
      );
      expect(process.exitCode).not.toBe(1);
      const receipt = JSON.parse(readFileSync(join(f.benchmarkDir, 'needs-env', 'repair.json'), 'utf-8')) as {
        environment_captured_at_repair: boolean;
      };
      expect(receipt.environment_captured_at_repair).toBe(true);
      expect(existsSync(join(f.benchmarkDir, 'needs-env', 'environment.json'))).toBe(true);
    } finally {
      process.exitCode = saved;
    }
  });

  it('does not capture repair environment before phase eligibility is checked', () => {
    const f = setupFixture();
    createResearchPost(f, 'too-late');
    captureLogs();
    runBenchmarkInit('too-late', paths(f));
    const db = getDatabase(f.dbPath);
    try {
      advancePhase(db, 'too-late', 'draft');
      advancePhase(db, 'too-late', 'evaluate');
    } finally {
      closeDatabase(db);
    }

    const saved = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runBenchmarkRepair(
        'too-late',
        {
          resultsFile: writeResultsInput(f, 'too-late'),
          allowCaptureRepairEnvironment: true,
        },
        paths(f),
      );
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('Benchmark repair only operates before evaluation starts');
      expect(existsSync(join(f.benchmarkDir, 'too-late', 'environment.json'))).toBe(false);
    } finally {
      process.exitCode = saved;
    }
  });
});

describe('runBenchmarkRepair --skip-optional', () => {
  it('skips an optional benchmark attempt from benchmark phase and preserves raw artifacts', () => {
    const f = setupFixture();
    createResearchPost(f, 'optional-skip');
    captureLogs();
    runBenchmarkInit('optional-skip', paths(f));
    const rawDir = join(f.benchmarkDir, 'optional-skip');
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, 'results.json'), JSON.stringify({ slug: 'optional-skip', bad: true }), 'utf-8');

    const saved = process.exitCode;
    try {
      captureLogs();
      process.exitCode = 0;
      runBenchmarkRepair(
        'optional-skip',
        { skipOptional: true, reason: 'environment.json was imported by mistake' },
        paths(f),
      );

      expect(process.exitCode).not.toBe(1);
      expect(existsSync(join(rawDir, 'results.json'))).toBe(true);
      const receipt = JSON.parse(readFileSync(join(rawDir, 'repair.json'), 'utf-8')) as {
        action: string;
        reason: string;
        preserve_raw_artifacts: boolean;
        phase_after: string;
      };
      expect(receipt.action).toBe('skip-optional');
      expect(receipt.reason).toContain('environment.json');
      expect(receipt.preserve_raw_artifacts).toBe(true);
      expect(receipt.phase_after).toBe('draft');
      const db = getDatabase(f.dbPath);
      try {
        const post = db.prepare('SELECT phase, has_benchmarks FROM posts WHERE slug = ?').get('optional-skip') as {
          phase: string;
          has_benchmarks: number;
        };
        expect(post.phase).toBe('draft');
        expect(post.has_benchmarks).toBe(0);
      } finally {
        closeDatabase(db);
      }
    } finally {
      process.exitCode = saved;
    }
  });

  it('skips from draft phase without changing phase when no draft file exists', () => {
    const f = setupFixture();
    createResearchPost(f, 'draft-skip');
    captureLogs();
    runBenchmarkInit('draft-skip', paths(f));
    const db = getDatabase(f.dbPath);
    try {
      advancePhase(db, 'draft-skip', 'draft');
    } finally {
      closeDatabase(db);
    }

    const saved = process.exitCode;
    try {
      captureLogs();
      process.exitCode = 0;
      runBenchmarkRepair('draft-skip', { skipOptional: true, reason: 'optional benchmark failed' }, paths(f));
      expect(process.exitCode).not.toBe(1);
      const db2 = getDatabase(f.dbPath);
      try {
        const post = db2.prepare('SELECT phase, has_benchmarks FROM posts WHERE slug = ?').get('draft-skip') as {
          phase: string;
          has_benchmarks: number;
        };
        expect(post.phase).toBe('draft');
        expect(post.has_benchmarks).toBe(0);
      } finally {
        closeDatabase(db2);
      }
    } finally {
      process.exitCode = saved;
    }
  });

  it('refuses optional skip for required or skipped benchmark content', () => {
    const f = setupFixture();
    createResearchPost(f, 'required', 'technical-deep-dive');
    createResearchPost(f, 'skipped', 'analysis-opinion');
    captureLogs();
    runBenchmarkInit('required', paths(f));
    vi.restoreAllMocks();
    const db = getDatabase(f.dbPath);
    try {
      advancePhase(db, 'skipped', 'draft');
    } finally {
      closeDatabase(db);
    }

    const saved = process.exitCode;
    try {
      let captured = captureLogs();
      process.exitCode = 0;
      runBenchmarkRepair('required', { skipOptional: true, reason: 'bad run' }, paths(f));
      expect(process.exitCode).toBe(1);
      expect(captured.errors.join('\n')).toContain("requirement 'required'");

      vi.restoreAllMocks();
      captured = captureLogs();
      process.exitCode = 0;
      runBenchmarkRepair('skipped', { skipOptional: true, reason: 'bad run' }, paths(f));
      expect(process.exitCode).toBe(1);
      expect(captured.errors.join('\n')).toContain("requirement 'skip'");
    } finally {
      process.exitCode = saved;
    }
  });

  it('refuses optional skip when an existing draft might contain stale benchmark prose', () => {
    const f = setupFixture();
    createResearchPost(f, 'stale-draft');
    captureLogs();
    runBenchmarkInit('stale-draft', paths(f));
    const draftDir = join(f.draftsDir, 'stale-draft');
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(join(draftDir, 'index.mdx'), 'benchmark prose', 'utf-8');

    const saved = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runBenchmarkRepair('stale-draft', { skipOptional: true, reason: 'bad run' }, paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('draft file already exists');
    } finally {
      process.exitCode = saved;
    }
  });
});
