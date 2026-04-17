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

// Each article in the /me/all listing exposes its canonical_url and the
// Dev.to-side URL. Shape is intentionally narrow — we only read fields we
// use, and tolerate missing fields via optional typing since Dev.to's API
// response shape is not strictly versioned.
interface DevToListArticle {
  id?: number;
  url?: string;
  canonical_url?: string | null;
}

// Probe the authenticated user's articles for one whose canonical_url
// matches the post we're about to cross-post. Returns the existing article's
// Dev.to URL + id when found, null otherwise. This closes the resume hole:
// a prior run may have succeeded at POST /api/articles but died before the
// local transaction that marks the step completed and persists the URL
// to the posts row. Without a probe, resume would POST again and create a
// duplicate draft on Dev.to.
//
// Any error from the probe (network, auth, JSON parse) is treated as fatal:
// throw so the step is marked failed and the operator retries. Falling
// through to POST would reopen the duplicate-create window on transient
// probe failures.
// Paginate /api/articles/me/all until we find a matching canonical or hit a
// short page (< per_page entries → last page). Dev.to's documented max is
// per_page=1000; we cap the loop at 100 pages to avoid an infinite scan if
// the API ever misreports the short-page signal.
const DEVTO_PROBE_PER_PAGE = 1000;
const DEVTO_PROBE_MAX_PAGES = 100;

async function probeDevToForCanonical(
  apiKey: string,
  canonicalUrl: string,
): Promise<{ id?: number; url?: string } | null> {
  // Normalize trailing slashes so an author that stores canonical with a
  // slash in Dev.to still matches one without here (and vice versa).
  const target = canonicalUrl.replace(/\/+$/, '');

  for (let page = 1; page <= DEVTO_PROBE_MAX_PAGES; page += 1) {
    const url = `https://dev.to/api/articles/me/all?per_page=${DEVTO_PROBE_PER_PAGE}&page=${page}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'api-key': apiKey,
        Accept: 'application/json',
      },
    });

    if (response.status !== 200) {
      const text = await response.text();
      throw new Error(
        `Dev.to probe failed (${response.status}): ${text}`,
      );
    }

    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) {
      throw new Error('Dev.to probe returned a non-array response');
    }

    for (const entry of data as DevToListArticle[]) {
      if (typeof entry.canonical_url !== 'string') continue;
      if (entry.canonical_url.replace(/\/+$/, '') === target) {
        return {
          id: typeof entry.id === 'number' ? entry.id : undefined,
          url: typeof entry.url === 'string' ? entry.url : undefined,
        };
      }
    }

    // Short page means no more results — stop paginating.
    if ((data as unknown[]).length < DEVTO_PROBE_PER_PAGE) {
      return null;
    }
  }

  // Hit the safety cap without finding a match. This is effectively a
  // "probe could not confirm absence" result. Throw so the step is
  // marked failed and the operator notices, rather than falling through
  // to POST and potentially creating a duplicate for a >100,000-article
  // author (the real-world likelihood of this is near zero).
  throw new Error(
    `Dev.to probe exceeded ${DEVTO_PROBE_MAX_PAGES} pages — aborting to avoid duplicate-create`,
  );
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

  const canonicalUrl = `${config.site.base_url.replace(/\/+$/, '')}/writing/${slug}`;

  // Probe-then-create. If a prior run already created the Dev.to draft but
  // crashed before the local commit, we find it here and return the existing
  // URL instead of POSTing a duplicate. Mirrors the probe-then-create
  // pattern in repo.ts.
  const existing = await probeDevToForCanonical(apiKey, canonicalUrl);
  if (existing) {
    return { id: existing.id, url: existing.url };
  }

  const draftPath = join(paths.draftsDir, slug, 'index.mdx');
  const mdx = readFileSync(draftPath, 'utf-8');
  const fm = parseFrontmatter(mdx);
  const { body } = splitMdx(mdx);

  const bodyMarkdown = mdxToMarkdown(body, slug, config.site.base_url);
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

// Phase 7: probe-then-PUT. Update-mode Dev.to refresh. The probe resolves
// the article id via canonical URL; a successful probe triggers a PUT that
// replaces body_markdown + tags + description. A probe miss falls through
// to the regular create path (recovers from manual deletion on Dev.to).
//
// Per Cluster E6 spike (docs/spikes/forem-put-semantics.md), Forem's PUT
// accepts the same article-shape payload POST uses — body_markdown is NOT
// required on every PUT but IS required to actually update the rendered
// body, so we always include it.
export async function updateDevToArticle(
  slug: string,
  config: BlogConfig,
  paths: DevToPaths,
): Promise<DevToResult> {
  const apiKey = process.env.DEVTO_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    return { skipped: true, reason: 'DEVTO_API_KEY not set' };
  }

  const canonicalUrl = `${config.site.base_url.replace(/\/+$/, '')}/writing/${slug}`;
  const existing = await probeDevToForCanonical(apiKey, canonicalUrl);
  if (!existing || typeof existing.id !== 'number') {
    // Probe miss — likely manual deletion on Dev.to. Recover by falling
    // through to POST via the standard crosspost path.
    return crosspostToDevTo(slug, config, paths);
  }

  const draftPath = join(paths.draftsDir, slug, 'index.mdx');
  const mdx = readFileSync(draftPath, 'utf-8');
  const fm = parseFrontmatter(mdx);
  const { body } = splitMdx(mdx);

  const bodyMarkdown = mdxToMarkdown(body, slug, config.site.base_url);
  const tags = mapDevToTags(fm.tags);

  const payload = {
    article: {
      title: fm.title,
      body_markdown: bodyMarkdown,
      canonical_url: canonicalUrl,
      tags,
      description: fm.description,
    },
  };

  const response = await fetch(`https://dev.to/api/articles/${existing.id}`, {
    method: 'PUT',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 200) {
    const data = (await response.json()) as DevToArticleResponse;
    return {
      id: typeof data.id === 'number' ? data.id : existing.id,
      url: typeof data.url === 'string' ? data.url : existing.url,
    };
  }

  const text = await response.text();
  if (response.status === 422) {
    throw new Error(`Dev.to PUT validation failed: ${text}`);
  }
  throw new Error(`Dev.to PUT failed (${response.status}): ${text}`);
}
