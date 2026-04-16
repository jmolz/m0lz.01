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
function seedDraftMdx(draftsDir: string, slug: string, content = '# Hello\n\nBody.'): void {
  const dir = join(draftsDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.mdx'), content, 'utf-8');
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
  it('copies MDX, creates branch, pushes, opens PR, returns structured result', () => {
    const f = setup();
    seedPost(f.db, 'alpha');
    seedDraftMdx(f.draftsDir, 'alpha');

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

    const result = createSitePR('alpha', f.config, f.paths, f.db);

    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toBe('https://github.com/jmolz/m0lz.00/pull/42');
    expect(result.branchName).toBe('post/alpha');
    expect(createCalls).toBe(1);
    // The MDX was copied into the site repo.
    expect(existsSync(join(f.siteRepoPath, 'content/posts/alpha/index.mdx'))).toBe(true);
  });

  it('copies assets directory when present', () => {
    const f = setup();
    seedPost(f.db, 'withassets');
    seedDraftMdx(f.draftsDir, 'withassets');
    const assetsDir = join(f.draftsDir, 'withassets', 'assets');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, 'diagram.svg'), '<svg/>');

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

    createSitePR('withassets', f.config, f.paths, f.db);
    expect(existsSync(join(f.siteRepoPath, 'content/posts/withassets/assets/diagram.svg'))).toBe(true);
  });

  it('copies research page when researchPagesDir/slug/index.mdx exists', () => {
    const f = setup();
    seedPost(f.db, 'withresearch');
    seedDraftMdx(f.draftsDir, 'withresearch');
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

    createSitePR('withresearch', f.config, f.paths, f.db);
    expect(existsSync(join(f.siteRepoPath, 'content/research/withresearch/index.mdx'))).toBe(true);
  });

  it('skips research page copy when researchPagesDir/slug/index.mdx is absent', () => {
    const f = setup();
    seedPost(f.db, 'noresearch');
    seedDraftMdx(f.draftsDir, 'noresearch');

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

    createSitePR('noresearch', f.config, f.paths, f.db);
    expect(existsSync(join(f.siteRepoPath, 'content/research/noresearch'))).toBe(false);
  });

  it('writes pr-number.txt to publishDir/slug after PR creation', () => {
    const f = setup();
    seedPost(f.db, 'prnumber');
    seedDraftMdx(f.draftsDir, 'prnumber');

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

    createSitePR('prnumber', f.config, f.paths, f.db);
    const prPath = join(f.publishDir, 'prnumber', 'pr-number.txt');
    expect(existsSync(prPath)).toBe(true);
    expect(readFileSync(prPath, 'utf-8').trim()).toBe('77');
  });
});

describe('createSitePR — idempotency', () => {
  it('reuses existing branch when `git branch --list` returns non-empty', () => {
    const f = setup();
    seedPost(f.db, 'existbranch');
    seedDraftMdx(f.draftsDir, 'existbranch');

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

    createSitePR('existbranch', f.config, f.paths, f.db);
    // Exactly one checkout call and it must NOT include the `-b` flag (reuse path).
    expect(checkoutArgs).toHaveLength(1);
    expect(checkoutArgs[0]).not.toContain('-b');
  });

  it('reuses existing PR when `gh pr list` returns an entry (no pr create)', () => {
    const f = setup();
    seedPost(f.db, 'existingpr');
    seedDraftMdx(f.draftsDir, 'existingpr');

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

    const result = createSitePR('existingpr', f.config, f.paths, f.db);
    expect(result.prNumber).toBe(99);
    expect(result.prUrl).toBe('https://github.com/jmolz/m0lz.00/pull/99');
    expect(createCalls).toBe(0);
  });

  it('skips commit call when `git diff --cached` exits 0 (no staged changes)', () => {
    const f = setup();
    seedPost(f.db, 'nochanges');
    seedDraftMdx(f.draftsDir, 'nochanges');

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

    createSitePR('nochanges', f.config, f.paths, f.db);
    expect(commitCalls).toBe(0);
  });
});

describe('createSitePR — git remote parsing', () => {
  it('accepts HTTPS remote URL shape', () => {
    const f = setup();
    seedPost(f.db, 'https');
    seedDraftMdx(f.draftsDir, 'https');

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

    const result = createSitePR('https', f.config, f.paths, f.db);
    expect(result.prNumber).toBe(3);
  });

  it('throws on unparseable git remote URL', () => {
    const f = setup();
    seedPost(f.db, 'weirdremote');
    seedDraftMdx(f.draftsDir, 'weirdremote');

    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('--get')) return 'ftp://some/nonsense';
      return null;
    });

    expect(() => createSitePR('weirdremote', f.config, f.paths, f.db)).toThrow(/Could not parse git remote URL/);
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

    const result = checkPreviewGate('merged', f.config, f.paths);
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

    const result = checkPreviewGate('pending', f.config, f.paths);
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

    const result = checkPreviewGate('missing', f.config, f.paths);
    expect(result.merged).toBe(false);
    expect(result.message).toMatch(/No PR number recorded/);
  });
});
