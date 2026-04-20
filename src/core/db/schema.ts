export const SCHEMA_VERSION = 4;

export const SCHEMA_V1_SQL = `
-- Core post tracking
CREATE TABLE IF NOT EXISTS posts (
  slug TEXT PRIMARY KEY,
  title TEXT,
  topic TEXT,
  content_type TEXT CHECK(content_type IN ('project-launch', 'technical-deep-dive', 'analysis-opinion')),
  phase TEXT CHECK(phase IN ('idea', 'research', 'benchmark', 'draft', 'evaluate', 'publish', 'published', 'unpublished')),
  mode TEXT CHECK(mode IN ('directed', 'exploratory', 'imported')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME,
  unpublished_at DATETIME,
  last_updated_at DATETIME,
  site_url TEXT,
  devto_url TEXT,
  medium_url TEXT,
  substack_url TEXT,
  repo_url TEXT,
  project_id TEXT,
  evaluation_passed BOOLEAN,
  evaluation_score REAL,
  has_benchmarks BOOLEAN DEFAULT FALSE,
  update_count INTEGER DEFAULT 0
);

-- Research source tracking
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT REFERENCES posts(slug),
  url TEXT NOT NULL,
  title TEXT,
  excerpt TEXT,
  source_type TEXT CHECK(source_type IN ('external', 'benchmark', 'primary')) DEFAULT 'external',
  accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Benchmark run tracking
CREATE TABLE IF NOT EXISTS benchmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT REFERENCES posts(slug),
  run_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  environment_json TEXT NOT NULL,
  results_path TEXT NOT NULL,
  is_update BOOLEAN DEFAULT FALSE,
  previous_run_id INTEGER REFERENCES benchmarks(id),
  status TEXT CHECK(status IN ('pending', 'running', 'completed', 'failed')) DEFAULT 'pending'
);

-- Pipeline sub-step tracking for resume-on-failure
CREATE TABLE IF NOT EXISTS pipeline_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT REFERENCES posts(slug),
  step_number INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT CHECK(status IN ('pending', 'running', 'completed', 'failed', 'skipped')) DEFAULT 'pending',
  started_at DATETIME,
  completed_at DATETIME,
  error_message TEXT,
  UNIQUE(post_slug, step_name)
);

-- Generated assets (diagrams, charts, images)
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT REFERENCES posts(slug),
  type TEXT CHECK(type IN ('excalidraw', 'chart', 'image', 'benchmark_viz')),
  filename TEXT NOT NULL,
  generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Three-reviewer evaluation panel results
CREATE TABLE IF NOT EXISTS evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT REFERENCES posts(slug),
  reviewer TEXT CHECK(reviewer IN ('structural', 'adversarial', 'methodology')) NOT NULL,
  model TEXT NOT NULL,
  passed BOOLEAN,
  issues_json TEXT,
  report_path TEXT NOT NULL,
  run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_update_review BOOLEAN DEFAULT FALSE
);

-- Synthesized evaluation verdicts
CREATE TABLE IF NOT EXISTS evaluation_synthesis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT REFERENCES posts(slug),
  consensus_issues INTEGER DEFAULT 0,
  majority_issues INTEGER DEFAULT 0,
  single_issues INTEGER DEFAULT 0,
  verdict TEXT CHECK(verdict IN ('pass', 'fail')) NOT NULL,
  report_path TEXT NOT NULL,
  synthesized_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- General event log for metrics
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT REFERENCES posts(slug),
  event TEXT NOT NULL,
  value TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const SCHEMA_V2_SQL = `
-- Dedupe sources by (post_slug, url). Added in Phase 2 research pipeline.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_post_url ON sources(post_slug, url);
`;

// Phase 7 schema changes:
//
// 1. pipeline_steps table rebuild — add cycle_id (NOT NULL DEFAULT 0) so the
//    same 11 step names can repeat across publish cycles (initial publish
//    uses cycle_id=0; each update cycle uses its own update_cycles.id).
//    Replace UNIQUE(post_slug, step_name) with
//    UNIQUE(post_slug, cycle_id, step_name). Uses the SQLite canonical
//    transactional table-rebuild pattern: rename old -> create new ->
//    INSERT..SELECT cycle_id=0 -> drop old. Foreign keys are disabled around
//    the rebuild (see database.ts migrate()) so the rebuild does not trigger
//    cascade behavior against referencing columns during the interim state.
//
// 2. update_cycles — first-class rows for update lifecycle. Partial unique
//    index idx_update_cycles_open enforces "at most one open cycle per post"
//    at the DB level (WHERE closed_at IS NULL).
//
// 3. unpublish_steps — parallel to pre-v3 pipeline_steps shape. No cycle_id
//    because unpublish is one-shot per post (a second unpublish is either
//    idempotent no-op or requires a prior re-publish). Step-name collision
//    with pipeline_steps is avoided by using a disjoint table, not by
//    prefix.
export const SCHEMA_V3_SQL = `
-- 1. pipeline_steps rebuild (add cycle_id + composite uniqueness).
ALTER TABLE pipeline_steps RENAME TO pipeline_steps_old;

