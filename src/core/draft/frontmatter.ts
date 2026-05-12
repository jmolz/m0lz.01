import { dirname, resolve } from 'node:path';

import yaml from 'js-yaml';

import { PostRow } from '../db/types.js';
import { BlogConfig } from '../config/types.js';
import { parseGitHubRemoteUrl, readOriginUrl } from '../publish/origin-guard.js';

export interface PostFrontmatter {
  title: string;
  description: string;
  date: string;
  tags: string[];
  published: boolean;
  canonical?: string;
  companion_repo?: string;
  project?: string;
  medium_url?: string;
  substack_url?: string;
  devto_url?: string;
  devto_main_image?: string;
  medium_featured_image?: string;
  substack_header_image?: string;
  // Phase 7 additions. All optional — present only after the
  // corresponding lifecycle event:
  // - `unpublished_at` set by `blog unpublish` when the site-revert PR
  //   flips `published: false`.
  // - `updated_at` set by each update-publish cycle's site-update step.
  // - `update_count` incremented on each successful update cycle close.
  // The m0lz.00 frontmatter parser must accept these fields without
  // erroring. The in-repo proof that the parser is tolerant lives in
  // tests/frontmatter-phase7.test.ts — a round-trip test that
  // serializes + parses MDX containing all three fields.
  unpublished_at?: string;
  updated_at?: string;
  update_count?: number;
}

// Best-effort lookup of a companion repo's HTTPS URL via git origin. Used
// by project-launch posts where `config.projects[project_id]` points at
// the local clone of an existing repo. Every failure path (missing dir,
// absent origin, non-github URL, subprocess error) returns null so the
// frontmatter generator can fall back silently — this is an enrichment,
// not a hard contract. The caller chooses whether to skip the field or
// substitute a default when null is returned.
function resolveCompanionRepoFromProject(
  config: BlogConfig,
  projectId: string,
  configPath: string,
): string | null {
  const projectPath = config.projects?.[projectId];
  if (!projectPath) return null;
  const projectDir = resolve(dirname(configPath), projectPath);
  try {
    const rawUrl = readOriginUrl(projectDir);
    if (!rawUrl) return null;
    const parsed = parseGitHubRemoteUrl(rawUrl);
    if (!parsed) return null;
    // Canonical HTTPS form — origin may be SSH (`git@github.com:owner/name.git`)
    // or HTTPS with or without trailing `.git`. The frontmatter contract
    // with m0lz.00 expects a stable HTTPS URL; parseGitHubRemoteUrl
    // already normalized owner+name so we just reassemble.
    return `https://github.com/${parsed.owner}/${parsed.name}`;
  } catch {
    // readOriginUrl re-throws any non-"no such remote" subprocess failure
    // (missing binary, not a git repo, permission error). For frontmatter
    // enrichment those are informational — swallow so a degraded
    // environment doesn't break `blog draft init`.
    return null;
  }
}

export function generateFrontmatter(
  post: PostRow,
  config: BlogConfig,
  configPath: string,
): PostFrontmatter {
  const fm: PostFrontmatter = {
    title: '{{title}}',
    description: '{{description}}',
    date: new Date().toISOString().slice(0, 10),
    tags: [],
    published: false,
  };

  fm.canonical = `${config.site.base_url}/writing/${post.slug}`;

  // project_id + config.projects wins over the has_benchmarks heuristic
  // because it points at an existing published repo URL (project-launch
  // content type). The heuristic only fires for technical-deep-dive
  // posts that will get a NEW companion repo scaffolded at
  // `github.com/<author>/<slug>` during publish step 8.
  if (post.project_id) {
    const resolved = resolveCompanionRepoFromProject(config, post.project_id, configPath);
    if (resolved) {
      fm.companion_repo = resolved;
    }
  }

  if (!fm.companion_repo && post.has_benchmarks) {
    fm.companion_repo = `https://github.com/${config.author.github}/${post.slug}`;
  }

  if (post.project_id) {
    fm.project = post.project_id;
  }

  return fm;
}

export interface FrontmatterValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateFrontmatter(fm: PostFrontmatter): FrontmatterValidationResult {
  const errors: string[] = [];

  if (typeof fm.title !== 'string' || fm.title.length === 0) {
    errors.push('Missing required field: title');
  } else if (fm.title === '{{title}}') {
    errors.push('Title is still a placeholder');
  }

  if (typeof fm.description !== 'string' || fm.description.length === 0) {
    errors.push('Missing required field: description');
  } else if (fm.description === '{{description}}') {
    errors.push('Description is still a placeholder');
  }

