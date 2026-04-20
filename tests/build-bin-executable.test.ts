import { describe, it, expect } from 'vitest';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import { PACKAGE_ROOT } from '../src/core/paths.js';

// Regression guard: tsc does NOT preserve or set the executable bit on its
// outputs. On initial `npm install` / `npm link`, npm applies +x once — but
// every subsequent `npm run build` (which runs `clean-dist && tsc`) wipes
// dist/ and regenerates index.js with 0644. The user-visible symptom is
// bash "Permission denied" on the /blog skill's !`blog agent preflight`
// call, with no stack trace pointing at the build pipeline.
//
// `scripts/chmod-bin.mjs` runs as the last step of `npm run build` and
// restores 0755. This test asserts the fix stays in place — if anyone
// refactors the build script and drops the chmod step, CI fails here
// instead of in the next contributor's skill session.
//
// Relies on vitest globalSetup (tests/global-setup.ts) having already run
// `npm run build`, so dist/cli/index.js exists and reflects the current
// build pipeline's output.

describe('built CLI entrypoint retains executable bit after build', () => {
  it('dist/cli/index.js is 0755 (or at least user-executable)', () => {
    const entry = resolve(PACKAGE_ROOT, 'dist', 'cli', 'index.js');
    const mode = statSync(entry).mode;

    // Owner-execute bit must be set. We check the exact bit rather than
    // the full mode octal so the test tolerates different umasks without
    // losing the invariant.
    expect(mode & 0o100, `dist/cli/index.js mode=${mode.toString(8)} missing owner-execute bit`).toBe(0o100);
  });
});
