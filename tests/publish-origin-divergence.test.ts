import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { assertOriginInSync } from '../src/core/publish/origin-guard.js';
import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { initResearchPost } from '../src/core/research/state.js';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  vi.doUnmock('node:child_process');
  vi.doUnmock('../src/core/publish/origin-guard.js');
  vi.resetModules();
  vi.restoreAllMocks();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
}

// Build a self-contained origin + clone pair. The "origin" is a bare repo
// so we can push/fetch against it; the clone starts in sync and diverges
// via additional unpushed commits in individual tests.
function setupOriginAndClone(): { originPath: string; clonePath: string } {
  tempDir = mkdtempSync(join(tmpdir(), 'origin-sync-'));
  const originPath = join(tempDir, 'origin.git');
  const workPath = join(tempDir, 'seed');
  const clonePath = join(tempDir, 'clone');

  // Bare origin.
  mkdirSync(originPath, { recursive: true });
  execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', originPath]);

  // Seed a single commit on main via a throwaway work tree, then push.
  mkdirSync(workPath, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: workPath });
  git(workPath, 'config', 'user.email', 'test@example.com');
  git(workPath, 'config', 'user.name', 'Test');
  writeFileSync(join(workPath, 'README.md'), '# seed\n');
  git(workPath, 'add', 'README.md');
  git(workPath, 'commit', '-q', '-m', 'initial commit');
  git(workPath, 'remote', 'add', 'origin', originPath);
  git(workPath, 'push', '-q', '-u', 'origin', 'main');

  // Clone the origin for the actual test work.
  execFileSync('git', ['clone', '--quiet', originPath, clonePath]);
  git(clonePath, 'config', 'user.email', 'test@example.com');
  git(clonePath, 'config', 'user.name', 'Test');

  return { originPath, clonePath };
}

describe('assertOriginInSync', () => {
  it('passes silently when local main matches origin/main', () => {
    const { clonePath } = setupOriginAndClone();
    expect(() => assertOriginInSync(clonePath, 'main')).not.toThrow();
  });

  it('throws ORIGIN_OUT_OF_SYNC when local main is ahead', () => {
    const { clonePath } = setupOriginAndClone();
    writeFileSync(join(clonePath, 'new.txt'), 'unpushed\n');
    git(clonePath, 'add', 'new.txt');
    git(clonePath, 'commit', '-q', '-m', 'unpushed commit');

    expect(() => assertOriginInSync(clonePath, 'main'))
      .toThrow(/\[AGENT_ERROR\] ORIGIN_OUT_OF_SYNC/);
    expect(() => assertOriginInSync(clonePath, 'main'))
      .toThrow(/1 commit\(s\) ahead/);
  });

  it('reports the exact commit count when multiple local commits are ahead', () => {
    const { clonePath } = setupOriginAndClone();
    for (let i = 0; i < 3; i += 1) {
      writeFileSync(join(clonePath, `f${i}.txt`), 'x\n');
      git(clonePath, 'add', `f${i}.txt`);
      git(clonePath, 'commit', '-q', '-m', `commit ${i}`);
    }
    expect(() => assertOriginInSync(clonePath, 'main'))
      .toThrow(/3 commit\(s\) ahead of origin\/main/);
  });

  it('throws ORIGIN_OUT_OF_SYNC when the branch does not exist on origin', () => {
    const { clonePath } = setupOriginAndClone();
    git(clonePath, 'checkout', '-q', '-b', 'feature-x');
    expect(() => assertOriginInSync(clonePath, 'feature-x'))
      .toThrow(/\[AGENT_ERROR\] ORIGIN_OUT_OF_SYNC/);
  });

  it('re-throws with context when git subprocess fails (not a git repo)', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'origin-sync-not-repo-'));
    // Just a plain empty dir — not a git repo. git fetch should fail
    // with something other than "unknown revision".
    expect(() => assertOriginInSync(tempDir, 'main'))
      .toThrow(/origin-guard: 'git/);
  });
});

