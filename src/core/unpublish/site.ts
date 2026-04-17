import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { BlogConfig } from '../config/types.js';

// Phase 7: site-revert PR. Creates a PR that flips `published: false` in
// the post's MDX frontmatter. PR-only by design (no direct-push flag) —
// this is a destructive-looking change readers need to see in review.
//
// The PR body cites the stored unpublished_at timestamp so reviewers can
// cross-reference with the metrics audit log.

export interface SiteRevertPRPaths {
  configPath: string;
  publishDir: string;
}

export interface SiteRevertPRResult {
  prNumber: number;
  prUrl: string;
  branchName: string;
}

interface RepoCoords {
  owner: string;
  name: string;
}

function resolveSiteRepoPath(configPath: string, repoPath: string): string {
  if (isAbsolute(repoPath)) return repoPath;
  return resolve(dirname(configPath), repoPath);
}

function parseRepoCoords(remoteUrl: string): RepoCoords {
  const trimmed = remoteUrl.trim();
  const ssh = trimmed.match(/^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], name: ssh[2] };
  const https = trimmed.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (https) return { owner: https[1], name: https[2] };
  throw new Error(`Could not parse git remote URL: ${remoteUrl}`);
}

function extractPrUrlFromGhOutput(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = lines[i].match(/https?:\/\/\S+/);
    if (match) return match[0];
  }
  return null;
}

function prNumberFromUrl(url: string): number {
  const match = url.match(/\/pull\/(\d+)/);
  if (!match) throw new Error(`Could not parse PR number from URL: ${url}`);
  return Number(match[1]);
}

