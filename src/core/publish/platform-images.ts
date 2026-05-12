import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import sharp from 'sharp';

import { BlogConfig } from '../config/types.js';
import { parseFrontmatter, PostFrontmatter, serializeFrontmatter } from '../draft/frontmatter.js';

export const MEDIUM_FEATURED_IMAGE = {
  platform: 'medium',
  field: 'medium_featured_image',
  filename: 'medium-featured.png',
  width: 1200,
  height: 675,
  altSuffix: 'featured image',
} as const;

export const SUBSTACK_HEADER_IMAGE = {
  platform: 'substack',
  field: 'substack_header_image',
  filename: 'substack-header.png',
  width: 1100,
  height: 220,
  altSuffix: 'Substack header',
} as const;

export const PLATFORM_IMAGE_SPECS = [
  MEDIUM_FEATURED_IMAGE,
  SUBSTACK_HEADER_IMAGE,
] as const;

export type PlatformImageSpec = typeof PLATFORM_IMAGE_SPECS[number];
export type PlatformImageField = PlatformImageSpec['field'] | 'devto_main_image';

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
    | 'devto_main_image'
    | 'devto-cover.webp'
    | 'fallback-template';
  source_path?: string;
  generated: boolean;
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

interface LocalSource {
  path: string;
  source: 'devto_main_image' | 'devto-cover.webp';
  sourcePath: string;
}

type PlatformReferenceMap = Map<PlatformImageSpec['field'], ResolvedAssetReference | undefined>;

const FRONTMATTER_SPLIT_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/;

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
  spec: PlatformImageSpec,
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

function wrapTitle(title: string, maxChars: number): string[] {
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
    if (lines.length === 2) break;
  }
  if (current.length > 0 && lines.length < 3) {
    lines.push(current);
  }
  return lines.length > 0 ? lines.slice(0, 3) : ['site'];
}

function displayHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return cleanBaseUrl(baseUrl).replace(/^https?:\/\//i, '') || 'site';
  }
}

function fallbackSvg(spec: PlatformImageSpec, fm: PostFrontmatter, config: BlogConfig): string {
  const host = displayHost(config.site.base_url);
  const title = fm.title && fm.title !== '{{title}}' ? fm.title : host;
  const label = fm.project ?? config.author.github;
  const titleLines = wrapTitle(title, spec.platform === 'substack' ? 64 : 34);
  const titleStart = spec.platform === 'substack' ? 88 : 250;
  const titleSize = spec.platform === 'substack' ? 34 : 68;
  const titleGap = spec.platform === 'substack' ? 42 : 78;
  const markSize = spec.platform === 'substack' ? 72 : 120;
  const markX = spec.platform === 'substack' ? 42 : 72;
  const markY = spec.platform === 'substack' ? 38 : 72;
  const labelY = spec.platform === 'substack' ? 174 : 574;
  const titleText = titleLines
    .map((line, idx) =>
      `<text x="${spec.platform === 'substack' ? 150 : 240}" y="${titleStart + idx * titleGap}" fill="#f5f5f0" font-family="Inter, Arial, sans-serif" font-size="${titleSize}" font-weight="700">${escapeXml(line)}</text>`,
    )
    .join('\n');

  return `<svg width="${spec.width}" height="${spec.height}" viewBox="0 0 ${spec.width} ${spec.height}" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="${spec.width}" height="${spec.height}" fill="#090909"/>
<rect x="${markX}" y="${markY}" width="${markSize}" height="${markSize}" rx="${markSize / 9}" fill="#000000" stroke="#3a3a3a" stroke-width="${Math.max(2, markSize / 48)}"/>
<line x1="${markX + markSize * 0.38}" y1="${markY + markSize * 0.14}" x2="${markX + markSize * 0.38}" y2="${markY + markSize * 0.86}" stroke="#ffffff" stroke-width="${markSize * 0.056}" stroke-linecap="round"/>
<line x1="${markX + markSize * 0.62}" y1="${markY + markSize * 0.14}" x2="${markX + markSize * 0.62}" y2="${markY + markSize * 0.86}" stroke="#ffffff" stroke-width="${markSize * 0.056}" stroke-linecap="round"/>
<line x1="${markX + markSize * 0.38}" y1="${markY + markSize * 0.35}" x2="${markX + markSize * 0.16}" y2="${markY + markSize * 0.35}" stroke="#ffffff" stroke-width="${markSize * 0.056}" stroke-linecap="round"/>
<line x1="${markX + markSize * 0.62}" y1="${markY + markSize * 0.40}" x2="${markX + markSize * 0.84}" y2="${markY + markSize * 0.40}" stroke="#ffffff" stroke-width="${markSize * 0.056}" stroke-linecap="round"/>
<line x1="${markX + markSize * 0.62}" y1="${markY + markSize * 0.65}" x2="${markX + markSize * 0.84}" y2="${markY + markSize * 0.65}" stroke="#ffffff" stroke-width="${markSize * 0.056}" stroke-linecap="round"/>
${titleText}
<text x="${spec.platform === 'substack' ? 150 : 240}" y="${labelY}" fill="#b7b7ad" font-family="Inter, Arial, sans-serif" font-size="${spec.platform === 'substack' ? 20 : 30}" font-weight="600">${escapeXml(label)} / ${escapeXml(host)}</text>
</svg>`;
}

