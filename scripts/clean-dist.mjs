#!/usr/bin/env node
// Cross-platform `rm -rf dist` for the build script. Replaces a POSIX-only
// `rm -rf dist && tsc` that broke on native Windows cmd/PowerShell.
// `fs.rmSync(..., { recursive, force })` is Node >= 14.14, works on every
// platform, and is a no-op when `dist/` doesn't exist yet (fresh clones).
//
// Wired into `package.json` as `build: "node scripts/clean-dist.mjs && tsc"`.
// Rationale: the src→dist closure check in `verify-pack.mjs` + clean build
// together guarantee no stale compiled modules ship. Without this cleanup,
// a renamed/deleted source file leaves behind an orphan `dist/foo.js` that
// passes the `dist/**/*.js` allowlist silently.

import { rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(resolve(PACKAGE_ROOT, 'dist'), { recursive: true, force: true });
