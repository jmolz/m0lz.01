import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { BlogConfig } from '../config/types.js';
import { GenerateDistributionKitResult } from './distribution-kit.js';
import { expectedSiteCoords, requireOriginMatch } from './origin-guard.js';

export interface SiteArtifactPaths {
  configPath: string;
}

export interface SiteArtifactPersistResult {
  updated: boolean;
  reason?: string;
  paths: string[];
}

interface AheadInspection {
  ahead: number;
  matches: boolean;
  reason?: string;
}

interface SubprocessError extends Error {
  status?: number | null;
}

function resolveSiteRepoPath(configPath: string, repoPath: string): string {
  if (isAbsolute(repoPath)) return repoPath;
  return resolve(dirname(configPath), repoPath);
}

function assertNoStaged(repoPath: string): void {
  const stagedRaw = execFileSync(
    'git',
    ['-C', repoPath, 'diff', '--cached', '--name-only'],
    { encoding: 'utf-8' },
  );
  const staged = String(stagedRaw).trim();
  if (staged.length === 0) return;
  throw new Error(
    `Cannot persist distribution kit: repo at '${repoPath}' has staged changes:\n` +
    staged.split(/\r?\n/).map((p) => `  ${p}`).join('\n'),
  );
}

function assertNoUnrelatedDirty(repoPath: string, allowedPrefixes: string[]): void {
  const porcelain = execFileSync(
    'git',
    ['-C', repoPath, 'status', '--porcelain'],
    { encoding: 'utf-8' },
  );
  const lines = porcelain.split(/\r?\n/).filter(Boolean);
  const unrelated: string[] = [];
  for (const line of lines) {
    const pathPart = line.slice(3);
    const paths = pathPart.includes(' -> ') ? pathPart.split(' -> ') : [pathPart];
    for (const p of paths) {
      if (!allowedPrefixes.some((prefix) => p.startsWith(prefix))) {
        unrelated.push(p);
      }
    }
  }
  if (unrelated.length > 0) {
    throw new Error(
      `Site repo at '${repoPath}' has uncommitted changes unrelated to this distribution kit:\n` +
      unrelated.map((p) => `  ${p}`).join('\n'),
    );
  }
}

function inspectAheadCommits(
  repoPath: string,
  expectedSubject: string,
  expectedPaths: string[],
): AheadInspection {
  const logRaw = execFileSync(
    'git',
    ['-C', repoPath, 'log', 'origin/main..HEAD', '--format=%H%x09%s'],
    { encoding: 'utf-8' },
  );
  const logOut = String(logRaw).trim();
  if (logOut.length === 0) return { ahead: 0, matches: false };
  const lines = logOut.split(/\r?\n/);
  if (lines.length !== 1) {
    return { ahead: lines.length, matches: false, reason: `Expected 1 ahead commit, found ${lines.length}` };
  }
  const [hash, subject] = lines[0].split('\t');
  if (subject !== expectedSubject) {
    return { ahead: 1, matches: false, reason: `Ahead commit subject '${subject}' does not match '${expectedSubject}'` };
  }
  const filesRaw = execFileSync(
    'git',
    ['-C', repoPath, 'show', '--name-only', '--format=', hash],
    { encoding: 'utf-8' },
  );
  const actual = String(filesRaw).trim().split(/\r?\n/).filter(Boolean).sort();
  const expected = [...expectedPaths].sort();
  if (
    actual.length !== expected.length ||
    actual.some((file, index) => file !== expected[index])
  ) {
    return {
      ahead: 1,
      matches: false,
      reason: `Ahead commit touches [${actual.join(', ') || '(none)'}] but expected [${expected.join(', ')}]`,
    };
  }
  return { ahead: 1, matches: true };
}

function hasStagedChanges(repoPath: string): boolean {
  try {
    execFileSync('git', ['-C', repoPath, 'diff', '--cached', '--quiet'], {
      encoding: 'utf-8',
    });
    return false;
  } catch (err) {
    const e = err as SubprocessError;
    if (e.status === 1) return true;
    throw err;
  }
}

function refuseUnexpectedAhead(repoPath: string, reason: string | undefined): never {
  throw new Error(
    `persistDistributionKitToSite refused to push: ${reason ?? 'unexpected ahead commits'}. ` +
    `Inspect the site repo at '${repoPath}' manually before retrying.`,
  );
}

