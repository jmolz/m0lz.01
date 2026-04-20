---
paths:
  - "RELEASING.md"
  - "CHANGELOG.md"
  - "package.json"
  - "scripts/**"
  - ".github/**"
  - ".nvmrc"
---

# Release & Packaging Conventions

Rules for `RELEASING.md`, `CHANGELOG.md`, `package.json`, `scripts/**`,
and `.github/**`. These invariants emerged from the v0.1.0 release-prep
work which ran seven adversarial passes (1 Claude evaluator + 6 Codex
GPT-5.4 high) against a Tier-2 contract before converging.

## Package-relative vs CWD-relative paths

Every path in `src/**/*.ts` answers one of two questions — **read or
write** — and the answer determines which resolver to use:

- **Read source** (shipped templates, example config, compiled assets) →
  `PACKAGE_ROOT` / `TEMPLATES_ROOT` from `src/core/paths.ts`. These
  paths must work identically from `src/` under Vitest AND from `dist/`
  after `tsc`.
- **Write target** (`.blog-agent/`, `.blogrc.yaml`, state DB, operator
  files) → CWD-relative via `resolve('.blog-agent/...')` or
  `resolve(baseDir, '...')` where `baseDir = process.cwd()`.

Mixing these is a release blocker. `blog init` that reads
`.blogrc.example.yaml` from `baseDir` instead of `PACKAGE_ROOT` fails
silently for npx-installed users because the example ships with the
package, not in the operator's CWD. The fix is to separate read source
from write target explicitly — injectable `packageRoot` parameter
defaults to `PACKAGE_ROOT`, tests can override.

Grep-verifiable: zero matches for `resolve\(['\"]templates` and zero
for `fileURLToPath\(import\.meta\.url\)` in `src/core/benchmark/*.ts` /
`src/core/research/*.ts` / `src/cli/*.ts`. Every template consumer
imports from `../core/paths.js`.

## Four-layer packaging gate (`scripts/verify-pack.mjs`)

Every release passes `npm run verify-pack`, wired into BOTH CI and
`prepublishOnly`. The script runs `npm pack --dry-run --json` and
checks the path set against four layers — each catches a different
failure mode the others miss:

1. **ALLOWED_PATTERNS** — every packed path must match one. Catches
   new globs added to `files` that accidentally sweep in unshipped
   directories.
2. **FORBIDDEN_PATTERNS** — no packed path may match any: `.js.map$`,
   `.d.ts.map$`, `.env$`, `.env.local$`, `.blogrc.yaml$`, `state.db$`,
   `^.blog-agent/`, `^.claude/`, `^tests/`, `^src/`. Catches secrets
   and source trees leaking into the tarball.
3. **REQUIRED_FILES** — explicit manifest of runtime-critical paths
   (templates, bin target, root files). Allowlist alone would let a
   deleted template slide through silently; this layer makes the
   deletion a build failure.
4. **Compiled closure** — walks `src/**/*.ts`, asserts each
   corresponding `dist/**/*.js` is in the tarball path set. Allowlist
   `dist/**/*.js` + single-entrypoint REQUIRED_FILES would silently
   pass a missing compiled module (e.g. renamed `src/core/foo.ts` →
   `src/core/bar.ts` without dist cleanup). This layer is the belt to
   `rm -rf dist && tsc`'s suspenders.

Adversarial smoke test: temporarily `mv dist/core/paths.js dist/core/paths.js.bak`
and run `npm run verify-pack`. Must exit 1 with `MISSING: dist/core/paths.js
expected (compiles from src/core/paths.ts) but not in tarball`.

## Clean build is required, not optional

`package.json` build script is
`"build": "node scripts/clean-dist.mjs && tsc && node scripts/chmod-bin.mjs"`.
Three steps, each load-bearing — do not drop any of them:

1. **Clean** (`clean-dist.mjs`) — `tsc` never removes stale outputs, so a
   renamed/deleted source file leaves an orphan `dist/foo.js` behind that
   (a) passes the `dist/**/*.js` allowlist and (b) would be re-packed on
   the next `npm publish`. The clean prevents orphan-in-tarball bugs.
