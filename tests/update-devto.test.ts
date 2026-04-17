import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { updateDevToArticle } from '../src/core/publish/devto.js';
import { BlogConfig } from '../src/core/config/types.js';

const savedDevtoKey = process.env.DEVTO_API_KEY;

interface Fx { tempDir: string; draftsDir: string }
let fx: Fx | undefined;

afterEach(() => {
  if (fx) rmSync(fx.tempDir, { recursive: true, force: true });
  fx = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (savedDevtoKey === undefined) delete process.env.DEVTO_API_KEY;
  else process.env.DEVTO_API_KEY = savedDevtoKey;
});

const SAMPLE_MDX = `---
title: "Updated Post"
description: "Fresh take"
date: "2026-04-17"
tags:
  - TypeScript
  - Benchmarks
published: false
canonical: "https://m0lz.dev/writing/sample"
---

# Sample

Body paragraph with real content.
`;

function mkFx(slug: string): Fx {
  const tempDir = mkdtempSync(join(tmpdir(), 'update-devto-'));
  const draftsDir = join(tempDir, 'drafts');
  mkdirSync(join(draftsDir, slug), { recursive: true });
  writeFileSync(join(draftsDir, slug, 'index.mdx'), SAMPLE_MDX, 'utf-8');
  fx = { tempDir, draftsDir };
  return fx;
}

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
  };
}

describe('updateDevToArticle — probe then PUT body + frontmatter', () => {
  it('probe-match → PUT 200: returns id+url; body carries title/body_markdown/tags/canonical/description', async () => {
    const f = mkFx('sample');
    process.env.DEVTO_API_KEY = 'k';

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 55, url: 'https://dev.to/u/sample', canonical_url: 'https://m0lz.dev/writing/sample' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 55, url: 'https://dev.to/u/sample',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await updateDevToArticle('sample', mkConfig(), { draftsDir: f.draftsDir });
    expect(result.id).toBe(55);
    expect(result.url).toBe('https://dev.to/u/sample');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // First call = probe.
    const [probeUrl, probeInit] = mockFetch.mock.calls[0];
    expect(String(probeUrl)).toMatch(/\/api\/articles\/me\/all/);
    expect(probeInit.method).toBe('GET');

    // Second call = PUT to /api/articles/{id}. Body contains MDX body + frontmatter fields.
    const [putUrl, putInit] = mockFetch.mock.calls[1];
    expect(putUrl).toBe('https://dev.to/api/articles/55');
    expect(putInit.method).toBe('PUT');
    const body = JSON.parse(putInit.body);
    expect(body.article.title).toBe('Updated Post');
    expect(body.article.description).toBe('Fresh take');
    expect(body.article.canonical_url).toBe('https://m0lz.dev/writing/sample');
    expect(body.article.tags).toEqual(['typescript', 'benchmarks']);
    // body_markdown must include the MDX body paragraph, not just frontmatter.
    expect(body.article.body_markdown).toMatch(/Body paragraph with real content/);
  });

  it('probe-miss → falls through to POST (recover from manual deletion)', async () => {
    const f = mkFx('sample');
    process.env.DEVTO_API_KEY = 'k';

    // probe page 1 is partial-no-match → pagination stops → miss.
    // Then the fallthrough POSTs to /api/articles (201).
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      // crosspostToDevTo probes again (its own probe, same endpoint)…
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 777, url: 'https://dev.to/u/sample-new',
      }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await updateDevToArticle('sample', mkConfig(), { draftsDir: f.draftsDir });

    // The last POST should win: id/url from the 201 response.
    expect(result.id).toBe(777);
    expect(result.url).toBe('https://dev.to/u/sample-new');

    // Last call MUST be POST to /api/articles (the recovery create).
    const calls = mockFetch.mock.calls;
    const last = calls[calls.length - 1];
    expect(last[0]).toBe('https://dev.to/api/articles');
    expect(last[1].method).toBe('POST');
  });

  it('PUT non-200 (500): throws', async () => {
    const f = mkFx('sample');
    process.env.DEVTO_API_KEY = 'k';
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 1, url: 'u', canonical_url: 'https://m0lz.dev/writing/sample' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('upstream', { status: 500 }));
    vi.stubGlobal('fetch', mockFetch);

    await expect(updateDevToArticle('sample', mkConfig(), { draftsDir: f.draftsDir }))
      .rejects.toThrow(/Dev\.to PUT failed \(500\)/);
  });

  it('PUT 422: throws with validation context', async () => {
    const f = mkFx('sample');
    process.env.DEVTO_API_KEY = 'k';
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 1, url: 'u', canonical_url: 'https://m0lz.dev/writing/sample' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('nope', { status: 422 }));
    vi.stubGlobal('fetch', mockFetch);

    await expect(updateDevToArticle('sample', mkConfig(), { draftsDir: f.draftsDir }))
      .rejects.toThrow(/Dev\.to PUT validation failed/);
  });
});
