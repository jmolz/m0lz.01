import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';

import { BlogConfig } from '../config/types.js';
import { parseFrontmatter, PostFrontmatter, serializeFrontmatter } from '../draft/frontmatter.js';

type PlatformName = 'devto' | 'medium' | 'substack';
export type GeneratedPlatformImageField = 'devto_main_image' | 'medium_featured_image' | 'substack_preview_image';
export type PlatformImageField = GeneratedPlatformImageField | 'substack_header_image';

interface PlatformImageSpecBase {
  platform: PlatformName;
  field: PlatformImageField;
  filename: string;
  width: number;
  height: number;
  altSuffix: string;
  allowedFormats?: readonly string[];
  legacyDefaultFilenames?: readonly string[];
}

export const DEVTO_MAIN_IMAGE = {
  platform: 'devto',
  field: 'devto_main_image',
  filename: 'devto-cover.png',
  width: 1000,
  height: 420,
  altSuffix: 'Dev.to cover image',
  allowedFormats: ['png', 'webp'],
  legacyDefaultFilenames: ['devto-cover.webp'],
} as const satisfies PlatformImageSpecBase;

export const MEDIUM_FEATURED_IMAGE = {
  platform: 'medium',
  field: 'medium_featured_image',
  filename: 'medium-featured.png',
  width: 1200,
  height: 675,
  altSuffix: 'featured image',
  allowedFormats: ['png'],
  legacyDefaultFilenames: [],
} as const satisfies PlatformImageSpecBase;

export const SUBSTACK_PREVIEW_IMAGE = {
  platform: 'substack',
  field: 'substack_preview_image',
  filename: 'substack-preview.png',
  width: 1200,
  height: 630,
  altSuffix: 'Substack preview image',
  allowedFormats: ['png'],
  legacyDefaultFilenames: [],
} as const satisfies PlatformImageSpecBase;

// Legacy compatibility only. Substack's persistent email banner/header is a
// publication-level asset, not a per-article asset, so the generator no longer
// emits this spec. Paste generation can still read old drafts that used it.
export const SUBSTACK_HEADER_IMAGE = {
  platform: 'substack',
  field: 'substack_header_image',
  filename: 'substack-header.png',
  width: 1100,
  height: 220,
  altSuffix: 'Substack header',
  allowedFormats: ['png'],
  legacyDefaultFilenames: [],
} as const satisfies PlatformImageSpecBase;

export const PLATFORM_IMAGE_SPECS = [
  DEVTO_MAIN_IMAGE,
  MEDIUM_FEATURED_IMAGE,
  SUBSTACK_PREVIEW_IMAGE,
] as const;

export type PlatformImageSpec = typeof PLATFORM_IMAGE_SPECS[number];
type AnyPlatformImageSpec = PlatformImageSpec | typeof SUBSTACK_HEADER_IMAGE;

export interface ResolvedAssetReference {
  kind: 'asset' | 'url';
  raw: string;
  publicUrl: string;
  filename?: string;
  normalizedAssetPath?: string;
  frontmatterValue?: string;
  localPath?: string;
}

export interface PlatformImageResult {
  platform: PlatformImageSpec['platform'];
  field: PlatformImageSpec['field'];
  filename: string;
  width: number;
  height: number;
  output_path: string;
  public_url: string;
  source:
    | 'configured-platform-image'
    | 'configured-platform-url'
    | 'fallback-template';
  source_path?: string;
  generated: boolean;
  sha256?: string;
  input_hash?: string;
}

export interface EnsurePlatformImagesResult {
  slug: string;
  draftPath: string;
  receiptPath: string;
  frontmatterUpdated: boolean;
  images: PlatformImageResult[];
}

interface PlatformImagePaths {
  draftsDir: string;
  updateFrontmatter?: boolean;
  writeReceipt?: boolean;
}

type PlatformReferenceMap = Map<PlatformImageSpec['field'], ResolvedAssetReference | undefined>;

