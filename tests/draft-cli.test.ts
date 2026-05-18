import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import sharp from 'sharp';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
import { writeResearchDocument, ResearchDocument } from '../src/core/research/document.js';
import {
  runDraftInit,
  runDraftShow,
  runDraftValidate,
  runDraftAddAsset,
  runDraftComplete,
  runDraftPlatformImages,
  runDraftRegenerate,
  DraftPaths,
} from '../src/cli/draft.js';

interface Fixture {
  tempDir: string;
  dbPath: string;
  draftsDir: string;
  benchmarkDir: string;
  researchDir: string;
  configPath: string;
}

let fixture: Fixture | undefined;

function setupFixture(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'draft-cli-'));
  const dbPath = join(tempDir, 'state.db');
  const draftsDir = join(tempDir, 'drafts');
  const benchmarkDir = join(tempDir, 'benchmarks');
  const researchDir = join(tempDir, 'research');
  const configPath = join(tempDir, '.blogrc.yaml');

  mkdirSync(draftsDir, { recursive: true });
  mkdirSync(benchmarkDir, { recursive: true });
  mkdirSync(researchDir, { recursive: true });

  const db = getDatabase(dbPath);
  closeDatabase(db);

  writeFileSync(configPath, `
site:
  repo_path: "${join(tempDir, 'site')}"
  base_url: "https://m0lz.dev"
  content_dir: "content/posts"
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
evaluation:
  min_sources: 1
`);

  fixture = { tempDir, dbPath, draftsDir, benchmarkDir, researchDir, configPath };
  return fixture;
}

function paths(f: Fixture): DraftPaths {
  return {
    dbPath: f.dbPath,
    draftsDir: f.draftsDir,
    benchmarkDir: f.benchmarkDir,
    researchDir: f.researchDir,
    configPath: f.configPath,
  };
}

function setupDraftSlug(f: Fixture, slug: string, contentType: string = 'technical-deep-dive'): void {
  const db = getDatabase(f.dbPath);
  try {
    // project-launch posts now require a projectId at init time (v0.3
    // dogfood-hardening guard). Seed a deterministic test.01 ID so the
    // existing tests exercise the full project-launch path.
    const projectId = contentType === 'project-launch' ? 'test.01' : null;
    initResearchPost(db, slug, 'test topic', 'directed', contentType as any, projectId);
    advancePhase(db, slug, 'benchmark');
    advancePhase(db, slug, 'draft');
  } finally {
    closeDatabase(db);
  }
  const doc: ResearchDocument = {
    slug,
    topic: 'test topic',
    mode: 'directed',
    content_type: contentType as any,
    created_at: new Date().toISOString(),
    thesis: 'Test thesis',
    findings: 'Findings',
    sources_list: 'Sources',
    data_points: 'Data',
    open_questions: 'Questions',
    benchmark_targets: '- Target A\n- Target B',
    repo_scope: 'Scope',
  };
  writeResearchDocument(f.researchDir, doc, { force: true });
}

function fillDraftPlaceholders(draftsDir: string, slug: string): void {
  const mdxPath = join(draftsDir, slug, 'index.mdx');
  const content = readFileSync(mdxPath, 'utf-8')
    .replace('{{title}}', 'Real Title')
    .replace('{{description}}', 'Real description')
    .replace('tags: []', 'tags:\n  - typescript')
    .replace(
      'published: false',
      [
        'published: false',
        'devto_main_image: ./assets/devto-cover.png',
        'medium_featured_image: ./assets/medium-featured.png',
        'substack_preview_image: ./assets/substack-preview.png',
      ].join('\n'),
    )
    .replace(/\{\/\* TODO: Fill this section \*\/\}/g, 'Filled content');
  writeFileSync(mdxPath, content, 'utf-8');
}

