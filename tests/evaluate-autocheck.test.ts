import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { runStructuralAutocheck } from '../src/core/evaluate/autocheck.js';
import { PostRow } from '../src/core/db/types.js';
import Database from 'better-sqlite3';

interface Fixture {
  tempDir: string;
  draftsDir: string;
  benchmarkDir: string;
  db: Database.Database;
}

let fixture: Fixture | undefined;

afterEach(() => {
  if (fixture?.db) closeDatabase(fixture.db);
  if (fixture) rmSync(fixture.tempDir, { recursive: true, force: true });
  fixture = undefined;
});

function setup(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'eval-autocheck-'));
  const draftsDir = join(tempDir, 'drafts');
  const benchmarkDir = join(tempDir, 'benchmarks');
  mkdirSync(draftsDir, { recursive: true });
  mkdirSync(benchmarkDir, { recursive: true });
  const db = getDatabase(':memory:');
  fixture = { tempDir, draftsDir, benchmarkDir, db };
  return fixture;
}

function insertPost(db: Database.Database, slug: string, overrides: Partial<PostRow> = {}): void {
  db.prepare(`
    INSERT INTO posts (slug, title, topic, content_type, phase, mode, has_benchmarks)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    slug,
    overrides.title ?? 'A test title',
    overrides.topic ?? 'a topic',
    overrides.content_type ?? 'technical-deep-dive',
    overrides.phase ?? 'evaluate',
    overrides.mode ?? 'directed',
    overrides.has_benchmarks ?? 0,
  );
}

function writeDraft(draftsDir: string, slug: string, body: string, frontmatter?: Record<string, unknown>): void {
  const dir = join(draftsDir, slug);
  mkdirSync(dir, { recursive: true });
  const fm = frontmatter ?? {
    title: 'A real title',
    description: 'A real description of the post',
    date: '2026-04-14',
    tags: ['testing'],
    published: false,
  };
  const fmLines = Object.entries(fm)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.map((x) => `"${x}"`).join(', ')}]`;
      if (typeof v === 'boolean') return `${k}: ${v}`;
      return `${k}: "${v}"`;
    })
    .join('\n');
  writeFileSync(join(dir, 'index.mdx'), `---\n${fmLines}\n---\n\n${body}`, 'utf-8');
}

function writeResults(benchmarkDir: string, slug: string, data: unknown): void {
  const dir = join(benchmarkDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'results.json'),
    JSON.stringify({ slug, run_id: 1, timestamp: '2026-04-14T00:00:00Z', targets: [], data }, null, 2),
    'utf-8',
  );
}

