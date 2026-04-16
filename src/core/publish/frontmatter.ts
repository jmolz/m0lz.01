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

  const mdxPath = join(siteRepoPath, config.site.content_dir, slug, 'index.mdx');
  if (!existsSync(mdxPath)) {
    throw new Error(`MDX file not found: ${mdxPath}`);
  }

  // Read and parse the existing MDX.
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

  // Git: checkout main, pull, add, check for staged changes, commit, push.
  execFileSync('git', ['-C', siteRepoPath, 'checkout', 'main'], {
    encoding: 'utf-8',
  });

  execFileSync('git', ['-C', siteRepoPath, 'pull', '--ff-only'], {
    encoding: 'utf-8',
  });

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

  if (!hasStaged) {
    return { updated: false, reason: 'No frontmatter changes' };
  }

  execFileSync(
    'git',
    ['-C', siteRepoPath, 'commit', '-m', `chore(post): ${slug} add platform URLs`],
    { encoding: 'utf-8' },
  );

  execFileSync(
    'git',
    ['-C', siteRepoPath, 'push', 'origin', 'main'],
    { encoding: 'utf-8' },
  );

  return { updated: true };
}