function markBenchmarkedWithInvalidResults(f: Fixture, slug: string): void {
  const db = getDatabase(f.dbPath);
  try {
    db.prepare('UPDATE posts SET has_benchmarks = 1 WHERE slug = ?').run(slug);
  } finally {
    closeDatabase(db);
  }
  const benchSlugDir = join(f.benchmarkDir, slug);
  mkdirSync(benchSlugDir, { recursive: true });
  writeFileSync(join(benchSlugDir, 'results.json'), JSON.stringify({
    slug,
    timestamp: new Date().toISOString(),
    targets: ['Target A'],
    data: {},
  }), 'utf-8');
}

function markBenchmarkedWithValidResults(f: Fixture, slug: string): void {
  const db = getDatabase(f.dbPath);
  try {
    db.prepare('UPDATE posts SET has_benchmarks = 1 WHERE slug = ?').run(slug);
  } finally {
    closeDatabase(db);
  }
  const benchSlugDir = join(f.benchmarkDir, slug);
  mkdirSync(benchSlugDir, { recursive: true });
  writeFileSync(join(benchSlugDir, 'results.json'), JSON.stringify({
    slug,
    run_id: 1,
    timestamp: new Date().toISOString(),
    targets: ['Target A'],
    data: {
      score: 42,
      summary: 'Current benchmark score 42 passed.',
    },
  }), 'utf-8');
}

afterEach(() => {
  if (fixture) {
    rmSync(fixture.tempDir, { recursive: true, force: true });
    fixture = undefined;
  }
  const saved = process.exitCode;
  process.exitCode = saved === undefined ? undefined : 0;
  vi.restoreAllMocks();
});

function captureLogs(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((msg: unknown) => { logs.push(String(msg)); });
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => { errors.push(String(msg)); });
  return { logs, errors };
}