describe('runStructuralAutocheck — determinism', () => {
  it('produces byte-identical output across runs on the same draft', () => {
    const f = setup();
    insertPost(f.db, 'det');
    writeDraft(f.draftsDir, 'det', 'Body text with a [broken link](/writing/nonexistent).');

    const first = runStructuralAutocheck(f.db, 'det', { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir });
    const second = runStructuralAutocheck(f.db, 'det', { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('sorts issues by (category, id)', () => {
    const f = setup();
    insertPost(f.db, 'sorted', { has_benchmarks: 1 });
    // companion_repo missing AND a broken link — two different categories.
    writeDraft(
      f.draftsDir,
      'sorted',
      'Body with [broken](/writing/nope).',
      { title: 'Real', description: 'Real desc', date: '2026-04-14', tags: ['a'], published: false },
    );
    const issues = runStructuralAutocheck(f.db, 'sorted', { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir });
    for (let i = 1; i < issues.length; i++) {
      const prevKey = `${issues[i - 1].category}:${issues[i - 1].id}`;
      const curKey = `${issues[i].category}:${issues[i].id}`;
      expect(prevKey <= curKey).toBe(true);
    }
  });
});

describe('runStructuralAutocheck — no-false-positives baseline', () => {
  it('returns empty issue list for a fully valid draft', () => {
    const f = setup();
    insertPost(f.db, 'clean');
    writeDraft(f.draftsDir, 'clean', 'Clean body text. No placeholders, no broken links.');
    const issues = runStructuralAutocheck(f.db, 'clean', { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir });
    expect(issues).toEqual([]);
  });

  it('returns empty list when draft file is missing (graceful)', () => {
    const f = setup();
    insertPost(f.db, 'no-draft');
    const issues = runStructuralAutocheck(f.db, 'no-draft', { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir });
    expect(issues).toEqual([]);
  });
});

describe('runStructuralAutocheck — lint categories', () => {
  it('catches frontmatter-placeholder when title is still the template token', () => {
    const f = setup();
    insertPost(f.db, 'ph');
    writeDraft(f.draftsDir, 'ph', 'Body.', {
      title: '{{title}}',
      description: 'real',
      date: '2026-04-14',
      tags: ['x'],
      published: false,
    });
    const issues = runStructuralAutocheck(f.db, 'ph', { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir });
    expect(issues.some((i) => i.category === 'frontmatter-placeholder')).toBe(true);
  });

  it('catches frontmatter-schema on invalid date format', () => {
    const f = setup();
    insertPost(f.db, 'bad-date');
    writeDraft(f.draftsDir, 'bad-date', 'Body.', {
      title: 'Real',
      description: 'Real desc',
      date: 'not-a-date',
      tags: ['x'],
      published: false,
    });
    const issues = runStructuralAutocheck(f.db, 'bad-date', { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir });
    expect(issues.some((i) => i.category === 'frontmatter-schema')).toBe(true);
  });

  it('catches placeholder-section when body contains TODO markers', () => {
    const f = setup();
    insertPost(f.db, 'todo');
    writeDraft(f.draftsDir, 'todo', 'Body {/* TODO: Fill this section */} more.');
    const issues = runStructuralAutocheck(f.db, 'todo', { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir });
    expect(issues.some((i) => i.category === 'placeholder-section')).toBe(true);
  });

  it('catches broken-internal-link for unresolvable /writing/ slug', () => {
    const f = setup();
    insertPost(f.db, 'links');
    writeDraft(f.draftsDir, 'links', 'See [this](/writing/does-not-exist) for details.');
    const issues = runStructuralAutocheck(f.db, 'links', { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir });
    expect(issues.some((i) => i.category === 'broken-internal-link')).toBe(true);
  });

  it('catches broken anchor link when heading is missing', () => {
    const f = setup();
    insertPost(f.db, 'anchors');
    writeDraft(f.draftsDir, 'anchors', '## Intro\n\nSee [link](#missing-heading).');
    const issues = runStructuralAutocheck(f.db, 'anchors', { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir });
    expect(issues.some((i) => i.category === 'broken-internal-link')).toBe(true);
  });

  it('catches mdx-parse on unbalanced code fences', () => {
    const f = setup();
    insertPost(f.db, 'parse');
    writeDraft(f.draftsDir, 'parse', '```js\nconst x = 1;\n\n(no closing fence)');
    const issues = runStructuralAutocheck(f.db, 'parse', { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir });
    expect(issues.some((i) => i.category === 'mdx-parse')).toBe(true);
  });

  it('catches benchmark-claim-unbacked when prose contains numeric values not in results.json', () => {
    const f = setup();
    insertPost(f.db, 'claims');
    writeDraft(f.draftsDir, 'claims', 'We measured 42 runs and achieved 99 percent accuracy.');
    writeResults(f.benchmarkDir, 'claims', { runs: 3, accuracy: 0.95 });
    const issues = runStructuralAutocheck(f.db, 'claims', { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir });
    expect(issues.some((i) => i.category === 'benchmark-claim-unbacked')).toBe(true);
  });

  it('skips benchmark-claim-unbacked silently when results.json is absent', () => {
    const f = setup();
    insertPost(f.db, 'no-bench');
    writeDraft(f.draftsDir, 'no-bench', 'We measured 42 runs and achieved 99 percent accuracy.');
    const issues = runStructuralAutocheck(f.db, 'no-bench', { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir });
    expect(issues.filter((i) => i.category === 'benchmark-claim-unbacked')).toHaveLength(0);
  });

  it('catches missing-companion-repo when has_benchmarks=1 and companion_repo absent', () => {
    const f = setup();
    insertPost(f.db, 'needs-repo', { has_benchmarks: 1 });
    writeDraft(f.draftsDir, 'needs-repo', 'Body.');
    const issues = runStructuralAutocheck(f.db, 'needs-repo', { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir });
    expect(issues.some((i) => i.category === 'missing-companion-repo')).toBe(true);
  });

  it('does not flag missing-companion-repo when companion_repo is present', () => {
    const f = setup();
    insertPost(f.db, 'has-repo', { has_benchmarks: 1 });
    writeDraft(f.draftsDir, 'has-repo', 'Body.', {
      title: 'Real',
      description: 'Real desc',
      date: '2026-04-14',
      tags: ['x'],
      published: false,
      companion_repo: 'https://github.com/owner/repo',
    });
    const issues = runStructuralAutocheck(f.db, 'has-repo', { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir });
    expect(issues.filter((i) => i.category === 'missing-companion-repo')).toHaveLength(0);
  });
});

describe('runStructuralAutocheck — issue tagging', () => {
  it('tags every issue with source=autocheck', () => {
    const f = setup();
    insertPost(f.db, 'tagged', { has_benchmarks: 1 });
    writeDraft(f.draftsDir, 'tagged', 'Body {/* TODO: Fill this section */}.');
    const issues = runStructuralAutocheck(f.db, 'tagged', { draftsDir: f.draftsDir, benchmarkDir: f.benchmarkDir });
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.source).toBe('autocheck');
    }
  });
});
