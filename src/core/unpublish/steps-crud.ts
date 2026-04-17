import Database from 'better-sqlite3';

import { BlogConfig } from '../config/types.js';
import { UnpublishStepRow } from '../db/types.js';
import {
  UNPUBLISH_STEP_NAMES,
  UnpublishStepName,
} from './steps-registry.js';

// Unpublish is one-shot per post so the unpublish_steps table has no
// cycle_id — the UNIQUE(post_slug, step_name) constraint alone scopes
// rows per post. All seven step names are always created; config
// controls which of them the step body skips at runtime.

function buildInitialSteps(
  config: BlogConfig,
): Array<{ name: UnpublishStepName; status: 'pending' | 'skipped'; reason?: string }> {
  const rows: Array<{ name: UnpublishStepName; status: 'pending' | 'skipped'; reason?: string }> = [];
  for (const name of UNPUBLISH_STEP_NAMES) {
    let status: 'pending' | 'skipped' = 'pending';
    let reason: string | undefined;
    switch (name) {
      case 'devto-unpublish':
        if (config.unpublish.devto === false) {
          status = 'skipped';
          reason = 'config.unpublish.devto=false';
        }
        break;
      case 'medium-instructions':
        if (config.unpublish.medium === false) {
          status = 'skipped';
          reason = 'config.unpublish.medium=false';
        }
        break;
      case 'substack-instructions':
        if (config.unpublish.substack === false) {
          status = 'skipped';
          reason = 'config.unpublish.substack=false';
        }
        break;
      case 'readme-revert':
        if (config.unpublish.readme === false) {
          status = 'skipped';
          reason = 'config.unpublish.readme=false';
        }
        break;
      default:
        break;
    }
    rows.push({ name, status, reason });
  }
  return rows;
}

export function createUnpublishSteps(
  db: Database.Database,
  slug: string,
  config: BlogConfig,
): void {
  const initial = buildInitialSteps(config);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO unpublish_steps
       (post_slug, step_number, step_name, status, completed_at, error_message)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    initial.forEach((row, idx) => {
      const stepNumber = idx + 1;
      const completedAt = row.status === 'skipped' ? new Date().toISOString() : null;
      const reason = row.status === 'skipped' ? (row.reason ?? null) : null;
      insert.run(slug, stepNumber, row.name, row.status, completedAt, reason);
    });
  });
  tx();
}

export function getNextPendingStep(
  db: Database.Database,
  slug: string,
): UnpublishStepRow | null {
  const row = db.prepare(
    `SELECT id, post_slug, step_number, step_name, status, started_at, completed_at, error_message
     FROM unpublish_steps
     WHERE post_slug = ? AND status IN ('pending', 'failed')
     ORDER BY step_number ASC LIMIT 1`,
  ).get(slug) as UnpublishStepRow | undefined;
  return row ?? null;
}

export function markStepRunning(db: Database.Database, slug: string, name: UnpublishStepName): void {
  db.prepare(
    `UPDATE unpublish_steps
     SET status = 'running', started_at = CURRENT_TIMESTAMP, completed_at = NULL, error_message = NULL
     WHERE post_slug = ? AND step_name = ?`,
  ).run(slug, name);
}

export function markStepCompleted(db: Database.Database, slug: string, name: UnpublishStepName): void {
  db.prepare(
    `UPDATE unpublish_steps
     SET status = 'completed', completed_at = CURRENT_TIMESTAMP, error_message = NULL
     WHERE post_slug = ? AND step_name = ?`,
  ).run(slug, name);
}

export function markStepFailed(db: Database.Database, slug: string, name: UnpublishStepName, errorMessage: string): void {
  db.prepare(
    `UPDATE unpublish_steps
     SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error_message = ?
     WHERE post_slug = ? AND step_name = ?`,
  ).run(errorMessage, slug, name);
}

export function markStepSkipped(db: Database.Database, slug: string, name: UnpublishStepName, reason?: string): void {
  db.prepare(
    `UPDATE unpublish_steps
     SET status = 'skipped', completed_at = CURRENT_TIMESTAMP, error_message = ?
     WHERE post_slug = ? AND step_name = ?`,
  ).run(reason ?? null, slug, name);
}

export function reclaimStaleRunning(db: Database.Database, slug: string): number {
  const info = db.prepare(
    `UPDATE unpublish_steps
     SET status = 'pending', started_at = NULL
     WHERE post_slug = ? AND status = 'running'`,
  ).run(slug);
  return info.changes;
}

export function allStepsComplete(db: Database.Database, slug: string): boolean {
  const rows = db.prepare(
    `SELECT status FROM unpublish_steps WHERE post_slug = ?`,
  ).all(slug) as Array<{ status: string }>;
  if (rows.length !== UNPUBLISH_STEP_NAMES.length) return false;
  return rows.every((r) => r.status === 'completed' || r.status === 'skipped');
}

export function listUnpublishSteps(db: Database.Database, slug: string): UnpublishStepRow[] {
  return db.prepare(
    `SELECT id, post_slug, step_number, step_name, status, started_at, completed_at, error_message
     FROM unpublish_steps
     WHERE post_slug = ? ORDER BY step_number ASC`,
  ).all(slug) as UnpublishStepRow[];
}
