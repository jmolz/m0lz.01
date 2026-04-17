import { describe, it, expect, afterEach, vi } from 'vitest';

import { unpublishFromDevTo } from '../src/core/unpublish/devto.js';
import { BlogConfig } from '../src/core/config/types.js';

// Save DEVTO_API_KEY once and restore between tests so env doesn't leak.
const savedDevtoKey = process.env.DEVTO_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (savedDevtoKey === undefined) delete process.env.DEVTO_API_KEY;
  else process.env.DEVTO_API_KEY = savedDevtoKey;
});

function mkConfig(): BlogConfig {
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
    social: { platforms: [], timing_recommendations: true },
    evaluation: {
      require_pass: true, min_sources: 3, max_reading_level: 12, three_reviewer_panel: true,
      consensus_must_fix: true, majority_should_fix: true, single_advisory: true,
      verify_benchmark_claims: true, methodology_completeness: true,
    },
    updates: {
      preserve_original_data: true, update_notice: true, update_crosspost: true,
      devto_update: true, refresh_paste_files: true, notice_template: 'Updated {DATE}: {SUMMARY}',
      require_summary: true, site_update_mode: 'pr',
    },
    unpublish: { devto: true, medium: true, substack: true, readme: true },
  };
}

describe('unpublishFromDevTo', () => {
  it('skips with reason when DEVTO_API_KEY is not set', async () => {
    delete process.env.DEVTO_API_KEY;
    const result = await unpublishFromDevTo('sample', mkConfig());
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/DEVTO_API_KEY not set/);
  });

  it('probe-match + PUT 200: returns id+url; PUT body is exactly { article: { published: false } }', async () => {
    process.env.DEVTO_API_KEY = 'abc';
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify([
          { id: 99, url: 'https://dev.to/u/other', canonical_url: 'https://m0lz.dev/writing/other' },
          { id: 42, url: 'https://dev.to/u/sample', canonical_url: 'https://m0lz.dev/writing/sample' },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ id: 42, url: 'https://dev.to/u/sample', published: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    vi.stubGlobal('fetch', mockFetch);

    const result = await unpublishFromDevTo('sample', mkConfig());

    expect(result.id).toBe(42);
    expect(result.url).toBe('https://dev.to/u/sample');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Probe: GET with api-key header.
    const [probeUrl, probeInit] = mockFetch.mock.calls[0];
    expect(String(probeUrl)).toMatch(/^https:\/\/dev\.to\/api\/articles\/me\/all/);
    expect(probeInit.method).toBe('GET');
    expect(probeInit.headers['api-key']).toBe('abc');

    // PUT: body exactly `{ article: { published: false } }` per spike.
    const [putUrl, putInit] = mockFetch.mock.calls[1];
    expect(putUrl).toBe('https://dev.to/api/articles/42');
    expect(putInit.method).toBe('PUT');
    expect(putInit.headers['api-key']).toBe('abc');
    const body = JSON.parse(putInit.body);
    expect(body).toEqual({ article: { published: false } });
  });

  it('probe-miss (no matching canonical): skips with reason, no PUT issued', async () => {
    process.env.DEVTO_API_KEY = 'abc';
    // Return fewer than per_page entries so pagination stops on page 1.
    const mockFetch = vi.fn().mockResolvedValueOnce(new Response(
      JSON.stringify([
        { id: 7, url: 'https://dev.to/u/x', canonical_url: 'https://m0lz.dev/writing/other' },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', mockFetch);

    const result = await unpublishFromDevTo('ghost', mkConfig());
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/already deleted/i);
    // Only the probe should have fired. No PUT.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('probe HTTP 500: throws', async () => {
    process.env.DEVTO_API_KEY = 'abc';
    const mockFetch = vi.fn().mockResolvedValueOnce(new Response(
      'upstream boom', { status: 500 },
    ));
    vi.stubGlobal('fetch', mockFetch);

    await expect(unpublishFromDevTo('any', mkConfig())).rejects.toThrow(/Dev\.to probe failed \(500\)/);
  });

  it('PUT non-200 (500): throws with status + body', async () => {
    process.env.DEVTO_API_KEY = 'abc';
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify([
          { id: 1, url: 'https://dev.to/u/x', canonical_url: 'https://m0lz.dev/writing/x' },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response('down', { status: 500 }));
    vi.stubGlobal('fetch', mockFetch);

    await expect(unpublishFromDevTo('x', mkConfig())).rejects.toThrow(/Dev\.to unpublish failed \(500\)/);
  });

  it('PUT 422: throws with validation context', async () => {
    process.env.DEVTO_API_KEY = 'abc';
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify([
          { id: 1, url: 'https://dev.to/u/x', canonical_url: 'https://m0lz.dev/writing/x' },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response('invalid', { status: 422 }));
    vi.stubGlobal('fetch', mockFetch);

    await expect(unpublishFromDevTo('x', mkConfig())).rejects.toThrow(/Dev\.to unpublish validation failed/);
  });

  it('probe pagination: stops when a page returns fewer than per_page entries', async () => {
    process.env.DEVTO_API_KEY = 'abc';
    const fullPage = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      url: `https://dev.to/u/p${i}`,
      canonical_url: `https://m0lz.dev/writing/p${i}`,
    }));
    const mockFetch = vi.fn()
      // page 1 is full (30 entries), no match
      .mockResolvedValueOnce(new Response(JSON.stringify(fullPage), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      // page 2 is partial (1 entry), no match → pagination stops
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 99, url: 'x', canonical_url: 'y' }]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await unpublishFromDevTo('not-there', mkConfig());
    expect(result.skipped).toBe(true);
    // Exactly 2 probe calls. No PUT.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
