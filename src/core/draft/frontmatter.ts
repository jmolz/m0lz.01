import yaml from 'js-yaml';

import { PostRow } from '../db/types.js';
import { BlogConfig } from '../config/types.js';

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
  devto_url?: string;
}

export function generateFrontmatter(post: PostRow, config: BlogConfig): PostFrontmatter {
  const fm: PostFrontmatter = {
    title: '{{title}}',
    description: '{{description}}',
    date: new Date().toISOString().slice(0, 10),
    tags: [],
    published: false,
  };

  fm.canonical = `${config.site.base_url}/writing/${post.slug}`;

  if (post.has_benchmarks) {
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
  if (fm.devto_url !== undefined) obj.devto_url = fm.devto_url;

  const dumped = yaml.dump(obj, { lineWidth: -1, quotingType: '"', forceQuotes: false });
  return `---\n${dumped}---`;
}

export function parseFrontmatter(mdxContent: string): PostFrontmatter {
  const parts = mdxContent.split(/^---$/m);
  if (parts.length < 3) {
    throw new Error('MDX content missing frontmatter delimiters');
  }
  const parsed = yaml.load(parts[1]);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Frontmatter is not a valid YAML object');
  }
  const obj = parsed as Record<string, unknown>;

  // js-yaml parses unquoted dates as Date objects — normalize
  const dateRaw = obj.date;
  const dateStr = dateRaw instanceof Date
    ? dateRaw.toISOString().slice(0, 10)
    : String(dateRaw ?? '');

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
    devto_url: obj.devto_url !== undefined ? String(obj.devto_url) : undefined,
  };
}
