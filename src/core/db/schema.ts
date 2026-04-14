export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
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
