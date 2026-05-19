import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import Database from 'better-sqlite3';
import sharp from 'sharp';

import { BlogConfig, LinkedInImageConfig, LinkedInImageMode } from '../config/types.js';
import { ContentType, PostRow, UpdateCycleRow } from '../db/types.js';
import { parseFrontmatter, PostFrontmatter } from '../draft/frontmatter.js';
import { getOpenUpdateCycle } from '../update/cycles.js';
import { renderMediumPaste, writeMediumPaste, writeMediumUploadChecklist } from './medium.js';
import { ImageProvider, OpenAIImageProvider } from './openai-image.js';
import {
  fitNaturalCopy,
  hasAbruptEllipsis,
  LINKEDIN_BODY_MAX_CHARS,
  LINKEDIN_POST_MAX_CHARS,
  normalizePlatformCopy,
} from './platform-copy.js';
import {
  LINKEDIN_LOCAL_CARD_TEMPLATE_VERSION,
  renderLinkedInLocalCardImageBuffer,
  writeLinkedInLocalCardImage,
} from './platform-images.js';
import { renderSubstackPaste, writeSubstackPaste, writeSubstackUploadChecklist } from './substack.js';
import { PortableTableAsset, PortableTableSource, writePortableTableAssets } from './table-assets.js';

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

export interface TableImageManifestEntry extends ImageManifestEntry {
  alt: string;
  source_hash: string;
  row_count: number;
  column_count: number;
}

export interface DistributionKitManifest {
  slug: string;
  canonical_url: string;
  source_mode: DistributionKitSourceMode;
  input_hash: string;
  generated_at: string;
  platforms: string[];
  text: {
    linkedin: ArtifactManifestEntry | null;
    hackernews: ArtifactManifestEntry | null;
    medium: ArtifactManifestEntry | null;
    medium_upload_checklist: ArtifactManifestEntry | null;
    substack: ArtifactManifestEntry | null;
    substack_upload_checklist: ArtifactManifestEntry | null;
  };
  prompt: ArtifactManifestEntry | null;
  image: ImageManifestEntry | null;
  tables: TableImageManifestEntry[];
  image_provider: 'local-card' | 'openai' | null;
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
  linkedinPath: string | null;
  hackerNewsPath: string | null;
  mediumPath: string | null;
  mediumUploadChecklistPath: string | null;
  substackPath: string | null;
  substackUploadChecklistPath: string | null;
  promptPath: string | null;
  imagePath: string | null;
  tableImagePaths: string[];
  manifestPath: string;
  manifest: DistributionKitManifest;
  reused: boolean;
}

const REQUIRED_PROMPT_TERMS = ['architecture', 'layered', 'product', 'editorial'];

const BANNED_PROMPT_TERMS = [
  'AI glow',
  'robot',
  'orb',
  'bokeh',
  'corporate handshake',
  'desk',
  'notes',
  'terminal windows',
  'laptop',
  'workspace scene',
  'fake UI text',
  'unreadable text',
];
const PROMPT_CONTEXT_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/\bAI glow\b/gi, 'high contrast'],
  [/\brobot\b/gi, 'system'],
  [/\borb\b/gi, 'node'],
  [/\bbokeh\b/gi, 'depth'],
  [/\bcorporate handshake\b/gi, 'collaboration'],
  [/desk/gi, 'surface'],
  [/notes/gi, 'evidence'],
  [/terminal windows/gi, 'command layers'],
  [/laptop/gi, 'device'],
  [/workspace scene/gi, 'architecture view'],
  [/\bfake UI text\b/gi, 'abstract interface marks'],
  [/unreadable text/gi, 'abstract labels'],
];

const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const TEXT_ARTIFACT_PATH_BY_ROLE = {
  linkedin: 'linkedin.md',
  hackernews: 'hackernews.md',
  medium: 'medium-paste.md',
  mediumChecklist: 'medium-upload-checklist.md',
  substack: 'substack-paste.md',
  substackChecklist: 'substack-upload-checklist.md',
  prompt: 'linkedin-image-prompt.md',
} as const;
const TEXT_ARTIFACT_PATHS: ReadonlySet<string> = new Set(Object.values(TEXT_ARTIFACT_PATH_BY_ROLE));

