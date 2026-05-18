import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BlogConfig } from '../config/types.js';
import { parseFrontmatter } from '../draft/frontmatter.js';
import { mdxToMarkdown } from './convert.js';
import {
  SUBSTACK_HEADER_IMAGE,
  SUBSTACK_PREVIEW_IMAGE,
  resolvePlatformImageUrl,
} from './platform-images.js';
import { derivePortableTables, PortableTableSource } from './table-assets.js';

// Step 7 of the publish pipeline: generate a paste-ready Markdown file for
// Substack. Substack has no official publishing API; the author pastes this
// file into the Substack post editor. Differs from Medium in one shape:
// Substack treats the first H1 as the post title and the following H2 as a
// subtitle, so we promote the description to an H2 rather than a paragraph.

export interface SubstackPaths {
  draftsDir: string; // .blog-agent/drafts
  socialDir: string; // .blog-agent/social
}

export interface SubstackResult {
  path: string;
  tables: PortableTableSource[];
}

export interface RenderSubstackPasteResult {
  content: string;
  tables: PortableTableSource[];
}

const SUBSTACK_SUBTITLE_MAX_CHARS = 120;

function displayBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
}

function splitMdx(mdx: string): { frontmatter: string; body: string } {
  const match = mdx.match(/^---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
  if (!match) {
    return { frontmatter: '', body: mdx };
  }
  return {
    frontmatter: match[0],
    body: mdx.slice(match[0].length),
  };
}

function imageAlt(title: string, suffix: string): string {
  return `${title} ${suffix}`.replace(/[\[\]]/g, '');
}

function truncateDescription(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;

  const sentenceEnd = normalized.match(/^(.+?[.!?])(?:\s|$)/);
  if (sentenceEnd && sentenceEnd[1].length <= maxChars) {
    return sentenceEnd[1];
  }

  const limit = Math.max(0, maxChars - 3);
  const clipped = normalized.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(' ');
  const base = lastSpace >= Math.floor(limit * 0.7)
    ? clipped.slice(0, lastSpace)
    : clipped;
  return `${base.trimEnd()}...`;
}

export function generateSubstackPaste(
  slug: string,
  config: BlogConfig,
  paths: SubstackPaths,
): SubstackResult {
  const draftPath = join(paths.draftsDir, slug, 'index.mdx');
  const mdx = readFileSync(draftPath, 'utf-8');
  const rendered = renderSubstackPaste(slug, config, mdx);
  const outputPath = writeSubstackPaste(slug, rendered.content, paths);

  return { path: outputPath, tables: rendered.tables };
}

export function renderSubstackPaste(
  slug: string,
  config: BlogConfig,
  mdx: string,
): RenderSubstackPasteResult {
  const fm = parseFrontmatter(mdx);
  const { body } = splitMdx(mdx);
  const markdownBody = mdxToMarkdown(body, slug, config.site.base_url);
  const portable = derivePortableTables(markdownBody, {
    slug,
    baseUrl: config.site.base_url,
    title: fm.title,
  });

  const canonicalUrl = `${config.site.base_url.replace(/\/+$/, '')}/writing/${slug}`;
  const display = displayBaseUrl(config.site.base_url);
  const substackImage = fm.substack_preview_image !== undefined
    ? { rawValue: fm.substack_preview_image, spec: SUBSTACK_PREVIEW_IMAGE }
    : { rawValue: fm.substack_header_image, spec: fm.substack_header_image ? SUBSTACK_HEADER_IMAGE : SUBSTACK_PREVIEW_IMAGE };
  const imageUrl = resolvePlatformImageUrl(
    substackImage.rawValue,
    slug,
    config.site.base_url,
    substackImage.spec,
  );

  const paste = [
    `# ${fm.title}`,
    '',
    `## ${truncateDescription(fm.description, SUBSTACK_SUBTITLE_MAX_CHARS)}`,
    '',
    `![${imageAlt(fm.title, substackImage.spec.altSuffix)}](${imageUrl})`,
    '',
    portable.markdown.trim(),
    '',
    '---',
    '',
    `*Originally published at [${display}](${canonicalUrl})*`,
    '',
  ].join('\n');

  return { content: paste, tables: portable.tables };
}

export function writeSubstackPaste(
  slug: string,
  content: string,
  paths: Pick<SubstackPaths, 'socialDir'>,
): string {
  const outputPath = join(paths.socialDir, slug, 'substack-paste.md');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, 'utf-8');
  return outputPath;
}
