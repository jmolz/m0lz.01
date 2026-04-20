import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { PostRow } from '../src/core/db/types.js';
import { importPosts } from '../src/core/migrate/import-posts.js';
import { runStatus } from '../src/cli/status.js';
import { runMetrics, computeMetrics } from '../src/cli/metrics.js';
import { runInit } from '../src/cli/init.js';

let db: Database.Database;
let tempDir: string;

afterEach(() => {
  if (db) closeDatabase(db);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function insertPost(db: Database.Database, slug: string, overrides: Partial<PostRow> = {}): void {
  db.prepare(`
    INSERT INTO posts (slug, title, phase, mode, site_url, repo_url, content_type, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    slug,
    overrides.title ?? slug,
    overrides.phase ?? 'published',
    overrides.mode ?? 'imported',
    overrides.site_url ?? `https://m0lz.dev/writing/${slug}`,
    overrides.repo_url ?? null,
    overrides.content_type ?? null,
    overrides.project_id ?? null,
  );
}

function setupTempDb(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'blog-cli-'));
  const dbPath = join(tempDir, 'state.db');
  db = getDatabase(dbPath);
  return dbPath;
}

describe('runStatus', () => {
  it('prints a formatted table when posts exist', () => {
    const dbPath = setupTempDb();
    insertPost(db, 'alpha', { phase: 'published', mode: 'imported' });
    insertPost(db, 'beta', { phase: 'research', mode: 'exploratory', content_type: 'technical-deep-dive' });
    closeDatabase(db);
    db = undefined as unknown as Database.Database;

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => { logs.push(msg); });

    runStatus({ dbPath });

    const output = logs.join('\n');
    expect(output).toContain('alpha');
    expect(output).toContain('beta');
    expect(output).toContain('published');
    expect(output).toContain('research');
    expect(output).toContain('technical-deep-dive');
    expect(output).toContain('2 posts (1 published, 1 in progress)');
  });

  it('prints empty-state message when no posts exist', () => {
    const dbPath = setupTempDb();
    closeDatabase(db);
    db = undefined as unknown as Database.Database;

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => { logs.push(msg); });

    runStatus({ dbPath });

    expect(logs.join('\n')).toContain('No posts yet');
  });

  it('exits with error when database is missing', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-cli-'));
    const dbPath = join(tempDir, 'nonexistent.db');

    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg: string) => { errors.push(msg); });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);

    expect(() => runStatus({ dbPath })).toThrow('exit:1');
    expect(errors.join('\n')).toContain("No state database found");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('runMetrics / computeMetrics', () => {
  it('computes correct aggregate counts from posts table', () => {
    setupTempDb();
    insertPost(db, 'pub-1', { phase: 'published', mode: 'imported', repo_url: 'github.com/x/1' });
    insertPost(db, 'pub-2', { phase: 'published', mode: 'imported' });
    insertPost(db, 'wip-1', { phase: 'research', mode: 'exploratory' });
    db.prepare("UPDATE posts SET devto_url = 'https://dev.to/t' WHERE slug = 'pub-1'").run();

    const m = computeMetrics(db);
    expect(m.total).toBe(3);
    expect(m.imported).toBe(2);
    expect(m.agentCreated).toBe(1);
    expect(m.published).toBe(2);
    expect(m.inProgress).toBe(1);
    expect(m.siteCount).toBe(3);
    expect(m.devtoCount).toBe(1);
    expect(m.mediumCount).toBe(0);
    expect(m.repoCount).toBe(1);
    expect(m.evaluationPassRate).toBe('- (no evaluations yet)');
  });

  it('computes evaluation pass rate correctly when verdicts exist', () => {
    setupTempDb();
    insertPost(db, 'p1');
    insertPost(db, 'p2');

    db.prepare(`
      INSERT INTO evaluation_synthesis (post_slug, verdict, report_path)
      VALUES ('p1', 'pass', 'report1.md'), ('p2', 'fail', 'report2.md')
    `).run();

    const m = computeMetrics(db);
    expect(m.evaluationPassRate).toBe('50%');
  });

  it('handles empty database', () => {
    setupTempDb();
    const m = computeMetrics(db);
    expect(m.total).toBe(0);
    expect(m.imported).toBe(0);
    expect(m.evaluationPassRate).toBe('- (no evaluations yet)');
  });

  it('runMetrics prints output', () => {
    const dbPath = setupTempDb();
    insertPost(db, 'a', { phase: 'published', mode: 'imported', repo_url: 'github.com/x/a' });
    closeDatabase(db);
    db = undefined as unknown as Database.Database;

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => { logs.push(msg); });

    runMetrics(dbPath);

    const output = logs.join('\n');
    expect(output).toContain('Total:       1');
    expect(output).toContain('Companion repos: 1');
  });

  it('exits with error when database is missing', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-cli-'));
    const dbPath = join(tempDir, 'nonexistent.db');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);

    expect(() => runMetrics(dbPath)).toThrow('exit:1');
  });
});

