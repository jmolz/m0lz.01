import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

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
import { pushCompanionRepo, RepoPaths } from '../src/core/publish/repo.js';
// eslint-disable-next-line import/first
import { parseGitHubRemoteUrl } from '../src/core/publish/origin-guard.js';
// eslint-disable-next-line import/first
import { BlogConfig } from '../src/core/config/types.js';

const mockExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

function makeConfig(githubUser = 'jmolz'): BlogConfig {
  return {
    site: {
      repo_path: '/tmp/site',
      base_url: 'https://m0lz.dev',
      content_dir: 'content/posts',
      research_dir: 'content/research',
    },
    author: { name: 'Tester', github: githubUser },
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

interface Fixture {
  tempDir: string;
  reposDir: string;
  db: Database.Database;
  paths: RepoPaths;
}

let fixture: Fixture | undefined;

function setup(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'publish-repo-'));
  const reposDir = join(tempDir, 'repos');
  mkdirSync(reposDir, { recursive: true });
  const db = getDatabase(':memory:');
  fixture = { tempDir, reposDir, db, paths: { reposDir } };
  return fixture;
}

afterEach(() => {
  if (fixture?.db) closeDatabase(fixture.db);
  if (fixture) rmSync(fixture.tempDir, { recursive: true, force: true });
  fixture = undefined;
  mockExec.mockReset();
});

function seedPost(
  db: Database.Database,
  slug: string,
  contentType: 'project-launch' | 'technical-deep-dive' | 'analysis-opinion',
  title = 'Repo Title',
): void {
  initResearchPost(db, slug, 'topic', 'directed', contentType);
  advancePhase(db, slug, 'benchmark');
  advancePhase(db, slug, 'draft');
  advancePhase(db, slug, 'evaluate');
  db.prepare('UPDATE posts SET title = ?, evaluation_passed = 1 WHERE slug = ?').run(title, slug);
  advancePhase(db, slug, 'publish');
}

// Create an empty directory at reposDir/slug so existsSync passes.
function seedRepoDir(reposDir: string, slug: string): void {
  mkdirSync(join(reposDir, slug), { recursive: true });
}

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

function makeExecError(status: number, stderr = ''): Error {
  const e = new Error(`exec exit ${status}`) as Error & {
    status: number;
    stdout: string;
    stderr: string;
  };
  e.status = status;
  e.stdout = '';
  e.stderr = stderr;
  return e;
}

