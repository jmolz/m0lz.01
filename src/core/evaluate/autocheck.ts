import { existsSync, readFileSync } from 'node:fs';

import Database from 'better-sqlite3';

import { PostRow } from '../db/types.js';
import { parseFrontmatter, validateFrontmatter, PostFrontmatter } from '../draft/frontmatter.js';
import { PLACEHOLDER_PATTERN, draftPath } from '../draft/state.js';
import { readResults, BenchmarkResults } from '../benchmark/results.js';
import { Issue, issueFingerprint } from './reviewer.js';

export interface AutocheckPaths {
  draftsDir: string;
  benchmarkDir: string;
  siteRepoPath?: string;
  siteContentDir?: string;
}

interface Draft {
  raw: string;
  frontmatter: PostFrontmatter | null;
  frontmatterError: string | null;
  body: string;
}

function loadDraft(draftsDir: string, slug: string): Draft | null {
  const mdxPath = draftPath(draftsDir, slug);
  if (!existsSync(mdxPath)) return null;
  const raw = readFileSync(mdxPath, 'utf-8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const body = match ? raw.slice(match[0].length) : raw;
  let frontmatter: PostFrontmatter | null = null;
  let frontmatterError: string | null = null;
  try {
    frontmatter = parseFrontmatter(raw);
  } catch (e) {
    frontmatterError = (e as Error).message;
  }
  return { raw, frontmatter, frontmatterError, body };
}

function makeIssue(
  category: string,
  severity: Issue['severity'],
  title: string,
  description: string,
): Issue {
  return {
    id: issueFingerprint('structural', title, description),
    category,
    severity,
    title,
    description,
    source: 'autocheck',
  };
}

function checkFrontmatter(draft: Draft, issues: Issue[]): void {
  if (draft.frontmatterError) {
    issues.push(makeIssue(
      'frontmatter-schema',
      'high',
      'Frontmatter failed to parse',
      draft.frontmatterError,
    ));
    return;
  }
  if (!draft.frontmatter) return;

  const result = validateFrontmatter(draft.frontmatter);
  if (!result.ok) {
    for (const err of result.errors) {
      const isPlaceholder = err.includes('placeholder');
      issues.push(makeIssue(
        isPlaceholder ? 'frontmatter-placeholder' : 'frontmatter-schema',
        'high',
        isPlaceholder ? 'Placeholder frontmatter value' : 'Frontmatter schema violation',
        err,
      ));
    }
  }
}

function checkPlaceholderSections(draft: Draft, issues: Issue[]): void {
  const matches = draft.body.match(PLACEHOLDER_PATTERN) || [];
  if (matches.length === 0) return;
  issues.push(makeIssue(
    'placeholder-section',
    'high',
    'Draft contains unfilled placeholder sections',
    `Found ${matches.length} placeholder marker(s) in draft body. Fill them before evaluation.`,
  ));
}

const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function extractLinks(body: string): Array<{ text: string; url: string }> {
  return Array.from(body.matchAll(LINK_RE)).map((m) => ({ text: m[1], url: m[2] }));
}

function collectHeadings(body: string): Set<string> {
  const headings = new Set<string>();
  const lines = body.split('\n');
  for (const line of lines) {
    const m = line.match(/^#+\s+(.+?)\s*$/);
    if (!m) continue;
    const slug = m[1]
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
    headings.add(slug);
  }
  return headings;
}

function checkBrokenLinks(
  draft: Draft,
  db: Database.Database,
  issues: Issue[],
): void {
  const links = extractLinks(draft.body);
  const headings = collectHeadings(draft.body);
  for (const { text, url } of links) {
    if (url.startsWith('#')) {
      const target = url.slice(1).toLowerCase();
      if (!headings.has(target)) {
        issues.push(makeIssue(
          'broken-internal-link',
          'medium',
          `Broken anchor link: ${url}`,
          `Link [${text}](${url}) targets a heading that does not exist in this draft.`,
        ));
      }
      continue;
    }
    if (url.startsWith('/writing/') || url.startsWith('/research/')) {
      const targetSlug = url.replace(/^\/(writing|research)\//, '').replace(/[/#?].*$/, '');
      if (targetSlug.length === 0) continue;
      const row = db.prepare('SELECT slug FROM posts WHERE slug = ?').get(targetSlug);
      if (!row) {
        issues.push(makeIssue(
          'broken-internal-link',
          'medium',
          `Broken internal link: ${url}`,
          `Link [${text}](${url}) references slug '${targetSlug}' which does not exist in the posts database.`,
        ));
      }
      continue;
    }
  }
}

function stripFencedBlocks(body: string): string {
  return body.replace(/```[\s\S]*?```/g, '');
}

function checkMdxParse(draft: Draft, issues: Issue[]): void {
  const body = draft.body;

  const fenceMatches = body.match(/^```/gm) || [];
  if (fenceMatches.length % 2 !== 0) {
    issues.push(makeIssue(
      'mdx-parse',
      'high',
      'Unbalanced code fences',
      'Draft contains an odd number of ``` fences — a code block is unclosed.',
    ));
  }

  const withoutFenced = stripFencedBlocks(body);
  const withoutInline = withoutFenced.replace(/`[^`\n]*`/g, '');
  const strayLt = withoutInline.match(/<(?![\/a-zA-Z!])/);
  if (strayLt) {
    issues.push(makeIssue(
      'mdx-parse',
      'high',
      'Unescaped `<` in MDX body',
      'Bare `<` outside a code block will be interpreted as JSX. Escape it as `&lt;` or wrap in backticks.',
    ));
  }
}

function checkBenchmarkClaims(
  slug: string,
  draft: Draft,
  benchmarkDir: string,
  issues: Issue[],
): void {
  let results: BenchmarkResults | null;
  try {
    results = readResults(benchmarkDir, slug);
  } catch {
    return;
  }
  if (!results) return;

  const knownNumbers = collectNumericTokens(results.data);
  if (knownNumbers.size === 0) return;

  const prose = stripFencedBlocks(draft.body);
  const numbers = prose.match(/\b\d+(?:\.\d+)?\b/g) || [];
  const unbacked = new Set<string>();
  for (const n of numbers) {
    const parsed = Number(n);
    if (!Number.isFinite(parsed) || parsed < 10) continue;
    if (!knownNumbers.has(n) && !knownNumbers.has(String(parsed))) {
      unbacked.add(n);
    }
  }
  for (const n of Array.from(unbacked).sort()) {
    issues.push(makeIssue(
      'benchmark-claim-unbacked',
      'medium',
      `Unbacked numeric claim: ${n}`,
      `The value '${n}' appears in the draft prose but does not match any number in results.json.`,
    ));
  }
}

function collectNumericTokens(data: unknown, acc: Set<string> = new Set()): Set<string> {
  if (data === null || data === undefined) return acc;
  if (typeof data === 'number' && Number.isFinite(data)) {
    acc.add(String(data));
    return acc;
  }
  if (typeof data === 'string') {
    const matches = data.match(/\b\d+(?:\.\d+)?\b/g) || [];
    for (const m of matches) acc.add(m);
    return acc;
  }
  if (Array.isArray(data)) {
    for (const item of data) collectNumericTokens(item, acc);
    return acc;
  }
  if (typeof data === 'object') {
    for (const value of Object.values(data as Record<string, unknown>)) {
      collectNumericTokens(value, acc);
    }
  }
  return acc;
}

function checkCompanionRepo(post: PostRow, draft: Draft, issues: Issue[]): void {
  if (!post.has_benchmarks) return;
  if (draft.frontmatter?.companion_repo && draft.frontmatter.companion_repo.length > 0) return;
  issues.push(makeIssue(
    'missing-companion-repo',
    'medium',
    'Missing companion_repo for benchmarked post',
    'Post has has_benchmarks=1 but the draft frontmatter has no companion_repo URL.',
  ));
}

export function runStructuralAutocheck(
  db: Database.Database,
  slug: string,
  paths: AutocheckPaths,
): Issue[] {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
  if (!post) return [];

  const draft = loadDraft(paths.draftsDir, slug);
  if (!draft) return [];

  const issues: Issue[] = [];
  checkFrontmatter(draft, issues);
  checkPlaceholderSections(draft, issues);
  checkMdxParse(draft, issues);
  checkBrokenLinks(draft, db, issues);
  checkBenchmarkClaims(slug, draft, paths.benchmarkDir, issues);
  checkCompanionRepo(post, draft, issues);

  issues.sort((a, b) => {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return issues;
}
