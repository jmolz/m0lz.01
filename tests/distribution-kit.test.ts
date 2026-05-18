import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    expect(existsSync(result.mediumPath!)).toBe(true);
    expect(existsSync(result.substackPath!)).toBe(true);
    expect(result.manifest.image_mode).toBe('prompt-only');
    expect(result.manifest.image).toBeNull();
    expect(result.manifest.text.medium?.sha256).toBe(sha256(readFileSync(result.mediumPath!)));
    expect(result.manifest.text.substack?.sha256).toBe(sha256(readFileSync(result.substackPath!)));
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
    expect(first.manifest.text.medium?.sha256).toBe(sha256(readFileSync(first.mediumPath!)));
    expect(first.manifest.text.substack?.sha256).toBe(sha256(readFileSync(first.substackPath!)));
    expect(first.manifest.image?.path).toBe('assets/linkedin-feed.png');
    expect(first.manifest.image?.width).toBe(1200);
    expect(first.manifest.image?.height).toBe(1200);
    expect(first.manifest.image?.bytes).toBe(readFileSync(first.imagePath!).length);
    expect(first.manifest.image?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifest.image?.sha256).toBe(sha256(readFileSync(first.imagePath!)));
    expect(first.imagePath).toBe(join(f.socialDir, 'generated', 'assets', 'linkedin-feed.png'));
    expect(existsSync(join(f.draftsDir, 'generated', 'assets', 'linkedin-feed.png'))).toBe(false);

    const second = await generateDistributionKit('generated', f.config, f, f.db, {
      sourceMode: 'publish',
      imageMode: 'generate',
      provider,
    });
    expect(second.reused).toBe(true);
    expect(provider.calls.length).toBe(1);
    expect(readFileSync(second.manifestPath, 'utf-8')).toBe(manifestBytes);
  });

  it('writes portable table assets into the distribution kit, not evaluated draft assets', async () => {
    const f = setup();
    seedPost(f.db, 'table-location');
    writeDraft(f, 'table-location', 'Table Location Title');
    const draftPath = join(f.draftsDir, 'table-location', 'index.mdx');
    writeFileSync(draftPath, readFileSync(draftPath, 'utf-8').replace('Body', [
      '| Runtime | Median |',
      '| --- | ---: |',
      '| Node | 12ms |',
    ].join('\n')), 'utf-8');

    const result = await generateDistributionKit('table-location', f.config, f, f.db, {
      sourceMode: 'publish',
      imageMode: 'prompt-only',
    });

    expect(result.tableImagePaths).toHaveLength(1);
    expect(result.tableImagePaths[0].startsWith(join(f.socialDir, 'table-location', 'assets'))).toBe(true);
    expect(existsSync(join(f.draftsDir, 'table-location', 'assets'))).toBe(false);
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

  it('loadDistributionKit refuses Medium paste and table assets that no longer match the manifest', async () => {
    const f = setup();
    seedPost(f.db, 'tampered-bundle');
    writeDraft(f, 'tampered-bundle', 'Tampered Bundle Title');
    const draftPath = join(f.draftsDir, 'tampered-bundle', 'index.mdx');
    writeFileSync(draftPath, readFileSync(draftPath, 'utf-8').replace('Body', [
      '| Runtime | Median |',
      '| --- | ---: |',
      '| Node | 12ms |',
    ].join('\n')), 'utf-8');
    const result = await generateDistributionKit('tampered-bundle', f.config, f, f.db, {
      sourceMode: 'publish',
    });
    expect(result.manifest.tables).toHaveLength(1);

    writeFileSync(result.mediumPath!, 'tampered medium paste\n', 'utf-8');
    expect(() => loadDistributionKit('tampered-bundle', f))
      .toThrow(/Medium paste artifact hash mismatch/);

    await generateDistributionKit('tampered-bundle', f.config, f, f.db, {
      sourceMode: 'publish',
      force: true,
    });
    writeFileSync(result.tableImagePaths[0], Buffer.from('tampered table'));
    expect(() => loadDistributionKit('tampered-bundle', f))
      .toThrow(/table 1 artifact hash mismatch/);
  });

  it('loadDistributionKit refuses Hacker News and Substack artifacts that no longer match the manifest', async () => {
    const f = setup();
    seedPost(f.db, 'tampered-platforms');
    writeDraft(f, 'tampered-platforms', 'Tampered Platforms Title');
    const result = await generateDistributionKit('tampered-platforms', f.config, f, f.db, {
      sourceMode: 'publish',
    });

    writeFileSync(result.hackerNewsPath!, 'tampered hacker news text\n', 'utf-8');
    expect(() => loadDistributionKit('tampered-platforms', f))
      .toThrow(/Hacker News text artifact hash mismatch/);

    await generateDistributionKit('tampered-platforms', f.config, f, f.db, {
      sourceMode: 'publish',
      force: true,
    });
    writeFileSync(result.substackPath!, 'tampered substack paste\n', 'utf-8');
    expect(() => loadDistributionKit('tampered-platforms', f))
      .toThrow(/Substack paste artifact hash mismatch/);
  });

  it('backfill renders paste files from hub-site MDX before stale local draft MDX', async () => {
    const f = setup();
    seedPost(f.db, 'hub-source');
    advancePhase(f.db, 'hub-source', 'published');
    writeDraft(f, 'hub-source', 'Stale Draft Title');
    writeHub(f, 'hub-source');

    const result = await generateDistributionKit('hub-source', f.config, f, f.db, {
      sourceMode: 'backfill',
    });
    const medium = readFileSync(result.mediumPath!, 'utf-8');
    expect(medium).toContain('# Hub Title');
    expect(medium).not.toContain('Stale Draft Title');
  });

  it('respects disabled Medium/Substack while still allowing social artifacts', async () => {
    const f = setup();
    seedPost(f.db, 'disabled-paste');
    writeDraft(f, 'disabled-paste');
    f.config.publish.medium = false;
    f.config.publish.substack = false;

    const result = await generateDistributionKit('disabled-paste', f.config, f, f.db, {
      sourceMode: 'publish',
    });
    expect(result.mediumPath).toBeNull();
    expect(result.substackPath).toBeNull();
    expect(result.manifest.text.medium).toBeNull();
    expect(result.manifest.text.substack).toBeNull();
    expect(existsSync(result.linkedinPath!)).toBe(true);
  });

  it('respects individual Medium and Substack config toggles', async () => {
    const f = setup();
    seedPost(f.db, 'medium-disabled');
    writeDraft(f, 'medium-disabled');
    f.config.publish.medium = false;

    const mediumDisabled = await generateDistributionKit('medium-disabled', f.config, f, f.db, {
      sourceMode: 'publish',
    });
    expect(mediumDisabled.mediumPath).toBeNull();
    expect(mediumDisabled.substackPath).not.toBeNull();
    expect(mediumDisabled.manifest.text.medium).toBeNull();
    expect(mediumDisabled.manifest.text.substack?.path).toBe('substack-paste.md');

    f.config.publish.medium = true;
    f.config.publish.substack = false;
    seedPost(f.db, 'substack-disabled');
    writeDraft(f, 'substack-disabled');

    const substackDisabled = await generateDistributionKit('substack-disabled', f.config, f, f.db, {
      sourceMode: 'publish',
    });
    expect(substackDisabled.mediumPath).not.toBeNull();
    expect(substackDisabled.substackPath).toBeNull();
    expect(substackDisabled.manifest.text.medium?.path).toBe('medium-paste.md');
    expect(substackDisabled.manifest.text.substack).toBeNull();
  });

  it('keeps enabled Medium/Substack artifacts when social distribution is disabled', async () => {
    const f = setup();
    seedPost(f.db, 'social-disabled');
    writeDraft(f, 'social-disabled');
    f.config.social.distribution_kit.enabled = false;

    const result = await generateDistributionKit('social-disabled', f.config, f, f.db, {
      sourceMode: 'publish',
    });
    expect(result.linkedinPath).toBeNull();
    expect(result.hackerNewsPath).toBeNull();
    expect(result.manifest.text.linkedin).toBeNull();
    expect(result.manifest.text.hackernews).toBeNull();
    expect(existsSync(result.mediumPath!)).toBe(true);
    expect(existsSync(result.substackPath!)).toBe(true);
  });

  it('rejects non-allowlisted manifest paths before returning local artifact paths', async () => {
    const f = setup();
    seedPost(f.db, 'unsafe-paths');
    writeDraft(f, 'unsafe-paths');
    const result = await generateDistributionKit('unsafe-paths', f.config, f, f.db, {
      sourceMode: 'publish',
    });
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf-8'));
    manifest.text.medium.path = '../medium-paste.md';
    writeFileSync(result.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    expect(() => loadDistributionKit('unsafe-paths', f))
      .toThrow(/unsafe or non-allowlisted path/);

    const regenerated = await generateDistributionKit('unsafe-paths', f.config, f, f.db, {
      sourceMode: 'publish',
      force: true,
    });
    const roleSwappedManifest = JSON.parse(readFileSync(regenerated.manifestPath, 'utf-8'));
    roleSwappedManifest.text.medium.path = 'linkedin.md';
    roleSwappedManifest.text.medium.sha256 = roleSwappedManifest.text.linkedin.sha256;
    writeFileSync(regenerated.manifestPath, `${JSON.stringify(roleSwappedManifest, null, 2)}\n`, 'utf-8');
    expect(() => loadDistributionKit('unsafe-paths', f))
      .toThrow(/expected 'medium-paste\.md'/);
  });

  it('rejects absolute, symlinked, and non-allowlisted table manifest paths', async () => {
    const f = setup();
    seedPost(f.db, 'unsafe-path-variants');
    writeDraft(f, 'unsafe-path-variants');
    const result = await generateDistributionKit('unsafe-path-variants', f.config, f, f.db, {
      sourceMode: 'publish',
    });

    let manifest = JSON.parse(readFileSync(result.manifestPath, 'utf-8'));
    manifest.text.medium.path = join(f.tempDir, 'absolute-medium-paste.md');
    writeFileSync(result.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    expect(() => loadDistributionKit('unsafe-path-variants', f))
      .toThrow(/unsafe or non-allowlisted path/);

    await generateDistributionKit('unsafe-path-variants', f.config, f, f.db, {
      sourceMode: 'publish',
      force: true,
    });
    const hackerNewsBytes = readFileSync(result.hackerNewsPath!);
    const symlinkTarget = join(f.tempDir, 'hackernews-target.md');
    writeFileSync(symlinkTarget, hackerNewsBytes);
    rmSync(result.hackerNewsPath!, { force: true });
    symlinkSync(symlinkTarget, result.hackerNewsPath!);
    expect(() => loadDistributionKit('unsafe-path-variants', f))
      .toThrow(/not a regular file/);

    rmSync(result.hackerNewsPath!, { force: true });
    await generateDistributionKit('unsafe-path-variants', f.config, f, f.db, {
      sourceMode: 'publish',
      force: true,
    });
    manifest = JSON.parse(readFileSync(result.manifestPath, 'utf-8'));
    manifest.tables.push({
      path: 'assets/../portable-table-bad.png',
      sha256: '0'.repeat(64),
      width: 1,
      height: 1,
      bytes: 1,
      alt: 'bad table',
      source_hash: '0'.repeat(64),
      row_count: 1,
      column_count: 1,
    });
    writeFileSync(result.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    expect(() => loadDistributionKit('unsafe-path-variants', f))
      .toThrow(/unsafe or non-allowlisted path/);
  });

  it('does not reuse an otherwise hash-matching manifest with an unsafe or wrong-role artifact path', async () => {
    const f = setup();
    seedPost(f.db, 'unsafe-reuse');
    writeDraft(f, 'unsafe-reuse');
    const result = await generateDistributionKit('unsafe-reuse', f.config, f, f.db, {
      sourceMode: 'publish',
    });
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf-8'));
    manifest.text.medium.path = '../medium-paste.md';
    writeFileSync(join(f.socialDir, 'medium-paste.md'), readFileSync(result.mediumPath!));
    writeFileSync(result.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const regenerated = await generateDistributionKit('unsafe-reuse', f.config, f, f.db, {
      sourceMode: 'publish',
    });

    expect(regenerated.reused).toBe(false);
    expect(regenerated.manifest.text.medium?.path).toBe('medium-paste.md');
    expect(() => loadDistributionKit('unsafe-reuse', f)).not.toThrow();

    seedPost(f.db, 'wrong-role-reuse');
    writeDraft(f, 'wrong-role-reuse');
    const roleResult = await generateDistributionKit('wrong-role-reuse', f.config, f, f.db, {
      sourceMode: 'publish',
    });
    const roleManifest = JSON.parse(readFileSync(roleResult.manifestPath, 'utf-8'));
    roleManifest.text.medium.path = 'linkedin.md';
    roleManifest.text.medium.sha256 = roleManifest.text.linkedin.sha256;
    writeFileSync(roleResult.manifestPath, `${JSON.stringify(roleManifest, null, 2)}\n`, 'utf-8');

    const roleRegenerated = await generateDistributionKit('wrong-role-reuse', f.config, f, f.db, {
      sourceMode: 'publish',
    });

    expect(roleRegenerated.reused).toBe(false);
    expect(roleRegenerated.manifest.text.medium?.path).toBe('medium-paste.md');
    expect(() => loadDistributionKit('wrong-role-reuse', f)).not.toThrow();
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
