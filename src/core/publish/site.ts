import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { BlogConfig } from '../config/types.js';

// Steps 3 + 4 of the publish pipeline.
//
// createSitePR (step 3): copy the draft MDX and research-page MDX into the
// m0lz.00 repo, commit on a slug-scoped branch (`post/{slug}`), push, and
// open a PR. Idempotent: repeated runs reuse an existing branch and PR when
// present and skip the commit step when there are no staged changes.
//
// checkPreviewGate (step 4): poll the PR's merge state via `gh pr view`.
// The gate only passes when a human merges the PR in the site repo — the
// Vercel preview deploy review is the human quality gate before the post
// goes live. Unmerged is a soft failure (return with message), not an
// exception, so the pipeline runner can surface the guidance to the user.
//
// Every subprocess call uses execFileSync with an argument array and no
// shell. Commands that legitimately exit non-zero (branch detection,
// `git diff --cached --quiet`, `gh pr list` with no matches) are wrapped
// in try/catch that reads the error's status and captured stdout.

export interface SitePaths {
  draftsDir: string; // .blog-agent/drafts
  researchPagesDir: string; // .blog-agent/research-pages
  publishDir: string; // .blog-agent/publish
  configPath: string; // absolute path to .blogrc.yaml
}

export interface SitePRResult {
  prNumber: number;
  prUrl: string;
  branchName: string;
}

export interface PreviewGateResult {
  merged: boolean;
  message?: string;
}

interface RepoCoords {
  owner: string;
  name: string;
}

// Resolve the on-disk site repo path from config, defending against both
// absolute and config-relative shapes. `loadConfig` already resolves
// repo_path against the config file's directory, but defense-in-depth: if
// the value arrives relative, re-anchor against dirname(configPath).
function resolveSiteRepoPath(configPath: string, repoPath: string): string {
  if (isAbsolute(repoPath)) return repoPath;
  return resolve(dirname(configPath), repoPath);
}

// Parse a git remote URL into owner + repo. Accepts both SSH
// (`git@github.com:owner/repo.git`) and HTTPS
// (`https://github.com/owner/repo(.git)?`) shapes. Throws on any other
// shape so the PR creation step surfaces a parse failure loudly rather
// than silently targeting the wrong repo.
function parseRepoCoords(remoteUrl: string): RepoCoords {
  const trimmed = remoteUrl.trim();
  const ssh = trimmed.match(/^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) {
    return { owner: ssh[1], name: ssh[2] };
  }
  const https = trimmed.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (https) {
    return { owner: https[1], name: https[2] };
  }
  throw new Error(`Could not parse git remote URL: ${remoteUrl}`);
}

// Best-effort retrieval of the PR URL from `gh pr create`. gh prints a
// variety of diagnostics before the URL; the URL is always the last
// http-prefixed token on stdout. Falls back to the last non-empty line.
function extractPrUrlFromGhOutput(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = lines[i].match(/https?:\/\/\S+/);
    if (match) return match[0];
  }
  return null;
}

// Parse a PR number out of a GitHub PR URL.
// e.g. https://github.com/owner/repo/pull/42 → 42
function prNumberFromUrl(url: string): number {
  const match = url.match(/\/pull\/(\d+)/);
  if (!match) {
    throw new Error(`Could not parse PR number from URL: ${url}`);
  }
  return Number(match[1]);
}

interface SubprocessError extends Error {
  status?: number | null;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

export function createSitePR(
  slug: string,
  config: BlogConfig,
  paths: SitePaths,
  db: Database.Database,
): SitePRResult {
  const siteRepoPath = resolveSiteRepoPath(paths.configPath, config.site.repo_path);
  if (!existsSync(siteRepoPath)) {
    throw new Error(`Site repo path does not exist: ${siteRepoPath}`);
  }

  const post = db
    .prepare('SELECT title, content_type FROM posts WHERE slug = ?')
    .get(slug) as { title: string | null; content_type: string | null } | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }
  const title = post.title ?? slug;

