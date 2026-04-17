import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock child_process BEFORE importing site.ts so all git/gh calls are
// intercepted. Same pattern as publish-site.test.ts.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// eslint-disable-next-line import/first
import { execFileSync } from 'node:child_process';
// eslint-disable-next-line import/first
import Database from 'better-sqlite3';
// eslint-disable-next-line import/first
import { closeDatabase, getDatabase } from '../src/core/db/database.js';
// eslint-disable-next-line import/first
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
// eslint-disable-next-line import/first
import { openUpdateCycle } from '../src/core/update/cycles.js';
// eslint-disable-next-line import/first
import { createSiteUpdate } from '../src/core/publish/site-update.js';
// eslint-disable-next-line import/first
import { completeUpdateUnderLock } from '../src/core/publish/phase.js';
// eslint-disable-next-line import/first
import { acquirePublishLock } from '../src/core/publish/lock.js';
// eslint-disable-next-line import/first
import { BlogConfig } from '../src/core/config/types.js';

const mockExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

interface Fx {
  tempDir: string;
  siteRepoPath: string;
  draftsDir: string;
  researchPagesDir: string;
  publishDir: string;
  configPath: string;
  db: Database.Database;
  config: BlogConfig;
}

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
    updates: { preserve_original_data: true, update_notice: true, update_crosspost: true, devto_update: true, refresh_paste_files: true, notice_template: 'Updated {DATE}: {SUMMARY}', require_summary: true, site_update_mode: 'pr' },
    unpublish: { devto: true, medium: true, substack: true, readme: true },
  };
}

function setup(): Fx {
  const tempDir = mkdtempSync(join(tmpdir(), 'update-pub-'));
  // Use 'm0lz.00' basename so assertOriginMatches expects jmolz/m0lz.00.
  const siteRepoPath = join(tempDir, 'm0lz.00');
  const draftsDir = join(tempDir, 'drafts');
  const researchPagesDir = join(tempDir, 'research-pages');
  const publishDir = join(tempDir, 'publish');
  const configPath = join(tempDir, '.blogrc.yaml');
  mkdirSync(siteRepoPath, { recursive: true });
  mkdirSync(draftsDir, { recursive: true });
  mkdirSync(researchPagesDir, { recursive: true });
  mkdirSync(publishDir, { recursive: true });
  writeFileSync(configPath, '');
  const db = getDatabase(':memory:');
  fx = { tempDir, siteRepoPath, draftsDir, researchPagesDir, publishDir, configPath, db, config: mkConfig(siteRepoPath) };
  return fx;
}

function seedPublishedPost(db: Database.Database, slug: string, title = 'Sample Title'): void {
  initResearchPost(db, slug, 'topic', 'directed', 'technical-deep-dive');
  advancePhase(db, slug, 'benchmark');
  advancePhase(db, slug, 'draft');
  advancePhase(db, slug, 'evaluate');
  db.prepare('UPDATE posts SET evaluation_passed = 1, title = ? WHERE slug = ?').run(title, slug);
  advancePhase(db, slug, 'publish');
  advancePhase(db, slug, 'published');
}

function seedDraftMdx(draftsDir: string, slug: string, content: string): void {
  const dir = join(draftsDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.mdx'), content, 'utf-8');
}

afterEach(() => {
  if (fx?.db) closeDatabase(fx.db);
  if (fx) rmSync(fx.tempDir, { recursive: true, force: true });
  fx = undefined;
  mockExec.mockReset();
  vi.restoreAllMocks();
});

type ExecMatcher = (cmd: string, args: string[]) => string | Error | null;
function installExec(matcher: ExecMatcher): void {
  mockExec.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'git' && args.includes('status') && args.includes('--porcelain')) {
      return '';
    }
    const result = matcher(cmd, args);
    if (result instanceof Error) throw result;
    if (result === null) {
      throw new Error(`Unexpected exec: ${cmd} ${args.join(' ')}`);
    }
    return result;
  });
}

function makeExecError(status: number): Error {
  const e = new Error(`exec exit ${status}`) as Error & { status: number };
  e.status = status;
  return e;
}

const UPDATED_MDX = `---
title: "Sample Title"
description: "Re-ran benchmarks"
date: "2026-04-17"
tags:
  - TypeScript
published: true
canonical: "https://m0lz.dev/writing/alpha"
---

# Heading

Paragraph updated with the Q2 2026 benchmark numbers from the re-run.

The throughput delta is +18% under the new compiler toolchain.
`;

