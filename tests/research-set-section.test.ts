import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';
import {
  getDatabase,
  closeDatabase,
} from '../src/core/db/database.js';
import {
  SECTION_KEYS,
  setResearchSection,
  readResearchDocument,
  writeResearchDocument,
  validateResearchDocument,
} from '../src/core/research/document.js';
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
import { runResearchSetSection } from '../src/cli/research.ts';

// `blog research set-section` exists because the /blog skill cannot Write
// files directly (allowed-tools: Bash(blog:*) Read Grep Glob — no Write/Edit
// by design, structural safety boundary). Without this CLI surface, the
// skill would be forced to push research-doc authoring onto the operator
// as a manual-edit workaround. These tests lock in the two-gate finalize
// contract: DB sources + doc sections are INDEPENDENTLY validated, and
// set-section is the only CLI path the skill uses to satisfy the
// sections half.

let tempDir: string;
let db: Database.Database;
let researchDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'set-section-'));
  dbPath = join(tempDir, 'state.db');
  researchDir = join(tempDir, 'research');
  mkdirSync(researchDir, { recursive: true });
  db = getDatabase(dbPath);
});

afterEach(() => {
  if (db) closeDatabase(db);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function seedDocAndPost(slug: string): void {
  initResearchPost(db, slug, `topic for ${slug}`, 'directed', 'project-launch');
  writeResearchDocument(researchDir, {
    slug,
    topic: `topic for ${slug}`,
    mode: 'directed',
    content_type: 'project-launch',
    created_at: '2026-04-20T00:00:00.000Z',
    thesis: '{{thesis}}',
    findings: '{{findings}}',
    sources_list: '{{sources_list}}',
    data_points: '{{data_points}}',
    open_questions: '{{open_questions}}',
    benchmark_targets: '{{benchmark_targets}}',
    repo_scope: '{{repo_scope}}',
  });
}

describe('setResearchSection (library)', () => {
  it('replaces one section and preserves all others', () => {
    seedDocAndPost('alpha');
    setResearchSection(researchDir, 'alpha', 'thesis', 'The real thesis.');

    const doc = readResearchDocument(join(researchDir, 'alpha.md'));
    expect(doc.thesis).toBe('The real thesis.');
    // Other sections retain placeholder content.
    expect(doc.findings).toBe('{{findings}}');
    expect(doc.sources_list).toBe('{{sources_list}}');
  });

  it('populating all 7 sections makes validateResearchDocument pass', () => {
    seedDocAndPost('beta');
    for (const key of SECTION_KEYS) {
      setResearchSection(researchDir, 'beta', key, `Real content for ${key}.`);
    }
    const result = validateResearchDocument(join(researchDir, 'beta.md'));
    expect(result.ok).toBe(true);
    expect(result.empty).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('rejects invalid section name', () => {
    seedDocAndPost('gamma');
    expect(() =>
      setResearchSection(researchDir, 'gamma', 'bogus' as never, 'content'),
    ).toThrow(/Invalid section/);
  });

  it('rejects path-traversal slug', () => {
    expect(() =>
      setResearchSection(researchDir, '../outside', 'thesis', 'x'),
    ).toThrow(/Invalid slug/);
  });

  it('throws descriptive error if doc not initialized', () => {
    initResearchPost(db, 'delta', 'topic', 'directed', 'project-launch');
    // Post row exists but the doc file was never written.
    expect(() =>
      setResearchSection(researchDir, 'delta', 'thesis', 'x'),
    ).toThrow(/not found|blog research init/);
  });

  it('overwrites an already-populated section (not append)', () => {
    seedDocAndPost('epsilon');
    setResearchSection(researchDir, 'epsilon', 'thesis', 'First take.');
    setResearchSection(researchDir, 'epsilon', 'thesis', 'Revised take.');
    const doc = readResearchDocument(join(researchDir, 'epsilon.md'));
    expect(doc.thesis).toBe('Revised take.');
  });
});

describe('runResearchSetSection (CLI handler)', () => {
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

  it('writes content from --content inline', () => {
    seedDocAndPost('zeta');
    closeDatabase(db);
    db = undefined as unknown as Database.Database;

    const { logs } = captureLogs();
    runResearchSetSection(
      'zeta',
      { section: 'thesis', content: 'Inline thesis.' },
      { dbPath, researchDir },
    );
    expect(logs.some((l) => l.includes("Updated 'thesis'"))).toBe(true);

    const doc = readResearchDocument(join(researchDir, 'zeta.md'));
    expect(doc.thesis).toBe('Inline thesis.');
  });

  it('writes content from --from-file', () => {
    seedDocAndPost('eta');
    closeDatabase(db);
    db = undefined as unknown as Database.Database;

    const contentFile = join(tempDir, 'thesis.md');
    writeFileSync(contentFile, 'File-sourced thesis.\n\nWith multi paragraph.');

    captureLogs();
    runResearchSetSection(
      'eta',
      { section: 'thesis', fromFile: contentFile },
      { dbPath, researchDir },
    );

    const doc = readResearchDocument(join(researchDir, 'eta.md'));
    expect(doc.thesis).toBe('File-sourced thesis.\n\nWith multi paragraph.');
  });

  it('rejects passing both --content and --from-file', () => {
    seedDocAndPost('theta');
    closeDatabase(db);
    db = undefined as unknown as Database.Database;

    const { errors } = captureLogs();
    const savedExitCode = process.exitCode;
    try {
      runResearchSetSection(
        'theta',
        { section: 'thesis', content: 'x', fromFile: '/tmp/x' },
        { dbPath, researchDir },
      );
      expect(process.exitCode).toBe(1);
      expect(errors.some((e) => e.includes('exactly one'))).toBe(true);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('rejects empty content (finalize would reject it)', () => {
    seedDocAndPost('iota');
    closeDatabase(db);
    db = undefined as unknown as Database.Database;

    const { errors } = captureLogs();
    const savedExitCode = process.exitCode;
    try {
      runResearchSetSection(
        'iota',
        { section: 'thesis', content: '   \n  ' },
        { dbPath, researchDir },
      );
      expect(process.exitCode).toBe(1);
      expect(errors.some((e) => e.includes('empty'))).toBe(true);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('rejects non-research phase posts', () => {
    seedDocAndPost('kappa');
    advancePhase(db, 'kappa', 'draft');
    closeDatabase(db);
    db = undefined as unknown as Database.Database;

    const { errors } = captureLogs();
    const savedExitCode = process.exitCode;
    try {
      runResearchSetSection(
        'kappa',
        { section: 'thesis', content: 'x' },
        { dbPath, researchDir },
      );
      expect(process.exitCode).toBe(1);
      expect(errors.some((e) => /phase|research/i.test(e))).toBe(true);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('rejects missing --from-file target', () => {
    seedDocAndPost('lambda');
    closeDatabase(db);
    db = undefined as unknown as Database.Database;

    const { errors } = captureLogs();
    const savedExitCode = process.exitCode;
    try {
      runResearchSetSection(
        'lambda',
        { section: 'thesis', fromFile: '/does/not/exist.md' },
        { dbPath, researchDir },
      );
      expect(process.exitCode).toBe(1);
      expect(errors.some((e) => e.includes('File not found'))).toBe(true);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('rejects path-traversal slug at CLI boundary', () => {
    const { errors } = captureLogs();
    const savedExitCode = process.exitCode;
    try {
      runResearchSetSection(
        '../escape',
        { section: 'thesis', content: 'x' },
        { dbPath, researchDir },
      );
      expect(process.exitCode).toBe(1);
      expect(errors.some((e) => /Invalid slug/i.test(e))).toBe(true);
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});