const DEFAULT_LINKEDIN_IMAGE_CONFIG: LinkedInImageConfig = {
  mode: 'local-card',
  model: 'gpt-image-2-2026-04-21',
  size: '1200x1200',
  quality: 'high',
};

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

export function distributionDirectory(config: BlogConfig): string {
  return config.social?.distribution_kit?.directory ?? 'distribution';
}

function socialArtifactsEnabled(config: BlogConfig): boolean {
  return config.social ? config.social.distribution_kit?.enabled !== false : false;
}

function mediumEnabled(config: BlogConfig): boolean {
  return config.publish ? config.publish.medium !== false : false;
}

function substackEnabled(config: BlogConfig): boolean {
  return config.publish ? config.publish.substack !== false : false;
}

export function shouldGeneratePublicationBundle(config: BlogConfig): boolean {
  return socialArtifactsEnabled(config) ||
    mediumEnabled(config) ||
    substackEnabled(config);
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
  const trimmed = normalizePlatformCopy(description);
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
      break;
    }
  }
  if (trimmed.length <= maxLen) return trimmed;
  throw new Error(
    `Lead sentence could not be fit within ${maxLen} characters without clipping. ` +
    'Shorten the draft frontmatter description, then re-run draft/evaluate before publishing.',
  );
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

function assertNoAbruptEllipsis(kind: string, content: string): void {
  if (hasAbruptEllipsis(content)) {
    throw new Error(`${kind} text contains abrupt ellipsis clipping`);
  }
}

function fallbackCopyFor(metadata: SocialMetadata): string {
  const title = normalizePlatformCopy(metadata.title);
  const prefix = metadata.contentType === 'project-launch' ? 'Launch notes' : 'Technical notes';
  return `${prefix} and evidence for ${title}.`;
}

function fallbackPromptCopyFor(metadata: SocialMetadata): string {
  const title = normalizePlatformCopy(metadata.title);
  const prefix = metadata.contentType === 'project-launch' ? 'Launch evidence' : 'Technical evidence';
  return `${prefix} for ${title}.`;
}

