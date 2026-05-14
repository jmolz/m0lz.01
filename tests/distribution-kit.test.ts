import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';
import sharp from 'sharp';

import { closeDatabase, getDatabase } from '../src/core/db/database.js';
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
import { openUpdateCycle } from '../src/core/update/cycles.js';
import {
  generateDistributionKit,
  loadDistributionKit,
  resolveSocialMetadata,
  extractLeadSentence,
} from '../src/core/publish/distribution-kit.js';
import {
  ImageProvider,
  ImageGenerationRequest,
  OpenAIImageProvider,
} from '../src/core/publish/openai-image.js';
import { BlogConfig } from '../src/core/config/types.js';

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Fixture {
  tempDir: string;
  siteRepoPath: string;
  socialDir: string;
  draftsDir: string;
  templatesDir: string;
  configPath: string;
  db: Database.Database;
  config: BlogConfig;
}

let fixture: Fixture | undefined;
let originalOpenAIKey: string | undefined;

function makeConfig(siteRepoPath: string): BlogConfig {
  return {
    site: {
      repo_path: siteRepoPath,
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
    social: {
      platforms: ['linkedin', 'hackernews'],
      timing_recommendations: true,
      distribution_kit: { enabled: true, persist_to_site: true, directory: 'distribution' },
      linkedin_image: {
        mode: 'prompt-only',
        model: 'gpt-image-2-2026-04-21',
        size: '1200x1200',
        quality: 'high',
      },
    },
    evaluation: {
      require_pass: true, min_sources: 3, max_reading_level: 12, three_reviewer_panel: true,
      consensus_must_fix: true, majority_should_fix: true, single_advisory: true,
      verify_benchmark_claims: true, methodology_completeness: true,
    },
    updates: {
      preserve_original_data: true,
      update_notice: true,
      update_crosspost: true,
      devto_update: true,
      refresh_paste_files: true,
      notice_template: 'Updated {DATE}: {SUMMARY}',
      require_summary: true,
      site_update_mode: 'pr',
    },
    unpublish: { devto: true, medium: true, substack: true, readme: true },
  };
}

function setup(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'distribution-kit-'));
  const siteRepoPath = join(tempDir, 'm0lz.00');
  const socialDir = join(tempDir, 'social');
  const draftsDir = join(tempDir, 'drafts');
  const templatesDir = join(tempDir, 'templates');
  const configPath = join(tempDir, '.blogrc.yaml');
  [siteRepoPath, socialDir, draftsDir, templatesDir].forEach((dir) => mkdirSync(dir, { recursive: true }));
  mkdirSync(join(templatesDir, 'social'), { recursive: true });
  writeFileSync(join(templatesDir, 'social/linkedin.md'), readFileSync(join(__dirname, '../templates/social/linkedin.md'), 'utf-8'));
  writeFileSync(join(templatesDir, 'social/hackernews.md'), readFileSync(join(__dirname, '../templates/social/hackernews.md'), 'utf-8'));
  writeFileSync(join(templatesDir, 'social/linkedin-image-prompt.md'), readFileSync(join(__dirname, '../templates/social/linkedin-image-prompt.md'), 'utf-8'));
  writeFileSync(configPath, '');
  const db = getDatabase(':memory:');
  const config = makeConfig(siteRepoPath);
  fixture = { tempDir, siteRepoPath, socialDir, draftsDir, templatesDir, configPath, db, config };
  return fixture;
}

function seedPost(
  db: Database.Database,
  slug: string,
  contentType: 'project-launch' | 'technical-deep-dive' | 'analysis-opinion' = 'project-launch',
): void {
  initResearchPost(db, slug, 'DB topic m0lz.01 should not truncate to m0lz. Broken fallback text.', 'directed', contentType, 'm0lz.01');
  advancePhase(db, slug, 'benchmark');
  advancePhase(db, slug, 'draft');
  advancePhase(db, slug, 'evaluate');
  db.prepare(
    'UPDATE posts SET title = ?, repo_url = ?, evaluation_passed = 1 WHERE slug = ?',
  ).run('DB Title', 'https://github.com/jmolz/db-repo', slug);
  advancePhase(db, slug, 'publish');
}

