import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import yaml from 'js-yaml';

import { BlogConfig } from '../config/types.js';
import { PublishUrls } from './types.js';

// Step 9 of the publish pipeline: update the MDX frontmatter in the site
// repo after the PR has been merged, then commit + push directly to main.
// This adds platform URLs (Dev.to, companion repo) and flips `published`
// to `true` — fields that are only known after the earlier pipeline steps
// complete.
//
// The update is idempotent: if the file already has all the expected values,
// `git diff --cached --quiet` detects no staged changes and the function
// returns without committing.
//
// Subprocess pattern: `execFileSync` with argument arrays only, matching
// `site.ts`.

export interface FrontmatterPaths {
  configPath: string;
}

export interface FrontmatterResult {
  updated: boolean;
  reason?: string;
}

interface SubprocessError extends Error {
  status?: number | null;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

// Describe the commits HEAD has ahead of origin/main, with a strict match
// check so the crash-replay push-ahead only fires when the ahead commits
// are unambiguously our pipeline's prior work.
//
// Prior revision (getAheadCount) returned a bare count — which would auto-
// push ANY unpushed commit on main, including unrelated operator work that
// happened to be sitting locally. That's a production hazard: a manually-
// edited README or config on main that the operator hadn't pushed would
// get shipped under the guise of "crash recovery."
//
// Strict match requires:
//   1. Exactly one commit ahead (more than one is already unexpected).
//   2. That commit's subject matches `expectedSubject` exactly.
//   3. That commit touches only one file, and that file equals `expectedPath`
//      (repo-root-relative, slash-separated).
// Callers that see `matches=false` MUST refuse to push and throw.
export interface AheadInspection {
  ahead: number;
  matches: boolean;
  reason?: string;
  commits: Array<{ hash: string; subject: string; files: string[] }>;
}

export function inspectAheadCommits(
  repoPath: string,
  expectedSubject: string,
  expectedPath: string,
): AheadInspection {
  // String() wrappers below defend against mocks that return Buffer
  // despite the encoding:'utf-8' hint (vitest vi.fn() can hand back
  // whatever the author sets). On real Node with encoding:'utf-8',
  // execFileSync returns a string already, so String() is a no-op.
  const logRaw = execFileSync(
    'git',
    ['-C', repoPath, 'log', 'origin/main..HEAD', '--format=%H%x09%s'],
    { encoding: 'utf-8' },
  );
  const logOut = String(logRaw).trim();
  if (logOut.length === 0) {
    return { ahead: 0, matches: false, commits: [] };
  }
  const lines = logOut.split(/\r?\n/);
  const commits = lines.map((line) => {
    const tabIdx = line.indexOf('\t');
    const hash = tabIdx === -1 ? line : line.slice(0, tabIdx);
    const subject = tabIdx === -1 ? '' : line.slice(tabIdx + 1);
    const filesRaw = execFileSync(
      'git',
      ['-C', repoPath, 'show', '--name-only', '--format=', hash],
      { encoding: 'utf-8' },
    );
    const filesOut = String(filesRaw).trim();
    const files = filesOut.length === 0 ? [] : filesOut.split(/\r?\n/).filter(Boolean);
    return { hash, subject, files };
  });

  if (commits.length !== 1) {
    return {
      ahead: commits.length,
      matches: false,
      reason: `Expected exactly 1 commit ahead of origin/main, found ${commits.length}`,
      commits,
    };
  }
  const [only] = commits;
  if (only.subject !== expectedSubject) {
    return {
      ahead: 1,
      matches: false,
      reason: `Ahead commit subject '${only.subject}' does not match expected '${expectedSubject}'`,
      commits,
    };
  }
  if (only.files.length !== 1 || only.files[0] !== expectedPath) {
    return {
      ahead: 1,
      matches: false,
      reason: `Ahead commit touches [${only.files.join(', ') || '(none)'}] but expected only [${expectedPath}]`,
      commits,
    };
  }
  return { ahead: 1, matches: true, commits };
}

export function updateFrontmatter(
  slug: string,
  config: BlogConfig,
  urls: PublishUrls,
  paths: FrontmatterPaths,
): FrontmatterResult {
  const siteRepoPath = config.site.repo_path;
  if (!existsSync(siteRepoPath)) {
    throw new Error(`Site repo path does not exist: ${siteRepoPath}`);
  }

  // CRITICAL ordering: switch to main BEFORE any file mutation. Step 3
  // (createSitePR) leaves the site repo on branch `post/<slug>`. If we
  // read/write the MDX first, the worktree becomes dirty and `git
  // checkout main` either aborts (file doesn't exist on local main) or
  // carries the edit across branches — both wrong. Pulling first also
  // ensures the just-merged PR's version is what we edit, not a stale
  // copy from the feature branch.
  execFileSync('git', ['-C', siteRepoPath, 'checkout', 'main'], {
    encoding: 'utf-8',
  });
  execFileSync('git', ['-C', siteRepoPath, 'pull', '--ff-only'], {
    encoding: 'utf-8',
  });

  const mdxRelative = `${config.site.content_dir}/${slug}/index.mdx`;
  const mdxPath = join(siteRepoPath, mdxRelative);
  if (!existsSync(mdxPath)) {
    throw new Error(`MDX file not found: ${mdxPath}`);
  }

  // Read and parse the existing MDX (now the merged-to-main version).
  const mdxContent = readFileSync(mdxPath, 'utf-8');
  const fmMatch = mdxContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!fmMatch) {
    throw new Error(`MDX content missing frontmatter delimiters: ${mdxPath}`);
  }