const FRONTMATTER_SPLIT_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/;
const PLATFORM_IMAGE_TEMPLATE_VERSION = 2;

interface PlatformImagesReceipt {
  timestamp: string;
  slug: string;
  input_hash?: string;
  images?: PlatformImageResult[];
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function missingRequiredPlatformImageFields(fm: PostFrontmatter): GeneratedPlatformImageField[] {
  return PLATFORM_IMAGE_SPECS
    .map((spec) => spec.field)
    .filter((field) => (fm[field] ?? '').trim().length === 0);
}

export function platformImageDraftCompleteMessage(
  slug: string,
  missing: readonly GeneratedPlatformImageField[],
): string {
  return (
    `Missing platform image frontmatter: ${missing.join(', ')}. ` +
    `Run 'blog draft platform-images ${slug}' before 'blog draft complete ${slug}'.`
  );
}

function platformImagePublishRepairMessage(
  slug: string,
  field: PlatformImageSpec['field'],
): string {
  return (
    `Missing ${field}. This draft reached publish without platform image frontmatter. ` +
    `Run 'blog publish reopen-draft ${slug} --reason "missing platform images"', ` +
    `then run 'blog draft platform-images ${slug}' and re-run draft/evaluate before publishing.`
  );
}

function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function publicAssetUrl(baseUrl: string, slug: string, filename: string): string {
  return `${cleanBaseUrl(baseUrl)}/writing/${slug}/assets/${encodeURIComponent(filename)}`;
}

export function resolvePostAssetReference(
  rawValue: string | undefined,
  slug: string,
  baseUrl: string,
  fieldName: PlatformImageField,
  paths: PlatformImagePaths | undefined = undefined,
): ResolvedAssetReference | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  const raw = rawValue.trim();
  if (raw.length === 0) {
    throw new Error(`Invalid ${fieldName}: value cannot be empty`);
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return { kind: 'url', raw, publicUrl: raw };
      }
    } catch {
      throw new Error(`Invalid ${fieldName} URL: ${raw}`);
    }
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
    throw new Error(`Invalid ${fieldName}: expected an http(s) URL or assets/<filename>`);
  }

  const assetPath = raw.startsWith('./assets/') ? raw.slice(2) : raw;
  if (assetPath.startsWith('assets/')) {
    const filename = assetPath.slice('assets/'.length);
    if (
      filename.length === 0 ||
      filename.includes('/') ||
      filename.includes('\\') ||
      filename.includes('..')
    ) {
      throw new Error(`Invalid ${fieldName} asset path: ${raw}`);
    }

    return {
      kind: 'asset',
      raw,
      filename,
      normalizedAssetPath: `assets/${filename}`,
      frontmatterValue: `./assets/${filename}`,
      publicUrl: publicAssetUrl(baseUrl, slug, filename),
      localPath: paths ? join(paths.draftsDir, slug, 'assets', filename) : undefined,
    };
  }

  throw new Error(`Invalid ${fieldName}: expected an http(s) URL or assets/<filename>`);
}

export function resolvePlatformImageUrl(
  rawValue: string | undefined,
  slug: string,
  baseUrl: string,
  spec: AnyPlatformImageSpec,
): string {
  const resolved = resolvePostAssetReference(rawValue, slug, baseUrl, spec.field);
  return resolved?.publicUrl ?? publicAssetUrl(baseUrl, slug, spec.filename);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapTitle(title: string, maxChars: number, maxLines = 3): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length <= maxChars || current.length === 0) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
    if (lines.length === maxLines - 1) break;
  }
  if (current.length > 0 && lines.length < maxLines) {
    lines.push(current);
  }
  return lines.length > 0 ? lines.slice(0, maxLines) : ['site'];
}

function displayHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return cleanBaseUrl(baseUrl).replace(/^https?:\/\//i, '') || 'site';
  }
}

