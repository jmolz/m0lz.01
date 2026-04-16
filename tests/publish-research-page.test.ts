import { describe, it, expect, afterEach } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

import { closeDatabase, getDatabase } from '../src/core/db/database.js';
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
import { generateResearchPage, ResearchPagePaths } from '../src/core/publish/research-page.js';
import { BlogConfig } from '../src/core/config/types.js';

const WORKTREE_ROOT = join(__dirname, '..');
const REAL_TEMPLATE_PATH = join(WORKTREE_ROOT, 'templates', 'research-page', 'template.mdx');

function makeConfig(): BlogConfig {
  return {
    site: {
      repo_path: '/tmp/site',
      base_url: 'https://m0lz.dev',
      content_dir: 'content/posts',
      research_dir: 'content/research',
    },
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

interface Fixture {
  tempDir: string;
  researchDir: string;
  benchmarkDir: string;
  researchPagesDir: string;
  templatesDir: string;
  draftsDir: string;
  db: Database.Database;
  paths: ResearchPagePaths;
}

let fixture: Fixture | undefined;

function setup(copyTemplate = true): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'publish-rp-'));
  const researchDir = join(tempDir, 'research');
  const benchmarkDir = join(tempDir, 'benchmarks');
  const researchPagesDir = join(tempDir, 'research-pages');
  const templatesDir = join(tempDir, 'templates');
  const draftsDir = join(tempDir, 'drafts');
  mkdirSync(researchDir, { recursive: true });
  mkdirSync(benchmarkDir, { recursive: true });
  mkdirSync(researchPagesDir, { recursive: true });
  mkdirSync(join(templatesDir, 'research-page'), { recursive: true });
  mkdirSync(draftsDir, { recursive: true });
  if (copyTemplate) {
    cpSync(REAL_TEMPLATE_PATH, join(templatesDir, 'research-page', 'template.mdx'));
  }
  const db = getDatabase(':memory:');
  const paths: ResearchPagePaths = {
    researchDir,
    benchmarkDir,
    researchPagesDir,
    templatesDir,
    draftsDir,
  };
  fixture = {
    tempDir, researchDir, benchmarkDir, researchPagesDir, templatesDir, draftsDir, db, paths,
  };
  return fixture;
}

afterEach(() => {
  if (fixture?.db) closeDatabase(fixture.db);
  if (fixture) rmSync(fixture.tempDir, { recursive: true, force: true });
  fixture = undefined;
});

function seedPost(
  db: Database.Database,
  slug: string,
  contentType: 'project-launch' | 'technical-deep-dive' | 'analysis-opinion' = 'technical-deep-dive',
): void {
  initResearchPost(db, slug, 'some topic', 'directed', contentType);
  advancePhase(db, slug, 'benchmark');
  advancePhase(db, slug, 'draft');
  advancePhase(db, slug, 'evaluate');
  db.prepare('UPDATE posts SET title = ?, evaluation_passed = 1 WHERE slug = ?').run(
    'Sample Research',
    slug,
  );
  advancePhase(db, slug, 'publish');
}

const SAMPLE_RESEARCH_MD = `# Research Doc

This is the thesis paragraph — the first non-heading block is captured as the thesis.

## Key Findings

Finding one with a [source A](https://example.com/a) link.

Finding two citing [source B](https://example.com/b).

## Open Questions

What about X?

## Bibliography

Duplicate reference to [source A](https://example.com/a).
`;

function writeResearchDoc(researchDir: string, slug: string, body = SAMPLE_RESEARCH_MD): void {
  writeFileSync(join(researchDir, `${slug}.md`), body, 'utf-8');
}

function writeBenchmarkResults(benchmarkDir: string, slug: string, summary: string): void {
  const dir = join(benchmarkDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ summary }), 'utf-8');
}

function writeDraft(
  draftsDir: string,
  slug: string,
  description = 'Sample description from draft',
): void {
  const dir = join(draftsDir, slug);
  mkdirSync(dir, { recursive: true });
  const frontmatter = [
    '---',
    'title: "Sample Research"',
    `description: "${description}"`,
    'date: "2026-04-16"',
    'tags:',
    '  - research',
    'published: false',
    '---',
    '',
    'Body.',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'index.mdx'), frontmatter, 'utf-8');
}

