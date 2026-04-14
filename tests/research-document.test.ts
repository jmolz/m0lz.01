import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ResearchDocument,
  REQUIRED_SECTIONS,
  writeResearchDocument,
  readResearchDocument,
  validateResearchDocument,
  documentPath,
} from '../src/core/research/document.js';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function makeDoc(overrides: Partial<ResearchDocument> = {}): ResearchDocument {
  return {
    slug: 'sample-slug',
    topic: 'sample topic',
    mode: 'directed',
    content_type: 'technical-deep-dive',
    created_at: '2026-04-14T12:00:00.000Z',
    thesis: 'Thesis body.',
    findings: '- Finding 1\n- Finding 2',
    sources_list: '- https://example.com',
    data_points: '- 42ms p95',
    open_questions: '- What about X?',
    benchmark_targets: '- Claim A: test it this way',
    repo_scope: 'Scaffold a Rust crate with two modules.',
    ...overrides,
  };
}

describe('writeResearchDocument', () => {
  it('writes a file with all 7 H2 sections present', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'research-doc-'));
    const doc = makeDoc();
    const path = writeResearchDocument(tempDir, doc);
    const content = readFileSync(path, 'utf-8');

    for (const heading of REQUIRED_SECTIONS) {
      expect(content).toContain(`## ${heading}`);
    }
    expect(content).toContain('slug: sample-slug');
    expect(content).toContain('mode: directed');
  });

  it('refuses to overwrite without force', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'research-doc-'));
    const doc = makeDoc();
    writeResearchDocument(tempDir, doc);

    expect(() => writeResearchDocument(tempDir!, doc)).toThrow(/already exists/);
  });

  it('overwrites when force is true', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'research-doc-'));
    const doc = makeDoc();
    writeResearchDocument(tempDir, doc);

    const updated = makeDoc({ thesis: 'Different thesis.' });
    const path = writeResearchDocument(tempDir, updated, { force: true });
    const content = readFileSync(path, 'utf-8');

    expect(content).toContain('Different thesis.');
  });
});

describe('readResearchDocument', () => {
  it('round-trips a fully populated doc', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'research-doc-'));
    const doc = makeDoc();
    const path = writeResearchDocument(tempDir, doc);
    const loaded = readResearchDocument(path);

    expect(loaded).toEqual(doc);
  });

  it('throws on missing file', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'research-doc-'));
    const missing = join(tempDir, 'missing.md');
    expect(() => readResearchDocument(missing)).toThrow(/not found/);
  });
});

describe('validateResearchDocument', () => {
  it('returns ok when every section has content', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'research-doc-'));
    const doc = makeDoc();
    const path = writeResearchDocument(tempDir, doc);

    const result = validateResearchDocument(path);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.empty).toEqual([]);
  });

  it('reports removed sections', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'research-doc-'));
    const doc = makeDoc();
    const path = writeResearchDocument(tempDir, doc);

    // Remove "Benchmark Targets" heading + body
    const raw = readFileSync(path, 'utf-8');
    const stripped = raw.replace(/## Benchmark Targets\n\n.*?\n\n/s, '');
    writeFileSync(path, stripped, 'utf-8');

    const result = validateResearchDocument(path);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('Benchmark Targets');
  });

  it('reports empty-body sections separately from missing ones', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'research-doc-'));
    const doc = makeDoc({ data_points: '{{data_points}}' });
    const path = writeResearchDocument(tempDir, doc);

    const result = validateResearchDocument(path);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.empty).toContain('Data Points');
  });

  it('treats whitespace-only body as empty', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'research-doc-'));
    const doc = makeDoc();
    const path = writeResearchDocument(tempDir, doc);

    const raw = readFileSync(path, 'utf-8');
    const blanked = raw.replace(/## Open Questions\n\n- What about X\?/, '## Open Questions\n\n   ');
    writeFileSync(path, blanked, 'utf-8');

    const result = validateResearchDocument(path);
    expect(result.empty).toContain('Open Questions');
  });

  it('throws on malformed frontmatter', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'research-doc-'));
    const path = join(tempDir, 'bad.md');
    writeFileSync(path, 'no frontmatter here', 'utf-8');
    expect(() => validateResearchDocument(path)).toThrow(/frontmatter/);
  });
});

describe('documentPath', () => {
  it('joins researchDir with slug.md', () => {
    expect(documentPath('/tmp/r', 'my-slug')).toBe('/tmp/r/my-slug.md');
  });
});
