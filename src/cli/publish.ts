import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Command } from 'commander';

import { getDatabase, closeDatabase } from '../core/db/database.js';
import { ContentType } from '../core/db/types.js';
import { loadConfig } from '../core/config/loader.js';
import { validateSlug } from '../core/research/document.js';
import { initPublish } from '../core/publish/phase.js';
import { getPipelineSteps } from '../core/publish/steps-crud.js';
import { runPipeline } from '../core/publish/pipeline-runner.js';
import { PipelineContext } from '../core/publish/pipeline-types.js';
import { PipelineStepRow } from '../core/publish/types.js';

// CLI handlers for the publish phase. Mirrors the pattern in `evaluate.ts`
// and `draft.ts`: `runPublishStart` and `runPublishShow` are exported and
// testable; `registerPublish` wires them into Commander. Every handler
// accepts an optional `PublishCliPaths` override so tests can redirect
// every filesystem path without process.chdir hacks.
//
// The start handler is async because `runPipeline` is async (the
// crosspost-devto step returns a Promise). The show handler stays sync.

const DB_PATH = resolve('.blog-agent/state.db');
const CONFIG_PATH = resolve('.blogrc.yaml');
const DRAFTS_DIR = resolve('.blog-agent/drafts');
const BENCHMARK_DIR = resolve('.blog-agent/benchmarks');
const EVALUATIONS_DIR = resolve('.blog-agent/evaluations');
const RESEARCH_DIR = resolve('.blog-agent/research');
const REPOS_DIR = resolve('.blog-agent/repos');
const SOCIAL_DIR = resolve('.blog-agent/social');
const RESEARCH_PAGES_DIR = resolve('.blog-agent/research-pages');
const PUBLISH_DIR = resolve('.blog-agent/publish');
const TEMPLATES_DIR = resolve('templates');

export interface PublishCliPaths {
  dbPath?: string;
  configPath?: string;
  draftsDir?: string;
  benchmarkDir?: string;
  evaluationsDir?: string;
  researchDir?: string;
  reposDir?: string;
  socialDir?: string;
  researchPagesDir?: string;
  publishDir?: string;
  templatesDir?: string;
}

function requireDb(dbPath: string): void {
  if (!existsSync(dbPath)) {
    console.error("No state database found. Run 'blog init' first.");
    process.exit(1);
  }
}

