import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock runPipeline BEFORE src/cli/publish.ts is imported so the handler
// resolves to the stub. `vi.hoisted` ensures the mock ref is created ahead of
// the hoisted `vi.mock` factory, working around the "cannot access before
// initialization" error caused by top-level const + hoisted mock.
const { mockRunPipeline } = vi.hoisted(() => ({ mockRunPipeline: vi.fn() }));
vi.mock('../src/core/publish/pipeline-runner.js', () => ({
  runPipeline: mockRunPipeline,
}));

// eslint-disable-next-line import/first
import { closeDatabase, getDatabase } from '../src/core/db/database.js';
// eslint-disable-next-line import/first
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
// eslint-disable-next-line import/first
import {
  getPipelineSteps,
  createPipelineSteps,
  markStepCompleted,
  markStepFailed,
} from '../src/core/publish/steps-crud.js';
// eslint-disable-next-line import/first
import {
  runPublishStart,
  runPublishShow,
  runPublishDistributionKit,
  runPublishPlatformImages,
  runPublishReopenDraft,
  PublishCliPaths,
} from '../src/cli/publish.js';

interface Fixture {
  tempDir: string;
  dbPath: string;
  configPath: string;
  draftsDir: string;
  benchmarkDir: string;
  evaluationsDir: string;
  researchDir: string;
  reposDir: string;
  socialDir: string;
  researchPagesDir: string;
  publishDir: string;
  templatesDir: string;
}

let fixture: Fixture | undefined;

const CONFIG_YAML = (repoPath: string) => `site:
  repo_path: "${repoPath}"
  base_url: "https://m0lz.dev"
  content_dir: "content/posts"
  research_dir: "content/research"
author:
  name: "Tester"
  github: "jmolz"
content_types:
  project-launch:
    benchmark: "optional"
    companion_repo: "existing"
    social_prefix: "Show HN:"
  technical-deep-dive:
    benchmark: "required"
    companion_repo: "new"
    social_prefix: ""
  analysis-opinion:
    benchmark: "skip"
    companion_repo: "optional"
    social_prefix: ""
social:
  distribution_kit:
    persist_to_site: false
`;

function setup(withConfig = true): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'publish-cli-'));
  const dbPath = join(tempDir, 'state.db');
  const configPath = join(tempDir, '.blogrc.yaml');
  const draftsDir = join(tempDir, 'drafts');
  const benchmarkDir = join(tempDir, 'benchmarks');
  const evaluationsDir = join(tempDir, 'evaluations');
  const researchDir = join(tempDir, 'research');
  const reposDir = join(tempDir, 'repos');
  const socialDir = join(tempDir, 'social');
  const researchPagesDir = join(tempDir, 'research-pages');
  const publishDir = join(tempDir, 'publish');
  const templatesDir = join(tempDir, 'templates');
  const siteRepoPath = join(tempDir, 'site');
  [draftsDir, benchmarkDir, evaluationsDir, researchDir, reposDir, socialDir, researchPagesDir, publishDir, templatesDir, siteRepoPath]
    .forEach((d) => mkdirSync(d, { recursive: true }));
  // Initialize the DB schema by opening/closing once.
  const db = getDatabase(dbPath);
  closeDatabase(db);
  if (withConfig) {
    writeFileSync(configPath, CONFIG_YAML(siteRepoPath), 'utf-8');
  }
  fixture = {
    tempDir, dbPath, configPath, draftsDir, benchmarkDir, evaluationsDir, researchDir,
    reposDir, socialDir, researchPagesDir, publishDir, templatesDir,
  };
  return fixture;
}

function paths(f: Fixture): PublishCliPaths {
  return {
    dbPath: f.dbPath,
    configPath: f.configPath,
    draftsDir: f.draftsDir,
    benchmarkDir: f.benchmarkDir,
    evaluationsDir: f.evaluationsDir,
    researchDir: f.researchDir,
    reposDir: f.reposDir,
    socialDir: f.socialDir,
    researchPagesDir: f.researchPagesDir,
    publishDir: f.publishDir,
    templatesDir: f.templatesDir,
  };
}

function seedEvaluatePost(
  dbPath: string,
  slug: string,
  evaluationPassed: 0 | 1 = 1,
): void {
  const db = getDatabase(dbPath);
  try {
    initResearchPost(db, slug, 'topic', 'directed', 'technical-deep-dive');
    advancePhase(db, slug, 'benchmark');
    advancePhase(db, slug, 'draft');
    advancePhase(db, slug, 'evaluate');
    db.prepare('UPDATE posts SET evaluation_passed = ? WHERE slug = ?').run(evaluationPassed, slug);
  } finally {
    closeDatabase(db);
  }
}