2. **Compile** (`tsc`) — standard TypeScript emit, no special flags.
3. **chmod +x** (`chmod-bin.mjs`) — `tsc` does NOT preserve or set the
   owner-execute bit on its outputs. On initial `npm install` / `npm
   link`, npm applies +x to every `bin` target exactly once — but every
   subsequent rebuild regenerates `dist/cli/index.js` as 0644. Any
   pre-existing symlink (e.g. `/opt/homebrew/bin/blog → dist/cli/index.js`
   from a previous `npm link`) dereferences to the now-non-executable
   target and the bash error surfaces as `Permission denied: blog`
   inside the `/blog` skill — with zero diagnostic hint at the build
   pipeline. The chmod step closes that loop. `tests/build-bin-executable.test.ts`
   regression-asserts `mode & 0o100 === 0o100` after globalSetup's
   build completes.

**Use `scripts/clean-dist.mjs`, not `rm -rf`.** Pure Node
(`fs.rmSync({recursive, force})`), cross-platform, no new devDeps.
`rm -rf dist && tsc` works on macOS/Linux/WSL but breaks on Windows
cmd/PowerShell — we do not target Windows in CI but the build script
should not preemptively block Windows contributors. Same rationale
applies to `chmod-bin.mjs`: pure Node `fs.chmodSync`, not shell `chmod`.

## `prepublishOnly` is the publish-time gate

```jsonc
"prepublishOnly": "npm run lint && npm run build && npm test && npm run verify-pack"
```

Order matters:
1. `lint` — fast fail on type errors before wasting cycles
2. `build` — dist must exist before test (the CWD-independence
   integration test spawns `dist/cli/index.js`)
3. `test` — full test suite must pass (860+ tests as of Phase 8), including the registered regression suite
4. `verify-pack` — last gate, reads from the freshly-built `dist/`

Any `npm publish` invocation triggers this hook. It cannot be bypassed
without `--ignore-scripts` (which we do not document and do not support).

## `engines.node` must pin to the minimum version of APIs we actually use

`readdirSync(dir, { recursive: true })` requires Node ≥ 20.1. Therefore
`engines.node: ">=20.1.0"`, not `">=20.0.0"`. Whenever a new stdlib
feature lands in `src/**` or `scripts/**`, update `engines.node` to
match. `npm install` enforces this at install time — a looser pin lets
a 20.0.x user install and crash later; a tight pin surfaces the
incompatibility immediately.

## Release runbook invariants (`RELEASING.md`)

The runbook went through six Codex adversarial passes. Every invariant
below is a scar tissue from a specific finding. Do NOT revert any of
them without re-running adversarial review.

- **`main`-branch + clean-tree fail-fast preflight** at the top of
  every release flow (first and subsequent). `git push --atomic origin
  main refs/tags/vX.Y.Z` from a topic branch silently succeeds as a
  no-op branch push plus a new tag push, publishing unmerged code.
  Guard:
  `test "$(git branch --show-current)" = main || exit 1`
  plus `test -z "$(git status --porcelain)" || exit 1`.
- **`npm publish` runs BEFORE any remote push.** Pushing a tag before
  publish succeeds leaves an orphan tag on GitHub advertising a
  release that doesn't exist on npm. Reversed ordering was the root
  cause of Pass 3 Finding #2.
- **Pre-publish `git push --atomic --dry-run`.** The only way to
  surface auth / branch-protection / remote-advancement problems
  BEFORE `npm publish` makes the release irreversible on the registry.
- **Atomic push with explicit refs** —
  `git push --atomic origin main refs/tags/vX.Y.Z`, never
  `--follow-tags`. `--follow-tags` is not atomic; one ref can be
  accepted while the other is rejected, leaving GitHub with branch/tag
  skew that the later `gh release create` attaches metadata to the
  wrong commit.
- **`gh release create --verify-tag`**, always. Without the flag,
  `gh` silently auto-creates a new tag from the current default-branch
  HEAD when the expected tag is missing — producing a release pointing
  at a different commit than the npm tarball.
