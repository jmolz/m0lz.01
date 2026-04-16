import Database from 'better-sqlite3';

import { BlogConfig } from '../config/types.js';
import { ContentType, PostRow } from '../db/types.js';
import { advancePhase } from '../research/state.js';
import { acquirePublishLock } from './lock.js';
import { allStepsComplete, createPipelineSteps } from './steps-crud.js';
import { PublishUrls } from './types.js';

// Phase-boundary helpers for the publish pipeline. Mirrors the pattern
// established by `getResearchPost` / `initEvaluation` / `completeEvaluation`
// in adjacent modules: library functions enforce that operations only run
// when the post is in the expected phase and throw with a descriptive
// message otherwise. CLI handlers catch at the boundary.
//
// The publish phase transition graph:
//   evaluate (evaluation_passed=1) -- initPublish --> publish
//   publish                        -- completePublish --> published
// `initPublish` is idempotent on an already-`publish` post; it re-runs
// `createPipelineSteps` so the pre-skip decisions converge under re-entry
// after config changes.

// Throws if the post is missing or not in the `publish` phase. Used by every
// publish command except the init orchestrator (which accepts `evaluate` too).
export function getPublishPost(db: Database.Database, slug: string): PostRow {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }
  if (post.phase !== 'publish') {
    throw new Error(
      `Post '${slug}' is in phase '${post.phase}', not 'publish'. ` +
      `Publish commands only operate on posts in the publish phase.`,
    );
  }
  return post;
}

// Promote a post from `evaluate` (with a passing evaluation) to `publish`.
// Idempotent when the post is already in `publish`. Throws on any other
// starting phase or when evaluation has not passed.
export function initPublishFromEvaluate(db: Database.Database, slug: string): void {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }
  if (post.phase === 'publish') {
    // Idempotent: already promoted.
    return;
  }
  if (post.phase !== 'evaluate') {
    throw new Error(
      `Post '${slug}' is in phase '${post.phase}', not 'evaluate'. ` +
      `Publish can only be initialized from the evaluate phase.`,
    );
  }
  // BOOLEAN is stored as 0/1 in SQLite. An unfinished evaluation leaves this
  // column NULL; a failing synthesis sets it to 0. Only an explicit 1 means
  // the gate authorized publish.
  if (post.evaluation_passed !== 1) {
    throw new Error(
      `Post '${slug}' has not passed evaluation (evaluation_passed=${post.evaluation_passed}). ` +
      `Run 'blog evaluate synthesize' and 'blog evaluate complete' before initializing publish.`,
    );
  }
  advancePhase(db, slug, 'publish');
}

// Orchestrator for `blog publish init`. Acquires the slug-scoped FS lock,
// promotes from evaluate if needed, seeds the 11 pipeline_steps rows with
// content-type + config pre-skips applied. Returns the post row AFTER the
// phase promotion so callers observe `phase='publish'`.
//
// The content type is passed explicitly (rather than read from the post row)
// so callers can assert the value they expect — defensive against a NULL
// content_type on legacy rows that would otherwise flow into
// `createPipelineSteps` as undefined.
export function initPublish(
  db: Database.Database,
  slug: string,
  contentType: ContentType,
  config: BlogConfig,
  publishDir: string,
): PostRow {
  const release = acquirePublishLock(publishDir, slug);
  try {
    const initial = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
    if (!initial) {
      throw new Error(`Post not found: ${slug}`);
    }
    if (initial.phase !== 'publish') {
      initPublishFromEvaluate(db, slug);
    }
    // Idempotent seed of the 11 pipeline_steps rows. Re-running this after a
    // config change re-applies pre-skip decisions only for rows that did not
    // previously exist (INSERT OR IGNORE).
    createPipelineSteps(db, slug, contentType, config);
    const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
    if (!post) {
      throw new Error(`initPublish failed to reload post after phase advance: ${slug}`);
    }
    return post;
  } finally {
    release();
  }
}

// Transition a post from `publish` to `published` and write the collected
// URLs onto the posts row. Every field in `urls` is optional; only fields
// with a defined value update the corresponding column (coalesce pattern).
// Steps that failed or were skipped do not contribute a URL, so the row
// faithfully reflects what actually succeeded.
//
// Refuses to advance unless every pipeline_steps row is completed or
// skipped. The FS lock serializes against a concurrent runner that might
// mark additional steps running mid-complete.
export function completePublish(
  db: Database.Database,
  slug: string,
  urls: PublishUrls,
  publishDir: string,
): void {
  const release = acquirePublishLock(publishDir, slug);
  try {
    getPublishPost(db, slug);
    if (!allStepsComplete(db, slug)) {
      throw new Error(
        `Cannot complete publish for '${slug}': not every pipeline step is completed or skipped. ` +
        `Run 'blog publish' to finish remaining steps, or inspect 'blog status ${slug}' for blocked steps.`,
      );
    }

    const tx = db.transaction(() => {
      advancePhase(db, slug, 'published');
      // Coalesce-style UPDATE: each column takes the supplied URL when
      // present, otherwise keeps its current value. This lets the function
      // be called repeatedly (or with partial URL bundles from different
      // runners) without clobbering already-written URLs.
      db.prepare(`
        UPDATE posts
        SET published_at = CURRENT_TIMESTAMP,
            site_url = COALESCE(?, site_url),
            devto_url = COALESCE(?, devto_url),
            medium_url = COALESCE(?, medium_url),
            substack_url = COALESCE(?, substack_url),
            repo_url = COALESCE(?, repo_url),
            updated_at = CURRENT_TIMESTAMP
        WHERE slug = ?
      `).run(
        urls.site_url ?? null,
        urls.devto_url ?? null,
        urls.medium_url ?? null,
        urls.substack_url ?? null,
        urls.repo_url ?? null,
        slug,
      );
    });
    tx();
  } finally {
    release();
  }
}