  const parsed = yaml.load(fmMatch[1]);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Frontmatter is not a valid YAML object: ${mdxPath}`);
  }
  const fm = parsed as Record<string, unknown>;

  // Apply updates.
  fm.published = true;
  fm.canonical = `${config.site.base_url}/writing/${slug}`;

  if (urls.devto_url) {
    fm.devto_url = urls.devto_url;
  }
  if (urls.repo_url) {
    fm.companion_repo = urls.repo_url;
  }

  // Serialize back to YAML and reassemble the MDX file.
  const dumped = yaml.dump(fm, { lineWidth: -1, quotingType: '"', forceQuotes: false });
  const afterFrontmatter = mdxContent.slice(fmMatch[0].length);
  const updated = `---\n${dumped}---\n${afterFrontmatter}`;
  writeFileSync(mdxPath, updated, 'utf-8');

  execFileSync('git', ['-C', siteRepoPath, 'add', mdxPath], {
    encoding: 'utf-8',
  });

  // `git diff --cached --quiet` exits 1 when there ARE staged changes.
  let hasStaged = false;
  try {
    execFileSync('git', ['-C', siteRepoPath, 'diff', '--cached', '--quiet'], {
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

  const expectedSubject = `chore(post): ${slug} add platform URLs`;

  if (!hasStaged) {
    // No local edit staged. Check whether a prior run committed the edit
    // locally and died before `git push`. We only auto-push if EXACTLY
    // ONE ahead commit exists AND its subject + touched file match our
    // pipeline's expected shape. Anything else (2+ ahead, wrong subject,
    // unrelated file) is refused — the operator must inspect manually
    // instead of us shipping their unrelated local work.
    const backlog = inspectAheadCommits(siteRepoPath, expectedSubject, mdxRelative);
    if (backlog.ahead === 0) {
      return { updated: false, reason: 'No frontmatter changes' };
    }
    if (!backlog.matches) {
      throw new Error(
        `updateFrontmatter refused to push: ${backlog.reason ?? 'unexpected ahead commits'}. ` +
        `Inspect the site repo at '${siteRepoPath}' manually (git log origin/main..HEAD) before retrying.`,
      );
    }
    execFileSync('git', ['-C', siteRepoPath, 'push', 'origin', 'main'], {
      encoding: 'utf-8',
    });
    return {
      updated: true,
      reason: 'Pushed previously-committed change that never reached origin',
    };
  }

  execFileSync(
    'git',
    ['-C', siteRepoPath, 'commit', '-m', expectedSubject],
    { encoding: 'utf-8' },
  );

  execFileSync(
    'git',
    ['-C', siteRepoPath, 'push', 'origin', 'main'],
    { encoding: 'utf-8' },
  );

  return { updated: true };
}
