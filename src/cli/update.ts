import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Command } from 'commander';

import { getDatabase, closeDatabase } from '../core/db/database.js';
import { loadConfig } from '../core/config/loader.js';
import { TEMPLATES_ROOT } from '../core/paths.js';
import { printEnvelope } from '../core/json-envelope.js';
import { resolveUserPath } from '../core/workspace/user-path.js';
import { validateSlug } from '../core/research/document.js';
import {
  openUpdateCycle,
  getOpenUpdateCycle,
  closeUpdateCycle,
  listUpdateCycles,
  requirePublishedPost,
} from '../core/update/cycles.js';
import { appendUpdateNotice } from '../core/update/notice.js';
import {
  createBenchmarkRun,
  latestBaselineBenchmarkId,
} from '../core/benchmark/state.js';
import { initEvaluation } from '../core/evaluate/state.js';
import { runPipeline } from '../core/publish/pipeline-runner.js';
import { PipelineContext } from '../core/publish/pipeline-types.js';
import { PublishUrls } from '../core/publish/types.js';
import { getPipelineSteps } from '../core/publish/steps-crud.js';
import { createPipelineSteps } from '../core/publish/steps-crud.js';
import { PostRow, UpdateCycleRow } from '../core/db/types.js';

// Phase 7 CLI surface for the update flow. Lives alongside `blog publish`
// but kept as its own subcommand group so each handler can enforce the
// Phase 7 invariants:
//   - every handler requires an open update cycle (except `start` and
//     `show`), fetched via `getOpenUpdateCycle`
//   - every handler requires the post to be in 'published' phase
//   - the publish sub-command drives the runner with publishMode='update'
//     and cycleId=open_cycle.id
//
// All path defaults mirror `blog publish` so the two surfaces share the
// same `.blog-agent/*` layout.

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
const TEMPLATES_DIR = TEMPLATES_ROOT;

