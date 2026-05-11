import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
import { computePreviewUrls } from '../src/core/publish/preview-urls.js';
import { BlogConfig } from '../src/core/config/types.js';
import { PostRow } from '../src/core/db/types.js';
import { runPublishShow, PublishCliPaths } from '../src/cli/publish.js';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  vi.restoreAllMocks();
});

function makeConfig(overrides: Partial<BlogConfig> = {}): BlogConfig {
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
    social: { platforms: ['linkedin', 'hackernews'], timing_recommendations: true },
    evaluation: {
      require_pass: true, min_sources: 3, max_reading_level: 12, three_reviewer_panel: true,
      consensus_must_fix: true, majority_should_fix: true, single_advisory: true,
      verify_benchmark_claims: true, methodology_completeness: true,
    },
    updates: {
      preserve_original_data: true, update_notice: true, update_crosspost: true,
      devto_update: true, refresh_paste_files: true, notice_template: 'Updated {DATE}: {SUMMARY}',
      require_summary: true, site_update_mode: 'pr',
    },
    unpublish: { devto: true, medium: true, substack: true, readme: true },
    ...overrides,
  };
}

function makePost(overrides: Partial<PostRow> = {}): PostRow {
  return {
    slug: 'test-post',
    title: null,
    topic: 'Test topic',
    content_type: 'project-launch',
    phase: 'publish',
    mode: 'directed',
    created_at: '2026-04-22T00:00:00.000Z',
    updated_at: '2026-04-22T00:00:00.000Z',
    published_at: null,
    unpublished_at: null,
    last_updated_at: null,
    site_url: null,
    devto_url: null,
    medium_url: null,
    substack_url: null,
    repo_url: null,
    project_id: null,
    evaluation_passed: 1,
    evaluation_score: null,
    has_benchmarks: 0,
    update_count: 0,
    ...overrides,
  };
}

describe('computePreviewUrls', () => {
  it('always emits canonicalUrl from config.site.base_url + slug', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'preview-canonical-'));
    const urls = computePreviewUrls(
      makePost({ slug: 'launch-post' }),
      makeConfig(),
      join(tempDir, '.blogrc.yaml'),
      join(tempDir, 'research-pages'),
    );
    expect(urls.canonicalUrl).toBe('https://m0lz.dev/writing/launch-post');
  });

  it('supplementaryUrl is null when no research page file exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'preview-no-research-'));
    const urls = computePreviewUrls(
      makePost({ slug: 'no-research' }),
      makeConfig(),
      join(tempDir, '.blogrc.yaml'),
      join(tempDir, 'research-pages'),
    );
    expect(urls.supplementaryUrl).toBeNull();
  });

  it('supplementaryUrl is set when research-pages/<slug>/index.mdx exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'preview-has-research-'));
    const researchPagesDir = join(tempDir, 'research-pages');
    mkdirSync(join(researchPagesDir, 'has-research'), { recursive: true });
    writeFileSync(join(researchPagesDir, 'has-research', 'index.mdx'), '---\n---\n');

    const urls = computePreviewUrls(
      makePost({ slug: 'has-research' }),
      makeConfig(),
      join(tempDir, '.blogrc.yaml'),
      researchPagesDir,
    );
    expect(urls.supplementaryUrl).toBe('https://m0lz.dev/research/has-research');
  });

  it('companionRepoUrl resolves from config.projects + git origin when post.repo_url is empty', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'preview-companion-'));
    const projectDir = join(tempDir, 'project');
    mkdirSync(projectDir, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/x/y.git'], { cwd: projectDir });

    const configPath = join(tempDir, '.blogrc.yaml');
    writeFileSync(configPath, 'site:\n  repo_path: ./site\n');

    const config = makeConfig();
    config.projects = { 'test.01': './project' };

    const urls = computePreviewUrls(
      makePost({ project_id: 'test.01' }),
      config,
      configPath,
      join(tempDir, 'research-pages'),
    );
    expect(urls.companionRepoUrl).toBe('https://github.com/x/y');
  });

  it('prefers post.repo_url over config.projects origin lookup', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'preview-repo-url-'));
    const configPath = join(tempDir, '.blogrc.yaml');
    writeFileSync(configPath, 'site:\n  repo_path: ./site\n');

    const config = makeConfig();
    config.projects = { 'test.01': './project' }; // nonexistent — ignored

    const urls = computePreviewUrls(
      makePost({ project_id: 'test.01', repo_url: 'https://github.com/persisted/repo' }),
      config,
      configPath,
      join(tempDir, 'research-pages'),
    );
    expect(urls.companionRepoUrl).toBe('https://github.com/persisted/repo');
  });

  it('companionRepoUrl is null when no project_id and no repo_url', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'preview-no-companion-'));
    const urls = computePreviewUrls(
      makePost(),
      makeConfig(),
      join(tempDir, '.blogrc.yaml'),
      join(tempDir, 'research-pages'),
    );
    expect(urls.companionRepoUrl).toBeNull();
  });

  it('companionRepoUrl is null when project dir resolves but has no origin', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'preview-no-origin-'));
    const projectDir = join(tempDir, 'project');
    mkdirSync(projectDir, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
    // No `git remote add origin`

    const configPath = join(tempDir, '.blogrc.yaml');
    writeFileSync(configPath, 'site:\n  repo_path: ./site\n');

    const config = makeConfig();
    config.projects = { 'test.01': './project' };

    const urls = computePreviewUrls(
      makePost({ project_id: 'test.01' }),
      config,
      configPath,
      join(tempDir, 'research-pages'),
    );
    expect(urls.companionRepoUrl).toBeNull();
  });
});

