import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  formatBenchmarkTable,
  formatMethodologyRef,
  getBenchmarkContext,
} from '../src/core/draft/benchmark-data.js';
import { BenchmarkResults } from '../src/core/benchmark/results.js';
import { EnvironmentSnapshot } from '../src/core/benchmark/environment.js';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function makeResults(data: Record<string, unknown> = {}): BenchmarkResults {
  return {
    slug: 'test-bench',
    run_id: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    targets: ['Target A'],
    data,
  };
}

function makeEnv(): EnvironmentSnapshot {
  return {
    os: 'darwin',
    os_release: '24.0.0',
    arch: 'arm64',
    cpus: 'Apple M4 x 10',
    total_memory_gb: 32,
    node_version: 'v22.0.0',
    npm_version: '10.0.0',
    captured_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('formatBenchmarkTable', () => {
  it('produces valid markdown table from simple key-value data', () => {
    const results = makeResults({ latency_ms: 42, throughput_rps: 1000 });
    const table = formatBenchmarkTable(results);
    expect(table).toContain('| Metric | Value |');
    expect(table).toContain('| latency_ms | 42 |');
    expect(table).toContain('| throughput_rps | 1000 |');
  });

  it('handles empty data', () => {
    const results = makeResults({});
    const table = formatBenchmarkTable(results);
    expect(table).toBe('(no benchmark data)');
  });

  it('handles array values as rows', () => {
    const results = makeResults({
      tool: ['A', 'B', 'C'],
      score: [90, 85, 78],
    });
    const table = formatBenchmarkTable(results);
    expect(table).toContain('| tool | score |');
    expect(table).toContain('| A | 90 |');
    expect(table).toContain('| B | 85 |');
    expect(table).toContain('| C | 78 |');
  });

  it('handles nested objects by flattening one level', () => {
    const results = makeResults({
      toolA: { latency: 10, throughput: 500 },
      toolB: { latency: 20, throughput: 300 },
    });
    const table = formatBenchmarkTable(results);
    expect(table).toContain('| toolA | 10 | 500 |');
    expect(table).toContain('| toolB | 20 | 300 |');
  });
});

describe('formatMethodologyRef', () => {
  it('produces correct reference string', () => {
    const env = makeEnv();
    const ref = formatMethodologyRef(env, 'test-bench', { githubUser: 'jmolz' });
    expect(ref).toContain('darwin');
    expect(ref).toContain('arm64');
    expect(ref).toContain('Apple M4 x 10');
    expect(ref).toContain('v22.0.0');
    expect(ref).toContain('METHODOLOGY.md');
    expect(ref).toContain('test-bench');
    expect(ref).toContain('https://github.com/jmolz/test-bench');
  });

  it('honors a custom github user from config', () => {
    const env = makeEnv();
    const ref = formatMethodologyRef(env, 'test-bench', { githubUser: 'someone-else' });
    expect(ref).toContain('https://github.com/someone-else/test-bench');
    expect(ref).not.toContain('jmolz');
  });
});

describe('getBenchmarkContext', () => {
  it('reads existing results and environment', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bench-data-'));
    const slugDir = join(tempDir, 'test-slug');
    mkdirSync(slugDir, { recursive: true });

    writeFileSync(join(slugDir, 'results.json'), JSON.stringify(makeResults({ score: 42 })));
    writeFileSync(join(slugDir, 'environment.json'), JSON.stringify(makeEnv()));

    const ctx = getBenchmarkContext(tempDir, 'test-slug', { githubUser: 'jmolz' });
    expect(ctx.results).not.toBeNull();
    expect(ctx.environment).not.toBeNull();
    expect(ctx.table).toContain('score');
    expect(ctx.methodologyRef).toContain('darwin');
    expect(ctx.methodologyRef).toContain('github.com/jmolz');
  });

  it('returns nulls for missing files', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bench-data-'));
    const ctx = getBenchmarkContext(tempDir, 'nonexistent', { githubUser: 'jmolz' });
    expect(ctx.results).toBeNull();
    expect(ctx.environment).toBeNull();
    expect(ctx.table).toBe('(no benchmark data)');
    expect(ctx.methodologyRef).toBe('');
  });
});
