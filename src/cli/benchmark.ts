import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Command } from 'commander';

import { getDatabase, closeDatabase } from '../core/db/database.js';
import { ContentType } from '../core/db/types.js';
import { loadConfig } from '../core/config/loader.js';
import { validateSlug } from '../core/research/document.js';
import { resolveUserPath } from '../core/workspace/user-path.js';
import { captureEnvironment, formatEnvironmentMarkdown } from '../core/benchmark/environment.js';
import {
  getBenchmarkPost,
  getBenchmarkRequirement,
  initBenchmark,
  skipBenchmark,
  createBenchmarkRun,
  updateBenchmarkStatus,
  listBenchmarkRuns,
  completeBenchmark,
} from '../core/benchmark/state.js';
import {
  writeResults,
  readResults,
  writeEnvironment,
  readEnvironment,
  BenchmarkResults,
} from '../core/benchmark/results.js';
import { scaffoldCompanion } from '../core/benchmark/companion.js';

const DB_PATH = resolve('.blog-agent', 'state.db');
const BENCHMARK_DIR = resolve('.blog-agent', 'benchmarks');
const REPOS_DIR = resolve('.blog-agent', 'repos');
const RESEARCH_DIR = resolve('.blog-agent', 'research');
const CONFIG_PATH = resolve('.blogrc.yaml');

export interface BenchmarkPaths {
  dbPath?: string;
  benchmarkDir?: string;
  reposDir?: string;
  researchDir?: string;
  configPath?: string;
}

function requireDb(dbPath: string): void {
  if (!existsSync(dbPath)) {
    console.error("No state database found. Run 'blog init' first.");
    process.exit(1);
  }
}

