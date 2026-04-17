import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadConfig, validateConfig } from '../src/core/config/loader.js';

let tempDir: string;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('config loader', () => {
  it('parses a valid config file', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-config-'));
    const configPath = join(tempDir, '.blogrc.yaml');

    writeFileSync(configPath, `
site:
  repo_path: "../m0lz.00"
  base_url: "https://m0lz.dev"
  content_dir: "content/posts"
author:
  name: "Test Author"
  github: "testuser"
`);

    const config = loadConfig(configPath);
    expect(config.site.base_url).toBe('https://m0lz.dev');
    expect(config.author.name).toBe('Test Author');
    expect(config.author.github).toBe('testuser');
    // repo_path should be resolved relative to config file directory
    expect(config.site.repo_path).toContain('m0lz.00');
  });

  it('throws on missing site.repo_path', () => {
    expect(() => {
      validateConfig({
        site: { base_url: 'https://m0lz.dev' },
        author: { name: 'Test', github: 'test' },
      });
    }).toThrow('repo_path');
  });

  it('throws on missing author.name', () => {
    expect(() => {
      validateConfig({
        site: { repo_path: '../m0lz.00', base_url: 'https://m0lz.dev' },
        author: { github: 'test' },
      });
    }).toThrow('author.name');
  });

  it('throws on missing author.github', () => {
    expect(() => {
      validateConfig({
        site: { repo_path: '../m0lz.00', base_url: 'https://m0lz.dev' },
        author: { name: 'Test' },
      });
    }).toThrow('author.github');
  });

  it('applies defaults for optional sections', () => {
    const config = validateConfig({
      site: { repo_path: '../m0lz.00', base_url: 'https://m0lz.dev' },
      author: { name: 'Test', github: 'test' },
    });

    expect(config.benchmark.multiple_runs).toBe(3);
    expect(config.publish.devto).toBe(true);
    expect(config.evaluation.min_sources).toBe(3);
    expect(config.social.platforms).toEqual(['linkedin', 'hackernews']);
    expect(config.site.content_dir).toBe('content/posts');
    expect(config.site.research_dir).toBe('content/research');
    expect(config.projects).toBeUndefined();
  });

  it('applies Phase 7 updates defaults including new fields', () => {
    const config = validateConfig({
      site: { repo_path: '../m0lz.00', base_url: 'https://m0lz.dev' },
      author: { name: 'Test', github: 'test' },
    });

    // Existing Phase 1 fields
    expect(config.updates.preserve_original_data).toBe(true);
    expect(config.updates.update_notice).toBe(true);
    expect(config.updates.update_crosspost).toBe(true);
    // Phase 7 additions
    expect(config.updates.devto_update).toBe(true);
    expect(config.updates.refresh_paste_files).toBe(true);
    expect(config.updates.notice_template).toBe('Updated {DATE}: {SUMMARY}');
    expect(config.updates.require_summary).toBe(true);
    expect(config.updates.site_update_mode).toBe('pr');
  });

  it('applies Phase 7 unpublish defaults', () => {
    const config = validateConfig({
      site: { repo_path: '../m0lz.00', base_url: 'https://m0lz.dev' },
      author: { name: 'Test', github: 'test' },
    });

    expect(config.unpublish.devto).toBe(true);
    expect(config.unpublish.medium).toBe(true);
    expect(config.unpublish.substack).toBe(true);
    expect(config.unpublish.readme).toBe(true);
  });

  it('honors partial overrides for updates and unpublish', () => {
    const config = validateConfig({
      site: { repo_path: '../m0lz.00', base_url: 'https://m0lz.dev' },
      author: { name: 'Test', github: 'test' },
      updates: {
        site_update_mode: 'direct',
        require_summary: false,
      },
      unpublish: {
        readme: false,
      },
    });

    expect(config.updates.site_update_mode).toBe('direct');
    expect(config.updates.require_summary).toBe(false);
    // Defaults preserved for non-overridden fields
    expect(config.updates.devto_update).toBe(true);
    expect(config.updates.notice_template).toBe('Updated {DATE}: {SUMMARY}');

    expect(config.unpublish.readme).toBe(false);
    expect(config.unpublish.devto).toBe(true);
  });

  it('accepts site.research_dir override', () => {
    const config = validateConfig({
      site: { repo_path: '../m0lz.00', base_url: 'https://m0lz.dev', research_dir: 'content/notes' },
      author: { name: 'Test', github: 'test' },
    });
    expect(config.site.research_dir).toBe('content/notes');
  });

  it('parses projects map when provided', () => {
    const config = validateConfig({
      site: { repo_path: '../m0lz.00', base_url: 'https://m0lz.dev' },
      author: { name: 'Test', github: 'test' },
      projects: {
        'm0lz.02': '../m0lz.02',
        'm0lz.03': '../m0lz.03',
      },
    });
    expect(config.projects).toEqual({
      'm0lz.02': '../m0lz.02',
      'm0lz.03': '../m0lz.03',
    });
  });

  it('throws when projects is not an object', () => {
    expect(() => {
      validateConfig({
        site: { repo_path: '../m0lz.00', base_url: 'https://m0lz.dev' },
        author: { name: 'Test', github: 'test' },
        projects: 'not-an-object',
      });
    }).toThrow('projects');
  });

  it('throws when a projects value is not a string', () => {
    expect(() => {
      validateConfig({
        site: { repo_path: '../m0lz.00', base_url: 'https://m0lz.dev' },
        author: { name: 'Test', github: 'test' },
        projects: { 'm0lz.02': 42 },
      });
    }).toThrow("projects['m0lz.02']");
  });

  it('throws on non-existent config file', () => {
    expect(() => {
      loadConfig('/nonexistent/path/.blogrc.yaml');
    }).toThrow('Config file not found');
  });
});
