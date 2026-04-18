import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Command } from 'commander';

import { getDatabase, closeDatabase } from '../core/db/database.js';
import { loadConfig } from '../core/config/loader.js';
import { importPosts } from '../core/migrate/import-posts.js';
import { PACKAGE_ROOT } from '../core/paths.js';

const STATE_DIR = '.blog-agent';
const DB_FILE = 'state.db';
const SUBDIRS = [
  'research',
  'benchmarks',
  'drafts',
  'repos',
  'social',
  'evaluations',
  'research-pages',
];

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Initialize the blog agent workspace')
    .option('--import', 'Import existing posts from m0lz.00')
    .action((opts: { import?: boolean }) => {
      runInit(opts.import ?? false);
    });
}

// `packageRoot` is the read source for shipped templates. Defaults to the
// real installed-package root; tests can inject a temp dir to exercise the
// missing-example hard-fail path without monkey-patching the module.
export function runInit(
  shouldImport: boolean,
  baseDir: string = process.cwd(),
  packageRoot: string = PACKAGE_ROOT,
): void {
  const stateDir = resolve(baseDir, STATE_DIR);

  // Create .blog-agent/ and subdirectories
  mkdirSync(stateDir, { recursive: true });
  for (const sub of SUBDIRS) {
    mkdirSync(resolve(stateDir, sub), { recursive: true });
  }

  // Initialize SQLite database
  const dbPath = resolve(stateDir, DB_FILE);
  const db = getDatabase(dbPath);

  try {
    // Copy config + env templates. baseDir is the write target (CWD by
    // default — where the operator gets their files); PACKAGE_ROOT is the
    // read source (where the shipped examples live).
    //
    // A missing shipped example is a packaging bug, not a user error —
    // hard-fail loudly rather than silently skip. The earlier
    // `existsSync(exampleConfig)` guard would no-op when the tarball ever
    // lost the example file, recreating the original "empty workspace"
    // failure mode with no diagnostic (Codex Pass 1 Finding #4).
    const configPath = resolve(baseDir, '.blogrc.yaml');
    const envPath = resolve(baseDir, '.env');

    try {
      const exampleConfig = resolve(packageRoot, '.blogrc.example.yaml');
      if (!existsSync(configPath)) {
        if (!existsSync(exampleConfig)) {
          throw new Error(
            `Missing shipped config template: ${exampleConfig}. ` +
              `This is a packaging bug — reinstall m0lz-01 or report it at https://github.com/jmolz/m0lz.01/issues.`,
          );
        }
        copyFileSync(exampleConfig, configPath);
        console.log('Created .blogrc.yaml from template -- edit with your settings');
      }

      const exampleEnv = resolve(packageRoot, '.env.example');
      if (!existsSync(envPath)) {
        if (!existsSync(exampleEnv)) {
          throw new Error(
            `Missing shipped env template: ${exampleEnv}. ` +
              `This is a packaging bug — reinstall m0lz-01 or report it at https://github.com/jmolz/m0lz.01/issues.`,
          );
        }
        copyFileSync(exampleEnv, envPath);
        console.log('Created .env from template -- fill in your API keys');
      }
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
      return;
    }

    console.log(`Initialized ${STATE_DIR}/`);
    console.log(`  Database: ${STATE_DIR}/${DB_FILE}`);
    console.log(`  Directories: ${SUBDIRS.join(', ')}`);

    // Import existing posts if requested
    if (shouldImport) {
      try {
        const config = loadConfig(configPath);
        const count = importPosts(db, config.site.repo_path, config.site.base_url, config.site.content_dir);
        console.log(`Imported ${count} posts from m0lz.00`);
      } catch (e) {
        console.error(`Import failed: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    }
  } finally {
    closeDatabase(db);
  }
}
