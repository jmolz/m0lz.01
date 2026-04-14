import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
import { writeResearchDocument, ResearchDocument } from '../src/core/research/document.js';
import {
  runDraftInit,
  runDraftShow,
  runDraftValidate,
  runDraftAddAsset,
  runDraftComplete,
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
    initResearchPost(db, slug, 'test topic', 'directed', contentType as any);
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
      data: { metric_a: 100, metric_b: 200 },
      meta: { tool: 'test', date: '2026-01-01' },
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
    setupDraftSlug(f, 'val-fm');
    captureLogs();
    runDraftInit('val-fm', paths(f));

    const savedExitCode = process.exitCode;
    try {
      const { errors } = captureLogs();
      process.exitCode = 0;
      runDraftValidate('val-fm', paths(f));
      expect(process.exitCode).toBe(1);
      const combined = errors.join('\n');
      expect(combined).toContain('placeholder');
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('passes for complete draft', () => {
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
      .replace(/\{\/\* TODO: Fill this section \*\/\}/g, 'Real content');
    writeFileSync(mdxPath, content, 'utf-8');

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

describe('runDraftComplete', () => {
  it('advances to evaluate phase', () => {
    const f = setupFixture();
    setupDraftSlug(f, 'complete-test', 'analysis-opinion');
    captureLogs();
    runDraftInit('complete-test', paths(f));

    // Fill in the draft
    const mdxPath = join(f.draftsDir, 'complete-test', 'index.mdx');
    const content = readFileSync(mdxPath, 'utf-8')
      .replace('{{title}}', 'Real Title')
      .replace('{{description}}', 'Real description')
      .replace('tags: []', 'tags:\n  - typescript')
      .replace(/\{\/\* TODO: Fill this section \*\/\}/g, 'Filled content');
    writeFileSync(mdxPath, content, 'utf-8');

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
