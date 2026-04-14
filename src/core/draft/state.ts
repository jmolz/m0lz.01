import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { PostRow, AssetType, AssetRow, ContentType } from '../db/types.js';
import { BlogConfig } from '../config/types.js';
import { advancePhase } from '../research/state.js';
import { generateFrontmatter, parseFrontmatter, validateFrontmatter, PostFrontmatter } from './frontmatter.js';
import { renderDraftTemplate, DraftContext } from './template.js';
import { getBenchmarkContext } from './benchmark-data.js';
import { readExistingTags } from './tags.js';
import { readResearchDocument } from '../research/document.js';
import { documentPath } from '../research/document.js';

// Any TODO-flavored marker the template or skill emits counts as an
// unfilled section. Kept permissive so new placeholder variants still trip
// validation instead of silently passing.
export const PLACEHOLDER_PATTERN = /\{\/\*\s*TODO[:\s].*?\*\/\}/gi;

export function getDraftPost(db: Database.Database, slug: string): PostRow | undefined {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
  if (post && post.phase !== 'draft') {
    throw new Error(
      `Post '${slug}' is in phase '${post.phase}', not 'draft'. ` +
      `Draft commands only operate on posts in the draft phase.`,
    );
  }
  return post;
}

export function draftPath(draftsDir: string, slug: string): string {
  return join(draftsDir, slug, 'index.mdx');
}

export function initDraft(
  db: Database.Database,
  slug: string,
  draftsDir: string,
  benchmarkDir: string,
  researchDir: string,
  config: BlogConfig,
): { draftPath: string; frontmatter: PostFrontmatter } {
  const post = getDraftPost(db, slug);
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }

  const draftDir = join(draftsDir, slug);
  const assetsDir = join(draftDir, 'assets');
  const mdxPath = draftPath(draftsDir, slug);

  // Idempotent: if draft file already exists, return existing
  if (existsSync(mdxPath)) {
    const existing = parseFrontmatter(readFileSync(mdxPath, 'utf-8'));
    return { draftPath: mdxPath, frontmatter: existing };
  }

  mkdirSync(assetsDir, { recursive: true });

  const frontmatter = generateFrontmatter(post, config);

  // Build draft context from research and benchmark data
  const contentType = (post.content_type ?? 'technical-deep-dive') as ContentType;
  let researchThesis: string | undefined;
  let researchFindings: string | undefined;

  const docPath = documentPath(researchDir, slug);
  if (existsSync(docPath)) {
    const doc = readResearchDocument(docPath);
    researchThesis = doc.thesis || undefined;
    researchFindings = doc.findings || undefined;
  }

  const benchmarkCtx = getBenchmarkContext(benchmarkDir, slug, {
    githubUser: config.author.github,
  });
  const existingTags = readExistingTags(config.site.repo_path, config.site.content_dir);

  const context: DraftContext = {
    contentType,
    benchmarkTable: benchmarkCtx.table !== '(no benchmark data)' ? benchmarkCtx.table : undefined,
    methodologyRef: benchmarkCtx.methodologyRef || undefined,
    researchThesis,
    researchFindings,
    existingTags,
  };

  const mdxContent = renderDraftTemplate(frontmatter, context);
  writeFileSync(mdxPath, mdxContent, 'utf-8');

  return { draftPath: mdxPath, frontmatter };
}

export function completeDraft(
  db: Database.Database,
  slug: string,
  draftsDir: string,
): void {
  const post = getDraftPost(db, slug);
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }

  const mdxPath = draftPath(draftsDir, slug);
  if (!existsSync(mdxPath)) {
    throw new Error(`Draft file not found: ${mdxPath}`);
  }

  const content = readFileSync(mdxPath, 'utf-8');
  const fm = parseFrontmatter(content);
  const validation = validateFrontmatter(fm);
  const errors = [...validation.errors];

  // Check for placeholder sections
  const placeholderCount = (content.match(PLACEHOLDER_PATTERN) || []).length;
  if (placeholderCount > 0) {
    errors.push(`Placeholder sections remaining: ${placeholderCount}`);
  }

  // Check registered assets exist on disk
  const assets = listAssets(db, slug);
  for (const asset of assets) {
    const assetPath = join(draftsDir, slug, 'assets', asset.filename);
    if (!existsSync(assetPath)) {
      errors.push(`Missing asset file: ${asset.filename}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Draft validation failed:\n${errors.join('\n')}`);
  }

  advancePhase(db, slug, 'evaluate');
}

export function registerAsset(
  db: Database.Database,
  slug: string,
  assetType: AssetType,
  filename: string,
): void {
  const upsert = db.transaction(() => {
    const existing = db.prepare(
      'SELECT id FROM assets WHERE post_slug = ? AND filename = ?',
    ).get(slug, filename);
    if (existing) {
      return;
    }
    db.prepare(
      'INSERT INTO assets (post_slug, type, filename) VALUES (?, ?, ?)',
    ).run(slug, assetType, filename);
  });
  upsert();
}

export function listAssets(db: Database.Database, slug: string): AssetRow[] {
  return db.prepare(
    'SELECT * FROM assets WHERE post_slug = ? ORDER BY id ASC',
  ).all(slug) as AssetRow[];
}
