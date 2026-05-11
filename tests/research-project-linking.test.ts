import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getDatabase, closeDatabase } from '../src/core/db/database.js';
import { runResearchInit } from '../src/cli/research.js';
import {
  extractProjectIdFromPrompt,
  detectContentType,
} from '../src/core/draft/content-types.js';
import { initResearchPost } from '../src/core/research/state.js';

interface Fixture {
  tempDir: string;
  dbPath: string;
  researchDir: string;
  configPath: string;
}

let fixture: Fixture | undefined;

function setupFixture(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'research-linking-'));
  const dbPath = join(tempDir, 'state.db');
  const researchDir = join(tempDir, 'research');
  const configPath = join(tempDir, '.blogrc.yaml');
  mkdirSync(researchDir, { recursive: true });

  const db = getDatabase(dbPath);
  closeDatabase(db);

  writeFileSync(configPath, `
site:
  repo_path: "./site"
  base_url: "https://example.dev"
  content_dir: "content/posts"
author:
  name: "Tester"
  github: "tester"
`);

  fixture = { tempDir, dbPath, researchDir, configPath };
  return fixture;
}

afterEach(() => {
  if (fixture) {
    rmSync(fixture.tempDir, { recursive: true, force: true });
    fixture = undefined;
  }
  process.exitCode = 0;
  vi.restoreAllMocks();
});

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

describe('extractProjectIdFromPrompt', () => {
  it('extracts a catalog-style ID from prose', () => {
    expect(extractProjectIdFromPrompt('Launch post for new npm package m0lz.01 — Show HN target'))
      .toBe('m0lz.01');
  });

  it('lowercases matches (case-insensitive)', () => {
    expect(extractProjectIdFromPrompt('Shipping Project.42 next week')).toBe('project.42');
  });

  it('matches generic non-m0lz identifiers', () => {
    expect(extractProjectIdFromPrompt('ship repo.7 with new harness')).toBe('repo.7');
  });

  it('returns null when no catalog-style ID is present', () => {
    expect(extractProjectIdFromPrompt('generic opinion post')).toBeNull();
  });

  it('returns null for bare decimals or dotted IDs without leading alpha', () => {
    expect(extractProjectIdFromPrompt('version 3.14 shipped')).toBeNull();
    expect(extractProjectIdFromPrompt('2.0 release announcement')).toBeNull();
  });

  it('returns the first match when multiple IDs appear', () => {
    expect(extractProjectIdFromPrompt('migrate m0lz.01 → m0lz.02')).toBe('m0lz.01');
  });
});

