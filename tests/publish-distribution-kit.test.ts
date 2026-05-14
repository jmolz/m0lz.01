import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../src/core/publish/platform-images.js', () => ({
  ensurePlatformImages: vi.fn(async () => ({
    slug: 'alpha',
    draftPath: '',
    receiptPath: '',
    frontmatterUpdated: false,
    images: [],
  })),
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
import { createSitePR } from '../src/core/publish/site.js';
// eslint-disable-next-line import/first
import { generateDistributionKit } from '../src/core/publish/distribution-kit.js';
// eslint-disable-next-line import/first
import { persistDistributionKitToSite } from '../src/core/publish/site-artifacts.js';
// eslint-disable-next-line import/first
import { PIPELINE_STEPS } from '../src/core/publish/pipeline-registry.js';
// eslint-disable-next-line import/first
import { ImageGenerationRequest, ImageProvider } from '../src/core/publish/openai-image.js';
// eslint-disable-next-line import/first
import { PipelineContext } from '../src/core/publish/pipeline-types.js';
// eslint-disable-next-line import/first
import { BlogConfig } from '../src/core/config/types.js';

const mockExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

interface Fixture {
  tempDir: string;
  siteRepoPath: string;
  draftsDir: string;
  socialDir: string;
  templatesDir: string;
  researchPagesDir: string;
  publishDir: string;
  configPath: string;
  db: Database.Database;
  config: BlogConfig;
}

let fixture: Fixture | undefined;
let originalOpenAIKey: string | undefined;

function makeConfig(siteRepoPath: string): BlogConfig {
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
    social: {
      platforms: ['linkedin', 'hackernews'],
      timing_recommendations: true,
      distribution_kit: { enabled: true, persist_to_site: true, directory: 'distribution' },
      linkedin_image: {
        mode: 'prompt-only',
        model: 'gpt-image-2-2026-04-21',
        size: '1200x1200',
        quality: 'high',
      },
    },
    evaluation: { require_pass: true, min_sources: 3, max_reading_level: 12, three_reviewer_panel: true, consensus_must_fix: true, majority_should_fix: true, single_advisory: true, verify_benchmark_claims: true, methodology_completeness: true },
    updates: { preserve_original_data: true, update_notice: true, update_crosspost: true, devto_update: true, refresh_paste_files: true, notice_template: 'Updated {DATE}: {SUMMARY}', require_summary: true, site_update_mode: 'pr' },
    unpublish: { devto: true, medium: true, substack: true, readme: true },
  };
}

function setup(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'publish-distribution-kit-'));
  const siteRepoPath = join(tempDir, 'm0lz.00');
  const draftsDir = join(tempDir, 'drafts');
  const socialDir = join(tempDir, 'social');
  const templatesDir = join(tempDir, 'templates');
  const researchPagesDir = join(tempDir, 'research-pages');
  const publishDir = join(tempDir, 'publish');
  const configPath = join(tempDir, '.blogrc.yaml');
  [siteRepoPath, draftsDir, socialDir, templatesDir, researchPagesDir, publishDir].forEach((dir) => mkdirSync(dir, { recursive: true }));
  mkdirSync(join(templatesDir, 'social'), { recursive: true });
  writeFileSync(join(templatesDir, 'social/linkedin.md'), readFileSync(join(__dirname, '../templates/social/linkedin.md'), 'utf-8'));
  writeFileSync(join(templatesDir, 'social/hackernews.md'), readFileSync(join(__dirname, '../templates/social/hackernews.md'), 'utf-8'));
  writeFileSync(join(templatesDir, 'social/linkedin-image-prompt.md'), readFileSync(join(__dirname, '../templates/social/linkedin-image-prompt.md'), 'utf-8'));
  writeFileSync(configPath, '');
  const db = getDatabase(':memory:');
  const config = makeConfig(siteRepoPath);
  fixture = { tempDir, siteRepoPath, draftsDir, socialDir, templatesDir, researchPagesDir, publishDir, configPath, db, config };
  return fixture;
}

