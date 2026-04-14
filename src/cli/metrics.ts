import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { Command } from 'commander';

import { getDatabase, closeDatabase } from '../core/db/database.js';

const DB_PATH = resolve('.blog-agent', 'state.db');

export interface MetricsSummary {
  total: number;
  imported: number;
  agentCreated: number;
  published: number;
  inProgress: number;
  siteCount: number;
  devtoCount: number;
  mediumCount: number;
  substackCount: number;
  repoCount: number;
  evaluationPassRate: string;
}

export function registerMetrics(program: Command): void {
  program
    .command('metrics')
    .description('Show aggregate publishing statistics')
    .action(() => {
      runMetrics();
    });
}

export function computeMetrics(db: Database.Database): MetricsSummary {
  // Single aggregate query over posts table
  const postStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN mode = 'imported' THEN 1 ELSE 0 END) AS imported,
      SUM(CASE WHEN phase = 'published' THEN 1 ELSE 0 END) AS published,
      SUM(CASE WHEN site_url IS NOT NULL THEN 1 ELSE 0 END) AS site_count,
      SUM(CASE WHEN devto_url IS NOT NULL THEN 1 ELSE 0 END) AS devto_count,
      SUM(CASE WHEN medium_url IS NOT NULL THEN 1 ELSE 0 END) AS medium_count,
      SUM(CASE WHEN substack_url IS NOT NULL THEN 1 ELSE 0 END) AS substack_count,
      SUM(CASE WHEN repo_url IS NOT NULL THEN 1 ELSE 0 END) AS repo_count
    FROM posts
  `).get() as {
    total: number;
    imported: number | null;
    published: number | null;
    site_count: number | null;
    devto_count: number | null;
    medium_count: number | null;
    substack_count: number | null;
    repo_count: number | null;
  };

  const imported = postStats.imported ?? 0;
  const published = postStats.published ?? 0;

  // Single aggregate query over evaluation_synthesis
  const evalStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN verdict = 'pass' THEN 1 ELSE 0 END) AS passed
    FROM evaluation_synthesis
  `).get() as { total: number; passed: number | null };

  const evaluationPassRate = evalStats.total > 0
    ? `${Math.round(((evalStats.passed ?? 0) / evalStats.total) * 100)}%`
    : '- (no evaluations yet)';

  return {
    total: postStats.total,
    imported,
    agentCreated: postStats.total - imported,
    published,
    inProgress: postStats.total - published,
    siteCount: postStats.site_count ?? 0,
    devtoCount: postStats.devto_count ?? 0,
    mediumCount: postStats.medium_count ?? 0,
    substackCount: postStats.substack_count ?? 0,
    repoCount: postStats.repo_count ?? 0,
    evaluationPassRate,
  };
}

export function runMetrics(dbPath = DB_PATH): void {
  if (!existsSync(dbPath)) {
    console.error("No state database found. Run 'blog init' first.");
    process.exit(1);
  }

  const db = getDatabase(dbPath);
  const m = computeMetrics(db);

  console.log('Posts');
  console.log(`  Total:       ${m.total} (${m.imported} imported, ${m.agentCreated} agent-created)`);
  console.log(`  Published:   ${m.published}`);
  console.log(`  In progress: ${m.inProgress}`);
  console.log('');
  console.log('Platforms');
  console.log(`  Site:        ${m.siteCount}`);
  console.log(`  Dev.to:      ${m.devtoCount}`);
  console.log(`  Medium:      ${m.mediumCount}`);
  console.log(`  Substack:    ${m.substackCount}`);
  console.log('');
  console.log(`Companion repos: ${m.repoCount}`);
  console.log(`Evaluation pass rate: ${m.evaluationPassRate}`);

  closeDatabase(db);
}
