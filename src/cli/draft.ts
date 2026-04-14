import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { Command } from 'commander';

import { getDatabase, closeDatabase } from '../core/db/database.js';
import { AssetType } from '../core/db/types.js';
import { loadConfig } from '../core/config/loader.js';
import { validateSlug } from '../core/research/document.js';
import {
  getDraftPost,
  initDraft,
  completeDraft,
  registerAsset,
  listAssets,
  draftPath,
  PLACEHOLDER_PATTERN,
} from '../core/draft/state.js';
import { parseFrontmatter, validateFrontmatter } from '../core/draft/frontmatter.js';
import { getBenchmarkContext } from '../core/draft/benchmark-data.js';
import { readExistingTags } from '../core/draft/tags.js';

const DB_PATH = resolve('.blog-agent', 'state.db');
const DRAFTS_DIR = resolve('.blog-agent', 'drafts');
const BENCHMARK_DIR = resolve('.blog-agent', 'benchmarks');
const RESEARCH_DIR = resolve('.blog-agent', 'research');
const CONFIG_PATH = resolve('.blogrc.yaml');

export interface DraftPaths {
  dbPath?: string;
  draftsDir?: string;
  benchmarkDir?: string;
  researchDir?: string;
  configPath?: string;
}

function requireDb(dbPath: string): void {
  if (!existsSync(dbPath)) {
    console.error("No state database found. Run 'blog init' first.");
    process.exit(1);
  }
}

