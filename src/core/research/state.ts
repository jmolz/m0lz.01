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
  const existing = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
  if (existing) {
    if (existing.phase !== 'research') {
      throw new Error(
        `Post '${slug}' already exists in phase '${existing.phase}'. ` +
        `Only posts in the 'research' phase can be re-initialized.`,
      );
    }
    return { created: false, post: existing };
  }

  db.prepare(`
    INSERT INTO posts (slug, topic, content_type, phase, mode)
    VALUES (?, ?, ?, 'research', ?)
  `).run(slug, topic, contentType, mode);

  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
  if (!post) {
    throw new Error(`initResearchPost failed to load post after insert: ${slug}`);
  }

  return { created: true, post };
}

export function getResearchPost(db: Database.Database, slug: string): PostRow | undefined {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
  if (post && post.phase !== 'research') {
    throw new Error(
      `Post '${slug}' is in phase '${post.phase}', not 'research'. ` +
      `Research commands only operate on posts in the research phase.`,
    );
  }
  return post;
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
