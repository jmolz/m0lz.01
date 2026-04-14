import { describe, it, expect } from 'vitest';

import {
  generateFrontmatter,
  validateFrontmatter,
  serializeFrontmatter,
  parseFrontmatter,
  PostFrontmatter,
} from '../src/core/draft/frontmatter.js';
import { PostRow } from '../src/core/db/types.js';
import { BlogConfig } from '../src/core/config/types.js';

function makePost(overrides: Partial<PostRow> = {}): PostRow {
  return {
    slug: 'test-post',
    title: null,
    topic: 'Test topic',
    content_type: 'technical-deep-dive',
    phase: 'draft',
    mode: 'directed',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    published_at: null,
    unpublished_at: null,
    last_updated_at: null,
    site_url: null,
    devto_url: null,
    medium_url: null,
    substack_url: null,
    repo_url: null,
    project_id: null,
    evaluation_passed: null,
    evaluation_score: null,
    has_benchmarks: 0,
    update_count: 0,
    ...overrides,
  };
}

function makeConfig(): BlogConfig {
  return {
    site: { repo_path: '/tmp/site', base_url: 'https://m0lz.dev', content_dir: 'content/posts' },
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

describe('generateFrontmatter', () => {
  it('produces correct canonical URL', () => {
    const fm = generateFrontmatter(makePost(), makeConfig());
    expect(fm.canonical).toBe('https://m0lz.dev/writing/test-post');
  });

  it('includes companion_repo when has_benchmarks', () => {
    const fm = generateFrontmatter(makePost({ has_benchmarks: 1 }), makeConfig());
    expect(fm.companion_repo).toBe('https://github.com/jmolz/test-post');
  });

  it('omits companion_repo when no benchmarks', () => {
    const fm = generateFrontmatter(makePost({ has_benchmarks: 0 }), makeConfig());
    expect(fm.companion_repo).toBeUndefined();
  });

  it('includes project from project_id', () => {
    const fm = generateFrontmatter(makePost({ project_id: 'm0lz.02' }), makeConfig());
    expect(fm.project).toBe('m0lz.02');
  });

  it('sets published to false', () => {
    const fm = generateFrontmatter(makePost(), makeConfig());
    expect(fm.published).toBe(false);
  });

  it('generates placeholder title and description', () => {
    const fm = generateFrontmatter(makePost(), makeConfig());
    expect(fm.title).toBe('{{title}}');
    expect(fm.description).toBe('{{description}}');
  });
});

describe('validateFrontmatter', () => {
  function validFm(): PostFrontmatter {
    return {
      title: 'A real title',
      description: 'A real description',
      date: '2026-01-01',
      tags: ['typescript', 'benchmarks'],
      published: false,
    };
  }

  it('passes for complete frontmatter', () => {
    const result = validateFrontmatter(validFm());
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails for missing title', () => {
    const fm = validFm();
    fm.title = '';
    const result = validateFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Missing required field: title');
  });

  it('fails for placeholder title', () => {
    const fm = validFm();
    fm.title = '{{title}}';
    const result = validateFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Title is still a placeholder');
  });

  it('fails for missing description', () => {
    const fm = validFm();
    fm.description = '';
    const result = validateFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Missing required field: description');
  });

  it('fails for placeholder description', () => {
    const fm = validFm();
    fm.description = '{{description}}';
    const result = validateFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Description is still a placeholder');
  });

  it('fails for missing date', () => {
    const fm = validFm();
    fm.date = '';
    const result = validateFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Missing required field: date');
  });

  it('fails for non-array tags', () => {
    const fm = validFm();
    (fm as any).tags = 'not-an-array';
    const result = validateFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Field tags must be an array');
  });

  it('fails for missing published', () => {
    const fm = validFm();
    (fm as any).published = undefined;
    const result = validateFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Field published must be a boolean');
  });

  it('fails for invalid date format', () => {
    const fm = validFm();
    fm.date = 'January 1, 2026';
    const result = validateFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Field date must be in YYYY-MM-DD format');
  });

  it('fails for empty tags array', () => {
    const fm = validFm();
    fm.tags = [];
    const result = validateFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Field tags must not be empty');
  });

  it('fails for string published value', () => {
    const fm = validFm();
    (fm as any).published = 'false';
    const result = validateFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Field published must be a boolean');
  });
});

describe('serializeFrontmatter / parseFrontmatter', () => {
  it('round-trips through serialize and parse', () => {
    const original: PostFrontmatter = {
      title: 'Test Post Title',
      description: 'A test post',
      date: '2026-04-14',
      tags: ['typescript', 'testing'],
      published: false,
      canonical: 'https://m0lz.dev/writing/test-post',
      companion_repo: 'https://github.com/jmolz/test-post',
      project: 'm0lz.02',
    };

    const serialized = serializeFrontmatter(original);
    // Wrap with body content for parsing
    const mdx = `${serialized}\n\n## Content\n\nHello world`;
    const parsed = parseFrontmatter(mdx);

    expect(parsed.title).toBe(original.title);
    expect(parsed.description).toBe(original.description);
    expect(parsed.date).toBe(original.date);
    expect(parsed.tags).toEqual(original.tags);
    expect(parsed.published).toBe(original.published);
    expect(parsed.canonical).toBe(original.canonical);
    expect(parsed.companion_repo).toBe(original.companion_repo);
    expect(parsed.project).toBe(original.project);
  });

  it('omits undefined optional fields', () => {
    const fm: PostFrontmatter = {
      title: 'Test',
      description: 'Desc',
      date: '2026-01-01',
      tags: [],
      published: false,
    };
    const serialized = serializeFrontmatter(fm);
    expect(serialized).not.toContain('companion_repo');
    expect(serialized).not.toContain('medium_url');
  });
});

describe('parseFrontmatter', () => {
  it('extracts from valid MDX', () => {
    const mdx = `---
title: Hello World
description: A test
date: "2026-01-01"
tags:
  - typescript
published: false
---

## Content

Body text`;

    const fm = parseFrontmatter(mdx);
    expect(fm.title).toBe('Hello World');
    expect(fm.description).toBe('A test');
    expect(fm.tags).toEqual(['typescript']);
    expect(fm.published).toBe(false);
  });

  it('throws for missing frontmatter delimiters', () => {
    expect(() => parseFrontmatter('No frontmatter here')).toThrow('missing frontmatter');
  });

  it('throws for invalid YAML', () => {
    const mdx = `---
: bad yaml [
---

body`;
    expect(() => parseFrontmatter(mdx)).toThrow();
  });

  it('does not coerce string "false" to true for published', () => {
    const mdx = `---
title: Coercion Test
description: Testing published coercion
date: "2026-01-01"
tags:
  - test
published: "false"
---

body`;
    const fm = parseFrontmatter(mdx);
    expect(fm.published).toBe(false);
  });
});
