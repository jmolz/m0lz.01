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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateBenchmarkResults(
  value: unknown,
  expectedSlug?: string,
): BenchmarkResults {
  if (!isRecord(value)) {
    throw new Error('Invalid BenchmarkResults: expected a JSON object.');
  }

  const errors: string[] = [];

  if (typeof value.slug !== 'string' || value.slug.trim() === '') {
    errors.push("missing non-empty string field 'slug'");
  } else if (expectedSlug && value.slug !== expectedSlug) {
    errors.push(`field 'slug' must be '${expectedSlug}', got '${value.slug}'`);
  }

  if (!Number.isInteger(value.run_id)) {
    errors.push("missing integer field 'run_id'");
  }

  if (typeof value.timestamp !== 'string' || value.timestamp.trim() === '') {
    errors.push("missing non-empty string field 'timestamp'");
  } else if (Number.isNaN(Date.parse(value.timestamp))) {
    errors.push("field 'timestamp' must be an ISO-compatible date string");
  }

  if (!Array.isArray(value.targets) || !value.targets.every((target) => typeof target === 'string')) {
    errors.push("missing string[] field 'targets'");
  }

  if (!isRecord(value.data)) {
    errors.push("missing object field 'data'");
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid BenchmarkResults: ${errors.join('; ')}. ` +
      'Expected a benchmark results file, not environment.json.',
    );
  }

  return value as unknown as BenchmarkResults;
}

export function parseBenchmarkResultsJson(
  raw: string,
  expectedSlug?: string,
): BenchmarkResults {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid BenchmarkResults JSON: ${(e as Error).message}`);
  }
  return validateBenchmarkResults(parsed, expectedSlug);
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
  return parseBenchmarkResultsJson(readFileSync(filePath, 'utf-8'), slug);
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
