import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

import { closeDatabase, getDatabase } from '../src/core/db/database.js';
import { initResearchPost, advancePhase } from '../src/core/research/state.js';
import {
  containsEmoji,
  generateLinkedIn,
  generateHackerNews,
  generateSocialText,
} from '../src/core/publish/social.js';
import { BlogConfig } from '../src/core/config/types.js';
import { PostRow } from '../src/core/db/types.js';

// Path to the real templates directory in the worktree — the templates are
// clean (no emojis), so tests that exercise emoji detection write local
// fixture templates into tempDir instead.
const WORKTREE_ROOT = join(__dirname, '..');
const REAL_TEMPLATES_DIR = join(WORKTREE_ROOT, 'templates');

function makeConfig(timing = true): BlogConfig {
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
    social: {
      platforms: ['linkedin', 'hackernews'],
      timing_recommendations: timing,
      distribution_kit: { enabled: true, persist_to_site: true, directory: 'distribution' },
      linkedin_image: {
        mode: 'local-card',
        model: 'gpt-image-2-2026-04-21',
        size: '1200x1200',
        quality: 'high',
      },
    },
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
  socialDir: string;
  draftsDir: string;
  templatesDir: string;
  db: Database.Database;
}

let fixture: Fixture | undefined;

function setup(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'publish-social-'));
  const socialDir = join(tempDir, 'social');
  const draftsDir = join(tempDir, 'drafts');
  mkdirSync(socialDir, { recursive: true });
  mkdirSync(draftsDir, { recursive: true });
  const db = getDatabase(':memory:');
  fixture = { tempDir, socialDir, draftsDir, templatesDir: REAL_TEMPLATES_DIR, db };
  return fixture;
}

afterEach(() => {
  if (fixture?.db) closeDatabase(fixture.db);
  if (fixture) rmSync(fixture.tempDir, { recursive: true, force: true });
  fixture = undefined;
});

// Seed a post row at publish phase and optionally attach a title/topic so
// generateLinkedIn/generateHackerNews have metadata to fill into the template.
function seedPost(
  db: Database.Database,
  slug: string,
  opts: {
    title?: string;
    topic?: string;
    contentType?: 'project-launch' | 'technical-deep-dive' | 'analysis-opinion';
  } = {},
): PostRow {
  const contentType = opts.contentType ?? 'technical-deep-dive';
  const projectId = contentType === 'project-launch' ? 'test.01' : null;
  initResearchPost(db, slug, opts.topic ?? 'some topic', 'directed', contentType, projectId);
  advancePhase(db, slug, 'benchmark');
  advancePhase(db, slug, 'draft');
  advancePhase(db, slug, 'evaluate');
  db.prepare('UPDATE posts SET title = ?, evaluation_passed = 1 WHERE slug = ?').run(
    opts.title ?? 'Default Title',
    slug,
  );
  advancePhase(db, slug, 'publish');
  return db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow;
}

// Create a fixture templates/social directory with custom content. Used for
// the emoji-in-template test paths; tests that need the real templates just
// point at REAL_TEMPLATES_DIR instead.
function writeLocalSocialTemplates(templatesDir: string, linkedin: string, hackernews: string): void {
  mkdirSync(join(templatesDir, 'social'), { recursive: true });
  writeFileSync(join(templatesDir, 'social', 'linkedin.md'), linkedin, 'utf-8');
  writeFileSync(join(templatesDir, 'social', 'hackernews.md'), hackernews, 'utf-8');
}

describe('containsEmoji', () => {
  it('returns false for plain ASCII text', () => {
    expect(containsEmoji('hello world')).toBe(false);
  });

  it('returns true for U+1F600 range (grinning face)', () => {
    // Unicode escape — no literal emoji characters in source.
    expect(containsEmoji(`hello ${'\u{1F600}'}`)).toBe(true);
  });

  it('returns true for U+2605 (black star) — covered by the 0x2600-0x27BF range', () => {
    expect(containsEmoji(`star ${'\u{2605}'}`)).toBe(true);
  });
});

