import Database from 'better-sqlite3';

import { BlogConfig } from '../config/types.js';
import { PublishPaths, PublishStepName, PublishUrls } from './types.js';

// Execution context threaded through every step in the publish pipeline.
// `paths` is Required<PublishPaths> at runtime — the CLI boundary must
// materialize every field before constructing the context. `urls` is
// mutated as steps produce platform URLs; the runner merges urlUpdates
// from each step result back into this object.
export interface PipelineContext {
  db: Database.Database;
  slug: string;
  config: BlogConfig;
  paths: Required<PublishPaths>;
  urls: PublishUrls;
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
