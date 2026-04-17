import { describe, it, expect, afterEach, vi } from 'vitest';

// Mock child_process BEFORE importing origin-guard so execFileSync
// is interception-controlled for every test in this file.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// eslint-disable-next-line import/first
import { execFileSync } from 'node:child_process';
// eslint-disable-next-line import/first
import {
  parseGitHubRemoteUrl,
  getOriginState,
  requireOriginMatch,
  expectedSiteCoords,
} from '../src/core/publish/origin-guard.js';
// eslint-disable-next-line import/first
import { BlogConfig } from '../src/core/config/types.js';

const mockExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  mockExec.mockReset();
  vi.restoreAllMocks();
});

function makeExecError(status: number, stderr: string): Error {
  const e = new Error(`exec exit ${status}`) as Error & {
    status: number; stderr: string; stdout: string;
  };
  e.status = status;
  e.stdout = '';
  e.stderr = stderr;
  return e;
}

describe('parseGitHubRemoteUrl', () => {
  it('parses SSH shape', () => {
    expect(parseGitHubRemoteUrl('git@github.com:jmolz/m0lz.00.git')).toEqual({
      owner: 'jmolz', name: 'm0lz.00',
    });
  });

  it('parses HTTPS shape', () => {
    expect(parseGitHubRemoteUrl('https://github.com/jmolz/slug')).toEqual({
      owner: 'jmolz', name: 'slug',
    });
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parseGitHubRemoteUrl('https://gitlab.com/u/r.git')).toBeNull();
  });
});

describe('getOriginState — tolerant API', () => {
  it('returns "matches" when origin is the expected target', () => {
    mockExec.mockReturnValue('git@github.com:jmolz/m0lz.00.git\n');
    expect(getOriginState('/repo', 'jmolz', 'm0lz.00')).toBe('matches');
  });

  it('returns "absent" when git emits "No such remote" (English stderr)', () => {
    mockExec.mockImplementation(() => {
      throw makeExecError(128, "fatal: No such remote 'origin'\n");
    });
    expect(getOriginState('/repo', 'jmolz', 'slug')).toBe('absent');
  });

  it('re-throws on environment errors (not-a-git-repo, missing binary)', () => {
    mockExec.mockImplementation(() => {
      throw makeExecError(128, 'fatal: not a git repository\n');
    });
    expect(() => getOriginState('/bogus', 'jmolz', 'slug'))
      .toThrow(/origin-guard.*not a git repository/);
  });

  it('throws on origin mismatch', () => {
    mockExec.mockReturnValue('git@github.com:evil/hijacked.git\n');
    expect(() => getOriginState('/repo', 'jmolz', 'm0lz.00'))
      .toThrow(/origin points to 'github\.com\/evil\/hijacked'/);
  });

  it('throws on unparseable URL', () => {
    mockExec.mockReturnValue('ftp://weird/shape\n');
    expect(() => getOriginState('/repo', 'jmolz', 'slug'))
      .toThrow(/not a recognized GitHub URL/);
  });

  it('normalizes case when comparing (GitHub is case-insensitive)', () => {
    mockExec.mockReturnValue('git@github.com:JMolz/M0lz.00.git\n');
    // Expected is lowercase; origin emits mixed-case. Must match.
    expect(getOriginState('/repo', 'jmolz', 'm0lz.00')).toBe('matches');
  });

  it('forces LC_ALL=C on git invocation (locale independence)', () => {
    mockExec.mockReturnValue('git@github.com:jmolz/slug.git\n');
    getOriginState('/repo', 'jmolz', 'slug');
    const call = mockExec.mock.calls[0];
    const options = call[2] as { env?: Record<string, string> };
    expect(options.env?.LC_ALL).toBe('C');
    expect(options.env?.LANG).toBe('C');
  });
});

describe('requireOriginMatch — strict API', () => {
  it('passes silently when origin matches expected', () => {
    mockExec.mockReturnValue('git@github.com:jmolz/m0lz.00.git\n');
    expect(() => requireOriginMatch('/repo', 'jmolz', 'm0lz.00')).not.toThrow();
  });

  it('THROWS when origin is absent (unlike tolerant getOriginState)', () => {
    mockExec.mockImplementation(() => {
      throw makeExecError(128, "fatal: No such remote 'origin'\n");
    });
    expect(() => requireOriginMatch('/repo', 'jmolz', 'slug'))
      .toThrow(/no 'origin' remote configured/);
  });

  it('throws with actionable fix command when origin mismatches', () => {
    mockExec.mockReturnValue('git@github.com:wrong/repo.git\n');
    expect(() => requireOriginMatch('/repo', 'jmolz', 'm0lz.00'))
      .toThrow(/remote set-url origin https:\/\/github\.com\/jmolz\/m0lz\.00\.git/);
  });
});

describe('expectedSiteCoords — github_repo vs basename fallback', () => {
  function mkConfig(overrides: Partial<BlogConfig['site']> = {}): BlogConfig {
    return {
      site: { repo_path: '/tmp/m0lz.00', base_url: 'https://m0lz.dev', content_dir: 'content/posts', research_dir: 'content/research', ...overrides },
      author: { name: 'Tester', github: 'jmolz' },
      ai: { primary: 'c', reviewers: { structural: 'c', adversarial: 'c', methodology: 'c' }, codex: { adversarial_effort: 'high', methodology_effort: 'xhigh' } },
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

  it('prefers explicit config.site.github_repo when set', () => {
    const config = mkConfig({ github_repo: 'org-account/actual-site' });
    expect(expectedSiteCoords(config)).toEqual({ owner: 'org-account', name: 'actual-site' });
  });

  it('falls back to {author.github}/basename(repo_path) when github_repo unset', () => {
    const config = mkConfig();
    expect(expectedSiteCoords(config)).toEqual({ owner: 'jmolz', name: 'm0lz.00' });
  });

  it('handles trailing slash in repo_path when falling back', () => {
    const config = mkConfig({ repo_path: '/tmp/m0lz.00/' });
    expect(expectedSiteCoords(config)).toEqual({ owner: 'jmolz', name: 'm0lz.00' });
  });
});
