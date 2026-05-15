import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
import { writeResearchDocument, ResearchDocument } from '../src/core/research/document.js';
import {
  getDraftPost,
  initDraft,
  completeDraft,
  regenerateDraft,
  registerAsset,
  listAssets,
  draftPath,
} from '../src/core/draft/state.js';
import { BlogConfig } from '../src/core/config/types.js';
import { parseFrontmatter, validateFrontmatter } from '../src/core/draft/frontmatter.js';
import { runStructuralAutocheck } from '../src/core/evaluate/autocheck.js';

let tempDir: string | undefined;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'draft-state-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function makeConfig(dir: string): BlogConfig {
  return {
    site: { repo_path: join(dir, 'site'), base_url: 'https://m0lz.dev', content_dir: 'content/posts' },
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
    updates: { preserve_original_data: true, update_notice: true, update_crosspost: true },
  };
}

function createDraftPost(
  dbPath: string,
  researchDir: string,
  slug: string,
  contentType: string = 'technical-deep-dive',
): void {
  const db = getDatabase(dbPath);
  try {
    initResearchPost(
      db,
      slug,
      'test topic',
      'directed',
      contentType as any,
      contentType === 'project-launch' ? 'test.01' : null,
    );
    // Advance through research -> benchmark -> draft
    advancePhase(db, slug, 'benchmark');
    advancePhase(db, slug, 'draft');
  } finally {
    closeDatabase(db);
  }
  mkdirSync(researchDir, { recursive: true });
  const doc: ResearchDocument = {
    slug,
    topic: 'test topic',
    mode: 'directed',
    content_type: contentType as any,
    created_at: new Date().toISOString(),
    thesis: 'Test thesis statement',
    findings: 'Test findings content',
    sources_list: 'Test sources',
    data_points: 'Test data',
    open_questions: 'Test questions',
    benchmark_targets: '- Target A\n- Target B',
    repo_scope: 'Test scope',
  };
  writeResearchDocument(researchDir, doc, { force: true });
}

function writeBenchmarkArtifacts(benchmarkDir: string, slug: string): void {
  const dir = join(benchmarkDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'results.json'), JSON.stringify({
    slug,
    run_id: 1,
    timestamp: '2026-05-15T17:23:50Z',
    targets: [
      'cargo test -p pice-daemon --test parallel_cohort_speedup_assertion -- --nocapture',
      'node scripts/acceptance/phase8-reference-projects.mjs',
    ],
    data: {
      speedup_assertion: {
        status: 'passed',
        sequential_mean_seconds: 6.238500097,
        parallel_mean_seconds: 3.147005138,
        parallel_to_sequential_ratio: 0.504,
        target_ratio_max: 0.625,
        iterations: 3,
      },
      phase8_reference_projects: {
        status: 'passed',
        fixture_count: 5,
        fixtures: [
          {
            fixture: 'fastapi-postgres',
            detected_layers: 7,
            configured_layers: 7,
            evaluate_status: 'passed',
            terminal_exit_code: 0,
            distinct_layer_runs: 7,
            gate_decisions: 1,
          },
        ],
      },
      summary: 'Fresh benchmark capture passed: ratio 0.504 <= 0.625.',
    },
    summary: 'Fresh benchmark capture passed: ratio 0.504 <= 0.625.',
  }), 'utf-8');
  writeFileSync(join(dir, 'environment.json'), JSON.stringify({
    os: 'darwin',
    os_release: '25.4.0',
    arch: 'arm64',
    cpus: 'Apple M3 Max x 16',
    total_memory_gb: 128,
    node_version: 'v22.15.0',
    npm_version: '11.12.1',
    captured_at: '2026-05-15T14:30:01.679Z',
  }), 'utf-8');
}

function withPlatformImageFrontmatter(content: string): string {
  return content.replace(
    'published: false',
    [
      'published: false',
      'devto_main_image: ./assets/devto-cover.png',
      'medium_featured_image: ./assets/medium-featured.png',
      'substack_preview_image: ./assets/substack-preview.png',
    ].join('\n'),
  );
}

describe('getDraftPost', () => {
  it('returns post in draft phase', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const researchDir = join(dir, 'research');
    createDraftPost(dbPath, researchDir, 'alpha');

    const db = getDatabase(dbPath);
    try {
      const post = getDraftPost(db, 'alpha');
      expect(post).toBeDefined();
      expect(post!.phase).toBe('draft');
    } finally {
      closeDatabase(db);
    }
  });

  it('throws for wrong phase', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const researchDir = join(dir, 'research');
    const db = getDatabase(dbPath);
    try {
      initResearchPost(db, 'beta', 'test topic', 'directed', 'technical-deep-dive');
      expect(() => getDraftPost(db, 'beta')).toThrow("not 'draft'");
    } finally {
      closeDatabase(db);
    }
  });

  it('returns undefined for missing slug', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const db = getDatabase(dbPath);
    try {
      const post = getDraftPost(db, 'nonexistent');
      expect(post).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });
});