function seedPublishPost(dbPath: string, slug: string): void {
  const db = getDatabase(dbPath);
  try {
    initResearchPost(db, slug, 'topic', 'directed', 'technical-deep-dive');
    advancePhase(db, slug, 'benchmark');
    advancePhase(db, slug, 'draft');
    advancePhase(db, slug, 'evaluate');
    db.prepare('UPDATE posts SET evaluation_passed = 1 WHERE slug = ?').run(slug);
    advancePhase(db, slug, 'publish');
  } finally {
    closeDatabase(db);
  }
}

function seedPublishedPost(dbPath: string, slug: string): void {
  const db = getDatabase(dbPath);
  try {
    initResearchPost(db, slug, 'topic', 'directed', 'project-launch', 'm0lz.01');
    advancePhase(db, slug, 'benchmark');
    advancePhase(db, slug, 'draft');
    advancePhase(db, slug, 'evaluate');
    db.prepare('UPDATE posts SET evaluation_passed = 1, title = ? WHERE slug = ?').run('Published Title', slug);
    advancePhase(db, slug, 'publish');
    advancePhase(db, slug, 'published');
  } finally {
    closeDatabase(db);
  }
}

function seedResearchPost(dbPath: string, slug: string): void {
  const db = getDatabase(dbPath);
  try {
    initResearchPost(db, slug, 'topic', 'directed', 'technical-deep-dive');
  } finally {
    closeDatabase(db);
  }
}

function captureLogs(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  return { logs, errors };
}

let savedExitCode: number | undefined;

beforeEach(() => {
  savedExitCode = process.exitCode;
  process.exitCode = 0;
  mockRunPipeline.mockReset();
});

afterEach(() => {
  if (fixture) {
    rmSync(fixture.tempDir, { recursive: true, force: true });
    fixture = undefined;
  }
  process.exitCode = savedExitCode;
  vi.restoreAllMocks();
});

describe('runPublishStart — slug validation', () => {
  it('invalid slug -> exitCode=1, does not open DB', async () => {
    const { errors } = captureLogs();
    await runPublishStart('Invalid Slug', {}); // no fixture set up — any DB use would fail
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/Invalid slug/);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });
});