describe('generateResearchPage — happy path', () => {
  it('generates MDX with thesis, findings, and bibliography from the research doc', () => {
    const f = setup();
    seedPost(f.db, 'happy');
    writeResearchDoc(f.researchDir, 'happy');
    writeDraft(f.draftsDir, 'happy');
    writeBenchmarkResults(f.benchmarkDir, 'happy', 'Ran 10k iterations; median 1.2ms');

    const result = generateResearchPage('happy', makeConfig(), f.paths, f.db);
    expect(result.path).toBe(join(f.researchPagesDir, 'happy', 'index.mdx'));
    const content = readFileSync(result.path!, 'utf-8');
    expect(content).toContain('This is the thesis paragraph');
    expect(content).toContain('Finding one');
    // Source A appears in findings AND bibliography (once each — bibliography
    // dedupes within itself). Dedupe is list-scoped, not document-scoped.
    const sourceACount = (content.match(/\[source A\]/g) ?? []).length;
    expect(sourceACount).toBeGreaterThanOrEqual(1);
    expect(sourceACount).toBeLessThanOrEqual(2);
    expect(content).toContain('[source B]');
    expect(content).toContain('Ran 10k iterations');
  });

  it('extracts the first non-heading paragraph as the thesis', () => {
    const f = setup();
    seedPost(f.db, 'thesis');
    writeResearchDoc(
      f.researchDir, 'thesis',
      `# Title\n\nFirst real paragraph becomes the thesis.\n\n## Section\n\nOther body.\n`,
    );
    writeDraft(f.draftsDir, 'thesis');
    generateResearchPage('thesis', makeConfig(), f.paths, f.db);
    const content = readFileSync(join(f.researchPagesDir, 'thesis', 'index.mdx'), 'utf-8');
    expect(content).toContain('First real paragraph becomes the thesis');
  });

  it('dedupes bibliography entries by URL across the document', () => {
    const f = setup();
    seedPost(f.db, 'dedupe');
    writeResearchDoc(
      f.researchDir, 'dedupe',
      `# Doc\n\nIntro.\n\n[one](https://x.com/1) and [one dup](https://x.com/1) and [two](https://x.com/2).`,
    );
    writeDraft(f.draftsDir, 'dedupe');
    generateResearchPage('dedupe', makeConfig(), f.paths, f.db);
    const content = readFileSync(join(f.researchPagesDir, 'dedupe', 'index.mdx'), 'utf-8');
    const urls = (content.match(/https:\/\/x\.com\/1/g) ?? []).length;
    expect(urls).toBe(1);
    expect(content).toContain('https://x.com/2');
  });

  it('reads description from draft MDX frontmatter', () => {
    const f = setup();
    seedPost(f.db, 'desc');
    writeResearchDoc(f.researchDir, 'desc');
    writeDraft(f.draftsDir, 'desc', 'A very specific description for the description test.');
    const result = generateResearchPage('desc', makeConfig(), f.paths, f.db);
    const content = readFileSync(result.path!, 'utf-8');
    expect(content).toContain('A very specific description for the description test.');
  });

  it('falls back to empty description when draft is missing', () => {
    const f = setup();
    seedPost(f.db, 'nodraft');
    writeResearchDoc(f.researchDir, 'nodraft');
    // No writeDraft — draft MDX absent
    const result = generateResearchPage('nodraft', makeConfig(), f.paths, f.db);
    expect(result.path).toBeDefined();
    expect(existsSync(result.path!)).toBe(true);
  });
});

describe('generateResearchPage — content type routing', () => {
  it('skips for analysis-opinion when research doc is missing', () => {
    const f = setup();
    seedPost(f.db, 'skip-op', 'analysis-opinion');
    writeDraft(f.draftsDir, 'skip-op');
    const result = generateResearchPage('skip-op', makeConfig(), f.paths, f.db);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/Analysis-opinion without research artifacts/);
  });

  it('generates page for analysis-opinion when research doc IS present', () => {
    const f = setup();
    seedPost(f.db, 'op-with-research', 'analysis-opinion');
    writeResearchDoc(f.researchDir, 'op-with-research');
    writeDraft(f.draftsDir, 'op-with-research');
    const result = generateResearchPage('op-with-research', makeConfig(), f.paths, f.db);
    expect(result.skipped).toBeUndefined();
    expect(result.path).toBeDefined();
    expect(existsSync(result.path!)).toBe(true);
  });
});

describe('generateResearchPage — errors and idempotency', () => {
  it('throws when template file is missing', () => {
    const f = setup(false);
    seedPost(f.db, 'notemplate');
    writeResearchDoc(f.researchDir, 'notemplate');
    writeDraft(f.draftsDir, 'notemplate');
    expect(() => generateResearchPage('notemplate', makeConfig(), f.paths, f.db)).toThrow(
      /Template not found/,
    );
  });

  it('is idempotent — a second call overwrites the file cleanly', () => {
    const f = setup();
    seedPost(f.db, 'idem');
    writeResearchDoc(f.researchDir, 'idem');
    writeDraft(f.draftsDir, 'idem');
    const first = generateResearchPage('idem', makeConfig(), f.paths, f.db);
    const firstContent = readFileSync(first.path!, 'utf-8');
    const second = generateResearchPage('idem', makeConfig(), f.paths, f.db);
    expect(second.path).toBe(first.path);
    const secondContent = readFileSync(second.path!, 'utf-8');
    expect(secondContent).toBe(firstContent);
  });

  it('throws when post not found in DB', () => {
    const f = setup();
    expect(() => generateResearchPage('nonexistent', makeConfig(), f.paths, f.db)).toThrow(
      /Post not found/,
    );
  });
});