export function platformImageInputHash(fm: PostFrontmatter, config: BlogConfig): string {
  const host = displayHost(config.site.base_url);
  const title = fm.title && fm.title !== '{{title}}' ? fm.title : host;
  const label = fm.project ?? config.author.github;
  return createHash('sha256').update(JSON.stringify({
    version: PLATFORM_IMAGE_TEMPLATE_VERSION,
    title,
    label,
    host,
    specs: PLATFORM_IMAGE_SPECS.map((spec) => ({
      field: spec.field,
      filename: spec.filename,
      width: spec.width,
      height: spec.height,
    })),
  })).digest('hex');
}

function fallbackSvg(spec: PlatformImageSpec, fm: PostFrontmatter, config: BlogConfig): string {
  const host = displayHost(config.site.base_url);
  const title = fm.title && fm.title !== '{{title}}' ? fm.title : host;
  const label = fm.project ?? config.author.github;
  const marginX = Math.round(spec.width * 0.07);
  const marginY = Math.round(spec.height * 0.11);
  const markSize = Math.round(Math.min(spec.width * 0.13, spec.height * 0.24));
  const markX = marginX;
  const markY = marginY;
  const textX = markX + markSize + Math.round(spec.width * 0.045);
  const textWidth = Math.max(320, spec.width - textX - marginX);
  const titleSize = Math.round(Math.min(spec.height * 0.13, spec.width * 0.055, 68));
  const titleGap = Math.round(titleSize * 1.14);
  const titleLines = wrapTitle(title, Math.max(20, Math.floor(textWidth / (titleSize * 0.54))), 3);
  const titleBlockHeight = (titleLines.length - 1) * titleGap;
  const titleStart = Math.round(spec.height * 0.45 - titleBlockHeight / 2);
  const labelY = Math.round(spec.height - marginY - Math.max(22, spec.height * 0.045));
  const labelSize = Math.round(Math.max(18, Math.min(30, spec.height * 0.048)));
  const ruleY = Math.round(spec.height - marginY);
  const titleText = titleLines
    .map((line, idx) =>
      `<text x="${textX}" y="${titleStart + idx * titleGap}" fill="#f5f5f0" font-family="Inter, Arial, sans-serif" font-size="${titleSize}" font-weight="700">${escapeXml(line)}</text>`,
    )
    .join('\n');

  return `<svg width="${spec.width}" height="${spec.height}" viewBox="0 0 ${spec.width} ${spec.height}" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="${spec.width}" height="${spec.height}" fill="#090909"/>
<rect x="${marginX}" y="${ruleY}" width="${spec.width - marginX * 2}" height="2" fill="#2b2b2b"/>
<rect x="${markX}" y="${markY}" width="${markSize}" height="${markSize}" rx="${markSize / 9}" fill="#000000" stroke="#3a3a3a" stroke-width="${Math.max(2, markSize / 48)}"/>
<line x1="${markX + markSize * 0.38}" y1="${markY + markSize * 0.14}" x2="${markX + markSize * 0.38}" y2="${markY + markSize * 0.86}" stroke="#ffffff" stroke-width="${markSize * 0.056}" stroke-linecap="round"/>
<line x1="${markX + markSize * 0.62}" y1="${markY + markSize * 0.14}" x2="${markX + markSize * 0.62}" y2="${markY + markSize * 0.86}" stroke="#ffffff" stroke-width="${markSize * 0.056}" stroke-linecap="round"/>
<line x1="${markX + markSize * 0.38}" y1="${markY + markSize * 0.35}" x2="${markX + markSize * 0.16}" y2="${markY + markSize * 0.35}" stroke="#ffffff" stroke-width="${markSize * 0.056}" stroke-linecap="round"/>
<line x1="${markX + markSize * 0.62}" y1="${markY + markSize * 0.40}" x2="${markX + markSize * 0.84}" y2="${markY + markSize * 0.40}" stroke="#ffffff" stroke-width="${markSize * 0.056}" stroke-linecap="round"/>
<line x1="${markX + markSize * 0.62}" y1="${markY + markSize * 0.65}" x2="${markX + markSize * 0.84}" y2="${markY + markSize * 0.65}" stroke="#ffffff" stroke-width="${markSize * 0.056}" stroke-linecap="round"/>
${titleText}
<text x="${textX}" y="${labelY}" fill="#b7b7ad" font-family="Inter, Arial, sans-serif" font-size="${labelSize}" font-weight="600">${escapeXml(label)} / ${escapeXml(host)}</text>
</svg>`;
}

