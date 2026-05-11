import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
import { runDraftRegenerateFrontmatter, DraftPaths } from '../src/cli/draft.js';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  process.exitCode = 0;
  vi.restoreAllMocks();
});

interface Fixture {
  tempDir: string;
  dbPath: string;
  draftsDir: string;
  configPath: string;
  paths: DraftPaths;
}

function setup(): Fixture {
  tempDir = mkdtempSync(join(tmpdir(), 'regen-frontmatter-'));
  const dbPath = join(tempDir, 'state.db');
  const draftsDir = join(tempDir, 'drafts');
  const configPath = join(tempDir, '.blogrc.yaml');

  const db = getDatabase(dbPath);
  closeDatabase(db);

  writeFileSync(configPath, `site:
  repo_path: "./site"
  base_url: "https://m0lz.dev"
  content_dir: "content/posts"
  research_dir: "content/research"
author:
  name: "Tester"
  github: "jmolz"
`);

  return {
    tempDir,
    dbPath,
    draftsDir,
    configPath,
    paths: { dbPath, draftsDir, configPath },
  };
}

function seedDraft(
  f: Fixture,
  slug: string,
  frontmatter: string,
  body: string,
  projectId: string | null = null,
  phase: 'draft' | 'evaluate' | 'publish' | 'published' = 'draft',
): void {
  const db = getDatabase(f.dbPath);
  try {
    const ct = projectId ? 'project-launch' : 'technical-deep-dive';
    initResearchPost(db, slug, 'topic', 'directed', ct, projectId);
    advancePhase(db, slug, 'benchmark');
    advancePhase(db, slug, 'draft');
    if (phase !== 'draft') {
      advancePhase(db, slug, 'evaluate');
      db.prepare('UPDATE posts SET evaluation_passed = 1 WHERE slug = ?').run(slug);
    }
    if (phase === 'publish' || phase === 'published') {
      advancePhase(db, slug, 'publish');
    }
    if (phase === 'published') {
      advancePhase(db, slug, 'published');
    }
  } finally {
    closeDatabase(db);
  }
  const draftDir = join(f.draftsDir, slug);
  mkdirSync(draftDir, { recursive: true });
  writeFileSync(join(draftDir, 'index.mdx'), `---\n${frontmatter}\n---\n\n${body}`);
}

function addProjectWithOrigin(f: Fixture, projectId: string, originUrl: string): void {
  const projectDir = join(f.tempDir, 'project');
  mkdirSync(projectDir, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
  execFileSync('git', ['remote', 'add', 'origin', originUrl], { cwd: projectDir });
  // Append to config.
  const existing = readFileSync(f.configPath, 'utf-8');
  writeFileSync(f.configPath, `${existing}projects:\n  ${projectId}: "./project"\n`);
}

function captureLogs(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(' '));
  });
  return { logs, errors };
}

