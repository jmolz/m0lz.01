import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import {
  SCHEMA_VERSION,
  SCHEMA_V1_SQL,
  SCHEMA_V2_SQL,
} from '../src/core/db/schema.js';

let tempDir: string | undefined;
let db: Database.Database | undefined;

afterEach(() => {
  if (db) closeDatabase(db);
  db = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function objectExists(
  database: Database.Database,
  type: 'table' | 'index',
  name: string,
): boolean {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name = ?`)
    .get(type, name);
  return !!row;
}

function tableHasColumn(
  database: Database.Database,
  table: string,
  column: string,
): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`tableHasColumn: invalid table identifier '${table}'`);
  }
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.some((r) => r.name === column);
}

describe('schema migration v3 — fresh init', () => {
  it('fresh DB opens at the current SCHEMA_VERSION with all new tables and indexes', () => {
    db = getDatabase(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    // Guard against silent schema drift: bumping SCHEMA_VERSION without
    // adding a migration or without updating the assertions in this file
    // would regress the migration gate. Update this literal in lockstep
    // with SCHEMA_VERSION.
    expect(SCHEMA_VERSION).toBe(4);

    expect(objectExists(db, 'table', 'pipeline_steps')).toBe(true);
    expect(tableHasColumn(db, 'pipeline_steps', 'cycle_id')).toBe(true);

    expect(objectExists(db, 'table', 'update_cycles')).toBe(true);
    expect(objectExists(db, 'index', 'idx_update_cycles_open')).toBe(true);

    expect(objectExists(db, 'table', 'unpublish_steps')).toBe(true);

    // v4: DB-authoritative agent-plan execution state.
    expect(objectExists(db, 'table', 'agent_plan_runs')).toBe(true);
    expect(objectExists(db, 'table', 'agent_plan_steps')).toBe(true);
    expect(tableHasColumn(db, 'agent_plan_runs', 'plan_payload_hash')).toBe(true);
    expect(tableHasColumn(db, 'agent_plan_steps', 'args_json')).toBe(true);
  });

  it('pipeline_steps.cycle_id defaults to 0 on INSERT without cycle_id', () => {
    db = getDatabase(':memory:');
    db.prepare(
      `INSERT INTO posts (slug, phase, mode) VALUES ('p1', 'publish', 'directed')`,
    ).run();
    db.prepare(
      `INSERT INTO pipeline_steps (post_slug, step_number, step_name, status)
       VALUES ('p1', 1, 'verify', 'pending')`,
    ).run();

    const row = db
      .prepare(`SELECT cycle_id FROM pipeline_steps WHERE post_slug = ?`)
      .get('p1') as { cycle_id: number };
    expect(row.cycle_id).toBe(0);
  });

  it('composite UNIQUE(post_slug, cycle_id, step_name) enforced — same cycle duplicate rejected', () => {
    db = getDatabase(':memory:');
    db.prepare(
      `INSERT INTO posts (slug, phase, mode) VALUES ('p1', 'publish', 'directed')`,
    ).run();
    db.prepare(
      `INSERT INTO pipeline_steps (post_slug, step_number, step_name, status, cycle_id)
       VALUES ('p1', 1, 'verify', 'pending', 0)`,
    ).run();

    expect(() => {
      db!.prepare(
        `INSERT INTO pipeline_steps (post_slug, step_number, step_name, status, cycle_id)
         VALUES ('p1', 1, 'verify', 'pending', 0)`,
      ).run();
    }).toThrow();
  });

  it('same step_name across different cycles is allowed', () => {
    db = getDatabase(':memory:');
    db.prepare(
      `INSERT INTO posts (slug, phase, mode) VALUES ('p1', 'publish', 'directed')`,
    ).run();
    db.prepare(
      `INSERT INTO pipeline_steps (post_slug, step_number, step_name, status, cycle_id)
       VALUES ('p1', 1, 'verify', 'completed', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO pipeline_steps (post_slug, step_number, step_name, status, cycle_id)
       VALUES ('p1', 1, 'verify', 'pending', 1)`,
    ).run();

    const rows = db
      .prepare(
        `SELECT cycle_id, status FROM pipeline_steps WHERE post_slug = ? ORDER BY cycle_id`,
      )
      .all('p1') as Array<{ cycle_id: number; status: string }>;
    expect(rows).toEqual([
      { cycle_id: 0, status: 'completed' },
      { cycle_id: 1, status: 'pending' },
    ]);
  });

  it('partial unique index rejects a second open update cycle for the same post', () => {
    db = getDatabase(':memory:');
    db.prepare(
      `INSERT INTO posts (slug, phase, mode) VALUES ('p1', 'published', 'directed')`,
    ).run();
    db.prepare(
      `INSERT INTO update_cycles (post_slug, cycle_number) VALUES ('p1', 1)`,
    ).run();

    expect(() => {
      db!.prepare(
        `INSERT INTO update_cycles (post_slug, cycle_number) VALUES ('p1', 2)`,
      ).run();
    }).toThrow(/UNIQUE/i);
  });

  it('partial unique index allows a new open cycle after the prior one closed', () => {
    db = getDatabase(':memory:');
    db.prepare(
      `INSERT INTO posts (slug, phase, mode) VALUES ('p1', 'published', 'directed')`,
    ).run();
    db.prepare(
      `INSERT INTO update_cycles (post_slug, cycle_number, closed_at, ended_reason)
       VALUES ('p1', 1, CURRENT_TIMESTAMP, 'completed')`,
    ).run();

    const info = db
      .prepare(`INSERT INTO update_cycles (post_slug, cycle_number) VALUES ('p1', 2)`)
      .run();
    expect(info.changes).toBe(1);
  });

  it('update_cycles.ended_reason CHECK rejects bogus values', () => {
    db = getDatabase(':memory:');
    db.prepare(
      `INSERT INTO posts (slug, phase, mode) VALUES ('p1', 'published', 'directed')`,
    ).run();
    expect(() => {
      db!.prepare(
        `INSERT INTO update_cycles (post_slug, cycle_number, closed_at, ended_reason)
         VALUES ('p1', 1, CURRENT_TIMESTAMP, 'BOGUS')`,
      ).run();
    }).toThrow();
  });

  it('unpublish_steps UNIQUE(post_slug, step_name) rejects duplicates', () => {
    db = getDatabase(':memory:');
    db.prepare(
      `INSERT INTO posts (slug, phase, mode) VALUES ('p1', 'published', 'directed')`,
    ).run();
    db.prepare(
      `INSERT INTO unpublish_steps (post_slug, step_number, step_name, status)
       VALUES ('p1', 1, 'devto-unpublish', 'pending')`,
    ).run();

    expect(() => {
      db!.prepare(
        `INSERT INTO unpublish_steps (post_slug, step_number, step_name, status)
         VALUES ('p1', 1, 'devto-unpublish', 'pending')`,
      ).run();
    }).toThrow(/UNIQUE/i);
  });
});

describe('schema migration v1 -> v3', () => {
  it('migrates a seeded v1 DB to v3 preserving all data with cycle_id=0', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'db-mig-v3-'));
    const dbPath = join(tempDir, 'test.db');

    const staging = new Database(dbPath);
    staging.pragma('journal_mode = WAL');
    staging.pragma('foreign_keys = ON');
    staging.exec(SCHEMA_V1_SQL);
    staging
      .prepare(
        `INSERT INTO posts (slug, title, phase, mode)
         VALUES ('seed-1', 'Seed', 'publish', 'directed')`,
      )
      .run();
    staging
      .prepare(
        `INSERT INTO sources (post_slug, url, title)
         VALUES ('seed-1', 'https://a.com', 'A')`,
      )
      .run();
    staging
      .prepare(
        `INSERT INTO pipeline_steps (post_slug, step_number, step_name, status)
         VALUES ('seed-1', 1, 'verify', 'completed'),
                ('seed-1', 2, 'research-page', 'skipped'),
                ('seed-1', 3, 'site-pr', 'pending')`,
      )
      .run();
    staging.pragma('user_version = 1');
    staging.close();

    db = getDatabase(dbPath);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    expect(tableHasColumn(db, 'pipeline_steps', 'cycle_id')).toBe(true);
    expect(objectExists(db, 'table', 'update_cycles')).toBe(true);
    expect(objectExists(db, 'table', 'unpublish_steps')).toBe(true);
    expect(objectExists(db, 'index', 'idx_update_cycles_open')).toBe(true);
    expect(objectExists(db, 'index', 'idx_sources_post_url')).toBe(true);

    const post = db
      .prepare(`SELECT slug, phase FROM posts WHERE slug = ?`)
      .get('seed-1') as { slug: string; phase: string };
    expect(post).toEqual({ slug: 'seed-1', phase: 'publish' });

    const sourceCount = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM sources WHERE post_slug = ?`)
        .get('seed-1') as { c: number }
    ).c;
    expect(sourceCount).toBe(1);

    const stepRows = db
      .prepare(
        `SELECT step_name, status, cycle_id FROM pipeline_steps WHERE post_slug = ? ORDER BY step_number`,
      )
      .all('seed-1') as Array<{ step_name: string; status: string; cycle_id: number }>;
    expect(stepRows).toEqual([
      { step_name: 'verify', status: 'completed', cycle_id: 0 },
      { step_name: 'research-page', status: 'skipped', cycle_id: 0 },
      { step_name: 'site-pr', status: 'pending', cycle_id: 0 },
    ]);
  });
});