function receiptPathFor(draftsDir: string, slug: string): string {
  return join(draftsDir, slug, '.platform-images.json');
}

function readReceipt(draftsDir: string, slug: string): PlatformImagesReceipt | null {
  const path = receiptPathFor(draftsDir, slug);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as PlatformImagesReceipt;
  } catch {
    return null;
  }
}

function receiptImageFor(
  receipt: PlatformImagesReceipt | null,
  field: GeneratedPlatformImageField,
): PlatformImageResult | null {
  return receipt?.images?.find((image) => image.field === field) ?? null;
}

export function validatePlatformImageArtifacts(
  slug: string,
  config: BlogConfig,
  paths: Pick<PlatformImagePaths, 'draftsDir'>,
): string[] {
  const draftPath = join(paths.draftsDir, slug, 'index.mdx');
  if (!existsSync(draftPath)) {
    return [`Draft MDX not found: ${draftPath}`];
  }

  const fm = parseFrontmatter(readFileSync(draftPath, 'utf-8'));
  const inputHash = platformImageInputHash(fm, config);
  const receipt = readReceipt(paths.draftsDir, slug);
  const errors: string[] = [];

  for (const spec of PLATFORM_IMAGE_SPECS) {
    const resolved = resolvePostAssetReference(
      fm[spec.field],
      slug,
      config.site.base_url,
      spec.field,
      paths,
    );
    if (resolved === undefined) {
      errors.push(platformImageDraftCompleteMessage(slug, [spec.field]));
      continue;
    }
    if (resolved.kind === 'url') continue;
    if (!resolved.localPath) {
      errors.push(`${spec.field} asset path could not be resolved`);
      continue;
    }
    if (!existsSync(resolved.localPath)) {
      errors.push(`${spec.field} asset not found: ${resolved.normalizedAssetPath}`);
      continue;
    }

    const isGeneratorDefault = resolved.filename === spec.filename;
    if (!isGeneratorDefault) continue;

    const receiptImage = receiptImageFor(receipt, spec.field);
    if (!receipt || receipt.input_hash !== inputHash || !receiptImage?.sha256) {
      errors.push(
        `${spec.field} is stale or lacks a current generation receipt. ` +
        `Run 'blog draft platform-images ${slug}' after the latest title/frontmatter edit.`,
      );
      continue;
    }
    const actualHash = sha256File(resolved.localPath);
    if (actualHash !== receiptImage.sha256) {
      errors.push(
        `${spec.field} asset hash does not match .platform-images.json. ` +
        `Run 'blog draft platform-images ${slug}' to regenerate the platform images.`,
      );
    }
  }

  return errors;
}

async function assertImageDimensions(path: string, spec: PlatformImageSpec): Promise<void> {
  const metadata = await sharp(path).metadata();
  const formats: readonly string[] = spec.allowedFormats;
  const actualFormat = metadata.format ?? 'unknown';
  if (
    metadata.width !== spec.width ||
    metadata.height !== spec.height ||
    !formats.includes(actualFormat)
  ) {
    const expectedFormat = formats.map((format) => format.toUpperCase()).join(' or ');
    throw new Error(
      `Invalid ${spec.field}: expected ${spec.width}x${spec.height} ${expectedFormat}, got ` +
      `${metadata.width ?? 'unknown'}x${metadata.height ?? 'unknown'} ${actualFormat}`,
    );
  }
}

