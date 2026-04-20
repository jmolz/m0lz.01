import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { runStatus } from '../src/cli/status.js';
import { runPublishShow } from '../src/cli/publish.js';
import { runUpdateShow } from '../src/cli/update.js';
import { runUnpublishShow } from '../src/cli/unpublish.js';
import { runEvaluateShow } from '../src/cli/evaluate.js';

type Captured = { stdout: string[] };

function captureStdout(): Captured {
  const captured: Captured = { stdout: [] };
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    captured.stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return captured;
}

function parseEnvelope(cap: Captured): { schema_version: string; kind: string; generated_at: string; data: unknown } {
  const joined = cap.stdout.join('');
  return JSON.parse(joined);
}

let db: Database.Database;
let tempDir: string;

afterEach(() => {
  if (db) closeDatabase(db);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function setupDb(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'blog-cli-json-'));
  const dbPath = join(tempDir, 'state.db');
  db = getDatabase(dbPath);
  return dbPath;
}

describe('runStatus --json', () => {
  it('emits a WorkspaceStatus envelope with versioned schema', () => {
    const dbPath = setupDb();
    db.prepare(`
      INSERT INTO posts (slug, title, phase, mode, site_url, content_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('alpha', 'Alpha', 'published', 'imported', 'https://m0lz.dev/writing/alpha', 'project-launch');
    closeDatabase(db);
    db = undefined as unknown as Database.Database;

    const cap = captureStdout();
    runStatus({ dbPath, json: true });
    const env = parseEnvelope(cap);

    expect(env.schema_version).toBe('1');
    expect(env.kind).toBe('WorkspaceStatus');
    expect(typeof env.generated_at).toBe('string');
    const data = env.data as {
      workspace_root: string;
      posts: { slug: string; phase: string }[];
      totals: { total: number; published: number; in_progress: number };
    };
    expect(data.posts.length).toBe(1);
    expect(data.posts[0].slug).toBe('alpha');
    expect(data.totals).toEqual({ total: 1, published: 1, in_progress: 0 });
    expect(typeof data.workspace_root).toBe('string');
  });

  it('emits empty-state envelope when no DB exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-cli-json-nodb-'));
    const cap = captureStdout();
    runStatus({ dbPath: join(tempDir, 'missing.db'), json: true });
    const env = parseEnvelope(cap);
    expect(env.kind).toBe('WorkspaceStatus');
    expect((env.data as { posts: unknown[] }).posts).toEqual([]);
  });
});

describe('runPublishShow --json', () => {
  it('emits a PublishPipeline envelope', () => {
    const dbPath = setupDb();
    db.prepare(`
      INSERT INTO posts (slug, title, phase, mode, site_url, content_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('pub-test', 'Pub Test', 'published', 'directed', 'https://m0lz.dev/writing/pub-test', 'technical-deep-dive');
    db.prepare(`
      INSERT INTO pipeline_steps (post_slug, step_number, step_name, status, started_at, completed_at)
      VALUES ('pub-test', 1, 'prepare', 'completed', '2026-04-01T00:00:00Z', '2026-04-01T00:01:00Z')
    `).run();
    closeDatabase(db);
    db = undefined as unknown as Database.Database;

    const cap = captureStdout();
    runPublishShow('pub-test', { dbPath, json: true });
    const env = parseEnvelope(cap);

    expect(env.schema_version).toBe('1');
    expect(env.kind).toBe('PublishPipeline');
    const data = env.data as { slug: string; phase: string; steps: unknown[] };
    expect(data.slug).toBe('pub-test');
    expect(data.phase).toBe('published');
    expect(data.steps.length).toBe(1);
  });
});

describe('runUpdateShow --json', () => {
  it('emits an UpdatePipeline envelope with cycles', () => {
    const dbPath = setupDb();
    db.prepare(`
      INSERT INTO posts (slug, title, phase, mode, site_url, content_type, update_count, last_updated_at, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('upd-test', 'Upd Test', 'published', 'directed', 'https://m0lz.dev/writing/upd-test', 'project-launch', 0, null, '2026-03-01T00:00:00Z');
    closeDatabase(db);
    db = undefined as unknown as Database.Database;

    const cap = captureStdout();
    runUpdateShow('upd-test', { dbPath, json: true });
    const env = parseEnvelope(cap);

    expect(env.kind).toBe('UpdatePipeline');
    const data = env.data as { slug: string; cycles: unknown[]; open_cycle_id: number | null };
    expect(data.slug).toBe('upd-test');
    expect(data.cycles).toEqual([]);
    expect(data.open_cycle_id).toBeNull();
  });
});

describe('runUnpublishShow --json', () => {
  it('emits an UnpublishPipeline envelope', () => {
    const dbPath = setupDb();
    db.prepare(`
      INSERT INTO posts (slug, title, phase, mode, site_url, content_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('unp-test', 'Unp Test', 'published', 'directed', 'https://m0lz.dev/writing/unp-test', 'project-launch');
    closeDatabase(db);
    db = undefined as unknown as Database.Database;

    const cap = captureStdout();
    runUnpublishShow('unp-test', { dbPath, json: true });
    const env = parseEnvelope(cap);

    expect(env.kind).toBe('UnpublishPipeline');
    const data = env.data as { slug: string; steps: unknown[] };
    expect(data.slug).toBe('unp-test');
    expect(data.steps).toEqual([]);
  });
});

describe('runEvaluateShow --json', () => {
  it('emits an EvaluationState envelope when no manifest exists', () => {
    const dbPath = setupDb();
    db.prepare(`
      INSERT INTO posts (slug, title, phase, mode, site_url, content_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('eval-test', 'Eval Test', 'evaluate', 'directed', 'https://m0lz.dev/writing/eval-test', 'technical-deep-dive');
    closeDatabase(db);
    db = undefined as unknown as Database.Database;

    tempDir = tempDir ?? mkdtempSync(join(tmpdir(), 'blog-cli-json-'));
    const evalDir = join(tempDir, 'evaluations');

    const cap = captureStdout();
    runEvaluateShow('eval-test', { dbPath, evaluationsDir: evalDir, json: true });
    const env = parseEnvelope(cap);

    expect(env.kind).toBe('EvaluationState');
    const data = env.data as { slug: string; manifest_readable: boolean; verdict: string | null };
    expect(data.slug).toBe('eval-test');
    expect(data.manifest_readable).toBe(false);
    expect(data.verdict).toBeNull();
  });
});