describe('generateLinkedIn', () => {
  it('fills title, canonical URL, and hashtags from tags', () => {
    const f = setup();
    const post = seedPost(f.db, 'li-happy', { title: 'LinkedIn Post' });
    const outPath = generateLinkedIn(
      post, makeConfig(), f.socialDir, f.templatesDir, ['typescript', 'benchmark'],
    );
    const content = readFileSync(outPath, 'utf-8');
    const lines = content.trimEnd().split('\n');
    expect(lines[0]).toBe('LinkedIn Post');
    expect(lines[1]).toBe('');
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe('Read the full post: https://m0lz.dev/writing/li-happy');
    expect(content).toContain('https://m0lz.dev/writing/li-happy');
    expect(content).toContain('#typescript');
    expect(content).toContain('#benchmark');
    expect(content).not.toContain('Image prompt:');
    expect(content).not.toContain('Alt text:');
    expect(content).not.toContain('./distribution/');
    expect(content.length).toBeLessThanOrEqual(3000);
  });

  it('does not hard-clip long LinkedIn descriptions with ellipses', () => {
    const f = setup();
    const post = seedPost(f.db, 'li-natural-fit', {
      title: 'Natural Fit',
      topic: `${'A'.repeat(1800)} without a sentence boundary ${'B'.repeat(1800)}`,
    });
    const outPath = generateLinkedIn(post, makeConfig(false), f.socialDir, f.templatesDir, ['typescript']);
    const content = readFileSync(outPath, 'utf-8');
    expect(content).not.toMatch(/\.\.\.$/m);
    expect(content).toContain('Technical notes and evidence for Natural Fit.');
  });

  it('replaces already-clipped short LinkedIn descriptions with safe fallback copy', () => {
    const f = setup();
    const post = seedPost(f.db, 'li-preclipped', {
      title: 'Preclipped Copy',
      topic: 'Already clipped...',
    });
    const outPath = generateLinkedIn(post, makeConfig(false), f.socialDir, f.templatesDir, ['typescript']);
    const content = readFileSync(outPath, 'utf-8');

    expect(content).not.toContain('Already clipped...');
    expect(content).not.toMatch(/\.\.\.$/m);
    expect(content).toContain('Technical notes and evidence for Preclipped Copy.');
  });

  it('includes timing line when config.social.timing_recommendations=true', () => {
    const f = setup();
    const post = seedPost(f.db, 'li-timing');
    const outPath = generateLinkedIn(post, makeConfig(true), f.socialDir, f.templatesDir, ['a']);
    const content = readFileSync(outPath, 'utf-8');
    expect(content).toContain('Best posting times');
  });

  it('omits timing line when config.social.timing_recommendations=false', () => {
    const f = setup();
    const post = seedPost(f.db, 'li-notiming');
    const outPath = generateLinkedIn(post, makeConfig(false), f.socialDir, f.templatesDir, ['a']);
    const content = readFileSync(outPath, 'utf-8');
    expect(content).not.toContain('Best posting times');
  });

  it('throws when template expansion produces emoji characters', () => {
    const f = setup();
    // Use a local templates dir that seeds an emoji into the template.
    const localTemplates = join(f.tempDir, 'templates-emoji');
    writeLocalSocialTemplates(
      localTemplates,
      `${'\u{1F600}'} {{hook}}\n\n{{body}}\n\n{{canonical_url}}\n{{hashtags}}\n{{timing}}\n`,
      'Title: {{title}}\nURL: {{canonical_url}}\n',
    );
    const post = seedPost(f.db, 'li-emoji');
    expect(() =>
      generateLinkedIn(post, makeConfig(), f.socialDir, localTemplates, ['a']),
    ).toThrow(/contains emoji/);
  });
});

