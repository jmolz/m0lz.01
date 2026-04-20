import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { PACKAGE_ROOT } from '../src/core/paths.js';

// Black-box regression guard for the template-path bug:
//   * `resolve('templates')` in cli/publish.ts + cli/update.ts used CWD,
//   * `resolve(baseDir, '.blogrc.example.yaml')` in cli/init.ts silently
//     skipped the copy when baseDir (== CWD) lacked the shipped examples.
//
// After the Task 0/2/2b fixes, PACKAGE_ROOT/TEMPLATES_ROOT resolve against
// the package on disk, so the built CLI works from any CWD. This test
// spawns dist/cli/index.js from a genuinely empty tmpdir and asserts the
// template copies happen end-to-end.

const CLI_ENTRY = resolve(PACKAGE_ROOT, 'dist', 'cli', 'index.js');
const EXAMPLE_CONFIG = resolve(PACKAGE_ROOT, '.blogrc.example.yaml');
const EXAMPLE_ENV = resolve(PACKAGE_ROOT, '.env.example');

let tempDir: string;

beforeAll(() => {
  // The build is handled by vitest's globalSetup (tests/global-setup.ts)
  // so it runs exactly once across the whole test run. Previously this
  // file and skill-fixture-integration.test.ts each ran `npm run build`
  // in their own beforeAll, and the `clean-dist && tsc` step raced
  // between parallel vitest workers — deterministic CI failure, rare
  // locally. Here we just assert dist exists.
  //
  // Running a single test file standalone still works because globalSetup
  // fires for any `vitest run` invocation that uses this config. If you
  // run vitest WITHOUT our config (`npx vitest run --config ...`),
  // run `npm run build` first.
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `CLI entry missing: ${CLI_ENTRY}. globalSetup should have built dist/. ` +
        `If running vitest directly without our config, run \`npm run build\` first.`,
    );
  }
}, 60_000);

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined as unknown as string;
});

describe('blog init from an arbitrary CWD', () => {
  it('creates .blog-agent/, copies .blogrc.yaml + .env from shipped examples', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'blog-cwd-'));

    const result = spawnSync('node', [CLI_ENTRY, 'init'], {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr).toBe(0);

    // .blog-agent/state.db proves the DB initialization ran end-to-end
    // (the path-bug fix is upstream — if CLI boot failed on templates,
    // we never got here).
    const stateDb = join(tempDir, '.blog-agent', 'state.db');
    expect(existsSync(stateDb), `state.db missing at ${stateDb}`).toBe(true);

    // .blogrc.yaml was copied — this is what Task 2b fixed. Pre-fix, the
    // copy silently skipped (baseDir had no example file), so this
    // assertion is the regression guard.
    const rcPath = join(tempDir, '.blogrc.yaml');
    expect(existsSync(rcPath), '.blogrc.yaml not copied').toBe(true);
    expect(readFileSync(rcPath, 'utf-8')).toBe(
      readFileSync(EXAMPLE_CONFIG, 'utf-8'),
    );

    // .env was copied from .env.example for the same reason.
    const envPath = join(tempDir, '.env');
    expect(existsSync(envPath), '.env not copied').toBe(true);
    expect(readFileSync(envPath, 'utf-8')).toBe(
      readFileSync(EXAMPLE_ENV, 'utf-8'),
    );
  });
});
