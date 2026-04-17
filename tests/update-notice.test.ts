import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { appendUpdateNotice, countUpdateNotices } from '../src/core/update/notice.js';
import { BlogConfig } from '../src/core/config/types.js';

let tempDir: string;
let mdxPath: string;
const template = 'Updated {DATE}: {SUMMARY}';

function mkConfig(overrides: Partial<BlogConfig['updates']> = {}): BlogConfig {
  return {
    site: { repo_path: '/tmp', base_url: 'https://x', content_dir: 'content/posts', research_dir: 'content/research' },
    author: { name: 'T', github: 't' },
    ai: { primary: 'c', reviewers: { structural: 'c', adversarial: 'c', methodology: 'c' }, codex: { adversarial_effort: 'high', methodology_effort: 'xhigh' } },
    content_types: {
      'project-launch': { benchmark: 'optional', companion_repo: 'existing', social_prefix: 'Show HN:' },
      'technical-deep-dive': { benchmark: 'required', companion_repo: 'new', social_prefix: '' },
      'analysis-opinion': { benchmark: 'skip', companion_repo: 'optional', social_prefix: '' },
    },
    benchmark: { capture_environment: true, methodology_template: true, preserve_raw_data: true, multiple_runs: 3 },
    publish: { devto: true, medium: true, substack: true, github_repos: true, social_drafts: true, research_pages: true },
    social: { platforms: [], timing_recommendations: true },
    evaluation: { require_pass: true, min_sources: 3, max_reading_level: 12, three_reviewer_panel: true, consensus_must_fix: true, majority_should_fix: true, single_advisory: true, verify_benchmark_claims: true, methodology_completeness: true },
    updates: {
      preserve_original_data: true,
      update_notice: true,
      update_crosspost: true,
      devto_update: true,
      refresh_paste_files: true,
      notice_template: template,
      require_summary: true,
      site_update_mode: 'pr',
      ...overrides,
    },
    unpublish: { devto: true, medium: true, substack: true, readme: true },
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'update-notice-'));
  mdxPath = join(tempDir, 'index.mdx');
});
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('appendUpdateNotice — first append', () => {
  it('appends a block when no prior blocks exist', () => {
    writeFileSync(mdxPath, '---\ntitle: x\n---\n\nBody paragraph.\n');
    const result = appendUpdateNotice(mdxPath, 1, '2026-04-17', 'Summary A', mkConfig());
    expect(result.action).toBe('appended');
    expect(result.blockCount).toBe(1);

    const after = readFileSync(mdxPath, 'utf-8');
    expect(after).toContain('<!-- update-notice cycle=1 date=2026-04-17 -->');
    expect(after).toContain('Updated 2026-04-17: Summary A');
    expect(after).toContain('<!-- /update-notice -->');
    expect(countUpdateNotices(after)).toBe(1);
  });

  it('preserves the original body', () => {
    writeFileSync(mdxPath, '---\ntitle: x\n---\n\nOriginal body line.\n');
    appendUpdateNotice(mdxPath, 1, '2026-04-17', 'Sum', mkConfig());
    const after = readFileSync(mdxPath, 'utf-8');
    expect(after).toContain('Original body line.');
  });
});

describe('appendUpdateNotice — same-cycle replacement', () => {
  it('replaces body when re-run within the same cycle on the same date', () => {
    writeFileSync(mdxPath, 'Body.\n');
    appendUpdateNotice(mdxPath, 1, '2026-04-17', 'First body', mkConfig());
    const result = appendUpdateNotice(mdxPath, 1, '2026-04-17', 'Second body', mkConfig());
    expect(result.action).toBe('replaced');
    expect(result.blockCount).toBe(1);

    const after = readFileSync(mdxPath, 'utf-8');
    expect(after).toContain('Updated 2026-04-17: Second body');
    expect(after).not.toContain('Updated 2026-04-17: First body');
    expect(countUpdateNotices(after)).toBe(1);
  });

  it('replaces when date changes within the same cycle (midnight crossing)', () => {
    writeFileSync(mdxPath, 'Body.\n');
    appendUpdateNotice(mdxPath, 3, '2026-04-17', 'Sum A', mkConfig());
    const result = appendUpdateNotice(mdxPath, 3, '2026-04-18', 'Sum B', mkConfig());
    expect(result.action).toBe('replaced');
    expect(result.blockCount).toBe(1);

    const after = readFileSync(mdxPath, 'utf-8');
    expect(after).toContain('cycle=3 date=2026-04-18');
    expect(after).not.toContain('cycle=3 date=2026-04-17');
    expect(after).toContain('Sum B');
    expect(after).not.toContain('Sum A');
  });
});