// Start or resume the publish pipeline for a post. Accepts a slug that must
// pass `validateSlug`; refuses to run without a loadable `.blogrc.yaml`
// (publish is a mutating operation). Dispatches on the post's current
// phase: `evaluate` → promote + seed steps + run; `publish` → resume; any
// other phase → fail with a descriptive error. The inner try/finally
// guarantees `closeDatabase` runs even if the pipeline raises.
export async function runPublishStart(
  slug: string,
  paths: PublishCliPaths = {},
): Promise<void> {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  const dbPath = paths.dbPath ?? DB_PATH;
  const configPath = paths.configPath ?? CONFIG_PATH;
  const draftsDir = paths.draftsDir ?? DRAFTS_DIR;
  const benchmarkDir = paths.benchmarkDir ?? BENCHMARK_DIR;
  const evaluationsDir = paths.evaluationsDir ?? EVALUATIONS_DIR;
  const researchDir = paths.researchDir ?? RESEARCH_DIR;
  const reposDir = paths.reposDir ?? REPOS_DIR;
  const socialDir = paths.socialDir ?? SOCIAL_DIR;
  const researchPagesDir = paths.researchPagesDir ?? RESEARCH_PAGES_DIR;
  const publishDir = paths.publishDir ?? PUBLISH_DIR;
  const templatesDir = paths.templatesDir ?? TEMPLATES_DIR;

  requireDb(dbPath);

  // Publish mutates the site repo, pushes branches, and opens PRs. A
  // missing or malformed config would silently misroute those mutations,
  // so we hard-fail before opening the DB.
  if (!existsSync(configPath)) {
    console.error(`Config not found: ${configPath}. Run 'blog init' first.`);
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig(configPath);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const db = getDatabase(dbPath);
  try {
    const post = db
      .prepare('SELECT phase, content_type FROM posts WHERE slug = ?')
      .get(slug) as { phase: string; content_type: string | null } | undefined;
    if (!post) {
      console.error(`Post not found: ${slug}`);
      process.exitCode = 1;
      return;
    }

    if (post.phase === 'evaluate') {
      if (!post.content_type) {
        console.error(
          `Post '${slug}' has no content_type. Cannot initialize publish pipeline.`,
        );
        process.exitCode = 1;
        return;
      }
      try {
        initPublish(
          db,
          slug,
          post.content_type as ContentType,
          config!,
          publishDir,
        );
      } catch (e) {
        console.error((e as Error).message);
        process.exitCode = 1;
        return;
      }
    } else if (post.phase === 'publish') {
      // Resume: no init needed, the existing pipeline_steps rows drive the
      // runner. Fall through to runPipeline.
    } else {
      console.error(
        `Post '${slug}' is in phase '${post.phase}' — only 'evaluate' (to initialize) ` +
        `or 'publish' (to resume) are valid starting phases for this command.`,
      );
      process.exitCode = 1;
      return;
    }

    const ctx: PipelineContext = {
      db,
      slug,
      config: config!,
      paths: {
        dbPath,
        configPath,
        draftsDir,
        benchmarkDir,
        evaluationsDir,
        researchDir,
        reposDir,
        socialDir,
        researchPagesDir,
        publishDir,
        templatesDir,
      },
      urls: {},
    };

    let result;
    try {
      result = await runPipeline(ctx);
    } catch (e) {
      console.error(`Publish pipeline crashed: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }

    // The runner prints per-step progress and a "Pipeline complete" line
    // on full success. Here we print a short operator-facing summary of
    // what to do next; paused is NOT an error (it's the intentional manual
    // gate at step 4), failed IS an error.
    if (result.completed) {
      console.log(`Publish complete: ${slug} is now published.`);
    } else if (result.pausedStep) {
      console.log(
        `Publish paused at step: ${result.pausedStep}. ` +
        `Re-run 'blog publish start ${slug}' when ready to resume.`,
      );
    } else if (result.failedStep) {
      console.error(
        `Publish paused at failed step: ${result.failedStep}. ` +
        `Fix the underlying issue and re-run 'blog publish start ${slug}'.`,
      );
      process.exitCode = 1;
    } else {
      // Defensive: runner already logged the diagnostic; flag non-zero so
      // an operator doesn't mistake an incomplete state for success.
      console.error(
        `Publish did not complete for '${slug}'. Run 'blog publish show ${slug}' to inspect step status.`,
      );
      process.exitCode = 1;
    }
  } finally {
    closeDatabase(db);
  }
}

// Display the pipeline_steps table for a post. Informational: tolerates a
// malformed `.blogrc.yaml` (logs a warning and continues) because the
// operator is recovering, not mutating. Uses dynamic column widths so
// long step names and timestamps don't overflow.
export function runPublishShow(
  slug: string,
  paths: PublishCliPaths = {},
): void {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  const dbPath = paths.dbPath ?? DB_PATH;
  const configPath = paths.configPath ?? CONFIG_PATH;
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    // Best-effort config: `show` is informational. A malformed config
    // still lets us render post metadata and the step table.
    if (existsSync(configPath)) {
      try {
        loadConfig(configPath);
      } catch (e) {
        console.error(
          `Warning: failed to load config (${(e as Error).message}). Display may be incomplete.`,
        );
      }
    }

    const post = db
      .prepare(
        'SELECT slug, phase, content_type, title, evaluation_passed, published_at FROM posts WHERE slug = ?',
      )
      .get(slug) as
      | {
          slug: string;
          phase: string;
          content_type: string | null;
          title: string | null;
          evaluation_passed: number | null;
          published_at: string | null;
        }
      | undefined;
    if (!post) {
      console.error(`Post not found: ${slug}`);
      process.exitCode = 1;
      return;
    }

    console.log(`slug:               ${post.slug}`);
    console.log(`phase:              ${post.phase}`);
    console.log(`content_type:       ${post.content_type ?? 'unknown'}`);
    console.log(`title:              ${post.title ?? '(none)'}`);
    console.log(`evaluation_passed:  ${post.evaluation_passed === 1 ? 'Yes' : 'No'}`);
    console.log(`published_at:       ${post.published_at ?? '—'}`);
    console.log('');

    const steps = getPipelineSteps(db, slug);
    if (steps.length === 0) {
      console.log(`No pipeline steps yet. Run 'blog publish start ${slug}' to initialize.`);
      return;
    }

    renderStepTable(steps);
  } finally {
    closeDatabase(db);
  }
}

// Render a padded step table. Column widths are computed from the data so
// short step names don't waste horizontal space and long timestamps don't
// overflow. `note` holds the skip reason or error message from
// `pipeline_steps.error_message`.
function renderStepTable(steps: PipelineStepRow[]): void {
  const rows = steps.map((s) => ({
    step: String(s.step_number),
    name: s.step_name,
    status: s.status,
    started: s.started_at ?? '—',
    completed: s.completed_at ?? '—',
    note: s.error_message ?? '',
  }));

  const headers = {
    step: 'Step',
    name: 'Name',
    status: 'Status',
    started: 'Started',
    completed: 'Completed',
    note: 'Note',
  };

  const widths = {
    step: Math.max(headers.step.length, ...rows.map((r) => r.step.length)),
    name: Math.max(headers.name.length, ...rows.map((r) => r.name.length)),
    status: Math.max(headers.status.length, ...rows.map((r) => r.status.length)),
    started: Math.max(headers.started.length, ...rows.map((r) => r.started.length)),
    completed: Math.max(headers.completed.length, ...rows.map((r) => r.completed.length)),
  };

  const headerLine = [
    headers.step.padEnd(widths.step),
    headers.name.padEnd(widths.name),
    headers.status.padEnd(widths.status),
    headers.started.padEnd(widths.started),
    headers.completed.padEnd(widths.completed),
    headers.note,
  ].join('  ');
  console.log(headerLine);

  for (const r of rows) {
    const line = [
      r.step.padEnd(widths.step),
      r.name.padEnd(widths.name),
      r.status.padEnd(widths.status),
      r.started.padEnd(widths.started),
      r.completed.padEnd(widths.completed),
      r.note,
    ].join('  ');
    console.log(line);
  }
}

export function registerPublish(program: Command): void {
  const publish = program
    .command('publish')
    .description('Publish pipeline operations');

  publish
    .command('start <slug>')
    .description('Start or resume the publish pipeline for a post')
    .action(async (slug: string) => {
      await runPublishStart(slug);
    });

  publish
    .command('show <slug>')
    .description('Show publish pipeline step status for a post')
    .action((slug: string) => {
      runPublishShow(slug);
    });
}
