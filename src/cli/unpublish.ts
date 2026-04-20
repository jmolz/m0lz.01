import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Command } from 'commander';

import { getDatabase, closeDatabase } from '../core/db/database.js';
import { loadConfig } from '../core/config/loader.js';
import { printEnvelope } from '../core/json-envelope.js';
import { validateSlug } from '../core/research/document.js';
import { getOpenUpdateCycle } from '../core/update/cycles.js';
import { initUnpublish } from '../core/unpublish/state.js';
import { runUnpublishPipeline } from '../core/unpublish/runner.js';
import { listUnpublishSteps } from '../core/unpublish/steps-crud.js';

// Phase 7: `blog unpublish start <slug> --confirm` and `blog unpublish
// show <slug>`. start is gated on --confirm to prevent accidental
// rollbacks; show is informational.

const DB_PATH = resolve('.blog-agent/state.db');
const CONFIG_PATH = resolve('.blogrc.yaml');
const SOCIAL_DIR = resolve('.blog-agent/social');
const PUBLISH_DIR = resolve('.blog-agent/publish');

export interface UnpublishCliPaths {
  dbPath?: string;
  configPath?: string;
  socialDir?: string;
  publishDir?: string;
  json?: boolean;
}

export interface UnpublishStartOptions {
  confirm: boolean;
}

function requireDb(dbPath: string): void {
  if (!existsSync(dbPath)) {
    console.error("No state database found. Run 'blog init' first.");
    process.exit(1);
  }
}

function requireConfig(configPath: string): void {
  if (!existsSync(configPath)) {
    console.error(`Config not found: ${configPath}. Run 'blog init' first.`);
    process.exit(1);
  }
}

export async function runUnpublishStart(
  slug: string,
  opts: UnpublishStartOptions,
  paths: UnpublishCliPaths = {},
): Promise<void> {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  if (!opts.confirm) {
    console.error(
      `'blog unpublish start' requires --confirm. This is an irreversible operation ` +
      `(canonical URL is reserved forever; slug cannot be reused after unpublish). ` +
      `Re-run with --confirm to proceed.`,
    );
    process.exitCode = 1;
    return;
  }

  const dbPath = paths.dbPath ?? DB_PATH;
  const configPath = paths.configPath ?? CONFIG_PATH;
  const socialDir = paths.socialDir ?? SOCIAL_DIR;
  const publishDir = paths.publishDir ?? PUBLISH_DIR;
  requireDb(dbPath);
  requireConfig(configPath);

  let config;
  try {
    config = loadConfig(configPath);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const db = getDatabase(dbPath);
  try {
    const openCycle = getOpenUpdateCycle(db, slug);
    if (openCycle) {
      console.error(
        `Cannot unpublish '${slug}' — an update cycle is open (id=${openCycle.id}). ` +
        `Run 'blog update abort ${slug}' first.`,
      );
      process.exitCode = 1;
      return;
    }

    let initResult;
    try {
      initResult = initUnpublish(db, slug, config!);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    if (initResult.alreadyUnpublished) {
      console.log(`'${slug}' is already unpublished. Nothing to do.`);
      return;
    }

    let result;
    try {
      result = await runUnpublishPipeline({
        db,
        slug,
        config: config!,
        paths: {
          configPath,
          publishDir,
          socialDir,
        },
      });
    } catch (e) {
      console.error(`Unpublish pipeline crashed: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }

    if (result.completed) {
      console.log(`Unpublish complete: '${slug}' is now unpublished.`);
    } else if (result.pausedStep) {
      console.log(
        `Unpublish paused at step: ${result.pausedStep}. ` +
        `Merge the revert PR in the site repo, then re-run 'blog unpublish start ${slug} --confirm'.`,
      );
    } else if (result.failedStep) {
      console.error(
        `Unpublish paused at failed step: ${result.failedStep}. ` +
        `Fix the issue and re-run 'blog unpublish start ${slug} --confirm'.`,
      );
      process.exitCode = 1;
    } else {
      console.error(`Unpublish did not complete for '${slug}'.`);
      process.exitCode = 1;
    }
  } finally {
    closeDatabase(db);
  }
}

export function runUnpublishShow(
  slug: string,
  paths: UnpublishCliPaths = {},
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
    const post = db
      .prepare('SELECT slug, phase, title, unpublished_at FROM posts WHERE slug = ?')
      .get(slug) as
      | { slug: string; phase: string; title: string | null; unpublished_at: string | null }
      | undefined;
    if (!post) {
      console.error(`Post not found: ${slug}`);
      process.exitCode = 1;
      return;
    }
    const steps = listUnpublishSteps(db, slug);
    if (paths.json) {
      const completedStep = [...steps].reverse().find((s) => s.status === 'completed');
      printEnvelope<'UnpublishPipeline', {
        slug: string;
        phase: string;
        title: string | null;
        unpublished_at: string | null;
        completed_at: string | null;
        steps: Array<{
          step_number: number;
          step_name: string;
          status: string;
          error_message: string | null;
        }>;
      }>('UnpublishPipeline', {
        slug: post.slug,
        phase: post.phase,
        title: post.title,
        unpublished_at: post.unpublished_at,
        completed_at: completedStep?.completed_at ?? null,
        steps: steps.map((s) => ({
          step_number: s.step_number,
          step_name: s.step_name,
          status: s.status,
          error_message: s.error_message ?? null,
        })),
      });
      return;
    }
    console.log(`slug:            ${post.slug}`);
    console.log(`phase:           ${post.phase}`);
    console.log(`title:           ${post.title ?? '(none)'}`);
    console.log(`unpublished_at:  ${post.unpublished_at ?? '-'}`);
    console.log('');

    if (steps.length === 0) {
      console.log(
        `No unpublish steps recorded. Run 'blog unpublish start ${slug} --confirm' to begin.`,
      );
      return;
    }
    console.log('unpublish steps:');
    for (const s of steps) {
      console.log(
        `  ${s.step_number}. ${s.step_name.padEnd(22)} ${s.status}` +
        (s.error_message ? `  -- ${s.error_message}` : ''),
      );
    }
  } finally {
    closeDatabase(db);
  }
}

export function registerUnpublish(program: Command): void {
  const unpublish = program
    .command('unpublish')
    .description('Unpublish a previously-published post (PR-gated rollback)');

  unpublish
    .command('start <slug>')
    .description('Start the unpublish pipeline (requires --confirm)')
    .option('--confirm', 'Explicit confirmation flag (required, no default)')
    .action(async (slug: string, opts: { confirm?: boolean }) => {
      await runUnpublishStart(slug, { confirm: opts.confirm === true });
    });

  unpublish
    .command('show <slug>')
    .description('Show unpublish pipeline status for a post')
    .option('--json', 'Emit JSON envelope for machine consumers')
    .action((slug: string, opts: { json?: boolean }) => {
      runUnpublishShow(slug, { json: opts.json });
    });
}