describe('appendUpdateNotice — multi-cycle preservation', () => {
  it('appends when cycle differs, preserving historical notices', () => {
    writeFileSync(mdxPath, 'Body.\n');
    appendUpdateNotice(mdxPath, 1, '2026-01-01', 'Cycle 1', mkConfig());
    appendUpdateNotice(mdxPath, 2, '2026-02-02', 'Cycle 2', mkConfig());
    const result = appendUpdateNotice(mdxPath, 3, '2026-03-03', 'Cycle 3', mkConfig());
    expect(result.action).toBe('appended');
    expect(result.blockCount).toBe(3);

    const after = readFileSync(mdxPath, 'utf-8');
    expect(after).toContain('Cycle 1');
    expect(after).toContain('Cycle 2');
    expect(after).toContain('Cycle 3');
    expect(countUpdateNotices(after)).toBe(3);

    // Ordering: cycle 1 appears before cycle 2 appears before cycle 3
    const i1 = after.indexOf('cycle=1');
    const i2 = after.indexOf('cycle=2');
    const i3 = after.indexOf('cycle=3');
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
  });

  it('replaces only the matching-cycle block when interleaved with others', () => {
    writeFileSync(mdxPath, 'Body.\n');
    appendUpdateNotice(mdxPath, 1, '2026-01-01', 'C1 original', mkConfig());
    appendUpdateNotice(mdxPath, 2, '2026-02-02', 'C2 original', mkConfig());
    appendUpdateNotice(mdxPath, 1, '2026-01-01', 'C1 updated', mkConfig());

    const after = readFileSync(mdxPath, 'utf-8');
    expect(after).toContain('C1 updated');
    expect(after).not.toContain('C1 original');
    expect(after).toContain('C2 original');
    expect(countUpdateNotices(after)).toBe(2);
  });
});

describe('appendUpdateNotice — atomicity', () => {
  it('does not leave a .tmp file behind on success', () => {
    writeFileSync(mdxPath, 'Body.\n');
    appendUpdateNotice(mdxPath, 1, '2026-04-17', 'Sum', mkConfig());
    const files = readdirSync(tempDir);
    const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);
  });
});

describe('appendUpdateNotice — input validation', () => {
  it('throws on malformed date', () => {
    writeFileSync(mdxPath, 'Body.\n');
    expect(() =>
      appendUpdateNotice(mdxPath, 1, '2026/04/17', 's', mkConfig()),
    ).toThrow(/YYYY-MM-DD/);
  });

  it('throws on non-positive cycle id', () => {
    writeFileSync(mdxPath, 'Body.\n');
    expect(() =>
      appendUpdateNotice(mdxPath, 0, '2026-04-17', 's', mkConfig()),
    ).toThrow(/positive integer/);
  });

  it('renders (no summary) when summary is null', () => {
    writeFileSync(mdxPath, 'Body.\n');
    appendUpdateNotice(mdxPath, 1, '2026-04-17', null, mkConfig());
    const after = readFileSync(mdxPath, 'utf-8');
    expect(after).toContain('Updated 2026-04-17: (no summary)');
  });

  it('honors custom notice_template from config', () => {
    writeFileSync(mdxPath, 'Body.\n');
    appendUpdateNotice(mdxPath, 1, '2026-04-17', 'why', mkConfig({ notice_template: '[{DATE}] {SUMMARY}' }));
    const after = readFileSync(mdxPath, 'utf-8');
    expect(after).toContain('[2026-04-17] why');
  });
});

describe('countUpdateNotices', () => {
  it('counts zero on plain MDX', () => {
    expect(countUpdateNotices('just a body')).toBe(0);
  });

  it('counts blocks it finds', () => {
    const s =
      'body\n\n' +
      '<!-- update-notice cycle=1 date=2026-01-01 -->\nA\n<!-- /update-notice -->\n\n' +
      '<!-- update-notice cycle=2 date=2026-02-02 -->\nB\n<!-- /update-notice -->\n';
    expect(countUpdateNotices(s)).toBe(2);
  });
});
