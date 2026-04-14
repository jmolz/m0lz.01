import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import yaml from 'js-yaml';

interface PostFrontmatter {
  title: string;
  description: string;
  date: string;
  tags: string[];
  published: boolean;
  canonical?: string;
  companion_repo?: string;
  project?: string;
  medium_url?: string;
  devto_url?: string;
}

export function importPosts(db: Database.Database, siteRepoPath: string, baseUrl: string, contentDir = 'content/posts'): number {
  const postsDir = join(siteRepoPath, contentDir);

  if (!existsSync(postsDir)) {
    throw new Error(`Posts directory not found: ${postsDir}`);
  }

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO posts (
      slug, title, topic, content_type, phase, mode,
      site_url, devto_url, medium_url, repo_url, project_id,
      published_at
    ) VALUES (
      @slug, @title, @topic, @content_type, @phase, @mode,
      @site_url, @devto_url, @medium_url, @repo_url, @project_id,
      @published_at
    )
  `);

  let imported = 0;

  const dirs = readdirSync(postsDir).filter((name) => {
    const fullPath = join(postsDir, name);
    return statSync(fullPath).isDirectory();
  });

  const importAll = db.transaction(() => {
    for (const slug of dirs) {
      const mdxPath = join(postsDir, slug, 'index.mdx');
      if (!existsSync(mdxPath)) continue;

      const content = readFileSync(mdxPath, 'utf-8');
      const frontmatter = parseFrontmatter(content, mdxPath);
      if (!frontmatter) continue;

      const result = insertStmt.run({
        slug,
        title: frontmatter.title || null,
        topic: frontmatter.description || null,
        content_type: frontmatter.project ? 'project-launch' : null,
        phase: frontmatter.published ? 'published' : 'draft',
        mode: 'imported',
        site_url: `${baseUrl}/writing/${slug}`,
        devto_url: frontmatter.devto_url || null,
        medium_url: frontmatter.medium_url || null,
        repo_url: frontmatter.companion_repo || null,
        project_id: frontmatter.project || null,
        published_at: frontmatter.date || null,
      });

      if (result.changes > 0) {
        imported++;
      }
    }
  });

  importAll();
  return imported;
}

function parseFrontmatter(content: string, sourcePath: string): PostFrontmatter | null {
  const parts = content.split(/^---$/m);
  if (parts.length < 3) {
    console.warn(`Skipping ${sourcePath}: no frontmatter delimiters`);
    return null;
  }

  try {
    const parsed = yaml.load(parts[1]) as PostFrontmatter | undefined;
    if (!parsed || typeof parsed !== 'object') {
      console.warn(`Skipping ${sourcePath}: frontmatter is not an object`);
      return null;
    }
    if (!parsed.title) {
      console.warn(`Skipping ${sourcePath}: frontmatter missing required 'title' field`);
      return null;
    }
    return parsed;
  } catch (e) {
    console.warn(`Skipping ${sourcePath}: failed to parse frontmatter -- ${(e as Error).message}`);
    return null;
  }
}