function seedPost(f: Fixture, slug: string): void {
  initResearchPost(f.db, slug, 'Distribution kit post for m0lz.01.', 'directed', 'project-launch', 'm0lz.01');
  advancePhase(f.db, slug, 'benchmark');
  advancePhase(f.db, slug, 'draft');
  advancePhase(f.db, slug, 'evaluate');
  f.db.prepare('UPDATE posts SET title = ?, repo_url = ?, evaluation_passed = 1 WHERE slug = ?')
    .run('Distribution Kit Title', 'https://github.com/jmolz/m0lz.01', slug);
  advancePhase(f.db, slug, 'publish');
  const draftDir = join(f.draftsDir, slug);
  mkdirSync(draftDir, { recursive: true });
  writeFileSync(join(draftDir, 'index.mdx'), `---
title: "Distribution Kit Title"
description: "Distribution kit post for m0lz.01."
date: "2026-05-14"
tags:
  - TypeScript
published: false
canonical: "https://m0lz.dev/writing/${slug}"
project: "m0lz.01"
---

Body
`, 'utf-8');
}

function seedSitePost(f: Fixture, slug: string): void {
  const postDir = join(f.siteRepoPath, 'content/posts', slug);
  mkdirSync(postDir, { recursive: true });
  writeFileSync(join(postDir, 'index.mdx'), '---\ntitle: "Distribution Kit Title"\npublished: true\n---\nBody\n', 'utf-8');
}

