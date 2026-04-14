import { ContentType } from '../db/types.js';

export type { ContentType };

const BENCHMARK_KEYWORDS = [
  'benchmark', 'benchmarks', 'compare', 'comparison',
  'measure', 'performance', 'latency', 'throughput',
];

const CATALOG_PATTERN = /^m0lz\.\d+$/;

export function detectContentType(prompt: string, projectId?: string): ContentType {
  // If a catalog project ID is provided, it's a project launch
  if (projectId && CATALOG_PATTERN.test(projectId)) {
    return 'project-launch';
  }

  // Check for benchmark-related keywords
  const lower = prompt.toLowerCase();
  if (BENCHMARK_KEYWORDS.some((kw) => lower.includes(kw))) {
    return 'technical-deep-dive';
  }

  // Default to analysis/opinion
  return 'analysis-opinion';
}
