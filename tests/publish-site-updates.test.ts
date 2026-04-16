import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

// Mock child_process BEFORE frontmatter.ts / readme.ts import so execFileSync
// resolves to the mock. Both modules call git via execFileSync with argument
// arrays — the mock lets us assert exact argv without running real git.
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
import { updateFrontmatter } from '../src/core/publish/frontmatter.js';
// eslint-disable-next-line import/first
import { updateProjectReadme } from '../src/core/publish/readme.js';
// eslint-disable-next-line import/first
import { BlogConfig } from '../src/core/config/types.js';

const mockExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

interface Fixture {
  tempDir: string;
  siteRepoPath: string;
  configPath: string;
  db: Database.Database;
}

let fixture: Fixture | undefined;

function makeConfig(siteRepoPath: string, projects?: Record<string, string>): BlogConfig {
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
    ...(projects ? { projects } : {}),
  };
}

function setup(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'publish-updates-'));
  const siteRepoPath = join(tempDir, 'site');
  mkdirSync(siteRepoPath, { recursive: true });
  const configPath = join(tempDir, '.blogrc.yaml');
  writeFileSync(configPath, 'placeholder', 'utf-8');
  const db = getDatabase(':memory:');
  fixture = { tempDir, siteRepoPath, configPath, db };
  return fixture;
}

beforeEach(() => {
  mockExec.mockReset();
});

afterEach(() => {
  if (fixture?.db) closeDatabase(fixture.db);
  if (fixture) rmSync(fixture.tempDir, { recursive: true, force: true });
  fixture = undefined;
});

// Default mock: every git call succeeds except `git diff --cached --quiet`
// which exits 1 meaning "changes staged". Tests that need different shapes
// override with mockExec.mockImplementation per-test.
function simulateStagedChanges(): void {
  mockExec.mockImplementation((cmd: string, args: string[]): Buffer => {
    if (cmd === 'git' && args[2] === 'diff' && args.includes('--cached') && args.includes('--quiet')) {
      const err = new Error('changes staged') as NodeJS.ErrnoException & { status: number };
      err.status = 1;
      throw err;
    }
    return Buffer.from('');
  });
}

function simulateNoStagedChanges(): void {
  mockExec.mockImplementation((): Buffer => Buffer.from(''));
}

function writeSampleDraftMdx(siteRepoPath: string, slug: string): string {
  const postDir = join(siteRepoPath, 'content/posts', slug);
  mkdirSync(postDir, { recursive: true });
  const mdx = [
    '---',
    'title: "Sample Post"',
    'description: "A sample post"',
    'date: "2026-04-16"',
    'tags:',
    '  - research',
    'published: false',
    '---',
    '',
    'Body text.',
    '',
  ].join('\n');
  const mdxPath = join(postDir, 'index.mdx');
  writeFileSync(mdxPath, mdx, 'utf-8');
  return mdxPath;
}

