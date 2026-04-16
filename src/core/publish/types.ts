// Publish pipeline type contracts.
//
// The publish pipeline is an 11-step sequential process tracked per post in
// the `pipeline_steps` SQLite table. Each step's name is taken from
// PUBLISH_STEP_NAMES below — `step_number` is the 1-based position of that
// name in the tuple. The ordering is authoritative: runners must execute
// steps in this order, and resume-on-failure restarts from the first
// non-completed step.
//
// Step status values mirror the CHECK constraint on pipeline_steps.status:
//   pending   — created but not yet attempted
//   running   — currently executing (started_at set, completed_at null)
//   completed — finished successfully
//   failed    — execution raised; error_message populated
//   skipped   — intentionally bypassed (content-type routing or config flag)

export const PUBLISH_STEP_NAMES = [
  'verify',
  'research-page',
  'site-pr',
  'preview-gate',
  'crosspost-devto',
  'paste-medium',
  'paste-substack',
  'companion-repo',
  'update-frontmatter',
  'update-readme',
  'social-text',
] as const;

export type PublishStepName = typeof PUBLISH_STEP_NAMES[number];

export type PublishStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

// Row shape for a single entry in the pipeline_steps table. Narrower than the
// DB-generic PipelineStepRow in db/types.ts — step_name is constrained to the
// 11 known publish step names and status to the publish-specific enum.
export interface PipelineStepRow {
  id: number;
  post_slug: string;
  step_number: number;
  step_name: PublishStepName;
  status: PublishStepStatus;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

// URLs collected across the publish pipeline. Each field is populated by the
// step that owns that destination; steps that fail (or are skipped) leave
// their URL undefined. `completePublish` writes any defined URLs to the post
// row via a coalesce pattern (only UPDATE fields where a value is provided).
export interface PublishUrls {
  site_url?: string;
  devto_url?: string;
  medium_url?: string;
  substack_url?: string;
  repo_url?: string;
}

// Injectable path bundle used by CLI handlers and step executors. Keeps every
// concrete filesystem path threaded through parameters rather than resolved
// inline, so tests can redirect each input to a temp dir. Every field is
// optional at the type level because individual steps need only a subset; the
// CLI boundary materializes the full set from config + runtime state.
export interface PublishPaths {
  dbPath?: string;
  configPath?: string;
  draftsDir?: string;
  benchmarkDir?: string;
  evaluationsDir?: string;
  researchDir?: string;
  reposDir?: string;
  socialDir?: string;
  researchPagesDir?: string;
  publishDir?: string;
}
