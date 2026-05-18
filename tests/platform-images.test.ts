import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';

import { BlogConfig } from '../src/core/config/types.js';
import { parseFrontmatter } from '../src/core/draft/frontmatter.js';
import {
  DEVTO_MAIN_IMAGE,
  ensurePlatformImages,
  MEDIUM_FEATURED_IMAGE,
  SUBSTACK_PREVIEW_IMAGE,
  validatePlatformImageArtifacts,
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

async function writeWebpImage(path: string, width: number, height: number, color = '#336699'): Promise<void> {
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: color,
    },
  }).webp().toFile(path);
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
  it('generates exact Dev.to, Medium, and Substack preview PNGs from the shared article-card template', async () => {
    const f = setup('fallback');

    const result = await ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir });

    const devto = join(f.draftsDir, f.slug, 'assets', DEVTO_MAIN_IMAGE.filename);
    const medium = join(f.draftsDir, f.slug, 'assets', MEDIUM_FEATURED_IMAGE.filename);
    const substack = join(f.draftsDir, f.slug, 'assets', SUBSTACK_PREVIEW_IMAGE.filename);
    await expectDimensions(devto, 1000, 420);
    await expectDimensions(medium, 1200, 675);
    await expectDimensions(substack, 1200, 630);
    expect(result.images.map((i) => i.source)).toEqual([
      'fallback-template',
      'fallback-template',
      'fallback-template',
    ]);
    expect(result.images.every((i) => i.sha256?.match(/^[a-f0-9]{64}$/))).toBe(true);
    expect(result.images.every((i) => i.input_hash === result.images[0].input_hash)).toBe(true);

    const fm = parseFrontmatter(readFileSync(join(f.draftsDir, f.slug, 'index.mdx'), 'utf-8'));
    expect(fm.devto_main_image).toBe('./assets/devto-cover.png');
    expect(fm.medium_featured_image).toBe('./assets/medium-featured.png');
    expect(fm.substack_preview_image).toBe('./assets/substack-preview.png');
    const receipt = JSON.parse(readFileSync(join(f.draftsDir, f.slug, '.platform-images.json'), 'utf-8')) as {
      input_hash: string;
      images: Array<{ sha256?: string; input_hash?: string }>;
    };
    expect(receipt.input_hash).toBe(result.images[0].input_hash);
    expect(receipt.images.every((i) => i.sha256?.match(/^[a-f0-9]{64}$/))).toBe(true);
    expect(validatePlatformImageArtifacts(f.slug, makeConfig(), { draftsDir: f.draftsDir })).toEqual([]);
  });

  it('upgrades the legacy generated WebP Dev.to cover to the shared article-card PNG', async () => {
    const f = setup('existing-devto', ['devto_main_image: assets/devto-cover.webp']);
    await writeWebpImage(join(f.draftsDir, f.slug, 'assets', 'devto-cover.webp'), 1000, 420);

    const result = await ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir });

    const fm = parseFrontmatter(readFileSync(join(f.draftsDir, f.slug, 'index.mdx'), 'utf-8'));
    expect(fm.devto_main_image).toBe('./assets/devto-cover.png');
    expect(result.images.map((i) => i.source)).toEqual([
      'fallback-template',
      'fallback-template',
      'fallback-template',
    ]);
    await expectDimensions(join(f.draftsDir, f.slug, 'assets', 'devto-cover.png'), 1000, 420);
    await expectDimensions(join(f.draftsDir, f.slug, 'assets', 'medium-featured.png'), 1200, 675);
    await expectDimensions(join(f.draftsDir, f.slug, 'assets', 'substack-preview.png'), 1200, 630);
  });

  it('preserves custom WebP Dev.to covers', async () => {
    const f = setup('custom-devto-webp', ['devto_main_image: assets/custom-devto.webp']);
    await writeWebpImage(join(f.draftsDir, f.slug, 'assets', 'custom-devto.webp'), 1000, 420);

    const result = await ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir });

    const fm = parseFrontmatter(readFileSync(join(f.draftsDir, f.slug, 'index.mdx'), 'utf-8'));
    expect(fm.devto_main_image).toBe('./assets/custom-devto.webp');
    expect(result.images[0].source).toBe('configured-platform-image');
  });

  it('preserves explicit platform image URLs without rewriting frontmatter', async () => {
    const f = setup('external-urls', [
      'devto_main_image: "https://cdn.example.com/posts/devto.png"',
      'medium_featured_image: "https://cdn.example.com/posts/medium.png"',
      'substack_preview_image: "https://cdn.example.com/posts/substack.png"',
    ]);
    const draftPath = join(f.draftsDir, f.slug, 'index.mdx');
    const originalMdx = readFileSync(draftPath, 'utf-8');

    const result = await ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir });

    expect(result.frontmatterUpdated).toBe(false);
    expect(result.images.map((i) => i.source)).toEqual([
      'configured-platform-url',
      'configured-platform-url',
      'configured-platform-url',
    ]);
    expect(result.images[0].public_url).toBe('https://cdn.example.com/posts/devto.png');
    expect(result.images[1].public_url).toBe('https://cdn.example.com/posts/medium.png');
    expect(result.images[2].public_url).toBe('https://cdn.example.com/posts/substack.png');
    expect(readFileSync(draftPath, 'utf-8')).toBe(originalMdx);
    expect(readdirSync(join(f.draftsDir, f.slug, 'assets'))).toEqual([]);
  });

  it.each([
    ['devto_main_image', ''],
    ['devto_main_image', '../cover.webp'],
    ['medium_featured_image', '/tmp/cover.png'],
    ['medium_featured_image', 'assets/../cover.png'],
    ['medium_featured_image', 'assets/nested/cover.png'],
    ['substack_preview_image', 'file:///tmp/cover.png'],
    ['substack_preview_image', 'data:image/png;base64,abc'],
    ['substack_preview_image', 'assets\\cover.png'],
    ['substack_header_image', 'assets\\legacy-cover.png'],
  ])('rejects unsafe %s value %s', async (field, value) => {
    const f = setup('unsafe', [`${field}: "${value}"`]);

    await expect(ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir }))
      .rejects.toThrow(new RegExp(field));
  });

  it('rejects unsafe platform fields before writing generated assets or receipts', async () => {
    const f = setup('unsafe-no-writes', ['substack_preview_image: "../bad.png"']);
    const draftPath = join(f.draftsDir, f.slug, 'index.mdx');
    const originalMdx = readFileSync(draftPath, 'utf-8');

    await expect(ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir }))
      .rejects.toThrow(/substack_preview_image/);

    expect(readdirSync(join(f.draftsDir, f.slug, 'assets'))).toEqual([]);
    expect(existsSync(join(f.draftsDir, f.slug, '.platform-images.json'))).toBe(false);
    expect(readFileSync(draftPath, 'utf-8')).toBe(originalMdx);
  });

  it('keeps valid explicit platform image assets and normalizes draft-relative frontmatter', async () => {
    const f = setup('explicit', [
      'devto_main_image: assets/custom-devto.png',
      'medium_featured_image: assets/custom-medium.png',
      'substack_preview_image: ./assets/custom-substack.png',
    ]);
    await writeImage(join(f.draftsDir, f.slug, 'assets', 'custom-devto.png'), 1000, 420);
    await writeImage(join(f.draftsDir, f.slug, 'assets', 'custom-medium.png'), 1200, 675);
    await writeImage(join(f.draftsDir, f.slug, 'assets', 'custom-substack.png'), 1200, 630);

    const result = await ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir });

    expect(result.images.every((i) => i.generated === false)).toBe(true);
    const fm = parseFrontmatter(readFileSync(join(f.draftsDir, f.slug, 'index.mdx'), 'utf-8'));
    expect(fm.devto_main_image).toBe('./assets/custom-devto.png');
    expect(fm.medium_featured_image).toBe('./assets/custom-medium.png');
    expect(fm.substack_preview_image).toBe('./assets/custom-substack.png');
  });

  it('refreshes generator-owned default filenames in draft phase', async () => {
    const f = setup('explicit-defaults', [
      'devto_main_image: ./assets/devto-cover.png',
      'medium_featured_image: ./assets/medium-featured.png',
      'substack_preview_image: ./assets/substack-preview.png',
    ]);
    const devtoPath = join(f.draftsDir, f.slug, 'assets', 'devto-cover.png');
    const mediumPath = join(f.draftsDir, f.slug, 'assets', 'medium-featured.png');
    const substackPath = join(f.draftsDir, f.slug, 'assets', 'substack-preview.png');
    await writeImage(devtoPath, 1000, 420, '#111111');
    await writeImage(mediumPath, 1200, 675, '#112233');
    await writeImage(substackPath, 1200, 630, '#445566');
    const devtoBefore = readFileSync(devtoPath);
    const mediumBefore = readFileSync(mediumPath);
    const substackBefore = readFileSync(substackPath);

    const result = await ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir });

    expect(result.images.every((i) => i.generated === true)).toBe(true);
    expect(readFileSync(devtoPath)).not.toEqual(devtoBefore);
    expect(readFileSync(mediumPath)).not.toEqual(mediumBefore);
    expect(readFileSync(substackPath)).not.toEqual(substackBefore);
  });

  it('keeps default filename assets untouched during publish-phase verification when the receipt is fresh', async () => {
    const f = setup('explicit-defaults-publish', [
      'devto_main_image: ./assets/devto-cover.png',
      'medium_featured_image: ./assets/medium-featured.png',
      'substack_preview_image: ./assets/substack-preview.png',
    ]);
    await ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir });
    const devtoPath = join(f.draftsDir, f.slug, 'assets', 'devto-cover.png');
    const mediumPath = join(f.draftsDir, f.slug, 'assets', 'medium-featured.png');
    const substackPath = join(f.draftsDir, f.slug, 'assets', 'substack-preview.png');
    const devtoBefore = readFileSync(devtoPath);
    const mediumBefore = readFileSync(mediumPath);
    const substackBefore = readFileSync(substackPath);

    const result = await ensurePlatformImages(f.slug, makeConfig(), {
      draftsDir: f.draftsDir,
      updateFrontmatter: false,
      writeReceipt: false,
    });

    expect(result.images.every((i) => i.generated === false)).toBe(true);
    expect(readFileSync(devtoPath)).toEqual(devtoBefore);
    expect(readFileSync(mediumPath)).toEqual(mediumBefore);
    expect(readFileSync(substackPath)).toEqual(substackBefore);
  });

  it('rejects publish-phase verification when generator-owned assets are stale after a title edit', async () => {
    const f = setup('stale-defaults', [
      'devto_main_image: ./assets/devto-cover.png',
      'medium_featured_image: ./assets/medium-featured.png',
      'substack_preview_image: ./assets/substack-preview.png',
    ]);
    await ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir });
    const draftPath = join(f.draftsDir, f.slug, 'index.mdx');
    writeFileSync(
      draftPath,
      readFileSync(draftPath, 'utf-8').replace('Sample Platform Post', 'Changed Platform Post'),
      'utf-8',
    );

    expect(validatePlatformImageArtifacts(f.slug, makeConfig(), { draftsDir: f.draftsDir }).join('\n'))
      .toMatch(/stale|current generation receipt/);
    await expect(ensurePlatformImages(f.slug, makeConfig(), {
      draftsDir: f.draftsDir,
      updateFrontmatter: false,
      writeReceipt: false,
    })).rejects.toThrow(/stale platform images/);
  });

  it('keeps a valid explicit Dev.to image from being reused as the Medium or Substack output', async () => {
    const f = setup('separate-platform-outputs', ['devto_main_image: ./assets/devto-cover.png']);
    const sourcePath = join(f.draftsDir, f.slug, 'assets', 'devto-cover.png');
    await writeImage(sourcePath, 1000, 420, '#778899');

    await ensurePlatformImages(f.slug, makeConfig(), { draftsDir: f.draftsDir });

    await expectDimensions(sourcePath, 1000, 420);
    await expectDimensions(join(f.draftsDir, f.slug, 'assets', 'medium-featured.png'), 1200, 675);
    await expectDimensions(join(f.draftsDir, f.slug, 'assets', 'substack-preview.png'), 1200, 630);
    expect(readdirSync(join(f.draftsDir, f.slug, 'assets')).sort()).toEqual([
      'devto-cover.png',
      'medium-featured.png',
      'substack-preview.png',
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
    expect(assetNames).toEqual(['devto-cover.png', 'medium-featured.png', 'substack-preview.png']);
  });

  it('keeps fallback labels config-derived rather than hardcoded', () => {
    const source = readFileSync('src/core/publish/platform-images.ts', 'utf-8');
    expect(source).not.toContain("'m0lz.01'");
    expect(source).not.toContain("'m0lz.dev'");
  });
});
