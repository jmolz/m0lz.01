import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { BlogConfig } from '../config/types.js';
import { PostRow } from '../db/types.js';
import { parseGitHubRemoteUrl, readOriginUrl } from './origin-guard.js';

// Three URLs the preview-gate surface exposes so the `/blog` skill can
// render them at the preview-gate checkpoint. Shipped both as part of
// `PreviewGateResult` (step-level return) and via the `publish show --json`
// envelope (operator-facing state query). Either surface must produce the
// same values for a given (post, config) pair — use this helper everywhere
// rather than reinventing the computation.
export interface PreviewUrls {
  // Always present — derived from config.site.base_url + slug.
  canonicalUrl: string;
  // Null when no research page has been generated for this post.
  // Surfaces the m0lz.00 /research/<slug> companion page when present.
  supplementaryUrl: string | null;
  // Null when the companion repo URL cannot be resolved from post state
  // or config. Prefers `posts.repo_url` (set by the companion-repo step)
  // over re-reading the git origin of the registered project directory.
  companionRepoUrl: string | null;
}

export function computePreviewUrls(
  post: PostRow,
  config: BlogConfig,
  configPath: string,
  researchPagesDir: string,
): PreviewUrls {
  const canonicalUrl = `${config.site.base_url}/writing/${post.slug}`;

  // Supplementary page exists iff the research-page step produced an
  // MDX artifact for this slug. Checking the file avoids threading
  // additional state through the post row (the current schema has no
  // `research_page_path` column).
  const researchPageFile = join(researchPagesDir, post.slug, 'index.mdx');
  const supplementaryUrl = existsSync(researchPageFile)
    ? `${config.site.base_url}/research/${post.slug}`
    : null;

  // Prefer the URL the companion-repo step already persisted. Falls back
  // to reading the git origin of the registered project dir — same
  // resolution path the frontmatter emitter uses at draft-init time.
  let companionRepoUrl: string | null = null;
  if (post.repo_url) {
    companionRepoUrl = post.repo_url;
  } else if (post.project_id && config.projects?.[post.project_id]) {
    try {
      const projectDir = resolve(dirname(configPath), config.projects[post.project_id]);
      const raw = readOriginUrl(projectDir);
      if (raw) {
        const parsed = parseGitHubRemoteUrl(raw);
        if (parsed) {
          companionRepoUrl = `https://github.com/${parsed.owner}/${parsed.name}`;
        }
      }
    } catch {
      // Best-effort: missing project dir, non-git path, or weird subprocess
      // failure all yield null. The preview gate is informational — a
      // degraded environment should not break `blog publish show --json`.
    }
  }

  return { canonicalUrl, supplementaryUrl, companionRepoUrl };
}
