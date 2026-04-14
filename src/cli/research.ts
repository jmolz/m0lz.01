import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Command } from 'commander';

import { getDatabase, closeDatabase } from '../core/db/database.js';
import { Mode, ContentType, SourceType } from '../core/db/types.js';
import { loadConfig } from '../core/config/loader.js';
import { detectContentType } from '../core/draft/content-types.js';
import {
  ResearchDocument,
  writeResearchDocument,
  validateResearchDocument,
  validateSlug,
  documentPath,
} from '../core/research/document.js';
import { addSource, countSources } from '../core/research/sources.js';
import { initResearchPost, getResearchPost } from '../core/research/state.js';

const DB_PATH = resolve('.blog-agent', 'state.db');
const RESEARCH_DIR = resolve('.blog-agent', 'research');
const CONFIG_PATH = resolve('.blogrc.yaml');

interface ResearchPaths {
  dbPath?: string;
  researchDir?: string;
  configPath?: string;
}

interface InitOptions {
  topic: string;
  mode?: Mode;
  contentType?: ContentType;
  force?: boolean;
}

interface AddSourceOptions {
  url: string;
  title?: string;
  excerpt?: string;
  type?: SourceType;
}

function requireDb(dbPath: string): void {
  if (!existsSync(dbPath)) {
    console.error("No state database found. Run 'blog init' first.");
    process.exit(1);
  }
}

export function runResearchInit(
  slug: string,
  opts: InitOptions,
  paths: ResearchPaths = {},
): void {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }
  const dbPath = paths.dbPath ?? DB_PATH;
  const researchDir = paths.researchDir ?? RESEARCH_DIR;
  requireDb(dbPath);

  const mode: Mode = opts.mode ?? 'exploratory';
  const contentType: ContentType = opts.contentType ?? detectContentType(opts.topic);

  const db = getDatabase(dbPath);
  try {
    let result: { created: boolean; post: import('../core/db/types.js').PostRow };
    try {
      result = initResearchPost(db, slug, opts.topic, mode, contentType);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    console.log(result.created
      ? `Created research entry for ${slug}`
      : `Entry already exists for ${slug} -- continuing`);

    const post = result.post;
    const doc: ResearchDocument = {
      slug: post.slug,
      topic: post.topic ?? opts.topic,
      mode: post.mode,
      content_type: post.content_type ?? contentType,
      created_at: result.created ? new Date().toISOString() : post.created_at,
      thesis: '{{thesis}}',
      findings: '{{findings}}',
      sources_list: '{{sources_list}}',
      data_points: '{{data_points}}',
      open_questions: '{{open_questions}}',
      benchmark_targets: '{{benchmark_targets}}',
      repo_scope: '{{repo_scope}}',
    };

    try {
      const written = writeResearchDocument(researchDir, doc, { force: opts.force ?? false });
      console.log(`Research document: ${written}`);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
    }
  } finally {
    closeDatabase(db);
  }
}

export function runResearchAddSource(
  slug: string,
  opts: AddSourceOptions,
  paths: ResearchPaths = {},
): void {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }
  const dbPath = paths.dbPath ?? DB_PATH;
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    const result = addSource(db, slug, opts.url, {
      title: opts.title,
      excerpt: opts.excerpt,
      sourceType: opts.type,
    });
    console.log(result.inserted
      ? `Added source (id=${result.id})`
      : `Source already tracked (id=${result.id})`);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