async function assertImageDimensions(path: string, spec: PlatformImageSpec): Promise<void> {
  const metadata = await sharp(path).metadata();
  if (metadata.width !== spec.width || metadata.height !== spec.height || metadata.format !== 'png') {
    throw new Error(
      `Invalid ${spec.field}: expected ${spec.width}x${spec.height} PNG, got ` +
      `${metadata.width ?? 'unknown'}x${metadata.height ?? 'unknown'} ${metadata.format ?? 'unknown'}`,
    );
  }
}

function findLocalSource(
  devto: ResolvedAssetReference | undefined,
  slug: string,
  paths: PlatformImagePaths,
): LocalSource | undefined {
  if (devto?.kind === 'asset') {
    if (!devto.localPath || !existsSync(devto.localPath)) {
      throw new Error(`devto_main_image asset not found: ${devto.normalizedAssetPath}`);
    }
    return {
      path: devto.localPath,
      source: 'devto_main_image',
      sourcePath: devto.normalizedAssetPath ?? devto.raw,
    };
  }

  const defaultCover = join(paths.draftsDir, slug, 'assets', 'devto-cover.webp');
  if (existsSync(defaultCover)) {
    return {
      path: defaultCover,
      source: 'devto-cover.webp',
      sourcePath: 'assets/devto-cover.webp',
    };
  }

  return undefined;
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
  return refs;
}

async function generatePlatformImage(
  spec: PlatformImageSpec,
  fm: PostFrontmatter,
  config: BlogConfig,
  outputPath: string,
  source: LocalSource | undefined,
): Promise<Pick<PlatformImageResult, 'source' | 'source_path'>> {
  if (source) {
    const samePath = source.path === outputPath;
    const writePath = samePath
      ? join(dirname(outputPath), `.${spec.filename}.${process.pid}.${Date.now()}.tmp`)
      : outputPath;
    await sharp(source.path)
      .resize(spec.width, spec.height, {
        fit: spec.platform === 'substack' ? 'contain' : 'cover',
        position: 'center',
        background: '#000000',
      })
      .png()
      .toFile(writePath);
    if (samePath) {
      renameSync(writePath, outputPath);
    }
    return { source: source.source, source_path: source.sourcePath };
  }

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
  const devto = resolvePostAssetReference(
    fm.devto_main_image,
    slug,
    config.site.base_url,
    'devto_main_image',
    paths,
  );
  const source = findLocalSource(devto, slug, paths);

  const assetsDir = join(paths.draftsDir, slug, 'assets');
  const results: PlatformImageResult[] = [];
  let frontmatterUpdated = false;

  if (!updateFrontmatter) {
    for (const spec of PLATFORM_IMAGE_SPECS) {
      const resolved = platformRefs.get(spec.field);
      if (resolved === undefined) {
        throw new Error(
          `Missing ${spec.field}. Run 'blog draft platform-images ${slug}' while the post is in draft phase.`,
        );
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
        });
        continue;
      }
      if (resolved.filename !== spec.filename) {
        throw new Error(`${spec.field} asset not found: ${resolved.normalizedAssetPath}`);
      }
      if (fm[spec.field] !== resolved.frontmatterValue) {
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
    const generation = await generatePlatformImage(spec, fm, config, outputPath, source);
    await assertImageDimensions(outputPath, spec);
    const nextValue = `./assets/${spec.filename}`;
    if (fm[spec.field] !== nextValue) {
      if (!updateFrontmatter) {
        throw new Error(
          `${spec.field} must be present before publishing. Run 'blog draft platform-images ${slug}' while the post is in draft phase.`,
        );
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
