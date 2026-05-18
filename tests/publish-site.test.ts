import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

// Mock child_process BEFORE site.ts is imported so execFileSync resolves to
// the mock. site.ts uses execFileSync for every git + gh invocation, so the
// mock handler dispatches on argv to simulate whatever shape the test needs.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// eslint-disable-next-line import/first
import { execFileSync } from 'node:child_process';
// eslint-disable-next-line import/first
import { closeDatabase, getDatabase } from '../src/core/db/database.js';
// eslint-disable-next-line import/first
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
// eslint-disable-next-line import/first
import { createSitePR, checkPreviewGate, SitePaths } from '../src/core/publish/site.js';
// eslint-disable-next-line import/first
import { BlogConfig } from '../src/core/config/types.js';
// eslint-disable-next-line import/first
import { ensurePlatformImages } from '../src/core/publish/platform-images.js';

const mockExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

interface Fixture {
  tempDir: string;
  siteRepoPath: string;
  draftsDir: string;
  researchPagesDir: string;
  publishDir: string;
  configPath: string;
  db: Database.Database;
  config: BlogConfig;
  paths: SitePaths;
}

let fixture: Fixture | undefined;

function makeConfig(siteRepoPath: string): BlogConfig {
  return {
    site: {
      repo_path: siteRepoPath,
      base_url: 'https://m0lz.dev',
      content_dir: 'content/posts',
      research_dir: 'content/research',
      // Explicit coords — the local test tempdir basename is 'site' which
      // would otherwise make origin-guard expect 'jmolz/site'. Setting
      // `github_repo` overrides the basename fallback.
      github_repo: 'jmolz/m0lz.00',
    },
    author: { name: 'Tester', github: 'jmolz' },
    ai: {
      primary: 'claude-code',
      reviewers: { structural: 'claude-code', adversarial: 'codex-cli', methodology: 'codex-cli' },
      codex: { adversarial_effort: 'high', methodology_effort: 'xhigh' },
    },
    content_types: {
      'project-launch': { benchmark: 'optional', companion_repo: 'existing', social_prefix: 'Show HN:' },
      'technical-deep-dive': { benchmark: 'required', companion_repo: 'new', social_prefix: '' },
      'analysis-opinion': { benchmark: 'skip', companion_repo: 'optional', social_prefix: '' },
    },
    benchmark: { capture_environment: true, methodology_template: true, preserve_raw_data: true, multiple_runs: 3 },
    publish: { devto: true, medium: true, substack: true, github_repos: true, social_drafts: true, research_pages: true },
    social: { platforms: ['linkedin', 'hackernews'], timing_recommendations: true },
    evaluation: {
      require_pass: true, min_sources: 3, max_reading_level: 12, three_reviewer_panel: true,
      consensus_must_fix: true, majority_should_fix: true, single_advisory: true,
      verify_benchmark_claims: true, methodology_completeness: true,
    },
    updates: { preserve_original_data: true, update_notice: true, update_crosspost: true },
  };
}

function setup(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'publish-site-'));
  const siteRepoPath = join(tempDir, 'site');
  const draftsDir = join(tempDir, 'drafts');
  const researchPagesDir = join(tempDir, 'research-pages');
  const publishDir = join(tempDir, 'publish');
  const configPath = join(tempDir, '.blogrc.yaml');
  mkdirSync(siteRepoPath, { recursive: true });
  mkdirSync(draftsDir, { recursive: true });
  mkdirSync(researchPagesDir, { recursive: true });
  mkdirSync(publishDir, { recursive: true });
  // Touch configPath so resolveSiteRepoPath has a real anchor. createSitePR
  // doesn't read the file, but existsSync for the site repo needs to return
  // true for the non-mocked fs check.
  writeFileSync(configPath, '');

  const db = getDatabase(':memory:');
  const config = makeConfig(siteRepoPath);
  const paths: SitePaths = { draftsDir, researchPagesDir, publishDir, configPath };
  fixture = { tempDir, siteRepoPath, draftsDir, researchPagesDir, publishDir, configPath, db, config, paths };
  return fixture;
}

