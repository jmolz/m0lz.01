import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Command } from 'commander';

import { getDatabase, closeDatabase } from '../core/db/database.js';
import { loadConfig } from '../core/config/loader.js';
import { importPosts } from '../core/migrate/import-posts.js';

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

export function runInit(shouldImport: boolean, baseDir: string = process.cwd()): void {
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
    // Copy config template if .blogrc.yaml doesn't exist
    const configPath = resolve(baseDir, '.blogrc.yaml');
    const exampleConfig = resolve(baseDir, '.blogrc.example.yaml');
    if (!existsSync(configPath) && existsSync(exampleConfig)) {
      copyFileSync(exampleConfig, configPath);
      console.log('Created .blogrc.yaml from template -- edit with your settings');
    }

    // Copy .env template if .env doesn't exist
    const envPath = resolve(baseDir, '.env');
    const exampleEnv = resolve(baseDir, '.env.example');
    if (!existsSync(envPath) && existsSync(exampleEnv)) {
      copyFileSync(exampleEnv, envPath);
      console.log('Created .env from template -- fill in your API keys');
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
