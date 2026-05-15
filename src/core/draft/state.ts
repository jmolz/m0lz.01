import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { PostRow, AssetType, AssetRow, ContentType } from '../db/types.js';
import { BlogConfig } from '../config/types.js';
import { advancePhase } from '../research/state.js';
import { generateFrontmatter, parseFrontmatter, serializeFrontmatter, validateFrontmatter, PostFrontmatter } from './frontmatter.js';
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

function benchmarkRepairHint(slug: string): string {
  return (
    `Repair with 'blog benchmark repair ${slug} --results-file <file>' or, for optional project-launch benchmarks, ` +
    `'blog benchmark repair ${slug} --skip-optional --reason "..."'.`
  );
}

export function validateDraftBenchmarkEvidence(
  post: PostRow,
  slug: string,
  benchmarkDir: string,
): string[] {
  if (!post.has_benchmarks) {
    return [];
  }
  const benchmarkCtx = getBenchmarkContext(benchmarkDir, slug, {
    githubUser: 'unknown',
  });
  if (!benchmarkCtx.resultsError) {
    return [];
  }
  return [
    `Invalid benchmark results for '${slug}': ${benchmarkCtx.resultsError}. ${benchmarkRepairHint(slug)}`,
  ];
}

export function initDraft(
  db: Database.Database,
  slug: string,
  draftsDir: string,
  benchmarkDir: string,
  researchDir: string,
  config: BlogConfig,
  configPath: string,
): { draftPath: string; frontmatter: PostFrontmatter } {
  const post = getDraftPost(db, slug);
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }

  const benchmarkErrors = validateDraftBenchmarkEvidence(post, slug, benchmarkDir);
  if (benchmarkErrors.length > 0) {
    throw new Error(benchmarkErrors[0]);
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

  const frontmatter = generateFrontmatter(post, config, configPath);

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
  benchmarkDir: string,
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
  errors.push(...validateDraftBenchmarkEvidence(post, slug, benchmarkDir));

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

// Anchored frontmatter-split regex — mirrors `parseFrontmatter` so a
// thematic break `---` in the body cannot corrupt the split. Matches
// the leading `---\n<yaml>\n---\n?` block; everything after is body
// that must be preserved byte-for-byte when rewriting.
const FRONTMATTER_SPLIT_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/;

export interface RegenerateFrontmatterResult {
  // Absolute path of the MDX file that was rewritten.
  draftPath: string;
  // SHA256 of the frontmatter block (between the two `---` delimiters)
  // BEFORE the rewrite. Lets operators verify the receipt against the
  // original file if they kept a backup.
  previousHash: string;
  // SHA256 of the frontmatter block AFTER the rewrite.
  newHash: string;
  // Field names whose values changed. Empty array when the rewrite was
  // a no-op (e.g., already current) — receipt still written for audit.
  fieldsChanged: string[];
  // Absolute path of the audit-log JSON receipt file written beside the
  // draft: `.blog-agent/drafts/<slug>/.frontmatter-regenerated.json`.
  receiptPath: string;
}

export interface RegenerateFrontmatterOptions {
  // Optional recovery input for dogfood failures where an existing
  // project-launch row reached draft/evaluate/publish with project_id=NULL.
  // When supplied, this updates posts.project_id before deriving frontmatter.
  projectId?: string;
}

// v0.3 dogfood-hardening: rewrites the frontmatter block of
// `.blog-agent/drafts/<slug>/index.mdx` in place from the current
// (post, config) pair, preserving the body byte-for-byte. Does NOT
// touch the site repo — the site-repo copy must be fixed separately
// via the PR branch (or by re-running the publish pipeline if not yet
// merged). Rejects phase=published because the canonical MDX for a
// published post lives in the site repo and should be updated there,
// not here.
export function regenerateDraftFrontmatter(
  db: Database.Database,
  slug: string,
  draftsDir: string,
  config: BlogConfig,
  configPath: string,
  options: RegenerateFrontmatterOptions = {},
): RegenerateFrontmatterResult {
  let post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }
  if (post.phase === 'published') {
    throw new Error(
      `Post '${slug}' is in phase 'published'. Frontmatter lives in the site repo at ` +
      `{content_dir}/${slug}/index.mdx; update it there on a branch, not in the local draft.`,
    );
  }

  const projectIdBefore = post.project_id;
  let projectIdOverride: string | undefined;
  if (options.projectId !== undefined) {
    const nextProjectId = options.projectId.trim();
    if (nextProjectId.length === 0) {
      throw new Error('Project ID cannot be empty.');
    }
    projectIdOverride = nextProjectId;
  }

  if (post.content_type === 'project-launch' && !post.project_id && !projectIdOverride) {
    throw new Error(
      `[AGENT_ERROR] PROJECT_UNLINKED: project-launch post '${slug}' has no project_id. ` +
      `Re-run with 'blog draft regenerate-frontmatter ${slug} --project <id>' so ` +
      `companion_repo can be resolved from .blogrc.yaml projects.`,
    );
  }

  const mdxPath = draftPath(draftsDir, slug);
  if (!existsSync(mdxPath)) {
    throw new Error(`Draft MDX not found: ${mdxPath}. Run 'blog draft init ${slug}' first.`);
  }

  const original = readFileSync(mdxPath, 'utf-8');
  const match = original.match(FRONTMATTER_SPLIT_RE);
  if (!match) {
    throw new Error(
      `Draft MDX at ${mdxPath} has no frontmatter delimiters. ` +
      `Expected leading '---\\n<yaml>\\n---'.`,
    );
  }
  const body = original.slice(match[0].length);

  const previousFm = parseFrontmatter(original);
  const previousHash = createHash('sha256').update(match[1]).digest('hex');

  if (projectIdOverride !== undefined && post.project_id !== projectIdOverride) {
    db.prepare(
      'UPDATE posts SET project_id = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ?',
    ).run(projectIdOverride, slug);
    post = { ...post, project_id: projectIdOverride };
  }

  // Compose the new frontmatter from current post+config. Preserve every
  // operator-authored value on the existing block (title, description,
  // tags, date, etc.) — we only want to re-apply the fields that
  // generateFrontmatter resolves from post/config state. Otherwise this
  // would overwrite the operator's title every time.
  const derived = generateFrontmatter(post, config, configPath);
  const merged: PostFrontmatter = {
    ...previousFm,
    canonical: derived.canonical ?? previousFm.canonical,
    // companion_repo: re-resolve EVERY time — that's the whole point of
    // this command. If the new resolution is null and the previous was
    // set, keep the previous (no downgrade); if both null, stays null.
    companion_repo: derived.companion_repo ?? previousFm.companion_repo,
    project: derived.project ?? previousFm.project,
  };

  const newFrontmatterBlock = serializeFrontmatter(merged);
  // serializeFrontmatter returns `---\n<yaml>---` (no trailing newline
  // after the closing ---). Reassembling: `<block>\n<body>` preserves
  // the original newline pattern because `body` retains its leading
  // newline(s) from the source file.
  const newContent = newFrontmatterBlock + '\n' + body;
  writeFileSync(mdxPath, newContent, 'utf-8');

  const newMatch = newContent.match(FRONTMATTER_SPLIT_RE);
  const newHash = newMatch
    ? createHash('sha256').update(newMatch[1]).digest('hex')
    : '';

  const fieldsChanged: string[] = [];
  const keys = new Set<string>([
    ...Object.keys(previousFm),
    ...Object.keys(merged),
  ]);
  for (const k of keys) {
    const prev = (previousFm as unknown as Record<string, unknown>)[k];
    const next = (merged as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      fieldsChanged.push(k);
    }
  }

  const receiptPath = join(draftsDir, slug, '.frontmatter-regenerated.json');
  writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        slug,
        previous_hash: previousHash,
        new_hash: newHash,
        fields_changed: fieldsChanged,
        project_id_before: projectIdBefore,
        project_id_after: post.project_id,
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );

  return {
    draftPath: mdxPath,
    previousHash,
    newHash,
    fieldsChanged,
    receiptPath,
  };
}