  // Fail fast if the site repo has uncommitted state that isn't ours.
  // Later in this function we stage ONLY pipeline-owned paths (content/
  // posts/<slug>, content/research/<slug>) — but any pre-existing dirty
  // state would still be in the working tree when the operator reviews
  // the PR, and prior implementations used `git add .` which would have
  // swept it into the commit outright. Failing closed here surfaces the
  // issue before it reaches the PR instead of relying on visual review.
  //
  // Do NOT .trim() the output: `git status --porcelain` lines start with
  // two status chars followed by a space, and trimming strips the leading
  // space of the " M path" form — corrupting the subsequent slice(3).
  // Split, drop empty trailing lines, then parse each line preserving its
  // column alignment.
  const porcelain = execFileSync(
    'git',
    ['-C', siteRepoPath, 'status', '--porcelain'],
    { encoding: 'utf-8' },
  );
  const porcelainLines = porcelain.split(/\r?\n/).filter((line) => line.length > 0);
  if (porcelainLines.length > 0) {
    const ownedPrefixes = [
      `${config.site.content_dir}/${slug}/`,
      `${config.site.research_dir}/${slug}/`,
    ];
    const isOwned = (p: string): boolean =>
      ownedPrefixes.some((prefix) => p.startsWith(prefix));
    const unrelated: string[] = [];
    for (const line of porcelainLines) {
      // Porcelain format: XY<space>path — for renames (R) and copies (C)
      // the path is encoded as "source -> destination" and BOTH sides
      // must be owned for the guardrail to tolerate the entry. Without
      // this split, a staged rename `content/posts/slug/foo -> static/
      // unrelated.tsx` would slip through: the raw string starts with
      // an owned prefix, but the destination is not owned and would
      // still be in the index for the subsequent commit.
      const status = line.slice(0, 2);
      const pathPart = line.slice(3);
      const isRenameOrCopy =
        status[0] === 'R' || status[0] === 'C' ||
        status[1] === 'R' || status[1] === 'C';
      const paths = isRenameOrCopy && pathPart.includes(' -> ')
        ? pathPart.split(' -> ')
        : [pathPart];
      for (const p of paths) {
        if (!isOwned(p)) {
          unrelated.push(p);
        }
      }
    }
    if (unrelated.length > 0) {
      throw new Error(
        `Site repo at '${siteRepoPath}' has uncommitted changes unrelated to this post:\n` +
        unrelated.map((p) => `  ${p}`).join('\n') + '\n' +
        `Commit, stash, or discard them before running 'blog publish start ${slug}'.`,
      );
    }
  }

  // Determine repo coordinates from the site repo's origin remote.
  const remoteUrl = execFileSync(
    'git',
    ['-C', siteRepoPath, 'config', '--get', 'remote.origin.url'],
    { encoding: 'utf-8' },
  ).trim();
  const coords = parseRepoCoords(remoteUrl);
  const repoFlag = `${coords.owner}/${coords.name}`;

  const branchName = `post/${slug}`;

  // Branch detection: `git branch --list` returns 0 whether the branch
  // matches or not — empty stdout means no match.
  const branchListing = execFileSync(
    'git',
    ['-C', siteRepoPath, 'branch', '--list', branchName],
    { encoding: 'utf-8' },
  ).trim();
  if (branchListing.length === 0) {
    execFileSync('git', ['-C', siteRepoPath, 'checkout', '-b', branchName, 'main'], {
      encoding: 'utf-8',
    });
  } else {
    execFileSync('git', ['-C', siteRepoPath, 'checkout', branchName], {
      encoding: 'utf-8',
    });
  }

  // Copy draft MDX into the site repo's content directory.
  const sourceDraftMdx = join(paths.draftsDir, slug, 'index.mdx');
  if (!existsSync(sourceDraftMdx)) {
    throw new Error(`Draft MDX not found: ${sourceDraftMdx}`);
  }
  const targetContentDir = join(siteRepoPath, config.site.content_dir, slug);
  mkdirSync(targetContentDir, { recursive: true });
  cpSync(sourceDraftMdx, join(targetContentDir, 'index.mdx'));

  // Copy assets directory if present.
  const sourceAssetsDir = join(paths.draftsDir, slug, 'assets');
  if (existsSync(sourceAssetsDir)) {
    cpSync(sourceAssetsDir, join(targetContentDir, 'assets'), { recursive: true });
  }

  // Copy research page (optional — skipped steps leave this absent).
  const sourceResearchMdx = join(paths.researchPagesDir, slug, 'index.mdx');
  if (existsSync(sourceResearchMdx)) {
    const targetResearchDir = join(siteRepoPath, config.site.research_dir, slug);
    mkdirSync(targetResearchDir, { recursive: true });
    cpSync(sourceResearchMdx, join(targetResearchDir, 'index.mdx'));
  }

  // Stage ONLY pipeline-owned paths. The dirty-state check at the top of
  // this function rejects unrelated modifications, but path-scoped staging
  // is a defense-in-depth: even if the check were bypassed (e.g., a new
  // file landed between the check and the add), only our owned paths get
  // committed.
  const contentPath = `${config.site.content_dir}/${slug}`;
  execFileSync('git', ['-C', siteRepoPath, 'add', contentPath], {
    encoding: 'utf-8',
  });
  const researchPath = `${config.site.research_dir}/${slug}`;
  if (existsSync(join(siteRepoPath, researchPath))) {
    execFileSync('git', ['-C', siteRepoPath, 'add', researchPath], {
      encoding: 'utf-8',
    });
  }

