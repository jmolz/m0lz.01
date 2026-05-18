import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Command } from 'commander';

import { getDatabase, closeDatabase } from '../core/db/database.js';
import { ContentType } from '../core/db/types.js';
import { loadConfig } from '../core/config/loader.js';
import { TEMPLATES_ROOT } from '../core/paths.js';
import { printEnvelope } from '../core/json-envelope.js';
import { validateSlug } from '../core/research/document.js';
import { initPublish, reopenPublishDraft } from '../core/publish/phase.js';
import { getPipelineSteps } from '../core/publish/steps-crud.js';
import { getOpenUpdateCycle } from '../core/update/cycles.js';
import { runPipeline } from '../core/publish/pipeline-runner.js';
import { PipelineContext } from '../core/publish/pipeline-types.js';
import { PipelineStepRow, PublishUrls } from '../core/publish/types.js';
import { computePreviewUrls } from '../core/publish/preview-urls.js';
import { PostRow } from '../core/db/types.js';
import { LinkedInImageMode } from '../core/config/types.js';
import { generateDistributionKit } from '../core/publish/distribution-kit.js';
import { persistDistributionKitToSite } from '../core/publish/site-artifacts.js';
import { backfillPlatformImages } from '../core/publish/platform-image-site.js';

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
const TEMPLATES_DIR = TEMPLATES_ROOT;

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
  json?: boolean;
  // v0.3 dogfood-hardening: bypass the local-main-ahead-of-origin guard
  // in the site-pr step. Surfaced as --allow-main-ahead on the CLI and
  // forwarded through PipelineContext. The flag is a plan-step arg so
  // the SHA256 plan hash binds operator consent (see site.ts).
  allowMainAhead?: boolean;
  distributionImageMode?: LinkedInImageMode;
}

export interface PublishDistributionKitOptions {
  commitSite?: boolean;
  imageMode?: LinkedInImageMode;
  force?: boolean;
}

export interface PublishPlatformImagesOptions {
  commitSite?: boolean;
}

export interface PublishReopenDraftOptions {
  reason?: string;
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
    // Phase 7: refuse to run initial publish while an update cycle is open.
    // If we didn't guard here, a naive re-run of `blog publish start` on a
    // published post with an open update cycle would either (a) try to
    // promote from published to publish phase (impossible) or (b) with the
    // update flow's phase-stays-published invariant, silently misroute
    // update work into the initial-publish pipeline.
    const openCycle = getOpenUpdateCycle(db, slug);
    if (openCycle) {
      console.error(
        `Cannot run 'blog publish start' — an open update cycle exists for '${slug}' ` +
        `(id=${openCycle.id}, cycle_number=${openCycle.cycle_number}).\n` +
        `Use 'blog update publish ${slug}' to complete the update, ` +
        `or 'blog update abort ${slug}' to cancel.`,
      );
      process.exitCode = 1;
      return;
    }

    const post = db
      .prepare('SELECT phase, content_type FROM posts WHERE slug = ?')
      .get(slug) as { phase: string; content_type: string | null } | undefined;
    if (!post) {
      console.error(`Post not found: ${slug}`);
      process.exitCode = 1;
      return;
    }

    if (post.phase === 'published') {
      console.error(
        `Post '${slug}' is already published. Use 'blog update start ${slug}' to open an update cycle, ` +
        `or 'blog unpublish start ${slug} --confirm' to revert.`,
      );
      process.exitCode = 1;
      return;
    }
    if (post.phase !== 'evaluate' && post.phase !== 'publish') {
      console.error(
        `Post '${slug}' is in phase '${post.phase}' — only 'evaluate' (to initialize) ` +
        `or 'publish' (to resume) are valid starting phases for this command.`,
      );
      process.exitCode = 1;
      return;
    }
    if (!post.content_type) {
      console.error(
        `Post '${slug}' has no content_type. Cannot initialize publish pipeline.`,
      );
      process.exitCode = 1;
      return;
    }

    // v0.3 dogfood-hardening: always call initPublish when phase is
    // `evaluate` (promotes + seeds) OR `publish` (seed-only, idempotent
    // via INSERT OR IGNORE inside createPipelineSteps). Previously the
    // handler skipped initPublish on phase=publish entirely — but
    // `completeEvaluation` advances phase to `publish` WITHOUT seeding
    // `pipeline_steps`, so a post landing in phase=publish via evaluate→
    // complete had zero step rows and the pipeline runner's
    // `getNextPendingStep` returned null forever. Recovery required SQL.
    // Re-entry on a post that already has seeded rows is safe — the
    // INSERT OR IGNORE leaves them alone.
    const countPipelineSteps = (): number =>
      (db
        .prepare(
          'SELECT COUNT(*) as c FROM pipeline_steps WHERE post_slug = ? AND cycle_id = 0',
        )
        .get(slug) as { c: number }).c;

    const countBefore = countPipelineSteps();
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
    const countAfter = countPipelineSteps();
    const seeded = countAfter - countBefore;
    if (seeded > 0) {
      console.log(`seeded ${seeded} pipeline_steps for ${slug}`);
    }

