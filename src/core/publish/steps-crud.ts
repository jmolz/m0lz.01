import Database from 'better-sqlite3';

import { BlogConfig } from '../config/types.js';
import { ContentType } from '../db/types.js';
import {
  PUBLISH_STEP_NAMES,
  PipelineStepRow,
  PublishStepName,
} from './types.js';

// CRUD operations over the `pipeline_steps` table, scoped to the 11 publish
// step names defined in ./types.ts. The table's UNIQUE(post_slug, step_name)
// constraint makes creation idempotent via INSERT OR IGNORE; updates are
// keyed by (post_slug, step_name) so re-runs of the same function converge
// on the intended status.
//
// All SQL uses parameterized ? placeholders. Table name is a SQL literal;
// SQLite does not support parameterized table names.

export interface CreatePipelineStepsOptions {
  // When provided, drives pre-skipping of the `research-page` step:
  //   false + contentType === 'analysis-opinion' → skip research-page
  //   true                                        → do not pre-skip
  //   undefined                                   → do not pre-skip (runtime
  //                                                 decision deferred to the
  //                                                 step's execute function)
  hasResearchArtifact?: boolean;
}

// Build the full list of 11 step rows with content-type + config-driven
// pre-skip decisions. Returns tuples so a single transactional insert sees
// them in declaration order.
function buildInitialSteps(
  contentType: ContentType,
  config: BlogConfig,
  options?: CreatePipelineStepsOptions,
): Array<{ name: PublishStepName; status: 'pending' | 'skipped'; reason?: string }> {
  const rows: Array<{ name: PublishStepName; status: 'pending' | 'skipped'; reason?: string }> = [];
  for (const name of PUBLISH_STEP_NAMES) {
    let status: 'pending' | 'skipped' = 'pending';
    let reason: string | undefined;

    switch (name) {
      case 'research-page': {
        // Pre-skip only when the caller affirmatively reports no research
        // artifact AND content type is analysis-opinion. When unknown, defer
        // to runtime.
        if (contentType === 'analysis-opinion' && options?.hasResearchArtifact === false) {
          status = 'skipped';
          reason = 'Analysis-opinion without research artifacts';
        }
        break;
      }
      case 'companion-repo': {
        if (contentType === 'analysis-opinion') {
          status = 'skipped';
          reason = 'Analysis-opinion posts do not scaffold companion repos';
        } else if (contentType === 'project-launch') {
          status = 'skipped';
          reason = 'Project-launch posts use an existing companion repo';
        }
        break;
      }
      case 'crosspost-devto': {
        if (config.publish.devto === false) {
          status = 'skipped';
          reason = 'Dev.to cross-posting disabled in config (publish.devto=false)';
        }
        break;
      }
      case 'paste-medium': {
        if (config.publish.medium === false) {
          status = 'skipped';
          reason = 'Medium paste disabled in config (publish.medium=false)';
        }
        break;
      }
      case 'paste-substack': {
        if (config.publish.substack === false) {
          status = 'skipped';
          reason = 'Substack paste disabled in config (publish.substack=false)';
        }
        break;
      }
      default:
        break;
    }

    rows.push({ name, status, reason });
  }
  return rows;
}

// Idempotent creation of all 11 pipeline_steps rows for a post. UNIQUE on
// (post_slug, step_name) makes INSERT OR IGNORE safe under repeated calls.
// The first call establishes the pre-skip decisions; subsequent calls never
// override an existing row's status (IGNORE keeps the prior content).
export function createPipelineSteps(
  db: Database.Database,
  slug: string,
  contentType: ContentType,
  config: BlogConfig,
  options?: CreatePipelineStepsOptions,
): void {
  const initial = buildInitialSteps(contentType, config, options);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO pipeline_steps
      (post_slug, step_number, step_name, status, completed_at, error_message)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    initial.forEach((row, idx) => {
      const stepNumber = idx + 1;
      // For skipped rows, populate completed_at (skip is a terminal state)
      // and put the reason into error_message so operators see why it was
      // skipped without widening the schema with a dedicated reason column.
      const completedAt = row.status === 'skipped' ? new Date().toISOString() : null;
      const reason = row.status === 'skipped' ? (row.reason ?? null) : null;
      insert.run(slug, stepNumber, row.name, row.status, completedAt, reason);
    });
  });
  tx();
}

// Return the first row eligible for execution, by step order. A failed step
// qualifies too — it means the previous attempt raised and the runner should
// retry before advancing.
export function getNextPendingStep(
  db: Database.Database,
  slug: string,
): PipelineStepRow | null {
  const row = db.prepare(`
    SELECT id, post_slug, step_number, step_name, status, started_at, completed_at, error_message
    FROM pipeline_steps
    WHERE post_slug = ? AND status IN ('pending', 'failed')
    ORDER BY step_number ASC
    LIMIT 1
  `).get(slug) as PipelineStepRow | undefined;
  return row ?? null;
}

export function markStepRunning(
  db: Database.Database,
  slug: string,
  stepName: PublishStepName,
): void {
  db.prepare(`
    UPDATE pipeline_steps
    SET status = 'running',
        started_at = CURRENT_TIMESTAMP,
        completed_at = NULL,
        error_message = NULL
    WHERE post_slug = ? AND step_name = ?
  `).run(slug, stepName);
}

export function markStepCompleted(
  db: Database.Database,
  slug: string,
  stepName: PublishStepName,
): void {
  db.prepare(`
    UPDATE pipeline_steps
    SET status = 'completed',
        completed_at = CURRENT_TIMESTAMP,
        error_message = NULL
    WHERE post_slug = ? AND step_name = ?
  `).run(slug, stepName);
}

export function markStepFailed(
  db: Database.Database,
  slug: string,
  stepName: PublishStepName,
  errorMessage: string,
): void {
  db.prepare(`
    UPDATE pipeline_steps
    SET status = 'failed',
        completed_at = CURRENT_TIMESTAMP,
        error_message = ?
    WHERE post_slug = ? AND step_name = ?
  `).run(errorMessage, slug, stepName);
}

export function markStepSkipped(
  db: Database.Database,
  slug: string,
  stepName: PublishStepName,
  reason?: string,
): void {
  db.prepare(`
    UPDATE pipeline_steps
    SET status = 'skipped',
        completed_at = CURRENT_TIMESTAMP,
        error_message = ?
    WHERE post_slug = ? AND step_name = ?
  `).run(reason ?? null, slug, stepName);
}

export function getPipelineSteps(
  db: Database.Database,
  slug: string,
): PipelineStepRow[] {
  return db.prepare(`
    SELECT id, post_slug, step_number, step_name, status, started_at, completed_at, error_message
    FROM pipeline_steps
    WHERE post_slug = ?
    ORDER BY step_number ASC
  `).all(slug) as PipelineStepRow[];
}

// True iff every pipeline_steps row is completed or skipped AND there are
// exactly 11 rows (sanity check: catches a partial createPipelineSteps that
// was interrupted before all rows landed).
export function allStepsComplete(
  db: Database.Database,
  slug: string,
): boolean {
  const rows = db.prepare(`
    SELECT status
    FROM pipeline_steps
    WHERE post_slug = ?
  `).all(slug) as Array<{ status: string }>;
  if (rows.length !== PUBLISH_STEP_NAMES.length) return false;
  return rows.every((r) => r.status === 'completed' || r.status === 'skipped');
}