describe('createSiteUpdate — update-branch commit carries body + frontmatter', () => {
  it('branch = update/<slug>-cycle-<N>; MDX copied into content/posts/<slug>/index.mdx with body intact', () => {
    const f = setup();
    seedPublishedPost(f.db, 'alpha');
    openUpdateCycle(f.db, 'alpha', 'Re-ran benchmarks');
    seedDraftMdx(f.draftsDir, 'alpha', UPDATED_MDX);

    let prCreateCalls = 0;
    let observedBranch: string | null = null;
    let observedCommit: string | null = null;
    let observedPrTitle: string | null = null;
    installExec((cmd, args) => {
      if (cmd === 'git' && args.includes('--get')) {
        return 'git@github.com:jmolz/m0lz.00.git\n';
      }
      if (cmd === 'git' && args.includes('remote') && args.includes('get-url')) {
        return 'git@github.com:jmolz/m0lz.00.git\n';
      }
      if (cmd === 'git' && args.includes('branch') && args.includes('--list')) {
        observedBranch = args[args.length - 1];
        return '';
      }
      if (cmd === 'git' && args.includes('checkout') && args.includes('-b')) {
        observedBranch = args[args.indexOf('-b') + 1];
        return '';
      }
      if (cmd === 'git' && args.includes('add')) return '';
      if (cmd === 'git' && args.includes('diff') && args.includes('--cached')) {
        throw makeExecError(1);
      }
      if (cmd === 'git' && args.includes('commit')) {
        const i = args.indexOf('-m');
        observedCommit = i >= 0 ? args[i + 1] : null;
        return '';
      }
      if (cmd === 'git' && args.includes('push')) return '';
      if (cmd === 'gh' && args.includes('pr') && args.includes('list')) return '[]';
      if (cmd === 'gh' && args.includes('pr') && args.includes('create')) {
        prCreateCalls += 1;
        const ti = args.indexOf('--title');
        observedPrTitle = ti >= 0 ? args[ti + 1] : null;
        return 'https://github.com/jmolz/m0lz.00/pull/99\n';
      }
      return null;
    });

    const result = createSiteUpdate('alpha', f.config, {
      draftsDir: f.draftsDir,
      researchPagesDir: f.researchPagesDir,
      publishDir: f.publishDir,
      configPath: f.configPath,
    }, f.db);

    expect(result.prNumber).toBe(99);
    expect(result.cycleNumber).toBe(1);
    expect(observedBranch).toBe('update/alpha-cycle-1');
    expect(observedCommit).toBe('chore(site): update alpha (cycle 1)');
    expect(observedPrTitle).toBe('Update Sample Title (cycle 1)');
    expect(prCreateCalls).toBe(1);

    // The MDX written into the site repo MUST include the BODY lines, not
    // just frontmatter — contract criterion #14.
    const targetMdxPath = join(f.siteRepoPath, 'content/posts/alpha/index.mdx');
    expect(existsSync(targetMdxPath)).toBe(true);
    const landed = readFileSync(targetMdxPath, 'utf-8');
    expect(landed).toContain('Paragraph updated with the Q2 2026 benchmark numbers');
    expect(landed).toContain('+18% under the new compiler toolchain');
    // Frontmatter preserved too.
    expect(landed).toMatch(/^---\n[\s\S]*?title: "Sample Title"[\s\S]*?---/);
  });

  it('throws when there is no open update cycle (operator/runner bug)', () => {
    const f = setup();
    seedPublishedPost(f.db, 'orphan');
    seedDraftMdx(f.draftsDir, 'orphan', UPDATED_MDX);

    // No openUpdateCycle call — createSiteUpdate should fail fast.
    expect(() => createSiteUpdate('orphan', f.config, {
      draftsDir: f.draftsDir,
      researchPagesDir: f.researchPagesDir,
      publishDir: f.publishDir,
      configPath: f.configPath,
    }, f.db)).toThrow(/no open update cycle/);
  });
});

