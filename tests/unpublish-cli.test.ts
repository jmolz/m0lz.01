import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runUnpublishStart, runUnpublishShow } from '../src/cli/unpublish.js';
import { getDatabase, closeDatabase } from '../src/core/db/database.js';

let tempDir: string;
let dbPath: string;
let configPath: string;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function setup(phase: 'published' | 'draft' = 'published'): void {
  tempDir = mkdtempSync(join(tmpdir(), 'unpub-cli-'));
  dbPath = join(tempDir, 'state.db');
  configPath = join(tempDir, '.blogrc.yaml');
  writeFileSync(
    configPath,
    `site:\n  repo_path: "${tempDir}/site"\n  base_url: "https://x"\nauthor:\n  name: T\n  github: t\n`,
  );
  const db = getDatabase(dbPath);
  db.prepare(
    `INSERT INTO posts (slug, phase, mode, content_type) VALUES ('post1', ?, 'directed', 'technical-deep-dive')`,
  ).run(phase);
  closeDatabase(db);
}

describe('blog unpublish start', () => {
  it('refuses without --confirm and writes no rows', async () => {
    setup();
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg: string) => {
      errors.push(msg);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const savedExit = process.exitCode;
    try {
      await runUnpublishStart('post1', { confirm: false }, { dbPath, configPath });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = savedExit;
    }

    expect(errors.join('\n')).toMatch(/--confirm/);

    const db = getDatabase(dbPath);
    const count = (
      db.prepare(`SELECT COUNT(*) AS c FROM unpublish_steps WHERE post_slug = ?`).get('post1') as { c: number }
    ).c;
    closeDatabase(db);
    expect(count).toBe(0);
  });

  it('rejects non-published posts with phase-boundary error', async () => {
    setup('draft');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg: string) => {
      errors.push(msg);
    });

    const savedExit = process.exitCode;
    try {
      await runUnpublishStart('post1', { confirm: true }, { dbPath, configPath });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = savedExit;
    }
    expect(errors.join('\n')).toMatch(/'draft'.*'published'/);

    const db = getDatabase(dbPath);
    const count = (
      db.prepare(`SELECT COUNT(*) AS c FROM unpublish_steps WHERE post_slug = ?`).get('post1') as { c: number }
    ).c;
    closeDatabase(db);
    expect(count).toBe(0);
  });
});

describe('blog unpublish show', () => {
  it('renders post status and reports no steps yet when not started', () => {
    setup();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg);
    });

    runUnpublishShow('post1', { dbPath });

    const joined = logs.join('\n');
    expect(joined).toMatch(/slug: *post1/);
    expect(joined).toMatch(/phase: *published/);
    expect(joined).toMatch(/No unpublish steps recorded/);
  });
});