function writeDraft(f: Fixture, slug: string, title = 'Draft Title'): void {
  const dir = join(f.draftsDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.mdx'), `---
title: "${title}"
description: "Draft description for m0lz.01. Extra sentence."
date: "2026-05-14"
tags:
  - TypeScript
  - Distribution
published: false
canonical: "https://draft.example/writing/${slug}"
companion_repo: "https://github.com/jmolz/draft-repo"
project: "draft.01"
---

Body
`, 'utf-8');
}

function writeHub(f: Fixture, slug: string): void {
  const dir = join(f.siteRepoPath, 'content/posts', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.mdx'), `---
title: "Hub Title"
description: "Hub description wins for already published posts."
date: "2026-05-14"
tags:
  - Hub
published: true
canonical: "https://m0lz.dev/writing/${slug}"
companion_repo: "https://github.com/jmolz/hub-repo"
project: "hub.01"
---

Body
`, 'utf-8');
}

class FakeProvider implements ImageProvider {
  calls: ImageGenerationRequest[] = [];
  constructor(private readonly bytes: Buffer) {}

  async generateImage(request: ImageGenerationRequest): Promise<{ bytes: Buffer }> {
    this.calls.push(request);
    return { bytes: this.bytes };
  }
}

beforeEach(() => {
  originalOpenAIKey = process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (originalOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIKey;
  }
  if (fixture?.db) closeDatabase(fixture.db);
  if (fixture) rmSync(fixture.tempDir, { recursive: true, force: true });
  fixture = undefined;
  vi.restoreAllMocks();
});

describe('resolveSocialMetadata', () => {
  it('uses draft frontmatter for publish mode and hub frontmatter for backfill mode', () => {
    const f = setup();
    seedPost(f.db, 'meta');
    writeDraft(f, 'meta', 'Draft Title');
    writeHub(f, 'meta');

    const publish = resolveSocialMetadata('meta', f.config, f, f.db, 'publish');
    expect(publish.title).toBe('Draft Title');
    expect(publish.description).toContain('Draft description');
    expect(publish.companionRepo).toBe('https://github.com/jmolz/draft-repo');

    const backfill = resolveSocialMetadata('meta', f.config, f, f.db, 'backfill');
    expect(backfill.title).toBe('Hub Title');
    expect(backfill.description).toContain('Hub description');
    expect(backfill.canonicalUrl).toBe('https://m0lz.dev/writing/meta');
    expect(backfill.tags).toEqual(['Hub']);
  });

  it('captures open update-cycle metadata without inventing a summary', () => {
    const f = setup();
    seedPost(f.db, 'update-meta');
    advancePhase(f.db, 'update-meta', 'published');
    openUpdateCycle(f.db, 'update-meta', null);
    writeDraft(f, 'update-meta');

    const metadata = resolveSocialMetadata('update-meta', f.config, f, f.db, 'update');
    expect(metadata.updateCycle?.cycleNumber).toBe(1);
    expect(metadata.updateCycle?.summary).toBeNull();
  });
});

describe('generateDistributionKit', () => {
  it('prompt-only mode writes text, prompt, and manifest without calling an image provider', async () => {
    const f = setup();
    seedPost(f.db, 'prompt-only');
    writeDraft(f, 'prompt-only', 'Prompt Only Title');
    const png = await sharp({ create: { width: 1200, height: 1200, channels: 4, background: '#111111' } }).png().toBuffer();
    const provider = new FakeProvider(png);

    const result = await generateDistributionKit('prompt-only', f.config, f, f.db, {
      sourceMode: 'publish',
      provider,
    });

    expect(provider.calls.length).toBe(0);
    expect(existsSync(result.linkedinPath)).toBe(true);
    expect(existsSync(result.hackerNewsPath)).toBe(true);
    expect(existsSync(result.promptPath!)).toBe(true);
    expect(result.imagePath).toBeNull();
    expect(result.manifest.image_mode).toBe('prompt-only');
    expect(result.manifest.image).toBeNull();
    const linkedin = readFileSync(result.linkedinPath, 'utf-8');
    expect(linkedin).toContain('Prompt Only Title');
    expect(linkedin).toContain('https://draft.example/writing/prompt-only');
    expect(linkedin).toContain('Image prompt: ./distribution/linkedin-image-prompt.md');
    expect(linkedin).toContain('Alt text:');
    expect(linkedin).toContain('#TypeScript');
    expect(linkedin).not.toContain('{{');
    expect(linkedin).not.toMatch(/\bn\/a\b/i);
    expect(linkedin).not.toContain('Key takeaway: m0lz.');
  });

  it('generated mode is content-addressed and does not rewrite a valid manifest on the second run', async () => {
    const f = setup();
    seedPost(f.db, 'generated');
    writeDraft(f, 'generated', 'Generated Title');
    const png = await sharp({ create: { width: 1200, height: 1200, channels: 4, background: '#222222' } }).png().toBuffer();
    const provider = new FakeProvider(png);

    const first = await generateDistributionKit('generated', f.config, f, f.db, {
      sourceMode: 'publish',
      imageMode: 'generate',
      provider,
    });
    const manifestBytes = readFileSync(first.manifestPath, 'utf-8');
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].model).toBe('gpt-image-2-2026-04-21');
    expect(provider.calls[0].size).toBe('1200x1200');
    expect(first.manifest.image_model).toBe('gpt-image-2-2026-04-21');
    expect(first.manifest.image_size).toBe('1200x1200');
    expect(first.manifest.image_quality).toBe('high');
    expect(first.manifest.image_format).toBe('png');
    expect(first.manifest.image_mode).toBe('generate');
    expect(first.manifest.input_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifest.prompt?.path).toBe('linkedin-image-prompt.md');
    expect(first.manifest.prompt?.sha256).toBe(sha256(readFileSync(first.promptPath!)));
    expect(first.manifest.text.linkedin.sha256).toBe(sha256(readFileSync(first.linkedinPath)));
    expect(first.manifest.text.hackernews.sha256).toBe(sha256(readFileSync(first.hackerNewsPath)));
    expect(first.manifest.image?.path).toBe('assets/linkedin-feed.png');
    expect(first.manifest.image?.width).toBe(1200);
    expect(first.manifest.image?.height).toBe(1200);
    expect(first.manifest.image?.bytes).toBe(readFileSync(first.imagePath!).length);
    expect(first.manifest.image?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifest.image?.sha256).toBe(sha256(readFileSync(first.imagePath!)));

    const second = await generateDistributionKit('generated', f.config, f, f.db, {
      sourceMode: 'publish',
      imageMode: 'generate',
      provider,
    });
    expect(second.reused).toBe(true);
    expect(provider.calls.length).toBe(1);
    expect(readFileSync(second.manifestPath, 'utf-8')).toBe(manifestBytes);
  });

  it('loadDistributionKit refuses text artifacts that no longer match the manifest', async () => {
    const f = setup();
    seedPost(f.db, 'tampered-text');
    writeDraft(f, 'tampered-text', 'Tampered Text Title');
    const result = await generateDistributionKit('tampered-text', f.config, f, f.db, {
      sourceMode: 'publish',
    });
    writeFileSync(result.linkedinPath, 'tampered linkedin text\n', 'utf-8');

    expect(() => loadDistributionKit('tampered-text', f))
      .toThrow(/LinkedIn text artifact hash mismatch/);
  });

  it('loadDistributionKit refuses generated images that no longer match the manifest', async () => {
    const f = setup();
    seedPost(f.db, 'tampered-image');
    writeDraft(f, 'tampered-image', 'Tampered Image Title');
    const png = await sharp({ create: { width: 1200, height: 1200, channels: 4, background: '#444444' } }).png().toBuffer();
    const provider = new FakeProvider(png);
    const result = await generateDistributionKit('tampered-image', f.config, f, f.db, {
      sourceMode: 'publish',
      imageMode: 'generate',
      provider,
    });
    writeFileSync(result.imagePath!, Buffer.from('tampered image bytes'));

    expect(() => loadDistributionKit('tampered-image', f))
      .toThrow(/image artifact hash mismatch/);
  });

  it('required mode fails before provider construction when OPENAI_API_KEY is missing', async () => {
    const f = setup();
    seedPost(f.db, 'required');
    writeDraft(f, 'required');
    delete process.env.OPENAI_API_KEY;

    await expect(generateDistributionKit('required', f.config, f, f.db, {
      sourceMode: 'publish',
      imageMode: 'required',
    })).rejects.toThrow(/OPENAI_API_KEY/);
    expect(existsSync(join(f.socialDir, 'required'))).toBe(false);
  });
});

describe('text helpers', () => {
  it('does not split product IDs or decimal-like names as sentence boundaries', () => {
    expect(extractLeadSentence('m0lz.01 ships distribution artifacts. Second sentence.', 160))
      .toBe('m0lz.01 ships distribution artifacts.');
  });
});

describe('OpenAIImageProvider', () => {
  it('omits unsupported response_format and reads b64_json image bytes', async () => {
    const bytes = Buffer.from('image bytes');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      created: 123,
      data: [{ b64_json: bytes.toString('base64') }],
    }), { status: 200 }));
    const provider = new OpenAIImageProvider('test-key');

    const result = await provider.generateImage({
      model: 'gpt-image-2-2026-04-21',
      prompt: 'Generate a square launch image.',
      size: '1200x1200',
      quality: 'high',
    });

    expect(result.bytes.equals(bytes)).toBe(true);
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-image-2-2026-04-21',
      prompt: 'Generate a square launch image.',
      size: '1200x1200',
      quality: 'high',
      n: 1,
    });
    expect(body).not.toHaveProperty('response_format');
  });
});
