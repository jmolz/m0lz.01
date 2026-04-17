import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { PostRow, BenchmarkRow, BenchmarkStatus, ContentType } from '../db/types.js';
import { BlogConfig, ContentTypesConfig } from '../config/types.js';
import { advancePhase } from '../research/state.js';
import { readResearchDocument } from '../research/document.js';
import { documentPath } from '../research/document.js';

export type BenchmarkRequirement = 'required' | 'optional' | 'skip';

export function getBenchmarkPost(db: Database.Database, slug: string): PostRow | undefined {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
  if (post && post.phase !== 'benchmark') {
    throw new Error(
      `Post '${slug}' is in phase '${post.phase}', not 'benchmark'. ` +
      `Benchmark commands only operate on posts in the benchmark phase.`,
    );
  }
  return post;
}

export function getBenchmarkRequirement(
  contentType: ContentType,
  config: BlogConfig,
): BenchmarkRequirement {
  const entry = (config.content_types as ContentTypesConfig)[contentType];
  if (!entry) {
    return 'required';
  }
  return entry.benchmark as BenchmarkRequirement;
}

export function initBenchmark(
  db: Database.Database,
  slug: string,
  benchmarkDir: string,
  researchDir: string,
): { targets: string[]; benchmarkPath: string } {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }
  if (post.phase !== 'research') {
    throw new Error(
      `Post '${slug}' is in phase '${post.phase}', not 'research'. ` +
      `Benchmark init requires the post to be in the research phase.`,
    );
  }

  const docPath = documentPath(researchDir, slug);
  const doc = readResearchDocument(docPath);

  const targets = doc.benchmark_targets
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());

  advancePhase(db, slug, 'benchmark');

  const benchmarkPath = join(benchmarkDir, slug);
  mkdirSync(benchmarkPath, { recursive: true });

  return { targets, benchmarkPath };
}

export function skipBenchmark(
  db: Database.Database,
  slug: string,
): void {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }
  if (post.phase !== 'research') {
    throw new Error(
      `Post '${slug}' is in phase '${post.phase}', not 'research'. ` +
      `Skip requires the post to be in the research phase.`,
    );
  }

  db.prepare('UPDATE posts SET has_benchmarks = 0 WHERE slug = ?').run(slug);
  advancePhase(db, slug, 'draft');
}

export interface CreateBenchmarkRunOptions {
  // Phase 7: mark as an update-cycle benchmark. Paired with previous_run_id
  // so a reader can trace `baseline → update1 → update2 → ...` via the
  // benchmarks table alone.
  isUpdate?: boolean;
  previousRunId?: number;
}

export function createBenchmarkRun(
  db: Database.Database,
  slug: string,
  environmentJson: string,
  resultsPath: string,
  options?: CreateBenchmarkRunOptions,
): number {
  const isUpdate = options?.isUpdate === true ? 1 : 0;
  const info = db.prepare(
    `INSERT INTO benchmarks
       (post_slug, environment_json, results_path, status, is_update, previous_run_id)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
  ).run(
    slug,
    environmentJson,
    resultsPath,
    isUpdate,
    options?.previousRunId ?? null,
  );
  return Number(info.lastInsertRowid);
}

// Phase 7 helper. Return the most recent baseline (is_update=0) benchmark
// for a post, or null. `blog update benchmark` uses this to set
// `previous_run_id` on the new update-cycle benchmark row.
export function latestBaselineBenchmarkId(
  db: Database.Database,
  slug: string,
): number | null {
  const row = db
    .prepare(
      `SELECT id FROM benchmarks
       WHERE post_slug = ? AND is_update = 0
       ORDER BY id DESC LIMIT 1`,
    )
    .get(slug) as { id: number } | undefined;
  return row?.id ?? null;
}

export function updateBenchmarkStatus(
  db: Database.Database,
  runId: number,
  status: BenchmarkStatus,
): void {
  if (status === 'running') {
    db.prepare(
      'UPDATE benchmarks SET status = ?, run_date = CURRENT_TIMESTAMP WHERE id = ?',
    ).run(status, runId);
  } else if (status === 'completed' || status === 'failed') {
    db.prepare(
      'UPDATE benchmarks SET status = ? WHERE id = ?',
    ).run(status, runId);
  } else {
    db.prepare('UPDATE benchmarks SET status = ? WHERE id = ?').run(status, runId);
  }
}

export function listBenchmarkRuns(
  db: Database.Database,
  slug: string,
): BenchmarkRow[] {
  return db.prepare(
    'SELECT * FROM benchmarks WHERE post_slug = ? ORDER BY id ASC',
  ).all(slug) as BenchmarkRow[];
}

export function completeBenchmark(
  db: Database.Database,
  slug: string,
): void {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
  if (!post) {
    throw new Error(`Post not found: ${slug}`);
  }
  if (post.phase !== 'benchmark') {
    throw new Error(
      `Post '${slug}' is in phase '${post.phase}', not 'benchmark'. ` +
      `Complete requires the post to be in the benchmark phase.`,
    );
  }
  db.prepare('UPDATE posts SET has_benchmarks = 1 WHERE slug = ?').run(slug);
  advancePhase(db, slug, 'draft');
}
