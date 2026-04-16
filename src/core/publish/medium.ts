import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BlogConfig } from '../config/types.js';
import { parseFrontmatter } from '../draft/frontmatter.js';
import { mdxToMarkdown } from './convert.js';

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

export function generateMediumPaste(
  slug: string,
  config: BlogConfig,
  paths: MediumPaths,
): MediumResult {
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
    fm.description,
    '',
    markdownBody.trim(),
    '',
    '---',
    '',
    `*Originally published at [${display}](${canonicalUrl})*`,
    '',
  ].join('\n');

  const outputPath = join(paths.socialDir, slug, 'medium-paste.md');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, paste, 'utf-8');

  return { path: outputPath };
}
