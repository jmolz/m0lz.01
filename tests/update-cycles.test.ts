import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import {
  openUpdateCycle,
  getOpenUpdateCycle,
  closeUpdateCycle,
  listUpdateCycles,
  requirePublishedPost,
} from '../src/core/update/cycles.js';

let db: Database.Database | undefined;

afterEach(() => {
  if (db) closeDatabase(db);
  db = undefined;
});

function seedPost(database: Database.Database, slug: string, phase: string): void {
  database
    .prepare(`INSERT INTO posts (slug, phase, mode) VALUES (?, ?, 'directed')`)
    .run(slug, phase);
}

describe('openUpdateCycle', () => {
  it('opens cycle 1 for a published post and writes metrics', () => {
    db = getDatabase(':memory:');
    seedPost(db, 'post1', 'published');

    const cycle = openUpdateCycle(db, 'post1', 'Re-run 2026 benchmarks');
    expect(cycle.id).toBeTypeOf('number');
    expect(cycle.post_slug).toBe('post1');
    expect(cycle.cycle_number).toBe(1);
    expect(cycle.summary).toBe('Re-run 2026 benchmarks');
    expect(cycle.closed_at).toBeNull();
    expect(cycle.ended_reason).toBeNull();

    const metrics = db
      .prepare(`SELECT event, value FROM metrics WHERE post_slug = ?`)
      .all('post1') as Array<{ event: string; value: string | null }>;
    expect(metrics).toEqual([{ event: 'update_opened', value: '1' }]);
  });

  it('computes cycle_number = MAX + 1 across closed cycles', () => {
    db = getDatabase(':memory:');
    seedPost(db, 'post1', 'published');

    const first = openUpdateCycle(db, 'post1', 'v1');
    closeUpdateCycle(db, first.id, 'completed');
    const second = openUpdateCycle(db, 'post1', 'v2');
    closeUpdateCycle(db, second.id, 'aborted');
    const third = openUpdateCycle(db, 'post1', 'v3');

    expect(first.cycle_number).toBe(1);
    expect(second.cycle_number).toBe(2);
    expect(third.cycle_number).toBe(3);
  });

  it('rejects posts that are not in published phase', () => {
    db = getDatabase(':memory:');
    seedPost(db, 'draft-post', 'draft');
    expect(() => openUpdateCycle(db!, 'draft-post', 'x')).toThrow(/'draft'.*'published'/);
  });

  it('rejects missing posts', () => {
    db = getDatabase(':memory:');
    expect(() => openUpdateCycle(db!, 'nope', 'x')).toThrow(/Post not found/);
  });

  it('rejects when an open cycle already exists', () => {
    db = getDatabase(':memory:');
    seedPost(db, 'post1', 'published');
    openUpdateCycle(db, 'post1', 'first');
    expect(() => openUpdateCycle(db!, 'post1', 'second')).toThrow(
      /already has an open update cycle/,
    );
  });

  it('permits null summary', () => {
    db = getDatabase(':memory:');
    seedPost(db, 'post1', 'published');
    const cycle = openUpdateCycle(db, 'post1', null);
    expect(cycle.summary).toBeNull();
  });
});

describe('getOpenUpdateCycle', () => {
  it('returns null when no cycle has been opened', () => {
    db = getDatabase(':memory:');
    seedPost(db, 'post1', 'published');
    expect(getOpenUpdateCycle(db, 'post1')).toBeNull();
  });

  it('returns the open cycle when one exists', () => {
    db = getDatabase(':memory:');
    seedPost(db, 'post1', 'published');
    const opened = openUpdateCycle(db, 'post1', 'sum');
    const got = getOpenUpdateCycle(db, 'post1');
    expect(got?.id).toBe(opened.id);
    expect(got?.cycle_number).toBe(1);
  });

  it('returns null after the cycle closes', () => {
    db = getDatabase(':memory:');
    seedPost(db, 'post1', 'published');
    const opened = openUpdateCycle(db, 'post1', 'sum');
    closeUpdateCycle(db, opened.id, 'completed');
    expect(getOpenUpdateCycle(db, 'post1')).toBeNull();
  });
});

describe('closeUpdateCycle', () => {
  it("writes 'update_aborted' metrics when reason='aborted'", () => {
    db = getDatabase(':memory:');
    seedPost(db, 'post1', 'published');
    const opened = openUpdateCycle(db, 'post1', 'x');
    closeUpdateCycle(db, opened.id, 'aborted');

    const events = db
      .prepare(`SELECT event FROM metrics WHERE post_slug = ? ORDER BY id`)
      .all('post1') as Array<{ event: string }>;
    expect(events.map((e) => e.event)).toEqual(['update_opened', 'update_aborted']);

    const row = db
      .prepare(`SELECT ended_reason, closed_at FROM update_cycles WHERE id = ?`)
      .get(opened.id) as { ended_reason: string; closed_at: string };
    expect(row.ended_reason).toBe('aborted');
    expect(row.closed_at).not.toBeNull();
  });

  it("does NOT write 'update_completed' metrics on reason='completed' (owned by finalizer)", () => {
    db = getDatabase(':memory:');
    seedPost(db, 'post1', 'published');
    const opened = openUpdateCycle(db, 'post1', 'x');
    closeUpdateCycle(db, opened.id, 'completed');

    const events = db
      .prepare(`SELECT event FROM metrics WHERE post_slug = ? ORDER BY id`)
      .all('post1') as Array<{ event: string }>;
    expect(events.map((e) => e.event)).toEqual(['update_opened']);
  });

  it('rejects closing a cycle that is already closed', () => {
    db = getDatabase(':memory:');
    seedPost(db, 'post1', 'published');
    const opened = openUpdateCycle(db, 'post1', 'x');
    closeUpdateCycle(db, opened.id, 'completed');
    expect(() => closeUpdateCycle(db!, opened.id, 'aborted')).toThrow(/already closed/);
  });

  it('rejects closing a non-existent cycle', () => {
    db = getDatabase(':memory:');
    expect(() => closeUpdateCycle(db!, 99999, 'completed')).toThrow(/not found/);
  });
});

describe('listUpdateCycles', () => {
  it('returns cycles in cycle_number order', () => {
    db = getDatabase(':memory:');
    seedPost(db, 'post1', 'published');

    const c1 = openUpdateCycle(db, 'post1', 'first');
    closeUpdateCycle(db, c1.id, 'completed');
    const c2 = openUpdateCycle(db, 'post1', 'second');

    const all = listUpdateCycles(db, 'post1');
    expect(all).toHaveLength(2);
    expect(all[0].cycle_number).toBe(1);
    expect(all[0].ended_reason).toBe('completed');
    expect(all[1].cycle_number).toBe(2);
    expect(all[1].ended_reason).toBeNull();
  });
});

describe('requirePublishedPost', () => {
  it('returns the post when phase=published', () => {
    db = getDatabase(':memory:');
    seedPost(db, 'post1', 'published');
    const post = requirePublishedPost(db, 'post1');
    expect(post.slug).toBe('post1');
  });

  it('throws on any other phase', () => {
    db = getDatabase(':memory:');
    seedPost(db, 'draft-post', 'draft');
    expect(() => requirePublishedPost(db!, 'draft-post')).toThrow(/'draft'.*'published'/);
  });

  it('throws when post is missing', () => {
    db = getDatabase(':memory:');
    expect(() => requirePublishedPost(db!, 'nope')).toThrow(/not found/);
  });
});
