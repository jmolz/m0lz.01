import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { addSource, listSources, countSources } from '../src/core/research/sources.js';

let db: Database.Database;

beforeEach(() => {
  db = getDatabase(':memory:');
  db.prepare(`
    INSERT INTO posts (slug, title, topic, content_type, phase, mode)
    VALUES ('test-slug', 'Test', 'test topic', 'technical-deep-dive', 'research', 'directed')
  `).run();
});

afterEach(() => {
  if (db) closeDatabase(db);
});

describe('addSource', () => {
  it('inserts a new source and returns inserted=true', () => {
    const result = addSource(db, 'test-slug', 'https://example.com', {
      title: 'Example',
      excerpt: 'baseline claim',
    });
    expect(result.inserted).toBe(true);
    expect(result.id).toBeGreaterThan(0);
    expect(countSources(db, 'test-slug')).toBe(1);
  });

  it('dedupes by (post_slug, url) and returns inserted=false on repeat', () => {
    const first = addSource(db, 'test-slug', 'https://example.com');
    const second = addSource(db, 'test-slug', 'https://example.com');

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
    expect(countSources(db, 'test-slug')).toBe(1);
  });

  it('allows the same URL across different posts', () => {
    db.prepare(`
      INSERT INTO posts (slug, phase, mode)
      VALUES ('other-slug', 'research', 'directed')
    `).run();

    addSource(db, 'test-slug', 'https://example.com');
    const result = addSource(db, 'other-slug', 'https://example.com');

    expect(result.inserted).toBe(true);
    expect(countSources(db, 'test-slug')).toBe(1);
    expect(countSources(db, 'other-slug')).toBe(1);
  });

  it('throws with the slug in the message when post is missing', () => {
    expect(() => addSource(db, 'nonexistent-slug', 'https://example.com'))
      .toThrow(/nonexistent-slug/);
  });

  it('persists source_type correctly for each value', () => {
    addSource(db, 'test-slug', 'https://a.com', { sourceType: 'external' });
    addSource(db, 'test-slug', 'https://b.com', { sourceType: 'primary' });
    addSource(db, 'test-slug', 'https://c.com', { sourceType: 'benchmark' });

    const rows = listSources(db, 'test-slug');
    const types = rows.map((r) => r.source_type).sort();
    expect(types).toEqual(['benchmark', 'external', 'primary']);
  });

  it('defaults source_type to external when not provided', () => {
    addSource(db, 'test-slug', 'https://x.com');
    const [row] = listSources(db, 'test-slug');
    expect(row.source_type).toBe('external');
  });
});

describe('listSources', () => {
  it('returns rows ordered by accessed_at ASC, then id ASC', () => {
    addSource(db, 'test-slug', 'https://a.com');
    addSource(db, 'test-slug', 'https://b.com');
    addSource(db, 'test-slug', 'https://c.com');

    const rows = listSources(db, 'test-slug');
    expect(rows.map((r) => r.url)).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
  });

  it('returns empty array for a post with no sources', () => {
    expect(listSources(db, 'test-slug')).toEqual([]);
  });
});

describe('countSources', () => {
  it('counts sources for a given slug', () => {
    addSource(db, 'test-slug', 'https://a.com');
    addSource(db, 'test-slug', 'https://b.com');
    expect(countSources(db, 'test-slug')).toBe(2);
  });

  it('returns 0 for unknown slug', () => {
    expect(countSources(db, 'unknown')).toBe(0);
  });
});

describe('phase boundary', () => {
  it('addSource rejects posts not in research phase', () => {
    db.prepare("UPDATE posts SET phase = 'draft' WHERE slug = 'test-slug'").run();
    expect(() => addSource(db, 'test-slug', 'https://example.com'))
      .toThrow(/not 'research'/);
  });
});