// Seed a valid publish-phase post so createSitePR's post lookup succeeds.
function seedPost(db: Database.Database, slug: string, title: string | null = 'Sample Title'): void {
  initResearchPost(db, slug, 'topic', 'directed', 'technical-deep-dive');
  advancePhase(db, slug, 'benchmark');
  advancePhase(db, slug, 'draft');
  advancePhase(db, slug, 'evaluate');
  db.prepare('UPDATE posts SET evaluation_passed = 1, title = ? WHERE slug = ?').run(title, slug);
  advancePhase(db, slug, 'publish');
}

// Write a draft MDX for the post under the configured drafts directory so
// createSitePR's cpSync sees a real source file.
function seedDraftMdx(
  draftsDir: string,
  slug: string,
  content = `---
title: "Sample Title"
description: "Description"
date: "2026-05-12"
tags:
  - test
published: false
canonical: "https://m0lz.dev/writing/sample"
devto_main_image: ./assets/devto-cover.png
medium_featured_image: ./assets/medium-featured.png
substack_preview_image: ./assets/substack-preview.png
---

# Hello

Body.`,
): void {
  const dir = join(draftsDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.mdx'), content, 'utf-8');
}

async function seedFreshPlatformImages(f: Fixture, slug: string): Promise<void> {
  await ensurePlatformImages(slug, f.config, { draftsDir: f.draftsDir });
}

afterEach(() => {
  if (fixture?.db) closeDatabase(fixture.db);
  if (fixture) rmSync(fixture.tempDir, { recursive: true, force: true });
  fixture = undefined;
  mockExec.mockReset();
});

// Build an exec-mock handler from a list of per-call response functions. Each
// handler receives (cmd, args) and returns either a string (success stdout)
// or throws to simulate non-zero exit. The real code sometimes catches errors
// with specific `.status` — tests can attach status to thrown Errors.
type ExecMatcher = (cmd: string, args: string[]) => string | Error | null;

function installExec(matcher: ExecMatcher): void {
  mockExec.mockImplementation((cmd: string, args: string[]) => {
    // Common prelude: dirty-state check runs at the top of createSitePR.
    // Default to "clean repo" so tests not focused on dirty-state detection
    // don't need to add boilerplate. Tests that DO want to simulate a
    // dirty repo bypass this by calling mockExec.mockImplementation
    // directly instead of installExec.
    if (cmd === 'git' && args.includes('status') && args.includes('--porcelain')) {
      return '';
    }
    // Default: origin-guard reads via `git remote get-url origin`. Return
    // the expected m0lz.00 origin so requireOriginMatch passes. Tests
    // focused on wrong-origin behavior override via direct mockImplementation.
    if (cmd === 'git' && args.includes('remote') && args.includes('get-url')) {
      return 'git@github.com:jmolz/m0lz.00.git\n';
    }
    // Default: origin-sync check — `git fetch origin main --quiet` and
    // `git rev-list --count origin/main..main`. Return "in sync"
    // (exit 0, zero ahead) so existing tests not focused on origin
    // divergence don't need to model the new v0.3 guard.
    if (cmd === 'git' && args.includes('fetch') && args.includes('origin')) {
      return '';
    }
    if (cmd === 'git' && args.includes('rev-list') && args.includes('--count')) {
      return '0\n';
    }
    const result = matcher(cmd, args);
    if (result instanceof Error) throw result;
    if (result === null) {
      throw new Error(`Unexpected exec call: ${cmd} ${args.join(' ')}`);
    }
    return result;
  });
}

// Construct a SubprocessError-shaped Error (as execFileSync would throw on
// non-zero exit). The caller sets .status to the simulated exit code.
function makeExecError(status: number, stdout = '', stderr = ''): Error {
  const e = new Error(`exec exit ${status}`) as Error & {
    status: number;
    stdout: string;
    stderr: string;
  };
  e.status = status;
  e.stdout = stdout;
  e.stderr = stderr;
  return e;
}

describe('createSitePR — happy path', () => {
  it('copies MDX, creates branch, pushes, opens PR, returns structured result', async () => {
    const f = setup();
    seedPost(f.db, 'alpha');
    seedDraftMdx(f.draftsDir, 'alpha');
    await seedFreshPlatformImages(f, 'alpha');

    let createCalls = 0;
    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('config') && args.includes('--get')) {
        return 'git@github.com:jmolz/m0lz.00.git\n';
      }
      if (cmd === 'git' && args.includes('branch') && args.includes('--list')) {
        // No existing branch — empty stdout.
        return '';
      }
      if (cmd === 'git' && args.includes('checkout') && args.includes('-b')) {
        return '';
      }
      if (cmd === 'git' && args.includes('add')) {
        return '';
      }
      if (cmd === 'git' && args.includes('diff') && args.includes('--cached')) {
        // Exit 1 = staged changes exist.
        throw makeExecError(1);
      }
      if (cmd === 'git' && args.includes('commit')) {
        return '';
      }
      if (cmd === 'git' && args.includes('push')) {
        return '';
      }
      if (cmd === 'gh' && args.includes('pr') && args.includes('list')) {
        return '[]';
      }
      if (cmd === 'gh' && args.includes('pr') && args.includes('create')) {
        createCalls += 1;
        return 'https://github.com/jmolz/m0lz.00/pull/42\n';
      }
      return null;
    });

    const result = await createSitePR('alpha', f.config, f.paths, f.db);

    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toBe('https://github.com/jmolz/m0lz.00/pull/42');
    expect(result.branchName).toBe('post/alpha');
    expect(createCalls).toBe(1);
    // The MDX was copied into the site repo.
    const copiedPath = join(f.siteRepoPath, 'content/posts/alpha/index.mdx');
    expect(existsSync(copiedPath)).toBe(true);
    expect(readFileSync(copiedPath, 'utf-8')).toMatch(/published:\s*true/);
    expect(readFileSync(join(f.draftsDir, 'alpha', 'index.mdx'), 'utf-8')).toMatch(/published:\s*false/);
  });

  it('copies assets directory when present', async () => {
    const f = setup();
    seedPost(f.db, 'withassets');
    seedDraftMdx(f.draftsDir, 'withassets');
    await seedFreshPlatformImages(f, 'withassets');
    const assetsDir = join(f.draftsDir, 'withassets', 'assets');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, 'diagram.svg'), '<svg/>');
    const sourceDraftPath = join(f.draftsDir, 'withassets', 'index.mdx');
    const sourceBefore = readFileSync(sourceDraftPath, 'utf-8');

    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('--get')) return 'git@github.com:jmolz/m0lz.00.git';
      if (cmd === 'git' && args.includes('--list')) return '';
      if (cmd === 'git' && args.includes('-b')) return '';
      if (cmd === 'git' && args.includes('add')) return '';
      if (cmd === 'git' && args.includes('--cached')) throw makeExecError(1);
      if (cmd === 'git' && args.includes('commit')) return '';
      if (cmd === 'git' && args.includes('push')) return '';
      if (cmd === 'gh' && args.includes('list')) return '[]';
      if (cmd === 'gh' && args.includes('create')) return 'https://github.com/jmolz/m0lz.00/pull/1';
      return null;
    });

    await createSitePR('withassets', f.config, f.paths, f.db);
    expect(existsSync(join(f.siteRepoPath, 'content/posts/withassets/assets/diagram.svg'))).toBe(true);
    expect(existsSync(join(f.siteRepoPath, 'content/posts/withassets/assets/devto-cover.png'))).toBe(true);
    expect(existsSync(join(f.siteRepoPath, 'content/posts/withassets/assets/medium-featured.png'))).toBe(true);
    expect(existsSync(join(f.siteRepoPath, 'content/posts/withassets/assets/substack-preview.png'))).toBe(true);
    expect(readFileSync(sourceDraftPath, 'utf-8')).toBe(sourceBefore);
    expect(existsSync(join(f.draftsDir, 'withassets', '.platform-images.json'))).toBe(true);
    const copiedMdx = readFileSync(join(f.siteRepoPath, 'content/posts/withassets/index.mdx'), 'utf-8');
    expect(copiedMdx).toMatch(/published:\s*true/);
    expect(copiedMdx).toContain('devto_main_image: ./assets/devto-cover.png');
    expect(copiedMdx).toContain('medium_featured_image: ./assets/medium-featured.png');
    expect(copiedMdx).toContain('substack_preview_image: ./assets/substack-preview.png');
  });

  it('refuses missing platform image frontmatter before branch checkout or site copy', async () => {
    const f = setup();
    seedPost(f.db, 'missingimages');
    seedDraftMdx(f.draftsDir, 'missingimages', `---
title: "Sample Title"
description: "Description"
date: "2026-05-12"
tags:
  - test
published: false
canonical: "https://m0lz.dev/writing/missingimages"
---

# Hello
`);
    const sourceDraftPath = join(f.draftsDir, 'missingimages', 'index.mdx');
    const sourceBefore = readFileSync(sourceDraftPath, 'utf-8');
    const execCalls: string[] = [];

    installExec((cmd, args) => {
      execCalls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'git' && args.includes('--get')) return 'git@github.com:jmolz/m0lz.00.git';
      return null;
    });

    await expect(createSitePR('missingimages', f.config, f.paths, f.db))
      .rejects.toThrow(/Missing platform image frontmatter: devto_main_image.*blog publish reopen-draft missingimages/s);

    expect(execCalls.some((call) => call.includes(' checkout '))).toBe(false);
    expect(existsSync(join(f.siteRepoPath, 'content/posts/missingimages'))).toBe(false);
    expect(existsSync(join(f.draftsDir, 'missingimages', '.platform-images.json'))).toBe(false);
    expect(existsSync(join(f.draftsDir, 'missingimages', 'assets'))).toBe(false);
    expect(readFileSync(sourceDraftPath, 'utf-8')).toBe(sourceBefore);
  });

  it('copies research page when researchPagesDir/slug/index.mdx exists', async () => {
    const f = setup();
    seedPost(f.db, 'withresearch');
    seedDraftMdx(f.draftsDir, 'withresearch');
    await seedFreshPlatformImages(f, 'withresearch');
    const rpDir = join(f.researchPagesDir, 'withresearch');
    mkdirSync(rpDir, { recursive: true });
    writeFileSync(join(rpDir, 'index.mdx'), '# Research');

    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('--get')) return 'git@github.com:jmolz/m0lz.00.git';
      if (cmd === 'git' && args.includes('--list')) return '';
      if (cmd === 'git' && args.includes('-b')) return '';
      if (cmd === 'git' && args.includes('add')) return '';
      if (cmd === 'git' && args.includes('--cached')) throw makeExecError(1);
      if (cmd === 'git' && args.includes('commit')) return '';
      if (cmd === 'git' && args.includes('push')) return '';
      if (cmd === 'gh' && args.includes('list')) return '[]';
      if (cmd === 'gh' && args.includes('create')) return 'https://github.com/jmolz/m0lz.00/pull/5';
      return null;
    });

    await createSitePR('withresearch', f.config, f.paths, f.db);
    expect(existsSync(join(f.siteRepoPath, 'content/research/withresearch/index.mdx'))).toBe(true);
  });

  it('skips research page copy when researchPagesDir/slug/index.mdx is absent', async () => {
    const f = setup();
    seedPost(f.db, 'noresearch');
    seedDraftMdx(f.draftsDir, 'noresearch');
    await seedFreshPlatformImages(f, 'noresearch');

    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('--get')) return 'git@github.com:jmolz/m0lz.00.git';
      if (cmd === 'git' && args.includes('--list')) return '';
      if (cmd === 'git' && args.includes('-b')) return '';
      if (cmd === 'git' && args.includes('add')) return '';
      if (cmd === 'git' && args.includes('--cached')) throw makeExecError(1);
      if (cmd === 'git' && args.includes('commit')) return '';
      if (cmd === 'git' && args.includes('push')) return '';
      if (cmd === 'gh' && args.includes('list')) return '[]';
      if (cmd === 'gh' && args.includes('create')) return 'https://github.com/jmolz/m0lz.00/pull/9';
      return null;
    });

    await createSitePR('noresearch', f.config, f.paths, f.db);
    expect(existsSync(join(f.siteRepoPath, 'content/research/noresearch'))).toBe(false);
  });

  it('writes pr-number.txt to publishDir/slug after PR creation', async () => {
    const f = setup();
    seedPost(f.db, 'prnumber');
    seedDraftMdx(f.draftsDir, 'prnumber');
    await seedFreshPlatformImages(f, 'prnumber');

    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('--get')) return 'git@github.com:jmolz/m0lz.00.git';
      if (cmd === 'git' && args.includes('--list')) return '';
      if (cmd === 'git' && args.includes('-b')) return '';
      if (cmd === 'git' && args.includes('add')) return '';
      if (cmd === 'git' && args.includes('--cached')) throw makeExecError(1);
      if (cmd === 'git' && args.includes('commit')) return '';
      if (cmd === 'git' && args.includes('push')) return '';
      if (cmd === 'gh' && args.includes('list')) return '[]';
      if (cmd === 'gh' && args.includes('create')) return 'https://github.com/jmolz/m0lz.00/pull/77';
      return null;
    });

    await createSitePR('prnumber', f.config, f.paths, f.db);
    const prPath = join(f.publishDir, 'prnumber', 'pr-number.txt');
    expect(existsSync(prPath)).toBe(true);
    expect(readFileSync(prPath, 'utf-8').trim()).toBe('77');
  });
});

