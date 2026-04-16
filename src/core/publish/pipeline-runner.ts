import { PipelineContext } from './pipeline-types.js';
import { PIPELINE_STEPS } from './pipeline-registry.js';
import { acquirePublishLock } from './lock.js';
import {
  allStepsComplete,
  getNextPendingStep,
  markStepCompleted,
  markStepFailed,
  markStepRunning,
  markStepSkipped,
} from './steps-crud.js';
import { completePublish } from './phase.js';
import { PUBLISH_STEP_NAMES } from './types.js';

// Result of a full pipeline run. `completed` is true only when every step
// has reached completed/skipped status and the post has been advanced to
// the `published` phase. `stepsRun` counts the steps actually executed in
// this invocation (excludes previously completed/skipped steps).
export interface PipelineRunResult {
  completed: boolean;
  stepsRun: number;
  totalSteps: number;
  failedStep?: string;
  pausedStep?: string;
}

const TOTAL_STEPS = PUBLISH_STEP_NAMES.length;

// Revert a step from 'running' back to 'pending' so a subsequent
// runPipeline invocation picks it up again. Used when a step returns
// the 'paused' outcome (e.g., preview-gate waiting for PR merge).
function revertStepToPending(
  ctx: PipelineContext,
  stepName: string,
): void {
  ctx.db
    .prepare(
      'UPDATE pipeline_steps SET status = ?, started_at = NULL WHERE post_slug = ? AND step_name = ?',
    )
    .run('pending', ctx.slug, stepName);
}

// Execute the publish pipeline for a post. Acquires a slug-scoped FS
// lock, iterates through pending/failed steps in order, and advances the
// post to `published` when all steps complete. The runner is async because
// the crosspost-devto step returns a Promise.
//
// Resume semantics: the loop calls getNextPendingStep on each iteration,
// which returns the first step with status 'pending' or 'failed' by
// step_number order. Steps that were completed or skipped in a prior run
// are naturally skipped.
//
// Pause semantics: when a step returns outcome 'paused', the runner
// reverts the step to 'pending' and returns immediately. Re-running
// `blog publish start` after the blocking condition clears (e.g., PR
// merge) picks up from the paused step.
export async function runPipeline(
  ctx: PipelineContext,
): Promise<PipelineRunResult> {
  const release = acquirePublishLock(ctx.paths.publishDir, ctx.slug);
  try {
    let stepsRun = 0;

    while (true) {
      const nextStep = getNextPendingStep(ctx.db, ctx.slug);
      if (nextStep === null) {
        break;
      }

      const stepDef = PIPELINE_STEPS.find((s) => s.name === nextStep.step_name);
      if (!stepDef) {
        markStepFailed(
          ctx.db,
          ctx.slug,
          nextStep.step_name,
          `Unknown step: ${nextStep.step_name}`,
        );
        return {
          completed: false,
          stepsRun,
          totalSteps: TOTAL_STEPS,
          failedStep: nextStep.step_name,
        };
      }

      markStepRunning(ctx.db, ctx.slug, nextStep.step_name);

      let result;
      try {
        result = await stepDef.execute(ctx);
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        markStepFailed(ctx.db, ctx.slug, nextStep.step_name, message);
        console.error(
          `[${nextStep.step_number}/${TOTAL_STEPS}] ${nextStep.step_name}: FAILED -- ${message}`,
        );
        return {
          completed: false,
          stepsRun,
          totalSteps: TOTAL_STEPS,
          failedStep: nextStep.step_name,
        };
      }

      switch (result.outcome) {
        case 'completed': {
          markStepCompleted(ctx.db, ctx.slug, nextStep.step_name);
          if (result.urlUpdates) {
            Object.assign(ctx.urls, result.urlUpdates);
          }
          console.log(
            `[${nextStep.step_number}/${TOTAL_STEPS}] ${nextStep.step_name}: ${result.message}`,
          );
          stepsRun += 1;
          break;
        }
        case 'skipped': {
          markStepSkipped(ctx.db, ctx.slug, nextStep.step_name, result.message);
          console.log(
            `[${nextStep.step_number}/${TOTAL_STEPS}] ${nextStep.step_name}: SKIPPED -- ${result.message}`,
          );
          stepsRun += 1;
          break;
        }
        case 'paused': {
          revertStepToPending(ctx, nextStep.step_name);
          console.log(
            `[${nextStep.step_number}/${TOTAL_STEPS}] ${nextStep.step_name}: PAUSED -- ${result.message}`,
          );
          return {
            completed: false,
            stepsRun,
            totalSteps: TOTAL_STEPS,
            pausedStep: nextStep.step_name,
          };
        }
        case 'failed': {
          markStepFailed(ctx.db, ctx.slug, nextStep.step_name, result.message);
          console.error(
            `[${nextStep.step_number}/${TOTAL_STEPS}] ${nextStep.step_name}: FAILED -- ${result.message}`,
          );
          return {
            completed: false,
            stepsRun,
            totalSteps: TOTAL_STEPS,
            failedStep: nextStep.step_name,
          };
        }
      }
    }

    // All pending/failed steps exhausted. Verify completeness and advance
    // the post to the published phase. `completePublish` re-acquires the
    // same slug-scoped lock, so we must release ours first — the FS lock is
    // not reentrant within a single process. The `finally` block below is
    // idempotent (release swallows ENOENT), so calling release() twice is
    // safe.
    if (allStepsComplete(ctx.db, ctx.slug)) {
      release();
      completePublish(ctx.db, ctx.slug, ctx.urls, ctx.paths.publishDir);
      console.log(`Pipeline complete: ${ctx.slug} is now published`);
      return { completed: true, stepsRun, totalSteps: TOTAL_STEPS };
    }

    // Defensive: getNextPendingStep returned null but allStepsComplete is
    // false — some steps may still be in 'running' state from a crashed
    // prior run. Log a warning so the operator can inspect.
    console.error(
      `Pipeline for '${ctx.slug}' has no pending steps but is not fully complete. ` +
      `Inspect pipeline_steps for stuck 'running' rows.`,
    );
    return { completed: false, stepsRun, totalSteps: TOTAL_STEPS };
  } finally {
    release();
  }
}