export function runDraftInit(slug: string, paths: DraftPaths = {}): void {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  const dbPath = paths.dbPath ?? DB_PATH;
  const draftsDir = paths.draftsDir ?? DRAFTS_DIR;
  const benchmarkDir = paths.benchmarkDir ?? BENCHMARK_DIR;
  const researchDir = paths.researchDir ?? RESEARCH_DIR;
  const configPath = paths.configPath ?? CONFIG_PATH;
  requireDb(dbPath);

  if (!existsSync(configPath)) {
    console.error(`Config not found: ${configPath}. Run 'blog init' first.`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(configPath);
  const db = getDatabase(dbPath);
  try {
    let result: { draftPath: string; frontmatter: import('../core/draft/frontmatter.js').PostFrontmatter };
    try {
      result = initDraft(db, slug, draftsDir, benchmarkDir, researchDir, config);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }

    console.log(`Draft initialized for ${slug}`);
    console.log(`Draft path: ${result.draftPath}`);
    console.log(`Title: ${result.frontmatter.title}`);
    console.log(`Canonical: ${result.frontmatter.canonical ?? '(none)'}`);
    if (result.frontmatter.companion_repo) {
      console.log(`Companion repo: ${result.frontmatter.companion_repo}`);
    }
    if (result.frontmatter.project) {
      console.log(`Project: ${result.frontmatter.project}`);
    }
  } finally {
    closeDatabase(db);
  }
}

export function runDraftShow(slug: string, paths: DraftPaths = {}): void {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  const dbPath = paths.dbPath ?? DB_PATH;
  const draftsDir = paths.draftsDir ?? DRAFTS_DIR;
  const benchmarkDir = paths.benchmarkDir ?? BENCHMARK_DIR;
  const configPath = paths.configPath ?? CONFIG_PATH;
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    let post;
    try {
      post = getDraftPost(db, slug);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    if (!post) {
      console.error(`Post not found: ${slug}`);
      process.exitCode = 1;
      return;
    }

    const mdxPath = draftPath(draftsDir, slug);
    const hasDraft = existsSync(mdxPath);

    let fmValid = false;
    if (hasDraft) {
      const content = readFileSync(mdxPath, 'utf-8');
      const fm = parseFrontmatter(content);
      const validation = validateFrontmatter(fm);
      fmValid = validation.ok;
    }

    const assets = listAssets(db, slug);

    // Best-effort config read: a malformed .blogrc.yaml shouldn't abort `show`.
    let existingTags: string[] = [];
    let githubUser = 'unknown';
    if (existsSync(configPath)) {
      try {
        const config = loadConfig(configPath);
        existingTags = readExistingTags(config.site.repo_path, config.site.content_dir);
        githubUser = config.author.github;
      } catch (e) {
        console.error(`Warning: failed to read config (${(e as Error).message}). Tags unavailable.`);
      }
    }

    const benchmarkCtx = getBenchmarkContext(benchmarkDir, slug, { githubUser });

    console.log(`slug:            ${post.slug}`);
    console.log(`phase:           ${post.phase}`);
    console.log(`content_type:    ${post.content_type ?? 'unknown'}`);
    console.log(`draft_file:      ${hasDraft ? mdxPath : '(not created)'}`);
    console.log(`frontmatter:     ${hasDraft ? (fmValid ? 'valid' : 'invalid') : '(no draft)'}`);
    console.log(`assets:          ${assets.length}`);
    console.log(`benchmark_data:  ${benchmarkCtx.results ? 'available' : 'none'}`);
    if (existingTags.length > 0) {
      console.log(`existing_tags:   ${existingTags.join(', ')}`);
    }
  } finally {
    closeDatabase(db);
  }
}

export function runDraftValidate(slug: string, paths: DraftPaths = {}): void {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  const dbPath = paths.dbPath ?? DB_PATH;
  const draftsDir = paths.draftsDir ?? DRAFTS_DIR;
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    let post;
    try {
      post = getDraftPost(db, slug);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    if (!post) {
      console.error(`Post not found: ${slug}`);
      process.exitCode = 1;
      return;
    }

    const mdxPath = draftPath(draftsDir, slug);
    if (!existsSync(mdxPath)) {
      console.error(`Draft file not found: ${mdxPath}. Run 'blog draft init ${slug}' first.`);
      process.exitCode = 1;
      return;
    }

    const content = readFileSync(mdxPath, 'utf-8');
    const fm = parseFrontmatter(content);
    const validation = validateFrontmatter(fm);

    // Check for placeholder sections
    const placeholderCount = (content.match(PLACEHOLDER_PATTERN) || []).length;

    // Check registered assets exist
    const assets = listAssets(db, slug);
    const missingAssets: string[] = [];
    for (const asset of assets) {
      const assetPath = resolve(draftsDir, slug, 'assets', asset.filename);
      if (!existsSync(assetPath)) {
        missingAssets.push(asset.filename);
      }
    }

    const allOk = validation.ok && placeholderCount === 0 && missingAssets.length === 0;

    if (validation.ok) {
      console.log('Frontmatter: valid');
    } else {
      console.error('Frontmatter errors:');
      for (const err of validation.errors) {
        console.error(`  - ${err}`);
      }
    }

    if (placeholderCount > 0) {
      console.error(`Placeholder sections remaining: ${placeholderCount}`);
    } else {
      console.log('Sections: all filled');
    }

    if (missingAssets.length > 0) {
      console.error('Missing asset files:');
      for (const f of missingAssets) {
        console.error(`  - ${f}`);
      }
    } else if (assets.length > 0) {
      console.log(`Assets: ${assets.length} registered, all present`);
    }

    if (allOk) {
      console.log('Validation: PASS');
    } else {
      console.error('Validation: FAIL');
      process.exitCode = 1;
    }
  } finally {
    closeDatabase(db);
  }
}

export function runDraftAddAsset(
  slug: string,
  opts: { file: string; type: string },
  paths: DraftPaths = {},
): void {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  const validTypes: AssetType[] = ['excalidraw', 'chart', 'image', 'benchmark_viz'];
  if (!validTypes.includes(opts.type as AssetType)) {
    console.error(`Invalid asset type: '${opts.type}'. Valid types: ${validTypes.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  // Reject path traversal in filenames
  if (opts.file !== basename(opts.file) || opts.file.includes('..')) {
    console.error(`Invalid asset filename: '${opts.file}'. Must be a plain filename without path separators.`);
    process.exitCode = 1;
    return;
  }

  const dbPath = paths.dbPath ?? DB_PATH;
  const draftsDir = paths.draftsDir ?? DRAFTS_DIR;
  requireDb(dbPath);

  const assetPath = resolve(draftsDir, slug, 'assets', opts.file);
  if (!existsSync(assetPath)) {
    console.error(`Asset file not found: ${assetPath}`);
    process.exitCode = 1;
    return;
  }

  const db = getDatabase(dbPath);
  try {
    let post;
    try {
      post = getDraftPost(db, slug);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    if (!post) {
      console.error(`Post not found: ${slug}`);
      process.exitCode = 1;
      return;
    }

    registerAsset(db, slug, opts.type as AssetType, opts.file);
    console.log(`Asset registered: ${opts.file} (${opts.type})`);
  } finally {
    closeDatabase(db);
  }
}

export function runDraftComplete(slug: string, paths: DraftPaths = {}): void {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  const dbPath = paths.dbPath ?? DB_PATH;
  const draftsDir = paths.draftsDir ?? DRAFTS_DIR;
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    try {
      completeDraft(db, slug, draftsDir);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    console.log(`Draft completed for ${slug}. Phase advanced to evaluate.`);
  } finally {
    closeDatabase(db);
  }
}

export function registerDraft(program: Command): void {
  const draft = program.command('draft').description('Draft phase operations');

  draft
    .command('init <slug>')
    .description('Initialize draft workspace with template MDX and auto-populated frontmatter')
    .action((slug: string) => {
      runDraftInit(slug);
    });

  draft
    .command('show <slug>')
    .description('Show draft state: frontmatter validity, assets, benchmark data')
    .action((slug: string) => {
      runDraftShow(slug);
    });

  draft
    .command('validate <slug>')
    .description('Validate draft: frontmatter, sections, asset files')
    .action((slug: string) => {
      runDraftValidate(slug);
    });

  draft
    .command('add-asset <slug>')
    .description('Register an asset file for the draft')
    .requiredOption('--file <filename>', 'Asset filename (relative to assets directory)')
    .requiredOption('--type <type>', 'Asset type: excalidraw, chart, image, benchmark_viz')
    .action((slug: string, opts: { file: string; type: string }) => {
      runDraftAddAsset(slug, opts);
    });

  draft
    .command('complete <slug>')
    .description('Validate draft and advance to evaluate phase')
    .action((slug: string) => {
      runDraftComplete(slug);
    });
}
