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
  registerAsset,
  listAssets,
  draftPath,
} from '../src/core/draft/state.js';
import { BlogConfig } from '../src/core/config/types.js';

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
    initResearchPost(db, slug, 'test topic', 'directed', contentType as any);
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
      const result = initDraft(db, 'gamma', draftsDir, benchmarkDir, researchDir, config);

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
      const first = initDraft(db, 'delta', draftsDir, benchmarkDir, researchDir, config);

      // Simulate the skill filling in the draft — keep valid frontmatter
      // at the top so the file still parses, with author-edited body.
      writeFileSync(
        first.draftPath,
        '---\ntitle: Custom\ndescription: Edited\ndate: "2026-04-14"\ntags:\n  - test\npublished: false\n---\n\nauthor body content\n',
      );

      const second = initDraft(db, 'delta', draftsDir, benchmarkDir, researchDir, config);
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
      const result = initDraft(db, 'epsilon', draftsDir, benchmarkDir, researchDir, config);
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
      const result = initDraft(db, 'zeta', draftsDir, benchmarkDir, researchDir, config);
      const content = readFileSync(result.draftPath, 'utf-8');
      expect(content).not.toContain('## Benchmark Results');
      expect(content).not.toContain('## Methodology');
      expect(content).toContain('## Analysis');
      expect(content).toContain('## Key Takeaways');
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
        initDraft(db, 'missing', join(dir, 'drafts'), join(dir, 'bench'), join(dir, 'research'), makeConfig(dir)),
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
      initDraft(db, 'eta', draftsDir, benchmarkDir, researchDir, config);

      // Write a valid draft (replace placeholders)
      const mdxPath = draftPath(draftsDir, 'eta');
      const content = readFileSync(mdxPath, 'utf-8')
        .replace('{{title}}', 'Real Title')
        .replace('{{description}}', 'Real description')
        .replace('tags: []', 'tags:\n  - typescript')
        .replace(/\{\/\* TODO: Fill this section \*\/\}/g, 'Filled content');
      writeFileSync(mdxPath, content, 'utf-8');

      completeDraft(db, 'eta', draftsDir);

      const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get('eta') as { phase: string };
      expect(post.phase).toBe('evaluate');
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
      initDraft(db, 'eta-placeholders', draftsDir, benchmarkDir, researchDir, config);

      // Replace frontmatter placeholders but leave body placeholders
      const mdxPath = draftPath(draftsDir, 'eta-placeholders');
      const content = readFileSync(mdxPath, 'utf-8')
        .replace('{{title}}', 'Real Title')
        .replace('{{description}}', 'Real description');
      writeFileSync(mdxPath, content, 'utf-8');

      expect(() => completeDraft(db, 'eta-placeholders', draftsDir)).toThrow('Placeholder sections remaining');
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
      initDraft(db, 'eta-assets', draftsDir, benchmarkDir, researchDir, config);

      // Fill in draft completely
      const mdxPath = draftPath(draftsDir, 'eta-assets');
      const content = readFileSync(mdxPath, 'utf-8')
        .replace('{{title}}', 'Real Title')
        .replace('{{description}}', 'Real description')
        .replace(/\{\/\* TODO: Fill this section \*\/\}/g, 'Content');
      writeFileSync(mdxPath, content, 'utf-8');

      // Register an asset that doesn't exist on disk
      registerAsset(db, 'eta-assets', 'excalidraw', 'ghost.svg');

      expect(() => completeDraft(db, 'eta-assets', draftsDir)).toThrow('Missing asset file: ghost.svg');
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
      expect(() => completeDraft(db, 'theta', join(dir, 'drafts'))).toThrow("not 'draft'");
    } finally {
      closeDatabase(db);
    }
  });

  it('throws for missing post', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'state.db');
    const db = getDatabase(dbPath);
    try {
      expect(() => completeDraft(db, 'nonexistent', join(dir, 'drafts'))).toThrow('Post not found');
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
