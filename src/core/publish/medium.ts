import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BlogConfig } from '../config/types.js';
import { parseFrontmatter } from '../draft/frontmatter.js';
import { mdxToMarkdown } from './convert.js';
import { MEDIUM_FEATURED_IMAGE, resolvePlatformImageUrl } from './platform-images.js';
import { derivePortableTables, PortableTableSource } from './table-assets.js';

// Step 6 of the publish pipeline: generate a paste-ready Markdown file for
// Medium. The Medium Integration Token API has been deprecated, so this step
// deliberately does NOT call any API — the author copies/pastes the produced
// file into Medium's editor. See CLAUDE.md "Fallback is structural" for the
// design rationale: cross-post pipelines never block on unreliable APIs.

export interface MediumPaths {
  draftsDir: string; // .blog-agent/drafts
  socialDir: string; // .blog-agent/social
}

export interface MediumResult {
  path: string;
  uploadChecklistPath: string;
  tables: PortableTableSource[];
}

export interface RenderMediumPasteResult {
  content: string;
  uploadChecklist: string;
  tables: PortableTableSource[];
}

// Strip protocol + trailing slashes from a URL so it can be displayed inline
// (e.g., `https://m0lz.dev/` → `m0lz.dev`). The result is used inside a
// Markdown link label, so we keep it deliberately terse.
function displayBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
}

// Split an MDX file into (frontmatter region, body). The frontmatter region
// includes the delimiters so the caller can hand it to yaml-aware parsers;
// the body is everything after the closing `---` line. Returns the whole
// content as body when no frontmatter is present.
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

export function renderMediumUploadChecklist(
  slug: string,
  config: BlogConfig,
  tables: PortableTableSource[],
): string {
  const canonical = canonicalUrl(slug, config);
  const lines = [
    `# Medium upload checklist: ${slug}`,
    '',
    '## Preferred workflow',
    '',
    `1. Import the canonical article URL in Medium: ${canonical}`,
    '2. Verify Medium preserved the canonical link after import.',
    '3. If import or paste loses table fidelity, upload or drag in the local table PNGs below.',
    '',
    '## Manual paste fallback',
    '',
    `- Set or verify the canonical link manually: ${canonical}`,
    '- Medium embeds are provider-gated; do not depend on arbitrary portable-table PNG URLs becoming inline image blocks.',
    '- Use the public URLs only as reference links. Upload the local PNG files for table images.',
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

export function generateMediumPaste(
  slug: string,
  config: BlogConfig,
  paths: MediumPaths,
): MediumResult {
  const draftPath = join(paths.draftsDir, slug, 'index.mdx');
  const mdx = readFileSync(draftPath, 'utf-8');
  const rendered = renderMediumPaste(slug, config, mdx);
  const outputPath = writeMediumPaste(slug, rendered.content, paths);
  const uploadChecklistPath = writeMediumUploadChecklist(slug, rendered.uploadChecklist, paths);

  return { path: outputPath, uploadChecklistPath, tables: rendered.tables };
}

export function renderMediumPaste(
  slug: string,
  config: BlogConfig,
  mdx: string,
): RenderMediumPasteResult {
  const fm = parseFrontmatter(mdx);
  const { body } = splitMdx(mdx);
  const markdownBody = mdxToMarkdown(body, slug, config.site.base_url);
  const portable = derivePortableTables(markdownBody, {
    slug,
    baseUrl: config.site.base_url,
    title: fm.title,
    referenceMode: 'placeholder',
    platformName: 'Medium',
    checklistPath: 'medium-upload-checklist.md',
  });

  const canonical = canonicalUrl(slug, config);
  const display = displayBaseUrl(config.site.base_url);
  const imageUrl = resolvePlatformImageUrl(
    fm.medium_featured_image,
    slug,
    config.site.base_url,
    MEDIUM_FEATURED_IMAGE,
  );

  const paste = [
    `# ${fm.title}`,
    '',
    fm.description,
    '',
    `![${imageAlt(fm.title, MEDIUM_FEATURED_IMAGE.altSuffix)}](${imageUrl})`,
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
    uploadChecklist: renderMediumUploadChecklist(slug, config, portable.tables),
    tables: portable.tables,
  };
}

export function writeMediumPaste(
  slug: string,
  content: string,
  paths: Pick<MediumPaths, 'socialDir'>,
): string {
  const outputPath = join(paths.socialDir, slug, 'medium-paste.md');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, 'utf-8');
  return outputPath;
}

export function writeMediumUploadChecklist(
  slug: string,
  content: string,
  paths: Pick<MediumPaths, 'socialDir'>,
): string {
  const outputPath = join(paths.socialDir, slug, 'medium-upload-checklist.md');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, 'utf-8');
  return outputPath;
}
