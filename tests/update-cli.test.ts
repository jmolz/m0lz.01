import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

import { closeDatabase, getDatabase } from '../src/core/db/database.js';
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
import { openUpdateCycle } from '../src/core/update/cycles.js';
import yaml from 'js-yaml';

import { runUpdateAbort, runUpdateStart, runUpdateShow } from '../src/cli/update.js';
import { BlogConfig } from '../src/core/config/types.js';

interface Fx {
  tempDir: string;
  dbPath: string;
  configPath: string;
  draftsDir: string;
  db?: Database.Database;
}

let fx: Fx | undefined;
let savedExitCode: number | undefined;

function mkBaseConfig(): BlogConfig {
  return {
    site: { repo_path: '/tmp/site', base_url: 'https://m0lz.dev', content_dir: 'content/posts', research_dir: 'content/research' },
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
  const tempDir = mkdtempSync(join(tmpdir(), 'update-cli-'));
  const dbPath = join(tempDir, 'state.db');
  const configPath = join(tempDir, '.blogrc.yaml');
  const draftsDir = join(tempDir, 'drafts');
  mkdirSync(draftsDir, { recursive: true });
  writeFileSync(configPath, yaml.dump(mkBaseConfig()), 'utf-8');
  fx = { tempDir, dbPath, configPath, draftsDir };
  savedExitCode = process.exitCode;
  return fx;
}

function seedPublishedPost(db: Database.Database, slug: string): void {
  initResearchPost(db, slug, 'topic', 'directed', 'technical-deep-dive');
  advancePhase(db, slug, 'benchmark');
  advancePhase(db, slug, 'draft');
  advancePhase(db, slug, 'evaluate');
  db.prepare('UPDATE posts SET evaluation_passed = 1 WHERE slug = ?').run(slug);
  advancePhase(db, slug, 'publish');
  advancePhase(db, slug, 'published');
}

afterEach(() => {
  if (fx?.db) closeDatabase(fx.db);
  if (fx) rmSync(fx.tempDir, { recursive: true, force: true });
  fx = undefined;
  process.exitCode = savedExitCode;
  vi.restoreAllMocks();
});

describe('runUpdateAbort', () => {
  it('closes cycle with ended_reason=aborted, writes update_aborted metric, preserves draft artifacts on disk', () => {
    const f = setup();
    // Seed DB with a published post and an open cycle.
    f.db = getDatabase(f.dbPath);
    seedPublishedPost(f.db, 'alpha');
    openUpdateCycle(f.db, 'alpha', 'Re-ran benchmarks on Q2 versions');
    closeDatabase(f.db);
    f.db = undefined;

    // Seed a regenerated draft artifact (the one blog update draft would have produced).
    const draftSlugDir = join(f.draftsDir, 'alpha');
    mkdirSync(draftSlugDir, { recursive: true });
    const draftMdxPath = join(draftSlugDir, 'index.mdx');
    const draftBody = '---\ntitle: "Alpha"\n---\n\n<!-- update-notice cycle=1 date=2026-04-17 -->\nUpdated.\n<!-- /update-notice -->\n\nBody.\n';
    writeFileSync(draftMdxPath, draftBody, 'utf-8');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    runUpdateAbort('alpha', { dbPath: f.dbPath });

    // exitCode stays 0 for successful abort.
    expect(process.exitCode ?? 0).toBe(0);

    // Re-open DB and verify closed_at / ended_reason / metric row.
    f.db = getDatabase(f.dbPath);
    const cycleRow = f.db
      .prepare('SELECT closed_at, ended_reason FROM update_cycles WHERE post_slug = ?')
      .get('alpha') as { closed_at: string | null; ended_reason: string | null };
    expect(cycleRow.closed_at).not.toBeNull();
    expect(cycleRow.ended_reason).toBe('aborted');

    const metricEvents = f.db
      .prepare('SELECT event FROM metrics WHERE post_slug = ? ORDER BY id')
      .all('alpha') as Array<{ event: string }>;
    expect(metricEvents.map((m) => m.event)).toContain('update_aborted');

    // On-disk draft artifact MUST be preserved — abort does not sweep the FS.
    expect(existsSync(draftMdxPath)).toBe(true);
    expect(readFileSync(draftMdxPath, 'utf-8')).toBe(draftBody);
  });

  it('exits 1 when no open cycle exists for the slug', () => {
    const f = setup();
    f.db = getDatabase(f.dbPath);
    seedPublishedPost(f.db, 'nocycle');
    closeDatabase(f.db);
    f.db = undefined;

    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });

    runUpdateAbort('nocycle', { dbPath: f.dbPath });

    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/requires an open update cycle/);
  });

  it('exits 1 on invalid slug without touching the DB', () => {
    const f = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    runUpdateAbort('BAD/SLUG!', { dbPath: f.dbPath });
    expect(process.exitCode).toBe(1);
    // state.db should not exist because the slug validation failed before DB open.
    expect(existsSync(f.dbPath)).toBe(false);
  });
});

describe('runUpdateStart — --summary contract', () => {
  it('refuses to open a cycle when summary is empty (require_summary=true default)', () => {
    const f = setup();
    f.db = getDatabase(f.dbPath);
    seedPublishedPost(f.db, 'needy');
    closeDatabase(f.db);
    f.db = undefined;

    vi.spyOn(console, 'error').mockImplementation(() => {});
    runUpdateStart('needy', { summary: '' }, { dbPath: f.dbPath, configPath: f.configPath });
    expect(process.exitCode).toBe(1);

    // No cycle row should have been created.
    f.db = getDatabase(f.dbPath);
    const cycles = f.db.prepare('SELECT id FROM update_cycles WHERE post_slug = ?').all('needy');
    expect(cycles).toEqual([]);
  });
});

describe('runUpdateShow', () => {
  it('prints phase / update_count / cycle table for posts with and without cycles', () => {
    const f = setup();
    f.db = getDatabase(f.dbPath);
    seedPublishedPost(f.db, 'shown');
    closeDatabase(f.db);
    f.db = undefined;

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });

    runUpdateShow('shown', { dbPath: f.dbPath });

    const joined = logs.join('\n');
    expect(joined).toMatch(/phase:\s+published/);
    expect(joined).toMatch(/update_count:\s+0/);
    expect(joined).toMatch(/No update cycles yet/);
  });
});
