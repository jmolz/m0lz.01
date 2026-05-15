import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { BlogConfig } from '../config/types.js';
import { parseFrontmatter } from '../draft/frontmatter.js';
import { readBenchmarkSummary } from '../benchmark/results.js';
import { parseGitHubRemoteUrl, readOriginUrl } from './origin-guard.js';

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
  draftsDir: string; // .blog-agent/drafts — description sourced from draft frontmatter
  configPath?: string; // .blogrc.yaml — used to resolve config.projects relative paths
}

interface PostLookupRow {
  content_type: string | null;
  title: string | null;
  repo_url: string | null;
  project_id: string | null;
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

function renderTagsYaml(tags: string[]): string {
  const quoted = tags.map((t) => `"${t.replace(/"/g, '\\"')}"`);
  return `[${quoted.join(', ')}]`;
}

function renderProjectFrontmatter(projectId: string | null): string {
  if (!projectId) return '';
  return `project: "${projectId.replace(/"/g, '\\"')}"`;
}

function renderResearchTitle(title: string, projectId: string | null): string {
  if (!projectId) return `Research: ${title}`;
  return title.startsWith(projectId) ? title : `${projectId} Research: ${title}`;
}

function resolveResearchRepoUrl(
  slug: string,
  post: PostLookupRow,
  config: BlogConfig,
  configPath: string | undefined,
): string {
  if (post.repo_url) {
    return post.repo_url;
  }

  if (post.project_id && configPath && config.projects?.[post.project_id]) {
    try {
      const projectDir = resolve(dirname(configPath), config.projects[post.project_id]);
      const raw = readOriginUrl(projectDir);
      if (raw) {
        const parsed = parseGitHubRemoteUrl(raw);
        if (parsed) {
          return `https://github.com/${parsed.owner}/${parsed.name}`;
        }
      }
    } catch {
      // Best-effort enrichment. Research pages should still render when a
      // local project clone is missing or not a git repository.
    }
  }

  return `https://github.com/${config.author.github}/${slug}`;
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
    .prepare('SELECT content_type, title, repo_url, project_id FROM posts WHERE slug = ?')
    .get(slug) as PostLookupRow | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }

  // Description lives in the draft MDX frontmatter — the posts table has
  // no `description` column. Matches the pattern in medium.ts, substack.ts,
  // devto.ts. Empty string when the draft is absent or missing the field;
  // an absent draft is not fatal because the research page can still
  // render with the title alone.
  let description = '';
  const draftPath = join(paths.draftsDir, slug, 'index.mdx');
  if (existsSync(draftPath)) {
    try {
      const fm = parseFrontmatter(readFileSync(draftPath, 'utf-8'));
      description = fm.description ?? '';
    } catch {
      // Malformed frontmatter — fall back to empty description rather than
      // blocking the pipeline. site-pr will surface draft issues separately.
    }
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
  let benchmarkSummary: string | null = null;
  try {
    benchmarkSummary = readBenchmarkSummary(paths.benchmarkDir, slug);
  } catch {
    // Research page generation is best-effort for methodology enrichment.
    // Invalid benchmark results are rejected by benchmark/draft/evaluate gates;
    // this publisher-side enrichment simply omits the summary when the
    // canonical helper refuses the file.
    benchmarkSummary = null;
  }
  const methodologySummary = benchmarkSummary
    ?? (post.content_type === 'analysis-opinion' ? '' : '(no benchmark)');
  const openQuestions =
    extractSection(researchBody, /^#{1,6}\s+Open\s+Questions\b/i) ?? '(none listed)';
  const repoUrl = resolveResearchRepoUrl(slug, post, config, paths.configPath);
  const repoLink = `[companion repo](${repoUrl})`;

  const filled = fillTemplate(template, {
    title,
    research_title: renderResearchTitle(title, post.project_id),
    description,
    date,
    tags: tagsYaml,
    project_frontmatter: renderProjectFrontmatter(post.project_id),
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
