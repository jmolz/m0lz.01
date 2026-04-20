// Restore the executable bit on the CLI entrypoint after `tsc` compiles it.
//
// tsc does NOT preserve or set executable bits on its outputs. On initial
// `npm install` / `npm link`, npm applies +x to every `bin` target once —
// but subsequent rebuilds (the `clean-dist && tsc` in the build script) wipe
// dist/ and regenerate the file with 0644, silently breaking:
//
//   !blog agent preflight --json
//     → /bin/sh: /opt/homebrew/bin/blog: Permission denied
//
// That failure surfaces inside the `/blog` skill, not at the CLI itself,
// so contributors debugging skill behavior wasted time tracing it back to
// the build pipeline. This script runs as the last step of `npm run build`
// and every consumer of that script (including `prepublishOnly`).
//
// Regression guard: tests/build-bin-executable.test.ts.
import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';

const entry = resolve(process.cwd(), 'dist/cli/index.js');
chmodSync(entry, 0o755);
