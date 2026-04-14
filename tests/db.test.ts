import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { SCHEMA_VERSION } from '../src/core/db/schema.js';

let db: Database.Database;
let tempDir: string | undefined;

afterEach(() => {
  if (db) closeDatabase(db);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('database', () => {
  it('creates all tables on fresh database', () => {
    db = getDatabase(':memory:');

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('posts');
    expect(tableNames).toContain('sources');
    expect(tableNames).toContain('benchmarks');
    expect(tableNames).toContain('pipeline_steps');
    expect(tableNames).toContain('assets');
    expect(tableNames).toContain('evaluations');
    expect(tableNames).toContain('evaluation_synthesis');
    expect(tableNames).toContain('metrics');
  });

  it('sets user_version to SCHEMA_VERSION', () => {
    db = getDatabase(':memory:');
    const version = db.pragma('user_version', { simple: true });
    expect(version).toBe(SCHEMA_VERSION);
  });

  it('enables WAL mode on file-backed database', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-db-'));
    const dbPath = join(tempDir, 'test.db');
    db = getDatabase(dbPath);
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });

  it('enables foreign keys', () => {
    db = getDatabase(':memory:');
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });

  it('inserts and retrieves a post', () => {
    db = getDatabase(':memory:');

    db.prepare(`
      INSERT INTO posts (slug, title, phase, mode)
      VALUES ('test-post', 'Test Post', 'research', 'exploratory')
    `).run();

    const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get('test-post') as Record<string, unknown>;
    expect(post.slug).toBe('test-post');
    expect(post.title).toBe('Test Post');
    expect(post.phase).toBe('research');
    expect(post.mode).toBe('exploratory');
  });

  it('rejects invalid phase values via CHECK constraint', () => {
    db = getDatabase(':memory:');

    expect(() => {
      db.prepare(`
        INSERT INTO posts (slug, phase, mode)
        VALUES ('bad-phase', 'invalid_phase', 'exploratory')
      `).run();
    }).toThrow();
  });

  it('enforces foreign key on sources', () => {
    db = getDatabase(':memory:');

    expect(() => {
      db.prepare(`
        INSERT INTO sources (post_slug, url, title)
        VALUES ('nonexistent-slug', 'https://example.com', 'Test')
      `).run();
    }).toThrow();
  });
});
