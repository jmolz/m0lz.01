import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { BlogConfig } from '../config/types.js';

// Step 10 of the publish pipeline: update the project README in the site
// repo with a link back to the published post. Only applies to posts that
// have a `project_id` AND a matching entry in `config.projects`. Skips
// gracefully for posts without a project association.
//
// The update is idempotent: if the canonical URL already appears in the
// README, no changes are made and the function returns without committing.
//
// Subprocess pattern: `execFileSync` with argument arrays only, matching
// `site.ts`.

export interface ReadmePaths {
  configPath: string;
}

export interface ReadmeResult {
  updated: boolean;
  skipped?: boolean;
  reason?: string;
}

interface SubprocessError extends Error {
  status?: number | null;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

export function updateProjectReadme(
  slug: string,
  config: BlogConfig,
  paths: ReadmePaths,
  db: Database.Database,
): ReadmeResult {
  const post = db
    .prepare('SELECT title, project_id FROM posts WHERE slug = ?')
    .get(slug) as { title: string | null; project_id: string | null } | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }

  if (!post.project_id) {
    return { updated: false, skipped: true, reason: 'No project_id on post' };
  }

  if (!config.projects || !config.projects[post.project_id]) {
    return { updated: false, skipped: true, reason: `No projects config for '${post.project_id}'` };
  }

  // Resolve the project path against the directory of the config file so a
  // relative entry like "../m0lz.02" in .blogrc.yaml works regardless of the
  // process CWD. Mirrors site.ts's resolveSiteRepoPath pattern.
  const projectDir = resolve(dirname(paths.configPath), config.projects[post.project_id]);
  if (!existsSync(projectDir)) {
    return { updated: false, skipped: true, reason: `Project directory not found: ${projectDir}` };
  }

  const readmePath = join(projectDir, 'README.md');
  if (!existsSync(readmePath)) {
    return { updated: false, skipped: true, reason: `README.md not found in ${projectDir}` };
  }

  const canonicalUrl = `${config.site.base_url}/writing/${slug}`;
  const title = post.title ?? slug;

  // Idempotency: if the canonical URL is already present, skip.
  const readmeContent = readFileSync(readmePath, 'utf-8');
  if (readmeContent.includes(canonicalUrl)) {
    return { updated: false, reason: 'Canonical URL already present in README' };
  }

  // Insert a writing link under the `## Writing` heading. Create the heading
  // if it does not exist.
  const writingLink = `- [${title}](${canonicalUrl})`;
  let updatedContent: string;

  const writingHeadingPattern = /^## Writing\s*$/m;
  if (writingHeadingPattern.test(readmeContent)) {
    // Insert the link on the line after the heading.
    updatedContent = readmeContent.replace(
      writingHeadingPattern,
      `## Writing\n\n${writingLink}`,
    );
  } else {
    // Append the heading + link at the end of the file.
    const separator = readmeContent.endsWith('\n') ? '\n' : '\n\n';
    updatedContent = readmeContent + separator + `## Writing\n\n${writingLink}\n`;
  }

  writeFileSync(readmePath, updatedContent, 'utf-8');

  // Git: checkout main, pull, add, check staged, commit, push.
  execFileSync('git', ['-C', projectDir, 'checkout', 'main'], {
    encoding: 'utf-8',
  });

  execFileSync('git', ['-C', projectDir, 'pull', '--ff-only'], {
    encoding: 'utf-8',
  });

  execFileSync('git', ['-C', projectDir, 'add', readmePath], {
    encoding: 'utf-8',
  });

  // `git diff --cached --quiet` exits 1 when there ARE staged changes.
  let hasStaged = false;
  try {
    execFileSync('git', ['-C', projectDir, 'diff', '--cached', '--quiet'], {
      encoding: 'utf-8',
    });
    hasStaged = false;
  } catch (err) {
    const e = err as SubprocessError;
    if (e.status === 1) {
      hasStaged = true;
    } else {
      throw err;
    }
  }

  if (!hasStaged) {
    return { updated: false, reason: 'No README changes staged' };
  }

  execFileSync(
    'git',
    ['-C', projectDir, 'commit', '-m', `chore: add writing link for ${slug}`],
    { encoding: 'utf-8' },
  );

  execFileSync(
    'git',
    ['-C', projectDir, 'push', 'origin', 'main'],
    { encoding: 'utf-8' },
  );

  return { updated: true };
}