describe('completeUpdateUnderLock — finalization state', () => {
  it('closes cycle with ended_reason=completed; increments update_count; sets last_updated_at; phase stays published; writes update_completed metric', () => {
    const f = setup();
    seedPublishedPost(f.db, 'finalize');
    const { id: cycleId } = openUpdateCycle(f.db, 'finalize', 'summary');

    // Simulate a pipeline_steps table populated with all completed rows for
    // this cycle so allStepsComplete returns true. The shape matches what
    // the runner would seed via createPipelineSteps.
    f.db.prepare(`INSERT INTO pipeline_steps (post_slug, cycle_id, step_name, step_number, status)
                  VALUES (?, ?, 'verify', 1, 'completed'),
                         (?, ?, 'research-page', 2, 'completed'),
                         (?, ?, 'site-update', 3, 'completed'),
                         (?, ?, 'preview-gate', 4, 'completed'),
                         (?, ?, 'crosspost-devto', 5, 'completed'),
                         (?, ?, 'paste-medium', 6, 'completed'),
                         (?, ?, 'paste-substack', 7, 'completed'),
                         (?, ?, 'update-frontmatter', 8, 'completed'),
                         (?, ?, 'social-text', 9, 'completed')`)
      .run('finalize', cycleId, 'finalize', cycleId, 'finalize', cycleId, 'finalize', cycleId,
           'finalize', cycleId, 'finalize', cycleId, 'finalize', cycleId, 'finalize', cycleId,
           'finalize', cycleId);

    // finalizePipelineUnderLock needs the PID-stamped lockfile.
    mkdirSync(join(f.publishDir, 'finalize'), { recursive: true });
    writeFileSync(join(f.publishDir, 'finalize', '.publish.lock'), `${process.pid}\n`);

    completeUpdateUnderLock(f.db, 'finalize', cycleId, {
      site_url: 'https://m0lz.dev/writing/finalize',
      devto_url: 'https://dev.to/u/finalize',
    }, f.publishDir);

    const cycleRow = f.db
      .prepare('SELECT closed_at, ended_reason FROM update_cycles WHERE id = ?')
      .get(cycleId) as { closed_at: string | null; ended_reason: string | null };
    expect(cycleRow.closed_at).not.toBeNull();
    expect(cycleRow.ended_reason).toBe('completed');

    const post = f.db
      .prepare('SELECT phase, update_count, last_updated_at, site_url, devto_url FROM posts WHERE slug = ?')
      .get('finalize') as {
      phase: string; update_count: number; last_updated_at: string | null;
      site_url: string | null; devto_url: string | null;
    };
    expect(post.phase).toBe('published');
    expect(post.update_count).toBe(1);
    expect(post.last_updated_at).not.toBeNull();
    expect(post.site_url).toBe('https://m0lz.dev/writing/finalize');
    expect(post.devto_url).toBe('https://dev.to/u/finalize');

    const metricEvents = f.db
      .prepare('SELECT event, value FROM metrics WHERE post_slug = ? ORDER BY id')
      .all('finalize') as Array<{ event: string; value: string | null }>;
    const events = metricEvents.map((m) => m.event);
    expect(events).toContain('update_opened');
    expect(events).toContain('update_completed');
    const completedRow = metricEvents.find((m) => m.event === 'update_completed');
    expect(completedRow?.value).toBe(String(cycleId));
  });
});

describe('Update publish pipeline — shared per-slug lock contention', () => {
  it('a live lock blocks a second publish/update acquire on the same slug', () => {
    const f = setup();
    const release = acquirePublishLock(f.publishDir, 'contested', 10_000);
    try {
      expect(() => acquirePublishLock(f.publishDir, 'contested', 100))
        .toThrow(/Could not acquire publish lock for 'contested'/);
    } finally {
      release();
    }
  });
});

describe('Update publish pipeline — grep invariants', () => {
  it('update-mode finalizer does NOT advance posts.phase (phase stays published)', () => {
    const src = readFileSync(
      new URL('../src/core/publish/phase.ts', import.meta.url),
      'utf-8',
    );
    // The completeUpdateUnderLock function body must not contain
    // `advancePhase(db, slug, 'published')` — that's the initial-publish
    // finalizer's behavior. Update mode keeps phase unchanged.
    const updateFn = src.slice(src.indexOf('export function completeUpdateUnderLock'));
    const endIdx = updateFn.indexOf('\n}\n');
    const body = endIdx === -1 ? updateFn : updateFn.slice(0, endIdx + 3);
    expect(body).not.toMatch(/advancePhase\([^,]+,[^,]+,\s*['"]published['"]\)/);
  });
});
