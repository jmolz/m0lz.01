import { StepDefinition, PipelineContext, StepResult } from './pipeline-types.js';
import { generateResearchPage } from './research-page.js';
import { createSitePR, checkPreviewGate } from './site.js';
import { createSiteUpdate } from './site-update.js';
import { crosspostToDevTo, updateDevToArticle } from './devto.js';
import { generateMediumPaste } from './medium.js';
import { generateSubstackPaste } from './substack.js';
import { pushCompanionRepo } from './repo.js';
import { updateFrontmatter } from './frontmatter.js';
import { updateProjectReadme } from './readme.js';
import { generateSocialText } from './social.js';
import { getOpenUpdateCycle } from '../update/cycles.js';

// Ordered list of all 11 publish pipeline steps. Each step's execute
// function translates the unified PipelineContext into the step-specific
// paths interface, calls the module function, and translates the result
// into a StepResult. Steps that produce URLs populate urlUpdates so the
// runner can merge them into ctx.urls for downstream steps.
//
// Step ordering is authoritative and matches PUBLISH_STEP_NAMES in
// ./types.ts. The runner iterates by database step_number order, but the
// registry is the single source for the execute wiring.

export const PIPELINE_STEPS: StepDefinition[] = [
  // Step 1: verify — inline check, no dedicated module.
  //
  // Phase 7 mode dispatch:
  //   - initial: `posts.evaluation_passed = 1` gates the whole cycle.
  //   - update:  the most recent synthesis in the CURRENT update-review
  //     cycle must be verdict='pass'. Scoped by update cycle's opened_at
  //     so a pre-update synthesis cannot authorize an update publish.
  {
    number: 1,
    name: 'verify',
    execute: (ctx: PipelineContext): StepResult => {
      if (ctx.publishMode === 'update') {
        const cycle = getOpenUpdateCycle(ctx.db, ctx.slug);
        if (!cycle) {
          return {
            outcome: 'failed',
            message: `verify (update mode): no open update cycle for '${ctx.slug}'.`,
          };
        }
        const row = ctx.db
          .prepare(
            `SELECT s.verdict
             FROM evaluation_synthesis s
             WHERE s.post_slug = ?
               AND s.synthesized_at >= ?
               AND EXISTS (
                 SELECT 1 FROM evaluations e
                 WHERE e.post_slug = s.post_slug
                   AND e.is_update_review = 1
                   AND e.run_at >= ?
               )
             ORDER BY s.id DESC
             LIMIT 1`,
          )
          .get(ctx.slug, cycle.opened_at, cycle.opened_at) as
          | { verdict: string }
          | undefined;
        if (!row) {
          return {
            outcome: 'failed',
            message: `verify (update mode): no evaluation synthesis found for the current update cycle.`,
          };
        }
        if (row.verdict !== 'pass') {
          return {
            outcome: 'failed',
            message: `verify (update mode): synthesis verdict is '${row.verdict}', not 'pass'.`,
          };
        }
        return { outcome: 'completed', message: 'Update evaluation verified' };
      }
      const post = ctx.db
        .prepare('SELECT evaluation_passed FROM posts WHERE slug = ?')
        .get(ctx.slug) as { evaluation_passed: number | null } | undefined;
      if (!post) {
        return { outcome: 'failed', message: `Post not found: ${ctx.slug}` };
      }
      if (!post.evaluation_passed) {
        return { outcome: 'failed', message: 'Evaluation not passed -- cannot publish' };
      }
      return { outcome: 'completed', message: 'Evaluation verified' };
    },
  },

  // Step 2: research-page — generate research companion MDX.
  {
    number: 2,
    name: 'research-page',
    execute: (ctx: PipelineContext): StepResult => {
      const result = generateResearchPage(ctx.slug, ctx.config, {
        researchDir: ctx.paths.researchDir,
        benchmarkDir: ctx.paths.benchmarkDir,
        researchPagesDir: ctx.paths.researchPagesDir,
        templatesDir: ctx.paths.templatesDir,
        draftsDir: ctx.paths.draftsDir,
      }, ctx.db);
      if (result.skipped) {
        return { outcome: 'skipped', message: result.reason ?? 'Research page skipped' };
      }
      return { outcome: 'completed', message: `Research page generated: ${result.path}` };
    },
  },

  // Step 3: site-pr — copy content into site repo, commit, push, open PR.
  // Phase 7: initial mode only (update mode uses site-update below).
  {
    number: 3,
    name: 'site-pr',
    execute: (ctx: PipelineContext): StepResult => {
      const result = createSitePR(ctx.slug, ctx.config, {
        draftsDir: ctx.paths.draftsDir,
        researchPagesDir: ctx.paths.researchPagesDir,
        publishDir: ctx.paths.publishDir,
        configPath: ctx.paths.configPath,
      }, ctx.db);
      return {
        outcome: 'completed',
        message: `PR #${result.prNumber} opened: ${result.prUrl}`,
        data: {
          prNumber: result.prNumber,
          prUrl: result.prUrl,
          branchName: result.branchName,
        },
        urlUpdates: {
          site_url: `${ctx.config.site.base_url}/writing/${ctx.slug}`,
        },
      };
    },
  },

  // Phase 7: site-update — update-mode equivalent of site-pr. Commits the
  // regenerated MDX body + assets on an update-cycle-scoped branch and
  // opens a PR so preview-gate can wait for merge (mirrors initial
  // publish's review gate).
  {
    number: 3,
    name: 'site-update',
    execute: (ctx: PipelineContext): StepResult => {
      const result = createSiteUpdate(ctx.slug, ctx.config, {
        draftsDir: ctx.paths.draftsDir,
        researchPagesDir: ctx.paths.researchPagesDir,
        publishDir: ctx.paths.publishDir,
        configPath: ctx.paths.configPath,
      }, ctx.db);
      return {
        outcome: 'completed',
        message: `Update PR #${result.prNumber} opened (cycle ${result.cycleNumber}): ${result.prUrl}`,
        data: {
          prNumber: result.prNumber,
          prUrl: result.prUrl,
          branchName: result.branchName,
          cycleNumber: result.cycleNumber,
        },
        urlUpdates: {
          site_url: `${ctx.config.site.base_url}/writing/${ctx.slug}`,
        },
      };
    },
  },

  // Step 4: preview-gate — check whether the site PR has been merged.
  // Returns 'paused' when unmerged so the runner can surface guidance
  // without marking the step failed.
  {
    number: 4,
    name: 'preview-gate',
    execute: (ctx: PipelineContext): StepResult => {
      const result = checkPreviewGate(ctx.slug, ctx.config, {
        draftsDir: ctx.paths.draftsDir,
        researchPagesDir: ctx.paths.researchPagesDir,
        publishDir: ctx.paths.publishDir,
        configPath: ctx.paths.configPath,
      });
      if (result.merged) {
        return { outcome: 'completed', message: 'PR merged -- preview gate passed' };
      }
      return {
        outcome: 'paused',
        message: result.message ?? 'PR not yet merged -- waiting for review',
      };
    },
  },

  // Step 5: crosspost-devto — async Dev.to API call.
  //
  // Phase 7 mode dispatch:
  //   - initial: probe-then-create (Phase 6 behavior).
  //   - update:  probe-then-PUT-body. On probe-miss, fall through to POST
  //     to recover from manual deletion.
  {
    number: 5,
    name: 'crosspost-devto',
    execute: async (ctx: PipelineContext): Promise<StepResult> => {
      if (ctx.publishMode === 'update' && ctx.config.updates.devto_update !== false) {
        const result = await updateDevToArticle(ctx.slug, ctx.config, {
          draftsDir: ctx.paths.draftsDir,
        });
        if (result.skipped) {
          return { outcome: 'skipped', message: result.reason ?? 'Dev.to update skipped' };
        }
        return {
          outcome: 'completed',
          message: result.url
            ? `Updated Dev.to article: ${result.url}`
            : `Updated Dev.to article (ID: ${result.id})`,
          urlUpdates: result.url ? { devto_url: result.url } : undefined,
        };
      }
      const result = await crosspostToDevTo(ctx.slug, ctx.config, {
        draftsDir: ctx.paths.draftsDir,
      });
      if (result.skipped) {
        return { outcome: 'skipped', message: result.reason ?? 'Dev.to cross-post skipped' };
      }
      return {
        outcome: 'completed',
        message: result.url
          ? `Cross-posted to Dev.to: ${result.url}`
          : `Cross-posted to Dev.to (ID: ${result.id})`,
        urlUpdates: result.url ? { devto_url: result.url } : undefined,
      };
    },
  },

  // Step 6: paste-medium — generate paste-ready Medium markdown.
  {
    number: 6,
    name: 'paste-medium',
    execute: (ctx: PipelineContext): StepResult => {
      const result = generateMediumPaste(ctx.slug, ctx.config, {
        draftsDir: ctx.paths.draftsDir,
        socialDir: ctx.paths.socialDir,
      });
      return { outcome: 'completed', message: `Medium paste generated: ${result.path}` };
    },
  },

  // Step 7: paste-substack — generate paste-ready Substack markdown.
  {
    number: 7,
    name: 'paste-substack',
    execute: (ctx: PipelineContext): StepResult => {
      const result = generateSubstackPaste(ctx.slug, ctx.config, {
        draftsDir: ctx.paths.draftsDir,
        socialDir: ctx.paths.socialDir,
      });
      return { outcome: 'completed', message: `Substack paste generated: ${result.path}` };
    },
  },

  // Step 8: companion-repo — push/create companion GitHub repo.
  {
    number: 8,
    name: 'companion-repo',
    execute: (ctx: PipelineContext): StepResult => {
      const result = pushCompanionRepo(ctx.slug, ctx.config, {
        reposDir: ctx.paths.reposDir,
      }, ctx.db);
      if (result.skipped) {
        return { outcome: 'skipped', message: result.reason ?? 'Companion repo skipped' };
      }
      return {
        outcome: 'completed',
        message: `Companion repo pushed: ${result.repoUrl}`,
        urlUpdates: result.repoUrl ? { repo_url: result.repoUrl } : undefined,
      };
    },
  },

  // Step 9: update-frontmatter — add platform URLs to site repo MDX.
  // Receives ctx.urls which accumulates URLs from prior steps.
  {
    number: 9,
    name: 'update-frontmatter',
    execute: (ctx: PipelineContext): StepResult => {
      const result = updateFrontmatter(ctx.slug, ctx.config, ctx.urls, {
        configPath: ctx.paths.configPath,
      });
      if (!result.updated) {
        return { outcome: 'completed', message: result.reason ?? 'No frontmatter changes needed' };
      }
      return { outcome: 'completed', message: 'Frontmatter updated with platform URLs' };
    },
  },

  // Step 10: update-readme — add writing link to project README.
  {
    number: 10,
    name: 'update-readme',
    execute: (ctx: PipelineContext): StepResult => {
      const result = updateProjectReadme(ctx.slug, ctx.config, {
        configPath: ctx.paths.configPath,
      }, ctx.db);
      if (result.skipped) {
        return { outcome: 'skipped', message: result.reason ?? 'README update skipped' };
      }
      if (!result.updated) {
        return { outcome: 'completed', message: result.reason ?? 'No README changes needed' };
      }
      return { outcome: 'completed', message: 'Project README updated with writing link' };
    },
  },

  // Step 11: social-text — generate LinkedIn + Hacker News paste text.
  {
    number: 11,
    name: 'social-text',
    execute: (ctx: PipelineContext): StepResult => {
      const result = generateSocialText(ctx.slug, ctx.config, {
        socialDir: ctx.paths.socialDir,
        templatesDir: ctx.paths.templatesDir,
        draftsDir: ctx.paths.draftsDir,
      }, ctx.db);
      return {
        outcome: 'completed',
        message: `Social text generated: ${result.linkedinPath}, ${result.hackerNewsPath}`,
      };
    },
  },
];