describe('initDraft', () => {
  it('creates draft directory structure and template MDX', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const draftsDir = join(dir, 'drafts');
    const benchmarkDir = join(dir, 'benchmarks');
    const researchDir = join(dir, 'research');
    const config = makeConfig(dir);
    createDraftPost(dbPath, researchDir, 'gamma');

    const db = getDatabase(dbPath);
    try {
      const result = initDraft(db, 'gamma', draftsDir, benchmarkDir, researchDir, config, join(dir, '.blogrc.yaml'));

      expect(existsSync(result.draftPath)).toBe(true);
      expect(existsSync(join(draftsDir, 'gamma', 'assets'))).toBe(true);
      expect(result.frontmatter.canonical).toBe('https://m0lz.dev/writing/gamma');
      expect(result.frontmatter.published).toBe(false);

      const content = readFileSync(result.draftPath, 'utf-8');
      expect(content).toContain('## Introduction');
      expect(content).toContain('## Conclusion');
    } finally {
      closeDatabase(db);
    }
  });

  it('is idempotent — second call does not overwrite', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const draftsDir = join(dir, 'drafts');
    const benchmarkDir = join(dir, 'benchmarks');
    const researchDir = join(dir, 'research');
    const config = makeConfig(dir);
    createDraftPost(dbPath, researchDir, 'delta');

    const db = getDatabase(dbPath);
    try {
      const first = initDraft(db, 'delta', draftsDir, benchmarkDir, researchDir, config, join(dir, '.blogrc.yaml'));

      // Simulate the skill filling in the draft — keep valid frontmatter
      // at the top so the file still parses, with author-edited body.
      writeFileSync(
        first.draftPath,
        '---\ntitle: Custom\ndescription: Edited\ndate: "2026-04-14"\ntags:\n  - test\npublished: false\n---\n\nauthor body content\n',
      );

      const second = initDraft(db, 'delta', draftsDir, benchmarkDir, researchDir, config, join(dir, '.blogrc.yaml'));
      expect(second.draftPath).toBe(first.draftPath);
      expect(second.frontmatter.title).toBe('Custom');

      const content = readFileSync(second.draftPath, 'utf-8');
      expect(content).toContain('author body content');
    } finally {
      closeDatabase(db);
    }
  });

  it('includes benchmark sections for technical-deep-dive', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const draftsDir = join(dir, 'drafts');
    const benchmarkDir = join(dir, 'benchmarks');
    const researchDir = join(dir, 'research');
    const config = makeConfig(dir);
    createDraftPost(dbPath, researchDir, 'epsilon', 'technical-deep-dive');

    const db = getDatabase(dbPath);
    try {
      const result = initDraft(db, 'epsilon', draftsDir, benchmarkDir, researchDir, config, join(dir, '.blogrc.yaml'));
      const content = readFileSync(result.draftPath, 'utf-8');
      expect(content).toContain('## Benchmark Results');
      expect(content).toContain('## Methodology');
    } finally {
      closeDatabase(db);
    }
  });

  it('omits benchmark sections for analysis-opinion', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const draftsDir = join(dir, 'drafts');
    const benchmarkDir = join(dir, 'benchmarks');
    const researchDir = join(dir, 'research');
    const config = makeConfig(dir);
    createDraftPost(dbPath, researchDir, 'zeta', 'analysis-opinion');

    const db = getDatabase(dbPath);
    try {
      const result = initDraft(db, 'zeta', draftsDir, benchmarkDir, researchDir, config, join(dir, '.blogrc.yaml'));
      const content = readFileSync(result.draftPath, 'utf-8');
      expect(content).not.toContain('## Benchmark Results');
      expect(content).not.toContain('## Methodology');
      expect(content).toContain('## Analysis');
      expect(content).toContain('## Key Takeaways');
    } finally {
      closeDatabase(db);
    }
  });

  it('derives project-launch frontmatter and sections from a completed research document', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const draftsDir = join(dir, 'drafts');
    const benchmarkDir = join(dir, 'benchmarks');
    const researchDir = join(dir, 'research');
    const config = makeConfig(dir);
    createDraftPost(dbPath, researchDir, 'launch-draft', 'project-launch');

    const db = getDatabase(dbPath);
    try {
      const result = initDraft(db, 'launch-draft', draftsDir, benchmarkDir, researchDir, config, join(dir, '.blogrc.yaml'));
      const content = readFileSync(result.draftPath, 'utf-8');
      const frontmatter = parseFrontmatter(content);

      expect(frontmatter.title).toBe('test.01 -- Launch Draft');
      expect(frontmatter.description).toBe('Test thesis statement');
      expect(frontmatter.tags).toContain('project-launch');
      expect(frontmatter.tags).toContain('test-01');
      expect(validateFrontmatter(frontmatter).ok).toBe(true);
      expect(content).toContain('## What It Does');
      expect(content).toContain('Test findings content');
      expect(content).toContain('## How It Works');
      expect(content).toContain('Test data');
      expect(content).toContain('## Architecture');
      expect(content).toContain('Test scope');
      expect(content).not.toContain('{/* TODO: Fill this section */}');
    } finally {
      closeDatabase(db);
    }
  });

  it('generates benchmark-backed project-launch drafts that pass structural autocheck', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const draftsDir = join(dir, 'drafts');
    const benchmarkDir = join(dir, 'benchmarks');
    const researchDir = join(dir, 'research');
    const config = makeConfig(dir);
    createDraftPost(dbPath, researchDir, 'benchmark-launch', 'project-launch');

    writeResearchDocument(researchDir, {
      slug: 'benchmark-launch',
      topic: 'benchmark launch',
      mode: 'directed',
      content_type: 'project-launch',
      created_at: new Date().toISOString(),
      thesis: 'Feature-level review misses seams in v0.2 workflows.',
      findings: 'Historical notes mention 1,262 tests, 553.273194 ms, and 96.6 percent confidence.',
      sources_list: 'Test sources',
      data_points: 'Older release evidence mentioned 586.49 ms and workflow run 25886626757.',
      open_questions: 'Can a generated draft avoid stale numbers?',
      benchmark_targets: '- Target A',
      repo_scope: 'The release notes also mention 100 concurrent CI runs as out of scope.',
    }, { force: true });
    writeBenchmarkArtifacts(benchmarkDir, 'benchmark-launch');

    const db = getDatabase(dbPath);
    try {
      db.prepare('UPDATE posts SET has_benchmarks = 1 WHERE slug = ?').run('benchmark-launch');
      const result = initDraft(db, 'benchmark-launch', draftsDir, benchmarkDir, researchDir, config, join(dir, '.blogrc.yaml'));
      const content = readFileSync(result.draftPath, 'utf-8');

      expect(content).toContain('## Benchmark Results');
      expect(content).toContain('ratio 0.504 &lt;= 0.625');
      expect(content).not.toContain('1,262 tests');
      expect(content).not.toContain('553.273194');

      const issues = runStructuralAutocheck(db, 'benchmark-launch', { draftsDir, benchmarkDir });
      expect(issues).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });

  it('regenerates stale evaluate-phase draft bodies from benchmark artifacts', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const draftsDir = join(dir, 'drafts');
    const benchmarkDir = join(dir, 'benchmarks');
    const researchDir = join(dir, 'research');
    const config = makeConfig(dir);
    createDraftPost(dbPath, researchDir, 'stale-launch', 'project-launch');
    writeBenchmarkArtifacts(benchmarkDir, 'stale-launch');

    const db = getDatabase(dbPath);
    try {
      db.prepare('UPDATE posts SET has_benchmarks = 1 WHERE slug = ?').run('stale-launch');
      initDraft(db, 'stale-launch', draftsDir, benchmarkDir, researchDir, config, join(dir, '.blogrc.yaml'));
      const mdxPath = draftPath(draftsDir, 'stale-launch');
      writeFileSync(
        mdxPath,
        readFileSync(mdxPath, 'utf-8')
          .replace('The claim surface is bounded', 'The stale draft says 9999 tests and ratio 0.999 before a bare <= marker. The claim surface is bounded'),
        'utf-8',
      );
      advancePhase(db, 'stale-launch', 'evaluate');

      const before = runStructuralAutocheck(db, 'stale-launch', { draftsDir, benchmarkDir });
      expect(before.some((issue) => issue.category === 'benchmark-claim-unbacked')).toBe(true);
      expect(before.some((issue) => issue.category === 'mdx-parse')).toBe(true);

      const result = regenerateDraft(db, 'stale-launch', draftsDir, benchmarkDir, researchDir, config, join(dir, '.blogrc.yaml'));
      expect(existsSync(result.receiptPath)).toBe(true);

      const after = runStructuralAutocheck(db, 'stale-launch', { draftsDir, benchmarkDir });
      expect(after).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });

  it('throws for missing post', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const db = getDatabase(dbPath);
    try {
      expect(() =>
        initDraft(db, 'missing', join(dir, 'drafts'), join(dir, 'bench'), join(dir, 'research'), makeConfig(dir), join(dir, '.blogrc.yaml')),
      ).toThrow('Post not found');
    } finally {
      closeDatabase(db);
    }
  });
});

