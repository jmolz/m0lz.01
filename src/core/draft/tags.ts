import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import yaml from 'js-yaml';

export function readExistingTags(siteRepoPath: string, contentDir: string): string[] {
  const postsDir = join(siteRepoPath, contentDir);

  if (!existsSync(postsDir)) {
    return [];
  }

  const tags = new Set<string>();

  const entries = readdirSync(postsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Look for index.mdx inside the directory
      const mdxPath = join(postsDir, entry.name, 'index.mdx');
      extractTags(mdxPath, tags);
    } else if (entry.isFile() && entry.name.endsWith('.mdx')) {
      extractTags(join(postsDir, entry.name), tags);
    }
  }

  return Array.from(tags).sort();
}

function extractTags(filePath: string, tags: Set<string>): void {
  if (!existsSync(filePath)) {
    return;
  }

  const content = readFileSync(filePath, 'utf-8');
  const parts = content.split(/^---$/m);
  if (parts.length < 3) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(parts[1]);
  } catch {
    return;
  }

  if (!parsed || typeof parsed !== 'object') {
    return;
  }

  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj.tags)) {
    for (const tag of obj.tags) {
      if (typeof tag === 'string' && tag.length > 0) {
        tags.add(tag);
      }
    }
  }
}