describe('runInit', () => {
  it('creates .blog-agent/ with all subdirectories and state.db', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-init-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    runInit(false, tempDir);

    const stateDir = join(tempDir, '.blog-agent');
    expect(existsSync(stateDir)).toBe(true);
    expect(existsSync(join(stateDir, 'state.db'))).toBe(true);
    for (const sub of ['research', 'benchmarks', 'drafts', 'repos', 'social', 'evaluations', 'research-pages']) {
      expect(existsSync(join(stateDir, sub))).toBe(true);
    }
  });

  it('hard-fails with a diagnostic when the shipped config template is missing', () => {
    // Simulate a broken install: point packageRoot at a tmpdir that lacks
    // .blogrc.example.yaml. Pre-fix, runInit silently skipped the copy and
    // left the operator with an empty workspace (Codex Pass 1 Finding #4).
    tempDir = mkdtempSync(join(tmpdir(), 'blog-init-'));
    const fakePkg = mkdtempSync(join(tmpdir(), 'blog-init-pkg-'));

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg: string) => {
      errors.push(msg);
    });

    const savedExitCode = process.exitCode;
    try {
      runInit(false, tempDir, fakePkg);
      expect(process.exitCode).toBe(1);
      expect(
        errors.some((e) => e.includes('Missing shipped config template')),
      ).toBe(true);
      // The write target must NOT have been created when the read source
      // is missing — that is the regression this test locks in.
      expect(existsSync(join(tempDir, '.blogrc.yaml'))).toBe(false);
    } finally {
      process.exitCode = savedExitCode;
      rmSync(fakePkg, { recursive: true, force: true });
    }
  });

  it('hard-fails with a diagnostic when the shipped env template is missing', () => {
    // Same pattern, but put .blogrc.example.yaml in the fake pkg so the
    // config copy succeeds and the throw fires on .env.example instead.
    tempDir = mkdtempSync(join(tmpdir(), 'blog-init-'));
    const fakePkg = mkdtempSync(join(tmpdir(), 'blog-init-pkg-'));
    writeFileSync(
      join(fakePkg, '.blogrc.example.yaml'),
      '# minimal example\nsite:\n  repo_path: ./\n',
    );

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg: string) => {
      errors.push(msg);
    });

    const savedExitCode = process.exitCode;
    try {
      runInit(false, tempDir, fakePkg);
      expect(process.exitCode).toBe(1);
      expect(
        errors.some((e) => e.includes('Missing shipped env template')),
      ).toBe(true);
      // The config DID copy (pre-throw), but .env did not.
      expect(existsSync(join(tempDir, '.blogrc.yaml'))).toBe(true);
      expect(existsSync(join(tempDir, '.env'))).toBe(false);
    } finally {
      process.exitCode = savedExitCode;
      rmSync(fakePkg, { recursive: true, force: true });
    }
  });

  it('is idempotent on re-run', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-init-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    runInit(false, tempDir);
    runInit(false, tempDir);

    // Directory and DB still exist, no errors thrown
    expect(existsSync(join(tempDir, '.blog-agent', 'state.db'))).toBe(true);
    // Subdirs still present
    for (const sub of ['research', 'benchmarks', 'drafts']) {
      expect(existsSync(join(tempDir, '.blog-agent', sub))).toBe(true);
    }
  });

  it('initializes database with correct schema', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-init-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    runInit(false, tempDir);

    const dbPath = join(tempDir, '.blog-agent', 'state.db');
    db = getDatabase(dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('posts');
    expect(names).toContain('pipeline_steps');
    expect(names).toContain('evaluation_synthesis');
  });

  it('prints clean error message when --import fails', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-init-'));

    // Stage a config pointing to a non-existent site repo
    writeFileSync(join(tempDir, '.blogrc.yaml'), `
site:
  repo_path: "./does-not-exist"
  base_url: "https://m0lz.dev"
  content_dir: "content/posts"
author:
  name: "Tester"
  github: "tester"
`);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg: string) => { errors.push(msg); });

    // Save and restore exitCode around the test — runInit sets it on failure
    const savedExitCode = process.exitCode;
    try {
      runInit(true, tempDir);
      expect(errors.some((e) => e.includes('Import failed'))).toBe(true);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = savedExitCode;
    }

    // Verify the state.db was still created (directory init succeeded)
    expect(existsSync(join(tempDir, '.blog-agent', 'state.db'))).toBe(true);
  });

  it('import uses content_dir parameter from config', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-init-'));

    // Stage a site repo with a custom content_dir
    const siteRepo = join(tempDir, 'site');
    const customContentDir = 'posts';
    const postSlug = 'custom-post';
    mkdirSync(join(siteRepo, customContentDir, postSlug), { recursive: true });
    writeFileSync(
      join(siteRepo, customContentDir, postSlug, 'index.mdx'),
      '---\ntitle: "Custom"\ndescription: "Test"\ndate: "2026-04-01"\ntags: []\npublished: true\n---\n\nContent.',
    );

    // Pre-create the config so runInit doesn't copy the example
    writeFileSync(join(tempDir, '.blogrc.yaml'), `
site:
  repo_path: "./site"
  base_url: "https://m0lz.dev"
  content_dir: "${customContentDir}"
author:
  name: "Tester"
  github: "tester"
`);

    vi.spyOn(console, 'log').mockImplementation(() => {});

    runInit(true, tempDir);

    const dbPath = join(tempDir, '.blog-agent', 'state.db');
    db = getDatabase(dbPath);
    const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(postSlug) as PostRow;
    expect(post).toBeDefined();
    expect(post.title).toBe('Custom');
  });
});