  // `git diff --cached --quiet` exits 1 when there ARE staged changes and 0
  // when the index is clean. Translate the exit code into a boolean.
  let hasStaged = false;
  try {
    execFileSync('git', ['-C', siteRepoPath, 'diff', '--cached', '--quiet'], {
      encoding: 'utf-8',
    });
    // Exit 0 → no staged changes
    hasStaged = false;
  } catch (err) {
    const e = err as SubprocessError;
    if (e.status === 1) {
      hasStaged = true;
    } else {
      throw err;
    }
  }

  if (hasStaged) {
    execFileSync(
      'git',
      ['-C', siteRepoPath, 'commit', '-m', `feat(post): ${slug}`],
      { encoding: 'utf-8' },
    );
  }

  // Push with upstream tracking. -u is safe to re-run.
  execFileSync(
    'git',
    ['-C', siteRepoPath, 'push', '-u', 'origin', branchName],
    { encoding: 'utf-8' },
  );

  // Look for an existing PR on this branch to make PR creation idempotent.
  let prUrl: string | null = null;
  let prNumber: number | null = null;

  const existingJson = execFileSync(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      repoFlag,
      '--head',
      branchName,
      '--json',
      'number,url',
    ],
    { encoding: 'utf-8' },
  );
  try {
    const parsed = JSON.parse(existingJson) as Array<{ number?: number; url?: string }>;
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0];
      if (typeof first.url === 'string' && typeof first.number === 'number') {
        prUrl = first.url;
        prNumber = first.number;
      }
    }
  } catch {
    // Tolerate malformed stdout — fall through to create.
  }

  if (prUrl === null || prNumber === null) {
    const body = `Automated PR for ${slug}\n\nSee ${paths.publishDir}/${slug} for context.`;
    const createOut = execFileSync(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        repoFlag,
        '--title',
        `Post: ${title}`,
        '--body',
        body,
        '--base',
        'main',
        '--head',
        branchName,
      ],
      { encoding: 'utf-8' },
    );
    const extracted = extractPrUrlFromGhOutput(createOut);
    if (!extracted) {
      throw new Error(
        `gh pr create did not return a parsable PR URL. Raw output: ${createOut}`,
      );
    }
    prUrl = extracted;
    prNumber = prNumberFromUrl(extracted);
  }

  // Persist the PR number so checkPreviewGate can retrieve it without
  // depending on runner-owned state.
  const prNumberDir = join(paths.publishDir, slug);
  mkdirSync(prNumberDir, { recursive: true });
  writeFileSync(join(prNumberDir, 'pr-number.txt'), `${prNumber}\n`, 'utf-8');

  return { prNumber, prUrl, branchName };
}

export function checkPreviewGate(
  slug: string,
  config: BlogConfig,
  paths: SitePaths,
): PreviewGateResult {
  const siteRepoPath = resolveSiteRepoPath(paths.configPath, config.site.repo_path);
  if (!existsSync(siteRepoPath)) {
    throw new Error(`Site repo path does not exist: ${siteRepoPath}`);
  }
  const remoteUrl = execFileSync(
    'git',
    ['-C', siteRepoPath, 'config', '--get', 'remote.origin.url'],
    { encoding: 'utf-8' },
  ).trim();
  const coords = parseRepoCoords(remoteUrl);
  const repoFlag = `${coords.owner}/${coords.name}`;

  const prNumberPath = join(paths.publishDir, slug, 'pr-number.txt');
  if (!existsSync(prNumberPath)) {
    return {
      merged: false,
      message: 'No PR number recorded — run site-pr step first',
    };
  }
  const prNumber = readFileSync(prNumberPath, 'utf-8').trim();

  const viewOut = execFileSync(
    'gh',
    ['pr', 'view', prNumber, '--repo', repoFlag, '--json', 'state,mergedAt'],
    { encoding: 'utf-8' },
  );
  let state = 'UNKNOWN';
  try {
    const parsed = JSON.parse(viewOut) as { state?: string; mergedAt?: string | null };
    if (typeof parsed.state === 'string') state = parsed.state;
  } catch {
    // Keep state='UNKNOWN' so the surface message still informs the user.
  }

  if (state === 'MERGED') {
    return { merged: true };
  }
  return {
    merged: false,
    message:
      `PR #${prNumber} is ${state} — review the Vercel preview, merge when ready, ` +
      `then re-run blog publish start ${slug}`,
  };
}
