import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { crosspostToDevTo, mapDevToTags } from '../src/core/publish/devto.js';
import { generateMediumPaste } from '../src/core/publish/medium.js';
import { generateSubstackPaste } from '../src/core/publish/substack.js';
import { BlogConfig } from '../src/core/config/types.js';

function makeConfig(): BlogConfig {
  return {
    site: {
      repo_path: '/tmp/site',
      base_url: 'https://m0lz.dev',
      content_dir: 'content/posts',
      research_dir: 'content/research',
    },
    author: { name: 'Tester', github: 'jmolz' },
    ai: {
      primary: 'claude-code',
      reviewers: { structural: 'claude-code', adversarial: 'codex-cli', methodology: 'codex-cli' },
      codex: { adversarial_effort: 'high', methodology_effort: 'xhigh' },
    },
    content_types: {
      'project-launch': { benchmark: 'optional', companion_repo: 'existing', social_prefix: 'Show HN:' },
      'technical-deep-dive': { benchmark: 'required', companion_repo: 'new', social_prefix: '' },
      'analysis-opinion': { benchmark: 'skip', companion_repo: 'optional', social_prefix: '' },
    },
    benchmark: { capture_environment: true, methodology_template: true, preserve_raw_data: true, multiple_runs: 3 },
    publish: { devto: true, medium: true, substack: true, github_repos: true, social_drafts: true, research_pages: true },
    social: { platforms: ['linkedin', 'hackernews'], timing_recommendations: true },
    evaluation: {
      require_pass: true, min_sources: 3, max_reading_level: 12, three_reviewer_panel: true,
      consensus_must_fix: true, majority_should_fix: true, single_advisory: true,
      verify_benchmark_claims: true, methodology_completeness: true,
    },
    updates: { preserve_original_data: true, update_notice: true, update_crosspost: true },
  };
}

const SAMPLE_MDX = `---
title: "Sample Post"
description: "A one-line description"
date: "2026-04-16"
tags:
  - TypeScript
  - Web Performance
  - benchmark
published: false
canonical: "https://m0lz.dev/writing/sample"
---

# Heading

Body paragraph here.

\`\`\`ts
const x = 1;
\`\`\`

<FancyComponent>gone</FancyComponent>
`;

interface Fixture {
  tempDir: string;
  draftsDir: string;
  socialDir: string;
}

let fixture: Fixture | undefined;
// Save DEVTO_API_KEY once at module load. Each test may mutate it and we
// restore in afterEach so no test leaks into another.
const savedDevtoKey = process.env.DEVTO_API_KEY;

function setup(slug: string): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'publish-xxx-crosspost-'));
  const draftsDir = join(tempDir, 'drafts');
  const socialDir = join(tempDir, 'social');
  mkdirSync(join(draftsDir, slug), { recursive: true });
  writeFileSync(join(draftsDir, slug, 'index.mdx'), SAMPLE_MDX, 'utf-8');
  fixture = { tempDir, draftsDir, socialDir };
  return fixture;
}

afterEach(() => {
  if (fixture) rmSync(fixture.tempDir, { recursive: true, force: true });
  fixture = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Restore env so DEVTO_API_KEY tests don't bleed between each other.
  if (savedDevtoKey === undefined) {
    delete process.env.DEVTO_API_KEY;
  } else {
    process.env.DEVTO_API_KEY = savedDevtoKey;
  }
});