describe('createSitePR — idempotency', () => {
  it('reuses existing branch when `git branch --list` returns non-empty', async () => {
    const f = setup();
    seedPost(f.db, 'existbranch');
    seedDraftMdx(f.draftsDir, 'existbranch');
    await seedFreshPlatformImages(f, 'existbranch');

    const checkoutArgs: string[][] = [];
    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('--get')) return 'git@github.com:jmolz/m0lz.00.git';
      if (cmd === 'git' && args.includes('--list')) {
        // Return a matching branch listing so site.ts takes the reuse path.
        return '  post/existbranch\n';
      }
      if (cmd === 'git' && args.includes('checkout')) {
        checkoutArgs.push(args.slice());
        return '';
      }
      if (cmd === 'git' && args.includes('add')) return '';
      if (cmd === 'git' && args.includes('--cached')) throw makeExecError(1);
      if (cmd === 'git' && args.includes('commit')) return '';
      if (cmd === 'git' && args.includes('push')) return '';
      if (cmd === 'gh' && args.includes('list')) return '[]';
      if (cmd === 'gh' && args.includes('create')) return 'https://github.com/jmolz/m0lz.00/pull/1';
      return null;
    });

    await createSitePR('existbranch', f.config, f.paths, f.db);
    // Exactly one checkout call and it must NOT include the `-b` flag (reuse path).
    expect(checkoutArgs).toHaveLength(1);
    expect(checkoutArgs[0]).not.toContain('-b');
  });

  it('reuses existing PR when `gh pr list` returns an entry (no pr create)', async () => {
    const f = setup();
    seedPost(f.db, 'existingpr');
    seedDraftMdx(f.draftsDir, 'existingpr');
    await seedFreshPlatformImages(f, 'existingpr');

    let createCalls = 0;
    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('--get')) return 'git@github.com:jmolz/m0lz.00.git';
      if (cmd === 'git' && args.includes('--list')) return '';
      if (cmd === 'git' && args.includes('-b')) return '';
      if (cmd === 'git' && args.includes('add')) return '';
      if (cmd === 'git' && args.includes('--cached')) throw makeExecError(1);
      if (cmd === 'git' && args.includes('commit')) return '';
      if (cmd === 'git' && args.includes('push')) return '';
      if (cmd === 'gh' && args.includes('list')) {
        return JSON.stringify([{ number: 99, url: 'https://github.com/jmolz/m0lz.00/pull/99' }]);
      }
      if (cmd === 'gh' && args.includes('create')) {
        createCalls += 1;
        return '';
      }
      return null;
    });

    const result = await createSitePR('existingpr', f.config, f.paths, f.db);
    expect(result.prNumber).toBe(99);
    expect(result.prUrl).toBe('https://github.com/jmolz/m0lz.00/pull/99');
    expect(createCalls).toBe(0);
  });

  it('skips commit call when `git diff --cached` exits 0 (no staged changes)', async () => {
    const f = setup();
    seedPost(f.db, 'nochanges');
    seedDraftMdx(f.draftsDir, 'nochanges');
    await seedFreshPlatformImages(f, 'nochanges');

    let commitCalls = 0;
    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('--get')) return 'git@github.com:jmolz/m0lz.00.git';
      if (cmd === 'git' && args.includes('--list')) return '';
      if (cmd === 'git' && args.includes('-b')) return '';
      if (cmd === 'git' && args.includes('add')) return '';
      if (cmd === 'git' && args.includes('--cached')) return ''; // exit 0 = clean
      if (cmd === 'git' && args.includes('commit')) {
        commitCalls += 1;
        return '';
      }
      if (cmd === 'git' && args.includes('push')) return '';
      if (cmd === 'gh' && args.includes('list')) return '[]';
      if (cmd === 'gh' && args.includes('create')) return 'https://github.com/jmolz/m0lz.00/pull/2';
      return null;
    });

    await createSitePR('nochanges', f.config, f.paths, f.db);
    expect(commitCalls).toBe(0);
  });
});