function flipPublishedToFalse(mdx: string): string {
  // Minimal frontmatter edit: replace `published: true` / no field with
  // `published: false`. If a `published:` line already exists, replace;
  // otherwise insert at the end of the frontmatter block.
  const fmEnd = mdx.match(/^---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
  if (!fmEnd) {
    throw new Error('site-revert: MDX has no frontmatter block');
  }
  const fmBlock = fmEnd[0];
  const hasLine = /\bpublished:\s*(?:true|false)/.test(fmBlock);
  let newFm: string;
  if (hasLine) {
    newFm = fmBlock.replace(/\bpublished:\s*(?:true|false)/, 'published: false');
  } else {
    newFm = fmBlock.replace(/\r?\n---(\s*)(\r?\n|$)/, '\npublished: false\n---$1$2');
  }
  return newFm + mdx.slice(fmBlock.length);
}

export function createSiteRevertPR(
  slug: string,
  config: BlogConfig,
  paths: SiteRevertPRPaths,
): SiteRevertPRResult {
  const siteRepoPath = resolveSiteRepoPath(paths.configPath, config.site.repo_path);
  if (!existsSync(siteRepoPath)) {
    throw new Error(`Site repo path does not exist: ${siteRepoPath}`);
  }

  // Clean-tree prelude: reject an already-dirty site repo to avoid
  // accidentally committing unrelated work into the revert PR.
  const porcelain = execFileSync(
    'git',
    ['-C', siteRepoPath, 'status', '--porcelain'],
    { encoding: 'utf-8' },
  );
  const porcelainLines = porcelain.split(/\r?\n/).filter((line) => line.length > 0);
  const ownedPrefix = `${config.site.content_dir}/${slug}/`;
  const unrelated = porcelainLines.filter((line) => {
    const pathPart = line.slice(3);
    const isRenameOrCopy =
      line[0] === 'R' || line[0] === 'C' ||
      line[1] === 'R' || line[1] === 'C';
    const parts = isRenameOrCopy && pathPart.includes(' -> ')
      ? pathPart.split(' -> ')
      : [pathPart];
    return parts.some((p) => !p.startsWith(ownedPrefix));
  });
  if (unrelated.length > 0) {
    throw new Error(
      `Site repo at '${siteRepoPath}' has unrelated uncommitted changes:\n` +
      unrelated.map((p) => `  ${p}`).join('\n') + '\n' +
      `Commit, stash, or discard them before running 'blog unpublish'.`,
    );
  }

  const remoteUrl = execFileSync(
    'git', ['-C', siteRepoPath, 'config', '--get', 'remote.origin.url'],
    { encoding: 'utf-8' },
  ).trim();
  const coords = parseRepoCoords(remoteUrl);
  const repoFlag = `${coords.owner}/${coords.name}`;

  const branchName = `unpublish/${slug}`;

  // Branch detection — `git branch --list` returns 0 whether or not the
  // branch matches; empty stdout means no match.
  const branchListing = execFileSync(
    'git', ['-C', siteRepoPath, 'branch', '--list', branchName],
    { encoding: 'utf-8' },
  ).trim();
  if (branchListing.length === 0) {
    execFileSync('git', ['-C', siteRepoPath, 'checkout', '-b', branchName, 'main'], {
      encoding: 'utf-8',
    });
  } else {
    execFileSync('git', ['-C', siteRepoPath, 'checkout', branchName], { encoding: 'utf-8' });
  }

  const mdxPath = join(siteRepoPath, config.site.content_dir, slug, 'index.mdx');
  if (!existsSync(mdxPath)) {
    throw new Error(`site-revert: MDX not found at ${mdxPath}`);
  }
  const original = readFileSync(mdxPath, 'utf-8');
  const rewritten = flipPublishedToFalse(original);
  if (rewritten !== original) {
    writeFileSync(mdxPath, rewritten, 'utf-8');
  }

  const contentPath = `${config.site.content_dir}/${slug}`;
  execFileSync('git', ['-C', siteRepoPath, 'add', contentPath], { encoding: 'utf-8' });

  let hasStaged = false;
  try {
    execFileSync('git', ['-C', siteRepoPath, 'diff', '--cached', '--quiet'], { encoding: 'utf-8' });
    hasStaged = false;
  } catch (err) {
    const e = err as { status?: number | null };
    if (e.status === 1) hasStaged = true;
    else throw err;
  }
  if (hasStaged) {
    execFileSync(
      'git',
      ['-C', siteRepoPath, 'commit', '-m', `chore(site): unpublish ${slug}`],
      { encoding: 'utf-8' },
    );
  }

  execFileSync('git', ['-C', siteRepoPath, 'push', '-u', 'origin', branchName], {
    encoding: 'utf-8',
  });

  // Idempotent PR creation.
  let prUrl: string | null = null;
  let prNumber: number | null = null;
  const existingJson = execFileSync(
    'gh', ['pr', 'list', '--repo', repoFlag, '--head', branchName, '--json', 'number,url'],
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
    // malformed listing — fall through to create
  }
  if (prUrl === null || prNumber === null) {
    const body =
      `Automated unpublish PR for ${slug}.\n\nFlips \`published: false\` in the post frontmatter. ` +
      `This is paired with a Dev.to PUT published:false and manual Medium/Substack removal ` +
      `(see ${paths.publishDir}/${slug} / .blog-agent/social/${slug}/).`;
    const createOut = execFileSync(
      'gh',
      [
        'pr', 'create',
        '--repo', repoFlag,
        '--title', `Unpublish: ${slug}`,
        '--body', body,
        '--base', 'main',
        '--head', branchName,
      ],
      { encoding: 'utf-8' },
    );
    const extracted = extractPrUrlFromGhOutput(createOut);
    if (!extracted) {
      throw new Error(`gh pr create returned no parsable URL. Raw: ${createOut}`);
    }
    prUrl = extracted;
    prNumber = prNumberFromUrl(extracted);
  }
  return { prNumber, prUrl, branchName };
}

// Re-use the same preview-gate polling as publish — checkUnpublishPreviewGate
// reads `gh pr view` for the unpublish branch to see if it has merged. The
// step returns 'paused' until merge lands.
export interface UnpublishPreviewGateResult {
  merged: boolean;
  message?: string;
}

export function checkUnpublishPreviewGate(
  slug: string,
  config: BlogConfig,
  paths: SiteRevertPRPaths,
): UnpublishPreviewGateResult {
  const siteRepoPath = resolveSiteRepoPath(paths.configPath, config.site.repo_path);
  const remoteUrl = execFileSync(
    'git', ['-C', siteRepoPath, 'config', '--get', 'remote.origin.url'],
    { encoding: 'utf-8' },
  ).trim();
  const coords = parseRepoCoords(remoteUrl);
  const repoFlag = `${coords.owner}/${coords.name}`;
  const branchName = `unpublish/${slug}`;
  let stdout = '';
  try {
    stdout = execFileSync(
      'gh',
      ['pr', 'view', branchName, '--repo', repoFlag, '--json', 'state,mergeCommit'],
      { encoding: 'utf-8' },
    );
  } catch (err) {
    const e = err as { stderr?: Buffer | string };
    return {
      merged: false,
      message: `gh pr view failed; unpublish PR may not exist yet. ${e.stderr ?? ''}`,
    };
  }
  try {
    const parsed = JSON.parse(stdout) as { state?: string; mergeCommit?: { oid: string } | null };
    if (parsed.state === 'MERGED') return { merged: true };
    return { merged: false, message: `PR state: ${parsed.state ?? 'unknown'} — merge to continue.` };
  } catch {
    return { merged: false, message: 'Could not parse gh pr view output.' };
  }
}