export function runResearchShow(slug: string, paths: ResearchPaths = {}): void {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }
  const dbPath = paths.dbPath ?? DB_PATH;
  const researchDir = paths.researchDir ?? RESEARCH_DIR;
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    let post;
    try {
      post = getResearchPost(db, slug);
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

    const count = countSources(db, slug);
    const docPath = documentPath(researchDir, slug);
    const docExists = existsSync(docPath);

    console.log(`slug:         ${post.slug}`);
    console.log(`phase:        ${post.phase}`);
    console.log(`mode:         ${post.mode}`);
    console.log(`content_type: ${post.content_type ?? '(unset)'}`);
    console.log(`sources:      ${count}`);
    console.log(`doc path:     ${docPath}`);

    if (docExists) {
      const result = validateResearchDocument(docPath);
      if (result.ok) {
        console.log(`doc status:   ok (all sections filled)`);
      } else {
        const parts: string[] = [];
        if (result.missing.length > 0) parts.push(`${result.missing.length} missing`);
        if (result.empty.length > 0) parts.push(`${result.empty.length} empty`);
        console.log(`doc status:   ${parts.join(', ')}`);
      }
    } else {
      console.log(`doc status:   not written yet`);
    }
  } finally {
    closeDatabase(db);
  }
}

export function runResearchFinalize(slug: string, paths: ResearchPaths = {}): void {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }
  const dbPath = paths.dbPath ?? DB_PATH;
  const researchDir = paths.researchDir ?? RESEARCH_DIR;
  const configPath = paths.configPath ?? CONFIG_PATH;
  requireDb(dbPath);

  if (!existsSync(configPath)) {
    console.error(`Config not found: ${configPath}. Run 'blog init' first.`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(configPath);
  const minSources = config.evaluation.min_sources;

  const db = getDatabase(dbPath);
  try {
    let post;
    try {
      post = getResearchPost(db, slug);
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

    const count = countSources(db, slug);
    if (count < minSources) {
      console.error(`Only ${count} sources (min ${minSources} required)`);
      process.exitCode = 1;
      return;
    }

    const docPath = documentPath(researchDir, slug);
    if (!existsSync(docPath)) {
      console.error(`Research document not written yet: ${docPath}`);
      process.exitCode = 1;
      return;
    }

    const result = validateResearchDocument(docPath);
    if (!result.ok) {
      if (result.missing.length > 0) {
        console.error(`Missing sections: ${result.missing.join(', ')}`);
      }
      if (result.empty.length > 0) {
        console.error(`Empty sections: ${result.empty.join(', ')}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log(`Research phase ready for ${slug}. ${count} sources, doc validated.`);
  } finally {
    closeDatabase(db);
  }
}

export function registerResearch(program: Command): void {
  const research = program.command('research').description('Research phase operations');

  research
    .command('init <slug>')
    .description('Create a research entry and template document')
    .requiredOption('--topic <topic>', 'Topic or prompt for the research')
    .option('--mode <mode>', 'Research mode: directed or exploratory', 'exploratory')
    .option('--content-type <type>', 'Content type (auto-detected if omitted)')
    .option('--force', 'Overwrite existing research document')
    .action((slug: string, opts: { topic: string; mode: string; contentType?: string; force?: boolean }) => {
      runResearchInit(slug, {
        topic: opts.topic,
        mode: opts.mode as Mode,
        contentType: opts.contentType as ContentType | undefined,
        force: opts.force,
      });
    });

  research
    .command('add-source <slug>')
    .description('Track a source URL for the research doc')
    .requiredOption('--url <url>', 'Source URL')
    .option('--title <title>', 'Source title')
    .option('--excerpt <excerpt>', 'Why this source matters (claim supported or datum)')
    .option('--type <type>', 'Source type: external, benchmark, primary', 'external')
    .action((slug: string, opts: { url: string; title?: string; excerpt?: string; type?: string }) => {
      runResearchAddSource(slug, {
        url: opts.url,
        title: opts.title,
        excerpt: opts.excerpt,
        type: opts.type as SourceType | undefined,
      });
    });

  research
    .command('show <slug>')
    .description('Show research state for a slug')
    .action((slug: string) => {
      runResearchShow(slug);
    });

  research
    .command('finalize <slug>')
    .description('Validate the research doc is ready for the benchmark phase')
    .action((slug: string) => {
      runResearchFinalize(slug);
    });
}
