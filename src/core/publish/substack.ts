import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BlogConfig } from '../config/types.js';
import { parseFrontmatter } from '../draft/frontmatter.js';
import { mdxToMarkdown } from './convert.js';

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

export function generateSubstackPaste(
  slug: string,
  config: BlogConfig,
  paths: SubstackPaths,
): SubstackResult {
  const draftPath = join(paths.draftsDir, slug, 'index.mdx');
  const mdx = readFileSync(draftPath, 'utf-8');

  const fm = parseFrontmatter(mdx);
  const { body } = splitMdx(mdx);
  const markdownBody = mdxToMarkdown(body, slug, config.site.base_url);

  const canonicalUrl = `${config.site.base_url.replace(/\/+$/, '')}/writing/${slug}`;
  const display = displayBaseUrl(config.site.base_url);

  const paste = [
    `# ${fm.title}`,
    '',
    `## ${fm.description}`,
    '',
    markdownBody.trim(),
    '',
    '---',
    '',
    `*Originally published at [${display}](${canonicalUrl})*`,
    '',
  ].join('\n');

  const outputPath = join(paths.socialDir, slug, 'substack-paste.md');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, paste, 'utf-8');

  return { path: outputPath };
}