export function persistDistributionKitToSite(
  slug: string,
  config: BlogConfig,
  paths: SiteArtifactPaths,
  kit: GenerateDistributionKitResult,
): SiteArtifactPersistResult {
  const siteRepoPath = resolveSiteRepoPath(paths.configPath, config.site.repo_path);
  if (!existsSync(siteRepoPath)) {
    throw new Error(`Site repo path does not exist: ${siteRepoPath}`);
  }

  const distributionDir = config.social.distribution_kit.directory;
  const expected = expectedSiteCoords(config);
  requireOriginMatch(siteRepoPath, expected.owner, expected.name);

  execFileSync('git', ['-C', siteRepoPath, 'checkout', 'main'], { encoding: 'utf-8' });
  execFileSync('git', ['-C', siteRepoPath, 'pull', '--ff-only'], { encoding: 'utf-8' });
  assertNoStaged(siteRepoPath);

  const distributionPrefix = `${config.site.content_dir}/${slug}/${distributionDir}/`;
  const imageRelative = `${config.site.content_dir}/${slug}/assets/linkedin-feed.png`;
  const expectedPaths = [
    `${distributionPrefix}linkedin.md`,
    `${distributionPrefix}hackernews.md`,
    ...(kit.promptPath ? [`${distributionPrefix}linkedin-image-prompt.md`] : []),
    `${distributionPrefix}manifest.json`,
    ...(kit.imagePath ? [imageRelative] : []),
  ];
  const expectedSubject = `chore(distribution): ${slug}`;
  const ahead = inspectAheadCommits(siteRepoPath, expectedSubject, expectedPaths);
  if (ahead.ahead > 0 && !ahead.matches) {
    refuseUnexpectedAhead(siteRepoPath, ahead.reason);
  }

  assertNoUnrelatedDirty(siteRepoPath, [distributionPrefix, imageRelative]);

  const postDir = join(siteRepoPath, config.site.content_dir, slug);
  if (!existsSync(join(postDir, 'index.mdx'))) {
    throw new Error(`Published post not found in site repo: ${join(postDir, 'index.mdx')}`);
  }

  const targetDistributionDir = join(postDir, distributionDir);
  rmSync(targetDistributionDir, { recursive: true, force: true });
  mkdirSync(targetDistributionDir, { recursive: true });
  copyFileSync(kit.linkedinPath, join(targetDistributionDir, 'linkedin.md'));
  copyFileSync(kit.hackerNewsPath, join(targetDistributionDir, 'hackernews.md'));
  if (kit.promptPath) {
    copyFileSync(kit.promptPath, join(targetDistributionDir, 'linkedin-image-prompt.md'));
  }
  copyFileSync(kit.manifestPath, join(targetDistributionDir, 'manifest.json'));

  if (kit.imagePath) {
    const targetAssetsDir = join(postDir, 'assets');
    mkdirSync(targetAssetsDir, { recursive: true });
    copyFileSync(kit.imagePath, join(targetAssetsDir, 'linkedin-feed.png'));
  }

  execFileSync('git', ['-C', siteRepoPath, 'add', `${config.site.content_dir}/${slug}/${distributionDir}`], {
    encoding: 'utf-8',
  });
  if (kit.imagePath) {
    execFileSync('git', ['-C', siteRepoPath, 'add', imageRelative], {
      encoding: 'utf-8',
    });
  }

  if (!hasStagedChanges(siteRepoPath)) {
    if (ahead.ahead === 0) {
      return { updated: false, reason: 'No distribution-kit changes', paths: expectedPaths };
    }
    execFileSync('git', ['-C', siteRepoPath, 'push', 'origin', 'main'], {
      encoding: 'utf-8',
    });
    return {
      updated: true,
      reason: 'Pushed previously committed distribution-kit change',
      paths: expectedPaths,
    };
  }
  if (ahead.ahead > 0) {
    refuseUnexpectedAhead(
      siteRepoPath,
      'Existing distribution-kit ahead commit is waiting to be pushed, but the local artifacts now differ',
    );
  }

  execFileSync('git', ['-C', siteRepoPath, 'commit', '-m', expectedSubject], {
    encoding: 'utf-8',
  });
  execFileSync('git', ['-C', siteRepoPath, 'push', 'origin', 'main'], {
    encoding: 'utf-8',
  });
  return { updated: true, paths: expectedPaths };
}
