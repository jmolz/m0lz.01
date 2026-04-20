import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Vitest globalSetup — runs EXACTLY ONCE before any test worker starts.
//
// Before this was wired, two test files (`skill-fixture-integration.test.ts`
// and `cli-templates-cwd-independence.test.ts`) each called `npm run build`
// in their own `beforeAll`. Vitest runs test files in parallel workers, so
// file A's `beforeAll` could `clean-dist && tsc` while file B was reading
// `dist/cli/index.js` from a prior rebuild — the clean wiped it mid-read,
// and spawned `blog init` subprocesses hit `Cannot find module`.
//
// Locally this almost never showed up (the rebuild is fast on a warm
// cache). On CI the race was deterministic enough to fail every push.
// Fix: build ONCE here, then every test file trusts `dist/` exists.
export async function setup(): Promise<void> {
  const projectRoot = resolve(__dirname, '..');
  const distEntry = resolve(projectRoot, 'dist/cli/index.js');

  // If dist is already present (CI has run `npm run build` before `npm test`,
  // or a dev ran `npm run build` recently), skip — but ONLY if the flag is
  // set. Otherwise rebuild unconditionally to reflect current source.
  if (process.env.BLOG_SKIP_TEST_BUILD === '1' && existsSync(distEntry)) {
    return;
  }

  const result = spawnSync('npm', ['run', 'build'], {
    cwd: projectRoot,
    encoding: 'utf-8',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`globalSetup build failed (exit ${result.status})`);
  }
  if (!existsSync(distEntry)) {
    throw new Error(`globalSetup: build succeeded but ${distEntry} is missing`);
  }
}