describe('updateFrontmatter — direct push to main of site repo', () => {
  it('writes platform URLs, commits with chore(post) prefix, pushes to main', () => {
    const f = setup();
    const mdxPath = writeSampleDraftMdx(f.siteRepoPath, 'hello');
    simulateStagedChanges();

    const result = updateFrontmatter(
      'hello',
      makeConfig(f.siteRepoPath),
      {
        site_url: 'https://m0lz.dev/writing/hello',
        devto_url: 'https://dev.to/jmolz/hello',
        repo_url: 'https://github.com/jmolz/hello',
      },
      { configPath: f.configPath },
    );

    expect(result.updated).toBe(true);

    // File on disk reflects published=true, canonical, platform fields.
    const written = readFileSync(mdxPath, 'utf-8');
    expect(written).toMatch(/published:\s*true/);
    expect(written).toMatch(/canonical:\s*"?https:\/\/m0lz\.dev\/writing\/hello"?/);
    expect(written).toMatch(/devto_url:\s*"?https:\/\/dev\.to\/jmolz\/hello"?/);
    expect(written).toMatch(/companion_repo:\s*"?https:\/\/github\.com\/jmolz\/hello"?/);

    // Commit uses the chore(post): prefix per contract.
    const commitCall = mockExec.mock.calls.find((c) => c[1].includes('commit'));
    expect(commitCall).toBeDefined();
    const commitArgs = commitCall![1] as string[];
    const msgIdx = commitArgs.indexOf('-m');
    expect(msgIdx).toBeGreaterThan(-1);
    expect(commitArgs[msgIdx + 1]).toMatch(/^chore\(post\): hello add platform URLs$/);

    // Push targets origin main.
    const pushCall = mockExec.mock.calls.find((c) => c[1].includes('push'));
    expect(pushCall).toBeDefined();
    const pushArgs = pushCall![1] as string[];
    expect(pushArgs).toEqual(expect.arrayContaining(['push', 'origin', 'main']));

    // All subprocess calls use execFileSync pattern (command + argv array) —
    // no shell string interpolation.
    for (const call of mockExec.mock.calls) {
      expect(call[0]).toBe('git');
      expect(Array.isArray(call[1])).toBe(true);
    }
  });

  it('is a no-op when nothing staged AND HEAD is not ahead of origin (true idempotent)', () => {
    const f = setup();
    writeSampleDraftMdx(f.siteRepoPath, 'idem');
    // Diff --cached --quiet exits 0 (no staged); rev-list returns 0 (not ahead).
    mockExec.mockImplementation((cmd: string, args: string[]): Buffer => {
      if (args.includes('rev-list')) return Buffer.from('0\n');
      return Buffer.from('');
    });

    const result = updateFrontmatter(
      'idem',
      makeConfig(f.siteRepoPath),
      { devto_url: 'https://dev.to/jmolz/idem' },
      { configPath: f.configPath },
    );
    expect(result.updated).toBe(false);
    expect(result.reason).toMatch(/No frontmatter changes/);

    // Critical: must not call `commit` or `push` when there are no staged
    // changes AND HEAD is not ahead — otherwise every re-run would generate
    // an empty commit or an unnecessary push.
    const commitCall = mockExec.mock.calls.find((c) => c[1].includes('commit'));
    expect(commitCall).toBeUndefined();
    const pushCall = mockExec.mock.calls.find((c) => c[1].includes('push'));
    expect(pushCall).toBeUndefined();
  });

  it('crash-replay: pushes when HEAD is ahead of origin/main even though nothing is staged', () => {
    // Regression for Codex Pass 3 Critical. A prior run committed the
    // frontmatter edit locally but died before `git push`. On retry, the
    // worktree is clean (prior run's write is on disk), git diff --cached
    // --quiet reports 0, the naive implementation returned updated:false
    // and the runner marked the step completed — leaving origin/main
    // without the commit. The fix: `git rev-list origin/main..HEAD --count`
    // reveals the unpushed commit, then push.
    const f = setup();
    writeSampleDraftMdx(f.siteRepoPath, 'crashreplay');
    mockExec.mockImplementation((cmd: string, args: string[]): Buffer => {
      if (args.includes('rev-list')) return Buffer.from('1\n');
      return Buffer.from('');
    });

    const result = updateFrontmatter(
      'crashreplay',
      makeConfig(f.siteRepoPath),
      { devto_url: 'https://dev.to/jmolz/crashreplay' },
      { configPath: f.configPath },
    );
    expect(result.updated).toBe(true);
    expect(result.reason).toMatch(/previously-committed/);

    // A push to origin main MUST have happened. And NO new commit
    // (because nothing was staged).
    const pushCall = mockExec.mock.calls.find((c) => c[1].includes('push'));
    expect(pushCall).toBeDefined();
    expect(pushCall![1]).toEqual(expect.arrayContaining(['push', 'origin', 'main']));
    const commitCall = mockExec.mock.calls.find((c) => c[1].includes('commit'));
    expect(commitCall).toBeUndefined();
  });

  it('throws when the site repo path does not exist', () => {
    const f = setup();
    simulateStagedChanges();
    const config = makeConfig(join(f.tempDir, 'missing'));
    expect(() =>
      updateFrontmatter('ghost', config, {}, { configPath: f.configPath }),
    ).toThrow(/Site repo path does not exist/);
  });

  it('throws when the MDX file is missing', () => {
    const f = setup();
    simulateStagedChanges();
    expect(() =>
      updateFrontmatter('noposts', makeConfig(f.siteRepoPath), {}, { configPath: f.configPath }),
    ).toThrow(/MDX file not found/);
  });
});