function sanitizePromptContext(value: string): string {
  let sanitized = normalizePlatformCopy(value);
  for (const [pattern, replacement] of PROMPT_CONTEXT_REPLACEMENTS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

function renderLinkedInBody(metadata: SocialMetadata, config: BlogConfig): string {
  const timing = config.social.timing_recommendations
    ? 'Best posting times: Tuesday-Thursday, 8-10am local time.'
    : '';
  const values = (body: string): Record<string, string> => ({
    hook: metadata.title,
    body,
    canonical_url: sanitizePromptContext(metadata.canonicalUrl),
    hashtags: hashtags(metadata.tags),
    timing,
  });
  const fullBody = normalizePlatformCopy(metadata.description);
  const template = [
    '{{hook}}',
    '',
    '{{body}}',
    '',
    'Read the full post: {{canonical_url}}',
    '',
    '{{hashtags}}',
    '',
    '{{timing}}',
  ].join('\n');
  const fullContent = fillTemplate(template, values(fullBody));
  if (fullContent.length <= LINKEDIN_POST_MAX_CHARS && !hasAbruptEllipsis(fullBody)) return fullBody;
  return fitNaturalCopy(
    fullBody,
    LINKEDIN_BODY_MAX_CHARS,
    'LinkedIn body',
    fallbackCopyFor(metadata),
  );
}

export function renderLinkedInText(
  template: string,
  metadata: SocialMetadata,
  config: BlogConfig,
  _imageMode: LinkedInImageMode,
): string {
  const body = renderLinkedInBody(metadata, config);
  const timing = config.social.timing_recommendations
    ? 'Best posting times: Tuesday-Thursday, 8-10am local time.'
    : '';
  const content = fillTemplate(template, {
    hook: metadata.title,
    body,
    canonical_url: metadata.canonicalUrl,
    hashtags: hashtags(metadata.tags),
    timing,
  });
  assertCleanRenderedText('LinkedIn', content);
  assertNoAbruptEllipsis('LinkedIn', content);
  for (const internal of ['Image prompt:', 'Alt text:', './distribution/', './assets/', 'durable distribution kit']) {
    if (content.includes(internal)) {
      throw new Error(`LinkedIn text contains internal artifact label: ${internal}`);
    }
  }
  if (content.length > LINKEDIN_POST_MAX_CHARS) {
    throw new Error(`LinkedIn text exceeds ${LINKEDIN_POST_MAX_CHARS} characters`);
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
  const description = fitNaturalCopy(
    metadata.description,
    260,
    'Hacker News first comment',
    fallbackCopyFor(metadata),
  );
  const firstComment = [
    description,
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
  if (description.endsWith('...')) {
    throw new Error('Hacker News first comment contains abrupt description ellipsis');
  }
  return content;
}

function renderPrompt(template: string, metadata: SocialMetadata, config: BlogConfig): string {
  const description = fitNaturalCopy(
    metadata.description,
    220,
    'LinkedIn image prompt context',
    fallbackPromptCopyFor(metadata),
  );
	const content = fillTemplate(template, {
		title: sanitizePromptContext(metadata.title),
		description: sanitizePromptContext(description),
		canonical_url: sanitizePromptContext(metadata.canonicalUrl),
		project: sanitizePromptContext(metadata.project ?? 'local publishing system'),
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
    ...DEFAULT_LINKEDIN_IMAGE_CONFIG,
    ...(config.social?.linkedin_image ?? {}),
    mode: imageMode ?? config.social?.linkedin_image?.mode ?? DEFAULT_LINKEDIN_IMAGE_CONFIG.mode,
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

function artifactMatches(baseDir: string, entry: ArtifactManifestEntry | null | undefined): boolean {
  if (!entry) return true;
  const path = join(baseDir, entry.path);
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  return !stat.isSymbolicLink() && stat.isFile() && sha256(readFileSync(path)) === entry.sha256;
}

function entryMatchesExpectedHash(
  entry: ArtifactManifestEntry | null | undefined,
  expectedHash: string | null | undefined,
): boolean {
  if (expectedHash === undefined) return true;
  if (expectedHash === null) return entry === null || entry === undefined;
  return entry?.sha256 === expectedHash;
}

interface ExpectedArtifactHashes {
  linkedin: string | null;
  hackernews: string | null;
  medium: string | null;
  mediumUploadChecklist: string | null;
  substack: string | null;
  substackUploadChecklist: string | null;
  prompt: string | null;
  image?: string | null;
}

function assertSafeTextManifestPath(
  slug: string,
  entry: ArtifactManifestEntry,
  label: string,
  expectedPath: string,
): void {
  if (!TEXT_ARTIFACT_PATHS.has(entry.path)) {
    throw new Error(
      `Distribution kit ${label} artifact path mismatch for '${slug}': ` +
      `manifest points to unsafe or non-allowlisted path '${entry.path}'`,
    );
  }
  if (entry.path !== expectedPath) {
    throw new Error(
      `Distribution kit ${label} artifact path mismatch for '${slug}': ` +
      `manifest points to '${entry.path}' but expected '${expectedPath}'`,
    );
  }
}

function assertUniqueTextManifestPath(
  slug: string,
  seen: Set<string>,
  entry: ArtifactManifestEntry,
  label: string,
): void {
  if (seen.has(entry.path)) {
    throw new Error(
      `Distribution kit ${label} artifact path mismatch for '${slug}': ` +
      `manifest reuses text artifact path '${entry.path}'`,
    );
  }
  seen.add(entry.path);
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
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Distribution kit ${label} artifact path is not a regular file for '${slug}'`);
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

function assertTableManifestPath(slug: string, entry: ArtifactManifestEntry, label: string): void {
  if (!/^assets\/portable-table-[0-9a-f]{12}\.png$/.test(entry.path)) {
    throw new Error(
      `Distribution kit ${label} artifact path mismatch for '${slug}': ` +
      `manifest points to unsafe or non-allowlisted path '${entry.path}'`,
    );
  }
}

function manifestStillValid(
  slug: string,
  manifest: DistributionKitManifest,
  inputHash: string,
  kitDir: string,
  expected: ExpectedArtifactHashes,
): boolean {
  if (manifest.input_hash !== inputHash) return false;
  if (manifest.text.medium === undefined || manifest.text.substack === undefined) return false;
  if (
    manifest.text.medium_upload_checklist === undefined ||
    manifest.text.substack_upload_checklist === undefined
  ) {
    return false;
  }
  const textEntries: Array<[ArtifactManifestEntry | null, string, string]> = [
    [manifest.text.linkedin, 'LinkedIn text', TEXT_ARTIFACT_PATH_BY_ROLE.linkedin],
    [manifest.text.hackernews, 'Hacker News text', TEXT_ARTIFACT_PATH_BY_ROLE.hackernews],
    [manifest.text.medium, 'Medium paste', TEXT_ARTIFACT_PATH_BY_ROLE.medium],
    [
      manifest.text.medium_upload_checklist,
      'Medium upload checklist',
      TEXT_ARTIFACT_PATH_BY_ROLE.mediumChecklist,
    ],
    [manifest.text.substack, 'Substack paste', TEXT_ARTIFACT_PATH_BY_ROLE.substack],
    [
      manifest.text.substack_upload_checklist,
      'Substack upload checklist',
      TEXT_ARTIFACT_PATH_BY_ROLE.substackChecklist,
    ],
    [manifest.prompt, 'prompt', TEXT_ARTIFACT_PATH_BY_ROLE.prompt],
  ];
  const seenTextPaths = new Set<string>();
  for (const [entry, label, expectedPath] of textEntries) {
    if (!entry) continue;
    try {
      assertSafeTextManifestPath(slug, entry, label, expectedPath);
      assertUniqueTextManifestPath(slug, seenTextPaths, entry, label);
    } catch {
      return false;
    }
  }
  if (!entryMatchesExpectedHash(manifest.text.linkedin, expected.linkedin)) return false;
  if (!entryMatchesExpectedHash(manifest.text.hackernews, expected.hackernews)) return false;
  if (!entryMatchesExpectedHash(manifest.text.medium, expected.medium)) return false;
  if (!entryMatchesExpectedHash(manifest.text.medium_upload_checklist, expected.mediumUploadChecklist)) return false;
  if (!entryMatchesExpectedHash(manifest.text.substack, expected.substack)) return false;
  if (!entryMatchesExpectedHash(manifest.text.substack_upload_checklist, expected.substackUploadChecklist)) return false;
  if (!entryMatchesExpectedHash(manifest.prompt, expected.prompt)) return false;
  if (!entryMatchesExpectedHash(manifest.image, expected.image)) return false;
  if (!artifactMatches(kitDir, manifest.text.linkedin)) return false;
  if (!artifactMatches(kitDir, manifest.text.hackernews)) return false;
  if (!artifactMatches(kitDir, manifest.text.medium)) return false;
  if (!artifactMatches(kitDir, manifest.text.medium_upload_checklist)) return false;
  if (!artifactMatches(kitDir, manifest.text.substack)) return false;
  if (!artifactMatches(kitDir, manifest.text.substack_upload_checklist)) return false;
  if (!artifactMatches(kitDir, manifest.prompt)) return false;
  if (!Array.isArray(manifest.tables)) return false;
  if (manifest.image) {
    if (manifest.image.path !== `assets/${LINKEDIN_IMAGE_FILENAME}`) return false;
    if (!artifactMatches(kitDir, manifest.image)) return false;
  }
  for (const [index, table] of manifest.tables.entries()) {
    try {
      assertTableManifestPath(slug, table, `table ${index + 1}`);
    } catch {
      return false;
    }
    if (!artifactMatches(kitDir, table)) return false;
  }
  return true;
}

function resolveBundleMdxSource(
  slug: string,
  config: BlogConfig,
  paths: DistributionKitPaths,
  db: Database.Database,
  sourceMode: DistributionKitSourceMode,
): { path: string; mdx: string } {
  const draftPath = join(paths.draftsDir, slug, 'index.mdx');
  if (sourceMode === 'publish' || sourceMode === 'update') {
    if (!existsSync(draftPath)) {
      throw new Error(`Draft MDX not found for '${slug}': ${draftPath}`);
    }
    return { path: draftPath, mdx: readFileSync(draftPath, 'utf-8') };
  }

  const siteRepoPath = resolveSiteRepoPath(paths.configPath, config.site.repo_path);
  const hubPath = join(siteRepoPath, config.site.content_dir, slug, 'index.mdx');
  if (existsSync(hubPath)) {
    return { path: hubPath, mdx: readFileSync(hubPath, 'utf-8') };
  }

  const post = db.prepare('SELECT phase FROM posts WHERE slug = ?').get(slug) as { phase: string } | undefined;
  if (post?.phase !== 'published' && existsSync(draftPath)) {
    return { path: draftPath, mdx: readFileSync(draftPath, 'utf-8') };
  }
  throw new Error(
    `Hub-site MDX not found for published-post backfill '${slug}': ${hubPath}. ` +
    `Run the site publish step first or restore content/posts/${slug}/index.mdx.`,
  );
}

function mergeTables(...sets: PortableTableSource[][]): { tables: PortableTableSource[]; hashes: string[] } {
  const byPath = new Map<string, PortableTableSource>();
  for (const set of sets) {
    for (const table of set) {
      byPath.set(table.path, table);
    }
  }
  const tables = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { tables, hashes: tables.map((table) => table.source_hash) };
}

function assertImagePreflight(imageConfig: LinkedInImageConfig, provider: ImageProvider | undefined): void {
  if (
    imageConfig.mode === 'off' ||
    imageConfig.mode === 'prompt-only' ||
    imageConfig.mode === 'local-card'
  ) return;
  if (provider) return;
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.trim().length === 0) {
    throw new Error('OPENAI_API_KEY is required for LinkedIn image generation');
  }
}

async function writeLocalCardImage(
  config: BlogConfig,
  metadata: SocialMetadata,
  outputPath: string,
  imageBytes?: Buffer,
): Promise<ImageManifestEntry> {
  mkdirSync(dirname(outputPath), { recursive: true });
  await writeLinkedInLocalCardImage(localCardInput(config, metadata), outputPath, imageBytes);
  const bytes = readFileSync(outputPath);
  const imageMetadata = await sharp(bytes).metadata();
  const stats = statSync(outputPath);
  return {
    path: `assets/${LINKEDIN_IMAGE_FILENAME}`,
    sha256: sha256(bytes),
    width: imageMetadata.width ?? 0,
    height: imageMetadata.height ?? 0,
    bytes: stats.size,
  };
}

function localCardInput(config: BlogConfig, metadata: SocialMetadata) {
  return {
    title: metadata.title,
    project: metadata.project,
    tags: metadata.tags,
    baseUrl: config.site.base_url,
  };
}

function imageConfigForInputHash(imageConfig: LinkedInImageConfig): LinkedInImageConfig {
  if (imageConfig.mode !== 'required') return imageConfig;
  return {
    ...imageConfig,
    mode: 'generate',
  };
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
  if (!shouldGeneratePublicationBundle(config)) {
    throw new Error(
      'Publication bundle generation has no enabled artifacts: social distribution, Medium, and Substack are disabled',
    );
  }

  const includeSocial = socialArtifactsEnabled(config);
  const includeMedium = mediumEnabled(config);
  const includeSubstack = substackEnabled(config);
  const imageConfig = imageConfigWithOverride(config, options.imageMode);

  const kitDir = join(paths.socialDir, slug);
  const tableAssetsDir = join(kitDir, 'assets');
  const linkedinPath = join(kitDir, 'linkedin.md');
  const hackerNewsPath = join(kitDir, 'hackernews.md');
  const mediumPath = includeMedium ? join(kitDir, 'medium-paste.md') : null;
  const mediumUploadChecklistPath = includeMedium ? join(kitDir, 'medium-upload-checklist.md') : null;
  const substackPath = includeSubstack ? join(kitDir, 'substack-paste.md') : null;
  const substackUploadChecklistPath = includeSubstack ? join(kitDir, 'substack-upload-checklist.md') : null;
  const promptPath =
    includeSocial && (imageConfig.mode === 'prompt-only' || imageConfig.mode === 'generate' || imageConfig.mode === 'required')
      ? join(kitDir, 'linkedin-image-prompt.md')
      : null;
  const imagePath =
    includeSocial && (imageConfig.mode === 'local-card' || imageConfig.mode === 'generate' || imageConfig.mode === 'required')
      ? join(tableAssetsDir, LINKEDIN_IMAGE_FILENAME)
      : null;
  const manifestPath = join(kitDir, 'manifest.json');

  const metadata = resolveSocialMetadata(slug, config, paths, db, options.sourceMode);
  const source = resolveBundleMdxSource(slug, config, paths, db, options.sourceMode);
  const medium = includeMedium ? renderMediumPaste(slug, config, source.mdx) : null;
  const substack = includeSubstack ? renderSubstackPaste(slug, config, source.mdx) : null;
  const mergedTables = mergeTables(medium?.tables ?? [], substack?.tables ?? []);

  const linkedinTemplate = includeSocial
    ? readFileSync(join(paths.templatesDir, 'social', 'linkedin.md'), 'utf-8')
    : '';
  const hackerNewsTemplate = includeSocial
    ? readFileSync(join(paths.templatesDir, 'social', 'hackernews.md'), 'utf-8')
    : '';
  const promptTemplatePath = join(paths.templatesDir, 'social', 'linkedin-image-prompt.md');
  const promptTemplate = promptPath ? readFileSync(promptTemplatePath, 'utf-8') : '';
  const prompt = promptPath ? renderPrompt(promptTemplate, metadata, config) : null;
  const linkedin = includeSocial
    ? renderLinkedInText(linkedinTemplate, metadata, config, imageConfig.mode)
    : null;
  const hackerNews = includeSocial
    ? renderHackerNewsText(hackerNewsTemplate, metadata, config)
    : null;
  const localCardBytes = includeSocial && imageConfig.mode === 'local-card'
    ? await renderLinkedInLocalCardImageBuffer(localCardInput(config, metadata))
    : null;
  const expectedArtifactHashes: ExpectedArtifactHashes = {
    linkedin: linkedin ? sha256(linkedin) : null,
    hackernews: hackerNews ? sha256(hackerNews) : null,
    medium: medium ? sha256(medium.content) : null,
    mediumUploadChecklist: medium ? sha256(medium.uploadChecklist) : null,
    substack: substack ? sha256(substack.content) : null,
    substackUploadChecklist: substack ? sha256(substack.uploadChecklist) : null,
    prompt: prompt ? sha256(prompt) : null,
    image: imageConfig.mode === 'local-card' && localCardBytes ? sha256(localCardBytes) : undefined,
  };
  const inputHash = computeInputHash({
    metadata,
    sourcePath: source.path,
    sourceMode: options.sourceMode,
    sourceHash: sha256(source.mdx),
    linkedinTemplateHash: sha256(linkedinTemplate),
    hackerNewsTemplateHash: sha256(hackerNewsTemplate),
    promptTemplateHash: sha256(promptTemplate),
    mediumPasteHash: medium ? sha256(medium.content) : null,
    mediumUploadChecklistHash: medium ? sha256(medium.uploadChecklist) : null,
    substackPasteHash: substack ? sha256(substack.content) : null,
    substackUploadChecklistHash: substack ? sha256(substack.uploadChecklist) : null,
    tableSourceHashes: mergedTables.hashes,
    localCardTemplateVersion: imageConfig.mode === 'local-card'
      ? LINKEDIN_LOCAL_CARD_TEMPLATE_VERSION
      : null,
    publish: {
      medium: includeMedium,
      substack: includeSubstack,
    },
    socialDistributionEnabled: includeSocial,
    imageConfig: imageConfigForInputHash(imageConfig),
  });

  const existing = readManifest(manifestPath);
  if (!options.force && existing && manifestStillValid(slug, existing, inputHash, kitDir, expectedArtifactHashes)) {
    return {
      slug,
      directory: kitDir,
      linkedinPath: existing.text.linkedin ? linkedinPath : null,
      hackerNewsPath: existing.text.hackernews ? hackerNewsPath : null,
      mediumPath: existing.text.medium ? mediumPath : null,
      mediumUploadChecklistPath: existing.text.medium_upload_checklist ? mediumUploadChecklistPath : null,
      substackPath: existing.text.substack ? substackPath : null,
      substackUploadChecklistPath: existing.text.substack_upload_checklist ? substackUploadChecklistPath : null,
      promptPath,
      imagePath,
      tableImagePaths: (existing.tables ?? []).map((table) => join(kitDir, table.path)),
      manifestPath,
      manifest: existing,
      reused: true,
    };
  }

  if (includeSocial) {
    assertImagePreflight(imageConfig, options.provider);
  }

  mkdirSync(kitDir, { recursive: true });
  if (imagePath) {
    mkdirSync(tableAssetsDir, { recursive: true });
  }

  if (includeSocial) {
    writeFileSync(linkedinPath, linkedin!, 'utf-8');
    writeFileSync(hackerNewsPath, hackerNews!, 'utf-8');
  }
  if (medium && mediumPath) {
    writeMediumPaste(slug, medium.content, { socialDir: paths.socialDir });
  }
  if (medium && mediumUploadChecklistPath) {
    writeMediumUploadChecklist(slug, medium.uploadChecklist, { socialDir: paths.socialDir });
  }
  if (substack && substackPath) {
    writeSubstackPaste(slug, substack.content, { socialDir: paths.socialDir });
  }
  if (substack && substackUploadChecklistPath) {
    writeSubstackUploadChecklist(slug, substack.uploadChecklist, { socialDir: paths.socialDir });
  }
  if (promptPath && prompt) {
    writeFileSync(promptPath, prompt, 'utf-8');
  }
  if (!promptPath && existsSync(join(kitDir, 'linkedin-image-prompt.md'))) {
    rmSync(join(kitDir, 'linkedin-image-prompt.md'), { force: true });
  }
  const tableAssets = await writePortableTableAssets({ tables: mergedTables.tables }, tableAssetsDir);

  let image: ImageManifestEntry | null = null;
  if (imagePath && imageConfig.mode === 'local-card') {
    image = await writeLocalCardImage(config, metadata, imagePath, localCardBytes ?? undefined);
  } else if (imagePath && prompt) {
    image = await writeGeneratedImage(imageConfig, prompt, imagePath, options.provider);
  }

  const manifest: DistributionKitManifest = {
    slug,
    canonical_url: metadata.canonicalUrl,
    source_mode: options.sourceMode,
    input_hash: inputHash,
    generated_at: new Date().toISOString(),
    platforms: includeSocial ? config.social.platforms : [],
    text: {
      linkedin: includeSocial && linkedin
        ? {
            path: 'linkedin.md',
            sha256: sha256(readFileSync(linkedinPath)),
          }
        : null,
      hackernews: includeSocial && hackerNews
        ? {
            path: 'hackernews.md',
            sha256: sha256(readFileSync(hackerNewsPath)),
          }
        : null,
      medium: mediumPath
        ? {
            path: 'medium-paste.md',
            sha256: sha256(readFileSync(mediumPath)),
          }
        : null,
      medium_upload_checklist: mediumUploadChecklistPath
        ? {
            path: 'medium-upload-checklist.md',
            sha256: sha256(readFileSync(mediumUploadChecklistPath)),
          }
        : null,
      substack: substackPath
        ? {
            path: 'substack-paste.md',
            sha256: sha256(readFileSync(substackPath)),
          }
        : null,
      substack_upload_checklist: substackUploadChecklistPath
        ? {
            path: 'substack-upload-checklist.md',
            sha256: sha256(readFileSync(substackUploadChecklistPath)),
          }
        : null,
    },
    prompt: promptPath
      ? {
          path: 'linkedin-image-prompt.md',
          sha256: sha256(readFileSync(promptPath)),
        }
      : null,
    image,
    tables: tableAssets.map((table): TableImageManifestEntry => ({
      path: table.path,
      sha256: table.sha256,
      width: table.width,
      height: table.height,
      bytes: table.bytes,
      alt: table.alt,
      source_hash: table.source_hash,
      row_count: table.row_count,
      column_count: table.column_count,
    })),
    image_provider:
      imageConfig.mode === 'local-card'
        ? 'local-card'
        : imageConfig.mode === 'generate' || imageConfig.mode === 'required'
          ? 'openai'
          : null,
    image_model: imageConfig.mode === 'local-card'
      ? `local-card-v${LINKEDIN_LOCAL_CARD_TEMPLATE_VERSION}`
      : imageConfig.model,
    image_size: imageConfig.mode === 'local-card' && image
      ? `${image.width}x${image.height}`
      : imageConfig.size,
    image_quality: imageConfig.mode === 'local-card' ? 'deterministic' : imageConfig.quality,
    image_format: LINKEDIN_IMAGE_FORMAT,
    image_mode: imageConfig.mode,
    reused: false,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  return {
    slug,
    directory: kitDir,
    linkedinPath: includeSocial ? linkedinPath : null,
    hackerNewsPath: includeSocial ? hackerNewsPath : null,
    mediumPath,
    mediumUploadChecklistPath,
    substackPath,
    substackUploadChecklistPath,
    promptPath,
    imagePath,
    tableImagePaths: tableAssets.map((table) => join(kitDir, table.path)),
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
  if (manifest.text.medium === undefined || manifest.text.substack === undefined) {
    throw new Error(
      `Distribution kit manifest for '${slug}' predates complete publication bundles. ` +
      `Regenerate it with 'blog publish distribution-kit ${slug}'.`,
    );
  }
  if (
    manifest.text.medium_upload_checklist === undefined ||
    manifest.text.substack_upload_checklist === undefined
  ) {
    throw new Error(
      `Distribution kit manifest for '${slug}' predates platform upload checklists. ` +
      `Regenerate it with 'blog publish distribution-kit ${slug}'.`,
    );
  }
  if (!Array.isArray(manifest.tables)) {
    throw new Error(
      `Distribution kit manifest for '${slug}' is missing table asset provenance. ` +
      `Regenerate it with 'blog publish distribution-kit ${slug}'.`,
    );
  }
  const verifyText = (
    entry: ArtifactManifestEntry | null,
    label: string,
    expectedPath: string,
    seenPaths: Set<string>,
  ): string | null => {
    if (!entry) return null;
    assertSafeTextManifestPath(slug, entry, label, expectedPath);
    assertUniqueTextManifestPath(slug, seenPaths, entry, label);
    return verifiedArtifactPath(slug, kitDir, entry, label);
  };
  const seenTextPaths = new Set<string>();
  const linkedinPath = verifyText(
    manifest.text.linkedin,
    'LinkedIn text',
    TEXT_ARTIFACT_PATH_BY_ROLE.linkedin,
    seenTextPaths,
  );
  const hackerNewsPath = verifyText(
    manifest.text.hackernews,
    'Hacker News text',
    TEXT_ARTIFACT_PATH_BY_ROLE.hackernews,
    seenTextPaths,
  );
  const mediumPath = verifyText(
    manifest.text.medium,
    'Medium paste',
    TEXT_ARTIFACT_PATH_BY_ROLE.medium,
    seenTextPaths,
  );
  const mediumUploadChecklistPath = verifyText(
    manifest.text.medium_upload_checklist,
    'Medium upload checklist',
    TEXT_ARTIFACT_PATH_BY_ROLE.mediumChecklist,
    seenTextPaths,
  );
  const substackPath = verifyText(
    manifest.text.substack,
    'Substack paste',
    TEXT_ARTIFACT_PATH_BY_ROLE.substack,
    seenTextPaths,
  );
  const substackUploadChecklistPath = verifyText(
    manifest.text.substack_upload_checklist,
    'Substack upload checklist',
    TEXT_ARTIFACT_PATH_BY_ROLE.substackChecklist,
    seenTextPaths,
  );
  if (manifest.prompt) {
    assertSafeTextManifestPath(slug, manifest.prompt, 'prompt', TEXT_ARTIFACT_PATH_BY_ROLE.prompt);
    assertUniqueTextManifestPath(slug, seenTextPaths, manifest.prompt, 'prompt');
  }
  const promptPath = manifest.prompt
    ? verifiedArtifactPath(slug, kitDir, manifest.prompt, 'prompt')
    : null;
  if (manifest.image) {
    if (manifest.image.path !== `assets/${LINKEDIN_IMAGE_FILENAME}`) {
      throw new Error(
        `Distribution kit image artifact path mismatch for '${slug}': ` +
        `manifest points to '${manifest.image.path}' but expected 'assets/${LINKEDIN_IMAGE_FILENAME}'`,
      );
    }
  }
  const imagePath = manifest.image
    ? verifiedArtifactPath(slug, kitDir, manifest.image, 'image')
    : null;
  const tableImagePaths = manifest.tables.map((table, index) => {
    assertTableManifestPath(slug, table, `table ${index + 1}`);
    return verifiedArtifactPath(slug, kitDir, table, `table ${index + 1}`);
  });
  return {
    slug,
    directory: kitDir,
    linkedinPath,
    hackerNewsPath,
    mediumPath,
    mediumUploadChecklistPath,
    substackPath,
    substackUploadChecklistPath,
    promptPath,
    imagePath,
    tableImagePaths,
    manifestPath,
    manifest,
    reused: true,
  };
}
