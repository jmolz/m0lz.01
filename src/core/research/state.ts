import Database from 'better-sqlite3';

import { PostRow, Phase, Mode, ContentType } from '../db/types.js';

const VALID_PHASES: readonly Phase[] = [
  'idea', 'research', 'benchmark', 'draft', 'evaluate', 'publish', 'published', 'unpublished',
] as const;

export interface InitResearchResult {
  created: boolean;
  post: PostRow;
}

export function initResearchPost(
  db: Database.Database,
  slug: string,
  topic: string,
  mode: Mode,
  contentType: ContentType,
): InitResearchResult {
  const info = db
    .prepare(`
      INSERT OR IGNORE INTO posts (slug, topic, content_type, phase, mode)
      VALUES (?, ?, ?, 'research', ?)
    `)
    .run(slug, topic, contentType, mode);

  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
  if (!post) {
    throw new Error(`initResearchPost failed to load post after insert: ${slug}`);
  }

  return { created: info.changes > 0, post };
}

export function getResearchPost(db: Database.Database, slug: string): PostRow | undefined {
  return db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
}

export function advancePhase(db: Database.Database, slug: string, newPhase: Phase): void {
  if (!VALID_PHASES.includes(newPhase)) {
    throw new Error(`Invalid phase: ${newPhase}. Valid phases: ${VALID_PHASES.join(', ')}`);
  }
  const info = db
    .prepare('UPDATE posts SET phase = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ?')
    .run(newPhase, slug);
  if (info.changes === 0) {
    throw new Error(`Post not found: ${slug}`);
  }
}
