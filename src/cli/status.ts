import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Command } from 'commander';

import { getDatabase, closeDatabase } from '../core/db/database.js';
import { PostRow } from '../core/db/types.js';

const DB_PATH = resolve('.blog-agent', 'state.db');

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Show all posts and their pipeline status')
    .action(() => {
      runStatus();
    });
}

export function runStatus(dbPath = DB_PATH): void {
  if (!existsSync(dbPath)) {
    console.error("No state database found. Run 'blog init' first.");
    process.exit(1);
  }

  const db = getDatabase(dbPath);

  const posts = db.prepare('SELECT * FROM posts ORDER BY created_at DESC').all() as PostRow[];

  if (posts.length === 0) {
    console.log("No posts yet. Run 'blog init --import' or '/blog-research' to get started.");
    closeDatabase(db);
    return;
  }

  // Column widths
  const slugW = Math.max(4, ...posts.map((p) => p.slug.length));
  const phaseW = Math.max(5, ...posts.map((p) => p.phase.length));
  const modeW = Math.max(4, ...posts.map((p) => p.mode.length));
  const typeW = Math.max(4, ...posts.map((p) => (p.content_type || '-').length));

  // Header
  console.log(
    'slug'.padEnd(slugW) + '  ' +
    'phase'.padEnd(phaseW) + '  ' +
    'mode'.padEnd(modeW) + '  ' +
    'type'
  );

  // Rows
  for (const post of posts) {
    console.log(
      post.slug.padEnd(slugW) + '  ' +
      post.phase.padEnd(phaseW) + '  ' +
      post.mode.padEnd(modeW) + '  ' +
      (post.content_type || '-')
    );
  }

  // Summary
  const published = posts.filter((p) => p.phase === 'published').length;
  const inProgress = posts.length - published;
  console.log(`\n${posts.length} posts (${published} published, ${inProgress} in progress)`);

  closeDatabase(db);
}
