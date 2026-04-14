import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { initResearchPost, getResearchPost, advancePhase } from '../src/core/research/state.js';

let db: Database.Database;

beforeEach(() => {
  db = getDatabase(':memory:');
});

afterEach(() => {
  if (db) closeDatabase(db);
});

describe('initResearchPost', () => {
  it('creates a new row with phase=research and returns created=true', () => {
    const result = initResearchPost(db, 'new-slug', 'a topic', 'directed', 'technical-deep-dive');
    expect(result.created).toBe(true);
    expect(result.post.slug).toBe('new-slug');
    expect(result.post.phase).toBe('research');
    expect(result.post.mode).toBe('directed');
    expect(result.post.content_type).toBe('technical-deep-dive');
    expect(result.post.topic).toBe('a topic');
  });

  it('returns created=false and leaves row unchanged on re-init', () => {
    initResearchPost(db, 'dup-slug', 'first topic', 'directed', 'technical-deep-dive');
    const result = initResearchPost(db, 'dup-slug', 'second topic', 'exploratory', 'analysis-opinion');

    expect(result.created).toBe(false);
    // Original row survives: topic, mode, content_type all unchanged
    expect(result.post.topic).toBe('first topic');
    expect(result.post.mode).toBe('directed');
    expect(result.post.content_type).toBe('technical-deep-dive');
  });
});

describe('getResearchPost', () => {
  it('returns the row when present', () => {
    initResearchPost(db, 'a', 'topic', 'directed', 'technical-deep-dive');
    const post = getResearchPost(db, 'a');
    expect(post?.slug).toBe('a');
  });

  it('returns undefined when absent', () => {
    expect(getResearchPost(db, 'missing')).toBeUndefined();
  });
});

describe('advancePhase', () => {
  it('updates phase and bumps updated_at', () => {
    initResearchPost(db, 'a', 'topic', 'directed', 'technical-deep-dive');
    const before = getResearchPost(db, 'a');

    // Force updated_at to an older timestamp so we can detect the bump
    db.prepare(`UPDATE posts SET updated_at = '2020-01-01 00:00:00' WHERE slug = ?`).run('a');

    advancePhase(db, 'a', 'benchmark');

    const after = getResearchPost(db, 'a');
    expect(after?.phase).toBe('benchmark');
    expect(after?.updated_at).not.toBe('2020-01-01 00:00:00');
    expect(before?.phase).toBe('research');
  });

  it('throws when phase is invalid (before touching DB)', () => {
    initResearchPost(db, 'a', 'topic', 'directed', 'technical-deep-dive');
    // @ts-expect-error -- intentionally invalid
    expect(() => advancePhase(db, 'a', 'not-a-phase')).toThrow(/Invalid phase/);
    const post = getResearchPost(db, 'a');
    expect(post?.phase).toBe('research');
  });

  it('throws when slug does not exist', () => {
    expect(() => advancePhase(db, 'missing', 'benchmark')).toThrow(/not found/);
  });
});
