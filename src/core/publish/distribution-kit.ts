import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import Database from 'better-sqlite3';
import sharp from 'sharp';

import { BlogConfig, LinkedInImageConfig, LinkedInImageMode } from '../config/types.js';
import { ContentType, PostRow, UpdateCycleRow } from '../db/types.js';
import { parseFrontmatter, PostFrontmatter } from '../draft/frontmatter.js';
import { getOpenUpdateCycle } from '../update/cycles.js';
import { ImageProvider, OpenAIImageProvider } from './openai-image.js';

export const LINKEDIN_IMAGE_FILENAME = 'linkedin-feed.png';
export const LINKEDIN_IMAGE_FORMAT = 'png';

export type DistributionKitSourceMode = 'publish' | 'update' | 'backfill';

export interface DistributionKitPaths {
  socialDir: string;
  templatesDir: string;
  draftsDir: string;
  configPath: string;
}

export interface SocialMetadata {
  slug: string;
  title: string;
  description: string;
  canonicalUrl: string;
  tags: string[];
  companionRepo: string | null;
  project: string | null;
  contentType: ContentType | null;
  updateCycle: {
    id: number;
    cycleNumber: number;
    summary: string | null;
    openedAt: string;
  } | null;
}

interface ArtifactManifestEntry {
  path: string;
  sha256: string;
}

interface ImageManifestEntry extends ArtifactManifestEntry {
  width: number;
  height: number;
  bytes: number;
}

export interface DistributionKitManifest {
  slug: string;
  canonical_url: string;
  source_mode: DistributionKitSourceMode;
  input_hash: string;
  generated_at: string;
  platforms: string[];
  text: {
    linkedin: ArtifactManifestEntry;
    hackernews: ArtifactManifestEntry;
  };
  prompt: ArtifactManifestEntry | null;
  image: ImageManifestEntry | null;
  image_provider: 'openai';
  image_model: string;
  image_size: string;
  image_quality: string;
  image_format: 'png';
  image_mode: LinkedInImageMode;
  reused: boolean;
}

export interface GenerateDistributionKitOptions {
  sourceMode: DistributionKitSourceMode;
  imageMode?: LinkedInImageMode;
  force?: boolean;
  provider?: ImageProvider;
}

export interface GenerateDistributionKitResult {
  slug: string;
  directory: string;
  linkedinPath: string;
  hackerNewsPath: string;
  promptPath: string | null;
  imagePath: string | null;
  manifestPath: string;
  manifest: DistributionKitManifest;
  reused: boolean;
}

const REQUIRED_PROMPT_TERMS = [
  'technical founder',
  'local workflow',
  'inspectable',
  'real workspace',
];

const BANNED_PROMPT_TERMS = [
  'AI glow',
  'robot',
  'orb',
  'bokeh',
  'corporate handshake',
  'fake UI text',
  'unreadable text',
];

