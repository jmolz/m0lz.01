import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Command } from 'commander';

import { getDatabase, closeDatabase } from '../core/db/database.js';
import { PostRow } from '../core/db/types.js';
import { printEnvelope } from '../core/json-envelope.js';

const DB_PATH = resolve('.blog-agent', 'state.db');

export interface StatusOptions {
  json?: boolean;
  dbPath?: string;
}

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Show all posts and their pipeline status')
    .option('--json', 'Emit JSON envelope for machine consumers')
    .action((opts: StatusOptions) => {
      runStatus(opts);
    });
}

interface WorkspaceStatusPost {
  slug: string;
  phase: string;
  mode: string;
  content_type: string | null;
  published_at: string | null;
  created_at: string | null;
}

interface WorkspaceStatusData {
  workspace_root: string;
  posts: WorkspaceStatusPost[];
  totals: { total: number; published: number; in_progress: number };
}

export function runStatus(opts: StatusOptions = {}): void {
  const dbPath = opts.dbPath ?? DB_PATH;
  if (!existsSync(dbPath)) {
    if (opts.json) {
      printEnvelope<'WorkspaceStatus', WorkspaceStatusData>('WorkspaceStatus', {
        workspace_root: resolve('.'),
        posts: [],
        totals: { total: 0, published: 0, in_progress: 0 },
      });
      return;
    }
    console.error("No state database found. Run 'blog init' first.");
    process.exit(1);
  }

  const db = getDatabase(dbPath);
  try {
    const posts = db.prepare('SELECT * FROM posts ORDER BY created_at DESC').all() as PostRow[];

    if (opts.json) {
      const data: WorkspaceStatusData = {
        workspace_root: resolve('.'),
        posts: posts.map((p) => ({
          slug: p.slug,
          phase: p.phase,
          mode: p.mode,
          content_type: p.content_type ?? null,
          published_at: p.published_at ?? null,
          created_at: p.created_at ?? null,
        })),
        totals: {
          total: posts.length,
          published: posts.filter((p) => p.phase === 'published').length,
          in_progress: posts.filter((p) => p.phase !== 'published').length,
        },
      };
      printEnvelope<'WorkspaceStatus', WorkspaceStatusData>('WorkspaceStatus', data);
      return;
    }

    if (posts.length === 0) {
      console.log("No posts yet. Run 'blog init --import' or '/blog-research' to get started.");
      return;
    }

    const slugW = Math.max(4, ...posts.map((p) => p.slug.length));
    const phaseW = Math.max(5, ...posts.map((p) => p.phase.length));
    const modeW = Math.max(4, ...posts.map((p) => p.mode.length));

    console.log(
      'slug'.padEnd(slugW) +
        '  ' +
        'phase'.padEnd(phaseW) +
        '  ' +
        'mode'.padEnd(modeW) +
        '  ' +
        'type',
    );

    for (const post of posts) {
      console.log(
        post.slug.padEnd(slugW) +
          '  ' +
          post.phase.padEnd(phaseW) +
          '  ' +
          post.mode.padEnd(modeW) +
          '  ' +
          (post.content_type || '-'),
      );
    }

    const published = posts.filter((p) => p.phase === 'published').length;
    const inProgress = posts.length - published;
    console.log(`\n${posts.length} posts (${published} published, ${inProgress} in progress)`);
  } finally {
    closeDatabase(db);
  }
}
