import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock child_process BEFORE importing site.ts so execFileSync resolves to
// the mock. Same pattern as publish-site.test.ts.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// eslint-disable-next-line import/first
import { execFileSync } from 'node:child_process';
// eslint-disable-next-line import/first
import { createSiteRevertPR } from '../src/core/unpublish/site.js';
// eslint-disable-next-line import/first
import { BlogConfig } from '../src/core/config/types.js';

const mockExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

interface Fx { tempDir: string; siteRepoPath: string; configPath: string; publishDir: string }
let fx: Fx | undefined;

function mkConfig(siteRepoPath: string): BlogConfig {
  return {
    site: { repo_path: siteRepoPath, base_url: 'https://m0lz.dev', content_dir: 'content/posts', research_dir: 'content/research' },
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
    social: { platforms: [], timing_recommendations: true },
    evaluation: { require_pass: true, min_sources: 3, max_reading_level: 12, three_reviewer_panel: true, consensus_must_fix: true, majority_should_fix: true, single_advisory: true, verify_benchmark_claims: true, methodology_completeness: true },
    updates: { preserve_original_data: true, update_notice: true, update_crosspost: true, devto_update: true, refresh_paste_files: true, notice_template: 'x', require_summary: true, site_update_mode: 'pr' },
    unpublish: { devto: true, medium: true, substack: true, readme: true },
  };
}

function setup(slug: string): Fx {
  const tempDir = mkdtempSync(join(tmpdir(), 'unpub-site-'));
  // Site repo basename is 'm0lz.00' so expected origin = jmolz/m0lz.00.
  const siteRepoPath = join(tempDir, 'm0lz.00');
  mkdirSync(siteRepoPath, { recursive: true });
  const publishDir = join(tempDir, 'publish');
  mkdirSync(publishDir);
  const configPath = join(tempDir, '.blogrc.yaml');
  writeFileSync(configPath, '');
  // Seed a minimal MDX with frontmatter containing `published: true`.
  const mdxDir = join(siteRepoPath, 'content', 'posts', slug);
  mkdirSync(mdxDir, { recursive: true });
  writeFileSync(
    join(mdxDir, 'index.mdx'),
    '---\ntitle: "X"\ndate: "2026-04-17"\npublished: true\n---\n\nBody.\n',
    'utf-8',
  );
  fx = { tempDir, siteRepoPath, configPath, publishDir };
  return fx;
}

afterEach(() => {
  if (fx) rmSync(fx.tempDir, { recursive: true, force: true });
  fx = undefined;
  mockExec.mockReset();
});

type ExecMatcher = (cmd: string, args: string[]) => string | Error | null;
function installExec(matcher: ExecMatcher): void {
  mockExec.mockImplementation((cmd: string, args: string[]) => {
    // Default: clean porcelain so dirty-state check passes.
    if (cmd === 'git' && args.includes('status') && args.includes('--porcelain')) {
      return '';
    }
    const result = matcher(cmd, args);
    if (result instanceof Error) throw result;
    if (result === null) {
      throw new Error(`Unexpected exec call: ${cmd} ${args.join(' ')}`);
    }
    return result;
  });
}

