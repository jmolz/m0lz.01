import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { BlogConfig } from '../config/types.js';
import { PostRow } from '../db/types.js';
import { parseFrontmatter } from '../draft/frontmatter.js';

// Step 11 of the publish pipeline: generate paste-ready social text for
// LinkedIn and Hacker News. Templates live in `templates/social/` and are
// filled with post metadata + config values. The pipeline never auto-posts;
// it produces text files the author copies into each platform.
//
// Design constraints:
//   - No emojis anywhere in generated text (enforced by containsEmoji check)
//   - Config values (URLs, author info) are threaded, never hardcoded
//   - Templates use `{{token}}` placeholders, same pattern as draft templates

export interface SocialPaths {
  socialDir: string;
  templatesDir: string;
  draftsDir: string;
}

export interface SocialResult {
  linkedinPath: string;
  hackerNewsPath: string;
}

// Emoji detection regex. Uses unicode escape sequences exclusively — no
// literal emoji characters in source. Covers the most common emoji ranges:
//   U+1F300..U+1FAFF  (Miscellaneous Symbols and Pictographs through
//                       Symbols and Pictographs Extended-A)
//   U+2600..U+27BF    (Miscellaneous Symbols, Dingbats)
// eslint-disable-next-line no-misleading-character-class
const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

export function containsEmoji(text: string): boolean {
  return EMOJI_PATTERN.test(text);
}

// Extract the first sentence from a description, capped at maxLen characters.
// Falls back to truncation with ellipsis when no sentence boundary is found.
function extractTakeaway(description: string, maxLen: number): string {
  // Match the first sentence: text ending with a period, exclamation, or
  // question mark followed by whitespace or end-of-string.
  const sentenceMatch = description.match(/^[^.!?]*[.!?]/);
  if (sentenceMatch && sentenceMatch[0].length <= maxLen) {
    return sentenceMatch[0];
  }
  if (description.length <= maxLen) {
    return description;
  }
  return description.slice(0, maxLen - 3) + '...';
}

export function generateLinkedIn(
  post: PostRow,
  config: BlogConfig,
  socialDir: string,
  templatesDir: string,
  tags: string[],
): string {
  const templatePath = join(templatesDir, 'social', 'linkedin.md');
  if (!existsSync(templatePath)) {
    throw new Error(`LinkedIn template not found: ${templatePath}`);
  }
  const template = readFileSync(templatePath, 'utf-8');

  const canonicalUrl = `${config.site.base_url}/writing/${post.slug}`;
  const title = post.title ?? post.slug;
  const description = post.topic ?? '';
  const takeaway = extractTakeaway(description, 160);
  const hashtags = tags.map((t) => `#${t}`).join(' ');

  const timing = config.social.timing_recommendations
    ? 'Best posting times: Tuesday-Thursday, 8-10am'
    : '';

  let content = template
    .replace(/\{\{title\}\}/g, title)
    .replace(/\{\{description\}\}/g, description)
    .replace(/\{\{takeaway\}\}/g, takeaway)
    .replace(/\{\{canonical_url\}\}/g, canonicalUrl)
    .replace(/\{\{hashtags\}\}/g, hashtags)
    .replace(/\{\{timing\}\}/g, timing);

  if (containsEmoji(content)) {
    throw new Error(
      `LinkedIn text for '${post.slug}' contains emoji characters. ` +
      `Remove emojis from the template or post metadata.`,
    );
  }

  const slugDir = join(socialDir, post.slug);
  mkdirSync(slugDir, { recursive: true });
  const outputPath = join(slugDir, 'linkedin.md');
  writeFileSync(outputPath, content, 'utf-8');

  return outputPath;
}

export function generateHackerNews(
  post: PostRow,
  config: BlogConfig,
  socialDir: string,
  templatesDir: string,
  repoUrl: string | undefined,
): string {
  const templatePath = join(templatesDir, 'social', 'hackernews.md');
  if (!existsSync(templatePath)) {
    throw new Error(`Hacker News template not found: ${templatePath}`);
  }
  const template = readFileSync(templatePath, 'utf-8');

  const canonicalUrl = `${config.site.base_url}/writing/${post.slug}`;
  const rawTitle = post.title ?? post.slug;

  // project-launch gets the "Show HN: " prefix per content type routing.
  let hnTitle = post.content_type === 'project-launch'
    ? `Show HN: ${rawTitle}`
    : rawTitle;

  // Truncate to 80 characters.
  if (hnTitle.length > 80) {
    hnTitle = hnTitle.slice(0, 77) + '...';
  }

  const description = post.topic ?? '';
  const repoLine = repoUrl ?? 'n/a';
  const firstComment = `${description}\n\nCompanion repo: ${repoLine}`;

  const timing = config.social.timing_recommendations
    ? 'Best posting times: Tuesday-Thursday, 8-10am'
    : '';

  let content = template
    .replace(/\{\{title\}\}/g, hnTitle)
    .replace(/\{\{canonical_url\}\}/g, canonicalUrl)
    .replace(/\{\{first_comment\}\}/g, firstComment)
    .replace(/\{\{repo_url\}\}/g, repoLine)
    .replace(/\{\{timing\}\}/g, timing);

  if (containsEmoji(content)) {
    throw new Error(
      `Hacker News text for '${post.slug}' contains emoji characters. ` +
      `Remove emojis from the template or post metadata.`,
    );
  }

  const slugDir = join(socialDir, post.slug);
  mkdirSync(slugDir, { recursive: true });
  const outputPath = join(slugDir, 'hackernews.md');
  writeFileSync(outputPath, content, 'utf-8');

  return outputPath;
}

export function generateSocialText(
  slug: string,
  config: BlogConfig,
  paths: SocialPaths,
  db: Database.Database,
): SocialResult {
  const post = db
    .prepare('SELECT * FROM posts WHERE slug = ?')
    .get(slug) as PostRow | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }

  // Read tags from the draft frontmatter. Falls back to an empty array if
  // the draft or its frontmatter is missing — social text is best-effort.
  let tags: string[] = [];
  const draftPath = join(paths.draftsDir, slug, 'index.mdx');
  if (existsSync(draftPath)) {
    try {
      const mdxContent = readFileSync(draftPath, 'utf-8');
      const fm = parseFrontmatter(mdxContent);
      tags = fm.tags;
    } catch {
      // Tolerate malformed frontmatter — generate social text without tags.
    }
  }

  // Retrieve the repo_url from the posts row (populated by the companion-repo
  // step earlier in the pipeline, or NULL if skipped).
  const repoUrl = post.repo_url ?? undefined;

  const linkedinPath = generateLinkedIn(
    post, config, paths.socialDir, paths.templatesDir, tags,
  );
  const hackerNewsPath = generateHackerNews(
    post, config, paths.socialDir, paths.templatesDir, repoUrl,
  );

  return { linkedinPath, hackerNewsPath };
}