describe('mapDevToTags', () => {
  it('normalizes: lowercases, spaces→hyphens, preserves order, caps at 4', () => {
    const result = mapDevToTags(['TypeScript', 'Web Performance', 'benchmark']);
    expect(result).toEqual(['typescript', 'web-performance', 'benchmark']);
  });

  it('caps result at 4 tags', () => {
    const result = mapDevToTags(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(result).toHaveLength(4);
    expect(result).toEqual(['a', 'b', 'c', 'd']);
  });

  it('strips non [a-z0-9-] and drops tags that become empty', () => {
    const result = mapDevToTags(['!!!', '@@@', 'valid']);
    expect(result).toEqual(['valid']);
  });
});

describe('crosspostToDevTo', () => {
  it('skips with reason when DEVTO_API_KEY is not set', async () => {
    const f = setup('no-key');
    delete process.env.DEVTO_API_KEY;
    const result = await crosspostToDevTo('no-key', makeConfig(), { draftsDir: f.draftsDir });
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/DEVTO_API_KEY not set/);
  });

  it('builds POST with api-key header, correct URL, and article payload', async () => {
    const f = setup('sample');
    process.env.DEVTO_API_KEY = 'test-key-abc';
    // First call: probe GET returns an empty array (no existing draft for
    // this canonical). Second call: POST creates a new draft.
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        new Response('[]', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 123, url: 'https://dev.to/jmolz/sample-abc' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', mockFetch);

    const result = await crosspostToDevTo('sample', makeConfig(), { draftsDir: f.draftsDir });
    expect(result.id).toBe(123);
    expect(result.url).toBe('https://dev.to/jmolz/sample-abc');

    // Two fetch calls: the probe (GET) then the create (POST).
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [probeUrl, probeInit] = mockFetch.mock.calls[0];
    expect(probeUrl).toMatch(/^https:\/\/dev\.to\/api\/articles\/me\/all/);
    expect(probeInit.method).toBe('GET');
    expect(probeInit.headers['api-key']).toBe('test-key-abc');

    const [url, init] = mockFetch.mock.calls[1];
    expect(url).toBe('https://dev.to/api/articles');
    expect(init.method).toBe('POST');
    expect(init.headers['api-key']).toBe('test-key-abc');
    const payload = JSON.parse(init.body);
    expect(payload.article.title).toBe('Sample Post');
    expect(payload.article.published).toBe(false);
    expect(payload.article.canonical_url).toBe('https://m0lz.dev/writing/sample');
    expect(payload.article.tags).toEqual(['typescript', 'web-performance', 'benchmark']);
    expect(payload.article.description).toBe('A one-line description');
    // Body should contain the heading and code fence, JSX stripped.
    expect(payload.article.body_markdown).toContain('# Heading');
    expect(payload.article.body_markdown).toContain('const x = 1;');
    expect(payload.article.body_markdown).not.toContain('<FancyComponent');
  });

  it('probe-then-create: returns existing URL without POSTing when canonical already on Dev.to', async () => {
    // Regression for Codex Pass 2 Critical: a prior run may have succeeded
    // at POST /api/articles but died before the local DB transaction.
    // On resume the runner re-executes crosspost-devto; without the probe,
    // this would create a duplicate Dev.to draft. The probe must find the
    // existing article and return its URL instead.
    const f = setup('duplicate');
    process.env.DEVTO_API_KEY = 'retry-key';
    const existingArticles = [
      { id: 999, url: 'https://dev.to/jmolz/unrelated', canonical_url: 'https://m0lz.dev/writing/other' },
      { id: 777, url: 'https://dev.to/jmolz/duplicate-abc', canonical_url: 'https://m0lz.dev/writing/duplicate' },
    ];
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(existingArticles), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await crosspostToDevTo('duplicate', makeConfig(), { draftsDir: f.draftsDir });
    expect(result.id).toBe(777);
    expect(result.url).toBe('https://dev.to/jmolz/duplicate-abc');

    // Critical assertion: only the probe was called. No POST.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [probeUrl, probeInit] = mockFetch.mock.calls[0];
    expect(probeUrl).toMatch(/articles\/me\/all/);
    expect(probeInit.method).toBe('GET');
  });

  it('probe paginates beyond 1000 articles and matches on a later page', async () => {
    // Regression for Codex Pass 3 Medium. The original probe stopped at
    // page 1 (per_page=1000), so an author with >1000 articles whose
    // matching draft lived on page 2+ would invisibly miss and duplicate.
    // The fix: walk pages until a short page OR a match is found.
    const f = setup('paginated');
    process.env.DEVTO_API_KEY = 'many-articles';

    // Page 1: 1000 entries, none matching.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      id: i + 1,
      url: `https://dev.to/jmolz/other-${i + 1}`,
      canonical_url: `https://m0lz.dev/writing/other-${i + 1}`,
    }));
    // Page 2: a few entries, the last of which matches.
    const page2 = [
      { id: 1001, url: 'https://dev.to/jmolz/filler', canonical_url: 'https://m0lz.dev/writing/filler' },
      { id: 1002, url: 'https://dev.to/jmolz/paginated-match', canonical_url: 'https://m0lz.dev/writing/paginated' },
    ];
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page2), { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await crosspostToDevTo('paginated', makeConfig(), { draftsDir: f.draftsDir });
    expect(result.id).toBe(1002);
    expect(result.url).toBe('https://dev.to/jmolz/paginated-match');

    // Two probe GETs (page 1 + page 2), no POST.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [url1] = mockFetch.mock.calls[0];
    const [url2] = mockFetch.mock.calls[1];
    expect(url1).toMatch(/[?&]page=1\b/);
    expect(url2).toMatch(/[?&]page=2\b/);
    const methods = mockFetch.mock.calls.map((c) => c[1]?.method);
    expect(methods).toEqual(['GET', 'GET']);
  });

  it('probe stops on short page: page 1 has <1000 entries => no page 2 fetch', async () => {
    const f = setup('short');
    process.env.DEVTO_API_KEY = 'k';
    // Page 1: 3 entries, none matching. The pager must recognize the short
    // page as the last page and stop — NOT fetch page 2.
    const page1 = [
      { id: 1, url: 'u1', canonical_url: 'https://m0lz.dev/writing/a' },
      { id: 2, url: 'u2', canonical_url: 'https://m0lz.dev/writing/b' },
      { id: 3, url: 'u3', canonical_url: 'https://m0lz.dev/writing/c' },
    ];
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
      // Fallback for the POST that should follow — probe returns null so
      // we POST.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 999, url: 'https://dev.to/jmolz/short-xyz' }), { status: 201 }),
      );
    vi.stubGlobal('fetch', mockFetch);

    const result = await crosspostToDevTo('short', makeConfig(), { draftsDir: f.draftsDir });
    expect(result.id).toBe(999);
    // Exactly 2 calls: probe page 1, then POST. Page 2 should NOT be fetched.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const methods = mockFetch.mock.calls.map((c) => c[1]?.method);
    expect(methods).toEqual(['GET', 'POST']);
  });

  it('probe matches canonicals regardless of trailing slash', async () => {
    const f = setup('slashed');
    process.env.DEVTO_API_KEY = 'k';
    // Existing article canonical has a trailing slash; the canonical we
    // compute does not. The probe must still match them as the same URL.
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { id: 55, url: 'https://dev.to/jmolz/slashed', canonical_url: 'https://m0lz.dev/writing/slashed/' },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', mockFetch);
    const result = await crosspostToDevTo('slashed', makeConfig(), { draftsDir: f.draftsDir });
    expect(result.id).toBe(55);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws with probe context when the probe endpoint returns non-200', async () => {
    const f = setup('probefail');
    process.env.DEVTO_API_KEY = 'k';
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(crosspostToDevTo('probefail', makeConfig(), { draftsDir: f.draftsDir }))
      .rejects.toThrow(/Dev\.to probe failed \(401\)/);
    // Must not fall through to POST when the probe fails — otherwise a
    // transient probe failure would race a duplicate-create with a
    // subsequent retry that succeeds on the probe.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws a descriptive error on 422 validation failure', async () => {
    const f = setup('validation');
    process.env.DEVTO_API_KEY = 'k';
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))  // probe: nothing
      .mockResolvedValueOnce(
        new Response('{"error":"validation failed"}', { status: 422 }),
      );
    vi.stubGlobal('fetch', mockFetch);

    await expect(crosspostToDevTo('validation', makeConfig(), { draftsDir: f.draftsDir }))
      .rejects.toThrow(/Dev\.to validation failed/);
  });

  it('throws on other non-2xx errors with status in message', async () => {
    const f = setup('bigfail');
    process.env.DEVTO_API_KEY = 'k';
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))  // probe: nothing
      .mockResolvedValueOnce(
        new Response('Service unavailable', { status: 503 }),
      );
    vi.stubGlobal('fetch', mockFetch);

    await expect(crosspostToDevTo('bigfail', makeConfig(), { draftsDir: f.draftsDir }))
      .rejects.toThrow(/Dev\.to request failed \(503\)/);
  });

  it('skips when DEVTO_API_KEY is empty string (not just undefined)', async () => {
    const f = setup('empty-key');
    process.env.DEVTO_API_KEY = '';
    const result = await crosspostToDevTo('empty-key', makeConfig(), { draftsDir: f.draftsDir });
    expect(result.skipped).toBe(true);
  });
});

