import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { importPosts } from '../src/core/migrate/import-posts.js';
import { PostRow } from '../src/core/db/types.js';

let db: Database.Database;
let tempDir: string;

afterEach(() => {
  if (db) closeDatabase(db);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function createFixturePost(postsDir: string, slug: string, frontmatter: string): void {
  const postDir = join(postsDir, slug);
  mkdirSync(postDir, { recursive: true });
  writeFileSync(join(postDir, 'index.mdx'), `---\n${frontmatter}\n---\n\nPost content here.`);
}

describe('import posts', () => {
  it('imports posts from fixture directory', () => {
    db = getDatabase(':memory:');
    tempDir = mkdtempSync(join(tmpdir(), 'blog-import-'));
    const postsDir = join(tempDir, 'content', 'posts');
    mkdirSync(postsDir, { recursive: true });

    createFixturePost(postsDir, 'test-post', `title: "Test Post"
description: "A test"
date: "2026-04-01"
tags: [test]
published: true`);

    createFixturePost(postsDir, 'project-post', `title: "m0lz.02 -- Structured Workflows"
description: "A project post"
date: "2026-04-02"
tags: [ai, tools]
published: true
project: m0lz.02
companion_repo: "github.com/jmolz/m0lz.02"`);

    const count = importPosts(db, tempDir, 'https://m0lz.dev');
    expect(count).toBe(2);

    const posts = db.prepare('SELECT * FROM posts ORDER BY slug').all() as PostRow[];
    expect(posts).toHaveLength(2);

    // Verify first post
    const proj = posts.find((p) => p.slug === 'project-post')!;
    expect(proj.phase).toBe('published');
    expect(proj.mode).toBe('imported');
    expect(proj.site_url).toBe('https://m0lz.dev/writing/project-post');
    expect(proj.project_id).toBe('m0lz.02');
    expect(proj.repo_url).toBe('github.com/jmolz/m0lz.02');

    // Verify second post
    const test = posts.find((p) => p.slug === 'test-post')!;
    expect(test.phase).toBe('published');
    expect(test.content_type).toBeNull(); // no project, so no content_type set
  });

  it('is idempotent on re-run', () => {
    db = getDatabase(':memory:');
    tempDir = mkdtempSync(join(tmpdir(), 'blog-import-'));
    const postsDir = join(tempDir, 'content', 'posts');
    mkdirSync(postsDir, { recursive: true });

    createFixturePost(postsDir, 'repeat-post', `title: "Repeat"
description: "Test idempotency"
date: "2026-04-01"
tags: []
published: true`);

    importPosts(db, tempDir, 'https://m0lz.dev');
    importPosts(db, tempDir, 'https://m0lz.dev');

    const count = (db.prepare('SELECT COUNT(*) as c FROM posts').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('throws on missing posts directory', () => {
    db = getDatabase(':memory:');

    expect(() => {
      importPosts(db, '/nonexistent/path', 'https://m0lz.dev');
    }).toThrow('Posts directory not found');
  });

  it('skips posts with malformed frontmatter and warns', () => {
    db = getDatabase(':memory:');
    tempDir = mkdtempSync(join(tmpdir(), 'blog-import-'));
    const postsDir = join(tempDir, 'content', 'posts');
    mkdirSync(postsDir, { recursive: true });

    // Valid post
    createFixturePost(postsDir, 'good-post', `title: "Good"
description: "OK"
date: "2026-04-01"
tags: []
published: true`);

    // Malformed YAML (unclosed quote)
    const badDir = join(postsDir, 'bad-post');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'index.mdx'), `---\ntitle: "Bad\ndescription: broken\n---\n\nContent.`);

    // Missing frontmatter delimiters
    const noFrontDir = join(postsDir, 'no-front');
    mkdirSync(noFrontDir, { recursive: true });
    writeFileSync(join(noFrontDir, 'index.mdx'), `Just content, no frontmatter.`);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => { warnings.push(msg); };

    try {
      const count = importPosts(db, tempDir, 'https://m0lz.dev');
      expect(count).toBe(1); // only good-post imported
      expect(warnings.some((w) => w.includes('bad-post'))).toBe(true);
      expect(warnings.some((w) => w.includes('no-front'))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('skips posts whose frontmatter has no title', () => {
    db = getDatabase(':memory:');
    tempDir = mkdtempSync(join(tmpdir(), 'blog-import-'));
    const postsDir = join(tempDir, 'content', 'posts');
    mkdirSync(postsDir, { recursive: true });

    createFixturePost(postsDir, 'titleless', `description: "No title here"
date: "2026-04-01"
tags: []
published: true`);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => { warnings.push(msg); };

    try {
      const count = importPosts(db, tempDir, 'https://m0lz.dev');
      expect(count).toBe(0);
      expect(warnings.some((w) => w.includes('title'))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});
