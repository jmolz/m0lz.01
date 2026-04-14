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
  });

  it('throws on non-existent config file', () => {
    expect(() => {
      loadConfig('/nonexistent/path/.blogrc.yaml');
    }).toThrow('Config file not found');
  });
});
