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
import { fitNaturalCopy, SUBSTACK_SUBTITLE_MAX_CHARS } from './platform-copy.js';
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
  uploadChecklistPath: string;
  tables: PortableTableSource[];
}

export interface RenderSubstackPasteResult {
  content: string;
  uploadChecklist: string;
  tables: PortableTableSource[];
}

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

function canonicalUrl(slug: string, config: BlogConfig): string {
  return `${config.site.base_url.replace(/\/+$/, '')}/writing/${slug}`;
}

function publicTableUrl(slug: string, config: BlogConfig, path: string): string {
  return `${canonicalUrl(slug, config)}/${path}`;
}

function tableCaption(table: PortableTableSource, index: number, canonical: string): string {
  return `Table ${index + 1}: ${table.alt.replace(/^Table:\s*/, '')}. Full-fidelity semantic table: ${canonical}.`;
}

export function renderSubstackUploadChecklist(
  slug: string,
  config: BlogConfig,
  tables: PortableTableSource[],
): string {
  const canonical = canonicalUrl(slug, config);
  const lines = [
    `# Substack upload checklist: ${slug}`,
    '',
    '## Editor constraints',
    '',
    '- Substack post editing does not support Markdown table syntax as the durable insertion path.',
    '- Substack does not support custom HTML/CSS tables in the post editor.',
    '- Use image upload or drag/drop for generated table PNGs.',
    '- Public portable-table URLs are reference-only, not the primary insertion path.',
    '',
    `Canonical source URL: ${canonical}`,
    '',
    '## Table uploads',
    '',
  ];

  if (tables.length === 0) {
    lines.push('- No generated table images for this article.');
  } else {
    for (const [index, table] of tables.entries()) {
      lines.push(
        `### Table ${index + 1}`,
        '',
        `- Local file: \`./${table.path}\``,
        `- Public reference only: ${publicTableUrl(slug, config, table.path)}`,
        `- Alt text: ${table.alt}`,
        `- Caption: ${tableCaption(table, index, canonical)}`,
        '',
      );
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function subtitleFallback(title: string): string {
  return `Technical notes and evidence for ${title}.`;
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
  const uploadChecklistPath = writeSubstackUploadChecklist(slug, rendered.uploadChecklist, paths);

  return { path: outputPath, uploadChecklistPath, tables: rendered.tables };
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
    referenceMode: 'placeholder',
    platformName: 'Substack',
    checklistPath: 'substack-upload-checklist.md',
  });

  const canonical = canonicalUrl(slug, config);
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
    `## ${fitNaturalCopy(
      fm.description,
      SUBSTACK_SUBTITLE_MAX_CHARS,
      'Substack subtitle',
      subtitleFallback(fm.title),
    )}`,
    '',
    `![${imageAlt(fm.title, substackImage.spec.altSuffix)}](${imageUrl})`,
    '',
    portable.markdown.trim(),
    '',
    '---',
    '',
    `*Originally published at [${display}](${canonical})*`,
    '',
  ].join('\n');

  return {
    content: paste,
    uploadChecklist: renderSubstackUploadChecklist(slug, config, portable.tables),
    tables: portable.tables,
  };
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

export function writeSubstackUploadChecklist(
  slug: string,
  content: string,
  paths: Pick<SubstackPaths, 'socialDir'>,
): string {
  const outputPath = join(paths.socialDir, slug, 'substack-upload-checklist.md');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, 'utf-8');
  return outputPath;
}
