import Database from 'better-sqlite3';

import { SourceRow, SourceType } from '../db/types.js';

export interface AddSourceResult {
  id: number;
  inserted: boolean;
}

export interface AddSourceOptions {
  title?: string;
  excerpt?: string;
  sourceType?: SourceType;
}

export function addSource(
  db: Database.Database,
  slug: string,
  url: string,
  options: AddSourceOptions = {},
): AddSourceResult {
  const post = db.prepare('SELECT slug, phase FROM posts WHERE slug = ?').get(slug) as { slug: string; phase: string } | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}. Run 'blog research init ${slug}' first.`);
  }
  if (post.phase !== 'research') {
    throw new Error(
      `Post '${slug}' is in phase '${post.phase}', not 'research'. ` +
      `Cannot add sources to a post outside the research phase.`,
    );
  }

  const info = db
    .prepare(`
      INSERT OR IGNORE INTO sources (post_slug, url, title, excerpt, source_type)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      slug,
      url,
      options.title ?? null,
      options.excerpt ?? null,
      options.sourceType ?? 'external',
    );

  if (info.changes > 0) {
    return { id: Number(info.lastInsertRowid), inserted: true };
  }

  // Row already existed — fetch its id so the caller can report it.
  const existing = db
    .prepare('SELECT id FROM sources WHERE post_slug = ? AND url = ?')
    .get(slug, url) as { id: number } | undefined;

  if (!existing) {
    throw new Error(`Source insert ignored but lookup failed for ${slug} -> ${url}`);
  }
  return { id: existing.id, inserted: false };
}

export function listSources(db: Database.Database, slug: string): SourceRow[] {
  return db
    .prepare('SELECT * FROM sources WHERE post_slug = ? ORDER BY accessed_at ASC, id ASC')
    .all(slug) as SourceRow[];
}

export function countSources(db: Database.Database, slug: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM sources WHERE post_slug = ?')
    .get(slug) as { c: number };
  return row.c;
}
