import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';

// Phase 7: Substack has no unpublish API. Same strategy as Medium — emit
// a markdown checklist the operator follows manually.

export interface SubstackInstructionsResult {
  path: string;
}

export function generateSubstackRemovalInstructions(
  db: Database.Database,
  slug: string,
  socialDir: string,
): SubstackInstructionsResult {
  const row = db
    .prepare('SELECT title, substack_url FROM posts WHERE slug = ?')
    .get(slug) as { title: string | null; substack_url: string | null } | undefined;
  const title = row?.title ?? slug;
  const substackUrl = row?.substack_url ?? '(no substack_url recorded on publish)';

  const outPath = join(socialDir, slug, 'substack-removal.md');
  mkdirSync(dirname(outPath), { recursive: true });
  const body =
    `# Substack manual-removal instructions: ${title}\n\n` +
    `Substack has no delete/unpublish API. Follow these steps manually:\n\n` +
    `1. Open the Substack cross-post: ${substackUrl}\n` +
    `2. Click "Edit" on the post → scroll to the bottom → "Unpublish".\n` +
    `3. If subscribers already received the email, Substack cannot retract it.\n` +
    `   Consider sending a follow-up note through the same publication.\n` +
    `4. Confirm the post no longer resolves publicly before closing this task.\n\n` +
    `When done, check this item off in your ops log; the unpublish pipeline\n` +
    `already treats this step as completed (no back-channel to Substack).\n`;
  writeFileSync(outPath, body, 'utf-8');
  return { path: outPath };
}