describe('pushCompanionRepo — content type routing', () => {
  it('skips for analysis-opinion with no exec calls', () => {
    const f = setup();
    seedPost(f.db, 'op', 'analysis-opinion');
    const result = pushCompanionRepo('op', makeConfig(), f.paths, f.db);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/analysis-opinion/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('skips for project-launch (existing project repo owned elsewhere)', () => {
    const f = setup();
    seedPost(f.db, 'launch', 'project-launch');
    const result = pushCompanionRepo('launch', makeConfig(), f.paths, f.db);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/Existing project repo/i);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('skips for technical-deep-dive when no scaffolded repo directory exists', () => {
    const f = setup();
    seedPost(f.db, 'noscaffold', 'technical-deep-dive');
    // Do NOT seedRepoDir — the directory is absent.
    const result = pushCompanionRepo('noscaffold', makeConfig(), f.paths, f.db);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/No companion repo scaffolded/);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe('pushCompanionRepo — technical-deep-dive paths', () => {
  it('pushes to existing remote when `gh repo view` succeeds', () => {
    const f = setup();
    seedPost(f.db, 'existingrepo', 'technical-deep-dive');
    seedRepoDir(f.reposDir, 'existingrepo');

    const calls: Array<{ cmd: string; args: string[] }> = [];
    installExec((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'gh' && args[1] === 'view') return ''; // exists
      if (cmd === 'git' && args.includes('get-url')) return 'https://github.com/jmolz/existingrepo.git';
      if (cmd === 'git' && args.includes('push')) return '';
      return null;
    });

    const result = pushCompanionRepo('existingrepo', makeConfig(), f.paths, f.db);
    expect(result.repoUrl).toBe('https://github.com/jmolz/existingrepo');
    // Must NOT have called `gh repo create` on the existing-remote path.
    expect(calls.some((c) => c.cmd === 'gh' && c.args[1] === 'create')).toBe(false);
    // Must have pushed.
    expect(calls.some((c) => c.cmd === 'git' && c.args.includes('push'))).toBe(true);
  });

  it('creates and pushes when `gh repo view` fails (remote does not exist)', () => {
    const f = setup();
    seedPost(f.db, 'newrepo', 'technical-deep-dive');
    seedRepoDir(f.reposDir, 'newrepo');

    const calls: Array<{ cmd: string; args: string[] }> = [];
    installExec((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'gh' && args[1] === 'view') throw makeExecError(1, 'not found');
      if (cmd === 'gh' && args[1] === 'create') return '';
      return null;
    });

    const result = pushCompanionRepo('newrepo', makeConfig(), f.paths, f.db);
    expect(result.repoUrl).toBe('https://github.com/jmolz/newrepo');
    // Must have called `gh repo create` with --source . --push.
    const createCall = calls.find((c) => c.cmd === 'gh' && c.args[1] === 'create');
    expect(createCall).toBeDefined();
    expect(createCall!.args).toContain('--source');
    expect(createCall!.args).toContain('--push');
    expect(createCall!.args).toContain('jmolz/newrepo');
  });

  it('falls back to manual push on `gh repo create` "already exists" race', () => {
    const f = setup();
    seedPost(f.db, 'racerepo', 'technical-deep-dive');
    seedRepoDir(f.reposDir, 'racerepo');

    const calls: Array<{ cmd: string; args: string[] }> = [];
    installExec((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'gh' && args[1] === 'view') throw makeExecError(1);
      if (cmd === 'gh' && args[1] === 'create') throw makeExecError(1, 'repository name already exists');
      if (cmd === 'git' && args.includes('get-url')) return 'https://github.com/jmolz/racerepo.git';
      if (cmd === 'git' && args.includes('push')) return '';
      return null;
    });

    const result = pushCompanionRepo('racerepo', makeConfig(), f.paths, f.db);
    expect(result.repoUrl).toBe('https://github.com/jmolz/racerepo');
    // Should have followed create-failure with a push.
    expect(calls.some((c) => c.cmd === 'git' && c.args.includes('push'))).toBe(true);
  });

  it('adds origin remote when `git remote get-url origin` fails', () => {
    const f = setup();
    seedPost(f.db, 'noorigin', 'technical-deep-dive');
    seedRepoDir(f.reposDir, 'noorigin');

    const calls: Array<{ cmd: string; args: string[] }> = [];
    installExec((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'gh' && args[1] === 'view') return '';
      // Realistic git error shape: exit 128 with stderr including
      // "No such remote 'origin'". The origin-guard narrows its "absent"
      // detection to this specific stderr marker in Pass 3 (previously
      // any error = absent, which masked environment bugs).
      if (cmd === 'git' && args.includes('get-url')) {
        throw makeExecError(128, "fatal: No such remote 'origin'\n");
      }
      if (cmd === 'git' && args.includes('add') && args.includes('origin')) return '';
      if (cmd === 'git' && args.includes('push')) return '';
      return null;
    });

    pushCompanionRepo('noorigin', makeConfig(), f.paths, f.db);
    // Verify `git remote add origin <url>` was called.
    const addCall = calls.find((c) => c.cmd === 'git' && c.args.includes('add') && c.args.includes('origin'));
    expect(addCall).toBeDefined();
    expect(addCall!.args.some((a) => a.includes('github.com/jmolz/noorigin'))).toBe(true);
  });

  it('builds repo name from config.author.github (not hardcoded)', () => {
    const f = setup();
    seedPost(f.db, 'custom', 'technical-deep-dive');
    seedRepoDir(f.reposDir, 'custom');

    const calls: Array<{ cmd: string; args: string[] }> = [];
    installExec((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'gh' && args[1] === 'view') return '';
      if (cmd === 'git' && args.includes('get-url')) return 'https://github.com/otheruser/custom.git';
      if (cmd === 'git' && args.includes('push')) return '';
      return null;
    });

    const result = pushCompanionRepo('custom', makeConfig('otheruser'), f.paths, f.db);
    expect(result.repoUrl).toBe('https://github.com/otheruser/custom');
    const viewCall = calls.find((c) => c.cmd === 'gh' && c.args[1] === 'view');
    expect(viewCall!.args).toContain('otheruser/custom');
  });
});

describe('pushCompanionRepo — origin-URL guardrail (Codex Pass 5 regression)', () => {
  it('throws when origin points to a different GitHub repo (SSH form)', () => {
    const f = setup();
    seedPost(f.db, 'wrongorigin', 'technical-deep-dive');
    seedRepoDir(f.reposDir, 'wrongorigin');

    installExec((cmd, args) => {
      if (cmd === 'gh' && args[1] === 'view') return '';
      // Origin points at an UNRELATED repo. Pushing would mutate someone
      // else's project — the guardrail must refuse.
      if (cmd === 'git' && args.includes('get-url')) {
        return 'git@github.com:jmolz/different-project.git\n';
      }
      return null;
    });

    expect(() => pushCompanionRepo('wrongorigin', makeConfig(), f.paths, f.db)).toThrow(
      /origin points to 'github\.com\/jmolz\/different-project'.*pipeline expected 'github\.com\/jmolz\/wrongorigin'/,
    );
  });

  it('throws when origin points to a different owner (HTTPS form)', () => {
    const f = setup();
    seedPost(f.db, 'wrongowner', 'technical-deep-dive');
    seedRepoDir(f.reposDir, 'wrongowner');

    installExec((cmd, args) => {
      if (cmd === 'gh' && args[1] === 'view') return '';
      if (cmd === 'git' && args.includes('get-url')) {
        return 'https://github.com/someone-else/wrongowner.git\n';
      }
      return null;
    });

    expect(() => pushCompanionRepo('wrongowner', makeConfig(), f.paths, f.db)).toThrow(
      /Refusing to push/,
    );
  });

  it('throws when origin is a non-GitHub URL (GitLab, bitbucket, self-hosted)', () => {
    const f = setup();
    seedPost(f.db, 'gitlab', 'technical-deep-dive');
    seedRepoDir(f.reposDir, 'gitlab');

    installExec((cmd, args) => {
      if (cmd === 'gh' && args[1] === 'view') return '';
      if (cmd === 'git' && args.includes('get-url')) {
        return 'https://gitlab.com/jmolz/gitlab.git\n';
      }
      return null;
    });

    expect(() => pushCompanionRepo('gitlab', makeConfig(), f.paths, f.db)).toThrow(
      /not a recognized GitHub URL/,
    );
  });

  it('accepts origin in SSH form when owner/name matches', () => {
    const f = setup();
    seedPost(f.db, 'sshform', 'technical-deep-dive');
    seedRepoDir(f.reposDir, 'sshform');

    const calls: Array<{ cmd: string; args: string[] }> = [];
    installExec((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'gh' && args[1] === 'view') return '';
      if (cmd === 'git' && args.includes('get-url')) {
        return 'git@github.com:jmolz/sshform.git\n';
      }
      if (cmd === 'git' && args.includes('push')) return '';
      return null;
    });

    const result = pushCompanionRepo('sshform', makeConfig(), f.paths, f.db);
    expect(result.repoUrl).toBe('https://github.com/jmolz/sshform');
    expect(calls.some((c) => c.cmd === 'git' && c.args.includes('push'))).toBe(true);
  });

  it('race-fallback also enforces origin validation (Codex Pass 5 — same guardrail on both paths)', () => {
    const f = setup();
    seedPost(f.db, 'raceorigin', 'technical-deep-dive');
    seedRepoDir(f.reposDir, 'raceorigin');

    installExec((cmd, args) => {
      if (cmd === 'gh' && args[1] === 'view') throw makeExecError(1);
      if (cmd === 'gh' && args[1] === 'create') throw makeExecError(1, 'repository name already exists');
      // Origin points elsewhere — the race fallback must refuse just
      // like the remoteExists branch does.
      if (cmd === 'git' && args.includes('get-url')) {
        return 'https://github.com/evil/unrelated.git\n';
      }
      return null;
    });

    expect(() => pushCompanionRepo('raceorigin', makeConfig(), f.paths, f.db)).toThrow(
      /Refusing to push/,
    );
  });
});