describe('generateMediumPaste', () => {
  it('writes a Medium paste file with H1 title, description, body, and canonical footer', () => {
    const f = setup('mpost');
    const result = generateMediumPaste('mpost', makeConfig(), {
      draftsDir: f.draftsDir,
      socialDir: f.socialDir,
    });

    const expectedPath = join(f.socialDir, 'mpost', 'medium-paste.md');
    expect(result.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    const content = readFileSync(expectedPath, 'utf-8');
    expect(content.startsWith('# Sample Post')).toBe(true);
    expect(content).toContain('A one-line description');
    expect(content).toContain('# Heading');
    // Display URL strips the protocol — "m0lz.dev" appears without "https://".
    expect(content).toContain('[m0lz.dev](https://m0lz.dev/writing/mpost)');
  });

  it('creates nested socialDir/slug directory recursively', () => {
    const f = setup('deepdir');
    // Do NOT pre-create the socialDir — rely on the function to mkdir.
    generateMediumPaste('deepdir', makeConfig(), {
      draftsDir: f.draftsDir,
      socialDir: f.socialDir,
    });
    expect(existsSync(join(f.socialDir, 'deepdir'))).toBe(true);
  });

  it('displayBaseUrl correctly strips protocol from config.site.base_url', () => {
    const f = setup('proto');
    const config = makeConfig();
    config.site.base_url = 'https://example.com/';
    generateMediumPaste('proto', config, { draftsDir: f.draftsDir, socialDir: f.socialDir });
    const content = readFileSync(join(f.socialDir, 'proto', 'medium-paste.md'), 'utf-8');
    // Label text must drop protocol + trailing slash.
    expect(content).toContain('[example.com](https://example.com/writing/proto)');
  });
});

describe('generateSubstackPaste', () => {
  it('writes Substack paste with H1 title and H2 description subtitle', () => {
    const f = setup('sspost');
    const result = generateSubstackPaste('sspost', makeConfig(), {
      draftsDir: f.draftsDir,
      socialDir: f.socialDir,
    });
    const expectedPath = join(f.socialDir, 'sspost', 'substack-paste.md');
    expect(result.path).toBe(expectedPath);
    const content = readFileSync(expectedPath, 'utf-8');
    // Substack layout: H1 then H2 (distinct from Medium's H1 + paragraph).
    expect(content).toMatch(/^# Sample Post\n\n## A one-line description/);
  });

  it('applies mdxToMarkdown — JSX stripped outside fences, code blocks preserved', () => {
    const f = setup('mdxclean');
    generateSubstackPaste('mdxclean', makeConfig(), {
      draftsDir: f.draftsDir,
      socialDir: f.socialDir,
    });
    const content = readFileSync(join(f.socialDir, 'mdxclean', 'substack-paste.md'), 'utf-8');
    // JSX component removed from prose region.
    expect(content).not.toContain('<FancyComponent');
    // Code fence preserved.
    expect(content).toContain('const x = 1;');
    expect(content).toContain('```ts');
  });
});