async function resolveAndValidatePlatformReferences(
  fm: PostFrontmatter,
  slug: string,
  config: BlogConfig,
  paths: PlatformImagePaths,
): Promise<PlatformReferenceMap> {
  const refs: PlatformReferenceMap = new Map();
  for (const spec of PLATFORM_IMAGE_SPECS) {
    const resolved = resolvePostAssetReference(
      fm[spec.field],
      slug,
      config.site.base_url,
      spec.field,
      paths,
    );
    if (resolved?.kind === 'asset') {
      if (!resolved.localPath) {
        throw new Error(`${spec.field} asset path could not be resolved`);
      }
      if (existsSync(resolved.localPath)) {
        await assertImageDimensions(resolved.localPath, spec);
      } else if (resolved.filename !== spec.filename) {
        throw new Error(`${spec.field} asset not found: ${resolved.normalizedAssetPath}`);
      }
    }
    refs.set(spec.field, resolved);
  }
  resolvePostAssetReference(
    fm.substack_header_image,
    slug,
    config.site.base_url,
    'substack_header_image',
    paths,
  );
  return refs;
}

async function generatePlatformImage(
  spec: PlatformImageSpec,
  fm: PostFrontmatter,
  config: BlogConfig,
  outputPath: string,
): Promise<Pick<PlatformImageResult, 'source' | 'source_path'>> {
  await sharp(Buffer.from(fallbackSvg(spec, fm, config)))
    .png()
    .toFile(outputPath);
  return { source: 'fallback-template' };
}

function rewriteFrontmatter(mdx: string, fm: PostFrontmatter): string {
  const match = mdx.match(FRONTMATTER_SPLIT_RE);
  if (!match) {
    throw new Error('Draft MDX has no frontmatter delimiters');
  }
  const body = mdx.slice(match[0].length);
  return `${serializeFrontmatter(fm)}\n${body}`;
}

