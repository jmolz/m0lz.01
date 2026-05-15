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
  summary?: string | Record<string, unknown>;
}

export interface BenchmarkResultsInput {
  slug: string;
  timestamp: string;
  targets: string[];
  data: Record<string, unknown>;
  summary?: string | Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid ${label} JSON: ${(e as Error).message}`);
  }
}

function validateCommonFields(
  value: unknown,
  expectedSlug: string | undefined,
  options: { requireRunId: boolean },
): BenchmarkResultsInput & { run_id?: unknown } {
  if (!isRecord(value)) {
    throw new Error('Invalid BenchmarkResults: expected a JSON object.');
  }

  const errors: string[] = [];

  if (typeof value.slug !== 'string' || value.slug.trim() === '') {
    errors.push("missing non-empty string field 'slug'");
  } else if (expectedSlug && value.slug !== expectedSlug) {
    errors.push(`field 'slug' must be '${expectedSlug}', got '${value.slug}'`);
  }

  if (options.requireRunId && !Number.isInteger(value.run_id)) {
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

  if (
    value.summary !== undefined &&
    !(typeof value.summary === 'string' || isRecord(value.summary))
  ) {
    errors.push("optional field 'summary' must be a string or object");
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid BenchmarkResults: ${errors.join('; ')}. ` +
      'Expected a benchmark results file, not environment.json.',
    );
  }

  return value as unknown as BenchmarkResultsInput & { run_id?: unknown };
}

export function parseBenchmarkResultsInput(
  value: unknown,
  expectedSlug?: string,
): BenchmarkResultsInput {
  const validated = validateCommonFields(value, expectedSlug, { requireRunId: false });
  return {
    slug: validated.slug,
    timestamp: validated.timestamp,
    targets: validated.targets,
    data: validated.data,
    ...(validated.summary !== undefined ? { summary: validated.summary } : {}),
  };
}

export function parseBenchmarkResultsInputJson(
  raw: string,
  expectedSlug?: string,
): BenchmarkResultsInput {
  return parseBenchmarkResultsInput(parseJson(raw, 'BenchmarkResults'), expectedSlug);
}

export function validateBenchmarkResults(
  value: unknown,
  expectedSlug?: string,
): BenchmarkResults {
  const validated = validateCommonFields(value, expectedSlug, { requireRunId: true });
  return {
    slug: validated.slug,
    run_id: validated.run_id as number,
    timestamp: validated.timestamp,
    targets: validated.targets,
    data: validated.data,
    ...(validated.summary !== undefined ? { summary: validated.summary } : {}),
  };
}

export function parseBenchmarkResultsJson(
  raw: string,
  expectedSlug?: string,
): BenchmarkResults {
  return validateBenchmarkResults(parseJson(raw, 'BenchmarkResults'), expectedSlug);
}

export function canonicalizeBenchmarkResults(
  input: BenchmarkResultsInput,
  runId: number,
): BenchmarkResults {
  if (!Number.isInteger(runId) || runId <= 0) {
    throw new Error(`Invalid benchmark run id: ${runId}`);
  }
  return {
    ...input,
    run_id: runId,
  };
}

export function writeResults(
  benchmarkDir: string,
  slug: string,
  results: BenchmarkResults,
): string {
  validateSlug(slug);
  validateBenchmarkResults(results, slug);
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

function summaryToString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (isRecord(value)) {
    return JSON.stringify(value, null, 2);
  }
  return null;
}

export function extractBenchmarkSummary(results: BenchmarkResults): string | null {
  return summaryToString(results.summary) ?? summaryToString(results.data.summary);
}

export function readBenchmarkSummary(
  benchmarkDir: string,
  slug: string,
): string | null {
  const results = readResults(benchmarkDir, slug);
  return results ? extractBenchmarkSummary(results) : null;
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