describe('completeDraft', () => {
  it('advances to evaluate phase', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const draftsDir = join(dir, 'drafts');
    const benchmarkDir = join(dir, 'benchmarks');
    const researchDir = join(dir, 'research');
    const config = makeConfig(dir);
    createDraftPost(dbPath, researchDir, 'eta');

    const db = getDatabase(dbPath);
    try {
      initDraft(db, 'eta', draftsDir, benchmarkDir, researchDir, config, join(dir, '.blogrc.yaml'));

      // Write a valid draft (replace placeholders)
      const mdxPath = draftPath(draftsDir, 'eta');
      const content = readFileSync(mdxPath, 'utf-8')
        .replace('{{title}}', 'Real Title')
        .replace('{{description}}', 'Real description')
        .replace('tags: []', 'tags:\n  - typescript')
        .replace(/\{\/\* TODO: Fill this section \*\/\}/g, 'Filled content');
      writeFileSync(mdxPath, withPlatformImageFrontmatter(content), 'utf-8');

      completeDraft(db, 'eta', draftsDir, benchmarkDir);

      const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get('eta') as { phase: string };
      expect(post.phase).toBe('evaluate');
    } finally {
      closeDatabase(db);
    }
  });

  it('rejects draft before platform image frontmatter is present', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const draftsDir = join(dir, 'drafts');
    const benchmarkDir = join(dir, 'benchmarks');
    const researchDir = join(dir, 'research');
    const config = makeConfig(dir);
    createDraftPost(dbPath, researchDir, 'eta-no-images', 'analysis-opinion');

    const db = getDatabase(dbPath);
    try {
      initDraft(db, 'eta-no-images', draftsDir, benchmarkDir, researchDir, config, join(dir, '.blogrc.yaml'));

      const mdxPath = draftPath(draftsDir, 'eta-no-images');
      const content = readFileSync(mdxPath, 'utf-8')
        .replace('{{title}}', 'Real Title')
        .replace('{{description}}', 'Real description')
        .replace('tags: []', 'tags:\n  - typescript')
        .replace(/\{\/\* TODO: Fill this section \*\/\}/g, 'Filled content');
      writeFileSync(mdxPath, content, 'utf-8');

      expect(() => completeDraft(db, 'eta-no-images', draftsDir, benchmarkDir)).toThrow(
        'Missing platform image frontmatter',
      );
    } finally {
      closeDatabase(db);
    }
  });

  it('rejects draft with placeholder sections', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const draftsDir = join(dir, 'drafts');
    const benchmarkDir = join(dir, 'benchmarks');
    const researchDir = join(dir, 'research');
    const config = makeConfig(dir);
    createDraftPost(dbPath, researchDir, 'eta-placeholders', 'analysis-opinion');

    const db = getDatabase(dbPath);
    try {
      initDraft(db, 'eta-placeholders', draftsDir, benchmarkDir, researchDir, config, join(dir, '.blogrc.yaml'));

      // Replace frontmatter placeholders but leave body placeholders
      const mdxPath = draftPath(draftsDir, 'eta-placeholders');
      const content = readFileSync(mdxPath, 'utf-8')
        .replace('{{title}}', 'Real Title')
        .replace('{{description}}', 'Real description')
        .replace('Test data', '{/* TODO: Fill this section */}');
      writeFileSync(mdxPath, content, 'utf-8');

      expect(() => completeDraft(db, 'eta-placeholders', draftsDir, benchmarkDir)).toThrow('Placeholder sections remaining');
    } finally {
      closeDatabase(db);
    }
  });

  it('rejects draft with missing asset files', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const draftsDir = join(dir, 'drafts');
    const benchmarkDir = join(dir, 'benchmarks');
    const researchDir = join(dir, 'research');
    const config = makeConfig(dir);
    createDraftPost(dbPath, researchDir, 'eta-assets', 'analysis-opinion');

    const db = getDatabase(dbPath);
    try {
      initDraft(db, 'eta-assets', draftsDir, benchmarkDir, researchDir, config, join(dir, '.blogrc.yaml'));

      // Fill in draft completely
      const mdxPath = draftPath(draftsDir, 'eta-assets');
      const content = readFileSync(mdxPath, 'utf-8')
        .replace('{{title}}', 'Real Title')
        .replace('{{description}}', 'Real description')
        .replace(/\{\/\* TODO: Fill this section \*\/\}/g, 'Content');
      writeFileSync(mdxPath, content, 'utf-8');

      // Register an asset that doesn't exist on disk
      registerAsset(db, 'eta-assets', 'excalidraw', 'ghost.svg');

      expect(() => completeDraft(db, 'eta-assets', draftsDir, benchmarkDir)).toThrow('Missing asset file: ghost.svg');
    } finally {
      closeDatabase(db);
    }
  });

  it('rejects benchmarked draft with malformed benchmark results', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const draftsDir = join(dir, 'drafts');
    const benchmarkDir = join(dir, 'benchmarks');
    const researchDir = join(dir, 'research');
    const config = makeConfig(dir);
    createDraftPost(dbPath, researchDir, 'eta-bad-benchmark');

    const db = getDatabase(dbPath);
    try {
      initDraft(db, 'eta-bad-benchmark', draftsDir, benchmarkDir, researchDir, config, join(dir, '.blogrc.yaml'));

      const mdxPath = draftPath(draftsDir, 'eta-bad-benchmark');
      const content = readFileSync(mdxPath, 'utf-8')
        .replace('{{title}}', 'Real Title')
        .replace('{{description}}', 'Real description')
        .replace('tags: []', 'tags:\n  - typescript')
        .replace(/\{\/\* TODO: Fill this section \*\/\}/g, 'Content');
      writeFileSync(mdxPath, content, 'utf-8');

      db.prepare('UPDATE posts SET has_benchmarks = 1 WHERE slug = ?').run('eta-bad-benchmark');
      const benchSlugDir = join(benchmarkDir, 'eta-bad-benchmark');
      mkdirSync(benchSlugDir, { recursive: true });
      writeFileSync(join(benchSlugDir, 'results.json'), JSON.stringify({
        slug: 'eta-bad-benchmark',
        timestamp: new Date().toISOString(),
        targets: ['Target A'],
        data: {},
      }), 'utf-8');

      expect(() => completeDraft(db, 'eta-bad-benchmark', draftsDir, benchmarkDir)).toThrow(
        'Invalid benchmark results',
      );
    } finally {
      closeDatabase(db);
    }
  });

  it('throws for wrong phase', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const db = getDatabase(dbPath);
    try {
      initResearchPost(db, 'theta', 'test', 'directed', 'technical-deep-dive');
      expect(() => completeDraft(db, 'theta', join(dir, 'drafts'), join(dir, 'benchmarks'))).toThrow("not 'draft'");
    } finally {
      closeDatabase(db);
    }
  });

  it('throws for missing post', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const db = getDatabase(dbPath);
    try {
      expect(() => completeDraft(db, 'nonexistent', join(dir, 'drafts'), join(dir, 'benchmarks'))).toThrow('Post not found');
    } finally {
      closeDatabase(db);
    }
  });
});

describe('registerAsset / listAssets', () => {
  it('inserts into assets table', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const researchDir = join(dir, 'research');
    createDraftPost(dbPath, researchDir, 'iota');

    const db = getDatabase(dbPath);
    try {
      registerAsset(db, 'iota', 'excalidraw', 'arch-diagram.svg');
      const assets = listAssets(db, 'iota');
      expect(assets).toHaveLength(1);
      expect(assets[0].filename).toBe('arch-diagram.svg');
      expect(assets[0].type).toBe('excalidraw');
    } finally {
      closeDatabase(db);
    }
  });

  it('is idempotent', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const researchDir = join(dir, 'research');
    createDraftPost(dbPath, researchDir, 'kappa');

    const db = getDatabase(dbPath);
    try {
      registerAsset(db, 'kappa', 'chart', 'perf.png');
      registerAsset(db, 'kappa', 'chart', 'perf.png');
      const assets = listAssets(db, 'kappa');
      expect(assets).toHaveLength(1);
    } finally {
      closeDatabase(db);
    }
  });

  it('returns empty for unknown slug', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const db = getDatabase(dbPath);
    try {
      const assets = listAssets(db, 'nonexistent');
      expect(assets).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });
});
