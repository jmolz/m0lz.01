import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';

import { BlogConfig } from '../config/types.js';

// Step 2 of the publish pipeline: generate the m0lz.00 research-companion
// MDX page for a post. The page lives alongside the post on the hub and
// surfaces the research artifacts (thesis, findings, bibliography) plus a
// methodology summary derived from benchmark results when present.
//
// The writer is a pure file-in/file-out transform: it reads the post row,
// the research document, optional benchmark summary, and a template, then
// writes `{researchPagesDir}/{slug}/index.mdx`. It does NOT copy into the
// site repo — the site-pr step (Task 8) picks the file up from
// researchPagesDir so research-page stays independently re-runnable.

export interface ResearchPageResult {
  path?: string;
  skipped?: boolean;
  reason?: string;
}

export interface ResearchPagePaths {
  researchDir: string; // .blog-agent/research
  benchmarkDir: string; // .blog-agent/benchmarks
  researchPagesDir: string; // .blog-agent/research-pages
  templatesDir: string; // templates/
}

interface PostLookupRow {
  content_type: string | null;
  title: string | null;
  description: string | null;
}

function extractSection(body: string, headingPattern: RegExp): string | null {
  const lines = body.split(/\r?\n/);
  let capture: string[] | null = null;
  for (const line of lines) {
    const isHeading = /^#{1,6}\s+/.test(line);
    if (isHeading) {
      if (capture !== null) {
        // Stop at the next heading of any level
        break;
      }
      if (headingPattern.test(line)) {
        capture = [];
        continue;
      }
    } else if (capture !== null) {
      capture.push(line);
    }
  }
  if (capture === null) return null;
  return capture.join('\n').trim();
}

function firstParagraph(body: string): string {
  // Skip frontmatter if the document starts with --- ... ---
  let content = body;
  const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
  if (fmMatch) {
    content = content.slice(fmMatch[0].length);
  }
  // Take first non-empty block split on blank lines, skipping leading headings
  const blocks = content.split(/\r?\n\s*\r?\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;
    if (/^#{1,6}\s+/.test(trimmed)) continue;
    return trimmed;
  }
  return '';
}

function extractBibliography(body: string): string {
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const seen = new Set<string>();
  const entries: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(body)) !== null) {
    const text = match[1];
    const url = match[2];
    if (seen.has(url)) continue;
    seen.add(url);
    entries.push(`- [${text}](${url})`);
  }
  return entries.length === 0 ? '(no sources listed)' : entries.join('\n');
}

function readBenchmarkSummary(benchmarkDir: string, slug: string): string | null {
  const resultsPath = join(benchmarkDir, slug, 'results.json');
  if (!existsSync(resultsPath)) return null;
  try {
    const raw = readFileSync(resultsPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const summary = parsed.summary;
    if (typeof summary === 'string' && summary.length > 0) {
      return summary;
    }
    // Tolerate object-shaped summary by JSON-stringifying it so the page
    // still has something meaningful rather than `[object Object]`.
    if (summary && typeof summary === 'object') {
      return JSON.stringify(summary, null, 2);
    }
    return null;
  } catch {
    return null;
  }
}

function renderTagsYaml(tags: string[]): string {
  const quoted = tags.map((t) => `"${t.replace(/"/g, '\\"')}"`);
  return `[${quoted.join(', ')}]`;
}

// Fill a single `{{placeholder}}` occurrence globally. The template is a
// plain text document with no code fences around placeholders (Cluster 5
// owns the template), so a plain string replace loop is sufficient.
function fillTemplate(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
    out = out.replace(pattern, value);
  }
  return out;
}

export function generateResearchPage(
  slug: string,
  config: BlogConfig,
  paths: ResearchPagePaths,
  db: Database.Database,
): ResearchPageResult {
  const post = db
    .prepare('SELECT content_type, title, description FROM posts WHERE slug = ?')
    .get(slug) as PostLookupRow | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }

  const researchDocPath = join(paths.researchDir, `${slug}.md`);
  const researchExists = existsSync(researchDocPath);

  if (post.content_type === 'analysis-opinion' && !researchExists) {
    return {
      skipped: true,
      reason: 'Analysis-opinion without research artifacts',
    };
  }

  if (!researchExists) {
    throw new Error(`Research document not found: ${researchDocPath}`);
  }

  const researchBody = readFileSync(researchDocPath, 'utf-8');

  const templatePath = join(paths.templatesDir, 'research-page', 'template.mdx');
  if (!existsSync(templatePath)) {
    throw new Error(`Template not found: ${templatePath}`);
  }
  const template = readFileSync(templatePath, 'utf-8');

  // Derive template variables.
  const title = post.title ?? slug;
  const description = post.description ?? '';
  const date = new Date().toISOString().slice(0, 10);
  const tagsYaml = renderTagsYaml([
    'research',
    post.content_type ?? 'technical-deep-dive',
  ]);
  const thesis = firstParagraph(researchBody);
  const findings =
    extractSection(researchBody, /^#{1,6}\s+(?:Key\s+)?Findings\b/i) ??
    '(findings pending)';
  const bibliography = extractBibliography(researchBody);
  const benchmarkSummary = readBenchmarkSummary(paths.benchmarkDir, slug);
  const methodologySummary = benchmarkSummary
    ?? (post.content_type === 'analysis-opinion' ? '' : '(no benchmark)');
  const openQuestions =
    extractSection(researchBody, /^#{1,6}\s+Open\s+Questions\b/i) ?? '(none listed)';
  const repoUrl = `https://github.com/${config.author.github}/${slug}`;
  const repoLink = `[companion repo](${repoUrl})`;

  const filled = fillTemplate(template, {
    title,
    description,
    date,
    tags: tagsYaml,
    thesis,
    findings,
    bibliography,
    methodology_summary: methodologySummary,
    open_questions: openQuestions,
    repo_url: repoUrl,
    repo_link: repoLink,
    post_title: title,
    slug,
  });

  const outputPath = join(paths.researchPagesDir, slug, 'index.mdx');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, filled, 'utf-8');

  return { path: outputPath };
}