describe('parseGitHubRemoteUrl — URL shape matrix', () => {
  it('parses SSH with .git suffix', () => {
    expect(parseGitHubRemoteUrl('git@github.com:jmolz/slug.git')).toEqual({
      owner: 'jmolz',
      name: 'slug',
    });
  });
  it('parses SSH without .git suffix', () => {
    expect(parseGitHubRemoteUrl('git@github.com:jmolz/slug')).toEqual({
      owner: 'jmolz',
      name: 'slug',
    });
  });
  it('parses HTTPS with .git suffix', () => {
    expect(parseGitHubRemoteUrl('https://github.com/jmolz/slug.git')).toEqual({
      owner: 'jmolz',
      name: 'slug',
    });
  });
  it('parses HTTPS without .git suffix', () => {
    expect(parseGitHubRemoteUrl('https://github.com/jmolz/slug')).toEqual({
      owner: 'jmolz',
      name: 'slug',
    });
  });
  it('returns null for gitlab / bitbucket / self-hosted', () => {
    expect(parseGitHubRemoteUrl('https://gitlab.com/jmolz/slug.git')).toBeNull();
    expect(parseGitHubRemoteUrl('git@bitbucket.org:jmolz/slug')).toBeNull();
    expect(parseGitHubRemoteUrl('https://git.internal.co/jmolz/slug')).toBeNull();
  });
  it('returns null for garbage', () => {
    expect(parseGitHubRemoteUrl('')).toBeNull();
    expect(parseGitHubRemoteUrl('not-a-url')).toBeNull();
    expect(parseGitHubRemoteUrl('https://github.com/singlesegment')).toBeNull();
  });
});

describe('pushCompanionRepo — lookup errors', () => {
  it('throws when post is missing', () => {
    const f = setup();
    expect(() => pushCompanionRepo('ghost', makeConfig(), f.paths, f.db)).toThrow('Post not found: ghost');
  });

  it('propagates non-"already exists" create errors', () => {
    const f = setup();
    seedPost(f.db, 'failrepo', 'technical-deep-dive');
    seedRepoDir(f.reposDir, 'failrepo');

    installExec((cmd, args) => {
      if (cmd === 'gh' && args[1] === 'view') throw makeExecError(1);
      if (cmd === 'gh' && args[1] === 'create') throw makeExecError(128, 'auth failed');
      return null;
    });

    expect(() => pushCompanionRepo('failrepo', makeConfig(), f.paths, f.db)).toThrow(/exec exit 128/);
  });
});
