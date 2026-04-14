import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import {
  runResearchInit,
  runResearchAddSource,
  runResearchShow,
  runResearchFinalize,
} from '../src/cli/research.js';

interface Fixture {
  tempDir: string;
  dbPath: string;
  researchDir: string;
  configPath: string;
}

let fixture: Fixture | undefined;

function setupFixture(overrides: { minSources?: number } = {}): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'research-cli-'));
  const dbPath = join(tempDir, 'state.db');
  const researchDir = join(tempDir, 'research');
  const configPath = join(tempDir, '.blogrc.yaml');
  mkdirSync(researchDir, { recursive: true });

  // Seed empty DB so requireDb() passes
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
evaluation:
  min_sources: ${overrides.minSources ?? 3}
`);

  fixture = { tempDir, dbPath, researchDir, configPath };
  return fixture;
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

describe('runResearchInit', () => {
  it('creates a post row and writes a template doc', () => {
    const f = setupFixture();
    const { logs } = captureLogs();
    const savedExitCode = process.exitCode;

    try {
      runResearchInit('alpha', { topic: 'alpha topic', mode: 'directed' }, {
        dbPath: f.dbPath,
        researchDir: f.researchDir,
      });
    } finally {
      process.exitCode = savedExitCode;
    }

    const db = getDatabase(f.dbPath);
    try {
      const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get('alpha') as {
        slug: string; phase: string; mode: string;
      } | undefined;
      expect(post).toBeDefined();
      expect(post?.phase).toBe('research');
      expect(post?.mode).toBe('directed');
    } finally {
      closeDatabase(db);
    }

    expect(existsSync(join(f.researchDir, 'alpha.md'))).toBe(true);
    const combined = logs.join('\n');
    expect(combined).toContain('alpha');
    expect(combined).toContain('Research document');
  });

  it('refuses to overwrite existing doc without --force', () => {
    const f = setupFixture();
    captureLogs();
    const savedExitCode = process.exitCode;

    try {
      runResearchInit('alpha', { topic: 'first' }, { dbPath: f.dbPath, researchDir: f.researchDir });
      process.exitCode = 0;

      // Mutate file so we can detect a silent overwrite
      const docPath = join(f.researchDir, 'alpha.md');
      const original = readFileSync(docPath, 'utf-8');
      writeFileSync(docPath, original + '\n\nEXTRA', 'utf-8');

      runResearchInit('alpha', { topic: 'second' }, { dbPath: f.dbPath, researchDir: f.researchDir });

      expect(process.exitCode).toBe(1);
      expect(readFileSync(docPath, 'utf-8')).toContain('EXTRA');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('overwrites with --force', () => {
    const f = setupFixture();
    captureLogs();
    const savedExitCode = process.exitCode;

    try {
      runResearchInit('alpha', { topic: 'first' }, { dbPath: f.dbPath, researchDir: f.researchDir });

      const docPath = join(f.researchDir, 'alpha.md');
      writeFileSync(docPath, 'CORRUPTED', 'utf-8');

      runResearchInit('alpha', { topic: 'first', force: true }, {
        dbPath: f.dbPath,
        researchDir: f.researchDir,
      });

      const content = readFileSync(docPath, 'utf-8');
      expect(content).not.toBe('CORRUPTED');
      expect(content).toContain('## Thesis');
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('runResearchAddSource', () => {
  it('inserts a source and logs the id', () => {
    const f = setupFixture();
    captureLogs();
    runResearchInit('alpha', { topic: 'x' }, { dbPath: f.dbPath, researchDir: f.researchDir });

    const { logs } = captureLogs();
    runResearchAddSource('alpha', { url: 'https://example.com', excerpt: 'why' }, { dbPath: f.dbPath });

    expect(logs.some((l) => /Added source/.test(l))).toBe(true);
  });

  it('reports when source already tracked (idempotent)', () => {
    const f = setupFixture();
    captureLogs();
    runResearchInit('alpha', { topic: 'x' }, { dbPath: f.dbPath, researchDir: f.researchDir });
    runResearchAddSource('alpha', { url: 'https://x.com' }, { dbPath: f.dbPath });

    const { logs } = captureLogs();
    runResearchAddSource('alpha', { url: 'https://x.com' }, { dbPath: f.dbPath });

    expect(logs.some((l) => /already tracked/.test(l))).toBe(true);

    const db = getDatabase(f.dbPath);
    try {
      const row = db.prepare('SELECT COUNT(*) AS c FROM sources WHERE post_slug = ?').get('alpha') as { c: number };
      expect(row.c).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  it('sets exitCode=1 and emits slug in stderr for missing post', () => {
    const f = setupFixture();
    const savedExitCode = process.exitCode;

    try {
      const { errors } = captureLogs();
      runResearchAddSource('missing-slug', { url: 'https://x.com' }, { dbPath: f.dbPath });
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('missing-slug');
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('runResearchShow', () => {
  it('prints phase, source count, and doc path', () => {
    const f = setupFixture();
    captureLogs();
    runResearchInit('alpha', { topic: 'x' }, { dbPath: f.dbPath, researchDir: f.researchDir });
    runResearchAddSource('alpha', { url: 'https://x.com' }, { dbPath: f.dbPath });

    const { logs } = captureLogs();
    runResearchShow('alpha', { dbPath: f.dbPath, researchDir: f.researchDir });

    const combined = logs.join('\n');
    expect(combined).toContain('phase:');
    expect(combined).toContain('research');
    expect(combined).toContain('sources:');
    expect(combined).toContain('1');
    expect(combined).toContain('alpha.md');
  });

  it('sets exitCode=1 for missing slug', () => {
    const f = setupFixture();
    const savedExitCode = process.exitCode;

    try {
      const { errors } = captureLogs();
      runResearchShow('missing', { dbPath: f.dbPath, researchDir: f.researchDir });
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('missing');
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('runResearchFinalize', () => {
  it('fails with exitCode=1 on insufficient sources', () => {
    const f = setupFixture({ minSources: 3 });
    const savedExitCode = process.exitCode;

    try {
      captureLogs();
      runResearchInit('alpha', { topic: 'x' }, { dbPath: f.dbPath, researchDir: f.researchDir });

      const { errors } = captureLogs();
      runResearchFinalize('alpha', { dbPath: f.dbPath, researchDir: f.researchDir, configPath: f.configPath });

      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toMatch(/0.*3|min 3/);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('fails with exitCode=1 when required sections are empty', () => {
    const f = setupFixture({ minSources: 1 });
    const savedExitCode = process.exitCode;

    try {
      captureLogs();
      runResearchInit('alpha', { topic: 'x' }, { dbPath: f.dbPath, researchDir: f.researchDir });
      runResearchAddSource('alpha', { url: 'https://x.com' }, { dbPath: f.dbPath });

      const { errors } = captureLogs();
      runResearchFinalize('alpha', { dbPath: f.dbPath, researchDir: f.researchDir, configPath: f.configPath });

      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toMatch(/Empty sections|Missing sections/);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('passes when sources meet min and sections are filled', () => {
    const f = setupFixture({ minSources: 1 });
    const savedExitCode = process.exitCode;

    try {
      captureLogs();
      runResearchInit('alpha', { topic: 'x' }, { dbPath: f.dbPath, researchDir: f.researchDir });
      runResearchAddSource('alpha', { url: 'https://x.com' }, { dbPath: f.dbPath });

      // Fill all sections with real content
      const docPath = join(f.researchDir, 'alpha.md');
      const raw = readFileSync(docPath, 'utf-8');
      const filled = raw.replace(/\{\{[a-z_]+\}\}/g, 'Content here.');
      writeFileSync(docPath, filled, 'utf-8');

      process.exitCode = 0;
      const { logs } = captureLogs();
      runResearchFinalize('alpha', { dbPath: f.dbPath, researchDir: f.researchDir, configPath: f.configPath });

      expect(process.exitCode).toBe(0);
      expect(logs.join('\n')).toMatch(/ready for alpha/);
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});
