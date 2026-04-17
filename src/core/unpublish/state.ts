import Database from 'better-sqlite3';

import { BlogConfig } from '../config/types.js';
import { PostRow } from '../db/types.js';
import { advancePhase } from '../research/state.js';
import { finalizePipelineUnderLock } from '../publish/phase.js';
import {
  createUnpublishSteps,
  allStepsComplete,
} from './steps-crud.js';

// Phase 7: unpublish lifecycle. initUnpublish is the single seed point —
// it asserts the post is in 'published' (or detects an already-unpublished
// post for idempotent re-run), seeds unpublish_steps rows, and writes a
// metrics row 'unpublish_started'. completeUnpublishUnderLock finalizes
// when the runner observes allStepsComplete: advances phase to
// 'unpublished', sets unpublished_at, writes 'unpublished' metrics.

export interface InitUnpublishResult {
  post: PostRow;
  alreadyUnpublished: boolean;
}

export function initUnpublish(
  db: Database.Database,
  slug: string,
  config: BlogConfig,
): InitUnpublishResult {
  const post = db
    .prepare('SELECT * FROM posts WHERE slug = ?')
    .get(slug) as PostRow | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }
  if (post.phase === 'unpublished') {
    return { post, alreadyUnpublished: true };
  }
  if (post.phase !== 'published') {
    throw new Error(
      `Post '${slug}' is in phase '${post.phase}', not 'published'. ` +
      `Only published posts can be unpublished.`,
    );
  }
  const tx = db.transaction(() => {
    createUnpublishSteps(db, slug, config);
    db.prepare(
      `INSERT INTO metrics (post_slug, event, value) VALUES (?, 'unpublish_started', ?)`,
    ).run(slug, null);
  });
  tx();
  return { post, alreadyUnpublished: false };
}

export function getUnpublishPost(
  db: Database.Database,
  slug: string,
): PostRow | undefined {
  return db
    .prepare('SELECT * FROM posts WHERE slug = ?')
    .get(slug) as PostRow | undefined;
}

// Runner-owned finalization. Must hold the same slug-scoped publish lock
// (unpublish shares the lock for mutual exclusion vs. publish/update).
// Idempotent on already-unpublished posts.
export function completeUnpublishUnderLock(
  db: Database.Database,
  slug: string,
  publishDir: string,
): void {
  finalizePipelineUnderLock(publishDir, slug, () => {
    const post = db
      .prepare('SELECT * FROM posts WHERE slug = ?')
      .get(slug) as PostRow | undefined;
    if (!post) {
      throw new Error(`Post not found: ${slug}`);
    }
    if (post.phase === 'unpublished') {
      return;
    }
    if (post.phase !== 'published') {
      throw new Error(
        `Post '${slug}' is in phase '${post.phase}', not 'published'. ` +
        `Unpublish finalization only advances from 'published'.`,
      );
    }
    if (!allStepsComplete(db, slug)) {
      throw new Error(
        `Cannot complete unpublish for '${slug}': not every step is completed or skipped.`,
      );
    }
    const tx = db.transaction(() => {
      advancePhase(db, slug, 'unpublished');
      db.prepare(
        `UPDATE posts SET unpublished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE slug = ?`,
      ).run(slug);
      db.prepare(
        `INSERT INTO metrics (post_slug, event, value) VALUES (?, 'unpublished', ?)`,
      ).run(slug, null);
    });
    tx();
  });
}