const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(',')}}`;
}

function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function resolveSiteRepoPath(configPath: string, repoPath: string): string {
  if (isAbsolute(repoPath)) return repoPath;
  return resolve(dirname(configPath), repoPath);
}

function isRealString(value: string | null | undefined): value is string {
  return value !== undefined &&
    value !== null &&
    value.trim().length > 0 &&
    value.trim() !== '{{title}}' &&
    value.trim() !== '{{description}}' &&
    value.trim().toLowerCase() !== 'n/a';
}

function readFrontmatterIfPresent(path: string): PostFrontmatter | null {
  if (!existsSync(path)) return null;
  try {
    return parseFrontmatter(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function metadataFromFrontmatter(
  fm: PostFrontmatter | null,
): Partial<Pick<SocialMetadata, 'title' | 'description' | 'canonicalUrl' | 'tags' | 'companionRepo' | 'project'>> {
  if (!fm) return {};
  return {
    title: isRealString(fm.title) ? fm.title : undefined,
    description: isRealString(fm.description) ? fm.description : undefined,
    canonicalUrl: isRealString(fm.canonical) ? fm.canonical : undefined,
    tags: Array.isArray(fm.tags) ? fm.tags.filter(isRealString) : undefined,
    companionRepo: isRealString(fm.companion_repo) ? fm.companion_repo : undefined,
    project: isRealString(fm.project) ? fm.project : undefined,
  };
}

function mergeDefined(...parts: Array<Partial<SocialMetadata>>): Partial<SocialMetadata> {
  const out: Partial<SocialMetadata> = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (value !== undefined && value !== null) {
        out[key as keyof SocialMetadata] = value as never;
      }
    }
  }
  return out;
}

export function resolveSocialMetadata(
  slug: string,
  config: BlogConfig,
  paths: DistributionKitPaths,
  db: Database.Database,
  sourceMode: DistributionKitSourceMode,
): SocialMetadata {
  const post = db
    .prepare('SELECT * FROM posts WHERE slug = ?')
    .get(slug) as PostRow | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }

  const draftFrontmatter = readFrontmatterIfPresent(join(paths.draftsDir, slug, 'index.mdx'));
  const siteRepoPath = resolveSiteRepoPath(paths.configPath, config.site.repo_path);
  const hubFrontmatter = readFrontmatterIfPresent(
    join(siteRepoPath, config.site.content_dir, slug, 'index.mdx'),
  );

  const dbMeta: Partial<SocialMetadata> = {
    title: isRealString(post.title) ? post.title : slug,
    description: isRealString(post.topic) ? post.topic : '',
    canonicalUrl: `${cleanBaseUrl(config.site.base_url)}/writing/${slug}`,
    tags: [],
    companionRepo: isRealString(post.repo_url) ? post.repo_url : null,
    project: isRealString(post.project_id) ? post.project_id : null,
    contentType: post.content_type,
  };

  const primary =
    sourceMode === 'backfill'
      ? mergeDefined(
          dbMeta,
          metadataFromFrontmatter(draftFrontmatter),
          metadataFromFrontmatter(hubFrontmatter),
        )
      : mergeDefined(
          dbMeta,
          metadataFromFrontmatter(draftFrontmatter),
        );

  const openCycle = sourceMode === 'update' ? getOpenUpdateCycle(db, slug) : null;
  const updateCycle = openCycle
    ? {
        id: openCycle.id,
        cycleNumber: openCycle.cycle_number,
        summary: openCycle.summary,
        openedAt: openCycle.opened_at,
      }
    : null;

  return {
    slug,
    title: String(primary.title ?? slug),
    description: String(primary.description ?? ''),
    canonicalUrl: String(primary.canonicalUrl ?? `${cleanBaseUrl(config.site.base_url)}/writing/${slug}`),
    tags: Array.isArray(primary.tags) ? primary.tags : [],
    companionRepo: isRealString(primary.companionRepo as string | null | undefined)
      ? String(primary.companionRepo)
      : null,
    project: isRealString(primary.project as string | null | undefined)
      ? String(primary.project)
      : null,
    contentType: (primary.contentType as ContentType | null | undefined) ?? post.content_type,
    updateCycle,
  };
}

export function extractLeadSentence(description: string, maxLen: number): string {
  const trimmed = description.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (char !== '.' && char !== '!' && char !== '?') continue;
    const next = trimmed[i + 1] ?? '';
    const prev = trimmed[i - 1] ?? '';
    if (char === '.' && /[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next)) {
      continue;
    }
    if (next === '' || /\s/.test(next)) {
      const sentence = trimmed.slice(0, i + 1);
      if (sentence.length <= maxLen) return sentence;
    }
  }
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 3).trimEnd()}...`;
}

function hashtags(tags: string[]): string {
  return tags
    .map((tag) => tag.replace(/[^A-Za-z0-9]/g, ''))
    .filter(Boolean)
    .map((tag) => `#${tag}`)
    .join(' ');
}

function truncateHackerNewsTitle(title: string): string {
  if (title.length <= 80) return title;
  return `${title.slice(0, 77).trimEnd()}...`;
}