describe('createSitePR — git remote parsing', () => {
  it('accepts HTTPS remote URL shape', async () => {
    const f = setup();
    seedPost(f.db, 'https');
    seedDraftMdx(f.draftsDir, 'https');
    await seedFreshPlatformImages(f, 'https');

    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('--get')) return 'https://github.com/jmolz/m0lz.00.git\n';
      if (cmd === 'git' && args.includes('--list')) return '';
      if (cmd === 'git' && args.includes('-b')) return '';
      if (cmd === 'git' && args.includes('add')) return '';
      if (cmd === 'git' && args.includes('--cached')) throw makeExecError(1);
      if (cmd === 'git' && args.includes('commit')) return '';
      if (cmd === 'git' && args.includes('push')) return '';
      if (cmd === 'gh' && args.includes('list')) return '[]';
      if (cmd === 'gh' && args.includes('create')) return 'https://github.com/jmolz/m0lz.00/pull/3';
      return null;
    });

    const result = await createSitePR('https', f.config, f.paths, f.db);
    expect(result.prNumber).toBe(3);
  });

  it('throws on unparseable git remote URL', async () => {
    const f = setup();
    seedPost(f.db, 'weirdremote');
    seedDraftMdx(f.draftsDir, 'weirdremote');
    await seedFreshPlatformImages(f, 'weirdremote');

    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('--get')) return 'ftp://some/nonsense';
      return null;
    });

    await expect(createSitePR('weirdremote', f.config, f.paths, f.db))
      .rejects.toThrow(/Could not parse git remote URL/);
  });
});

