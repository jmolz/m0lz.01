import { ContentType } from '../db/types.js';

export type { ContentType };

const BENCHMARK_KEYWORDS = [
  'benchmark', 'benchmarks', 'compare', 'comparison',
  'measure', 'performance', 'latency', 'throughput',
];

const CATALOG_PATTERN = /^m0lz\.\d+$/;

// Generic catalog-style ID: lowercase letters start, optional letters/digits,
// required `.\d+` suffix. Matches `m0lz.01`, `project.42`, `repo.7`. Not
// anchored to any one owner's identity so the agent works for any author.
const PROMPT_PROJECT_PATTERN = /\b([a-z][a-z0-9]*\.\d+)\b/i;

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

// Best-effort extraction of a catalog-style project ID from the prompt text.
// Returns the first match lowercased (`M0LZ.01` → `m0lz.01`), or null when
// the prompt contains no match. Called by the research CLI after the explicit
// `--project` flag check: operators usually mention the project ID in the
// prompt itself, so requiring the flag separately would be redundant for the
// common case.
export function extractProjectIdFromPrompt(prompt: string): string | null {
  const match = prompt.match(PROMPT_PROJECT_PATTERN);
  if (!match) return null;
  return match[1].toLowerCase();
}
