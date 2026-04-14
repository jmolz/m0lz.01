import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scaffoldCompanion, writeMethodology } from '../src/core/benchmark/companion.js';
import { EnvironmentSnapshot } from '../src/core/benchmark/environment.js';

let tempDir: string | undefined;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'bench-companion-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

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

describe('scaffoldCompanion', () => {
  it('creates expected directory structure', () => {
    const dir = makeTempDir();
    const repoPath = scaffoldCompanion(dir, {
      slug: 'alpha',
      topic: 'Alpha benchmark',
      targets: ['Target A', 'Target B'],
      environment: sampleEnv,
      methodology: '',
    });

    expect(existsSync(join(repoPath, 'src'))).toBe(true);
    expect(existsSync(join(repoPath, 'results'))).toBe(true);
    expect(existsSync(join(repoPath, 'METHODOLOGY.md'))).toBe(true);
    expect(existsSync(join(repoPath, 'LICENSE'))).toBe(true);
    expect(existsSync(join(repoPath, 'README.md'))).toBe(true);
  });

  it('METHODOLOGY.md contains environment details', () => {
    const dir = makeTempDir();
    scaffoldCompanion(dir, {
      slug: 'beta',
      topic: 'Beta',
      targets: ['T1'],
      environment: sampleEnv,
      methodology: '',
    });

    const content = readFileSync(join(dir, 'beta', 'METHODOLOGY.md'), 'utf-8');
    expect(content).toContain('darwin');
    expect(content).toContain('v20.11.0');
    expect(content).toContain('arm64');
  });

  it('README.md lists benchmark targets', () => {
    const dir = makeTempDir();
    scaffoldCompanion(dir, {
      slug: 'gamma',
      topic: 'Gamma',
      targets: ['Target X', 'Target Y'],
      environment: sampleEnv,
      methodology: '',
    });

    const content = readFileSync(join(dir, 'gamma', 'README.md'), 'utf-8');
    expect(content).toContain('Target X');
    expect(content).toContain('Target Y');
  });

  it('LICENSE contains MIT', () => {
    const dir = makeTempDir();
    scaffoldCompanion(dir, {
      slug: 'delta',
      topic: 'Delta',
      targets: [],
      environment: sampleEnv,
      methodology: '',
    });

    const content = readFileSync(join(dir, 'delta', 'LICENSE'), 'utf-8');
    expect(content).toContain('MIT');
  });

  it('is idempotent: calling twice does not throw', () => {
    const dir = makeTempDir();
    const opts = {
      slug: 'epsilon',
      topic: 'Epsilon',
      targets: ['T1'],
      environment: sampleEnv,
      methodology: '',
    };

    scaffoldCompanion(dir, opts);

    // Write a file in src/ to verify it survives re-scaffold
    writeFileSync(join(dir, 'epsilon', 'src', 'test.ts'), 'test', 'utf-8');

    scaffoldCompanion(dir, opts);

    expect(existsSync(join(dir, 'epsilon', 'src', 'test.ts'))).toBe(true);
    expect(existsSync(join(dir, 'epsilon', 'METHODOLOGY.md'))).toBe(true);
  });
});

describe('writeMethodology', () => {
  it('replaces template placeholders with environment data', () => {
    const dir = makeTempDir();
    const repoPath = join(dir, 'repo');
    mkdirSync(repoPath, { recursive: true });

    writeMethodology(repoPath, sampleEnv, { runCount: 5, testSetup: 'Custom setup' });

    const content = readFileSync(join(repoPath, 'METHODOLOGY.md'), 'utf-8');
    expect(content).toContain('darwin');
    expect(content).toContain('v20.11.0');
    expect(content).toContain('5');
    expect(content).toContain('Custom setup');
    expect(content).not.toContain('{{environment_details}}');
    expect(content).not.toContain('{{run_count}}');
  });
});
