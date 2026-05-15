import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  writeResults,
  readResults,
  writeEnvironment,
  readEnvironment,
  BenchmarkResults,
  parseBenchmarkResultsJson,
  parseBenchmarkResultsInputJson,
  canonicalizeBenchmarkResults,
  readBenchmarkSummary,
} from '../src/core/benchmark/results.js';
import { EnvironmentSnapshot } from '../src/core/benchmark/environment.js';

let tempDir: string | undefined;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'bench-results-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

const sampleResults: BenchmarkResults = {
  slug: 'alpha',
  run_id: 1,
  timestamp: '2026-04-14T12:00:00.000Z',
  targets: ['Target A', 'Target B'],
  data: { target_a: { mean: 42.5, unit: 'ms' } },
};

const sampleEnv: EnvironmentSnapshot = {
  os: 'darwin',
  os_release: '24.1.0',
  arch: 'arm64',
  cpus: 'Apple M1 Pro x 10',
  total_memory_gb: 16,
  node_version: 'v20.11.0',
  npm_version: '10.2.4',
  captured_at: '2026-04-14T12:00:00.000Z',
};

describe('writeResults / readResults', () => {
  it('round-trips data through write and read', () => {
    const dir = makeTempDir();
    writeResults(dir, 'alpha', sampleResults);
    const read = readResults(dir, 'alpha');
    expect(read).toEqual(sampleResults);
  });

  it('returns null for nonexistent file', () => {
    const dir = makeTempDir();
    expect(readResults(dir, 'missing')).toBeNull();
  });

  it('rejects environment snapshots masquerading as results', () => {
    expect(() => parseBenchmarkResultsJson(JSON.stringify(sampleEnv), 'alpha')).toThrow(
      /Expected a benchmark results file, not environment\.json/,
    );
  });

  it('rejects results for the wrong slug', () => {
    expect(() => parseBenchmarkResultsJson(JSON.stringify(sampleResults), 'beta')).toThrow(
      /must be 'beta'/,
    );
  });

  it('accepts operator input without run_id and canonicalizes with DB run id', () => {
    const input = parseBenchmarkResultsInputJson(JSON.stringify({
      slug: 'alpha',
      timestamp: '2026-04-14T12:00:00.000Z',
      targets: ['Target A'],
      data: { score: 10 },
      summary: 'median 10ms',
    }), 'alpha');
    const canonical = canonicalizeBenchmarkResults(input, 42);

    expect(canonical.run_id).toBe(42);
    expect(canonical.summary).toBe('median 10ms');
  });

  it('ignores guessed input run_id when canonicalizing', () => {
    const input = parseBenchmarkResultsInputJson(JSON.stringify({
      slug: 'alpha',
      run_id: 999,
      timestamp: '2026-04-14T12:00:00.000Z',
      targets: ['Target A'],
      data: { score: 10 },
    }), 'alpha');

    expect(canonicalizeBenchmarkResults(input, 2).run_id).toBe(2);
  });

  it('rejects canonical results without run_id', () => {
    const dir = makeTempDir();
    writeResults(dir, 'alpha', sampleResults);
    const missingRunId = JSON.stringify({
      slug: 'alpha',
      timestamp: '2026-04-14T12:00:00.000Z',
      targets: ['Target A'],
      data: {},
    });
    expect(() => parseBenchmarkResultsJson(missingRunId, 'alpha')).toThrow(/run_id/);
  });

  it('extracts summary from canonical results summary or data.summary', () => {
    const dir = makeTempDir();
    writeResults(dir, 'alpha', { ...sampleResults, summary: 'top-level summary' });
    expect(readBenchmarkSummary(dir, 'alpha')).toBe('top-level summary');

    writeResults(dir, 'alpha', {
      ...sampleResults,
      summary: undefined,
      data: { summary: { median: '1.2ms' } },
    });
    expect(readBenchmarkSummary(dir, 'alpha')).toContain('"median": "1.2ms"');
  });
});

describe('writeEnvironment / readEnvironment', () => {
  it('round-trips environment through write and read', () => {
    const dir = makeTempDir();
    writeEnvironment(dir, 'alpha', sampleEnv);
    const read = readEnvironment(dir, 'alpha');
    expect(read).toEqual(sampleEnv);
  });

  it('returns null for nonexistent file', () => {
    const dir = makeTempDir();
    expect(readEnvironment(dir, 'missing')).toBeNull();
  });
});

describe('slug validation', () => {
  it('rejects invalid slug before touching filesystem', () => {
    const dir = makeTempDir();
    expect(() => writeResults(dir, '../escape', sampleResults)).toThrow(/Invalid slug/);
    expect(() => readResults(dir, '../escape')).toThrow(/Invalid slug/);
    expect(() => writeEnvironment(dir, '../escape', sampleEnv)).toThrow(/Invalid slug/);
    expect(() => readEnvironment(dir, '../escape')).toThrow(/Invalid slug/);
  });
});