function fillTemplate(template: string, values: Record<string, string>): string {
  let content = template;
  for (const [key, value] of Object.entries(values)) {
    content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return content.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function assertCleanRenderedText(kind: string, content: string): void {
  if (/\{\{[^}]+\}\}/.test(content)) {
    throw new Error(`${kind} text still contains template placeholders`);
  }
  if (/\bn\/a\b/i.test(content)) {
    throw new Error(`${kind} text contains n/a placeholder output`);
  }
  if (EMOJI_PATTERN.test(content)) {
    throw new Error(`${kind} text contains emoji characters`);
  }
}

function imageReferenceFor(mode: LinkedInImageMode, distributionDirectory: string): string {
  if (mode === 'generate' || mode === 'required') {
    return `Image: ./assets/${LINKEDIN_IMAGE_FILENAME}`;
  }
  if (mode === 'prompt-only') {
    return `Image prompt: ./${distributionDirectory}/linkedin-image-prompt.md`;
  }
  return 'Image: none';
}

export function renderLinkedInText(
  template: string,
  metadata: SocialMetadata,
  config: BlogConfig,
  imageMode: LinkedInImageMode,
): string {
  const description = extractLeadSentence(metadata.description, 220);
  const updateLine = metadata.updateCycle
    ? `Update cycle ${metadata.updateCycle.cycleNumber}: ${metadata.updateCycle.summary ?? '(no update summary provided)'}`
    : 'Built as a durable distribution kit for launch review and reuse.';
  const content = fillTemplate(template, {
    title: metadata.title,
    description,
    shipped_summary: updateLine,
    canonical_url: metadata.canonicalUrl,
    image_reference: imageReferenceFor(
      imageMode,
      config.social.distribution_kit?.directory ?? 'distribution',
    ),
    alt_text:
      `${metadata.title} visual for ${metadata.project ?? 'a local technical publishing workflow'} in a real workspace.`,
    hashtags: hashtags(metadata.tags),
    takeaway: description,
    timing: config.social.timing_recommendations
      ? 'Best posting times: Tuesday-Thursday, 8-10am local time.'
      : '',
  });
  assertCleanRenderedText('LinkedIn', content);
  if (content.includes('Key takeaway: m0lz.')) {
    throw new Error('LinkedIn text contains broken product-ID sentence fragment');
  }
  return content;
}

export function renderHackerNewsText(template: string, metadata: SocialMetadata, config: BlogConfig): string {
  const rawTitle = metadata.contentType === 'project-launch'
    ? `Show HN: ${metadata.title}`
    : metadata.title;
  const title = truncateHackerNewsTitle(rawTitle);
  const companionLine = metadata.companionRepo
    ? `Companion repo: ${metadata.companionRepo}`
    : '';
  const updateContext = metadata.updateCycle
    ? `Update: ${metadata.updateCycle.summary ?? '(no update summary provided)'}`
    : '';
  const firstComment = [
    extractLeadSentence(metadata.description, 260),
    updateContext,
    companionLine,
  ].filter((line) => line.trim().length > 0).join('\n\n');
  const content = fillTemplate(template, {
    title,
    canonical_url: metadata.canonicalUrl,
    first_comment: firstComment,
    companion_repo_line: companionLine,
    repo_url: metadata.companionRepo ?? '',
    hashtags: '',
    timing: config.social.timing_recommendations
      ? 'Timing: weekday morning US time tends to get the cleanest technical review window.'
      : '',
  });
  assertCleanRenderedText('Hacker News', content);
  const companionMatches = content.match(/^Companion repo:/gm) ?? [];
  if (companionMatches.length > 1) {
    throw new Error('Hacker News text contains duplicate Companion repo lines');
  }
  const titleMatch = content.match(/^Title:\s+(.+)$/m);
  if (titleMatch && titleMatch[1].length > 80) {
    throw new Error('Hacker News title exceeds 80 characters');
  }
  return content;
}

function renderPrompt(template: string, metadata: SocialMetadata, config: BlogConfig): string {
  const content = fillTemplate(template, {
    title: metadata.title,
    description: extractLeadSentence(metadata.description, 220),
    canonical_url: metadata.canonicalUrl,
    project: metadata.project ?? 'local publishing system',
    size: config.social.linkedin_image.size,
  });
  const lower = content.toLowerCase();
  for (const term of REQUIRED_PROMPT_TERMS) {
    if (!lower.includes(term.toLowerCase())) {
      throw new Error(`LinkedIn image prompt missing required term: ${term}`);
    }
  }
  for (const term of BANNED_PROMPT_TERMS) {
    if (lower.includes(term.toLowerCase())) {
      throw new Error(`LinkedIn image prompt contains banned term: ${term}`);
    }
  }
  return content;
}

function imageConfigWithOverride(
  config: BlogConfig,
  imageMode?: LinkedInImageMode,
): LinkedInImageConfig {
  return {
    ...config.social.linkedin_image,
    mode: imageMode ?? config.social.linkedin_image.mode,
  };
}

function computeInputHash(input: unknown): string {
  return sha256(stableJson(input));
}

function readManifest(path: string): DistributionKitManifest | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as DistributionKitManifest;
  } catch {
    return null;
  }
}

function artifactMatches(baseDir: string, entry: ArtifactManifestEntry | null): boolean {
  if (!entry) return true;
  const path = join(baseDir, entry.path);
  return existsSync(path) && sha256(readFileSync(path)) === entry.sha256;
}

