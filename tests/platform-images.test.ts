import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';

import { BlogConfig } from '../src/core/config/types.js';
import { parseFrontmatter } from '../src/core/draft/frontmatter.js';
import {
  ensurePlatformImages,
  MEDIUM_FEATURED_IMAGE,
  SUBSTACK_HEADER_IMAGE,
} from '../src/core/publish/platform-images.js';

let tempDir: string | undefined;

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
    social: { platforms: ['linkedin'], timing_recommendations: true },
    evaluation: {
      require_pass: true,
      min_sources: 3,
      max_reading_level: 12,
      three_reviewer_panel: true,
      consensus_must_fix: true,
      majority_should_fix: true,
      single_advisory: true,
      verify_benchmark_claims: true,
      methodology_completeness: true,
    },
    updates: { preserve_original_data: true, update_notice: true, update_crosspost: true },
    unpublish: { devto: true, medium: true, substack: true, readme: true },
  };
}

function setup(slug = 'sample', frontmatterLines: string[] = []): { draftsDir: string; slug: string } {
  tempDir = mkdtempSync(join(tmpdir(), 'platform-images-'));
  const draftsDir = join(tempDir, 'drafts');
  const draftDir = join(draftsDir, slug);
  mkdirSync(join(draftDir, 'assets'), { recursive: true });
  const frontmatter = [
    'title: "Sample Platform Post"',
    'description: "Description"',
    'date: "2026-05-12"',
    'tags:',
    '  - images',
    'published: false',
    'canonical: "https://m0lz.dev/writing/sample"',
    ...frontmatterLines,
  ].join('\n');
  writeFileSync(join(draftDir, 'index.mdx'), `---\n${frontmatter}\n---\n\n# Body\n`, 'utf-8');
  return { draftsDir, slug };
}

async function writeImage(path: string, width: number, height: number, color = '#336699'): Promise<void> {
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: color,
    },
  }).png().toFile(path);
}

