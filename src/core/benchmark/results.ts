import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { validateSlug } from '../research/document.js';
import { EnvironmentSnapshot } from './environment.js';

export interface BenchmarkResults {
  slug: string;
  run_id: number;
  timestamp: string;
  targets: string[];
  data: Record<string, unknown>;
}

export function writeResults(
  benchmarkDir: string,
  slug: string,
  results: BenchmarkResults,
): string {
  validateSlug(slug);
  const dir = join(benchmarkDir, slug);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'results.json');
  writeFileSync(filePath, JSON.stringify(results, null, 2), 'utf-8');
  return filePath;
}

export function readResults(
  benchmarkDir: string,
  slug: string,
): BenchmarkResults | null {
  validateSlug(slug);
  const filePath = join(benchmarkDir, slug, 'results.json');
  if (!existsSync(filePath)) {
    return null;
  }
  return JSON.parse(readFileSync(filePath, 'utf-8')) as BenchmarkResults;
}

export function writeEnvironment(
  benchmarkDir: string,
  slug: string,
  env: EnvironmentSnapshot,
): string {
  validateSlug(slug);
  const dir = join(benchmarkDir, slug);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'environment.json');
  writeFileSync(filePath, JSON.stringify(env, null, 2), 'utf-8');
  return filePath;
}

export function readEnvironment(
  benchmarkDir: string,
  slug: string,
): EnvironmentSnapshot | null {
  validateSlug(slug);
  const filePath = join(benchmarkDir, slug, 'environment.json');
  if (!existsSync(filePath)) {
    return null;
  }
  return JSON.parse(readFileSync(filePath, 'utf-8')) as EnvironmentSnapshot;
}
