import { describe, it, expect } from 'vitest';

import { captureEnvironment, formatEnvironmentMarkdown } from '../src/core/benchmark/environment.js';

describe('captureEnvironment', () => {
  it('returns all required fields as non-empty strings', () => {
    const env = captureEnvironment();

    expect(typeof env.os).toBe('string');
    expect(env.os.length).toBeGreaterThan(0);

    expect(typeof env.os_release).toBe('string');
    expect(env.os_release.length).toBeGreaterThan(0);

    expect(typeof env.arch).toBe('string');
    expect(env.arch.length).toBeGreaterThan(0);

    expect(typeof env.cpus).toBe('string');
    expect(env.cpus.length).toBeGreaterThan(0);

    expect(typeof env.node_version).toBe('string');
    expect(env.node_version.length).toBeGreaterThan(0);

    expect(typeof env.npm_version).toBe('string');
    expect(env.npm_version.length).toBeGreaterThan(0);

    expect(typeof env.captured_at).toBe('string');
    expect(env.captured_at.length).toBeGreaterThan(0);
  });

  it('returns total_memory_gb as a positive number', () => {
    const env = captureEnvironment();
    expect(env.total_memory_gb).toBeGreaterThan(0);
    expect(Number.isInteger(env.total_memory_gb)).toBe(true);
  });

  it('returns stable values across consecutive calls (except captured_at)', () => {
    const env1 = captureEnvironment();
    const env2 = captureEnvironment();

    expect(env1.os).toBe(env2.os);
    expect(env1.arch).toBe(env2.arch);
    expect(env1.node_version).toBe(env2.node_version);
    expect(env1.total_memory_gb).toBe(env2.total_memory_gb);
  });
});

describe('formatEnvironmentMarkdown', () => {
  it('returns a string containing OS, architecture, and Node version', () => {
    const env = captureEnvironment();
    const md = formatEnvironmentMarkdown(env);

    expect(md).toContain(env.os);
    expect(md).toContain(env.arch);
    expect(md).toContain(env.node_version);
    expect(md).toContain('**OS:**');
    expect(md).toContain('**Architecture:**');
    expect(md).toContain('**Node.js:**');
  });
});
