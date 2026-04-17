import Database from 'better-sqlite3';

import { BlogConfig } from '../config/types.js';
import { PublishPaths, PublishStepName, PublishUrls } from './types.js';

// Mode dispatch for the publish pipeline. `initial` is the Phase 6 flow —
// evaluate-passed post goes to `published`. `update` is Phase 7 — a
// published post re-runs selected steps inside an open update_cycles row,
// and `posts.phase` stays `published` throughout. Step bodies branch on
// `ctx.publishMode` where behavior differs; `runInModes` on StepDefinition
// (Task C2) governs whether a step runs at all per mode.
export type PublishMode = 'initial' | 'update';

// Execution context threaded through every step in the publish pipeline.
// `paths` is Required<PublishPaths> at runtime — the CLI boundary must
// materialize every field before constructing the context. `urls` is
// mutated as steps produce platform URLs; the runner merges urlUpdates
// from each step result back into this object.
//
// Phase 7: `publishMode` dispatches step behavior. `cycleId` scopes
// pipeline_steps queries — 0 for initial publish, update_cycles.id for
// updates. Together they let a single runner drive both flows.
export interface PipelineContext {
  db: Database.Database;
  slug: string;
  config: BlogConfig;
  paths: Required<PublishPaths>;
  urls: PublishUrls;
  publishMode: PublishMode;
  cycleId: number;
  // Optional override for the slug-scoped FS lock timeout. Tests use a
  // short timeout to fail fast on a held lock when asserting cross-flow
  // mutual exclusion. Production callers should omit this and accept
  // the 10s default from acquirePublishLock. Documented as test-only
  // in .claude/rules/lifecycle.md.
  lockTimeoutMs?: number;
}

export type StepOutcome = 'completed' | 'failed' | 'skipped' | 'paused';

export interface StepResult {
  outcome: StepOutcome;
  message: string;
  data?: Record<string, unknown>;
  urlUpdates?: Partial<PublishUrls>;
}

// Definition of a single pipeline step. The `execute` function may return
// either a StepResult directly (sync steps) or a Promise<StepResult>
// (async steps like crosspost-devto). The runner always `await`s the
// return value so both shapes are handled uniformly.
export interface StepDefinition {
  number: number;
  name: PublishStepName;
  execute: (ctx: PipelineContext) => Promise<StepResult> | StepResult;
}
