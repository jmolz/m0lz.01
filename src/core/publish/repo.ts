import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { BlogConfig } from '../config/types.js';
import { ContentType } from '../db/types.js';
// Import directly from the shared guard module. The prior re-export was
// kept during Cluster I for back-compat; Pass 3 consolidates on a single
// import surface to avoid split-brain between `repo.ts` and the canonical
// `origin-guard.ts` (Codex Pass 2 Minor #5).
import { getOriginState } from './origin-guard.js';

// Step 8 of the publish pipeline: push or create the companion repo on
// GitHub via the `gh` CLI. Content-type routing determines behaviour:
//
//   analysis-opinion    -> skip (no companion repo expected)
//   project-launch      -> skip (the project repo already exists; the
//                          publish pipeline does not own it)
//   technical-deep-dive -> push the repo scaffolded during the benchmark
//                          phase. Creates the remote repo if it does not
//                          exist yet; otherwise pushes to the existing one.
//
// Every subprocess call uses `execFileSync` with an argument array and no
// shell, matching the pattern established in `site.ts`.

export interface RepoPaths {
  reposDir: string;
}

export interface RepoResult {
  repoUrl?: string;
  skipped?: boolean;
  reason?: string;
}

interface SubprocessError extends Error {
  status?: number | null;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

export function pushCompanionRepo(
  slug: string,
  config: BlogConfig,
  paths: RepoPaths,
  db: Database.Database,
): RepoResult {
  const post = db
    .prepare('SELECT content_type, title FROM posts WHERE slug = ?')
    .get(slug) as { content_type: ContentType | null; title: string | null } | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }

  const contentType = post.content_type;

  if (contentType === 'analysis-opinion') {
    return { skipped: true, reason: 'No companion repo for analysis-opinion' };
  }

  if (contentType === 'project-launch') {
    return { skipped: true, reason: 'Existing project repo -- not created by publish pipeline' };
  }

  // technical-deep-dive: push or create companion repo.
  const repoName = `${config.author.github}/${slug}`;
  const repoPath = join(paths.reposDir, slug);

  if (!existsSync(repoPath)) {
    return { skipped: true, reason: 'No companion repo scaffolded' };
  }

  const canonicalUrl = `${config.site.base_url}/writing/${slug}`;
  const title = post.title ?? slug;

  // Probe whether the remote repo already exists.
  let remoteExists = false;
  try {
    execFileSync('gh', ['repo', 'view', repoName], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    remoteExists = true;
  } catch {
    remoteExists = false;
  }

  if (remoteExists) {
    // Ensure the local repo has origin pointing at the EXPECTED GitHub
    // target. assertOriginMatches throws if origin points somewhere else
    // — silently pushing would mutate an unrelated repository and report
    // success (Codex Pass 5 Critical).
    const state = getOriginState(repoPath, config.author.github, slug);
    if (state === 'absent') {
      execFileSync(
        'git',
        ['-C', repoPath, 'remote', 'add', 'origin', `https://github.com/${repoName}.git`],
        { encoding: 'utf-8' },
      );
    }

    execFileSync(
      'git',
      ['-C', repoPath, 'push', '-u', 'origin', 'HEAD:main'],
      { encoding: 'utf-8' },
    );
  } else {
    // Create the remote repo and push in one step. `gh repo create`
    // with --source and --push handles the initial push internally.
    const description = `Companion repo for ${title} -- ${canonicalUrl}`;
    try {
      execFileSync(
        'gh',
        [
          'repo', 'create', repoName,
          '--public',
          '--description', description,
          '--source', '.',
          '--push',
        ],
        { encoding: 'utf-8', cwd: repoPath },
      );
    } catch (err) {
      const e = err as SubprocessError;
      const stderr = typeof e.stderr === 'string' ? e.stderr : String(e.stderr ?? '');
      // Race condition: another process created the repo between our probe
      // and our create call. Fall back to a manual push.
      if (stderr.includes('already exists')) {
        // Same origin-URL guardrail as the remoteExists branch — the
        // race fallback must not push to an unrelated remote either.
        const state = getOriginState(repoPath, config.author.github, slug);
        if (state === 'absent') {
          execFileSync(
            'git',
            ['-C', repoPath, 'remote', 'add', 'origin', `https://github.com/${repoName}.git`],
            { encoding: 'utf-8' },
          );
        }
        execFileSync(
          'git',
          ['-C', repoPath, 'push', '-u', 'origin', 'HEAD:main'],
          { encoding: 'utf-8' },
        );
      } else {
        throw err;
      }
    }
  }

  return { repoUrl: `https://github.com/${repoName}` };
}