- **Recovery is registry-state-check-first.** `npm publish` can exit
  non-zero with the version ALREADY live on the registry (network
  timeout / CLI crash after upload). Always run
  `npm view m0lz-01@X.Y.Z version` BEFORE retrying or resetting. Three
  cases: A=live/push-only-with-rebase-and-re-tag, B=E404/safe-retry,
  C=abandon (valid only under B).
- **`--mixed` resets, not `--hard`.** `git reset --hard HEAD~1`
  silently discards any uncommitted changes in the working tree
  (including debug prints, modified CHANGELOG drafts, etc). Recovery
  must first run `git status` + `git log --oneline -N` preflights so
  the operator sees what's about to be removed.
- **Subsequent-release flow has TWO local commits** (CHANGELOG + `npm
  version` bump), so abandon uses `HEAD~2`, not `HEAD~1`. Documented
  separately from the first-release recovery block.
- **Rebase re-points the tag explicitly.** After `git rebase
  origin/main` on a remote-advanced case, the `vX.Y.Z` tag still
  points at the original commit (which no longer exists on the new
  branch). Run `git tag -f -a vX.Y.Z -m "..."` to re-point BEFORE
  pushing atomically.

## `awk` range delimiters are unsafe for CHANGELOG extraction

`awk '/^## \[0.1.0\]/,/^## \[/' CHANGELOG.md` emits only the heading
(1 line) because the start pattern matches its own termination. Use
flag-based extraction instead:

    awk '/^## \[0\.1\.0\]/{flag=1;print;next} /^## \[/{flag=0} flag' CHANGELOG.md

Verified to emit the full section body (22 lines for the v0.1.0
section with all seven phases + fix list). This is the canonical form
used in both `RELEASING.md` sections.

## Adversarial evaluation convergence cadence

Release-prep work ran seven passes before Codex returned
`clean / approve`. Expected cadence:

- **Pass 1-2**: Major findings (packaging-gate gaps, silent-failure
  modes, test coverage holes). 3-5 findings typical.
- **Pass 3-4**: Medium findings (recovery-section UX, documentation
  cross-references). 1-3 findings typical.
- **Pass 5-6**: Small findings (symmetry between first-release and
  subsequent-release sections, missing `--verify-tag`). 1-2 findings
  typical.
- **Pass 7+**: Convergence. Codex returns `clean / approve` explicitly.

Do NOT stop at "Claude evaluator says 11/11 PASS" — the Claude
evaluator grades contract criteria formally, which is necessary but
not sufficient. Codex challenges the approach itself and finds issues
that are out-of-scope of the contract. Every release-prep PR should
run to convergence or document explicitly-accepted residual risk.

When Codex is rate-limited (ChatGPT Team quota), fall back to the
OpenAI Responses API via `~/.claude/.openai-fallback-key` (see the
`/evaluate` skill for the exact pattern). Do NOT re-run
`codex login --api-key` — that would overwrite the ChatGPT Team
session.

## Regression suite registration is non-negotiable

Per `.claude/rules/testing.md`: every new test file must be registered
in **both** `.claude/commands/review.md` AND `.windsurf/workflows/review.md`,
and in all four places within each file:

1. The `npx vitest run` bash block (so it runs)
2. The "What each test covers" table (so it's documented)
3. The "Source files these tests protect" list (reverse index)
4. The Phase-N checklist in the output format + the baseline count

Verify via diff before every Phase close-out:

    ls tests/*.test.ts | sed 's|tests/||' | sort > /tmp/disk.txt
    grep -oE 'tests/[a-z0-9-]+\.test\.ts' .claude/commands/review.md | \
      sed 's|tests/||' | sort -u > /tmp/block.txt
    diff /tmp/disk.txt /tmp/block.txt

Zero diff in both directions = complete registration. A non-empty diff
means either a test on disk isn't in the suite, or a line in the suite
references a deleted test. Release-prep Pass 8 caught exactly this
gap (2 new tests registered in `.claude/commands/review.md` but not
`.windsurf/workflows/review.md`, where drift from Phase 5 was 31 files
deep).
