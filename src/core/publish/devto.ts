import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BlogConfig } from '../config/types.js';
import { parseFrontmatter } from '../draft/frontmatter.js';
import { mdxToMarkdown } from './convert.js';

// Step 5 of the publish pipeline: cross-post to Dev.to via the Forem API.
// Drafts are posted with `published: false` so the author can review the
// rendered post on Dev.to before flipping the public switch — the pipeline
// never auto-publishes on behalf of the user. Canonical URL is always the
// hub (m0lz.dev) so search engines credit the hub, not the cross-post.
//
// Credentials come from `process.env.DEVTO_API_KEY`, which
// `src/cli/index.ts` loads via `import 'dotenv/config'` at bootstrap. A
// missing key is a soft skip (return), not an error — matches the rest of
// the pipeline's tolerance for missing cross-post config.

export interface DevToPaths {
  draftsDir: string;
}

export interface DevToResult {
  url?: string;
  id?: number;
  skipped?: boolean;
  reason?: string;
}

// Dev.to tag rules (documented on dev.to/tags):
//   - lowercase
//   - alphanumeric + hyphens
//   - max 4 tags per article
// Normalization: lowercase, spaces→hyphens, strip other chars, drop empties,
// take first 4. Does not dedupe because the tag list is small and the author
// controls the draft tags — if they included a duplicate, preserve intent.
export function mapDevToTags(tags: string[]): string[] {
  const result: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const normalized = raw
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
    if (normalized.length === 0) continue;
    result.push(normalized);
    if (result.length >= 4) break;
  }
  return result;
}

// Split MDX into frontmatter + body regions. Returns the entire content as
// body when no frontmatter is present, matching the pattern used across the
// publish modules.
function splitMdx(mdx: string): { frontmatter: string; body: string } {
  const match = mdx.match(/^---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
  if (!match) {
    return { frontmatter: '', body: mdx };
  }
  return {
    frontmatter: match[0],
    body: mdx.slice(match[0].length),
  };
}

interface DevToArticleResponse {
  id?: number;
  url?: string;
}

export async function crosspostToDevTo(
  slug: string,
  config: BlogConfig,
  paths: DevToPaths,
): Promise<DevToResult> {
  const apiKey = process.env.DEVTO_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    return { skipped: true, reason: 'DEVTO_API_KEY not set' };
  }

  const draftPath = join(paths.draftsDir, slug, 'index.mdx');
  const mdx = readFileSync(draftPath, 'utf-8');
  const fm = parseFrontmatter(mdx);
  const { body } = splitMdx(mdx);

  const bodyMarkdown = mdxToMarkdown(body, slug, config.site.base_url);
  const canonicalUrl = `${config.site.base_url.replace(/\/+$/, '')}/writing/${slug}`;
  const tags = mapDevToTags(fm.tags);

  const payload = {
    article: {
      title: fm.title,
      body_markdown: bodyMarkdown,
      published: false,
      canonical_url: canonicalUrl,
      tags,
      description: fm.description,
    },
  };

  const response = await fetch('https://dev.to/api/articles', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 201) {
    const data = (await response.json()) as DevToArticleResponse;
    return {
      id: typeof data.id === 'number' ? data.id : undefined,
      url: typeof data.url === 'string' ? data.url : undefined,
    };
  }

  const text = await response.text();
  if (response.status === 422) {
    throw new Error(`Dev.to validation failed: ${text}`);
  }
  throw new Error(`Dev.to request failed (${response.status}): ${text}`);
}
