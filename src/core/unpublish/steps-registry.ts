// Phase 7: unpublish pipeline step registry. Seven persisted steps;
// finalization (phase advance + unpublished_at + metrics) is runner-owned
// and NOT a persisted step.
//
// Order matters — the runner iterates by step_number and pauses at
// `revert-preview-gate` until the site-revert PR merges.

export const UNPUBLISH_STEP_NAMES = [
  'verify-published',
  'devto-unpublish',
  'medium-instructions',
  'substack-instructions',
  'revert-site-pr',
  'revert-preview-gate',
  'readme-revert',
] as const;

export type UnpublishStepName = typeof UNPUBLISH_STEP_NAMES[number];
