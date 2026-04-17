import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { revertProjectReadmeLink } from '../src/core/unpublish/readme.js';
import { BlogConfig } from '../src/core/config/types.js';

let db: Database.Database | undefined;
let tempDir: string | undefined;

afterEach(() => {
  if (db) closeDatabase(db);
  db = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function baseConfig(overrides: Partial<BlogConfig> = {}): BlogConfig {
  return {
    site: { repo_path: '/tmp', base_url: 'https://x.dev', content_dir: 'content/posts', research_dir: 'content/research' },
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
    unpublish: { devto: true, medium: true, substack: true, readme: true },
    ...overrides,
  };
}

describe('revertProjectReadmeLink — skip paths', () => {
  it('skips when post has no project_id', () => {
    db = getDatabase(':memory:');
    db.prepare(
      `INSERT INTO posts (slug, phase, mode, project_id) VALUES ('p1', 'published', 'directed', NULL)`,
    ).run();
    const result = revertProjectReadmeLink('p1', baseConfig(), { configPath: '/tmp/.blogrc.yaml' }, db);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/no project_id/);
  });

  it('skips when config.projects[project_id] is absent', () => {
    db = getDatabase(':memory:');
    db.prepare(
      `INSERT INTO posts (slug, phase, mode, project_id) VALUES ('p2', 'published', 'directed', 'm0lz.02')`,
    ).run();
    const config = baseConfig();
    // No projects map at all
    const result = revertProjectReadmeLink('p2', config, { configPath: '/tmp/.blogrc.yaml' }, db);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/not configured/);
  });

  it('skips when writing link is not in README', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'readme-revert-'));
    const repoDir = join(tempDir, 'projrepo');
    mkdirSync(repoDir);
    // Initialize a git repo so the dirty-state check passes
    execFileSync('git', ['-C', repoDir, 'init', '--quiet', '--initial-branch=main'], { encoding: 'utf-8' });
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 't@example.com']);
    execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test']);
    writeFileSync(join(repoDir, 'README.md'), '# Project\n\nNo writing links here.\n');
    execFileSync('git', ['-C', repoDir, 'add', '.'], { encoding: 'utf-8' });
    execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init', '--quiet'], { encoding: 'utf-8' });

    db = getDatabase(':memory:');
    db.prepare(
      `INSERT INTO posts (slug, phase, mode, project_id) VALUES ('p3', 'published', 'directed', 'm0lz.99')`,
    ).run();
    const config = baseConfig({ projects: { 'm0lz.99': repoDir } });
    const result = revertProjectReadmeLink('p3', config, { configPath: join(tempDir, '.blogrc.yaml') }, db);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/not found in README/);
  });
});