describe('site-pr --allow-main-ahead override', () => {
  it('skips assertOriginInSync and emits warning when allowMainAhead=true', async () => {
    vi.resetModules();

    tempDir = mkdtempSync(join(tmpdir(), 'site-pr-allow-ahead-'));
    const siteRepoPath = join(tempDir, 'site');
    const draftsDir = join(tempDir, 'drafts');
    const researchPagesDir = join(tempDir, 'research-pages');
    const publishDir = join(tempDir, 'publish');
    mkdirSync(siteRepoPath, { recursive: true });
    mkdirSync(join(draftsDir, 'alpha'), { recursive: true });
    mkdirSync(researchPagesDir, { recursive: true });
    mkdirSync(publishDir, { recursive: true });
    writeFileSync(
      join(draftsDir, 'alpha', 'index.mdx'),
      [
        '---',
        'title: Alpha',
        'medium_featured_image: ./assets/medium-featured.png',
        'substack_header_image: ./assets/substack-header.png',
        '---',
        '',
        'body',
        '',
      ].join('\n'),
    );

    const db = getDatabase(':memory:');
    try {
      initResearchPost(db, 'alpha', 'topic', 'directed', 'technical-deep-dive');
      db.prepare('UPDATE posts SET title = ? WHERE slug = ?').run('Alpha Title', 'alpha');

      const mockAssertOriginInSync = vi.fn(() => {
        throw new Error('assertOriginInSync should be bypassed');
      });
      const mockRequireOriginMatch = vi.fn();
      const mockExecFileSync = vi.fn((cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('status') && args.includes('--porcelain')) return '';
        if (cmd === 'git' && args.includes('config') && args.includes('--get')) {
          return 'git@github.com:jmolz/m0lz.00.git\n';
        }
        if (cmd === 'git' && args.includes('branch') && args.includes('--list')) return '';
        if (cmd === 'git' && args.includes('checkout') && args.includes('-b')) return '';
        if (cmd === 'git' && args.includes('add')) return '';
        if (cmd === 'git' && args.includes('diff') && args.includes('--cached') && args.includes('--quiet')) {
          const err = new Error('has staged changes') as Error & { status?: number };
          err.status = 1;
          throw err;
        }
        if (cmd === 'git' && args.includes('commit')) return '';
        if (cmd === 'git' && args.includes('push')) return '';
        if (cmd === 'gh' && args.includes('list')) return '[]';
        if (cmd === 'gh' && args.includes('create')) {
          return 'https://github.com/jmolz/m0lz.00/pull/42\n';
        }
        throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
      });

      vi.doMock('node:child_process', () => ({ execFileSync: mockExecFileSync }));
      vi.doMock('../src/core/publish/origin-guard.js', () => ({
        expectedSiteCoords: () => ({ owner: 'jmolz', name: 'm0lz.00' }),
        requireOriginMatch: mockRequireOriginMatch,
        assertOriginInSync: mockAssertOriginInSync,
      }));

      const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { createSitePR } = await import('../src/core/publish/site.js');
      const result = await createSitePR(
        'alpha',
        {
          site: {
            repo_path: siteRepoPath,
            base_url: 'https://m0lz.dev',
            content_dir: 'content/posts',
            research_dir: 'content/research',
          },
          author: { name: 'Tester', github: 'jmolz' },
        } as never,
        {
          draftsDir,
          researchPagesDir,
          publishDir,
          configPath: join(tempDir, '.blogrc.yaml'),
        },
        db,
        { allowMainAhead: true },
      );

      expect(result.prNumber).toBe(42);
      expect(mockRequireOriginMatch).toHaveBeenCalledTimes(1);
      expect(mockAssertOriginInSync).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[WARN] site-pr: --allow-main-ahead bypassed origin sync check',
      );
    } finally {
      closeDatabase(db);
    }
  });
});