function assertManifestPath(
  slug: string,
  entry: ArtifactManifestEntry,
  expectedPath: string,
  label: string,
): void {
  if (entry.path !== expectedPath) {
    throw new Error(
      `Distribution kit ${label} artifact path mismatch for '${slug}': ` +
      `manifest points to '${entry.path}' but expected '${expectedPath}'`,
    );
  }
}

function verifiedArtifactPath(
  slug: string,
  baseDir: string,
  entry: ArtifactManifestEntry,
  label: string,
): string {
  const path = join(baseDir, entry.path);
  if (!existsSync(path)) {
    throw new Error(`Distribution kit ${label} artifact is missing for '${slug}'`);
  }
  const actual = sha256(readFileSync(path));
  if (actual !== entry.sha256) {
    throw new Error(
      `Distribution kit ${label} artifact hash mismatch for '${slug}': ` +
      `manifest has ${entry.sha256} but file has ${actual}`,
    );
  }
  return path;
}

function manifestStillValid(
  manifest: DistributionKitManifest,
  inputHash: string,
  kitDir: string,
  draftAssetsDir: string,
): boolean {
  if (manifest.input_hash !== inputHash) return false;
  if (!artifactMatches(kitDir, manifest.text.linkedin)) return false;
  if (!artifactMatches(kitDir, manifest.text.hackernews)) return false;
  if (!artifactMatches(kitDir, manifest.prompt)) return false;
  if (manifest.image) {
    const path = join(draftAssetsDir, LINKEDIN_IMAGE_FILENAME);
    if (!existsSync(path)) return false;
    if (sha256(readFileSync(path)) !== manifest.image.sha256) return false;
  }
  return true;
}

function assertImagePreflight(imageConfig: LinkedInImageConfig, provider: ImageProvider | undefined): void {
  if (imageConfig.mode === 'off' || imageConfig.mode === 'prompt-only') return;
  if (provider) return;
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.trim().length === 0) {
    throw new Error('OPENAI_API_KEY is required for LinkedIn image generation');
  }
}