async function expectDimensions(path: string, width: number, height: number): Promise<void> {
  const metadata = await sharp(path).metadata();
  expect(metadata.format).toBe('png');
  expect(metadata.width).toBe(width);
  expect(metadata.height).toBe(height);
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('ensurePlatformImages', () => {
  it('generates exact Medium and Substack PNGs from a local devto_main_image', async () => {
    const f = setup('from-devto', ['devto_main_image: ./assets/source.png']);
    await writeImage(join(f.draftsDir, f.slug, 'assets', 'source.png'), 1600, 900);

    const result = await ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir });

    const medium = join(f.draftsDir, f.slug, 'assets', MEDIUM_FEATURED_IMAGE.filename);
    const substack = join(f.draftsDir, f.slug, 'assets', SUBSTACK_HEADER_IMAGE.filename);
    await expectDimensions(medium, 1200, 675);
    await expectDimensions(substack, 1100, 220);
    expect(result.images.map((i) => i.source)).toEqual(['devto_main_image', 'devto_main_image']);

    const fm = parseFrontmatter(readFileSync(join(f.draftsDir, f.slug, 'index.mdx'), 'utf-8'));
    expect(fm.medium_featured_image).toBe('./assets/medium-featured.png');
    expect(fm.substack_header_image).toBe('./assets/substack-header.png');
    expect(existsSync(join(f.draftsDir, f.slug, '.platform-images.json'))).toBe(true);
  });

  it('generates both PNGs from the deterministic fallback when no source image exists', async () => {
    const f = setup('fallback');

    await ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir });

    await expectDimensions(join(f.draftsDir, f.slug, 'assets', 'medium-featured.png'), 1200, 675);
    await expectDimensions(join(f.draftsDir, f.slug, 'assets', 'substack-header.png'), 1100, 220);
  });

  it('preserves explicit platform image URLs without rewriting frontmatter', async () => {
    const f = setup('external-urls', [
      'medium_featured_image: "https://cdn.example.com/posts/medium.png"',
      'substack_header_image: "https://cdn.example.com/posts/substack.png"',
    ]);
    const draftPath = join(f.draftsDir, f.slug, 'index.mdx');
    const originalMdx = readFileSync(draftPath, 'utf-8');

    const result = await ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir });

    expect(result.frontmatterUpdated).toBe(false);
    expect(result.images.map((i) => i.source)).toEqual([
      'configured-platform-url',
      'configured-platform-url',
    ]);
    expect(result.images[0].public_url).toBe('https://cdn.example.com/posts/medium.png');
    expect(result.images[1].public_url).toBe('https://cdn.example.com/posts/substack.png');
    expect(readFileSync(draftPath, 'utf-8')).toBe(originalMdx);
    expect(readdirSync(join(f.draftsDir, f.slug, 'assets'))).toEqual([]);
  });

  it.each([
    ['devto_main_image', ''],
    ['devto_main_image', '../cover.webp'],
    ['medium_featured_image', '/tmp/cover.png'],
    ['medium_featured_image', 'assets/../cover.png'],
    ['medium_featured_image', 'assets/nested/cover.png'],
    ['substack_header_image', 'file:///tmp/cover.png'],
    ['substack_header_image', 'data:image/png;base64,abc'],
    ['substack_header_image', 'assets\\cover.png'],
  ])('rejects unsafe %s value %s', async (field, value) => {
    const f = setup('unsafe', [`${field}: "${value}"`]);

    await expect(ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir }))
      .rejects.toThrow(new RegExp(field));
  });

  it('rejects unsafe platform fields before writing generated assets or receipts', async () => {
    const f = setup('unsafe-no-writes', ['substack_header_image: "../bad.png"']);
    const draftPath = join(f.draftsDir, f.slug, 'index.mdx');
    const originalMdx = readFileSync(draftPath, 'utf-8');

    await expect(ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir }))
      .rejects.toThrow(/substack_header_image/);

    expect(readdirSync(join(f.draftsDir, f.slug, 'assets'))).toEqual([]);
    expect(existsSync(join(f.draftsDir, f.slug, '.platform-images.json'))).toBe(false);
    expect(readFileSync(draftPath, 'utf-8')).toBe(originalMdx);
  });

  it('keeps valid explicit platform image assets and normalizes draft-relative frontmatter', async () => {
    const f = setup('explicit', [
      'medium_featured_image: assets/custom-medium.png',
      'substack_header_image: ./assets/custom-substack.png',
    ]);
    await writeImage(join(f.draftsDir, f.slug, 'assets', 'custom-medium.png'), 1200, 675);
    await writeImage(join(f.draftsDir, f.slug, 'assets', 'custom-substack.png'), 1100, 220);

    const result = await ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir });

    expect(result.images.every((i) => i.generated === false)).toBe(true);
    const fm = parseFrontmatter(readFileSync(join(f.draftsDir, f.slug, 'index.mdx'), 'utf-8'));
    expect(fm.medium_featured_image).toBe('./assets/custom-medium.png');
    expect(fm.substack_header_image).toBe('./assets/custom-substack.png');
  });

  it('keeps valid explicit platform image assets when they use default filenames', async () => {
    const f = setup('explicit-defaults', [
      'medium_featured_image: ./assets/medium-featured.png',
      'substack_header_image: ./assets/substack-header.png',
    ]);
    const mediumPath = join(f.draftsDir, f.slug, 'assets', 'medium-featured.png');
    const substackPath = join(f.draftsDir, f.slug, 'assets', 'substack-header.png');
    await writeImage(mediumPath, 1200, 675, '#112233');
    await writeImage(substackPath, 1100, 220, '#445566');
    const mediumBefore = readFileSync(mediumPath);
    const substackBefore = readFileSync(substackPath);

    const result = await ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir });

    expect(result.images.every((i) => i.generated === false)).toBe(true);
    expect(readFileSync(mediumPath)).toEqual(mediumBefore);
    expect(readFileSync(substackPath)).toEqual(substackBefore);
  });

  it('handles devto_main_image pointing at a default output path without same-file write errors', async () => {
    const f = setup('same-path-source', ['devto_main_image: ./assets/medium-featured.png']);
    const sourcePath = join(f.draftsDir, f.slug, 'assets', 'medium-featured.png');
    await writeImage(sourcePath, 1600, 900, '#778899');

    await ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir });

    await expectDimensions(sourcePath, 1200, 675);
    await expectDimensions(join(f.draftsDir, f.slug, 'assets', 'substack-header.png'), 1100, 220);
    expect(readdirSync(join(f.draftsDir, f.slug, 'assets')).sort()).toEqual([
      'medium-featured.png',
      'substack-header.png',
    ]);
  });

  it('throws when an explicit platform image has the wrong dimensions', async () => {
    const f = setup('wrong-dimensions', ['medium_featured_image: ./assets/custom-medium.png']);
    await writeImage(join(f.draftsDir, f.slug, 'assets', 'custom-medium.png'), 100, 100);

    await expect(ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir }))
      .rejects.toThrow(/expected 1200x675 PNG/);
  });

  it('is idempotent and uses stable filenames without numbered duplicates', async () => {
    const f = setup('idempotent');

    await ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir });
    await ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir });

    const assetNames = readdirSync(join(f.draftsDir, f.slug, 'assets')).sort();
    expect(assetNames).toEqual(['medium-featured.png', 'substack-header.png']);
  });

  it('keeps fallback labels config-derived rather than hardcoded', () => {
    const source = readFileSync('src/core/publish/platform-images.ts', 'utf-8');
    expect(source).not.toContain("'m0lz.01'");
    expect(source).not.toContain("'m0lz.dev'");
  });
});
