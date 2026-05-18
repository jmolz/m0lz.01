import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { BlogConfig } from '../config/types.js';
import {
  distributionDirectory,
  GenerateDistributionKitResult,
  LINKEDIN_IMAGE_FILENAME,
} from './distribution-kit.js';
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

const OWNED_TEXT_ARTIFACT_FILENAMES = [
  'linkedin.md',
  'hackernews.md',
  'medium-paste.md',
  'substack-paste.md',
  'linkedin-image-prompt.md',
];

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

function assertNoUnrelatedDirty(repoPath: string, allowedPaths: string[]): void {
  const porcelain = execFileSync(
    'git',
    ['-C', repoPath, 'status', '--porcelain'],
    { encoding: 'utf-8' },
  );
  const lines = porcelain.split(/\r?\n/).filter(Boolean);
  const allowed = new Set(allowedPaths);
  const unrelated: string[] = [];
  for (const line of lines) {
    const pathPart = line.slice(3);
    const paths = pathPart.includes(' -> ') ? pathPart.split(' -> ') : [pathPart];
    for (const p of paths) {
      if (!allowed.has(p)) {
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
  isAllowedExtraPath: (path: string) => boolean = () => false,
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
  const expected = new Set(expectedPaths);
  const unexpected = actual.filter((file) => !expected.has(file) && !isAllowedExtraPath(file));
  if (actual.length === 0 || unexpected.length > 0) {
    return {
      ahead: 1,
      matches: false,
      reason:
        `Ahead commit touches [${actual.join(', ') || '(none)'}] but expected only owned paths ` +
        `[${[...expected].sort().join(', ')}]`,
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

function kitTextEntries(kit: GenerateDistributionKitResult): Array<{ path: string; label: string }> {
  return [
    kit.manifest.text.linkedin ? { path: kit.manifest.text.linkedin.path, label: 'LinkedIn text' } : null,
    kit.manifest.text.hackernews ? { path: kit.manifest.text.hackernews.path, label: 'Hacker News text' } : null,
    kit.manifest.text.medium ? { path: kit.manifest.text.medium.path, label: 'Medium paste' } : null,
    kit.manifest.text.substack ? { path: kit.manifest.text.substack.path, label: 'Substack paste' } : null,
    kit.manifest.prompt ? { path: kit.manifest.prompt.path, label: 'prompt' } : null,
  ].filter((entry): entry is { path: string; label: string } => entry !== null);
}

export function expectedSitePathsForKit(
  slug: string,
  config: BlogConfig,
  kit: GenerateDistributionKitResult,
  extraDistributionPaths: string[] = [],
): string[] {
  const distributionPrefix = `${config.site.content_dir}/${slug}/${distributionDirectory(config)}/`;
  return [
    ...kitTextEntries(kit).map((entry) => `${distributionPrefix}${entry.path}`),
    ...extraDistributionPaths,
    `${distributionPrefix}manifest.json`,
    ...(kit.imagePath ? [linkedinImageSitePath(slug, config)] : []),
    ...kit.manifest.tables.map((table) => `${config.site.content_dir}/${slug}/${table.path}`),
  ];
}

function isTrackedPath(repoPath: string, relativePath: string): boolean {
  try {
    execFileSync('git', ['-C', repoPath, 'ls-files', '--error-unmatch', relativePath], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return true;
  } catch (err) {
    const e = err as SubprocessError;
    if (e.status === 1) return false;
    throw err;
  }
}

export function omittedOwnedTextArtifactPaths(
  slug: string,
  config: BlogConfig,
  kit: GenerateDistributionKitResult,
): string[] {
  const distributionPrefix = `${config.site.content_dir}/${slug}/${distributionDirectory(config)}/`;
  const current = new Set(kitTextEntries(kit).map((entry) => entry.path));
  return OWNED_TEXT_ARTIFACT_FILENAMES
    .filter((filename) => !current.has(filename))
    .map((filename) => `${distributionPrefix}${filename}`);
}

function trackedStaleTextArtifactPaths(
  slug: string,
  config: BlogConfig,
  kit: GenerateDistributionKitResult,
  siteRepoPath: string,
): string[] {
  return omittedOwnedTextArtifactPaths(slug, config, kit)
    .filter((relativePath) => isTrackedPath(siteRepoPath, relativePath));
}

function linkedinImageSitePath(slug: string, config: BlogConfig): string {
  return `${config.site.content_dir}/${slug}/assets/${LINKEDIN_IMAGE_FILENAME}`;
}

export function omittedLinkedInImageArtifactPaths(
  slug: string,
  config: BlogConfig,
  kit: GenerateDistributionKitResult,
): string[] {
  return kit.imagePath ? [] : [linkedinImageSitePath(slug, config)];
}

function trackedStaleLinkedInImageArtifactPaths(
  slug: string,
  config: BlogConfig,
  kit: GenerateDistributionKitResult,
  siteRepoPath: string,
): string[] {
  return omittedLinkedInImageArtifactPaths(slug, config, kit)
    .filter((relativePath) => isTrackedPath(siteRepoPath, relativePath));
}

function portableTableSitePathPattern(slug: string, config: BlogConfig): RegExp {
  const prefix = `${config.site.content_dir}/${slug}/assets/`
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${prefix}portable-table-[0-9a-f]{12}\\.png$`);
}

export function isOwnedPortableTableSitePath(
  slug: string,
  config: BlogConfig,
  relativePath: string,
): boolean {
  return portableTableSitePathPattern(slug, config).test(relativePath);
}

function trackedPortableTableArtifactPaths(
  slug: string,
  config: BlogConfig,
  kit: GenerateDistributionKitResult,
  siteRepoPath: string,
): string[] {
  const current = new Set(
    kit.manifest.tables.map((table) => `${config.site.content_dir}/${slug}/${table.path}`),
  );
  const pathspec = `${config.site.content_dir}/${slug}/assets/portable-table-*.png`;
  const raw = execFileSync('git', ['-C', siteRepoPath, 'ls-files', '--', pathspec], {
    encoding: 'utf-8',
  });
  return String(raw).split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !current.has(line));
}

function existingPortableTableArtifactPaths(
  slug: string,
  config: BlogConfig,
  kit: GenerateDistributionKitResult,
  siteRepoPath: string,
): string[] {
  const current = new Set(
    kit.manifest.tables.map((table) => `${config.site.content_dir}/${slug}/${table.path}`),
  );
  const targetAssetsDir = join(siteRepoPath, config.site.content_dir, slug, 'assets');
  if (!existsSync(targetAssetsDir)) return [];
  return readdirSync(targetAssetsDir)
    .filter((entry) => /^portable-table-[0-9a-f]{12}\.png$/.test(entry))
    .map((entry) => `${config.site.content_dir}/${slug}/assets/${entry}`)
    .filter((relativePath) => !current.has(relativePath));
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function cleanupCandidateSitePathsForKit(
  slug: string,
  config: BlogConfig,
  kit: GenerateDistributionKitResult,
  siteRepoPath: string,
): string[] {
  return unique([
    ...omittedOwnedTextArtifactPaths(slug, config, kit),
    ...omittedLinkedInImageArtifactPaths(slug, config, kit),
    ...trackedPortableTableArtifactPaths(slug, config, kit, siteRepoPath),
    ...existingPortableTableArtifactPaths(slug, config, kit, siteRepoPath),
  ]);
}

export function trackedCleanupSitePathsForKit(
  slug: string,
  config: BlogConfig,
  kit: GenerateDistributionKitResult,
  siteRepoPath: string,
): string[] {
  return unique([
    ...trackedStaleTextArtifactPaths(slug, config, kit, siteRepoPath),
    ...trackedStaleLinkedInImageArtifactPaths(slug, config, kit, siteRepoPath),
    ...trackedPortableTableArtifactPaths(slug, config, kit, siteRepoPath),
  ]);
}

function assertCompatibleTarget(targetPath: string, sourcePath: string, label: string): void {
  if (!existsSync(targetPath)) return;
  const target = readFileSync(targetPath);
  const source = readFileSync(sourcePath);
  if (Buffer.compare(target, source) !== 0) {
    throw new Error(
      `Cannot persist distribution kit: existing site ${label} differs from the local manifest artifact: ${targetPath}`,
    );
  }
}

export function copyDistributionKitToPostDir(
  slug: string,
  config: BlogConfig,
  kit: GenerateDistributionKitResult,
  postDir: string,
  opts: { failOnConflict?: boolean; cleanupStaleTables?: boolean } = {},
): { removedPostPaths: string[] } {
  const distributionDir = distributionDirectory(config);
  const targetDistributionDir = join(postDir, distributionDir);
  const removedPostPaths: string[] = [];
  mkdirSync(targetDistributionDir, { recursive: true });

  if (opts.failOnConflict) {
    for (const entry of kitTextEntries(kit)) {
      assertCompatibleTarget(
        join(targetDistributionDir, entry.path),
        join(kit.directory, entry.path),
        entry.label,
      );
    }
    assertCompatibleTarget(join(targetDistributionDir, 'manifest.json'), kit.manifestPath, 'manifest');
    if (kit.imagePath) {
      assertCompatibleTarget(
        join(postDir, 'assets', 'linkedin-feed.png'),
        kit.imagePath,
        'LinkedIn image',
      );
    }
    for (const table of kit.manifest.tables) {
      assertCompatibleTarget(
        join(postDir, table.path),
        join(kit.directory, table.path),
        `table asset ${table.path}`,
      );
    }
  }

  for (const entry of kitTextEntries(kit)) {
    const source = join(kit.directory, entry.path);
    const target = join(targetDistributionDir, entry.path);
    copyFileSync(source, target);
  }

  const currentTextArtifacts = new Set(kitTextEntries(kit).map((entry) => entry.path));
  for (const filename of OWNED_TEXT_ARTIFACT_FILENAMES) {
    if (!currentTextArtifacts.has(filename)) {
      const target = join(targetDistributionDir, filename);
      if (existsSync(target)) {
        rmSync(target, { force: true });
        removedPostPaths.push(`${distributionDir}/${filename}`);
      }
    }
  }

  const manifestTarget = join(targetDistributionDir, 'manifest.json');
  copyFileSync(kit.manifestPath, manifestTarget);

  const targetAssetsDir = join(postDir, 'assets');
  if (kit.imagePath) {
    mkdirSync(targetAssetsDir, { recursive: true });
    const target = join(targetAssetsDir, LINKEDIN_IMAGE_FILENAME);
    copyFileSync(kit.imagePath, target);
  } else if (existsSync(join(targetAssetsDir, LINKEDIN_IMAGE_FILENAME))) {
    rmSync(join(targetAssetsDir, LINKEDIN_IMAGE_FILENAME), { force: true });
    removedPostPaths.push(`assets/${LINKEDIN_IMAGE_FILENAME}`);
  }

  const expectedTables = new Set(kit.manifest.tables.map((table) => table.path.replace(/^assets\//, '')));
  if (opts.cleanupStaleTables !== false && existsSync(targetAssetsDir)) {
    for (const entry of readdirSync(targetAssetsDir)) {
      if (/^portable-table-[0-9a-f]{12}\.png$/.test(entry) && !expectedTables.has(entry)) {
        rmSync(join(targetAssetsDir, entry), { force: true });
        removedPostPaths.push(`assets/${entry}`);
      }
    }
  }

  for (const table of kit.manifest.tables) {
    const source = join(kit.directory, table.path);
    const target = join(postDir, table.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  return { removedPostPaths: unique(removedPostPaths) };
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

  const expected = expectedSiteCoords(config);
  requireOriginMatch(siteRepoPath, expected.owner, expected.name);

  execFileSync('git', ['-C', siteRepoPath, 'checkout', 'main'], { encoding: 'utf-8' });
  execFileSync('git', ['-C', siteRepoPath, 'pull', '--ff-only'], { encoding: 'utf-8' });
  assertNoStaged(siteRepoPath);

  const cleanupAllowedPaths = cleanupCandidateSitePathsForKit(slug, config, kit, siteRepoPath);
  const dirtyAllowedPaths = expectedSitePathsForKit(slug, config, kit, cleanupAllowedPaths);
  const cleanupStagePaths = trackedCleanupSitePathsForKit(slug, config, kit, siteRepoPath);
  const expectedPaths = expectedSitePathsForKit(slug, config, kit, cleanupStagePaths);
  const replayExpectedPaths = expectedSitePathsForKit(
    slug,
    config,
    kit,
    [
      ...omittedOwnedTextArtifactPaths(slug, config, kit),
      ...omittedLinkedInImageArtifactPaths(slug, config, kit),
    ],
  );
  const expectedSubject = `chore(distribution): ${slug}`;
  const ahead = inspectAheadCommits(
    siteRepoPath,
    expectedSubject,
    replayExpectedPaths,
    (relativePath) => isOwnedPortableTableSitePath(slug, config, relativePath),
  );
  if (ahead.ahead > 0 && !ahead.matches) {
    refuseUnexpectedAhead(siteRepoPath, ahead.reason);
  }

  assertNoUnrelatedDirty(siteRepoPath, dirtyAllowedPaths);

  const postDir = join(siteRepoPath, config.site.content_dir, slug);
  if (!existsSync(join(postDir, 'index.mdx'))) {
    throw new Error(`Published post not found in site repo: ${join(postDir, 'index.mdx')}`);
  }

  copyDistributionKitToPostDir(slug, config, kit, postDir, {
    failOnConflict: true,
  });

  for (const expectedPath of expectedPaths) {
    execFileSync('git', ['-C', siteRepoPath, 'add', expectedPath], {
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
