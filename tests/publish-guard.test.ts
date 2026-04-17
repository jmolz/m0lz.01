import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { runPublishStart } from '../src/cli/publish.js';
import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { openUpdateCycle } from '../src/core/update/cycles.js';

let tempDir: string;
let dbPath: string;
let db: Database.Database | undefined;

afterEach(() => {
  if (db) closeDatabase(db);
  db = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function setup(): void {
  tempDir = mkdtempSync(join(tmpdir(), 'publish-guard-'));
  dbPath = join(tempDir, 'state.db');
  const configPath = join(tempDir, '.blogrc.yaml');
  writeFileSync(
    configPath,
    `site:\n  repo_path: "${tempDir}/site"\n  base_url: "https://x"\nauthor:\n  name: T\n  github: t\n`,
  );
  db = getDatabase(dbPath);
  db.prepare(
    `INSERT INTO posts (slug, phase, mode, content_type)
     VALUES ('post1', 'published', 'directed', 'technical-deep-dive')`,
  ).run();
  openUpdateCycle(db, 'post1', 'Updating benchmarks');
  closeDatabase(db);
  db = undefined;
}

describe('blog publish start — open-update-cycle guard', () => {
  it('refuses with exit code 1 when an open update cycle exists', async () => {
    setup();

    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg: string) => {
      errors.push(msg);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const savedExitCode = process.exitCode;
    try {
      await runPublishStart('post1', {
        dbPath,
        configPath: join(tempDir, '.blogrc.yaml'),
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = savedExitCode;
    }

    const joined = errors.join('\n');
    expect(joined).toMatch(/open update cycle exists/);
    expect(joined).toMatch(/blog update publish/);
    expect(joined).toMatch(/blog update abort/);
  });

  it('does not create any pipeline_steps rows', async () => {
    setup();

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const savedExitCode = process.exitCode;
    try {
      await runPublishStart('post1', {
        dbPath,
        configPath: join(tempDir, '.blogrc.yaml'),
      });
    } finally {
      process.exitCode = savedExitCode;
    }

    db = getDatabase(dbPath);
    const count = (
      db.prepare('SELECT COUNT(*) AS c FROM pipeline_steps WHERE post_slug = ?').get('post1') as { c: number }
    ).c;
    expect(count).toBe(0);
  });
});
