import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

import { Mode, ContentType } from '../db/types.js';

export interface ResearchDocument {
  slug: string;
  topic: string;
  mode: Mode;
  content_type: ContentType;
  created_at: string;
  thesis: string;
  findings: string;
  sources_list: string;
  data_points: string;
  open_questions: string;
  benchmark_targets: string;
  repo_scope: string;
}

export const REQUIRED_SECTIONS = [
  'Thesis',
  'Key Findings',
  'Sources',
  'Data Points',
  'Open Questions',
  'Benchmark Targets',
  'Suggested Companion Repo Scope',
] as const;

function getTemplatePath(): string {
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(here), '../../../templates/research/template.md');
}

const SAFE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function validateSlug(slug: string): void {
  if (!SAFE_SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid slug: '${slug}'. Slugs must be lowercase alphanumeric with hyphens, ` +
      `no leading/trailing hyphens, and no path separators.`,
    );
  }
}

function renderFrontmatter(doc: ResearchDocument): string {
  const fm = yaml.dump(
    {
      slug: doc.slug,
      topic: doc.topic,
      mode: doc.mode,
      content_type: doc.content_type,
      created_at: doc.created_at,
    },
    { lineWidth: -1, quotingType: '"', forceQuotes: false },
  );
  return `---\n${fm}---`;
}

function renderBody(doc: ResearchDocument): string {
  const template = readFileSync(getTemplatePath(), 'utf-8');
  const bodyMatch = template.match(/^---[\s\S]*?^---\s*\n([\s\S]*)$/m);
  const body = bodyMatch ? bodyMatch[1] : template;
  return body
    .replace(/\{\{topic\}\}/g, doc.topic)
    .replace(/\{\{thesis\}\}/g, doc.thesis)
    .replace(/\{\{findings\}\}/g, doc.findings)
    .replace(/\{\{sources_list\}\}/g, doc.sources_list)
    .replace(/\{\{data_points\}\}/g, doc.data_points)
    .replace(/\{\{open_questions\}\}/g, doc.open_questions)
    .replace(/\{\{benchmark_targets\}\}/g, doc.benchmark_targets)
    .replace(/\{\{repo_scope\}\}/g, doc.repo_scope);
}

function renderTemplate(doc: ResearchDocument): string {
  return `${renderFrontmatter(doc)}\n${renderBody(doc)}`;
}

export function documentPath(researchDir: string, slug: string): string {
  return join(researchDir, `${slug}.md`);
}

export function writeResearchDocument(
  researchDir: string,
  doc: ResearchDocument,
  options: { force?: boolean } = {},
): string {
  validateSlug(doc.slug);
  const target = documentPath(researchDir, doc.slug);
  const rel = relative(resolve(researchDir), resolve(target));
  if (isAbsolute(rel) || rel.startsWith('..')) {
    throw new Error(`Document path escapes research directory: ${resolve(target)}`);
  }
  if (existsSync(target) && !options.force) {
    throw new Error(`Research document already exists: ${target}. Pass force=true to overwrite.`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderTemplate(doc), 'utf-8');
  return target;
}

function parseFrontmatter(content: string, sourcePath: string): Record<string, unknown> {
  const parts = content.split(/^---$/m);
  if (parts.length < 3) {
    throw new Error(`Research doc missing frontmatter: ${sourcePath}`);
  }
  const parsed = yaml.load(parts[1]);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Research doc frontmatter is not an object: ${sourcePath}`);
  }
  return parsed as Record<string, unknown>;
}

function splitSections(body: string): Record<string, string> {
  const lines = body.split('\n');
  const sections: Record<string, string> = {};
  let currentHeading: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (currentHeading !== null) {
      sections[currentHeading] = buffer.join('\n').trim();
    }
  };

  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      currentHeading = match[1];
      buffer = [];
    } else if (currentHeading !== null) {
      buffer.push(line);
    }
  }
  flush();

  return sections;
}

function bodyAfterFrontmatter(raw: string): string {
  const firstDelim = raw.indexOf('---');
  if (firstDelim === -1) return raw;
  const secondDelim = raw.indexOf('---', firstDelim + 3);
  if (secondDelim === -1) return raw;
  return raw.slice(secondDelim + 3);
}

export function readResearchDocument(docPath: string): ResearchDocument {
  if (!existsSync(docPath)) {
    throw new Error(`Research document not found: ${docPath}`);
  }
  const raw = readFileSync(docPath, 'utf-8');
  const frontmatter = parseFrontmatter(raw, docPath);

  const sections = splitSections(bodyAfterFrontmatter(raw));
  const field = (heading: string): string => sections[heading] ?? '';

  // js-yaml parses unquoted ISO-8601 timestamps into Date objects.
  // Normalize back to the ISO string we wrote.
  const createdRaw = frontmatter.created_at;
  const createdAt = createdRaw instanceof Date
    ? createdRaw.toISOString()
    : String(createdRaw ?? '');

  return {
    slug: String(frontmatter.slug ?? ''),
    topic: String(frontmatter.topic ?? ''),
    mode: frontmatter.mode as Mode,
    content_type: frontmatter.content_type as ContentType,
    created_at: createdAt,
    thesis: field('Thesis'),
    findings: field('Key Findings'),
    sources_list: field('Sources'),
    data_points: field('Data Points'),
    open_questions: field('Open Questions'),
    benchmark_targets: field('Benchmark Targets'),
    repo_scope: field('Suggested Companion Repo Scope'),
  };
}

export interface ValidationResult {
  ok: boolean;
  missing: string[];
  empty: string[];
}

export function validateResearchDocument(docPath: string): ValidationResult {
  if (!existsSync(docPath)) {
    throw new Error(`Research document not found: ${docPath}`);
  }
  const raw = readFileSync(docPath, 'utf-8');
  parseFrontmatter(raw, docPath);

  const sections = splitSections(bodyAfterFrontmatter(raw));

  const missing: string[] = [];
  const empty: string[] = [];

  for (const heading of REQUIRED_SECTIONS) {
    if (!(heading in sections)) {
      missing.push(heading);
      continue;
    }
    const body = sections[heading].trim();
    const isPlaceholder = body.startsWith('{{') && body.endsWith('}}');
    if (body.length === 0 || isPlaceholder) empty.push(heading);
  }

  return {
    ok: missing.length === 0 && empty.length === 0,
    missing,
    empty,
  };
}