describe('runDraftInit', () => {
  it('creates draft directory and template MDX', () => {
    const f = setupFixture();
    setupDraftSlug(f, 'alpha');
    const { logs } = captureLogs();
    const savedExitCode = process.exitCode;

    try {
      runDraftInit('alpha', paths(f));

      expect(process.exitCode).not.toBe(1);
      const combined = logs.join('\n');
      expect(combined).toContain('Draft initialized');
      expect(combined).toContain('Draft path:');
      expect(combined).toContain('Canonical:');
      expect(existsSync(join(f.draftsDir, 'alpha', 'index.mdx'))).toBe(true);
      expect(existsSync(join(f.draftsDir, 'alpha', 'assets'))).toBe(true);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('includes benchmark sections for technical-deep-dive', () => {
    const f = setupFixture();
    setupDraftSlug(f, 'beta', 'technical-deep-dive');
    captureLogs();
    const savedExitCode = process.exitCode;

    try {
      runDraftInit('beta', paths(f));
      const content = readFileSync(join(f.draftsDir, 'beta', 'index.mdx'), 'utf-8');
      expect(content).toContain('## Benchmark Results');
      expect(content).toContain('## Methodology');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('omits benchmark sections for analysis-opinion', () => {
    const f = setupFixture();
    setupDraftSlug(f, 'gamma', 'analysis-opinion');
    captureLogs();
    const savedExitCode = process.exitCode;

    try {
      runDraftInit('gamma', paths(f));
      const content = readFileSync(join(f.draftsDir, 'gamma', 'index.mdx'), 'utf-8');
      expect(content).not.toContain('## Benchmark Results');
      expect(content).toContain('## Analysis');
      expect(content).toContain('## Key Takeaways');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('includes project-launch sections', () => {
    const f = setupFixture();
    setupDraftSlug(f, 'delta', 'project-launch');
    captureLogs();
    const savedExitCode = process.exitCode;

    try {
      runDraftInit('delta', paths(f));
      const content = readFileSync(join(f.draftsDir, 'delta', 'index.mdx'), 'utf-8');
      expect(content).toContain('## What It Does');
      expect(content).toContain('## How It Works');
      expect(content).not.toContain('## Benchmark Results');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('includes benchmark sections in project-launch when benchmarks exist', () => {
    const f = setupFixture();
    setupDraftSlug(f, 'delta-bench', 'project-launch');

    // Write benchmark results so they get picked up
    const benchSlugDir = join(f.benchmarkDir, 'delta-bench');
    mkdirSync(benchSlugDir, { recursive: true });
    writeFileSync(join(benchSlugDir, 'results.json'), JSON.stringify({
      slug: 'delta-bench',
      run_id: 1,
      timestamp: new Date().toISOString(),
      targets: ['Target A'],
      data: { metric_a: 100, metric_b: 200 },
    }), 'utf-8');

    captureLogs();
    const savedExitCode = process.exitCode;

    try {
      runDraftInit('delta-bench', paths(f));
      const content = readFileSync(join(f.draftsDir, 'delta-bench', 'index.mdx'), 'utf-8');
      expect(content).toContain('## What It Does');
      expect(content).toContain('## Benchmark Results');
      expect(content).toContain('metric_a');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('errors for wrong phase', () => {
    const f = setupFixture();
    const db = getDatabase(f.dbPath);
    try {
      initResearchPost(db, 'wrong-phase', 'test', 'directed', 'technical-deep-dive');
    } finally {
      closeDatabase(db);
    }

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runDraftInit('wrong-phase', paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain("not 'draft'");
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('fails closed when a benchmarked post has malformed results', () => {
    const f = setupFixture();
    setupDraftSlug(f, 'bad-benchmark', 'project-launch');
    markBenchmarkedWithInvalidResults(f, 'bad-benchmark');

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runDraftInit('bad-benchmark', paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('Invalid benchmark results');
      expect(errors.join('\n')).toContain('blog benchmark repair bad-benchmark');
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('runDraftRegenerate', () => {
  it('regenerates pre-published draft bodies from benchmark evidence', () => {
    const f = setupFixture();
    setupDraftSlug(f, 'regen-bench', 'project-launch');
    markBenchmarkedWithValidResults(f, 'regen-bench');
    captureLogs();
    runDraftInit('regen-bench', paths(f));

    const mdxPath = join(f.draftsDir, 'regen-bench', 'index.mdx');
    writeFileSync(
      mdxPath,
      readFileSync(mdxPath, 'utf-8').replace('The launch frames', 'This stale draft says 9999 tests. The launch frames'),
      'utf-8',
    );

    const db = getDatabase(f.dbPath);
    try {
      advancePhase(db, 'regen-bench', 'evaluate');
    } finally {
      closeDatabase(db);
    }

    const savedExitCode = process.exitCode;
    try {
      const { logs } = captureLogs();
      process.exitCode = 0;
      runDraftRegenerate('regen-bench', paths(f));
      expect(process.exitCode).not.toBe(1);
      expect(logs.join('\n')).toContain('Draft regenerated:');
      expect(existsSync(join(f.draftsDir, 'regen-bench', '.draft-regenerated.json'))).toBe(true);
      expect(readFileSync(mdxPath, 'utf-8')).not.toContain('9999 tests');
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('runDraftShow', () => {
  it('prints status for draft post', () => {
    const f = setupFixture();
    setupDraftSlug(f, 'show-test');
    captureLogs();
    runDraftInit('show-test', paths(f));

    const { logs } = captureLogs();
    const savedExitCode = process.exitCode;
    try {
      runDraftShow('show-test', paths(f));
      const combined = logs.join('\n');
      expect(combined).toContain('slug:');
      expect(combined).toContain('show-test');
      expect(combined).toContain('phase:');
      expect(combined).toContain('draft');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('reports invalid benchmark data in draft show', () => {
    const f = setupFixture();
    setupDraftSlug(f, 'show-invalid', 'project-launch');
    markBenchmarkedWithInvalidResults(f, 'show-invalid');

    const { logs } = captureLogs();
    runDraftShow('show-invalid', paths(f));
    expect(logs.join('\n')).toContain('benchmark_data:  invalid');
  });

  it('ignores preserved invalid benchmark artifacts after optional skip', () => {
    const f = setupFixture();
    setupDraftSlug(f, 'show-skipped', 'project-launch');
    const benchSlugDir = join(f.benchmarkDir, 'show-skipped');
    mkdirSync(benchSlugDir, { recursive: true });
    writeFileSync(join(benchSlugDir, 'results.json'), JSON.stringify({
      slug: 'show-skipped',
      bad: true,
    }), 'utf-8');

    const { logs } = captureLogs();
    runDraftShow('show-skipped', paths(f));
    const combined = logs.join('\n');
    expect(combined).toContain('benchmark_data:  none');
    expect(combined).not.toContain('benchmark_data:  invalid');
  });

  it('errors for wrong phase', () => {
    const f = setupFixture();
    const db = getDatabase(f.dbPath);
    try {
      initResearchPost(db, 'research-only', 'test', 'directed', 'technical-deep-dive');
    } finally {
      closeDatabase(db);
    }

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runDraftShow('research-only', paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain("not 'draft'");
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('runDraftValidate', () => {
  it('fails for draft with placeholder sections', () => {
    const f = setupFixture();
    setupDraftSlug(f, 'val-placeholders');
    captureLogs();
    runDraftInit('val-placeholders', paths(f));

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runDraftValidate('val-placeholders', paths(f));
      expect(process.exitCode).toBe(1);
      const combined = errors.join('\n');
      expect(combined).toContain('Placeholder sections remaining');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('fails for placeholder frontmatter', () => {
    const f = setupFixture();
    setupDraftSlug(f, 'val-fm', 'analysis-opinion');
    captureLogs();
    runDraftInit('val-fm', paths(f));
    const mdxPath = join(f.draftsDir, 'val-fm', 'index.mdx');
    const placeholderFrontmatter = readFileSync(mdxPath, 'utf-8')
      .replace(/^title: .+$/m, 'title: "{{title}}"')
      .replace(/^description: .+$/m, 'description: "{{description}}"');
    writeFileSync(mdxPath, placeholderFrontmatter, 'utf-8');

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runDraftValidate('val-fm', paths(f));
      expect(process.exitCode).toBe(1);
      const combined = errors.join('\n');
      expect(combined).toContain('Title is still a placeholder');
      expect(combined).toContain('Description is still a placeholder');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('passes for complete draft', async () => {
    const f = setupFixture();
    setupDraftSlug(f, 'val-good', 'analysis-opinion');
    captureLogs();
    runDraftInit('val-good', paths(f));

    // Fill in the draft
    const mdxPath = join(f.draftsDir, 'val-good', 'index.mdx');
    const content = readFileSync(mdxPath, 'utf-8')
      .replace('{{title}}', 'Real Title')
      .replace('{{description}}', 'Real description')
      .replace('tags: []', 'tags:\n  - typescript')
      .replace(
        'published: false',
        [
          'published: false',
          'devto_main_image: ./assets/devto-cover.png',
          'medium_featured_image: ./assets/medium-featured.png',
          'substack_preview_image: ./assets/substack-preview.png',
        ].join('\n'),
      )
      .replace(/\{\/\* TODO: Fill this section \*\/\}/g, 'Real content');
    writeFileSync(mdxPath, content, 'utf-8');
    await runDraftPlatformImages('val-good', paths(f));

    const savedExitCode = process.exitCode;
    try {
      const { logs } = captureLogs();
      process.exitCode = 0;
      runDraftValidate('val-good', paths(f));
      expect(process.exitCode).not.toBe(1);
      expect(logs.join('\n')).toContain('PASS');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('fails for missing asset files', () => {
    const f = setupFixture();
    setupDraftSlug(f, 'val-asset', 'analysis-opinion');
    captureLogs();
    runDraftInit('val-asset', paths(f));

    // Fill in draft
    const mdxPath = join(f.draftsDir, 'val-asset', 'index.mdx');
    const content = readFileSync(mdxPath, 'utf-8')
      .replace('{{title}}', 'Title')
      .replace('{{description}}', 'Desc')
      .replace(/\{\/\* TODO: Fill this section \*\/\}/g, 'Content');
    writeFileSync(mdxPath, content, 'utf-8');

    // Register an asset that doesn't exist on disk
    const db = getDatabase(f.dbPath);
    try {
      db.prepare("INSERT INTO assets (post_slug, type, filename) VALUES (?, ?, ?)").run('val-asset', 'excalidraw', 'missing.svg');
    } finally {
      closeDatabase(db);
    }

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runDraftValidate('val-asset', paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('missing.svg');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('fails when benchmarked post has malformed results', () => {
    const f = setupFixture();
    setupDraftSlug(f, 'val-bad-benchmark', 'project-launch');
    captureLogs();
    runDraftInit('val-bad-benchmark', paths(f));
    fillDraftPlaceholders(f.draftsDir, 'val-bad-benchmark');
    markBenchmarkedWithInvalidResults(f, 'val-bad-benchmark');

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runDraftValidate('val-bad-benchmark', paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('Benchmark errors');
      expect(errors.join('\n')).toContain('blog benchmark repair val-bad-benchmark');
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('runDraftAddAsset', () => {
  it('registers an existing asset file', () => {
    const f = setupFixture();
    setupDraftSlug(f, 'asset-add');
    captureLogs();
    runDraftInit('asset-add', paths(f));

    // Create the asset file
    const assetPath = join(f.draftsDir, 'asset-add', 'assets', 'diagram.svg');
    writeFileSync(assetPath, '<svg></svg>');

    const { logs } = captureLogs();
    const savedExitCode = process.exitCode;
    try {
      runDraftAddAsset('asset-add', { file: 'diagram.svg', type: 'excalidraw' }, paths(f));
      expect(process.exitCode).not.toBe(1);
      expect(logs.join('\n')).toContain('Asset registered');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('errors for missing asset file', () => {
    const f = setupFixture();
    setupDraftSlug(f, 'asset-missing');
    captureLogs();
    runDraftInit('asset-missing', paths(f));

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runDraftAddAsset('asset-missing', { file: 'nope.svg', type: 'excalidraw' }, paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('Asset file not found');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('errors for invalid asset type', () => {
    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runDraftAddAsset('whatever', { file: 'x.svg', type: 'invalid' }, {});
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('Invalid asset type');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('rejects path traversal in filename', () => {
    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runDraftAddAsset('test-slug', { file: '../index.mdx', type: 'image' }, {});
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('Invalid asset filename');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('rejects filename with subdirectory path', () => {
    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runDraftAddAsset('test-slug', { file: 'subdir/file.svg', type: 'image' }, {});
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('Invalid asset filename');
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('runDraftPlatformImages', () => {
  it('generates Dev.to/Medium/Substack preview assets and updates draft frontmatter', async () => {
    const f = setupFixture();
    setupDraftSlug(f, 'platform-ok');
    captureLogs();
    runDraftInit('platform-ok', paths(f));

    const { logs } = captureLogs();
    const savedExitCode = process.exitCode;
    try {
      await runDraftPlatformImages('platform-ok', paths(f));

      expect(process.exitCode).not.toBe(1);
      expect(logs.join('\n')).toContain('Platform images ready');
      const devtoPath = join(f.draftsDir, 'platform-ok', 'assets', 'devto-cover.png');
      const mediumPath = join(f.draftsDir, 'platform-ok', 'assets', 'medium-featured.png');
      const substackPath = join(f.draftsDir, 'platform-ok', 'assets', 'substack-preview.png');
      expect(existsSync(devtoPath)).toBe(true);
      expect(existsSync(mediumPath)).toBe(true);
      expect(existsSync(substackPath)).toBe(true);
      expect((await sharp(devtoPath).metadata()).width).toBe(1000);
      expect((await sharp(mediumPath).metadata()).width).toBe(1200);
      expect((await sharp(substackPath).metadata()).height).toBe(630);

      const mdx = readFileSync(join(f.draftsDir, 'platform-ok', 'index.mdx'), 'utf-8');
      expect(mdx).toContain('devto_main_image: ./assets/devto-cover.png');
      expect(mdx).toContain('medium_featured_image: ./assets/medium-featured.png');
      expect(mdx).toContain('substack_preview_image: ./assets/substack-preview.png');
      expect(existsSync(join(f.draftsDir, 'platform-ok', '.platform-images.json'))).toBe(true);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('reports missing posts without writing assets', async () => {
    const f = setupFixture();
    const { errors } = captureLogs();
    const savedExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      await runDraftPlatformImages('missing-post', paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('Post not found');
      expect(existsSync(join(f.draftsDir, 'missing-post'))).toBe(false);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('rejects posts outside the draft phase without writing assets', async () => {
    const f = setupFixture();
    setupDraftSlug(f, 'platform-wrong-phase');
    captureLogs();
    runDraftInit('platform-wrong-phase', paths(f));
    const db = getDatabase(f.dbPath);
    try {
      advancePhase(db, 'platform-wrong-phase', 'evaluate');
    } finally {
      closeDatabase(db);
    }

    const { errors } = captureLogs();
    const savedExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      await runDraftPlatformImages('platform-wrong-phase', paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain("not 'draft'");
      expect(existsSync(join(f.draftsDir, 'platform-wrong-phase', 'assets', 'medium-featured.png'))).toBe(false);
      expect(existsSync(join(f.draftsDir, 'platform-wrong-phase', '.platform-images.json'))).toBe(false);
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('runDraftComplete', () => {
  it('advances to evaluate phase', async () => {
    const f = setupFixture();
    setupDraftSlug(f, 'complete-test', 'analysis-opinion');
    captureLogs();
    runDraftInit('complete-test', paths(f));

    // Fill in the draft
    fillDraftPlaceholders(f.draftsDir, 'complete-test');
    await runDraftPlatformImages('complete-test', paths(f));

    const { logs } = captureLogs();
    const savedExitCode = process.exitCode;
    try {
      runDraftComplete('complete-test', paths(f));
      expect(process.exitCode).not.toBe(1);
      expect(logs.join('\n')).toContain('Phase advanced to evaluate');

      const db = getDatabase(f.dbPath);
      try {
        const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get('complete-test') as { phase: string };
        expect(post.phase).toBe('evaluate');
      } finally {
        closeDatabase(db);
      }
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('does not advance when benchmarked post has malformed results', async () => {
    const f = setupFixture();
    setupDraftSlug(f, 'complete-bad-benchmark', 'project-launch');
    captureLogs();
    runDraftInit('complete-bad-benchmark', paths(f));
    fillDraftPlaceholders(f.draftsDir, 'complete-bad-benchmark');
    await runDraftPlatformImages('complete-bad-benchmark', paths(f));
    markBenchmarkedWithInvalidResults(f, 'complete-bad-benchmark');

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runDraftComplete('complete-bad-benchmark', paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('Invalid benchmark results');
      const db = getDatabase(f.dbPath);
      try {
        const post = db.prepare('SELECT phase FROM posts WHERE slug = ?').get('complete-bad-benchmark') as {
          phase: string;
        };
        expect(post.phase).toBe('draft');
      } finally {
        closeDatabase(db);
      }
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('errors for wrong phase', () => {
    const f = setupFixture();
    const db = getDatabase(f.dbPath);
    try {
      initResearchPost(db, 'wrong', 'test', 'directed', 'technical-deep-dive');
    } finally {
      closeDatabase(db);
    }

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runDraftComplete('wrong', paths(f));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain("not 'draft'");
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('slug validation', () => {
  const invalidSlugs = ['UPPER', 'has spaces', '-leading', 'trailing-', '../escape', 'a/b'];

  for (const slug of invalidSlugs) {
    it(`rejects invalid slug: "${slug}"`, () => {
      const savedExitCode = process.exitCode;
      try {
        const { errors } = captureLogs();
        process.exitCode = 0;
        runDraftInit(slug, {});
        expect(process.exitCode).toBe(1);
        expect(errors.join('\n')).toContain('Invalid slug');
      } finally {
        process.exitCode = savedExitCode;
      }
    });
  }
});
