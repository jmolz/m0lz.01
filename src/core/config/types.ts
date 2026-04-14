export interface SiteConfig {
  repo_path: string;
  base_url: string;
  content_dir: string;
}

export interface AuthorConfig {
  name: string;
  github: string;
  devto?: string;
  medium?: string;
  substack?: string;
  linkedin?: string;
}

export interface ReviewersConfig {
  structural: string;
  adversarial: string;
  methodology: string;
}

export interface CodexConfig {
  adversarial_effort: string;
  methodology_effort: string;
}

export interface AIConfig {
  primary: string;
  reviewers: ReviewersConfig;
  codex: CodexConfig;
}

export interface ContentTypeEntry {
  benchmark: string;
  companion_repo: string;
  social_prefix: string;
}

export interface ContentTypesConfig {
  'project-launch': ContentTypeEntry;
  'technical-deep-dive': ContentTypeEntry;
  'analysis-opinion': ContentTypeEntry;
}

export interface BenchmarkConfig {
  capture_environment: boolean;
  methodology_template: boolean;
  preserve_raw_data: boolean;
  multiple_runs: number;
}

export interface PublishConfig {
  devto: boolean;
  medium: boolean;
  substack: boolean;
  github_repos: boolean;
  social_drafts: boolean;
  research_pages: boolean;
}

export interface SocialConfig {
  platforms: string[];
  timing_recommendations: boolean;
}

export interface EvaluationConfig {
  require_pass: boolean;
  min_sources: number;
  max_reading_level: number;
  three_reviewer_panel: boolean;
  consensus_must_fix: boolean;
  majority_should_fix: boolean;
  single_advisory: boolean;
  verify_benchmark_claims: boolean;
  methodology_completeness: boolean;
}

export interface UpdatesConfig {
  preserve_original_data: boolean;
  update_notice: boolean;
  update_crosspost: boolean;
}

export interface BlogConfig {
  site: SiteConfig;
  author: AuthorConfig;
  ai: AIConfig;
  content_types: ContentTypesConfig;
  benchmark: BenchmarkConfig;
  publish: PublishConfig;
  social: SocialConfig;
  evaluation: EvaluationConfig;
  updates: UpdatesConfig;
}
