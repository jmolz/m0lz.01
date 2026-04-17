import { BlogConfig } from '../config/types.js';

// Phase 7: Dev.to unpublish. Probe-then-PUT published:false. Probe-miss
// is a successful skip (likely manual deletion on Dev.to) — not an error.
//
// Isolated from publish/devto.ts because the unpublish-specific payload
// is just `{ published: false }` — no body_markdown, no tags, no fuss.

export interface DevToUnpublishResult {
  url?: string;
  id?: number;
  skipped?: boolean;
  reason?: string;
}

const DEVTO_PROBE_PER_PAGE = 30;
const DEVTO_PROBE_MAX_PAGES = 20;

interface DevToListArticle {
  id?: number;
  url?: string;
  canonical_url?: string;
}

interface DevToPutResponse {
  id?: number;
  url?: string;
  published?: boolean;
}

async function probe(
  apiKey: string,
  canonicalUrl: string,
): Promise<{ id: number; url: string } | null> {
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
      throw new Error(`Dev.to probe failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) {
      throw new Error('Dev.to probe returned a non-array response');
    }
    for (const entry of data as DevToListArticle[]) {
      if (typeof entry.canonical_url !== 'string') continue;
      if (entry.canonical_url.replace(/\/+$/, '') === target) {
        if (typeof entry.id === 'number' && typeof entry.url === 'string') {
          return { id: entry.id, url: entry.url };
        }
      }
    }
    if ((data as unknown[]).length < DEVTO_PROBE_PER_PAGE) return null;
  }
  throw new Error(
    `Dev.to probe exceeded ${DEVTO_PROBE_MAX_PAGES} pages — aborting to avoid blind PUT`,
  );
}

export async function unpublishFromDevTo(
  slug: string,
  config: BlogConfig,
): Promise<DevToUnpublishResult> {
  const apiKey = process.env.DEVTO_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    return { skipped: true, reason: 'DEVTO_API_KEY not set' };
  }
  const canonicalUrl = `${config.site.base_url.replace(/\/+$/, '')}/writing/${slug}`;
  const existing = await probe(apiKey, canonicalUrl);
  if (!existing) {
    return { skipped: true, reason: 'No matching Dev.to article found (already deleted?)' };
  }

  // Per docs/spikes/forem-put-semantics.md: `{ article: { published: false } }`
  // is the minimum unpublish payload. Forem preserves body_markdown on PUT
  // when omitted.
  const response = await fetch(`https://dev.to/api/articles/${existing.id}`, {
    method: 'PUT',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ article: { published: false } }),
  });

  if (response.status === 200) {
    const data = (await response.json()) as DevToPutResponse;
    return {
      id: typeof data.id === 'number' ? data.id : existing.id,
      url: typeof data.url === 'string' ? data.url : existing.url,
    };
  }
  const text = await response.text();
  if (response.status === 422) {
    throw new Error(`Dev.to unpublish validation failed: ${text}`);
  }
  throw new Error(`Dev.to unpublish failed (${response.status}): ${text}`);
}
