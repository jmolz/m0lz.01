import { BlogConfig } from '../config/types.js';
import { acquirePublishLock } from '../publish/lock.js';
import Database from 'better-sqlite3';

import {
  allStepsComplete,
  getNextPendingStep,
  markStepCompleted,
  markStepFailed,
  markStepRunning,
  markStepSkipped,
  reclaimStaleRunning,
} from './steps-crud.js';
import { UNPUBLISH_STEP_NAMES, UnpublishStepName } from './steps-registry.js';
import { completeUnpublishUnderLock } from './state.js';
import { unpublishFromDevTo } from './devto.js';
import { generateMediumRemovalInstructions } from './medium.js';
import { generateSubstackRemovalInstructions } from './substack.js';
import { createSiteRevertPR, checkUnpublishPreviewGate } from './site.js';
import { revertProjectReadmeLink } from './readme.js';

export interface UnpublishContext {
  db: Database.Database;
  slug: string;
  config: BlogConfig;
  paths: {
    configPath: string;
    publishDir: string;
    socialDir: string;
  };
}

export interface UnpublishRunResult {
  completed: boolean;
  stepsRun: number;
  totalSteps: number;
  pausedStep?: string;
  failedStep?: string;
}

type StepOutcome =
  | { outcome: 'completed'; message: string }
  | { outcome: 'skipped'; message: string }
  | { outcome: 'paused'; message: string }
  | { outcome: 'failed'; message: string };

async function executeStep(
  ctx: UnpublishContext,
  name: UnpublishStepName,
): Promise<StepOutcome> {
  switch (name) {
    case 'verify-published': {
      const post = ctx.db
        .prepare('SELECT phase FROM posts WHERE slug = ?')
        .get(ctx.slug) as { phase: string } | undefined;
      if (!post) return { outcome: 'failed', message: `post not found: ${ctx.slug}` };
      if (post.phase !== 'published') {
        return {
          outcome: 'failed',
          message: `post in phase '${post.phase}', expected 'published'`,
        };
      }
      return { outcome: 'completed', message: 'published verified' };
    }
    case 'devto-unpublish': {
      const result = await unpublishFromDevTo(ctx.slug, ctx.config);
      if (result.skipped) {
        return { outcome: 'skipped', message: result.reason ?? 'Dev.to unpublish skipped' };
      }
      return {
        outcome: 'completed',
        message: result.url
          ? `Dev.to set published:false: ${result.url}`
          : `Dev.to set published:false (id ${result.id})`,
      };
    }
    case 'medium-instructions': {
      const result = generateMediumRemovalInstructions(ctx.db, ctx.slug, ctx.paths.socialDir);
      return { outcome: 'completed', message: `instructions written: ${result.path}` };
    }
    case 'substack-instructions': {
      const result = generateSubstackRemovalInstructions(ctx.db, ctx.slug, ctx.paths.socialDir);
      return { outcome: 'completed', message: `instructions written: ${result.path}` };
    }
    case 'revert-site-pr': {
      const result = createSiteRevertPR(ctx.slug, ctx.config, {
        configPath: ctx.paths.configPath,
        publishDir: ctx.paths.publishDir,
      });
      return {
        outcome: 'completed',
        message: `revert PR #${result.prNumber} opened: ${result.prUrl}`,
      };
    }
    case 'revert-preview-gate': {
      const result = checkUnpublishPreviewGate(ctx.slug, ctx.config, {
        configPath: ctx.paths.configPath,
        publishDir: ctx.paths.publishDir,
      });
      if (result.merged) return { outcome: 'completed', message: 'revert PR merged' };
      return {
        outcome: 'paused',
        message: result.message ?? 'revert PR not yet merged',
      };
    }
    case 'readme-revert': {
      const result = revertProjectReadmeLink(
        ctx.slug,
        ctx.config,
        { configPath: ctx.paths.configPath },
        ctx.db,
      );
      if (result.skipped) {
        return { outcome: 'skipped', message: result.reason ?? 'README revert skipped' };
      }
      return { outcome: 'completed', message: 'writing link removed from project README' };
    }
  }
}

function revertStepToPending(ctx: UnpublishContext, name: string): void {
  ctx.db
    .prepare(
      `UPDATE unpublish_steps
       SET status = ?, started_at = NULL
       WHERE post_slug = ? AND step_name = ?`,
    )
    .run('pending', ctx.slug, name);
}

export async function runUnpublishPipeline(
  ctx: UnpublishContext,
): Promise<UnpublishRunResult> {
  const release = acquirePublishLock(ctx.paths.publishDir, ctx.slug);
  try {
    const reclaimed = reclaimStaleRunning(ctx.db, ctx.slug);
    if (reclaimed > 0) {
      console.log(
        `Reclaimed ${reclaimed} stale 'running' unpublish step(s) from a prior interrupted run`,
      );
    }

    let stepsRun = 0;
    const total = UNPUBLISH_STEP_NAMES.length;

    while (true) {
      const next = getNextPendingStep(ctx.db, ctx.slug);
      if (next === null) break;
      const name = next.step_name as UnpublishStepName;

      markStepRunning(ctx.db, ctx.slug, name);
      let outcome: StepOutcome;
      try {
        outcome = await executeStep(ctx, name);
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        markStepFailed(ctx.db, ctx.slug, name, msg);
        console.error(`[${next.step_number}/${total}] ${name}: FAILED -- ${msg}`);
        return { completed: false, stepsRun, totalSteps: total, failedStep: name };
      }

      switch (outcome.outcome) {
        case 'completed':
          markStepCompleted(ctx.db, ctx.slug, name);
          console.log(`[${next.step_number}/${total}] ${name}: ${outcome.message}`);
          stepsRun += 1;
          break;
        case 'skipped':
          markStepSkipped(ctx.db, ctx.slug, name, outcome.message);
          console.log(`[${next.step_number}/${total}] ${name}: SKIPPED -- ${outcome.message}`);
          stepsRun += 1;
          break;
        case 'paused':
          revertStepToPending(ctx, name);
          console.log(`[${next.step_number}/${total}] ${name}: PAUSED -- ${outcome.message}`);
          return { completed: false, stepsRun, totalSteps: total, pausedStep: name };
        case 'failed':
          markStepFailed(ctx.db, ctx.slug, name, outcome.message);
          console.error(`[${next.step_number}/${total}] ${name}: FAILED -- ${outcome.message}`);
          return { completed: false, stepsRun, totalSteps: total, failedStep: name };
      }
    }

    if (allStepsComplete(ctx.db, ctx.slug)) {
      completeUnpublishUnderLock(ctx.db, ctx.slug, ctx.paths.publishDir);
      console.log(`Unpublish complete: '${ctx.slug}' is now unpublished`);
      return { completed: true, stepsRun, totalSteps: total };
    }
    console.error(
      `Unpublish for '${ctx.slug}' has no pending steps but is not fully complete.`,
    );
    return { completed: false, stepsRun, totalSteps: total };
  } finally {
    release();
  }
}