    // Hydrate ctx.urls from the posts row so a resumed run can see URLs
    // that a prior invocation persisted via persistPublishUrls. Without
    // this, step 9 (update-frontmatter) would read empty ctx.urls on
    // resume and write incomplete frontmatter — a real bug surfaced by
    // the Cluster 8 adversarial review: per-step URLs landed on the row,
    // but downstream steps only looked at the in-memory bundle.
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
      // Phase 7: `blog publish start` always drives the initial-publish
      // flow. The update flow uses `blog update publish` (Cluster B) which
      // constructs its own ctx with publishMode='update' and a non-zero
      // cycleId from the open update_cycles row.
      publishMode: 'initial',
      cycleId: 0,
      allowMainAhead: paths.allowMainAhead,
      distributionImageMode: paths.distributionImageMode,
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
// Helper shared between the text and JSON paths — loads config + post,
// returns null when either is missing or malformed so callers can choose
// their own degraded-state behavior. `runPublishShow` is best-effort
// with config (show is informational, not mutating), so this helper
// never throws.
function tryLoadPreviewUrls(
  db: import('better-sqlite3').Database,
  slug: string,
  configPath: string,
  researchPagesDir: string,
): ReturnType<typeof computePreviewUrls> | null {
  if (!existsSync(configPath)) return null;
  let config;
  try {
    config = loadConfig(configPath);
  } catch {
    return null;
  }
  const post = db
    .prepare('SELECT * FROM posts WHERE slug = ?')
    .get(slug) as PostRow | undefined;
  if (!post) return null;
  return computePreviewUrls(post, config, configPath, researchPagesDir);
}

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
  const researchPagesDir = paths.researchPagesDir ?? RESEARCH_PAGES_DIR;
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

    const steps = getPipelineSteps(db, slug);
    if (paths.json) {
      const pausedStep = steps.find((s) => s.status === 'running' || s.status === 'failed');
      // v0.3 dogfood-hardening: surface the 3 preview URLs under
      // `preview_urls` so the `/blog` skill can render them at the
      // preview-gate checkpoint. Falls back to a minimal shape (with
      // null fields) when config is absent/malformed — the `show`
      // command must remain informational even in degraded state.
      const previewUrls = tryLoadPreviewUrls(db, slug, configPath, researchPagesDir) ?? {
        canonicalUrl: '',
        supplementaryUrl: null,
        companionRepoUrl: null,
      };
      printEnvelope<'PublishPipeline', {
        slug: string;
        phase: string;
        content_type: string | null;
        title: string | null;
        evaluation_passed: boolean;
        published_at: string | null;
        paused_step: number | null;
        preview_urls: {
          canonicalUrl: string;
          supplementaryUrl: string | null;
          companionRepoUrl: string | null;
        };
        steps: Array<{
          step_number: number;
          step_name: string;
          status: string;
          started_at: string | null;
          completed_at: string | null;
          error_message: string | null;
        }>;
      }>('PublishPipeline', {
        slug: post.slug,
        phase: post.phase,
        content_type: post.content_type,
        title: post.title,
        evaluation_passed: post.evaluation_passed === 1,
        published_at: post.published_at,
        paused_step: pausedStep ? pausedStep.step_number : null,
        preview_urls: previewUrls,
        steps: steps.map((s) => ({
          step_number: s.step_number,
          step_name: s.step_name,
          status: s.status,
          started_at: s.started_at ?? null,
          completed_at: s.completed_at ?? null,
          error_message: s.error_message ?? null,
        })),
      });
      return;
    }

    console.log(`slug:               ${post.slug}`);
    console.log(`phase:              ${post.phase}`);
    console.log(`content_type:       ${post.content_type ?? 'unknown'}`);
    console.log(`title:              ${post.title ?? '(none)'}`);
    console.log(`evaluation_passed:  ${post.evaluation_passed === 1 ? 'Yes' : 'No'}`);
    console.log(`published_at:       ${post.published_at ?? '—'}`);
    console.log('');

    if (steps.length === 0) {
      console.log(`No pipeline steps yet. Run 'blog publish start ${slug}' to initialize.`);
      return;
    }

    renderStepTable(steps);
  } finally {
    closeDatabase(db);
  }
}

