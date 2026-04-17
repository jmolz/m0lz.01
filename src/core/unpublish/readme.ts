import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { BlogConfig } from '../config/types.js';

// Phase 7: readme-revert. Removes the writing link added by the initial
// `update-readme` step. Direct-push to main (matches the Phase 6 readme
// step). THREE EXPLICIT SKIP PATHS (each returns skipped + reason):
//   1. post has no project_id                 (not a catalog project)
//   2. config.projects[post.project_id] absent (project repo unconfigured)
//   3. link not present in README              (already removed)

export interface ReadmeRevertPaths {
  configPath: string;
}

export interface ReadmeRevertResult {
  reverted: boolean;
  skipped?: boolean;
  reason?: string;
}

function resolveProjectRepoPath(configPath: string, repoPath: string): string {
  if (isAbsolute(repoPath)) return repoPath;
  return resolve(dirname(configPath), repoPath);
}

export function revertProjectReadmeLink(
  slug: string,
  config: BlogConfig,
  paths: ReadmeRevertPaths,
  db: Database.Database,
): ReadmeRevertResult {
  const post = db
    .prepare('SELECT project_id FROM posts WHERE slug = ?')
    .get(slug) as { project_id: string | null } | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }
  if (!post.project_id) {
    return { reverted: false, skipped: true, reason: 'post has no project_id' };
  }
  const projectsMap = config.projects ?? {};
  const projectRepoPath = projectsMap[post.project_id];
  if (!projectRepoPath) {
    return {
      reverted: false,
      skipped: true,
      reason: `config.projects['${post.project_id}'] is not configured`,
    };
  }
  const repo = resolveProjectRepoPath(paths.configPath, projectRepoPath);
  if (!existsSync(repo)) {
    return {
      reverted: false,
      skipped: true,
      reason: `project repo path not found: ${repo}`,
    };
  }
  const readmePath = join(repo, 'README.md');
  if (!existsSync(readmePath)) {
    return { reverted: false, skipped: true, reason: 'project README.md not found' };
  }

  // Dirty-state guardrail: reject if there are ANY unrelated changes in
  // the project repo. Path-scoped to README.md.
  const porcelain = execFileSync(
    'git', ['-C', repo, 'status', '--porcelain'],
    { encoding: 'utf-8' },
  );
  const lines = porcelain.split(/\r?\n/).filter((l) => l.length > 0);
  const unrelated = lines.filter((l) => !l.slice(3).startsWith('README.md'));
  if (unrelated.length > 0) {
    throw new Error(
      `Project repo at '${repo}' has unrelated uncommitted changes:\n` +
      unrelated.map((p) => `  ${p}`).join('\n'),
    );
  }

  const writingUrl = `${config.site.base_url.replace(/\/+$/, '')}/writing/${slug}`;
  const original = readFileSync(readmePath, 'utf-8');

  // Find + remove the writing link line. Tolerant regex: matches any line
  // containing the canonical URL (with or without surrounding markdown).
  const writingUrlEscaped = writingUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linePattern = new RegExp(
    `^.*${writingUrlEscaped}.*\\r?\\n?`,
    'gm',
  );
  const rewritten = original.replace(linePattern, '');
  if (rewritten === original) {
    return { reverted: false, skipped: true, reason: 'writing link not found in README' };
  }
  writeFileSync(readmePath, rewritten, 'utf-8');

  // Commit + push. Path-scoped add.
  execFileSync('git', ['-C', repo, 'add', 'README.md'], { encoding: 'utf-8' });
  execFileSync(
    'git',
    ['-C', repo, 'commit', '-m', `chore(readme): remove ${slug} writing link (unpublished)`],
    { encoding: 'utf-8' },
  );
  execFileSync('git', ['-C', repo, 'push', 'origin', 'main'], { encoding: 'utf-8' });
  return { reverted: true };
}