export interface UpdateCliPaths {
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
  json?: boolean;
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

// Today's date in YYYY-MM-DD, UTC. Used for the update notice block.
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface UpdateStartOptions {
  summary?: string;
}

export function runUpdateStart(
  slug: string,
  opts: UpdateStartOptions,
  paths: UpdateCliPaths = {},
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
    if (config!.updates.require_summary !== false) {
      if (!opts.summary || opts.summary.trim().length === 0) {
        console.error(
          `'blog update start' requires --summary "..." (config.updates.require_summary=true). ` +
          `Provide a one-line reason for this update (used in update notice and social text).`,
        );
        process.exitCode = 1;
        return;
      }
    }

    let cycle: UpdateCycleRow;
    try {
      cycle = openUpdateCycle(db, slug, opts.summary ?? null);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    console.log(
      `Update cycle ${cycle.cycle_number} opened for '${slug}' ` +
      `(id=${cycle.id}).`,
    );
    console.log(
      `Next: 'blog update draft ${slug}' (or 'blog update benchmark ${slug} --results <file>' if re-running).`,
    );
  } finally {
    closeDatabase(db);
  }
}

export interface UpdateBenchmarkOptions {
  results: string;
  environmentJson?: string;
}

export function runUpdateBenchmark(
  slug: string,
  opts: UpdateBenchmarkOptions,
  paths: UpdateCliPaths = {},
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
    try {
      requirePublishedPost(db, slug);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    const cycle = getOpenUpdateCycle(db, slug);
    if (!cycle) {
      console.error(
        `'blog update benchmark' requires an open update cycle. ` +
        `Run 'blog update start ${slug} --summary "..."' first.`,
      );
      process.exitCode = 1;
      return;
    }
    if (!existsSync(opts.results)) {
      console.error(`Benchmark results file not found: ${opts.results}`);
      process.exitCode = 1;
      return;
    }
    const envJson = opts.environmentJson ?? '{}';
    const previousRunId = latestBaselineBenchmarkId(db, slug) ?? undefined;
    const runId = createBenchmarkRun(db, slug, envJson, resolve(opts.results), {
      isUpdate: true,
      previousRunId,
    });
    console.log(
      `Update benchmark run ${runId} recorded for '${slug}' ` +
      `(is_update=1, previous_run_id=${previousRunId ?? 'null'}).`,
    );
  } finally {
    closeDatabase(db);
  }
}

export function runUpdateDraft(
  slug: string,
  paths: UpdateCliPaths = {},
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
  const draftsDir = paths.draftsDir ?? DRAFTS_DIR;
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
    try {
      requirePublishedPost(db, slug);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    const cycle = getOpenUpdateCycle(db, slug);
    if (!cycle) {
      console.error(
        `'blog update draft' requires an open update cycle. ` +
        `Run 'blog update start' first.`,
      );
      process.exitCode = 1;
      return;
    }
    const mdxPath = resolve(draftsDir, slug, 'index.mdx');
    if (!existsSync(mdxPath)) {
      console.error(
        `Draft MDX not found at ${mdxPath}. ` +
        `Initial publish should have left the draft in place; if the workspace was rebuilt, ` +
        `re-export the post's MDX to ${draftsDir}/${slug}/index.mdx first.`,
      );
      process.exitCode = 1;
      return;
    }
    const result = appendUpdateNotice(
      mdxPath,
      cycle.id,
      todayIsoDate(),
      cycle.summary,
      config!,
    );
    console.log(
      `Update notice ${result.action} on ${mdxPath} ` +
      `(cycle ${cycle.cycle_number}, total notice blocks now: ${result.blockCount}).`,
    );
    console.log(
      `Next: 'blog update evaluate ${slug}' once the draft regeneration is complete.`,
    );
  } finally {
    closeDatabase(db);
  }
}

export function runUpdateEvaluate(
  slug: string,
  paths: UpdateCliPaths = {},
): void {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }
  const dbPath = paths.dbPath ?? DB_PATH;
  const evaluationsDir = paths.evaluationsDir ?? EVALUATIONS_DIR;
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    try {
      requirePublishedPost(db, slug);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    const cycle = getOpenUpdateCycle(db, slug);
    if (!cycle) {
      console.error(
        `'blog update evaluate' requires an open update cycle. ` +
        `Run 'blog update start' first.`,
      );
      process.exitCode = 1;
      return;
    }
    try {
      initEvaluation(db, slug, evaluationsDir, { isUpdateReview: true });
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    console.log(
      `Evaluation workspace initialized for update-review cycle ${cycle.cycle_number} of '${slug}'.`,
    );
    console.log(
      `Next: run the three reviewers via the /blog-evaluate skill, then 'blog evaluate synthesize ${slug}', then 'blog update publish ${slug}'.`,
    );
  } finally {
    closeDatabase(db);
  }
}

export async function runUpdatePublish(
  slug: string,
  paths: UpdateCliPaths = {},
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
    let post: PostRow;
    try {
      post = requirePublishedPost(db, slug);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    const cycle = getOpenUpdateCycle(db, slug);
    if (!cycle) {
      console.error(
        `'blog update publish' requires an open update cycle. ` +
        `Run 'blog update start' first.`,
      );
      process.exitCode = 1;
      return;
    }

    if (!post.content_type) {
      console.error(`Post '${slug}' has no content_type — cannot dispatch pipeline.`);
      process.exitCode = 1;
      return;
    }

    // Seed pipeline_steps for this update cycle. Idempotent — INSERT OR
    // IGNORE on the UNIQUE(post_slug, cycle_id, step_name) constraint means
    // re-running after a partial crash is safe.
    createPipelineSteps(
      db,
      slug,
      post.content_type,
      config!,
      undefined,
      cycle.id,
      'update',
    );

    // Hydrate urls from the posts row so the runner sees everything a prior
    // run persisted — same logic as runPublishStart.
    const urlRow = db
      .prepare(
        'SELECT site_url, devto_url, medium_url, substack_url, repo_url FROM posts WHERE slug = ?',
      )
      .get(slug) as
      | {
          site_url: string | null;
          devto_url: string | null;
          medium_url: string | null;
          substack_url: string | null;
          repo_url: string | null;
        }
      | undefined;
    const hydratedUrls: PublishUrls = {};
    if (urlRow?.site_url) hydratedUrls.site_url = urlRow.site_url;
    if (urlRow?.devto_url) hydratedUrls.devto_url = urlRow.devto_url;
    if (urlRow?.medium_url) hydratedUrls.medium_url = urlRow.medium_url;
    if (urlRow?.substack_url) hydratedUrls.substack_url = urlRow.substack_url;
    if (urlRow?.repo_url) hydratedUrls.repo_url = urlRow.repo_url;

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
      urls: hydratedUrls,
      publishMode: 'update',
      cycleId: cycle.id,
    };

    let result;
    try {
      result = await runPipeline(ctx);
    } catch (e) {
      console.error(`Update publish pipeline crashed: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }

    if (result.completed) {
      console.log(
        `Update publish complete: cycle ${cycle.cycle_number} for '${slug}' closed.`,
      );
    } else if (result.pausedStep) {
      console.log(
        `Update publish paused at step: ${result.pausedStep}. ` +
        `Re-run 'blog update publish ${slug}' when ready to resume.`,
      );
    } else if (result.failedStep) {
      console.error(
        `Update publish paused at failed step: ${result.failedStep}. ` +
        `Fix the underlying issue and re-run 'blog update publish ${slug}'.`,
      );
      process.exitCode = 1;
    } else {
      console.error(
        `Update publish did not complete for '${slug}'. Run 'blog update show' to inspect.`,
      );
      process.exitCode = 1;
    }
  } finally {
    closeDatabase(db);
  }
}

export function runUpdateAbort(
  slug: string,
  paths: UpdateCliPaths = {},
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
    const cycle = getOpenUpdateCycle(db, slug);
    if (!cycle) {
      console.error(
        `'blog update abort' requires an open update cycle for '${slug}'. Nothing to abort.`,
      );
      process.exitCode = 1;
      return;
    }
    try {
      closeUpdateCycle(db, cycle.id, 'aborted');
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    console.log(
      `Update cycle ${cycle.cycle_number} for '${slug}' aborted. ` +
      `Regenerated artifacts (drafts, benchmarks) preserved on disk for inspection.`,
    );
  } finally {
    closeDatabase(db);
  }
}

export function runUpdateShow(
  slug: string,
  paths: UpdateCliPaths = {},
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
      .prepare('SELECT slug, phase, title, update_count, last_updated_at FROM posts WHERE slug = ?')
      .get(slug) as
      | { slug: string; phase: string; title: string | null; update_count: number; last_updated_at: string | null }
      | undefined;
    if (!post) {
      console.error(`Post not found: ${slug}`);
      process.exitCode = 1;
      return;
    }

    const cycles = listUpdateCycles(db, slug);
    const openCycle = cycles.find((c) => c.closed_at === null) ?? null;
    if (paths.json) {
      const openSteps = openCycle ? getPipelineSteps(db, slug, openCycle.id) : [];
      printEnvelope<'UpdatePipeline', {
        slug: string;
        phase: string;
        title: string | null;
        update_count: number;
        last_updated_at: string | null;
        open_cycle_id: number | null;
        cycles: Array<{
          id: number;
          cycle_number: number;
          opened_at: string;
          closed_at: string | null;
          ended_reason: string | null;
          summary: string | null;
        }>;
        open_cycle_steps: Array<{
          step_number: number;
          step_name: string;
          status: string;
        }>;
      }>('UpdatePipeline', {
        slug: post.slug,
        phase: post.phase,
        title: post.title,
        update_count: post.update_count,
        last_updated_at: post.last_updated_at,
        open_cycle_id: openCycle ? openCycle.id : null,
        cycles: cycles.map((c) => ({
          id: c.id,
          cycle_number: c.cycle_number,
          opened_at: c.opened_at,
          closed_at: c.closed_at,
          ended_reason: c.ended_reason ?? null,
          summary: c.summary ?? null,
        })),
        open_cycle_steps: openSteps.map((s) => ({
          step_number: s.step_number,
          step_name: s.step_name,
          status: s.status,
        })),
      });
      return;
    }

    console.log(`slug:            ${post.slug}`);
    console.log(`phase:           ${post.phase}`);
    console.log(`title:           ${post.title ?? '(none)'}`);
    console.log(`update_count:    ${post.update_count}`);
    console.log(`last_updated_at: ${post.last_updated_at ?? '-'}`);
    console.log('');

    if (cycles.length === 0) {
      console.log(
        `No update cycles yet. Run 'blog update start ${slug} --summary "..."' to open one.`,
      );
      return;
    }
    console.log('cycles:');
    for (const c of cycles) {
      const state = c.closed_at
        ? `closed (${c.ended_reason})`
        : 'OPEN';
      console.log(
        `  #${c.cycle_number}  id=${c.id}  opened=${c.opened_at}  state=${state}  summary=${c.summary ?? '(none)'}`,
      );
    }

    if (openCycle) {
      const steps = getPipelineSteps(db, slug, openCycle.id);
      if (steps.length > 0) {
        console.log('');
        console.log(`update-publish steps (cycle ${openCycle.cycle_number}):`);
        for (const s of steps) {
          console.log(
            `  ${s.step_number}. ${s.step_name.padEnd(22)} ${s.status}`,
          );
        }
      }
    }
  } finally {
    closeDatabase(db);
  }
}