describe('createSitePR — dirty-state guardrail (Codex Pass 4 regression)', () => {
  it('throws when the site repo has uncommitted changes unrelated to this post', async () => {
    const f = setup();
    seedPost(f.db, 'dirty');
    seedDraftMdx(f.draftsDir, 'dirty');
    await seedFreshPlatformImages(f, 'dirty');

    // Bypass installExec — we want full control of the status --porcelain
    // response. The simulated dirty state includes an UNRELATED file that
    // doesn't live under content/posts/dirty or content/research/dirty.
    mockExec.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('status') && args.includes('--porcelain')) {
        return ' M src/components/unrelated.tsx\n?? tmp/notes.md\n';
      }
      throw new Error(`Unexpected exec call: ${cmd} ${args.join(' ')}`);
    });

    await expect(createSitePR('dirty', f.config, f.paths, f.db))
      .rejects.toThrow(/uncommitted changes unrelated to this post/);
  });

  it('tolerates dirty state that is entirely under content/posts/<slug>/ (pipeline-owned)', async () => {
    const f = setup();
    seedPost(f.db, 'ownedonly');
    seedDraftMdx(f.draftsDir, 'ownedonly');
    await seedFreshPlatformImages(f, 'ownedonly');

    // Dirty state touches ONLY pipeline-owned paths — this is allowed
    // because the copy + add sequence will overwrite it deterministically.
    mockExec.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('status') && args.includes('--porcelain')) {
        return ' M content/posts/ownedonly/index.mdx\n';
      }
      if (cmd === 'git' && args.includes('remote') && args.includes('get-url')) {
        return 'git@github.com:jmolz/m0lz.00.git\n';
      }
      if (cmd === 'git' && args.includes('config') && args.includes('--get')) {
        return 'git@github.com:jmolz/m0lz.00.git\n';
      }
      if (cmd === 'git' && args.includes('fetch') && args.includes('origin')) return '';
      if (cmd === 'git' && args.includes('rev-list') && args.includes('--count')) return '0\n';
      if (cmd === 'git' && args.includes('branch') && args.includes('--list')) return '';
      if (cmd === 'git' && args.includes('checkout') && args.includes('-b')) return '';
      if (cmd === 'git' && args.includes('add')) return '';
      if (cmd === 'git' && args.includes('diff') && args.includes('--cached')) {
        throw makeExecError(1);
      }
      if (cmd === 'git' && args.includes('commit')) return '';
      if (cmd === 'git' && args.includes('push')) return '';
      if (cmd === 'gh' && args.includes('list')) return '[]';
      if (cmd === 'gh' && args.includes('create')) return 'https://github.com/jmolz/m0lz.00/pull/99';
      throw new Error(`Unexpected exec call: ${cmd} ${args.join(' ')}`);
    });

    await expect(createSitePR('ownedonly', f.config, f.paths, f.db)).resolves.toBeDefined();
  });

  it('rejects rename/copy records whose destination escapes owned prefixes (Codex Pass 5 regression)', async () => {
    // A staged rename like:
    //   R  content/posts/alpha/foo.ts -> static/leaked.ts
    // has an owned SOURCE but an UNOWNED DESTINATION. The naive slice(3) +
    // startsWith check misses this because the raw string starts with the
    // owned prefix. The fix: detect ' -> ' in R/C records, split, check
    // both sides for ownership. If either side isn't owned → reject.
    const f = setup();
    seedPost(f.db, 'renamed');
    seedDraftMdx(f.draftsDir, 'renamed');
    await seedFreshPlatformImages(f, 'renamed');

    mockExec.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('status') && args.includes('--porcelain')) {
        return 'R  content/posts/renamed/foo.ts -> static/leaked.ts\n';
      }
      throw new Error(`Unexpected exec call: ${cmd} ${args.join(' ')}`);
    });

    await expect(createSitePR('renamed', f.config, f.paths, f.db))
      .rejects.toThrow(/uncommitted changes unrelated to this post/);
  });

  it('tolerates rename/copy entries whose both sides live under owned prefixes', async () => {
    const f = setup();
    seedPost(f.db, 'owned-rename');
    seedDraftMdx(f.draftsDir, 'owned-rename');
    await seedFreshPlatformImages(f, 'owned-rename');

    // Both source and destination under content/posts/owned-rename/ — a
    // rename within the pipeline's own directory is tolerable.
    mockExec.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('status') && args.includes('--porcelain')) {
        return 'R  content/posts/owned-rename/old.mdx -> content/posts/owned-rename/index.mdx\n';
      }
      if (cmd === 'git' && args.includes('remote') && args.includes('get-url')) {
        return 'git@github.com:jmolz/m0lz.00.git\n';
      }
      if (cmd === 'git' && args.includes('config') && args.includes('--get')) {
        return 'git@github.com:jmolz/m0lz.00.git\n';
      }
      if (cmd === 'git' && args.includes('fetch') && args.includes('origin')) return '';
      if (cmd === 'git' && args.includes('rev-list') && args.includes('--count')) return '0\n';
      if (cmd === 'git' && args.includes('branch') && args.includes('--list')) return '';
      if (cmd === 'git' && args.includes('checkout') && args.includes('-b')) return '';
      if (cmd === 'git' && args.includes('add')) return '';
      if (cmd === 'git' && args.includes('diff') && args.includes('--cached')) {
        throw makeExecError(1);
      }
      if (cmd === 'git' && args.includes('commit')) return '';
      if (cmd === 'git' && args.includes('push')) return '';
      if (cmd === 'gh' && args.includes('list')) return '[]';
      if (cmd === 'gh' && args.includes('create')) return 'https://github.com/jmolz/m0lz.00/pull/201';
      throw new Error(`Unexpected exec call: ${cmd} ${args.join(' ')}`);
    });

    await expect(createSitePR('owned-rename', f.config, f.paths, f.db)).resolves.toBeDefined();
  });

  it('stages only pipeline-owned paths — not `git add .`', async () => {
    const f = setup();
    seedPost(f.db, 'scoped');
    seedDraftMdx(f.draftsDir, 'scoped');
    await seedFreshPlatformImages(f, 'scoped');

    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('config') && args.includes('--get')) {
        return 'git@github.com:jmolz/m0lz.00.git\n';
      }
      if (cmd === 'git' && args.includes('branch') && args.includes('--list')) return '';
      if (cmd === 'git' && args.includes('checkout') && args.includes('-b')) return '';
      if (cmd === 'git' && args.includes('add')) return '';
      if (cmd === 'git' && args.includes('diff') && args.includes('--cached')) {
        throw makeExecError(1);
      }
      if (cmd === 'git' && args.includes('commit')) return '';
      if (cmd === 'git' && args.includes('push')) return '';
      if (cmd === 'gh' && args.includes('list')) return '[]';
      if (cmd === 'gh' && args.includes('create')) return 'https://github.com/jmolz/m0lz.00/pull/42';
      return null;
    });

    await createSitePR('scoped', f.config, f.paths, f.db);

    // Critical: no `git add .` call — staging must be path-scoped.
    const addCalls = mockExec.mock.calls.filter(
      (call) => call[0] === 'git' && (call[1] as string[]).includes('add'),
    );
    expect(addCalls.length).toBeGreaterThan(0);
    for (const call of addCalls) {
      const args = call[1] as string[];
      expect(args).not.toContain('.');
      // The path arg must be the last element and match one of the owned
      // prefixes. Research dir is optional (existsSync check); when present
      // it's also owned. Accept either.
      const pathArg = args[args.length - 1];
      expect(
        pathArg === 'content/posts/scoped' ||
        pathArg === 'content/research/scoped',
      ).toBe(true);
    }
  });
});

