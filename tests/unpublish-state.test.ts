import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { initUnpublish, completeUnpublishUnderLock } from '../src/core/unpublish/state.js';
import { listUnpublishSteps, allStepsComplete } from '../src/core/unpublish/steps-crud.js';
import { UNPUBLISH_STEP_NAMES } from '../src/core/unpublish/steps-registry.js';
import { BlogConfig } from '../src/core/config/types.js';

let db: Database.Database | undefined;
let tempDir: string | undefined;

afterEach(() => {
  if (db) closeDatabase(db);
  db = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function mkConfig(overrides: Partial<BlogConfig['unpublish']> = {}): BlogConfig {
  return {
    site: { repo_path: '/tmp', base_url: 'https://x', content_dir: 'content/posts', research_dir: 'content/research' },
    author: { name: 'T', github: 't' },
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
    updates: {
      preserve_original_data: true, update_notice: true, update_crosspost: true,
      devto_update: true, refresh_paste_files: true, notice_template: 'Updated {DATE}: {SUMMARY}',
      require_summary: true, site_update_mode: 'pr',
    },
    unpublish: { devto: true, medium: true, substack: true, readme: true, ...overrides },
  };
}

function seedPublishedPost(database: Database.Database, slug: string): void {
  database
    .prepare(
      `INSERT INTO posts (slug, phase, mode, content_type, project_id)
       VALUES (?, 'published', 'directed', 'technical-deep-dive', NULL)`,
    )
    .run(slug);
}

describe('initUnpublish', () => {
  it('seeds all 7 unpublish_steps rows and writes unpublish_started metric', () => {
    db = getDatabase(':memory:');
    seedPublishedPost(db, 'post1');

    const result = initUnpublish(db, 'post1', mkConfig());
    expect(result.alreadyUnpublished).toBe(false);

    const steps = listUnpublishSteps(db, 'post1');
    expect(steps).toHaveLength(UNPUBLISH_STEP_NAMES.length);
    expect(steps.map((s) => s.step_name)).toEqual([...UNPUBLISH_STEP_NAMES]);

    const metrics = db
      .prepare(`SELECT event FROM metrics WHERE post_slug = ?`)
      .all('post1') as Array<{ event: string }>;
    expect(metrics.map((m) => m.event)).toEqual(['unpublish_started']);
  });

  it('pre-skips steps disabled by config', () => {
    db = getDatabase(':memory:');
    seedPublishedPost(db, 'p2');
    initUnpublish(db, 'p2', mkConfig({ devto: false, readme: false }));
    const steps = listUnpublishSteps(db, 'p2');
    const byName = new Map(steps.map((s) => [s.step_name, s.status]));
    expect(byName.get('devto-unpublish')).toBe('skipped');
    expect(byName.get('readme-revert')).toBe('skipped');
    expect(byName.get('medium-instructions')).toBe('pending');
    expect(byName.get('substack-instructions')).toBe('pending');
  });

  it('returns alreadyUnpublished:true for an already-unpublished post', () => {
    db = getDatabase(':memory:');
    db.prepare(
      `INSERT INTO posts (slug, phase, mode) VALUES ('done', 'unpublished', 'directed')`,
    ).run();
    const result = initUnpublish(db, 'done', mkConfig());
    expect(result.alreadyUnpublished).toBe(true);
    const steps = listUnpublishSteps(db, 'done');
    expect(steps).toEqual([]);
  });

  it('rejects posts that are not in published phase', () => {
    db = getDatabase(':memory:');
    db.prepare(
      `INSERT INTO posts (slug, phase, mode) VALUES ('d', 'draft', 'directed')`,
    ).run();
    expect(() => initUnpublish(db!, 'd', mkConfig())).toThrow(/'draft'.*'published'/);
  });

  it('rejects missing posts', () => {
    db = getDatabase(':memory:');
    expect(() => initUnpublish(db!, 'nope', mkConfig())).toThrow(/not found/);
  });
});

describe('completeUnpublishUnderLock', () => {
  it('advances phase to unpublished and writes metric when all steps terminal', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'unpub-'));
    const publishDir = join(tempDir, 'publish');
    mkdirSync(join(publishDir, 'post1'), { recursive: true });
    writeFileSync(join(publishDir, 'post1', '.publish.lock'), `${process.pid}\n`);

    db = getDatabase(':memory:');
    seedPublishedPost(db, 'post1');
    initUnpublish(db, 'post1', mkConfig());

    // Force all steps to completed so the finalizer passes allStepsComplete.
    db.prepare(
      `UPDATE unpublish_steps SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE post_slug = 'post1'`,
    ).run();
    expect(allStepsComplete(db, 'post1')).toBe(true);

    completeUnpublishUnderLock(db, 'post1', publishDir);
    const row = db
      .prepare(`SELECT phase, unpublished_at FROM posts WHERE slug = ?`)
      .get('post1') as { phase: string; unpublished_at: string };
    expect(row.phase).toBe('unpublished');
    expect(row.unpublished_at).not.toBeNull();

    const events = db
      .prepare(`SELECT event FROM metrics WHERE post_slug = ? ORDER BY id`)
      .all('post1') as Array<{ event: string }>;
    expect(events.map((e) => e.event)).toEqual(['unpublish_started', 'unpublished']);
  });
});