async function writeGeneratedImage(
  imageConfig: LinkedInImageConfig,
  prompt: string,
  outputPath: string,
  provider: ImageProvider | undefined,
): Promise<ImageManifestEntry> {
  const selectedProvider = provider ?? new OpenAIImageProvider();
  const response = await selectedProvider.generateImage({
    model: imageConfig.model,
    prompt,
    size: imageConfig.size,
    quality: imageConfig.quality,
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, response.bytes);
  const metadata = await sharp(response.bytes).metadata();
  const stats = statSync(outputPath);
  return {
    path: `assets/${LINKEDIN_IMAGE_FILENAME}`,
    sha256: sha256(response.bytes),
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    bytes: stats.size,
  };
}

export async function generateDistributionKit(
  slug: string,
  config: BlogConfig,
  paths: DistributionKitPaths,
  db: Database.Database,
  options: GenerateDistributionKitOptions,
): Promise<GenerateDistributionKitResult> {
  if (config.social.distribution_kit.enabled === false) {
    throw new Error('Distribution kit generation is disabled in config (social.distribution_kit.enabled=false)');
  }

  const imageConfig = imageConfigWithOverride(config, options.imageMode);
  assertImagePreflight(imageConfig, options.provider);

  const kitDir = join(paths.socialDir, slug);
  const draftAssetsDir = join(paths.draftsDir, slug, 'assets');
  const linkedinPath = join(kitDir, 'linkedin.md');
  const hackerNewsPath = join(kitDir, 'hackernews.md');
  const promptPath = imageConfig.mode === 'off' ? null : join(kitDir, 'linkedin-image-prompt.md');
  const imagePath =
    imageConfig.mode === 'generate' || imageConfig.mode === 'required'
      ? join(draftAssetsDir, LINKEDIN_IMAGE_FILENAME)
      : null;
  const manifestPath = join(kitDir, 'manifest.json');

  const metadata = resolveSocialMetadata(slug, config, paths, db, options.sourceMode);
  const linkedinTemplate = readFileSync(join(paths.templatesDir, 'social', 'linkedin.md'), 'utf-8');
  const hackerNewsTemplate = readFileSync(join(paths.templatesDir, 'social', 'hackernews.md'), 'utf-8');
  const promptTemplatePath = join(paths.templatesDir, 'social', 'linkedin-image-prompt.md');
  const promptTemplate = imageConfig.mode === 'off' ? '' : readFileSync(promptTemplatePath, 'utf-8');
  const prompt = imageConfig.mode === 'off' ? null : renderPrompt(promptTemplate, metadata, config);
  const inputHash = computeInputHash({
    metadata,
    linkedinTemplateHash: sha256(linkedinTemplate),
    hackerNewsTemplateHash: sha256(hackerNewsTemplate),
    promptTemplateHash: sha256(promptTemplate),
    imageConfig,
    sourceMode: options.sourceMode,
  });

  const existing = readManifest(manifestPath);
  if (!options.force && existing && manifestStillValid(existing, inputHash, kitDir, draftAssetsDir)) {
    return {
      slug,
      directory: kitDir,
      linkedinPath,
      hackerNewsPath,
      promptPath,
      imagePath,
      manifestPath,
      manifest: existing,
      reused: true,
    };
  }

  mkdirSync(kitDir, { recursive: true });
  mkdirSync(draftAssetsDir, { recursive: true });

  const linkedin = renderLinkedInText(linkedinTemplate, metadata, config, imageConfig.mode);
  const hackerNews = renderHackerNewsText(hackerNewsTemplate, metadata, config);
  writeFileSync(linkedinPath, linkedin, 'utf-8');
  writeFileSync(hackerNewsPath, hackerNews, 'utf-8');
  if (promptPath && prompt) {
    writeFileSync(promptPath, prompt, 'utf-8');
  }

  let image: ImageManifestEntry | null = null;
  if (imagePath && prompt) {
    image = await writeGeneratedImage(imageConfig, prompt, imagePath, options.provider);
  }

  const manifest: DistributionKitManifest = {
    slug,
    canonical_url: metadata.canonicalUrl,
    source_mode: options.sourceMode,
    input_hash: inputHash,
    generated_at: new Date().toISOString(),
    platforms: config.social.platforms,
    text: {
      linkedin: {
        path: 'linkedin.md',
        sha256: sha256(readFileSync(linkedinPath)),
      },
      hackernews: {
        path: 'hackernews.md',
        sha256: sha256(readFileSync(hackerNewsPath)),
      },
    },
    prompt: promptPath
      ? {
          path: 'linkedin-image-prompt.md',
          sha256: sha256(readFileSync(promptPath)),
        }
      : null,
    image,
    image_provider: 'openai',
    image_model: imageConfig.model,
    image_size: imageConfig.size,
    image_quality: imageConfig.quality,
    image_format: LINKEDIN_IMAGE_FORMAT,
    image_mode: imageConfig.mode,
    reused: false,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  return {
    slug,
    directory: kitDir,
    linkedinPath,
    hackerNewsPath,
    promptPath,
    imagePath,
    manifestPath,
    manifest,
    reused: false,
  };
}

export function loadDistributionKit(
  slug: string,
  paths: Pick<DistributionKitPaths, 'socialDir' | 'draftsDir'>,
): GenerateDistributionKitResult {
  const kitDir = join(paths.socialDir, slug);
  const manifestPath = join(kitDir, 'manifest.json');
  const manifest = readManifest(manifestPath);
  if (!manifest) {
    throw new Error(
      `Distribution kit missing for '${slug}'. Rerun publish/update from the site step or run ` +
      `'blog publish distribution-kit ${slug}'.`,
    );
  }
  assertManifestPath(slug, manifest.text.linkedin, 'linkedin.md', 'LinkedIn text');
  assertManifestPath(slug, manifest.text.hackernews, 'hackernews.md', 'Hacker News text');
  const linkedinPath = verifiedArtifactPath(slug, kitDir, manifest.text.linkedin, 'LinkedIn text');
  const hackerNewsPath = verifiedArtifactPath(slug, kitDir, manifest.text.hackernews, 'Hacker News text');
  if (manifest.prompt) {
    assertManifestPath(slug, manifest.prompt, 'linkedin-image-prompt.md', 'prompt');
  }
  const promptPath = manifest.prompt
    ? verifiedArtifactPath(slug, kitDir, manifest.prompt, 'prompt')
    : null;
  if (manifest.image) {
    assertManifestPath(slug, manifest.image, `assets/${LINKEDIN_IMAGE_FILENAME}`, 'image');
  }
  const imagePath = manifest.image
    ? verifiedArtifactPath(slug, join(paths.draftsDir, slug), manifest.image, 'image')
    : null;
  return {
    slug,
    directory: kitDir,
    linkedinPath,
    hackerNewsPath,
    promptPath,
    imagePath,
    manifestPath,
    manifest,
    reused: true,
  };
}
