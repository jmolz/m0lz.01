import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

// Persist a partial URL bundle to the posts row using COALESCE semantics so
// the existing column value wins when already set. Called per-step by the
// pipeline runner so that URLs survive a process crash BEFORE the final
// completePublish transition: if runner A writes devto_url at step 5 and
// then is killed, runner B resuming the pipeline sees devto_url already on
// the row and never tries to re-crosspost. `first-writer-wins` is the
// correct policy here because Dev.to article creation is not idempotent.
//
// This helper is intentionally separate from `markStepCompleted` so the
// runner can wrap both in a single transaction — either both land or
// neither does, preventing the "step marked completed but URL lost" crash
// window.
export function persistPublishUrls(
  db: Database.Database,
  slug: string,
  urls: Partial<PublishUrls>,
): void {
  db.prepare(`
    UPDATE posts
    SET site_url = COALESCE(site_url, ?),
        devto_url = COALESCE(devto_url, ?),
        medium_url = COALESCE(medium_url, ?),
        substack_url = COALESCE(substack_url, ?),
        repo_url = COALESCE(repo_url, ?),
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
}

// Shared lockfile PID-ownership check for every finalizer that must run
// "under the lock" (Phase 7: publish complete, update complete, unpublish
// complete). Callers pass the work as a closure; this helper asserts the
// lockfile exists AND stores the current process's PID, then invokes the
// body. Centralizing the check guarantees every finalizer has the same
// crash-safe guardrail against silent racing with a concurrent pipeline
// that forgot to acquire the lock.
export function finalizePipelineUnderLock(
  publishDir: string,
  slug: string,
  body: () => void,
): void {
  const lockPath = join(publishDir, slug, '.publish.lock');
  if (!existsSync(lockPath)) {
    throw new Error(
      `finalizePipelineUnderLock requires the publish lock to be held for ` +
      `'${slug}' at ${lockPath}, but the lockfile does not exist. Call the ` +
      `public (non-UnderLock) wrapper from callers outside the pipeline runner.`,
    );
  }
  const heldPid = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
  if (!Number.isFinite(heldPid) || heldPid !== process.pid) {
    throw new Error(
      `finalizePipelineUnderLock requires the slug-scoped lock to be held by ` +
      `this process (pid=${process.pid}) but the lockfile stores pid=${heldPid}. ` +
      `Call the public (non-UnderLock) wrapper instead.`,
    );
  }
  body();
}

// Internal variant used by the pipeline runner, which already holds the
// slug-scoped lock. Skips the lock acquisition to avoid a re-entry deadlock
// (the lock is non-reentrant by design — `process.kill(pid, 0)` for the
// current PID always reports alive, so a second acquire under the same PID
// would spin until timeout).
//
// Also idempotent: if another runner already promoted the post to
// `published`, this is a no-op. This makes the runner tolerant of the
// benign race where two processes both reach completion under the same
// lock handoff.
export function completePublishUnderLock(
  db: Database.Database,
  slug: string,
  urls: PublishUrls,
  publishDir: string,
): void {
  finalizePipelineUnderLock(publishDir, slug, () => {
    const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
    if (!post) {
      throw new Error(`Post not found: ${slug}`);
    }
    if (post.phase === 'published') {
      // Another runner already completed the phase transition — URLs were
      // written per-step, so the row is already correct.
      return;
    }
    if (post.phase !== 'publish') {
      throw new Error(
        `Post '${slug}' is in phase '${post.phase}', not 'publish'. ` +
        `Publish commands only operate on posts in the publish phase.`,
      );
    }
    if (!allStepsComplete(db, slug, 0)) {
      throw new Error(
        `Cannot complete publish for '${slug}': not every pipeline step is completed or skipped. ` +
        `Run 'blog publish' to finish remaining steps, or inspect 'blog status ${slug}' for blocked steps.`,
      );
    }

    const tx = db.transaction(() => {
      advancePhase(db, slug, 'published');
      // Coalesce-style UPDATE: each column takes the supplied URL when
      // present, otherwise keeps its current value. Combined with per-step
      // persistence via `persistPublishUrls`, this means `urls` can be empty
      // here without data loss — a concurrent runner that reaches this path
      // with `ctx.urls = {}` still sees the correct row because prior steps
      // already persisted their outputs.
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

      // Metrics audit — one row per cycle close, per Phase 7 adversarial
      // review finding #7 ("every destructive/cycle action writes a row").
      db.prepare(
        `INSERT INTO metrics (post_slug, event, value) VALUES (?, 'published', ?)`,
      ).run(slug, null);
    });
    tx();
  });
}

// Phase 7: update-mode finalizer. Called by the runner when every
// pipeline_steps row for the cycle reaches completed/skipped. Closes the
// open update_cycles row, increments `posts.update_count`, sets
// `posts.last_updated_at`, persists URLs, writes a metrics row. Does NOT
// change `posts.phase` — updates keep the post in `published`.
//
// Idempotent on an already-closed cycle: the UPDATE's WHERE closed_at IS
// NULL clause makes a second invocation a no-op with info.changes=0. We
// intentionally do NOT throw on the no-op branch because the runner may
// legitimately re-invoke after a benign crash where the tx committed but
// the runner couldn't observe it — idempotency is the contract.
export function completeUpdateUnderLock(
  db: Database.Database,
  slug: string,
  cycleId: number,
  urls: PublishUrls,
  publishDir: string,
): void {
  finalizePipelineUnderLock(publishDir, slug, () => {
    const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
    if (!post) {
      throw new Error(`Post not found: ${slug}`);
    }
    if (post.phase !== 'published') {
      throw new Error(
        `Post '${slug}' is in phase '${post.phase}', not 'published'. ` +
        `Update cycles only operate on published posts.`,
      );
    }
    if (!allStepsComplete(db, slug, cycleId)) {
      throw new Error(
        `Cannot complete update cycle ${cycleId} for '${slug}': ` +
        `not every pipeline step is completed or skipped.`,
      );
    }

    const tx = db.transaction(() => {
      // Close the cycle row. WHERE closed_at IS NULL makes the UPDATE a
      // no-op for an already-closed cycle (idempotent).
      const cycleInfo = db
        .prepare(
          `UPDATE update_cycles
           SET closed_at = CURRENT_TIMESTAMP,
               ended_reason = 'completed'
           WHERE id = ? AND post_slug = ? AND closed_at IS NULL`,
        )
        .run(cycleId, slug);

      if (cycleInfo.changes === 0) {
        // Either the cycle doesn't exist (operator error — we'd throw
        // earlier during step execution) OR it was already closed by a
        // concurrent runner (benign). Treat as benign no-op.
        return;
      }

      db.prepare(`
        UPDATE posts
        SET update_count = update_count + 1,
            last_updated_at = CURRENT_TIMESTAMP,
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

      db.prepare(
        `INSERT INTO metrics (post_slug, event, value) VALUES (?, 'update_completed', ?)`,
      ).run(slug, String(cycleId));
    });
    tx();
  });
}

// Public wrapper that acquires the slug-scoped FS lock and calls the
// internal variant. Use this from test code, CLI handlers, or anywhere the
// caller does NOT already hold the publish lock.
export function completePublish(
  db: Database.Database,
  slug: string,
  urls: PublishUrls,
  publishDir: string,
): void {
  const release = acquirePublishLock(publishDir, slug);
  try {
    completePublishUnderLock(db, slug, urls, publishDir);
  } finally {
    release();
  }
}