function seedProjectPost(
  db: Database.Database,
  slug: string,
  projectId: string | null,
  title = 'Sample Project Post',
): void {
  initResearchPost(db, slug, 'topic', 'directed', 'project-launch');
  advancePhase(db, slug, 'benchmark');
  advancePhase(db, slug, 'draft');
  advancePhase(db, slug, 'evaluate');
  advancePhase(db, slug, 'publish');
  if (projectId) {
    db.prepare('UPDATE posts SET title = ?, project_id = ? WHERE slug = ?').run(title, projectId, slug);
  } else {
    db.prepare('UPDATE posts SET title = ? WHERE slug = ?').run(title, slug);
  }
}

function makeProjectRepo(tempDir: string, name: string, readmeBody = '# Project\n'): string {
  const dir = join(tempDir, 'projects', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), readmeBody, 'utf-8');
  return dir;
}

describe('updateProjectReadme — direct push to main of project repo', () => {
  it('inserts writing link, commits with chore: prefix, pushes to main', () => {
    const f = setup();
    const projectDir = makeProjectRepo(f.tempDir, 'm0lz.02', '# m0lz.02\n\n## Writing\n\n');
    seedProjectPost(f.db, 'launch-post', 'm0lz.02');
    simulateStagedChanges();

    // Configure `projects` with an absolute path so path resolution is
    // deterministic across test runs.
    const config = makeConfig(f.siteRepoPath, { 'm0lz.02': projectDir });
    const result = updateProjectReadme('launch-post', config, { configPath: f.configPath }, f.db);
    expect(result.updated).toBe(true);

    // README gained the link.
    const updated = readFileSync(join(projectDir, 'README.md'), 'utf-8');
    expect(updated).toContain('[Sample Project Post](https://m0lz.dev/writing/launch-post)');

    // Commit uses chore: prefix per contract.
    const commitCall = mockExec.mock.calls.find((c) => c[1].includes('commit'));
    expect(commitCall).toBeDefined();
    const commitArgs = commitCall![1] as string[];
    const msgIdx = commitArgs.indexOf('-m');
    expect(commitArgs[msgIdx + 1]).toMatch(/^chore: add writing link for launch-post$/);

    // Push targets origin main.
    const pushCall = mockExec.mock.calls.find((c) => c[1].includes('push'));
    expect(pushCall).toBeDefined();
    expect(pushCall![1]).toEqual(expect.arrayContaining(['push', 'origin', 'main']));
  });

  it('resolves a relative `projects[id]` entry against the config file directory', () => {
    const f = setup();
    const projectDir = makeProjectRepo(f.tempDir, 'm0lz.03', '# m0lz.03\n\n## Writing\n\n');
    seedProjectPost(f.db, 'relpath-post', 'm0lz.03');
    simulateStagedChanges();

    // configPath sits in f.tempDir. relative() gives us "projects/m0lz.03"
    // — a path that only resolves correctly if readme.ts anchors it against
    // dirname(configPath), NOT against the test process CWD.
    const relativePath = relative(f.tempDir, projectDir);
    expect(relativePath).not.toMatch(/^\//);
    const config = makeConfig(f.siteRepoPath, { 'm0lz.03': relativePath });

    const result = updateProjectReadme('relpath-post', config, { configPath: f.configPath }, f.db);
    expect(result.updated).toBe(true);
    const updated = readFileSync(join(projectDir, 'README.md'), 'utf-8');
    expect(updated).toContain('https://m0lz.dev/writing/relpath-post');
  });

  it('creates a ## Writing heading when the README does not have one', () => {
    const f = setup();
    const projectDir = makeProjectRepo(f.tempDir, 'm0lz.04', '# m0lz.04\n');
    seedProjectPost(f.db, 'no-heading', 'm0lz.04');
    simulateStagedChanges();

    const config = makeConfig(f.siteRepoPath, { 'm0lz.04': projectDir });
    updateProjectReadme('no-heading', config, { configPath: f.configPath }, f.db);

    const updated = readFileSync(join(projectDir, 'README.md'), 'utf-8');
    expect(updated).toMatch(/## Writing\s*\n/);
    expect(updated).toContain('https://m0lz.dev/writing/no-heading');
  });

  it('skips when the post has no project_id', () => {
    const f = setup();
    seedProjectPost(f.db, 'no-project', null);
    simulateStagedChanges();

    const config = makeConfig(f.siteRepoPath, { 'm0lz.02': '/tmp/anywhere' });
    const result = updateProjectReadme('no-project', config, { configPath: f.configPath }, f.db);
    expect(result.updated).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/No project_id on post/);
    // Nothing should have been staged / committed / pushed.
    expect(mockExec.mock.calls.length).toBe(0);
  });

  it('skips when config.projects has no entry for the post project_id', () => {
    const f = setup();
    seedProjectPost(f.db, 'unknown-proj', 'not-in-config');
    simulateStagedChanges();

    const config = makeConfig(f.siteRepoPath, { 'm0lz.02': '/tmp/anywhere' });
    const result = updateProjectReadme('unknown-proj', config, { configPath: f.configPath }, f.db);
    expect(result.updated).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/No projects config for 'not-in-config'/);
    expect(mockExec.mock.calls.length).toBe(0);
  });

  it('skips when the configured project directory does not exist', () => {
    const f = setup();
    seedProjectPost(f.db, 'missing-dir', 'm0lz.99');
    simulateStagedChanges();

    const config = makeConfig(f.siteRepoPath, { 'm0lz.99': '/tmp/definitely-not-a-real-path-xyz' });
    const result = updateProjectReadme('missing-dir', config, { configPath: f.configPath }, f.db);
    expect(result.updated).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/Project directory not found/);
  });

  it('is idempotent — a second call when canonical URL is already in README is a no-op', () => {
    const f = setup();
    const body = [
      '# m0lz.02',
      '',
      '## Writing',
      '',
      '- [Sample Project Post](https://m0lz.dev/writing/idem-readme)',
      '',
    ].join('\n');
    const projectDir = makeProjectRepo(f.tempDir, 'm0lz.02', body);
    seedProjectPost(f.db, 'idem-readme', 'm0lz.02');
    simulateStagedChanges();

    const config = makeConfig(f.siteRepoPath, { 'm0lz.02': projectDir });
    const result = updateProjectReadme('idem-readme', config, { configPath: f.configPath }, f.db);
    expect(result.updated).toBe(false);
    expect(result.reason).toMatch(/already present/);
    // No git calls at all.
    expect(mockExec.mock.calls.length).toBe(0);
  });

  it('crash-replay: pushes when HEAD is ahead of origin/main even though nothing is staged', () => {
    // Same regression as updateFrontmatter — Codex Pass 3 Medium. A prior
    // run committed the README edit locally but died before `git push`.
    // The retry must push the orphan commit instead of silently returning
    // updated:false and letting the runner advance the phase.
    const f = setup();
    // README does NOT yet contain the canonical URL — we want the code to
    // pass the idempotency check (`if (readmeContent.includes(canonicalUrl))`)
    // and proceed to the git sequence where the ahead check can fire. BUT
    // we want the `diff --cached --quiet` check to report "no staged
    // changes" (simulating a crashed prior run whose write+commit left
    // the worktree clean on retry).
    const projectDir = makeProjectRepo(f.tempDir, 'm0lz.02', '# m0lz.02\n\n## Writing\n\n');
    seedProjectPost(f.db, 'readme-crashreplay', 'm0lz.02');
    mockExec.mockImplementation((cmd: string, args: string[]): Buffer => {
      if (args.includes('rev-list')) return Buffer.from('1\n');
      // diff --cached --quiet — exit 0 means NO staged changes.
      // Everything else (checkout, pull, add, push) — plain success.
      return Buffer.from('');
    });

    const config = makeConfig(f.siteRepoPath, { 'm0lz.02': projectDir });
    const result = updateProjectReadme('readme-crashreplay', config, { configPath: f.configPath }, f.db);
    expect(result.updated).toBe(true);
    expect(result.reason).toMatch(/previously-committed/);

    const pushCall = mockExec.mock.calls.find((c) => c[1].includes('push'));
    expect(pushCall).toBeDefined();
    expect(pushCall![1]).toEqual(expect.arrayContaining(['push', 'origin', 'main']));
    const commitCall = mockExec.mock.calls.find((c) => c[1].includes('commit'));
    expect(commitCall).toBeUndefined();
  });

  it('throws when the post row is missing', () => {
    const f = setup();
    const config = makeConfig(f.siteRepoPath, { 'm0lz.02': '/tmp/whatever' });
    expect(() =>
      updateProjectReadme('ghost', config, { configPath: f.configPath }, f.db),
    ).toThrow(/Post not found/);
  });
});
