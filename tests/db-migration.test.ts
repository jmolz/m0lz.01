import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { SCHEMA_VERSION, SCHEMA_V1_SQL } from '../src/core/db/schema.js';

let tempDir: string | undefined;
let db: Database.Database | undefined;

afterEach(() => {
  if (db) closeDatabase(db);
  db = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function indexExists(database: Database.Database, name: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name);
  return !!row;
}

describe('schema migration v1 to v2', () => {
  it('fresh DB opens at SCHEMA_VERSION with the unique source index', () => {
    db = getDatabase(':memory:');
    const version = db.pragma('user_version', { simple: true });
    expect(version).toBe(SCHEMA_VERSION);
    // SCHEMA_VERSION itself is verified against the current expected value in
    // db-migration-v3.test.ts; this test only enforces that the fresh DB
    // always matches SCHEMA_VERSION, whatever its current integer is.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
    expect(indexExists(db, 'idx_sources_post_url')).toBe(true);
  });

  it('upgrades a seeded v1 DB to v2 while preserving data', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'db-mig-'));
    const dbPath = join(tempDir, 'test.db');

    // Manually stage a v1 DB: schema + user_version=1 + seed data
    const staging = new Database(dbPath);
    staging.pragma('journal_mode = WAL');
    staging.pragma('foreign_keys = ON');
    staging.exec(SCHEMA_V1_SQL);
    staging.prepare(`
      INSERT INTO posts (slug, title, phase, mode)
      VALUES ('seed-1', 'Seed', 'research', 'directed')
    `).run();
    staging.prepare(`
      INSERT INTO sources (post_slug, url, title)
      VALUES ('seed-1', 'https://a.com', 'A'), ('seed-1', 'https://b.com', 'B')
    `).run();
    staging.pragma('user_version = 1');
    staging.close();

    // Re-open via the library: it migrates past v1 to the current
    // SCHEMA_VERSION. This test's original intent is the v1 -> v2 step; the
    // v2 -> v3 step is exercised in db-migration-v3.test.ts.
    db = getDatabase(dbPath);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(indexExists(db, 'idx_sources_post_url')).toBe(true);

    // Data preserved
    const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get('seed-1') as { slug: string };
    expect(post?.slug).toBe('seed-1');
    const countRow = db.prepare('SELECT COUNT(*) AS c FROM sources WHERE post_slug = ?')
      .get('seed-1') as { c: number };
    expect(countRow.c).toBe(2);

    // New unique constraint enforced
    const upgraded = db;
    expect(() => {
      upgraded.prepare(`INSERT INTO sources (post_slug, url, title) VALUES ('seed-1', 'https://a.com', 'dup')`).run();
    }).toThrow();
  });

  it('re-opening a DB does not re-run the migration', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'db-mig-'));
    const dbPath = join(tempDir, 'test.db');

    db = getDatabase(dbPath);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    closeDatabase(db);

    db = getDatabase(dbPath);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(indexExists(db, 'idx_sources_post_url')).toBe(true);
  });
});