describe('generateHackerNews', () => {
  it('applies Show HN: prefix only for project-launch content type', () => {
    const f = setup();
    const post = seedPost(f.db, 'hn-launch', {
      title: 'Cool Project',
      contentType: 'project-launch',
    });
    const outPath = generateHackerNews(post, makeConfig(), f.socialDir, f.templatesDir, undefined);
    const content = readFileSync(outPath, 'utf-8');
    expect(content).toContain('Show HN: Cool Project');
  });

  it('does NOT add Show HN: prefix for technical-deep-dive', () => {
    const f = setup();
    const post = seedPost(f.db, 'hn-tdd', {
      title: 'Deep Dive',
      contentType: 'technical-deep-dive',
    });
    const outPath = generateHackerNews(post, makeConfig(), f.socialDir, f.templatesDir, undefined);
    const content = readFileSync(outPath, 'utf-8');
    expect(content).not.toContain('Show HN:');
    expect(content).toContain('Deep Dive');
  });

  it('does NOT add Show HN: prefix for analysis-opinion', () => {
    const f = setup();
    const post = seedPost(f.db, 'hn-op', {
      title: 'An Opinion',
      contentType: 'analysis-opinion',
    });
    const outPath = generateHackerNews(post, makeConfig(), f.socialDir, f.templatesDir, undefined);
    const content = readFileSync(outPath, 'utf-8');
    expect(content).not.toContain('Show HN:');
  });

  it('truncates title to 80 characters', () => {
    const f = setup();
    const longTitle = 'x'.repeat(100);
    const post = seedPost(f.db, 'hn-long', { title: longTitle });
    const outPath = generateHackerNews(post, makeConfig(), f.socialDir, f.templatesDir, undefined);
    const content = readFileSync(outPath, 'utf-8');
    // Extract the title line and assert it fits within the 80-char cap.
    const titleMatch = content.match(/^Title:\s+(.+)$/m);
    expect(titleMatch).not.toBeNull();
    expect(titleMatch![1].length).toBeLessThanOrEqual(80);
    expect(titleMatch![1]).toMatch(/\.\.\.$/);
  });

  it('first_comment includes description and companion repo link', () => {
    const f = setup();
    const post = seedPost(f.db, 'hn-repo', {
      title: 'Repo Project',
      topic: 'A description here',
    });
    const outPath = generateHackerNews(
      post, makeConfig(), f.socialDir, f.templatesDir, 'https://github.com/jmolz/hn-repo',
    );
    const content = readFileSync(outPath, 'utf-8');
    expect(content).toContain('A description here');
    expect(content).toContain('https://github.com/jmolz/hn-repo');
  });

  it('fits Hacker News first-comment descriptions without abrupt ellipses', () => {
    const f = setup();
    const post = seedPost(f.db, 'hn-natural-fit', {
      title: 'HN Natural Fit',
      topic: `${'A'.repeat(280)} without a complete sentence ${'B'.repeat(120)}`,
    });
    const outPath = generateHackerNews(post, makeConfig(), f.socialDir, f.templatesDir, undefined);
    const content = readFileSync(outPath, 'utf-8');
    expect(content).not.toContain('...');
    expect(content).toContain('Technical notes and evidence for HN Natural Fit.');
  });

  it('throws when template expansion produces emoji', () => {
    const f = setup();
    const localTemplates = join(f.tempDir, 'templates-hn-emoji');
    writeLocalSocialTemplates(
      localTemplates,
      '{{title}}\n{{canonical_url}}\n{{hashtags}}\n{{timing}}\n',
      `Title: ${'\u{1F4A9}'} {{title}}\nURL: {{canonical_url}}\n{{first_comment}}\n{{repo_url}}\n{{timing}}\n`,
    );
    const post = seedPost(f.db, 'hn-emoji');
    expect(() =>
      generateHackerNews(post, makeConfig(), f.socialDir, localTemplates, undefined),
    ).toThrow(/contains emoji/);
  });
});

describe('generateSocialText — end-to-end wiring', () => {
  it('generates both linkedin.md and hackernews.md for a publish-phase post', () => {
    const f = setup();
    seedPost(f.db, 'wire', { title: 'End to End' });
    // Seed a draft MDX so the frontmatter-tag read path exercises.
    const draftDir = join(f.draftsDir, 'wire');
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(
      join(draftDir, 'index.mdx'),
      `---\ntitle: "End to End"\ndescription: "desc"\ndate: "2026-04-16"\ntags: ["typescript"]\npublished: false\n---\nBody\n`,
      'utf-8',
    );

    const result = generateSocialText('wire', makeConfig(), {
      socialDir: f.socialDir,
      templatesDir: f.templatesDir,
      draftsDir: f.draftsDir,
    }, f.db);

    expect(existsSync(result.linkedinPath)).toBe(true);
    expect(existsSync(result.hackerNewsPath)).toBe(true);
    const li = readFileSync(result.linkedinPath, 'utf-8');
    expect(li).toContain('#typescript');
  });
});
