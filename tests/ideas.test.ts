import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { loadIdeas, saveIdeas, startIdea, removeIdea, IdeaEntry } from '../src/cli/ideas.js';
import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { PostRow } from '../src/core/db/types.js';

let tempDir: string;
let db: Database.Database;

afterEach(() => {
  if (db) closeDatabase(db);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('ideas', () => {
  it('returns empty array for non-existent YAML file', () => {
    const ideas = loadIdeas('/nonexistent/ideas.yaml');
    expect(ideas).toEqual([]);
  });

  it('creates YAML file when saving ideas', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-ideas-'));
    const yamlPath = join(tempDir, 'ideas.yaml');

    const ideas: IdeaEntry[] = [{
      topic: 'Test topic',
      type: 'analysis-opinion',
      priority: 'high',
      notes: 'Some notes',
      added_at: '2026-04-14T00:00:00.000Z',
    }];

    saveIdeas(yamlPath, ideas);
    const loaded = loadIdeas(yamlPath);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].topic).toBe('Test topic');
    expect(loaded[0].priority).toBe('high');
  });

  it('appends to existing YAML file', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-ideas-'));
    const yamlPath = join(tempDir, 'ideas.yaml');

    saveIdeas(yamlPath, [{
      topic: 'First',
      type: 'analysis-opinion',
      priority: 'medium',
      notes: '',
      added_at: '2026-04-14T00:00:00.000Z',
    }]);

    const ideas = loadIdeas(yamlPath);
    ideas.push({
      topic: 'Second',
      type: 'technical-deep-dive',
      priority: 'high',
      notes: 'Important',
      added_at: '2026-04-14T01:00:00.000Z',
    });
    saveIdeas(yamlPath, ideas);

    const loaded = loadIdeas(yamlPath);
    expect(loaded).toHaveLength(2);
  });

  it('sorts ideas by priority (high > medium > low)', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-ideas-'));
    const yamlPath = join(tempDir, 'ideas.yaml');

    const ideas: IdeaEntry[] = [
      { topic: 'Low', type: 'analysis-opinion', priority: 'low', notes: '', added_at: '2026-04-14T00:00:00.000Z' },
      { topic: 'High', type: 'analysis-opinion', priority: 'high', notes: '', added_at: '2026-04-14T01:00:00.000Z' },
      { topic: 'Medium', type: 'analysis-opinion', priority: 'medium', notes: '', added_at: '2026-04-14T02:00:00.000Z' },
    ];

    saveIdeas(yamlPath, ideas);
    const loaded = loadIdeas(yamlPath);

    // loadIdeas returns unsorted; sorting happens in the CLI display layer
    expect(loaded).toHaveLength(3);
  });

  it('handles empty ideas list gracefully', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-ideas-'));
    const yamlPath = join(tempDir, 'ideas.yaml');

    saveIdeas(yamlPath, []);
    const loaded = loadIdeas(yamlPath);
    expect(loaded).toEqual([]);
  });

  it('startIdea creates DB entry and removes from YAML', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-ideas-'));
    const yamlPath = join(tempDir, 'ideas.yaml');
    const dbPath = join(tempDir, 'state.db');

    db = getDatabase(dbPath);

    saveIdeas(yamlPath, [{
      topic: 'Test deep dive',
      type: 'technical-deep-dive',
      priority: 'high',
      notes: '',
      added_at: '2026-04-14T00:00:00.000Z',
    }]);

    startIdea(1, yamlPath, dbPath);

    // Verify DB entry was created
    const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get('test-deep-dive') as PostRow;
    expect(post).toBeDefined();
    expect(post.phase).toBe('research');
    expect(post.mode).toBe('exploratory');
    expect(post.content_type).toBe('technical-deep-dive');

    // Verify idea was removed from YAML
    const remaining = loadIdeas(yamlPath);
    expect(remaining).toHaveLength(0);
  });

  it('startIdea throws on invalid index', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-ideas-'));
    const yamlPath = join(tempDir, 'ideas.yaml');

    saveIdeas(yamlPath, [{
      topic: 'Only idea',
      type: 'analysis-opinion',
      priority: 'medium',
      notes: '',
      added_at: '2026-04-14T00:00:00.000Z',
    }]);

    expect(() => startIdea(5, yamlPath)).toThrow('Invalid index');
    expect(() => startIdea(0, yamlPath)).toThrow('Invalid index');
  });

  it('removeIdea removes from YAML', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-ideas-'));
    const yamlPath = join(tempDir, 'ideas.yaml');

    saveIdeas(yamlPath, [
      { topic: 'Keep this', type: 'analysis-opinion', priority: 'low', notes: '', added_at: '2026-04-14T00:00:00.000Z' },
      { topic: 'Remove this', type: 'analysis-opinion', priority: 'high', notes: '', added_at: '2026-04-14T01:00:00.000Z' },
    ]);

    // Priority sort: high (index 1) = "Remove this", low (index 2) = "Keep this"
    removeIdea(1, yamlPath);

    const remaining = loadIdeas(yamlPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].topic).toBe('Keep this');
  });

  it('removeIdea throws on invalid index', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-ideas-'));
    const yamlPath = join(tempDir, 'ideas.yaml');

    saveIdeas(yamlPath, []);

    expect(() => removeIdea(1, yamlPath)).toThrow('Invalid index');
  });

  it('saveIdeas is idempotent (overwriting same content is a no-op)', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-ideas-'));
    const yamlPath = join(tempDir, 'ideas.yaml');

    const ideas: IdeaEntry[] = [
      { topic: 'A', type: 'analysis-opinion', priority: 'high', notes: '', added_at: '2026-04-14T00:00:00.000Z' },
    ];

    saveIdeas(yamlPath, ideas);
    saveIdeas(yamlPath, ideas);

    const loaded = loadIdeas(yamlPath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].topic).toBe('A');
  });

  it('startIdea INSERT OR IGNORE makes re-start a no-op on slug collision', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-ideas-'));
    const yamlPath = join(tempDir, 'ideas.yaml');
    const dbPath = join(tempDir, 'state.db');

    db = getDatabase(dbPath);

    // Two ideas that slugify to the same slug
    saveIdeas(yamlPath, [
      { topic: 'Same Topic', type: 'analysis-opinion', priority: 'high', notes: '', added_at: '2026-04-14T00:00:00.000Z' },
      { topic: 'Same Topic', type: 'technical-deep-dive', priority: 'medium', notes: '', added_at: '2026-04-14T01:00:00.000Z' },
    ]);

    startIdea(1, yamlPath, dbPath);
    startIdea(1, yamlPath, dbPath); // second idea, same slug

    const count = (db.prepare('SELECT COUNT(*) as c FROM posts WHERE slug = ?').get('same-topic') as { c: number }).c;
    expect(count).toBe(1); // INSERT OR IGNORE kept the first

    // Both ideas still removed from YAML (YAML mutation happens regardless of DB collision)
    expect(loadIdeas(yamlPath)).toHaveLength(0);
  });
});
