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
  reclaimStaleRunning,
  reconcilePipelineSteps,
} from './steps-crud.js';
import {
  completePublishUnderLock,
  completeUpdateUnderLock,
  persistPublishUrls,
} from './phase.js';
import { PUBLISH_STEP_NAMES } from './types.js';
import { ContentType } from '../db/types.js';

// Result of a full pipeline run. `completed` is true only when every step
// has reached completed/skipped status and the post has been advanced
// (initial mode: to `published`; update mode: update_cycles row closed).
// `stepsRun` counts the steps actually executed in this invocation (excludes
// previously completed/skipped steps).
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
// the 'paused' outcome (e.g., preview-gate waiting for PR merge). Scoped
// by cycle so updates and initial publish stay cleanly isolated.
function revertStepToPending(
  ctx: PipelineContext,
  stepName: string,
): void {
  ctx.db
    .prepare(
      'UPDATE pipeline_steps SET status = ?, started_at = NULL ' +
      'WHERE post_slug = ? AND cycle_id = ? AND step_name = ?',
    )
    .run('pending', ctx.slug, ctx.cycleId, stepName);
}

// Execute the publish pipeline for a post. Acquires a slug-scoped FS
// lock, iterates through pending/failed steps in order, and finalizes
// the cycle when all steps complete. Mode dispatch happens at finalize
// (initial publish vs update cycle close); per-step behavior dispatches
// inside step bodies on `ctx.publishMode` where needed.
//
// Resume semantics: the loop calls getNextPendingStep on each iteration,
// which returns the first step with status 'pending' or 'failed' by
// step_number order for the current cycle.
//
// Pause semantics: when a step returns outcome 'paused', the runner
// reverts the step to 'pending' and returns immediately. Re-running
// `blog publish start` (or `blog update publish`) after the blocking
// condition clears picks up from the paused step.
export async function runPipeline(
  ctx: PipelineContext,
): Promise<PipelineRunResult> {
  const release = acquirePublishLock(ctx.paths.publishDir, ctx.slug);
  try {
    // Reclaim stale `running` rows from a crashed prior runner. We hold the
    // lock, so anything in `running` can't have a live owner. If we didn't
    // reclaim, getNextPendingStep would skip past the interrupted row and
    // execute the next step out of order. Must happen BEFORE the loop.
    const reclaimed = reclaimStaleRunning(ctx.db, ctx.slug, ctx.cycleId);
    if (reclaimed > 0) {
      console.log(
        `Reclaimed ${reclaimed} stale 'running' step(s) from a prior interrupted run`,
      );
    }

    // Reconcile existing pending/failed rows against the CURRENT config
    // so the operator can disable optional destinations (publish.devto /
    // publish.medium / publish.substack) by editing .blogrc.yaml between
    // runs. Without this, INSERT OR IGNORE in createPipelineSteps freezes
    // the initial seed decision forever. Look up content_type here — the
    // PipelineContext does not carry it directly because steps use
    // different content-type signals and we want one authoritative read.
    const postRow = ctx.db
      .prepare('SELECT content_type FROM posts WHERE slug = ?')
      .get(ctx.slug) as { content_type: ContentType | null } | undefined;
    if (postRow?.content_type) {
      const reconciled = reconcilePipelineSteps(
        ctx.db,
        ctx.slug,
        postRow.content_type,
        ctx.config,
        undefined,
        ctx.cycleId,
      );
      if (reconciled > 0) {
        console.log(
          `Reconciled ${reconciled} pipeline step(s) against current config ` +
          `(marked as skipped because the current config disables them)`,
        );
      }
    }

    let stepsRun = 0;

    while (true) {
      const nextStep = getNextPendingStep(ctx.db, ctx.slug, ctx.cycleId);
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
          ctx.cycleId,
        );
        return {
          completed: false,
          stepsRun,
          totalSteps: TOTAL_STEPS,
          failedStep: nextStep.step_name,
        };
      }

      markStepRunning(ctx.db, ctx.slug, nextStep.step_name, ctx.cycleId);

      let result;
      try {
        result = await stepDef.execute(ctx);
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        markStepFailed(
          ctx.db,
          ctx.slug,
          nextStep.step_name,
          message,
          ctx.cycleId,
        );
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
          // Mark completed AND persist URLs atomically so a crash between
          // these two writes cannot leave URLs unrecoverable. If the process
          // dies before the commit lands, the step stays `running` and the
          // reclaim pass above demotes it to `pending` on resume; the step
          // module is idempotent, so the re-execution succeeds.
          const urlUpdates = result.urlUpdates;
          const tx = ctx.db.transaction(() => {
            markStepCompleted(
              ctx.db,
              ctx.slug,
              nextStep.step_name,
              ctx.cycleId,
            );
            if (urlUpdates) {
              persistPublishUrls(ctx.db, ctx.slug, urlUpdates);
            }
          });
          tx();
          if (urlUpdates) {
            Object.assign(ctx.urls, urlUpdates);
          }
          console.log(
            `[${nextStep.step_number}/${TOTAL_STEPS}] ${nextStep.step_name}: ${result.message}`,
          );
          stepsRun += 1;
          break;
        }
        case 'skipped': {
          markStepSkipped(
            ctx.db,
            ctx.slug,
            nextStep.step_name,
            result.message,
            ctx.cycleId,
          );
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
          markStepFailed(
            ctx.db,
            ctx.slug,
            nextStep.step_name,
            result.message,
            ctx.cycleId,
          );
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

    // All pending/failed steps exhausted. Verify completeness and finalize
    // the cycle. We stay under the lock by calling the `UnderLock` variants
    // — this closes the race window a prior implementation had
    // (release-then-complete let a second waiting runner call complete with
    // its own empty ctx.urls between the release and re-acquire). Per-step
    // URL persistence plus this lock-across-completion policy together
    // guarantee that:
    //   1. Every URL a step produces is persisted to the row before we move
    //      on to the next step (crash-safe).
    //   2. Only one runner can transition the row (race-safe).
    //   3. The finalizers are idempotent on an already-finalized post or
    //      closed cycle, so a concurrent runner that reaches this path
    //      after another completed is a harmless no-op.
    if (allStepsComplete(ctx.db, ctx.slug, ctx.cycleId)) {
      if (ctx.publishMode === 'update') {
        completeUpdateUnderLock(
          ctx.db,
          ctx.slug,
          ctx.cycleId,
          ctx.urls,
          ctx.paths.publishDir,
        );
        console.log(
          `Pipeline complete: update cycle ${ctx.cycleId} for ${ctx.slug} closed`,
        );
      } else {
        completePublishUnderLock(
          ctx.db,
          ctx.slug,
          ctx.urls,
          ctx.paths.publishDir,
        );
        console.log(`Pipeline complete: ${ctx.slug} is now published`);
      }
      return { completed: true, stepsRun, totalSteps: TOTAL_STEPS };
    }

    // Defensive: reclaim pass + atomic step transitions should make this
    // branch unreachable, but we log and surface a non-completed result
    // rather than silently returning, so operators notice schema drift or
    // an unexpected state machine hole.
    console.error(
      `Pipeline for '${ctx.slug}' has no pending steps but is not fully complete. ` +
      `Inspect pipeline_steps for rows that are neither completed nor skipped.`,
    );
    return { completed: false, stepsRun, totalSteps: TOTAL_STEPS };
  } finally {
    release();
  }
}
