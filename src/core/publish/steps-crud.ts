import Database from 'better-sqlite3';

import { BlogConfig } from '../config/types.js';
import { ContentType } from '../db/types.js';
import {
  PUBLISH_STEP_NAMES,
  PipelineStepRow,
  PublishStepName,
  stepNamesForMode,
} from './types.js';
import { PublishMode } from './pipeline-types.js';

// CRUD operations over the `pipeline_steps` table, scoped to the 11 publish
// step names defined in ./types.ts. The table's UNIQUE(post_slug, cycle_id,
// step_name) constraint makes creation idempotent via INSERT OR IGNORE;
// updates are keyed by (post_slug, cycle_id, step_name) so re-runs of the
// same function converge on the intended status.
//
// Phase 7: every function accepts an optional trailing `cycleId` parameter
// (default 0 for initial publish). Update cycles pass the open update
// cycle's id so the same 11 step names can repeat per cycle without
// colliding with prior runs. All queries filter on `cycle_id` so a given
// cycle's state is cleanly isolated from other cycles on the same post.
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

// Build the list of step rows with content-type + config-driven pre-skip
// decisions. Phase 7: the step set depends on `publishMode` (initial uses
// PUBLISH_STEP_NAMES; update uses UPDATE_STEP_NAMES with site-update
// substituted for site-pr and companion-repo/update-readme dropped).
function buildInitialSteps(
  contentType: ContentType,
  config: BlogConfig,
  options?: CreatePipelineStepsOptions,
  publishMode: PublishMode = 'initial',
): Array<{ name: PublishStepName; status: 'pending' | 'skipped'; reason?: string }> {
  const rows: Array<{ name: PublishStepName; status: 'pending' | 'skipped'; reason?: string }> = [];
  for (const name of stepNamesForMode(publishMode)) {
    let status: 'pending' | 'skipped' = 'pending';
    let reason: string | undefined;

    switch (name) {
      case 'research-page': {
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

// Idempotent creation of all pipeline_steps rows for a post + cycle.
// UNIQUE on (post_slug, cycle_id, step_name) makes INSERT OR IGNORE safe
// under repeated calls. The first call establishes the pre-skip decisions;
// subsequent calls never override an existing row's status. Step count
// is mode-dependent (11 for initial publish, 9 for update).
export function createPipelineSteps(
  db: Database.Database,
  slug: string,
  contentType: ContentType,
  config: BlogConfig,
  options?: CreatePipelineStepsOptions,
  cycleId: number = 0,
  publishMode: PublishMode = 'initial',
): void {
  const initial = buildInitialSteps(contentType, config, options, publishMode);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO pipeline_steps
      (post_slug, step_number, step_name, status, completed_at, error_message, cycle_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    initial.forEach((row, idx) => {
      const stepNumber = idx + 1;
      const completedAt = row.status === 'skipped' ? new Date().toISOString() : null;
      const reason = row.status === 'skipped' ? (row.reason ?? null) : null;
      insert.run(slug, stepNumber, row.name, row.status, completedAt, reason, cycleId);
    });
  });
  tx();
}

// Return the first row eligible for execution for the given cycle, by step
// order. A failed step qualifies too — it means the previous attempt raised
// and the runner should retry before advancing.
export function getNextPendingStep(
  db: Database.Database,
  slug: string,
  cycleId: number = 0,
): PipelineStepRow | null {
  const row = db.prepare(`
    SELECT id, post_slug, step_number, step_name, status,
           started_at, completed_at, error_message, cycle_id
    FROM pipeline_steps
    WHERE post_slug = ? AND cycle_id = ? AND status IN ('pending', 'failed')
    ORDER BY step_number ASC
    LIMIT 1
  `).get(slug, cycleId) as PipelineStepRow | undefined;
  return row ?? null;
}

export function markStepRunning(
  db: Database.Database,
  slug: string,
  stepName: PublishStepName,
  cycleId: number = 0,
): void {
  db.prepare(`
    UPDATE pipeline_steps
    SET status = 'running',
        started_at = CURRENT_TIMESTAMP,
        completed_at = NULL,
        error_message = NULL
    WHERE post_slug = ? AND cycle_id = ? AND step_name = ?
  `).run(slug, cycleId, stepName);
}

export function markStepCompleted(
  db: Database.Database,
  slug: string,
  stepName: PublishStepName,
  cycleId: number = 0,
): void {
  db.prepare(`
    UPDATE pipeline_steps
    SET status = 'completed',
        completed_at = CURRENT_TIMESTAMP,
        error_message = NULL
    WHERE post_slug = ? AND cycle_id = ? AND step_name = ?
  `).run(slug, cycleId, stepName);
}

export function markStepFailed(
  db: Database.Database,
  slug: string,
  stepName: PublishStepName,
  errorMessage: string,
  cycleId: number = 0,
): void {
  db.prepare(`
    UPDATE pipeline_steps
    SET status = 'failed',
        completed_at = CURRENT_TIMESTAMP,
        error_message = ?
    WHERE post_slug = ? AND cycle_id = ? AND step_name = ?
  `).run(errorMessage, slug, cycleId, stepName);
}

export function markStepSkipped(
  db: Database.Database,
  slug: string,
  stepName: PublishStepName,
  reason?: string,
  cycleId: number = 0,
): void {
  db.prepare(`
    UPDATE pipeline_steps
    SET status = 'skipped',
        completed_at = CURRENT_TIMESTAMP,
        error_message = ?
    WHERE post_slug = ? AND cycle_id = ? AND step_name = ?
  `).run(reason ?? null, slug, cycleId, stepName);
}

export function getPipelineSteps(
  db: Database.Database,
  slug: string,
  cycleId: number = 0,
): PipelineStepRow[] {
  return db.prepare(`
    SELECT id, post_slug, step_number, step_name, status,
           started_at, completed_at, error_message, cycle_id
    FROM pipeline_steps
    WHERE post_slug = ? AND cycle_id = ?
    ORDER BY step_number ASC
  `).all(slug, cycleId) as PipelineStepRow[];
}

// Reconcile existing `pending` / `failed` rows against the CURRENT config
// and content type. Lets the operator disable an optional destination by
// flipping `publish.devto`, `publish.medium`, or `publish.substack` to
// `false` in `.blogrc.yaml` between invocations — without this pass, the
// stale row stays `pending`/`failed` forever because INSERT OR IGNORE
// keeps the original status on re-init (Codex Pass 6 High).
//
// We only downgrade (pending/failed -> skipped). We never UP-grade a
// skipped row back to pending: that would risk re-running a destination
// the operator deliberately disabled, and the initial seed already set
// skip state deterministically. Re-enabling a skipped destination
// requires rejecting the evaluation and starting a new publish cycle.
export function reconcilePipelineSteps(
  db: Database.Database,
  slug: string,
  contentType: ContentType,
  config: BlogConfig,
  options?: CreatePipelineStepsOptions,
  cycleId: number = 0,
  publishMode: PublishMode = 'initial',
): number {
  const expected = buildInitialSteps(contentType, config, options, publishMode);
  const expectedByName = new Map(expected.map((r) => [r.name, r]));
  const existing = db.prepare(`
    SELECT step_name, status FROM pipeline_steps
    WHERE post_slug = ? AND cycle_id = ?
  `).all(slug, cycleId) as Array<{ step_name: PublishStepName; status: string }>;
  const update = db.prepare(`
    UPDATE pipeline_steps
    SET status = 'skipped',
        completed_at = CURRENT_TIMESTAMP,
        error_message = ?
    WHERE post_slug = ? AND cycle_id = ? AND step_name = ?
  `);
  let changed = 0;
  const tx = db.transaction(() => {
    for (const row of existing) {
      if (row.status !== 'pending' && row.status !== 'failed') continue;
      const want = expectedByName.get(row.step_name);
      if (want && want.status === 'skipped') {
        update.run(want.reason ?? null, slug, cycleId, row.step_name);
        changed += 1;
      }
    }
  });
  tx();
  return changed;
}

// Demote any `running` rows back to `pending` so the runner picks them up on
// resume. A row is only `running` because a prior invocation was killed
// mid-step. Callers MUST hold the slug-scoped publish lock — the lock is
// the proof that no other live runner owns those rows.
export function reclaimStaleRunning(
  db: Database.Database,
  slug: string,
  cycleId: number = 0,
): number {
  const info = db.prepare(`
    UPDATE pipeline_steps
    SET status = 'pending',
        started_at = NULL
    WHERE post_slug = ? AND cycle_id = ? AND status = 'running'
  `).run(slug, cycleId);
  return info.changes;
}

// True iff every pipeline_steps row for the given cycle is completed or
// skipped AND the row count matches the expected set for the mode (11 for
// initial, 9 for update). The length check catches a partial
// createPipelineSteps that was interrupted before all rows landed.
export function allStepsComplete(
  db: Database.Database,
  slug: string,
  cycleId: number = 0,
  publishMode: PublishMode = 'initial',
): boolean {
  const rows = db.prepare(`
    SELECT status
    FROM pipeline_steps
    WHERE post_slug = ? AND cycle_id = ?
  `).all(slug, cycleId) as Array<{ status: string }>;
  if (rows.length !== stepNamesForMode(publishMode).length) return false;
  return rows.every((r) => r.status === 'completed' || r.status === 'skipped');
}