describe('runDraftRegenerateFrontmatter', () => {
  it('adds missing companion_repo from config.projects + git origin', () => {
    const f = setup();
    addProjectWithOrigin(f, 'test.01', 'https://github.com/x/y.git');
    const existingFrontmatter = [
      'title: My Post',
      'description: A description',
      'date: "2026-04-01"',
      'tags:',
      '  - example',
      'published: false',
      'canonical: https://m0lz.dev/writing/alpha',
      'project: test.01',
    ].join('\n');
    const bodyContent = '# Heading\n\nParagraph.\n\n---\n\nAfter a thematic break.\n';
    seedDraft(f, 'alpha', existingFrontmatter, bodyContent, 'test.01');

    captureLogs();
    runDraftRegenerateFrontmatter('alpha', f.paths);

    const updated = readFileSync(join(f.draftsDir, 'alpha', 'index.mdx'), 'utf-8');
    expect(updated).toContain('companion_repo: https://github.com/x/y');
    // Body preserved byte-for-byte below the second `---`.
    const bodyStart = updated.indexOf('\n---\n') + '\n---\n'.length;
    const preservedBody = updated.slice(bodyStart);
    expect(preservedBody).toContain('# Heading');
    expect(preservedBody).toContain('thematic break');
    expect(process.exitCode).not.toBe(1);
  });

  it('writes a receipt file with previous/new hashes and fields_changed', () => {
    const f = setup();
    addProjectWithOrigin(f, 'test.01', 'https://github.com/x/y');
    const fm = [
      'title: Beta',
      'description: d',
      'date: "2026-04-01"',
      'tags:',
      '  - t',
      'published: false',
      'project: test.01',
    ].join('\n');
    seedDraft(f, 'beta', fm, 'body\n', 'test.01');

    captureLogs();
    runDraftRegenerateFrontmatter('beta', f.paths);

    const receiptPath = join(f.draftsDir, 'beta', '.frontmatter-regenerated.json');
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf-8'));
    expect(receipt.slug).toBe('beta');
    expect(receipt.previous_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.new_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.previous_hash).not.toBe(receipt.new_hash);
    expect(receipt.fields_changed).toContain('companion_repo');
    expect(receipt.project_id_before).toBe('test.01');
    expect(receipt.project_id_after).toBe('test.01');
  });

  it('repairs a stale project-launch row with project_id=NULL when --project is supplied', () => {
    const f = setup();
    addProjectWithOrigin(f, 'test.01', 'https://github.com/x/y.git');
    const fm = [
      'title: Recovery',
      'description: d',
      'date: "2026-04-01"',
      'tags:',
      '  - t',
      'published: false',
    ].join('\n');
    seedDraft(f, 'stale-project', fm, 'body\n', 'test.01', 'publish');

    const db = getDatabase(f.dbPath);
    try {
      db.prepare('UPDATE posts SET project_id = NULL WHERE slug = ?').run('stale-project');
    } finally {
      closeDatabase(db);
    }

    captureLogs();
    runDraftRegenerateFrontmatter('stale-project', f.paths, { projectId: 'test.01' });

    const updated = readFileSync(join(f.draftsDir, 'stale-project', 'index.mdx'), 'utf-8');
    expect(updated).toContain('project: test.01');
    expect(updated).toContain('companion_repo: https://github.com/x/y');

    const db2 = getDatabase(f.dbPath);
    try {
      const row = db2.prepare('SELECT project_id FROM posts WHERE slug = ?').get('stale-project') as {
        project_id: string | null;
      };
      expect(row.project_id).toBe('test.01');
    } finally {
      closeDatabase(db2);
    }
  });

  it('fails loudly for project-launch rows with project_id=NULL when --project is omitted', () => {
    const f = setup();
    const fm = [
      'title: Missing Project',
      'description: d',
      'date: "2026-04-01"',
      'tags:',
      '  - t',
      'published: false',
    ].join('\n');
    seedDraft(f, 'missing-project', fm, 'body\n', 'test.01', 'publish');

    const mdxPath = join(f.draftsDir, 'missing-project', 'index.mdx');
    const beforeBytes = readFileSync(mdxPath);
    const db = getDatabase(f.dbPath);
    try {
      db.prepare('UPDATE posts SET project_id = NULL WHERE slug = ?').run('missing-project');
    } finally {
      closeDatabase(db);
    }

    const { errors } = captureLogs();
    runDraftRegenerateFrontmatter('missing-project', f.paths);

    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('PROJECT_UNLINKED');
    expect(readFileSync(mdxPath).equals(beforeBytes)).toBe(true);
  });

  it('preserves operator-authored title/description/tags (does not overwrite)', () => {
    const f = setup();
    addProjectWithOrigin(f, 'test.01', 'https://github.com/x/y');
    const operatorTitle = 'Operator-authored title that must survive';
    const fm = [
      `title: ${operatorTitle}`,
      'description: Preserved description',
      'date: "2026-04-01"',
      'tags:',
      '  - t1',
      '  - t2',
      'published: false',
      'project: test.01',
    ].join('\n');
    seedDraft(f, 'gamma', fm, 'body\n', 'test.01');

    captureLogs();
    runDraftRegenerateFrontmatter('gamma', f.paths);

    const updated = readFileSync(join(f.draftsDir, 'gamma', 'index.mdx'), 'utf-8');
    expect(updated).toContain(operatorTitle);
    expect(updated).toContain('Preserved description');
    expect(updated).toContain('- t1');
    expect(updated).toContain('- t2');
  });

  it('rejects phase=published with actionable error and does not rewrite the file', () => {
    const f = setup();
    const fm = [
      'title: Published Post',
      'description: d',
      'date: "2026-04-01"',
      'tags:',
      '  - t',
      'published: true',
    ].join('\n');
    seedDraft(f, 'shipped', fm, 'body\n', null, 'published');

    const mdxPath = join(f.draftsDir, 'shipped', 'index.mdx');
    const beforeBytes = readFileSync(mdxPath);

    const { errors } = captureLogs();
    runDraftRegenerateFrontmatter('shipped', f.paths);

    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/published/);
    // File unchanged.
    const afterBytes = readFileSync(mdxPath);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
    // No receipt file either.
    expect(existsSync(join(f.draftsDir, 'shipped', '.frontmatter-regenerated.json'))).toBe(false);
  });

  it('fails loudly when the draft MDX does not exist', () => {
    const f = setup();
    const db = getDatabase(f.dbPath);
    try {
      initResearchPost(db, 'no-draft', 'topic', 'directed', 'technical-deep-dive');
    } finally {
      closeDatabase(db);
    }

    const { errors } = captureLogs();
    runDraftRegenerateFrontmatter('no-draft', f.paths);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/Draft MDX not found/);
  });

  it('does not touch any files outside .blog-agent/drafts/<slug>/', () => {
    const f = setup();
    addProjectWithOrigin(f, 'test.01', 'https://github.com/x/y');
    const fm = [
      'title: T',
      'description: d',
      'date: "2026-04-01"',
      'tags:',
      '  - t',
      'published: false',
      'project: test.01',
    ].join('\n');
    seedDraft(f, 'scoped', fm, 'body\n', 'test.01');

    // Snapshot the sibling dirs under tempDir.
    const siblingSlugs = ['other-slug'];
    for (const s of siblingSlugs) {
      mkdirSync(join(f.draftsDir, s), { recursive: true });
      writeFileSync(join(f.draftsDir, s, 'index.mdx'), 'untouched\n');
    }
    const beforeMtimes = siblingSlugs.map((s) => ({
      slug: s,
      mtimeMs: statSync(join(f.draftsDir, s, 'index.mdx')).mtimeMs,
    }));

    captureLogs();
    runDraftRegenerateFrontmatter('scoped', f.paths);

    // Sibling files untouched.
    for (const snapshot of beforeMtimes) {
      const now = statSync(join(f.draftsDir, snapshot.slug, 'index.mdx')).mtimeMs;
      expect(now).toBe(snapshot.mtimeMs);
      expect(readFileSync(join(f.draftsDir, snapshot.slug, 'index.mdx'), 'utf-8')).toBe('untouched\n');
    }
  });

  it('rejects invalid slugs at the CLI boundary', () => {
    const f = setup();
    const { errors } = captureLogs();
    runDraftRegenerateFrontmatter('../escape', f.paths);
    expect(process.exitCode).toBe(1);
    expect(errors.length).toBeGreaterThan(0);
  });
});