describe('runPublishStart — post lookup + phase dispatch', () => {
  it('post not found -> exitCode=1 with descriptive error', async () => {
    const f = setup();
    const { errors } = captureLogs();
    await runPublishStart('ghost', paths(f));
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('Post not found: ghost');
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('post in research phase -> exitCode=1 with valid-phases hint', async () => {
    const f = setup();
    seedResearchPost(f.dbPath, 'tooearly');
    const { errors } = captureLogs();
    await runPublishStart('tooearly', paths(f));
    expect(process.exitCode).toBe(1);
    const combined = errors.join('\n');
    expect(combined).toContain("phase 'research'");
    expect(combined).toMatch(/evaluate|publish/);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('post in evaluate with evaluation_passed=1 -> promotes to publish, creates step rows, runs pipeline', async () => {
    const f = setup();
    seedEvaluatePost(f.dbPath, 'promote', 1);
    mockRunPipeline.mockResolvedValue({ completed: true, stepsRun: 11, totalSteps: 11 });
    captureLogs();
    await runPublishStart('promote', paths(f));

    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    // Verify side effects: phase advanced + pipeline_steps populated.
    const db = getDatabase(f.dbPath);
    try {
      const post = db.prepare('SELECT phase FROM posts WHERE slug = ?').get('promote') as { phase: string };
      expect(post.phase).toBe('publish');
      const steps = getPipelineSteps(db, 'promote');
      expect(steps.length).toBe(11);
    } finally {
      closeDatabase(db);
    }
  });

  it('post already in publish phase -> skips initPublish, calls runPipeline directly', async () => {
    const f = setup();
    seedPublishPost(f.dbPath, 'resume');
    // Pre-seed pipeline_steps rows so we can detect no duplicates were added.
    const db = getDatabase(f.dbPath);
    let preCount = 0;
    try {
      // initPublish would have seeded rows; do it directly here.
      const config = { author: { github: 'jmolz' }, site: {}, content_types: {} } as any; // not used — createPipelineSteps needs real config
      createPipelineSteps(db, 'resume', 'technical-deep-dive', {
        publish: { devto: true, medium: true, substack: true, github_repos: true, social_drafts: true, research_pages: true },
      } as any);
      preCount = getPipelineSteps(db, 'resume').length;
    } finally {
      closeDatabase(db);
    }
    mockRunPipeline.mockResolvedValue({ completed: true, stepsRun: 11, totalSteps: 11 });
    captureLogs();
    await runPublishStart('resume', paths(f));

    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    // Row count unchanged (idempotent): no new rows added.
    const db2 = getDatabase(f.dbPath);
    try {
      const postCount = getPipelineSteps(db2, 'resume').length;
      expect(postCount).toBe(preCount);
    } finally {
      closeDatabase(db2);
    }
  });
});

describe('runPublishStart — runner result handling', () => {
  it('runner returns completed: true -> success log, no exit code set', async () => {
    const f = setup();
    seedPublishPost(f.dbPath, 'ok');
    mockRunPipeline.mockResolvedValue({ completed: true, stepsRun: 11, totalSteps: 11 });
    const { logs } = captureLogs();
    await runPublishStart('ok', paths(f));
    // exitCode unchanged from 0 (set in beforeEach)
    expect(process.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('Publish complete');
  });

  it('runner returns pausedStep -> info log (NOT an error)', async () => {
    const f = setup();
    seedPublishPost(f.dbPath, 'paused');
    mockRunPipeline.mockResolvedValue({ completed: false, pausedStep: 'preview-gate', stepsRun: 3, totalSteps: 11 });
    const { logs, errors } = captureLogs();
    await runPublishStart('paused', paths(f));
    expect(process.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('paused at step: preview-gate');
    expect(errors.join('\n')).not.toContain('preview-gate');
  });

  it('runner returns failedStep -> exitCode=1 with error log', async () => {
    const f = setup();
    seedPublishPost(f.dbPath, 'failed');
    mockRunPipeline.mockResolvedValue({ completed: false, failedStep: 'site-pr', stepsRun: 2, totalSteps: 11 });
    const { errors } = captureLogs();
    await runPublishStart('failed', paths(f));
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('site-pr');
  });

  it('runner throws -> exitCode=1 with "pipeline crashed" message', async () => {
    const f = setup();
    seedPublishPost(f.dbPath, 'crash');
    mockRunPipeline.mockRejectedValue(new Error('kaboom'));
    const { errors } = captureLogs();
    await runPublishStart('crash', paths(f));
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/pipeline crashed.*kaboom/i);
  });
});

describe('runPublishStart — ctx.urls hydration from posts row', () => {
  it('seeds ctx.urls from non-null URL columns on the posts row before runPipeline', async () => {
    // Regression for Codex Pass 2 High: every invocation of runPublishStart
    // used to set `urls: {}` unconditionally. On a resume, URLs persisted
    // by a prior run (via persistPublishUrls) were invisible to downstream
    // steps like update-frontmatter, which reads ctx.urls. The hydration
    // closes that hole.
    const f = setup();
    seedPublishPost(f.dbPath, 'hydrated');
    const db = getDatabase(f.dbPath);
    try {
      db.prepare(
        'UPDATE posts SET site_url = ?, devto_url = ?, repo_url = ? WHERE slug = ?',
      ).run(
        'https://m0lz.dev/writing/hydrated',
        'https://dev.to/jmolz/hydrated-123',
        'https://github.com/jmolz/hydrated',
        'hydrated',
      );
    } finally {
      closeDatabase(db);
    }
    mockRunPipeline.mockResolvedValue({ completed: true, stepsRun: 11, totalSteps: 11 });
    captureLogs();

    await runPublishStart('hydrated', paths(f));

    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    const ctx = mockRunPipeline.mock.calls[0][0];
    expect(ctx.urls.site_url).toBe('https://m0lz.dev/writing/hydrated');
    expect(ctx.urls.devto_url).toBe('https://dev.to/jmolz/hydrated-123');
    expect(ctx.urls.repo_url).toBe('https://github.com/jmolz/hydrated');
    // Columns that were NULL on the row stay absent on ctx.urls — not
    // present as `undefined` keys, so downstream COALESCE semantics are
    // clean.
    expect(ctx.urls.medium_url).toBeUndefined();
    expect(ctx.urls.substack_url).toBeUndefined();
  });

  it('ctx.urls is empty object when all URL columns are NULL (fresh publish)', async () => {
    const f = setup();
    seedPublishPost(f.dbPath, 'fresh');
    mockRunPipeline.mockResolvedValue({ completed: true, stepsRun: 11, totalSteps: 11 });
    captureLogs();

    await runPublishStart('fresh', paths(f));
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    const ctx = mockRunPipeline.mock.calls[0][0];
    expect(ctx.urls).toEqual({});
  });
});

describe('runPublishShow', () => {
  it('post not found -> exitCode=1', () => {
    const f = setup();
    const { errors } = captureLogs();
    runPublishShow('ghost', paths(f));
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('Post not found: ghost');
  });

  it('displays post metadata + step table when steps are seeded', () => {
    const f = setup();
    seedPublishPost(f.dbPath, 'showsteps');
    const db = getDatabase(f.dbPath);
    try {
      createPipelineSteps(db, 'showsteps', 'technical-deep-dive', {
        publish: { devto: true, medium: true, substack: true, github_repos: true, social_drafts: true, research_pages: true },
      } as any);
      markStepCompleted(db, 'showsteps', 'verify');
    } finally {
      closeDatabase(db);
    }
    const { logs } = captureLogs();
    runPublishShow('showsteps', paths(f));
    const combined = logs.join('\n');
    expect(combined).toContain('slug:');
    expect(combined).toContain('showsteps');
    expect(combined).toContain('phase:');
    expect(combined).toContain('publish');
    // Step table headers.
    expect(combined).toContain('Step');
    expect(combined).toContain('Name');
    expect(combined).toContain('Status');
    expect(combined).toContain('verify');
    expect(combined).toContain('completed');
  });

  it('prints "No pipeline steps yet" message when steps table is empty', () => {
    const f = setup();
    seedPublishPost(f.dbPath, 'nosteps');
    const { logs } = captureLogs();
    runPublishShow('nosteps', paths(f));
    expect(logs.join('\n')).toMatch(/No pipeline steps yet/);
  });

  it('best-effort config: malformed .blogrc.yaml does not abort the show command', () => {
    const f = setup();
    // Clobber config with malformed YAML. runPublishShow must still print
    // the post metadata and warn about the config failure.
    writeFileSync(f.configPath, 'this: [is: bad yaml', 'utf-8');
    seedPublishPost(f.dbPath, 'malformed');
    const { logs, errors } = captureLogs();
    runPublishShow('malformed', paths(f));
    // Show still ran — no exit code escalation.
    expect(process.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('malformed');
    // And warned on stderr.
    expect(errors.join('\n')).toMatch(/Warning|failed to load config/);
  });
});

describe('runPublishReopenDraft', () => {
  it('moves a site-pr platform-image failure back to draft and clears stale publish steps', () => {
    const f = setup();
    seedPublishPost(f.dbPath, 'repair-images');
    const db = getDatabase(f.dbPath);
    try {
      createPipelineSteps(db, 'repair-images', 'technical-deep-dive', {
        publish: { devto: true, medium: true, substack: true, github_repos: true, social_drafts: true, research_pages: true },
      } as any);
      markStepCompleted(db, 'repair-images', 'verify');
      markStepCompleted(db, 'repair-images', 'research-page');
      markStepFailed(
        db,
        'repair-images',
        'site-pr',
        'Missing devto_main_image. This draft reached publish without platform image frontmatter.',
      );
    } finally {
      closeDatabase(db);
    }

    const { logs } = captureLogs();
    runPublishReopenDraft('repair-images', { reason: 'missing platform images' }, paths(f));

    expect(process.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('Phase moved back to draft');
    const db2 = getDatabase(f.dbPath);
    try {
      const post = db2
        .prepare('SELECT phase, evaluation_passed FROM posts WHERE slug = ?')
        .get('repair-images') as { phase: string; evaluation_passed: number | null };
      expect(post.phase).toBe('draft');
      expect(post.evaluation_passed).toBeNull();
      expect(getPipelineSteps(db2, 'repair-images')).toHaveLength(0);
      const metric = db2
        .prepare("SELECT value FROM metrics WHERE post_slug = ? AND event = 'publish_reopened_to_draft'")
        .get('repair-images') as { value: string } | undefined;
      expect(metric?.value).toContain('missing platform images');
    } finally {
      closeDatabase(db2);
    }
  });

  it('moves a verify artifact-drift failure back to draft and clears stale publish steps', () => {
    const f = setup();
    seedPublishPost(f.dbPath, 'repair-drift');
    const db = getDatabase(f.dbPath);
    try {
      createPipelineSteps(db, 'repair-drift', 'technical-deep-dive', {
        publish: { devto: true, medium: true, substack: true, github_repos: true, social_drafts: true, research_pages: true },
      } as any);
      markStepFailed(
        db,
        'repair-drift',
        'verify',
        'Evaluation artifact verification failed -- Evaluated artifacts changed after evaluation completed: draft/index.mdx.',
      );
    } finally {
      closeDatabase(db);
    }

    const { logs } = captureLogs();
    runPublishReopenDraft('repair-drift', { reason: 'evaluated artifact drift' }, paths(f));

    expect(process.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('Phase moved back to draft');
    const db2 = getDatabase(f.dbPath);
    try {
      const post = db2
        .prepare('SELECT phase, evaluation_passed FROM posts WHERE slug = ?')
        .get('repair-drift') as { phase: string; evaluation_passed: number | null };
      expect(post.phase).toBe('draft');
      expect(post.evaluation_passed).toBeNull();
      expect(getPipelineSteps(db2, 'repair-drift')).toHaveLength(0);
    } finally {
      closeDatabase(db2);
    }
  });

  it('refuses to reopen when publish advanced beyond site-pr', () => {
    const f = setup();
    seedPublishPost(f.dbPath, 'too-late');
    const db = getDatabase(f.dbPath);
    try {
      createPipelineSteps(db, 'too-late', 'technical-deep-dive', {
        publish: { devto: true, medium: true, substack: true, github_repos: true, social_drafts: true, research_pages: true },
      } as any);
      markStepFailed(
        db,
        'too-late',
        'site-pr',
        'Missing devto_main_image. This draft reached publish without platform image frontmatter.',
      );
      markStepCompleted(db, 'too-late', 'preview-gate');
    } finally {
      closeDatabase(db);
    }

    const { errors } = captureLogs();
    runPublishReopenDraft('too-late', { reason: 'missing platform images' }, paths(f));

    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('advanced past site-pr');
    const db2 = getDatabase(f.dbPath);
    try {
      const post = db2.prepare('SELECT phase FROM posts WHERE slug = ?').get('too-late') as { phase: string };
      expect(post.phase).toBe('publish');
      expect(getPipelineSteps(db2, 'too-late').length).toBeGreaterThan(0);
    } finally {
      closeDatabase(db2);
    }
  });
});

describe('runPublishDistributionKit', () => {
  it('generates local backfill artifacts for a published post without committing when config disables site persistence', async () => {
    const f = setup();
    seedPublishedPost(f.dbPath, 'kit');
    const sitePostDir = join(f.tempDir, 'site', 'content', 'posts', 'kit');
    mkdirSync(sitePostDir, { recursive: true });
    writeFileSync(join(sitePostDir, 'index.mdx'), `---
title: "Hub Kit Title"
description: "Hub kit description."
date: "2026-05-14"
tags:
  - Publishing
published: true
canonical: "https://m0lz.dev/writing/kit"
---

Hub body
`, 'utf-8');
    const draftDir = join(f.draftsDir, 'kit');
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(join(draftDir, 'index.mdx'), `---
title: "Draft Kit Title"
description: "Draft kit description."
date: "2026-05-14"
tags:
  - TypeScript
published: true
canonical: "https://m0lz.dev/writing/kit"
---

Body
`, 'utf-8');
    const { logs } = captureLogs();
    await runPublishDistributionKit('kit', { imageMode: 'prompt-only' }, {
      ...paths(f),
      templatesDir: join(__dirname, '../templates'),
    });

    expect(process.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('distribution kit');
    expect(readFileSync(join(f.socialDir, 'kit/linkedin.md'), 'utf-8')).toContain('Hub Kit Title');
    expect(readFileSync(join(f.socialDir, 'kit/manifest.json'), 'utf-8')).toContain('gpt-image-2-2026-04-21');
  });
});

describe('runPublishPlatformImages', () => {
  it('regenerates platform image assets for published posts without requiring draft phase', async () => {
    const f = setup();
    seedPublishedPost(f.dbPath, 'platform-backfill');
    const draftDir = join(f.draftsDir, 'platform-backfill');
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(join(draftDir, 'index.mdx'), `---
title: "Platform Backfill"
description: "Platform image backfill."
date: "2026-05-18"
tags:
  - TypeScript
published: true
canonical: "https://m0lz.dev/writing/platform-backfill"
---

Body
`, 'utf-8');

    const { logs } = captureLogs();
    await runPublishPlatformImages('platform-backfill', {}, paths(f));

    expect(process.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('Generated platform images');
    expect(readFileSync(join(draftDir, 'index.mdx'), 'utf-8')).toContain('devto_main_image: ./assets/devto-cover.png');
    expect(readFileSync(join(draftDir, '.platform-images.json'), 'utf-8')).toContain('input_hash');
  });
});
