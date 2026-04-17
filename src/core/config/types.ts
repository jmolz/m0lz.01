export interface SiteConfig {
  repo_path: string;
  base_url: string;
  content_dir: string;
  research_dir: string;
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

// Phase 7: mode for the `site-update` step when an update-publish cycle
// commits regenerated MDX + assets to the site repo. 'pr' (default) mirrors
// initial publish: open a branch, push, open PR, pause on preview-gate
// until merged. 'direct' pushes straight to main — faster but skips review.
export type SiteUpdateMode = 'pr' | 'direct';

export interface UpdatesConfig {
  // Existing Phase 1 fields:
  preserve_original_data: boolean;
  update_notice: boolean;
  update_crosspost: boolean;

  // Phase 7 additions:
  // PUT the Dev.to article body during `blog update publish`.
  devto_update: boolean;
  // Regenerate Medium/Substack paste files with update framing.
  refresh_paste_files: boolean;
  // Template for the update notice block appended to the MDX body.
  // Placeholders: {DATE} (YYYY-MM-DD), {SUMMARY} (from update_cycles.summary).
  notice_template: string;
  // Enforce `--summary "..."` on `blog update start`. Default true.
  require_summary: boolean;
  // Commit strategy for the regenerated MDX during update publish.
  site_update_mode: SiteUpdateMode;
}

// Phase 7: controls which unpublish steps run. Site-revert is deliberately
// PR-only (no `site_revert_mode` flag) because the destructive operation
// deserves review.
export interface UnpublishConfig {
  devto: boolean;    // PUT published:false on the Dev.to article
  medium: boolean;   // Generate manual-removal instructions for Medium
  substack: boolean; // Generate manual-removal instructions for Substack
  readme: boolean;   // Remove the writing link from the project README
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
  unpublish: UnpublishConfig;
  projects?: Record<string, string>;
}
