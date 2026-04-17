import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { parseFrontmatter, serializeFrontmatter, PostFrontmatter } from '../src/core/draft/frontmatter.js';

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'frontmatter-phase7',
);

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, `${name}.mdx`), 'utf-8');
}

// Phase 7 PostFrontmatter contract test. The three new optional fields
// (`unpublished_at`, `updated_at`, `update_count`) must round-trip
// through serialize → parse without loss so m0lz.00's frontmatter
// ingestion pipeline receives exactly what the agent wrote. This is the
// in-repo artifact satisfying contract criterion #21 — "site accepts
// these fields" — without requiring a cross-repo integration test.

const BASELINE: PostFrontmatter = {
  title: 'Sample',
  description: 'desc',
  date: '2026-04-17',
  tags: ['typescript'],
  published: true,
};

describe('PostFrontmatter — Phase 7 fields round-trip', () => {
  it('serialize + parse preserves unpublished_at', () => {
    const fm: PostFrontmatter = { ...BASELINE, unpublished_at: '2026-04-17T12:00:00Z' };
    const mdx = serializeFrontmatter(fm) + '\n\nBody.\n';
    const parsed = parseFrontmatter(mdx);
    expect(parsed.unpublished_at).toBe('2026-04-17T12:00:00Z');
  });

  it('serialize + parse preserves updated_at', () => {
    const fm: PostFrontmatter = { ...BASELINE, updated_at: '2026-04-17T18:30:00Z' };
    const mdx = serializeFrontmatter(fm) + '\n\nBody.\n';
    const parsed = parseFrontmatter(mdx);
    expect(parsed.updated_at).toBe('2026-04-17T18:30:00Z');
  });

  it('serialize + parse preserves update_count as a number', () => {
    const fm: PostFrontmatter = { ...BASELINE, update_count: 3 };
    const mdx = serializeFrontmatter(fm) + '\n\nBody.\n';
    const parsed = parseFrontmatter(mdx);
    expect(parsed.update_count).toBe(3);
    expect(typeof parsed.update_count).toBe('number');
  });

  it('emits all three fields together when all three are set', () => {
    const fm: PostFrontmatter = {
      ...BASELINE,
      unpublished_at: '2026-04-17T12:00:00Z',
      updated_at: '2026-04-17T18:30:00Z',
      update_count: 2,
    };
    const mdx = serializeFrontmatter(fm);
    expect(mdx).toMatch(/unpublished_at:/);
    expect(mdx).toMatch(/updated_at:/);
    expect(mdx).toMatch(/update_count: 2/);
  });

  it('omits the fields when unset (legacy post compatibility)', () => {
    const mdx = serializeFrontmatter(BASELINE);
    expect(mdx).not.toMatch(/unpublished_at:/);
    expect(mdx).not.toMatch(/updated_at:/);
    expect(mdx).not.toMatch(/update_count:/);
  });

  it('parses a legacy frontmatter block (no Phase 7 fields) with the new fields all undefined', () => {
    const legacyMdx = `---
title: "Legacy"
description: "Old post"
date: "2025-01-15"
tags:
  - typescript
published: true
canonical: "https://m0lz.dev/writing/legacy"
---

Body paragraph.
`;
    const parsed = parseFrontmatter(legacyMdx);
    expect(parsed.title).toBe('Legacy');
    expect(parsed.unpublished_at).toBeUndefined();
    expect(parsed.updated_at).toBeUndefined();
    expect(parsed.update_count).toBeUndefined();
  });

  it('parses a Phase 7 frontmatter block written by m0lz.00 ingestion pipeline', () => {
    // Shape the site parser will see after `blog update publish` + `blog unpublish`.
    // If this test breaks, the site repo's frontmatter schema accepted
    // fields the agent no longer emits OR vice versa — drift alert.
    const phase7Mdx = `---
title: "Phase 7 Post"
description: "Re-ran benchmarks"
date: "2026-04-17"
tags:
  - benchmark
published: false
canonical: "https://m0lz.dev/writing/p7"
medium_url: "https://medium.com/@x/p7"
devto_url: "https://dev.to/u/p7"
unpublished_at: "2026-04-17T12:00:00Z"
updated_at: "2026-04-17T11:59:00Z"
update_count: 4
---

Body.
`;
    const parsed = parseFrontmatter(phase7Mdx);
    expect(parsed.published).toBe(false);
    expect(parsed.medium_url).toBe('https://medium.com/@x/p7');
    expect(parsed.devto_url).toBe('https://dev.to/u/p7');
    expect(parsed.unpublished_at).toBe('2026-04-17T12:00:00Z');
    expect(parsed.updated_at).toBe('2026-04-17T11:59:00Z');
    expect(parsed.update_count).toBe(4);
  });

  // -----------------------------------------------------------------
  // Cross-repo fixture suite — every file in fixtures/frontmatter-phase7
  // is a shape m0lz.00's parser must accept. These tests are the
  // PRODUCER side of the contract; the consumer side (m0lz.00) should
  // mirror them against its own parser.
  // -----------------------------------------------------------------

  it('fixture: legacy — parses cleanly; all Phase 7 fields undefined', () => {
    const parsed = parseFrontmatter(loadFixture('legacy'));
    expect(parsed.title).toBe('Legacy Post');
    expect(parsed.published).toBe(true);
    expect(parsed.unpublished_at).toBeUndefined();
    expect(parsed.updated_at).toBeUndefined();
    expect(parsed.update_count).toBeUndefined();
  });

  it('fixture: initial-published — Phase 7 fields all undefined on first publish', () => {
    const parsed = parseFrontmatter(loadFixture('initial-published'));
    expect(parsed.title).toBe('Initial Publish');
    expect(parsed.published).toBe(true);
    expect(parsed.companion_repo).toBe('https://github.com/jmolz/initial-publish');
    expect(parsed.unpublished_at).toBeUndefined();
    expect(parsed.updated_at).toBeUndefined();
    expect(parsed.update_count).toBeUndefined();
  });

  it('fixture: updated-once — updated_at + update_count=1, no unpublished_at', () => {
    const parsed = parseFrontmatter(loadFixture('updated-once'));
    expect(parsed.published).toBe(true);
    expect(parsed.updated_at).toBe('2026-04-17T18:30:00Z');
    expect(parsed.update_count).toBe(1);
    expect(parsed.unpublished_at).toBeUndefined();
  });

  it('fixture: updated-twice — update_count=2 preserved across cycles', () => {
    const parsed = parseFrontmatter(loadFixture('updated-twice'));
    expect(parsed.update_count).toBe(2);
    expect(parsed.updated_at).toBe('2026-04-17T19:45:00Z');
  });

  it('fixture: unpublished — published=false + unpublished_at, no update fields', () => {
    const parsed = parseFrontmatter(loadFixture('unpublished'));
    expect(parsed.published).toBe(false);
    expect(parsed.unpublished_at).toBe('2026-04-17T14:00:00Z');
    expect(parsed.updated_at).toBeUndefined();
    expect(parsed.update_count).toBeUndefined();
  });

  it('fixture: updated-then-unpublished — ALL Phase 7 fields set (most contentious shape)', () => {
    const parsed = parseFrontmatter(loadFixture('updated-then-unpublished'));
    expect(parsed.published).toBe(false);
    expect(parsed.unpublished_at).toBe('2026-04-17T15:30:00Z');
    expect(parsed.updated_at).toBe('2026-02-14T12:00:00Z');
    expect(parsed.update_count).toBe(3);
    // Platform URLs preserved even after unpublish.
    expect(parsed.medium_url).toBe('https://medium.com/@jmolz/updated-then-unpublished-pqr');
    expect(parsed.devto_url).toBe('https://dev.to/jmolz/updated-then-unpublished-pqr');
  });

  it('tolerates update_count written as a string (YAML ambiguity resilience)', () => {
    const mdx = `---
title: "Quoted Count"
description: "x"
date: "2026-04-17"
tags:
  - x
published: true
update_count: "5"
---

Body.
`;
    const parsed = parseFrontmatter(mdx);
    expect(parsed.update_count).toBe(5);
  });
});
