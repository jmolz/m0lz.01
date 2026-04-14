import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BenchmarkResults } from '../benchmark/results.js';
import { EnvironmentSnapshot } from '../benchmark/environment.js';

export interface BenchmarkContext {
  results: BenchmarkResults | null;
  environment: EnvironmentSnapshot | null;
  table: string;
  methodologyRef: string;
}

export function formatBenchmarkTable(results: BenchmarkResults): string {
  const data = results.data;
  const keys = Object.keys(data);

  if (keys.length === 0) {
    return '(no benchmark data)';
  }

  // If values are arrays, render each array element as a row
  const firstValue = data[keys[0]];
  if (Array.isArray(firstValue)) {
    const headers = keys;
    const maxLen = Math.max(...keys.map((k) => {
      const v = data[k];
      return Array.isArray(v) ? v.length : 0;
    }));

    const headerRow = `| ${headers.join(' | ')} |`;
    const separator = `| ${headers.map(() => '---').join(' | ')} |`;
    const rows: string[] = [];
    for (let i = 0; i < maxLen; i++) {
      const cells = headers.map((h) => {
        const v = data[h];
        return Array.isArray(v) && i < v.length ? String(v[i]) : '';
      });
      rows.push(`| ${cells.join(' | ')} |`);
    }
    return [headerRow, separator, ...rows].join('\n');
  }

  // If values are objects, flatten one level
  if (typeof firstValue === 'object' && firstValue !== null && !Array.isArray(firstValue)) {
    const subKeys = new Set<string>();
    for (const k of keys) {
      const v = data[k];
      if (typeof v === 'object' && v !== null) {
        for (const sk of Object.keys(v as Record<string, unknown>)) {
          subKeys.add(sk);
        }
      }
    }
    const subKeyArr = Array.from(subKeys);
    const headers = ['', ...subKeyArr];
    const headerRow = `| ${headers.join(' | ')} |`;
    const separator = `| ${headers.map(() => '---').join(' | ')} |`;
    const rows = keys.map((k) => {
      const v = data[k] as Record<string, unknown>;
      const cells = subKeyArr.map((sk) => String(v[sk] ?? ''));
      return `| ${k} | ${cells.join(' | ')} |`;
    });
    return [headerRow, separator, ...rows].join('\n');
  }

  // Simple key-value pairs: two-column table
  const headerRow = '| Metric | Value |';
  const separator = '| --- | --- |';
  const rows = keys.map((k) => `| ${k} | ${String(data[k])} |`);
  return [headerRow, separator, ...rows].join('\n');
}

export function formatMethodologyRef(env: EnvironmentSnapshot, slug: string): string {
  return (
    `Tested on ${env.os} ${env.arch} (${env.cpus}) with Node.js ${env.node_version} -- ` +
    `see [METHODOLOGY.md](https://github.com/jmolz/${slug}/blob/main/METHODOLOGY.md) for full reproduction steps.`
  );
}

export function getBenchmarkContext(benchmarkDir: string, slug: string): BenchmarkContext {
  let results: BenchmarkResults | null = null;
  let environment: EnvironmentSnapshot | null = null;

  const resultsPath = join(benchmarkDir, slug, 'results.json');
  if (existsSync(resultsPath)) {
    results = JSON.parse(readFileSync(resultsPath, 'utf-8')) as BenchmarkResults;
  }

  const envPath = join(benchmarkDir, slug, 'environment.json');
  if (existsSync(envPath)) {
    environment = JSON.parse(readFileSync(envPath, 'utf-8')) as EnvironmentSnapshot;
  }

  const table = results ? formatBenchmarkTable(results) : '(no benchmark data)';
  const methodologyRef = environment ? formatMethodologyRef(environment, slug) : '';

  return { results, environment, table, methodologyRef };
}