describe('createSiteRevertPR — happy path PR-only', () => {
  it('origin matches expected site repo; new branch; PR opened via gh; returns PR url/number', () => {
    const f = setup('alpha');

    let prCreateCalls = 0;
    installExec((cmd, args) => {
      // Origin check BEFORE any push. Both assertOriginMatches (get-url)
      // and the subsequent `git config --get` read origin; return the
      // expected site repo URL for both.
      if (cmd === 'git' && args.includes('remote') && args.includes('get-url')) {
        return 'git@github.com:jmolz/m0lz.00.git\n';
      }
      if (cmd === 'git' && args.includes('config') && args.includes('--get')) {
        return 'git@github.com:jmolz/m0lz.00.git\n';
      }
      if (cmd === 'git' && args.includes('branch') && args.includes('--list')) {
        return '';
      }
      if (cmd === 'git' && args.includes('checkout') && args.includes('-b')) {
        return '';
      }
      if (cmd === 'git' && args.includes('add')) {
        return '';
      }
      if (cmd === 'git' && args.includes('diff') && args.includes('--cached')) {
        const err = new Error('staged') as Error & { status: number };
        err.status = 1;
        throw err;
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
        prCreateCalls += 1;
        return 'https://github.com/jmolz/m0lz.00/pull/17\n';
      }
      return null;
    });

    const result = createSiteRevertPR('alpha', mkConfig(f.siteRepoPath), {
      configPath: f.configPath,
      publishDir: f.publishDir,
    });

    expect(result.prNumber).toBe(17);
    expect(result.prUrl).toBe('https://github.com/jmolz/m0lz.00/pull/17');
    expect(result.branchName).toBe('unpublish/alpha');
    expect(prCreateCalls).toBe(1);

    // The MDX on disk should have `published: false` after the flip.
    const after = readFileSync(join(f.siteRepoPath, 'content/posts/alpha/index.mdx'), 'utf-8');
    expect(after).toMatch(/\npublished:\s*false\b/);
  });

  it('gh pr list returns existing PR: does NOT call gh pr create; returns existing url', () => {
    const f = setup('beta');

    let prCreateCalls = 0;
    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('remote') && args.includes('get-url')) {
        return 'git@github.com:jmolz/m0lz.00.git\n';
      }
      if (cmd === 'git' && args.includes('config') && args.includes('--get')) {
        return 'git@github.com:jmolz/m0lz.00.git\n';
      }
      if (cmd === 'git' && args.includes('branch') && args.includes('--list')) {
        return 'unpublish/beta\n';
      }
      if (cmd === 'git' && args.includes('checkout')) return '';
      if (cmd === 'git' && args.includes('add')) return '';
      if (cmd === 'git' && args.includes('diff') && args.includes('--cached')) {
        const err = new Error('staged') as Error & { status: number };
        err.status = 1;
        throw err;
      }
      if (cmd === 'git' && args.includes('commit')) return '';
      if (cmd === 'git' && args.includes('push')) return '';
      if (cmd === 'gh' && args.includes('pr') && args.includes('list')) {
        return JSON.stringify([{ number: 88, url: 'https://github.com/jmolz/m0lz.00/pull/88' }]);
      }
      if (cmd === 'gh' && args.includes('pr') && args.includes('create')) {
        prCreateCalls += 1;
        return 'should-not-happen';
      }
      return null;
    });

    const result = createSiteRevertPR('beta', mkConfig(f.siteRepoPath), {
      configPath: f.configPath,
      publishDir: f.publishDir,
    });
    expect(result.prNumber).toBe(88);
    expect(prCreateCalls).toBe(0);
  });
});

describe('createSiteRevertPR — trust boundary', () => {
  it('throws when origin points to a different GitHub repo (no push, no PR)', () => {
    const f = setup('wrongorigin');

    let pushCalls = 0;
    let prCreateCalls = 0;
    installExec((cmd, args) => {
      // assertOriginMatches reads `remote get-url origin`. Return a DIFFERENT repo.
      if (cmd === 'git' && args.includes('remote') && args.includes('get-url')) {
        return 'git@github.com:evil/hijacked.git\n';
      }
      // Other exec calls should never fire because assertOriginMatches throws first.
      if (cmd === 'git' && args.includes('push')) {
        pushCalls += 1;
        return '';
      }
      if (cmd === 'gh' && args.includes('pr') && args.includes('create')) {
        prCreateCalls += 1;
        return '';
      }
      return null;
    });

    expect(() => createSiteRevertPR('wrongorigin', mkConfig(f.siteRepoPath), {
      configPath: f.configPath,
      publishDir: f.publishDir,
    })).toThrow(/origin points to 'github\.com\/evil\/hijacked'|expected 'github\.com\/jmolz\/m0lz\.00'/);

    expect(pushCalls).toBe(0);
    expect(prCreateCalls).toBe(0);
  });

  it('throws when origin is unparseable (not a GitHub URL)', () => {
    const f = setup('badremote');
    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('remote') && args.includes('get-url')) {
        return 'weird://not-a-github-url/xyz\n';
      }
      return null;
    });
    expect(() => createSiteRevertPR('badremote', mkConfig(f.siteRepoPath), {
      configPath: f.configPath,
      publishDir: f.publishDir,
    })).toThrow(/not a recognized GitHub URL/);
  });
});

describe('createSiteRevertPR — PR-only invariant', () => {
  it('source file contains no `push origin main` reference (grep-verifiable)', () => {
    // Architecture guard: the unpublish site revert is PR-only. Mirrors the
    // contract criterion #5 validation — no direct-push code path.
    const src = readFileSync(
      new URL('../src/core/unpublish/site.ts', import.meta.url),
      'utf-8',
    );
    expect(src).not.toMatch(/push\s+origin\s+main/);
    // Also: no `site_revert_mode` branching.
    expect(src).not.toMatch(/site_revert_mode/);
  });
});