describe('initResearchPost with projectId', () => {
  it('stores project_id when provided', () => {
    const db = getDatabase(':memory:');
    try {
      const result = initResearchPost(
        db, 'alpha', 'topic about test.01', 'directed',
        'project-launch', 'test.01',
      );
      expect(result.post.project_id).toBe('test.01');
    } finally {
      closeDatabase(db);
    }
  });

  it('keeps project_id null when omitted for non-project-launch types', () => {
    const db = getDatabase(':memory:');
    try {
      const result = initResearchPost(
        db, 'beta', 'analysis post', 'exploratory',
        'analysis-opinion',
      );
      expect(result.post.project_id).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  it('throws PROJECT_UNLINKED for project-launch without a project ID', () => {
    const db = getDatabase(':memory:');
    try {
      expect(() => initResearchPost(
        db, 'gamma', 'generic topic', 'directed',
        'project-launch',
      )).toThrow(/\[AGENT_ERROR\] PROJECT_UNLINKED/);

      // Also rejects empty string (not just undefined).
      expect(() => initResearchPost(
        db, 'delta', 'topic', 'directed',
        'project-launch', '',
      )).toThrow(/PROJECT_UNLINKED/);

      // Also rejects explicit null.
      expect(() => initResearchPost(
        db, 'epsilon', 'topic', 'directed',
        'project-launch', null,
      )).toThrow(/PROJECT_UNLINKED/);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('runResearchInit project resolution', () => {
  it('uses --project flag when provided', () => {
    const f = setupFixture();
    captureLogs();
    runResearchInit('alpha', {
      topic: 'topic without identifier',
      mode: 'directed',
      contentType: 'project-launch',
      projectId: 'test.01',
    }, { dbPath: f.dbPath, researchDir: f.researchDir });

    const db = getDatabase(f.dbPath);
    try {
      const post = db.prepare('SELECT project_id, content_type FROM posts WHERE slug = ?').get('alpha') as {
        project_id: string | null;
        content_type: string | null;
      };
      expect(post.project_id).toBe('test.01');
      expect(post.content_type).toBe('project-launch');
    } finally {
      closeDatabase(db);
    }
    expect(process.exitCode).not.toBe(1);
  });

  it('falls back to prompt regex when --project is omitted', () => {
    const f = setupFixture();
    captureLogs();
    runResearchInit('beta', {
      topic: 'shipping m0lz.01 to npm',
      mode: 'directed',
    }, { dbPath: f.dbPath, researchDir: f.researchDir });

    const db = getDatabase(f.dbPath);
    try {
      const post = db.prepare('SELECT project_id, content_type FROM posts WHERE slug = ?').get('beta') as {
        project_id: string | null;
        content_type: string | null;
      };
      expect(post.project_id).toBe('m0lz.01');
      // The CATALOG_PATTERN in detectContentType only matches m0lz.N — and
      // m0lz.01 matches, so auto-classifies as project-launch.
      expect(post.content_type).toBe('project-launch');
    } finally {
      closeDatabase(db);
    }
    expect(process.exitCode).not.toBe(1);
  });

  it('refuses project-launch without a resolvable project ID and emits PROJECT_UNLINKED', () => {
    const f = setupFixture();
    const { errors } = captureLogs();
    runResearchInit('gamma', {
      topic: 'generic opinion post',
      mode: 'directed',
      contentType: 'project-launch',
    }, { dbPath: f.dbPath, researchDir: f.researchDir });

    expect(process.exitCode).toBe(1);
    const combined = errors.join('\n');
    expect(combined).toContain('PROJECT_UNLINKED');
    expect(combined).toMatch(/--project|projects:/);

    // No row was inserted.
    const db = getDatabase(f.dbPath);
    try {
      const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get('gamma');
      expect(post).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  it('allows non-project-launch posts without a project ID', () => {
    const f = setupFixture();
    captureLogs();
    runResearchInit('delta', {
      topic: 'analysis of X',
      mode: 'directed',
      contentType: 'analysis-opinion',
    }, { dbPath: f.dbPath, researchDir: f.researchDir });

    const db = getDatabase(f.dbPath);
    try {
      const post = db.prepare('SELECT project_id, content_type FROM posts WHERE slug = ?').get('delta') as {
        project_id: string | null;
        content_type: string | null;
      };
      expect(post.project_id).toBeNull();
      expect(post.content_type).toBe('analysis-opinion');
    } finally {
      closeDatabase(db);
    }
  });
});

describe('detectContentType + extractProjectIdFromPrompt interaction', () => {
  it('m0lz.N IDs auto-classify as project-launch via detectContentType', () => {
    const projectId = extractProjectIdFromPrompt('ship m0lz.42 soon');
    expect(projectId).toBe('m0lz.42');
    expect(detectContentType('ship m0lz.42 soon', projectId ?? undefined))
      .toBe('project-launch');
  });

  it('generic catalog IDs do NOT trigger project-launch auto-classification', () => {
    const projectId = extractProjectIdFromPrompt('benchmark repo.7 vs repo.8');
    expect(projectId).toBe('repo.7');
    // Falls through to keyword routing — "benchmark" keyword matches.
    expect(detectContentType('benchmark repo.7 vs repo.8', projectId ?? undefined))
      .toBe('technical-deep-dive');
  });
});
