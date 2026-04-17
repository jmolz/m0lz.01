import Database from 'better-sqlite3';

import { PostRow, UpdateCycleRow, UpdateCycleEndedReason } from '../db/types.js';

// CRUD for update_cycles — Phase 7 first-class rows that track an open
// update cycle for a post. A cycle is "open" while `closed_at IS NULL`;
// the DB partial unique index `idx_update_cycles_open` enforces at most
// one open cycle per post.
//
// All metric-writing branches use the `metrics` table event names:
//   - 'update_opened'    — openUpdateCycle
//   - 'update_completed' — written by completeUpdateUnderLock (phase.ts)
//   - 'update_aborted'   — closeUpdateCycle when reason='aborted'
// The single-source-of-truth for event names lives in the call sites; the
// lifecycle rule (.claude/rules/lifecycle.md, Cluster H) documents them
// together for discoverability.

// Open a new update cycle for a post. Enforces:
//   - post exists
//   - post.phase === 'published' (the only phase from which an update
//     cycle can open — guarded at the library layer; the CLI catches
//     and formats)
//   - no open cycle already exists (the partial unique index catches
//     races too, but we check explicitly so the error message is
//     actionable rather than "UNIQUE constraint failed")
//
// Computes cycle_number as MAX(cycle_number) + 1 scoped to the slug.
// Writes a metrics row 'update_opened' inside the same transaction so
// audit trails cannot disagree with cycle state.
export function openUpdateCycle(
  db: Database.Database,
  slug: string,
  summary: string | null,
): UpdateCycleRow {
  const post = db
    .prepare('SELECT phase FROM posts WHERE slug = ?')
    .get(slug) as { phase: string } | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }
  if (post.phase !== 'published') {
    throw new Error(
      `Post '${slug}' is in phase '${post.phase}', not 'published'. ` +
      `Update cycles only operate on published posts.`,
    );
  }

  const existingOpen = getOpenUpdateCycle(db, slug);
  if (existingOpen) {
    throw new Error(
      `Post '${slug}' already has an open update cycle (id=${existingOpen.id}, ` +
      `cycle_number=${existingOpen.cycle_number}). Run 'blog update publish ${slug}' ` +
      `to complete it, or 'blog update abort ${slug}' to cancel.`,
    );
  }

  let row: UpdateCycleRow | undefined;
  const tx = db.transaction(() => {
    const maxRow = db
      .prepare(
        'SELECT MAX(cycle_number) AS mx FROM update_cycles WHERE post_slug = ?',
      )
      .get(slug) as { mx: number | null };
    const cycleNumber = (maxRow.mx ?? 0) + 1;

    const info = db
      .prepare(
        `INSERT INTO update_cycles (post_slug, cycle_number, summary)
         VALUES (?, ?, ?)`,
      )
      .run(slug, cycleNumber, summary);

    row = db
      .prepare(
        `SELECT id, post_slug, cycle_number, summary, opened_at, closed_at, ended_reason
         FROM update_cycles WHERE id = ?`,
      )
      .get(info.lastInsertRowid as number) as UpdateCycleRow;

    db.prepare(
      `INSERT INTO metrics (post_slug, event, value) VALUES (?, 'update_opened', ?)`,
    ).run(slug, String(cycleNumber));
  });
  tx();
  if (!row) {
    throw new Error(
      `openUpdateCycle: failed to read back inserted row for '${slug}'`,
    );
  }
  return row;
}

// Returns the single open cycle for a post, or null. Partial unique index
// guarantees at most one such row.
export function getOpenUpdateCycle(
  db: Database.Database,
  slug: string,
): UpdateCycleRow | null {
  const row = db
    .prepare(
      `SELECT id, post_slug, cycle_number, summary, opened_at, closed_at, ended_reason
       FROM update_cycles
       WHERE post_slug = ? AND closed_at IS NULL
       LIMIT 1`,
    )
    .get(slug) as UpdateCycleRow | undefined;
  return row ?? null;
}

// Close an update cycle with an explicit reason. Called by
// `completeUpdateUnderLock` (reason='completed') via its own UPDATE, and
// by `blog update abort` (reason='aborted') via this function.
//
// Writes a metrics row — 'update_aborted' for manual aborts. Completed
// cycles get their metrics row written by completeUpdateUnderLock so the
// metrics log colocates with the URL persistence + phase invariants.
export function closeUpdateCycle(
  db: Database.Database,
  cycleId: number,
  reason: UpdateCycleEndedReason,
): void {
  const existing = db
    .prepare(
      `SELECT id, post_slug, closed_at FROM update_cycles WHERE id = ?`,
    )
    .get(cycleId) as
    | { id: number; post_slug: string; closed_at: string | null }
    | undefined;
  if (!existing) {
    throw new Error(`Update cycle not found: id=${cycleId}`);
  }
  if (existing.closed_at !== null) {
    throw new Error(
      `Update cycle ${cycleId} for '${existing.post_slug}' is already closed.`,
    );
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE update_cycles
       SET closed_at = CURRENT_TIMESTAMP, ended_reason = ?
       WHERE id = ? AND closed_at IS NULL`,
    ).run(reason, cycleId);

    if (reason === 'aborted') {
      db.prepare(
        `INSERT INTO metrics (post_slug, event, value) VALUES (?, 'update_aborted', ?)`,
      ).run(existing.post_slug, String(cycleId));
    }
    // 'completed' metrics are owned by completeUpdateUnderLock to keep the
    // full finalization atomic with the cycle close.
  });
  tx();
}

export function listUpdateCycles(
  db: Database.Database,
  slug: string,
): UpdateCycleRow[] {
  return db
    .prepare(
      `SELECT id, post_slug, cycle_number, summary, opened_at, closed_at, ended_reason
       FROM update_cycles
       WHERE post_slug = ?
       ORDER BY cycle_number ASC`,
    )
    .all(slug) as UpdateCycleRow[];
}

// Fetch the post row and assert it is in 'published' phase — the common
// preflight for every `blog update <subcommand>` handler. Keeps the phase
// check centralized so adding a new subcommand only needs to call this.
export function requirePublishedPost(
  db: Database.Database,
  slug: string,
): PostRow {
  const post = db
    .prepare('SELECT * FROM posts WHERE slug = ?')
    .get(slug) as PostRow | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }
  if (post.phase !== 'published') {
    throw new Error(
      `Post '${slug}' is in phase '${post.phase}', not 'published'. ` +
      `Update commands only operate on published posts.`,
    );
  }
  return post;
}