export async function runPublishDistributionKit(
  slug: string,
  opts: PublishDistributionKitOptions = {},
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
  const socialDir = paths.socialDir ?? SOCIAL_DIR;
  const templatesDir = paths.templatesDir ?? TEMPLATES_DIR;
  requireDb(dbPath);

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
      .prepare('SELECT phase FROM posts WHERE slug = ?')
      .get(slug) as { phase: string } | undefined;
    if (!post) {
      console.error(`Post not found: ${slug}`);
      process.exitCode = 1;
      return;
    }
    if (post.phase !== 'publish' && post.phase !== 'published') {
      console.error(
        `Post '${slug}' is in phase '${post.phase}' — distribution-kit backfill requires 'publish' or 'published'.`,
      );
      process.exitCode = 1;
      return;
    }

    const kit = await generateDistributionKit(slug, config!, {
      socialDir,
      templatesDir,
      draftsDir,
      configPath,
    }, db, {
      sourceMode: 'backfill',
      imageMode: opts.imageMode,
      force: opts.force,
    });
    console.log(
      `${kit.reused ? 'Reused' : 'Generated'} distribution kit for '${slug}': ${kit.manifestPath}`,
    );

    const shouldCommitSite =
      opts.commitSite === true || config!.social.distribution_kit.persist_to_site === true;
    if (shouldCommitSite) {
      const persisted = persistDistributionKitToSite(slug, config!, { configPath }, kit);
      console.log(
        persisted.updated
          ? `Committed distribution kit to site repo: ${persisted.paths.join(', ')}`
          : `Site distribution kit already current: ${persisted.reason ?? 'no changes'}`,
      );
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

export async function runPublishPlatformImages(
  slug: string,
  opts: PublishPlatformImagesOptions = {},
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
  requireDb(dbPath);

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
      .prepare('SELECT phase FROM posts WHERE slug = ?')
      .get(slug) as { phase: string } | undefined;
    if (!post) {
      console.error(`Post not found: ${slug}`);
      process.exitCode = 1;
      return;
    }
    if (post.phase !== 'publish' && post.phase !== 'published') {
      console.error(
        `Post '${slug}' is in phase '${post.phase}' — platform-image backfill requires 'publish' or 'published'.`,
      );
      process.exitCode = 1;
      return;
    }

    const result = await backfillPlatformImages(slug, config!, { configPath, draftsDir }, {
      commitSite: opts.commitSite,
    });
    console.log(`Generated platform images for '${slug}': ${result.images.receiptPath}`);
    if (result.site) {
      console.log(
        result.site.updated
          ? `Committed platform images to site repo: ${result.site.paths.join(', ')}`
          : `Site platform images already current: ${result.site.reason ?? 'no changes'}`,
      );
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

export function runPublishReopenDraft(
  slug: string,
  opts: PublishReopenDraftOptions = {},
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
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    let result;
    try {
      result = reopenPublishDraft(db, slug, opts.reason ?? '');
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }

    console.log(`Publish reopened for ${slug}. Phase moved back to draft.`);
    console.log(`Cleared initial publish steps: ${result.clearedPipelineSteps}`);
    console.log(`Reason: ${result.reason}`);
    console.log(`Next: blog draft platform-images ${slug}`);
    console.log(`Then: blog draft complete ${slug} and re-run evaluation.`);
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
    .option(
      '--allow-main-ahead',
      "Bypass the site-pr origin-sync check (local main ahead of origin/main). The flag becomes part of the approved plan's hash, so an edit after approval requires re-consent.",
    )
    .option(
      '--image-mode <mode>',
      'One-run LinkedIn image mode override for the distribution kit: off, prompt-only, generate, required',
    )
    .action(async (slug: string, opts: { allowMainAhead?: boolean; imageMode?: string }) => {
      const imageMode = opts.imageMode as LinkedInImageMode | undefined;
      if (imageMode && !['off', 'prompt-only', 'generate', 'required'].includes(imageMode)) {
        console.error(`Invalid --image-mode: ${imageMode}`);
        process.exitCode = 1;
        return;
      }
      await runPublishStart(slug, {
        allowMainAhead: opts.allowMainAhead,
        distributionImageMode: imageMode,
      });
    });

  publish
    .command('show <slug>')
    .description('Show publish pipeline step status for a post')
    .option('--json', 'Emit JSON envelope for machine consumers')
    .action((slug: string, opts: { json?: boolean }) => {
      runPublishShow(slug, { json: opts.json });
    });

  publish
    .command('reopen-draft <slug>')
    .description('Recover a publish blocked before site-pr by moving the post back to draft')
    .requiredOption('--reason <reason>', 'Audit reason for reopening the failed publish')
    .action((slug: string, opts: { reason: string }) => {
      runPublishReopenDraft(slug, { reason: opts.reason });
    });

  publish
    .command('distribution-kit <slug>')
    .description('Generate or backfill durable distribution-kit artifacts for a post')
    .option('--commit-site', 'Commit generated artifacts to the configured site repo')
    .option('--image-mode <mode>', 'Override LinkedIn image mode: off, prompt-only, generate, required')
    .option('--force', 'Regenerate artifacts even when the manifest input hash matches')
    .action(async (
      slug: string,
      opts: { commitSite?: boolean; imageMode?: string; force?: boolean },
    ) => {
      const imageMode = opts.imageMode as LinkedInImageMode | undefined;
      if (imageMode && !['off', 'prompt-only', 'generate', 'required'].includes(imageMode)) {
        console.error(`Invalid --image-mode: ${imageMode}`);
        process.exitCode = 1;
        return;
      }
      await runPublishDistributionKit(slug, {
        commitSite: opts.commitSite,
        imageMode,
        force: opts.force,
      });
    });

  publish
    .command('platform-images <slug>')
    .description('Regenerate or backfill Dev.to, Medium, and Substack platform images for a published post')
    .option('--commit-site', 'Commit refreshed image assets to the configured site repo')
    .action(async (slug: string, opts: { commitSite?: boolean }) => {
      await runPublishPlatformImages(slug, { commitSite: opts.commitSite });
    });
}
