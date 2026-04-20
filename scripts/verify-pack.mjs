#!/usr/bin/env node
// Validates `npm pack --dry-run --json` output against four layers:
//   1. ALLOWED_PATTERNS — every packed path must match one.
//   2. FORBIDDEN_PATTERNS — no packed path may match any (secrets, maps, src).
//   3. REQUIRED_FILES — every runtime-critical file must be present. This
//      is the layer Codex Pass 1 Finding #3 added: allowlist alone lets
//      deletions slide through silently (deleting templates/social/linkedin.md
//      would still pass the allowlist check). The required list catches
//      quiet removals of files the CLI actually loads at runtime.
//   4. COMPILED CLOSURE — every `src/**/*.ts` must have a corresponding
//      `dist/**/*.js` in the tarball. Codex Pass 2 Finding #1 raised this:
//      the allowlist's `dist/**/*.js` glob happily accepts any subset of
//      compiled modules, and REQUIRED_FILES only pins one entrypoint — so a
//      deleted `dist/cli/update.js` or `dist/core/paths.js` would still
//      ship. Build cleanliness is enforced by `npm run build` which runs
//      `rm -rf dist && tsc`, but this check is the belt to that suspenders.
// Run locally via `npm run verify-pack` and in CI before release. Also wired
// into `prepublishOnly` so `npm publish` cannot bypass it.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED_PATTERNS = [
  /^dist\/.+\.js$/,
  /^dist\/.+\.d\.ts$/,
  /^templates\/.+$/,
  /^\.claude-plugin\/.+$/,
  /^\.blogrc\.example\.yaml$/,
  /^\.env\.example$/,
  /^branch-mark\.svg$/,
  /^LICENSE$/,
  /^README\.md$/,
  /^package\.json$/,
];

const FORBIDDEN_PATTERNS = [
  /\.js\.map$/,
  /\.d\.ts\.map$/,
  /^\.env$/,
  /^\.env\.local$/,
  /^\.blogrc\.yaml$/,
  /state\.db$/,
  /^\.blog-agent\//,
  /^\.claude\//,
  /^tests\//,
  /^src\//,
];

// Files the CLI loads at runtime (or ships as required starter config). If
// any disappears from the tarball, `blog init` / `blog publish` / `blog
// research` / `blog update` will crash for installed users. Each entry is
// cross-referenced below:
//   dist/cli/index.js               — bin target in package.json
//   .blogrc.example.yaml            — copied by src/cli/init.ts
//   .env.example                    — copied by src/cli/init.ts
//   templates/benchmark/methodology.md — read by src/core/benchmark/companion.ts
//   templates/research/template.md     — read by src/core/research/document.ts
//   templates/research-page/template.mdx — read by src/core/publish/research-page.ts
//   templates/social/linkedin.md       — read by src/core/publish/social.ts
//   templates/social/hackernews.md     — read by src/core/publish/social.ts
//   templates/draft/template.mdx       — consumed by /blog-draft skill
//   package.json / LICENSE / README.md — standard npm package surface
const REQUIRED_FILES = [
  'package.json',
  'LICENSE',
  'README.md',
  '.blogrc.example.yaml',
  '.env.example',
  'dist/cli/index.js',
  'templates/benchmark/methodology.md',
  'templates/draft/template.mdx',
  'templates/research/template.md',
  'templates/research-page/template.mdx',
  'templates/social/linkedin.md',
  'templates/social/hackernews.md',
  // Phase 8: /blog Claude Code plugin ships in the tarball so `claude
  // --plugin-dir $(npm root -g)/m0lz-01/.claude-plugin` finds the skill.
  '.claude-plugin/plugin.json',
  '.claude-plugin/skills/blog/SKILL.md',
];

function fail(msg) {
  console.error(`verify-pack: ${msg}`);
  process.exit(1);
}

let packJson;
try {
  packJson = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  fail(`\`npm pack --dry-run --json\` failed: ${e.message}`);
}

let parsed;
try {
  parsed = JSON.parse(packJson);
} catch (e) {
  fail(`could not parse npm pack JSON output: ${e.message}`);
}

if (!Array.isArray(parsed) || !parsed[0] || !Array.isArray(parsed[0].files)) {
  fail('unexpected npm pack JSON shape; expected [{ files: [...] }, ...]');
}

const paths = parsed[0].files.map((f) => f.path).sort();
const pathSet = new Set(paths);

const violations = [];

for (const p of paths) {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(p)) {
      violations.push(`FORBIDDEN: ${p} matches ${pattern}`);
    }
  }
  const allowed = ALLOWED_PATTERNS.some((pattern) => pattern.test(p));
  if (!allowed) {
    violations.push(`UNEXPECTED: ${p} does not match any allowlist pattern`);
  }
}

for (const required of REQUIRED_FILES) {
  if (!pathSet.has(required)) {
    violations.push(`MISSING: ${required} is required in the tarball but absent`);
  }
}

// Compiled-closure check: every src/**/*.ts must have a matching
// dist/**/*.js in the tarball. Fixes Codex Pass 2 Finding #1 — the
// `dist/**/*.js` allowlist + single-entrypoint REQUIRED_FILES lets a
// missing compiled module (e.g. `dist/cli/update.js`) ship silently.
const srcRoot = resolve(PACKAGE_ROOT, 'src');
const srcTsFiles = readdirSync(srcRoot, { recursive: true }).filter(
  (f) => typeof f === 'string' && f.endsWith('.ts') && !f.endsWith('.d.ts'),
);
const expectedDistJs = srcTsFiles.map((f) => `dist/${f.replace(/\.ts$/, '.js')}`);
for (const expected of expectedDistJs) {
  if (!pathSet.has(expected)) {
    violations.push(
      `MISSING: ${expected} expected (compiles from src/${expected.slice('dist/'.length).replace(/\.js$/, '.ts')}) but not in tarball`,
    );
  }
}

if (violations.length > 0) {
  console.error('verify-pack: tarball contents violate the packaging contract:');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(`\n${paths.length} paths scanned, ${violations.length} violation(s).`);
  process.exit(1);
}

console.log(
  `verify-pack: OK (${paths.length} paths, ${REQUIRED_FILES.length} required files present, ${expectedDistJs.length} src→dist closure entries present, all match allowlist, no forbidden entries).`,
);