function makeExecError(status: number): Error {
  const err = new Error(`exec exit ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

class FakeProvider implements ImageProvider {
  calls: ImageGenerationRequest[] = [];
  constructor(private readonly bytes: Buffer) {}

  async generateImage(request: ImageGenerationRequest): Promise<{ bytes: Buffer }> {
    this.calls.push(request);
    return { bytes: this.bytes };
  }
}

function makePipelineContext(f: Fixture, slug: string): PipelineContext {
  return {
    db: f.db,
    slug,
    config: f.config,
    paths: {
      dbPath: join(f.tempDir, 'state.db'),
      configPath: f.configPath,
      draftsDir: f.draftsDir,
      benchmarkDir: join(f.tempDir, 'benchmarks'),
      evaluationsDir: join(f.tempDir, 'evaluations'),
      researchDir: join(f.tempDir, 'research'),
      reposDir: join(f.tempDir, 'repos'),
      socialDir: f.socialDir,
      researchPagesDir: f.researchPagesDir,
      publishDir: f.publishDir,
      templatesDir: f.templatesDir,
    },
    urls: {},
    publishMode: 'initial',
    cycleId: 0,
  };
}

function mockSiteArtifactGit(options: {
  remoteUrl?: string;
  stagedNames?: string;
  dirtyStatus?: string;
  cachedHasChanges?: boolean;
  aheadLog?: string;
  showFiles?: string;
} = {}): { addCalls: string[]; commits: string[]; pushes: string[] } {
  const calls = { addCalls: [] as string[], commits: [] as string[], pushes: [] as string[] };
  mockExec.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'git' && args.includes('remote') && args.includes('get-url')) {
      return options.remoteUrl ?? 'git@github.com:jmolz/m0lz.00.git\n';
    }
    if (cmd === 'git' && args.includes('checkout')) return '';
    if (cmd === 'git' && args.includes('pull')) return '';
    if (cmd === 'git' && args.includes('diff') && args.includes('--cached') && args.includes('--name-only')) {
      return options.stagedNames ?? '';
    }
    if (cmd === 'git' && args.includes('status')) return options.dirtyStatus ?? '';
    if (cmd === 'git' && args.includes('add')) {
      calls.addCalls.push(args[args.length - 1]);
      return '';
    }
    if (cmd === 'git' && args.includes('diff') && args.includes('--cached') && args.includes('--quiet')) {
      if (options.cachedHasChanges ?? true) throw makeExecError(1);
      return '';
    }
    if (cmd === 'git' && args.includes('log') && args.includes('origin/main..HEAD')) {
      return options.aheadLog ?? '';
    }
    if (cmd === 'git' && args.includes('show') && args.includes('--name-only')) {
      return options.showFiles ?? '';
    }
    if (cmd === 'git' && args.includes('commit')) {
      calls.commits.push(args[args.indexOf('-m') + 1]);
      return '';
    }
    if (cmd === 'git' && args.includes('push')) {
      calls.pushes.push(args.slice(args.indexOf('push') + 1).join(' '));
      return '';
    }
    throw new Error(`Unexpected exec: ${cmd} ${args.join(' ')}`);
  });
  return calls;
}

beforeEach(() => {
  originalOpenAIKey = process.env.OPENAI_API_KEY;
  mockExec.mockReset();
});

afterEach(() => {
  if (originalOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIKey;
  }
  if (fixture?.db) closeDatabase(fixture.db);
  if (fixture) rmSync(fixture.tempDir, { recursive: true, force: true });
  fixture = undefined;
  vi.restoreAllMocks();
});

describe('createSitePR distribution-kit preflight', () => {
  it('required image mode fails before git checkout, copy, commit, push, or PR creation', async () => {
    const f = setup();
    seedPost(f, 'alpha');
    delete process.env.OPENAI_API_KEY;
    f.config.social.linkedin_image.mode = 'required';
    mockExec.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('status') && args.includes('--porcelain')) return '';
      if (cmd === 'git' && args.includes('remote') && args.includes('get-url')) return 'git@github.com:jmolz/m0lz.00.git\n';
      if (cmd === 'git' && args.includes('--get')) return 'git@github.com:jmolz/m0lz.00.git\n';
      if (cmd === 'git' && args.includes('fetch')) return '';
      if (cmd === 'git' && args.includes('rev-list')) return '0\n';
      throw new Error(`Unexpected exec before preflight failure: ${cmd} ${args.join(' ')}`);
    });

    await expect(createSitePR('alpha', f.config, {
      draftsDir: f.draftsDir,
      researchPagesDir: f.researchPagesDir,
      publishDir: f.publishDir,
      configPath: f.configPath,
      socialDir: f.socialDir,
      templatesDir: f.templatesDir,
    }, f.db)).rejects.toThrow(/OPENAI_API_KEY/);

    const calls = mockExec.mock.calls.map(([, args]) => (args as string[]).join(' '));
    expect(calls.some((args) => args.includes('checkout'))).toBe(false);
    expect(calls.some((args) => args.includes('commit'))).toBe(false);
    expect(calls.some((args) => args.includes('push'))).toBe(false);
    expect(calls.some((args) => args.includes('pr create'))).toBe(false);
  });
});

describe('PIPELINE_STEPS social-text distribution-kit persistence', () => {
  it('persists the existing local kit and optional image without calling OpenAI', async () => {
    const f = setup();
    seedPost(f, 'pipeline-kit');
    seedSitePost(f, 'pipeline-kit');
    const png = await sharp({ create: { width: 1200, height: 1200, channels: 4, background: '#333333' } }).png().toBuffer();
    const provider = new FakeProvider(png);
    await generateDistributionKit('pipeline-kit', f.config, f, f.db, {
      sourceMode: 'publish',
      imageMode: 'generate',
      provider,
    });
    expect(provider.calls.length).toBe(1);

    f.config.social.linkedin_image.mode = 'required';
    delete process.env.OPENAI_API_KEY;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch should not be called'));
    const calls = mockSiteArtifactGit();
    const step = PIPELINE_STEPS.find((candidate) => candidate.name === 'social-text');
    if (!step) throw new Error('social-text step missing');

    const result = await step.execute(makePipelineContext(f, 'pipeline-kit'));

    expect(result.outcome).toBe('completed');
    expect(provider.calls.length).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls.addCalls).toEqual([
      'content/posts/pipeline-kit/distribution',
      'content/posts/pipeline-kit/assets/linkedin-feed.png',
    ]);
    expect(existsSync(join(f.siteRepoPath, 'content/posts/pipeline-kit/distribution/linkedin.md'))).toBe(true);
    expect(existsSync(join(f.siteRepoPath, 'content/posts/pipeline-kit/distribution/hackernews.md'))).toBe(true);
    expect(existsSync(join(f.siteRepoPath, 'content/posts/pipeline-kit/distribution/linkedin-image-prompt.md'))).toBe(true);
    expect(existsSync(join(f.siteRepoPath, 'content/posts/pipeline-kit/distribution/manifest.json'))).toBe(true);
    expect(existsSync(join(f.siteRepoPath, 'content/posts/pipeline-kit/assets/linkedin-feed.png'))).toBe(true);
  });
});

describe('persistDistributionKitToSite', () => {
  it('stages only distribution files and commits the expected subject', async () => {
    const f = setup();
    seedPost(f, 'alpha');
    seedSitePost(f, 'alpha');
    const kit = await generateDistributionKit('alpha', f.config, f, f.db, { sourceMode: 'publish' });
    const calls = mockSiteArtifactGit();

    const result = persistDistributionKitToSite('alpha', f.config, { configPath: f.configPath }, kit);
    expect(result.updated).toBe(true);
    expect(calls.addCalls).toEqual(['content/posts/alpha/distribution']);
    expect(calls.commits).toEqual(['chore(distribution): alpha']);
    expect(existsSync(join(f.siteRepoPath, 'content/posts/alpha/distribution/linkedin.md'))).toBe(true);
    expect(existsSync(join(f.siteRepoPath, 'content/posts/alpha/distribution/manifest.json'))).toBe(true);
  });

  it('refuses a site repo whose origin does not match the configured hub repo', async () => {
    const f = setup();
    seedPost(f, 'origin');
    seedSitePost(f, 'origin');
    const kit = await generateDistributionKit('origin', f.config, f, f.db, { sourceMode: 'publish' });
    mockSiteArtifactGit({ remoteUrl: 'git@github.com:someone-else/m0lz.00.git\n' });

    expect(() => persistDistributionKitToSite('origin', f.config, { configPath: f.configPath }, kit))
      .toThrow(/origin points to .*pipeline expected/);
    const calls = mockExec.mock.calls.map(([, args]) => (args as string[]).join(' '));
    expect(calls.some((args) => args.includes('checkout'))).toBe(false);
  });

  it('refuses staged site-repo changes before copying artifacts', async () => {
    const f = setup();
    seedPost(f, 'staged');
    seedSitePost(f, 'staged');
    const kit = await generateDistributionKit('staged', f.config, f, f.db, { sourceMode: 'publish' });
    const calls = mockSiteArtifactGit({
      stagedNames: 'content/posts/other/index.mdx\n',
    });

    expect(() => persistDistributionKitToSite('staged', f.config, { configPath: f.configPath }, kit))
      .toThrow(/has staged changes/);
    expect(calls.addCalls).toEqual([]);
  });

  it('refuses unrelated dirty files before staging distribution artifacts', async () => {
    const f = setup();
    seedPost(f, 'dirty');
    seedSitePost(f, 'dirty');
    const kit = await generateDistributionKit('dirty', f.config, f, f.db, { sourceMode: 'publish' });
    const calls = mockSiteArtifactGit({ dirtyStatus: ' M README.md\n' });

    expect(() => persistDistributionKitToSite('dirty', f.config, { configPath: f.configPath }, kit))
      .toThrow(/uncommitted changes unrelated/);
    expect(calls.addCalls).toEqual([]);
  });

  it('refuses unexpected ahead commits before staging new distribution changes', async () => {
    const f = setup();
    seedPost(f, 'ahead-dirty');
    seedSitePost(f, 'ahead-dirty');
    const kit = await generateDistributionKit('ahead-dirty', f.config, f, f.db, { sourceMode: 'publish' });
    const calls = mockSiteArtifactGit({
      cachedHasChanges: true,
      aheadLog: 'abc123\tchore(other): unrelated local work\n',
      showFiles: 'README.md\n',
    });

    expect(() => persistDistributionKitToSite('ahead-dirty', f.config, { configPath: f.configPath }, kit))
      .toThrow(/subject/);
    expect(calls.addCalls).toEqual([]);
    expect(calls.commits).toEqual([]);
    expect(calls.pushes).toEqual([]);
    expect(existsSync(join(f.siteRepoPath, 'content/posts/ahead-dirty/distribution'))).toBe(false);
  });

  it('returns an exact no-op when artifacts match and no ahead commit exists', async () => {
    const f = setup();
    seedPost(f, 'noop');
    seedSitePost(f, 'noop');
    const kit = await generateDistributionKit('noop', f.config, f, f.db, { sourceMode: 'publish' });
    const calls = mockSiteArtifactGit({
      cachedHasChanges: false,
      aheadLog: '',
    });

    const result = persistDistributionKitToSite('noop', f.config, { configPath: f.configPath }, kit);

    expect(result.updated).toBe(false);
    expect(result.reason).toBe('No distribution-kit changes');
    expect(calls.commits).toEqual([]);
    expect(calls.pushes).toEqual([]);
  });

  it('pushes an exact crash-replay ahead commit without creating a second commit', async () => {
    const f = setup();
    seedPost(f, 'replay');
    seedSitePost(f, 'replay');
    const kit = await generateDistributionKit('replay', f.config, f, f.db, { sourceMode: 'publish' });
    const expectedFiles = [
      'content/posts/replay/distribution/hackernews.md',
      'content/posts/replay/distribution/linkedin-image-prompt.md',
      'content/posts/replay/distribution/linkedin.md',
      'content/posts/replay/distribution/manifest.json',
    ].join('\n');
    const calls = mockSiteArtifactGit({
      cachedHasChanges: false,
      aheadLog: 'abc123\tchore(distribution): replay\n',
      showFiles: `${expectedFiles}\n`,
    });

    const result = persistDistributionKitToSite('replay', f.config, { configPath: f.configPath }, kit);

    expect(result.updated).toBe(true);
    expect(result.reason).toBe('Pushed previously committed distribution-kit change');
    expect(calls.commits).toEqual([]);
    expect(calls.pushes).toEqual(['origin main']);
  });

  it('refuses ahead crash-replay commits with the wrong subject or touched files', async () => {
    const f = setup();
    seedPost(f, 'wrong-ahead');
    seedSitePost(f, 'wrong-ahead');
    const kit = await generateDistributionKit('wrong-ahead', f.config, f, f.db, { sourceMode: 'publish' });
    mockSiteArtifactGit({
      cachedHasChanges: false,
      aheadLog: 'abc123\tchore(other): wrong-ahead\n',
      showFiles: 'content/posts/wrong-ahead/distribution/linkedin.md\n',
    });
    expect(() => persistDistributionKitToSite('wrong-ahead', f.config, { configPath: f.configPath }, kit))
      .toThrow(/subject/);

    mockExec.mockReset();
    mockSiteArtifactGit({
      cachedHasChanges: false,
      aheadLog: 'def456\tchore(distribution): wrong-ahead\n',
      showFiles: 'README.md\n',
    });
    expect(() => persistDistributionKitToSite('wrong-ahead', f.config, { configPath: f.configPath }, kit))
      .toThrow(/touches/);
  });
});
