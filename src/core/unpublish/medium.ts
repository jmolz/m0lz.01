import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';

// Phase 7: Medium has no unpublish API. We emit a markdown file with
// explicit manual-removal instructions (including the stored medium_url
// when available) so the operator has a clear checklist to follow.

export interface MediumInstructionsResult {
  path: string;
}

export function generateMediumRemovalInstructions(
  db: Database.Database,
  slug: string,
  socialDir: string,
): MediumInstructionsResult {
  const row = db
    .prepare('SELECT title, medium_url FROM posts WHERE slug = ?')
    .get(slug) as { title: string | null; medium_url: string | null } | undefined;
  const title = row?.title ?? slug;
  const mediumUrl = row?.medium_url ?? '(no medium_url recorded on publish)';

  const outPath = join(socialDir, slug, 'medium-removal.md');
  mkdirSync(dirname(outPath), { recursive: true });
  const body =
    `# Medium manual-removal instructions: ${title}\n\n` +
    `Medium has no delete/unpublish API. Follow these steps manually:\n\n` +
    `1. Open the Medium cross-post: ${mediumUrl}\n` +
    `2. Click the "..." menu on the story page → "Unpublish" (moves to drafts)\n` +
    `   OR "Delete" (permanent removal).\n` +
    `3. If the post was republished under a publication, repeat inside the publication's edit view.\n` +
    `4. Confirm the post no longer resolves publicly before closing this task.\n\n` +
    `When done, check this item off in your ops log; the unpublish pipeline\n` +
    `already treats this step as completed (no back-channel to Medium).\n`;
  writeFileSync(outPath, body, 'utf-8');
  return { path: outPath };
}
