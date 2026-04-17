import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

import yaml from 'js-yaml';

import { BlogConfig } from './types.js';

const DEFAULT_BENCHMARK: BlogConfig['benchmark'] = {
  capture_environment: true,
  methodology_template: true,
  preserve_raw_data: true,
  multiple_runs: 3,
};

const DEFAULT_PUBLISH: BlogConfig['publish'] = {
  devto: true,
  medium: true,
  substack: true,
  github_repos: true,
  social_drafts: true,
  research_pages: true,
};

const DEFAULT_SOCIAL: BlogConfig['social'] = {
  platforms: ['linkedin', 'hackernews'],
  timing_recommendations: true,
};

const DEFAULT_EVALUATION: BlogConfig['evaluation'] = {
  require_pass: true,
  min_sources: 3,
  max_reading_level: 12,
  three_reviewer_panel: true,
  consensus_must_fix: true,
  majority_should_fix: true,
  single_advisory: true,
  verify_benchmark_claims: true,
  methodology_completeness: true,
};

const DEFAULT_UPDATES: BlogConfig['updates'] = {
  preserve_original_data: true,
  update_notice: true,
  update_crosspost: true,
  devto_update: true,
  refresh_paste_files: true,
  notice_template: 'Updated {DATE}: {SUMMARY}',
  require_summary: true,
  site_update_mode: 'pr',
};

const DEFAULT_UNPUBLISH: BlogConfig['unpublish'] = {
  devto: true,
  medium: true,
  substack: true,
  readme: true,
};

export function loadConfig(configPath: string): BlogConfig {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}. Run 'blog init' first.`);
  }

  const raw = yaml.load(readFileSync(configPath, 'utf-8'));
  const config = validateConfig(raw);

  // Resolve relative paths against the config file's directory
  const configDir = dirname(resolve(configPath));
  config.site.repo_path = resolve(configDir, config.site.repo_path);

  return config;
}

export function validateConfig(raw: unknown): BlogConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid config: expected a YAML object');
  }

  const obj = raw as Record<string, unknown>;

  // Validate required: site
  if (!obj.site || typeof obj.site !== 'object') {
    throw new Error('Missing required config section: site');
  }
  const site = obj.site as Record<string, unknown>;
  if (!site.repo_path || typeof site.repo_path !== 'string') {
    throw new Error('Missing required config field: site.repo_path');
  }
  if (!site.base_url || typeof site.base_url !== 'string') {
    throw new Error('Missing required config field: site.base_url');
  }

  // Validate required: author
  if (!obj.author || typeof obj.author !== 'object') {
    throw new Error('Missing required config section: author');
  }
  const author = obj.author as Record<string, unknown>;
  if (!author.name || typeof author.name !== 'string') {
    throw new Error('Missing required config field: author.name');
  }
  if (!author.github || typeof author.github !== 'string') {
    throw new Error('Missing required config field: author.github');
  }

  // Validate optional projects map. When present, every value must be a string
  // (the path to the project repo). We do NOT resolve these paths here; that
  // happens at use time in the publish pipeline where the config path is known.
  let projects: Record<string, string> | undefined;
  if (obj.projects !== undefined) {
    if (typeof obj.projects !== 'object' || obj.projects === null || Array.isArray(obj.projects)) {
      throw new Error('Config field projects must be a map of {projectId: repoPath}');
    }
    projects = {};
    for (const [k, v] of Object.entries(obj.projects as Record<string, unknown>)) {
      if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`Config field projects['${k}'] must be a non-empty string path`);
      }
      projects[k] = v;
    }
  }

  return {
    site: {
      repo_path: site.repo_path,
      base_url: site.base_url,
      content_dir: (site.content_dir as string) || 'content/posts',
      research_dir: (site.research_dir as string) || 'content/research',
    },
    author: {
      name: author.name,
      github: author.github,
      devto: author.devto as string | undefined,
      medium: author.medium as string | undefined,
      substack: author.substack as string | undefined,
      linkedin: author.linkedin as string | undefined,
    },
    ai: (obj.ai as BlogConfig['ai']) || {
      primary: 'claude-code',
      reviewers: { structural: 'claude-code', adversarial: 'codex-cli', methodology: 'codex-cli' },
      codex: { adversarial_effort: 'high', methodology_effort: 'xhigh' },
    },
    content_types: (obj.content_types as BlogConfig['content_types']) || {
      'project-launch': { benchmark: 'optional', companion_repo: 'existing', social_prefix: 'Show HN:' },
      'technical-deep-dive': { benchmark: 'required', companion_repo: 'new', social_prefix: '' },
      'analysis-opinion': { benchmark: 'skip', companion_repo: 'optional', social_prefix: '' },
    },
    benchmark: { ...DEFAULT_BENCHMARK, ...(obj.benchmark as Partial<BlogConfig['benchmark']>) },
    publish: { ...DEFAULT_PUBLISH, ...(obj.publish as Partial<BlogConfig['publish']>) },
    social: { ...DEFAULT_SOCIAL, ...(obj.social as Partial<BlogConfig['social']>) },
    evaluation: { ...DEFAULT_EVALUATION, ...(obj.evaluation as Partial<BlogConfig['evaluation']>) },
    updates: { ...DEFAULT_UPDATES, ...(obj.updates as Partial<BlogConfig['updates']>) },
    unpublish: { ...DEFAULT_UNPUBLISH, ...(obj.unpublish as Partial<BlogConfig['unpublish']>) },
    projects,
  };
}