export function registerUpdate(program: Command): void {
  const update = program.command('update').description('Update-cycle operations');

  update
    .command('start <slug>')
    .description('Open a new update cycle for a published post')
    .option('--summary <text>', 'One-line summary of what is being updated')
    .action((slug: string, opts: { summary?: string }) => {
      runUpdateStart(slug, { summary: opts.summary });
    });

  update
    .command('benchmark <slug>')
    .description('Record a new benchmark run for the open update cycle')
    .requiredOption('--results <file>', 'Path to benchmark results JSON', resolveUserPath)
    .option('--env-json <json>', 'Optional environment snapshot JSON (default "{}")')
    .action((slug: string, opts: { results: string; envJson?: string }) => {
      runUpdateBenchmark(slug, { results: opts.results, environmentJson: opts.envJson });
    });

  update
    .command('draft <slug>')
    .description('Append an update notice to the post MDX for the open cycle')
    .action((slug: string) => {
      runUpdateDraft(slug);
    });

  update
    .command('evaluate <slug>')
    .description('Open a fresh evaluation cycle flagged as an update review')
    .action((slug: string) => {
      runUpdateEvaluate(slug);
    });

  update
    .command('publish <slug>')
    .description('Run the publish pipeline in update mode for the open cycle')
    .action(async (slug: string) => {
      await runUpdatePublish(slug);
    });

  update
    .command('abort <slug>')
    .description('Abort the open update cycle (artifacts preserved on disk)')
    .action((slug: string) => {
      runUpdateAbort(slug);
    });

  update
    .command('show <slug>')
    .description('Show update cycle history and current pipeline state')
    .option('--json', 'Emit JSON envelope for machine consumers')
    .action((slug: string, opts: { json?: boolean }) => {
      runUpdateShow(slug, { json: opts.json });
    });
}