describe('checkPreviewGate', () => {
  it('returns { merged: true } when PR state is MERGED', () => {
    const f = setup();
    // Stash the pr-number file that checkPreviewGate reads.
    mkdirSync(join(f.publishDir, 'merged'), { recursive: true });
    writeFileSync(join(f.publishDir, 'merged', 'pr-number.txt'), '42\n', 'utf-8');

    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('--get')) return 'git@github.com:jmolz/m0lz.00.git';
      if (cmd === 'gh' && args.includes('view')) {
        return JSON.stringify({ state: 'MERGED', mergedAt: '2026-04-16T00:00:00Z' });
      }
      return null;
    });

    const result = checkPreviewGate('merged', f.config, f.paths, f.db);
    expect(result.merged).toBe(true);
    expect(result.message).toBeUndefined();
  });

  it('returns { merged: false } with guidance when PR state is OPEN', () => {
    const f = setup();
    mkdirSync(join(f.publishDir, 'pending'), { recursive: true });
    writeFileSync(join(f.publishDir, 'pending', 'pr-number.txt'), '15', 'utf-8');

    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('--get')) return 'git@github.com:jmolz/m0lz.00.git';
      if (cmd === 'gh' && args.includes('view')) {
        return JSON.stringify({ state: 'OPEN' });
      }
      return null;
    });

    const result = checkPreviewGate('pending', f.config, f.paths, f.db);
    expect(result.merged).toBe(false);
    expect(result.message).toContain('15');
    expect(result.message).toContain('OPEN');
  });

  it('returns { merged: false } with guidance when pr-number.txt is missing', () => {
    const f = setup();
    // Do NOT write pr-number.txt — simulate missing state.

    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('--get')) return 'git@github.com:jmolz/m0lz.00.git';
      return null;
    });

    const result = checkPreviewGate('missing', f.config, f.paths, f.db);
    expect(result.merged).toBe(false);
    expect(result.message).toMatch(/No PR number recorded/);
  });
});
