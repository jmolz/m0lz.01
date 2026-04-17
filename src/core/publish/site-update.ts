import Database from 'better-sqlite3';

import { BlogConfig } from '../config/types.js';
import { getOpenUpdateCycle } from '../update/cycles.js';
import { createSitePR, SitePaths, SitePRResult } from './site.js';

// Phase 7: site-update step body. Update-mode equivalent of createSitePR —
// reuses the same dirty-state / origin-match / strict-ahead / rename-copy
// porcelain machinery but commits under an update-branch name with an
// update-cycle-scoped commit message and PR title. Operates as PR-mode by
// default; `config.updates.site_update_mode === 'direct'` is the advanced
// opt-out path (documented as "not recommended" in the example config).
//
// For initial site-update step, the step body looks up the currently-open
// update_cycles row and derives the branch / commit / PR title from it.
// The step then delegates to createSitePR with overrides.

export interface SiteUpdateResult extends SitePRResult {
  cycleNumber: number;
}

export function createSiteUpdate(
  slug: string,
  config: BlogConfig,
  paths: SitePaths,
  db: Database.Database,
): SiteUpdateResult {
  // site-update is an update-mode-only step. If no open cycle exists, this
  // is an operator bug — either the pipeline-runner was invoked with
  // publishMode='update' but no cycle was opened, or the cycle was closed
  // between invocation and this step. Both are catastrophic for the update
  // flow, so we throw rather than silently succeed.
  const cycle = getOpenUpdateCycle(db, slug);
  if (!cycle) {
    throw new Error(
      `site-update step: no open update cycle found for '${slug}'. ` +
      `Run 'blog update start' before 'blog update publish'.`,
    );
  }

  const post = db
    .prepare('SELECT title FROM posts WHERE slug = ?')
    .get(slug) as { title: string | null } | undefined;
  const title = post?.title ?? slug;

  const result = createSitePR(slug, config, paths, db, {
    branchName: `update/${slug}-cycle-${cycle.cycle_number}`,
    commitMessage: `chore(site): update ${slug} (cycle ${cycle.cycle_number})`,
    prTitle: `Update ${title} (cycle ${cycle.cycle_number})`,
    prBodyPrefix:
      `Automated update PR for ${slug} (cycle ${cycle.cycle_number}).\n\n` +
      (cycle.summary ? `Summary: ${cycle.summary}` : '(no summary provided)'),
  });

  return { ...result, cycleNumber: cycle.cycle_number };
}