export async function ensurePlatformImages(
  slug: string,
  config: BlogConfig,
  paths: PlatformImagePaths,
): Promise<EnsurePlatformImagesResult> {
  const updateFrontmatter = paths.updateFrontmatter ?? true;
  const writeReceipt = paths.writeReceipt ?? true;
  const draftPath = join(paths.draftsDir, slug, 'index.mdx');
  if (!existsSync(draftPath)) {
    throw new Error(`Draft MDX not found: ${draftPath}`);
  }

  const originalMdx = readFileSync(draftPath, 'utf-8');
  const fm = parseFrontmatter(originalMdx);
  const platformRefs = await resolveAndValidatePlatformReferences(fm, slug, config, paths);
  const inputHash = platformImageInputHash(fm, config);

  if (!updateFrontmatter) {
    const staleErrors = validatePlatformImageArtifacts(slug, config, paths);
    if (staleErrors.length > 0) {
      throw new Error(
        staleErrors.join('\n') + '\n' +
        `Run 'blog publish reopen-draft ${slug} --reason "stale platform images"', ` +
        `then run 'blog draft platform-images ${slug}' and re-run draft/evaluate before publishing.`,
      );
    }
  }

  const assetsDir = join(paths.draftsDir, slug, 'assets');
  const results: PlatformImageResult[] = [];
  let frontmatterUpdated = false;

  if (!updateFrontmatter) {
    for (const spec of PLATFORM_IMAGE_SPECS) {
      const resolved = platformRefs.get(spec.field);
      if (resolved === undefined) {
        throw new Error(platformImagePublishRepairMessage(slug, spec.field));
      }
      if (resolved.kind === 'asset' && fm[spec.field] !== resolved.frontmatterValue) {
        throw new Error(
          `${spec.field} must use normalized ./assets/<filename> form before publishing`,
        );
      }
    }
  }

  mkdirSync(assetsDir, { recursive: true });

  for (const spec of PLATFORM_IMAGE_SPECS) {
    const resolved = platformRefs.get(spec.field);

    if (resolved?.kind === 'url') {
      results.push({
        platform: spec.platform,
        field: spec.field,
        filename: spec.filename,
        width: spec.width,
        height: spec.height,
        output_path: resolved.publicUrl,
        public_url: resolved.publicUrl,
        source: 'configured-platform-url',
        generated: false,
      });
      continue;
    }

    if (resolved?.kind === 'asset') {
      const localPath = resolved.localPath;
      if (!localPath) {
        throw new Error(`${spec.field} asset path could not be resolved`);
      }
      const isDefaultFilename = resolved.filename === spec.filename;
      const legacyDefaultFilenames: readonly string[] = spec.legacyDefaultFilenames;
      const isLegacyDefaultFilename =
        resolved.filename !== undefined &&
        legacyDefaultFilenames.includes(resolved.filename);
      const shouldRegenerateDefault =
        updateFrontmatter && (isDefaultFilename || isLegacyDefaultFilename);
      if (existsSync(localPath)) {
        if (fm[spec.field] !== resolved.frontmatterValue) {
          if (!updateFrontmatter) {
            throw new Error(
              `${spec.field} must use normalized ./assets/<filename> form before publishing`,
            );
          }
          fm[spec.field] = resolved.frontmatterValue;
          frontmatterUpdated = true;
        }
        if (shouldRegenerateDefault) {
          // Fall through to render the current deterministic template into
          // the canonical output filename. Custom filenames and external URLs
          // are preserved; generator-owned defaults are refreshable in draft
          // phase so visual framework changes can actually take effect.
        } else {
          results.push({
            platform: spec.platform,
            field: spec.field,
            filename: resolved.filename ?? spec.filename,
            width: spec.width,
            height: spec.height,
            output_path: localPath,
            public_url: resolved.publicUrl,
            source: 'configured-platform-image',
            source_path: resolved.normalizedAssetPath,
            generated: false,
            sha256: sha256File(localPath),
          });
          continue;
        }
      }
      if (resolved.filename !== spec.filename && !shouldRegenerateDefault) {
        throw new Error(`${spec.field} asset not found: ${resolved.normalizedAssetPath}`);
      }
      if (isLegacyDefaultFilename && updateFrontmatter) {
        frontmatterUpdated = true;
      } else if (fm[spec.field] !== resolved.frontmatterValue) {
        if (!updateFrontmatter) {
          throw new Error(
            `${spec.field} must use normalized ./assets/<filename> form before publishing`,
          );
        }
        fm[spec.field] = resolved.frontmatterValue;
        frontmatterUpdated = true;
      }
    }

    const outputPath = join(assetsDir, spec.filename);
    const generation = await generatePlatformImage(spec, fm, config, outputPath);
    await assertImageDimensions(outputPath, spec);
    const generatedHash = sha256File(outputPath);
    const nextValue = `./assets/${spec.filename}`;
    if (fm[spec.field] !== nextValue) {
      if (!updateFrontmatter) {
        throw new Error(platformImagePublishRepairMessage(slug, spec.field));
      }
      fm[spec.field] = nextValue;
      frontmatterUpdated = true;
    }
    results.push({
      platform: spec.platform,
      field: spec.field,
      filename: spec.filename,
      width: spec.width,
      height: spec.height,
      output_path: outputPath,
      public_url: publicAssetUrl(config.site.base_url, slug, spec.filename),
      source: generation.source,
      source_path: generation.source_path,
      generated: true,
      sha256: generatedHash,
      input_hash: inputHash,
    });
  }

  if (frontmatterUpdated && updateFrontmatter) {
    writeFileSync(draftPath, rewriteFrontmatter(originalMdx, fm), 'utf-8');
  }

  const receiptPath = join(paths.draftsDir, slug, '.platform-images.json');
  if (writeReceipt) {
    writeFileSync(
      receiptPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          slug,
          input_hash: inputHash,
          images: results,
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
  }

  return {
    slug,
    draftPath,
    receiptPath,
    frontmatterUpdated,
    images: results,
  };
}