describe('schema migration v2 -> v3', () => {
  it('migrates a seeded v2 DB to v3 preserving pipeline_steps with cycle_id=0', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'db-mig-v3-'));
    const dbPath = join(tempDir, 'test.db');

    const staging = new Database(dbPath);
    staging.pragma('journal_mode = WAL');
    staging.pragma('foreign_keys = ON');
    staging.exec(SCHEMA_V1_SQL);
    staging.exec(SCHEMA_V2_SQL);
    staging
      .prepare(
        `INSERT INTO posts (slug, phase, mode) VALUES ('s2', 'publish', 'directed')`,
      )
      .run();
    staging
      .prepare(
        `INSERT INTO pipeline_steps (post_slug, step_number, step_name, status)
         VALUES ('s2', 1, 'verify', 'completed')`,
      )
      .run();
    staging.pragma('user_version = 2');
    staging.close();

    db = getDatabase(dbPath);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    const row = db
      .prepare(
        `SELECT step_name, status, cycle_id FROM pipeline_steps WHERE post_slug = ?`,
      )
      .get('s2') as { step_name: string; status: string; cycle_id: number };
    expect(row).toEqual({ step_name: 'verify', status: 'completed', cycle_id: 0 });
  });
});

describe('schema migration idempotency', () => {
  it('re-opening a v3 DB does not re-run the migration', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'db-mig-v3-'));
    const dbPath = join(tempDir, 'test.db');

    db = getDatabase(dbPath);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    closeDatabase(db);

    db = getDatabase(dbPath);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    expect(tableHasColumn(db, 'pipeline_steps', 'cycle_id')).toBe(true);
    expect(objectExists(db, 'table', 'update_cycles')).toBe(true);
    expect(objectExists(db, 'table', 'unpublish_steps')).toBe(true);
  });

  it('preserves foreign_keys=ON after the v3 rebuild', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'db-mig-v3-'));
    const dbPath = join(tempDir, 'test.db');

    db = getDatabase(dbPath);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
