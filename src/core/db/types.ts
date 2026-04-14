export type ContentType = 'project-launch' | 'technical-deep-dive' | 'analysis-opinion';

export type Phase = 'idea' | 'research' | 'benchmark' | 'draft' | 'evaluate' | 'publish' | 'published' | 'unpublished';

export type Mode = 'directed' | 'exploratory' | 'imported';

export interface PostRow {
  slug: string;
  title: string | null;
  topic: string | null;
  content_type: ContentType | null;
  phase: Phase;
  mode: Mode;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  unpublished_at: string | null;
  last_updated_at: string | null;
  site_url: string | null;
  devto_url: string | null;
  medium_url: string | null;
  substack_url: string | null;
  repo_url: string | null;
  project_id: string | null;
  evaluation_passed: number | null;
  evaluation_score: number | null;
  has_benchmarks: number;
  update_count: number;
}

export type SourceType = 'external' | 'benchmark' | 'primary';

export interface SourceRow {
  id: number;
  post_slug: string;
  url: string;
  title: string | null;
  excerpt: string | null;
  source_type: SourceType;
  accessed_at: string;
}

export type BenchmarkStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface BenchmarkRow {
  id: number;
  post_slug: string;
  run_date: string;
  environment_json: string;
  results_path: string;
  is_update: number;
  previous_run_id: number | null;
  status: BenchmarkStatus;
}

export type PipelineStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface PipelineStepRow {
  id: number;
  post_slug: string;
  step_number: number;
  step_name: string;
  status: PipelineStatus;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

export type AssetType = 'excalidraw' | 'chart' | 'image' | 'benchmark_viz';

export interface AssetRow {
  id: number;
  post_slug: string;
  type: AssetType;
  filename: string;
  generated_at: string;
}

export type ReviewerType = 'structural' | 'adversarial' | 'methodology';

export interface EvaluationRow {
  id: number;
  post_slug: string;
  reviewer: ReviewerType;
  model: string;
  passed: number | null;
  issues_json: string | null;
  report_path: string;
  run_at: string;
  is_update_review: number;
}

export type Verdict = 'pass' | 'fail';

export interface EvaluationSynthesisRow {
  id: number;
  post_slug: string;
  consensus_issues: number;
  majority_issues: number;
  single_issues: number;
  verdict: Verdict;
  report_path: string;
  synthesized_at: string;
}

export interface MetricRow {
  id: number;
  post_slug: string;
  event: string;
  value: string | null;
  timestamp: string;
}