  if (typeof fm.date !== 'string' || fm.date.length === 0) {
    errors.push('Missing required field: date');
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(fm.date)) {
    errors.push('Field date must be in YYYY-MM-DD format');
  }

  if (!Array.isArray(fm.tags)) {
    errors.push('Field tags must be an array');
  } else if (fm.tags.length === 0) {
    errors.push('Field tags must not be empty');
  }

  if (typeof fm.published !== 'boolean') {
    errors.push('Field published must be a boolean');
  }

  return { ok: errors.length === 0, errors };
}

export function serializeFrontmatter(fm: PostFrontmatter): string {
  // Build a clean object for serialization, omitting undefined optional fields
  const obj: Record<string, unknown> = {
    title: fm.title,
    description: fm.description,
    date: fm.date,
    tags: fm.tags,
    published: fm.published,
  };

  if (fm.canonical !== undefined) obj.canonical = fm.canonical;
  if (fm.companion_repo !== undefined) obj.companion_repo = fm.companion_repo;
  if (fm.project !== undefined) obj.project = fm.project;
  if (fm.medium_url !== undefined) obj.medium_url = fm.medium_url;
  if (fm.substack_url !== undefined) obj.substack_url = fm.substack_url;
  if (fm.devto_url !== undefined) obj.devto_url = fm.devto_url;
  if (fm.devto_main_image !== undefined) obj.devto_main_image = fm.devto_main_image;
  if (fm.medium_featured_image !== undefined) obj.medium_featured_image = fm.medium_featured_image;
  if (fm.substack_header_image !== undefined) obj.substack_header_image = fm.substack_header_image;
  // Phase 7 additions — only emitted when present. The m0lz.00 site
  // parser must tolerate their absence (legacy posts) and their
  // presence (updated/unpublished posts).
  if (fm.unpublished_at !== undefined) obj.unpublished_at = fm.unpublished_at;
  if (fm.updated_at !== undefined) obj.updated_at = fm.updated_at;
  if (fm.update_count !== undefined) obj.update_count = fm.update_count;

  const dumped = yaml.dump(obj, { lineWidth: -1, quotingType: '"', forceQuotes: false });
  return `---\n${dumped}---`;
}

export function parseFrontmatter(mdxContent: string): PostFrontmatter {
  // Match only the first two `---` delimiters so thematic breaks in the body
  // (which render as `---` on their own line) don't corrupt parsing.
  const match = mdxContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new Error('MDX content missing frontmatter delimiters');
  }
  const parsed = yaml.load(match[1]);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Frontmatter is not a valid YAML object');
  }
  const obj = parsed as Record<string, unknown>;

  // js-yaml parses unquoted dates as Date objects — normalize
  const dateRaw = obj.date;
  const dateStr = dateRaw instanceof Date
    ? dateRaw.toISOString().slice(0, 10)
    : String(dateRaw ?? '');

  // Normalize Phase 7 additions. `update_count` is numeric; everything
  // else is string-coerced with undefined preservation.
  const updateCountRaw = obj.update_count;
  const updateCount = typeof updateCountRaw === 'number'
    ? updateCountRaw
    : typeof updateCountRaw === 'string' && /^\d+$/.test(updateCountRaw)
      ? Number(updateCountRaw)
      : undefined;

  return {
    title: String(obj.title ?? ''),
    description: String(obj.description ?? ''),
    date: dateStr,
    tags: Array.isArray(obj.tags) ? obj.tags.map(String) : [],
    published: typeof obj.published === 'boolean' ? obj.published : false,
    canonical: obj.canonical !== undefined ? String(obj.canonical) : undefined,
    companion_repo: obj.companion_repo !== undefined ? String(obj.companion_repo) : undefined,
    project: obj.project !== undefined ? String(obj.project) : undefined,
    medium_url: obj.medium_url !== undefined ? String(obj.medium_url) : undefined,
    substack_url: obj.substack_url !== undefined ? String(obj.substack_url) : undefined,
    devto_url: obj.devto_url !== undefined ? String(obj.devto_url) : undefined,
    devto_main_image: obj.devto_main_image !== undefined ? String(obj.devto_main_image) : undefined,
    medium_featured_image: obj.medium_featured_image !== undefined ? String(obj.medium_featured_image) : undefined,
    substack_header_image: obj.substack_header_image !== undefined ? String(obj.substack_header_image) : undefined,
    unpublished_at: obj.unpublished_at !== undefined ? String(obj.unpublished_at) : undefined,
    updated_at: obj.updated_at !== undefined ? String(obj.updated_at) : undefined,
    update_count: updateCount,
  };
}