export function runBenchmarkInit(slug: string, paths: BenchmarkPaths = {}): void {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  const dbPath = paths.dbPath ?? DB_PATH;
  const benchmarkDir = paths.benchmarkDir ?? BENCHMARK_DIR;
  const reposDir = paths.reposDir ?? REPOS_DIR;
  const researchDir = paths.researchDir ?? RESEARCH_DIR;
  const configPath = paths.configPath ?? CONFIG_PATH;
  requireDb(dbPath);

  if (!existsSync(configPath)) {
    console.error(`Config not found: ${configPath}. Run 'blog init' first.`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(configPath);
  const db = getDatabase(dbPath);
  try {
    const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as
      import('../core/db/types.js').PostRow | undefined;
    if (!post) {
      console.error(`Post not found: ${slug}`);
      process.exitCode = 1;
      return;
    }

    const contentType = post.content_type ?? 'technical-deep-dive';
    const requirement = getBenchmarkRequirement(contentType as ContentType, config);

    if (requirement === 'skip') {
      console.error(
        `Content type '${contentType}' does not require benchmarks. ` +
        `Use 'blog benchmark skip ${slug}' to advance to draft.`,
      );
      process.exitCode = 1;
      return;
    }

    if (requirement === 'optional') {
      console.log(`Warning: Benchmarks are optional for '${contentType}' content. Proceeding.`);
    }

    let result: { targets: string[]; benchmarkPath: string };
    try {
      result = initBenchmark(db, slug, benchmarkDir, researchDir);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }

    console.log(`Benchmark phase initialized for ${slug}`);
    if (result.targets.length > 0) {
      console.log('Benchmark targets:');
      for (const target of result.targets) {
        console.log(`  - ${target}`);
      }
    } else {
      console.log('No benchmark targets parsed from research document.');
    }
    console.log(`Benchmark workspace: ${result.benchmarkPath}`);

    const env = captureEnvironment();
    scaffoldCompanion(reposDir, {
      slug,
      topic: post.topic ?? slug,
      targets: result.targets,
      environment: env,
      methodology: '',
    });
    console.log(`Companion repo scaffolded at ${resolve(reposDir, slug)}`);
  } finally {
    closeDatabase(db);
  }
}

export function runBenchmarkEnv(slug: string, paths: BenchmarkPaths = {}): void {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  const dbPath = paths.dbPath ?? DB_PATH;
  const benchmarkDir = paths.benchmarkDir ?? BENCHMARK_DIR;
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    let post;
    try {
      post = getBenchmarkPost(db, slug);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    if (!post) {
      console.error(`Post not found: ${slug}`);
      process.exitCode = 1;
      return;
    }

    const env = captureEnvironment();
    const envPath = writeEnvironment(benchmarkDir, slug, env);
    console.log(`Environment captured: ${envPath}`);
    console.log(formatEnvironmentMarkdown(env));
  } finally {
    closeDatabase(db);
  }
}

export function runBenchmarkRun(
  slug: string,
  opts: { resultsFile?: string },
  paths: BenchmarkPaths = {},
): void {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  const dbPath = paths.dbPath ?? DB_PATH;
  const benchmarkDir = paths.benchmarkDir ?? BENCHMARK_DIR;
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    let post;
    try {
      post = getBenchmarkPost(db, slug);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    if (!post) {
      console.error(`Post not found: ${slug}`);
      process.exitCode = 1;
      return;
    }

    const env = readEnvironment(benchmarkDir, slug);
    if (!env) {
      console.error(`No environment captured. Run 'blog benchmark env ${slug}' first.`);
      process.exitCode = 1;
      return;
    }

    const resultsPath = resolve(benchmarkDir, slug, 'results.json');
    const runId = createBenchmarkRun(db, slug, JSON.stringify(env), resultsPath);
    updateBenchmarkStatus(db, runId, 'running');

    if (opts.resultsFile) {
      if (!existsSync(opts.resultsFile)) {
        console.error(`Results file not found: ${opts.resultsFile}`);
        updateBenchmarkStatus(db, runId, 'failed');
        process.exitCode = 1;
        return;
      }

      let resultsData: BenchmarkResults;
      try {
        resultsData = JSON.parse(readFileSync(opts.resultsFile, 'utf-8')) as BenchmarkResults;
      } catch (e) {
        console.error(`Failed to parse results file: ${(e as Error).message}`);
        updateBenchmarkStatus(db, runId, 'failed');
        process.exitCode = 1;
        return;
      }

      writeResults(benchmarkDir, slug, resultsData);
      updateBenchmarkStatus(db, runId, 'completed');
      console.log(`Run ${runId} completed. Results stored.`);
    } else {
      console.log(
        `Run row created (id=${runId}, status=running). ` +
        `Provide results with 'blog benchmark run ${slug} --results-file path/to/results.json'.`,
      );
    }
  } finally {
    closeDatabase(db);
  }
}

export function runBenchmarkShow(slug: string, paths: BenchmarkPaths = {}): void {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  const dbPath = paths.dbPath ?? DB_PATH;
  const benchmarkDir = paths.benchmarkDir ?? BENCHMARK_DIR;
  const configPath = paths.configPath ?? CONFIG_PATH;
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as
      import('../core/db/types.js').PostRow | undefined;
    if (!post) {
      console.error(`Post not found: ${slug}`);
      process.exitCode = 1;
      return;
    }

    const contentType = post.content_type ?? 'technical-deep-dive';
    let requirement = 'unknown';
    if (existsSync(configPath)) {
      const config = loadConfig(configPath);
      requirement = getBenchmarkRequirement(contentType as ContentType, config);
    }

    const runs = listBenchmarkRuns(db, slug);
    const env = readEnvironment(benchmarkDir, slug);
    const results = readResults(benchmarkDir, slug);

    console.log(`slug:            ${post.slug}`);
    console.log(`phase:           ${post.phase}`);
    console.log(`content_type:    ${contentType}`);
    console.log(`benchmark_req:   ${requirement}`);
    console.log(`runs:            ${runs.length}`);
    console.log(`env_captured:    ${env ? 'yes' : 'no'}`);
    console.log(`results_path:    ${results ? resolve(benchmarkDir, slug, 'results.json') : '(none)'}`);
  } finally {
    closeDatabase(db);
  }
}

export function runBenchmarkSkip(slug: string, paths: BenchmarkPaths = {}): void {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  const dbPath = paths.dbPath ?? DB_PATH;
  const configPath = paths.configPath ?? CONFIG_PATH;
  requireDb(dbPath);

  if (!existsSync(configPath)) {
    console.error(`Config not found: ${configPath}. Run 'blog init' first.`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(configPath);
  const db = getDatabase(dbPath);
  try {
    const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as
      import('../core/db/types.js').PostRow | undefined;
    if (!post) {
      console.error(`Post not found: ${slug}`);
      process.exitCode = 1;
      return;
    }

    const contentType = post.content_type ?? 'technical-deep-dive';
    const requirement = getBenchmarkRequirement(contentType as ContentType, config);

    if (requirement === 'required') {
      console.error(
        `Benchmarks are required for '${contentType}'. Cannot skip.`,
      );
      process.exitCode = 1;
      return;
    }

    try {
      skipBenchmark(db, slug);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }

    console.log(`Skipped benchmarks for ${slug}. Phase advanced to draft.`);
  } finally {
    closeDatabase(db);
  }
}

export function runBenchmarkComplete(slug: string, paths: BenchmarkPaths = {}): void {
  try {
    validateSlug(slug);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  const dbPath = paths.dbPath ?? DB_PATH;
  requireDb(dbPath);

  const db = getDatabase(dbPath);
  try {
    try {
      completeBenchmark(db, slug);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }
    console.log(`Benchmarks completed for ${slug}. Phase advanced to draft.`);
  } finally {
    closeDatabase(db);
  }
}

export function registerBenchmark(program: Command): void {
  const benchmark = program.command('benchmark').description('Benchmark phase operations');

  benchmark
    .command('init <slug>')
    .description('Initialize benchmark phase: transition from research, parse targets')
    .action((slug: string) => {
      runBenchmarkInit(slug);
    });

  benchmark
    .command('env <slug>')
    .description('Capture environment snapshot for benchmark runs')
    .action((slug: string) => {
      runBenchmarkEnv(slug);
    });

  benchmark
    .command('run <slug>')
    .description('Record a benchmark run and optionally store results')
    .option('--results-file <path>', 'Path to a results JSON file to import', resolveUserPath)
    .action((slug: string, opts: { resultsFile?: string }) => {
      runBenchmarkRun(slug, opts);
    });

  benchmark
    .command('show <slug>')
    .description('Show benchmark state for a slug')
    .action((slug: string) => {
      runBenchmarkShow(slug);
    });

  benchmark
    .command('skip <slug>')
    .description('Skip benchmarks and advance directly to draft phase')
    .action((slug: string) => {
      runBenchmarkSkip(slug);
    });

  benchmark
    .command('complete <slug>')
    .description('Mark benchmarks as done and advance to draft phase')
    .action((slug: string) => {
      runBenchmarkComplete(slug);
    });
}