CREATE TABLE pipeline_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT REFERENCES posts(slug),
  step_number INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT CHECK(status IN ('pending', 'running', 'completed', 'failed', 'skipped')) DEFAULT 'pending',
  started_at DATETIME,
  completed_at DATETIME,
  error_message TEXT,
  cycle_id INTEGER NOT NULL DEFAULT 0,
  UNIQUE(post_slug, cycle_id, step_name)
);

INSERT INTO pipeline_steps (
  id, post_slug, step_number, step_name, status,
  started_at, completed_at, error_message, cycle_id
)
SELECT
  id, post_slug, step_number, step_name, status,
  started_at, completed_at, error_message, 0
FROM pipeline_steps_old;

DROP TABLE pipeline_steps_old;

-- 2. update_cycles — open/closed update cycles as first-class rows.
CREATE TABLE update_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT NOT NULL REFERENCES posts(slug),
  cycle_number INTEGER NOT NULL,
  summary TEXT,
  opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME,
  ended_reason TEXT CHECK(ended_reason IS NULL OR ended_reason IN ('completed', 'aborted'))
);

CREATE UNIQUE INDEX idx_update_cycles_open
  ON update_cycles(post_slug) WHERE closed_at IS NULL;

-- 3. unpublish_steps — parallel to pre-v3 pipeline_steps shape.
CREATE TABLE unpublish_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT REFERENCES posts(slug),
  step_number INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT CHECK(status IN ('pending', 'running', 'completed', 'failed', 'skipped')) DEFAULT 'pending',
  started_at DATETIME,
  completed_at DATETIME,
  error_message TEXT,
  UNIQUE(post_slug, step_name)
);
`;

// Phase 8 schema changes (v4): DB-authoritative agent-plan execution state.
//
// Pre-v4 `blog agent apply` used the receipt JSON file as the sole source of
// truth for "which steps have already run". The receipt had no authenticity
// guarantee beyond a `plan_payload_hash` field that the operator (or the
// skill under a compromised scope) could trivially reconstruct — forged rows
// with `status: "completed"` silently suppressed execution (Codex Phase-8
// adversarial review, High #1).
//
// v4 moves authoritative step-completion state into SQLite under two tables,
// scoped by `plan_id`. The receipt file remains for audit, but `applyPlan`
// derives its skip authority from `agent_plan_steps`, not from the JSON.
// Tampering the receipt becomes a no-op; the only way to suppress a step is
// to mutate the DB, which requires the operator's privileges by definition.
//
// `agent_plan_runs` is keyed on `plan_id` — the same plan content can be
// re-approved (keeping the same `plan_id`) with new content bytes, and the
// apply path reconciles by checking `plan_payload_hash` against the plan's
// current hash.
//
// `agent_plan_steps` stores the authoritative per-step execution record.
// `UNIQUE(plan_id, step_number)` means re-executing a step (on resume after a
// transient failure) replaces the prior row via INSERT OR REPLACE rather than
// accumulating history — the receipt file is the append-once audit artifact,
// and per-step history is recoverable from Git if ever needed.
export const SCHEMA_V4_SQL = `
CREATE TABLE agent_plan_runs (
  plan_id TEXT PRIMARY KEY,
  plan_payload_hash TEXT NOT NULL,
  slug TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  applied_at DATETIME NOT NULL,
  completed_at DATETIME,
  overall_exit INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE agent_plan_steps (
  plan_id TEXT NOT NULL REFERENCES agent_plan_runs(plan_id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  command TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('completed', 'failed', 'skipped')),
  exit_code INTEGER NOT NULL,
  stdout_tail TEXT NOT NULL,
  stderr_tail TEXT NOT NULL,
  started_at DATETIME NOT NULL,
  completed_at DATETIME NOT NULL,
  duration_ms INTEGER NOT NULL,
  PRIMARY KEY (plan_id, step_number)
);
`;