describe('blog publish show --json surfaces preview_urls', () => {
  it('envelope includes preview_urls with all three keys', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'publish-show-json-'));
    const dbPath = join(tempDir, 'state.db');
    const configPath = join(tempDir, '.blogrc.yaml');
    const researchPagesDir = join(tempDir, 'research-pages');
    const projectDir = join(tempDir, 'project');

    // Set up a project with a git origin so companionRepoUrl resolves.
    mkdirSync(projectDir, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/x/y.git'], { cwd: projectDir });

    writeFileSync(configPath, `site:
  repo_path: "./site"
  base_url: "https://m0lz.dev"
  content_dir: "content/posts"
  research_dir: "content/research"
author:
  name: "Tester"
  github: "jmolz"
projects:
  test.01: "./project"
`);

    // Seed post in phase=publish with project_id=test.01.
    const db = getDatabase(dbPath);
    try {
      initResearchPost(db, 'envelope-check', 'topic', 'directed', 'project-launch', 'test.01');
      advancePhase(db, 'envelope-check', 'benchmark');
      advancePhase(db, 'envelope-check', 'draft');
      advancePhase(db, 'envelope-check', 'evaluate');
      db.prepare('UPDATE posts SET evaluation_passed = 1 WHERE slug = ?').run('envelope-check');
      advancePhase(db, 'envelope-check', 'publish');
    } finally {
      closeDatabase(db);
    }

    const logs: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array): boolean => {
      logs.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const paths: PublishCliPaths = {
      dbPath,
      configPath,
      draftsDir: join(tempDir, 'drafts'),
      benchmarkDir: join(tempDir, 'benchmarks'),
      evaluationsDir: join(tempDir, 'evaluations'),
      researchDir: join(tempDir, 'research'),
      reposDir: join(tempDir, 'repos'),
      socialDir: join(tempDir, 'social'),
      researchPagesDir,
      publishDir: join(tempDir, 'publish'),
      templatesDir: join(tempDir, 'templates'),
      json: true,
    };
    runPublishShow('envelope-check', paths);

    const jsonLine = logs.find((l) => l.includes('"kind"'));
    expect(jsonLine).toBeDefined();
    const envelope = JSON.parse(jsonLine!);
    expect(envelope.kind).toBe('PublishPipeline');
    expect(envelope.data.preview_urls).toBeDefined();
    expect(envelope.data.preview_urls.canonicalUrl).toBe('https://m0lz.dev/writing/envelope-check');
    expect(envelope.data.preview_urls.supplementaryUrl).toBeNull();
    expect(envelope.data.preview_urls.companionRepoUrl).toBe('https://github.com/x/y');
  });

  it('envelope preview_urls.supplementaryUrl is populated when research page exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'publish-show-research-'));
    const dbPath = join(tempDir, 'state.db');
    const configPath = join(tempDir, '.blogrc.yaml');
    const researchPagesDir = join(tempDir, 'research-pages');

    writeFileSync(configPath, `site:
  repo_path: "./site"
  base_url: "https://m0lz.dev"
  content_dir: "content/posts"
  research_dir: "content/research"
author:
  name: "Tester"
  github: "jmolz"
`);

    mkdirSync(join(researchPagesDir, 'with-research'), { recursive: true });
    writeFileSync(join(researchPagesDir, 'with-research', 'index.mdx'), '---\ntitle: X\n---\n');

    const db = getDatabase(dbPath);
    try {
      initResearchPost(db, 'with-research', 'topic', 'directed', 'technical-deep-dive');
      advancePhase(db, 'with-research', 'benchmark');
      advancePhase(db, 'with-research', 'draft');
      advancePhase(db, 'with-research', 'evaluate');
      db.prepare('UPDATE posts SET evaluation_passed = 1 WHERE slug = ?').run('with-research');
      advancePhase(db, 'with-research', 'publish');
    } finally {
      closeDatabase(db);
    }

    const logs: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array): boolean => {
      logs.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    runPublishShow('with-research', {
      dbPath,
      configPath,
      researchPagesDir,
      json: true,
    });

    const jsonLine = logs.find((l) => l.includes('"kind"'));
    const envelope = JSON.parse(jsonLine!);
    expect(envelope.data.preview_urls.supplementaryUrl).toBe('https://m0lz.dev/research/with-research');
    expect(envelope.data.preview_urls.companionRepoUrl).toBeNull();
  });
});
