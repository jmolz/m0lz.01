---
description: Review code changes for bugs, security issues, and improvements — includes cumulative regression suite
---

# Code Review

Perform a thorough code review of the current changes AND run the cumulative regression suite to ensure all previously built features still work.

## Phase 0: Contract Check

Before starting the standard review, check if the most recent plan has a contract:

```bash
# Find the most recently modified plan file
ls -t .claude/plans/*.md 2>/dev/null | head -1
```

If a plan file exists, read its `## Contract` section. If a contract is found:

1. Note the tier and criteria in the review output
2. After Phase 3 (Code Review), add a **Phase 3.5: Contract Evaluation** that spawns a fresh sub-agent to grade the implementation against the contract (see `/evaluate` for the full evaluator protocol)
3. Include the contract evaluation results in the final output

If no contract exists, skip this and proceed normally. The contract evaluation is additive — it does not replace the standard code review phases.

---

## Phase 0.5: Database Migration Check

This project uses **SQLite via better-sqlite3** with schema migrations gated on the `user_version` pragma (see `src/core/db/database.ts`). There is no separate migration tool — migrations apply at runtime when `getDatabase()` is called.

### Step 1: Check for schema drift

```bash
# Check whether the schema file was modified without bumping SCHEMA_VERSION
git diff HEAD --name-only -- 'src/core/db/schema.ts' 'src/core/db/types.ts' 2>/dev/null
git diff HEAD -- 'src/core/db/schema.ts' | grep -E '^\+.*SCHEMA_VERSION' 2>/dev/null
```

If `src/core/db/schema.ts` was modified (new tables, columns, or constraints) but `SCHEMA_VERSION` was NOT incremented, flag as **Critical** — existing databases will not pick up the change. The fix is:

1. Bump `SCHEMA_VERSION` by 1 in `src/core/db/schema.ts`
2. Add an `if (fromVersion < N)` block to the `migrate()` function in `src/core/db/database.ts`
3. Put the `ALTER TABLE` or `CREATE TABLE` statements in the new block
4. Update `src/core/db/types.ts` to match the new columns

### Step 2: Apply migrations

Migrations apply automatically on database open. To verify a fresh init works with the current schema:

```bash
rm -rf .blog-agent/
npx tsc -p . && node dist/cli/index.js init
```

If this fails, flag as **Critical**.

## Phase 1: Regression Suite

Run these tests FIRST to verify that all previously shipped features are intact. This suite grows with every feature — when you ship a feature, add its tests here. If any fail, flag them as **Critical** and investigate before proceeding with the code review.

```bash
# Run all regression suite tests
npx vitest run \
  tests/db.test.ts \
  tests/config.test.ts \
  tests/import.test.ts \
  tests/ideas.test.ts \
  tests/content-types.test.ts \
  tests/cli.test.ts \
  tests/db-migration.test.ts \
  tests/research-state.test.ts \
  tests/research-sources.test.ts \
  tests/research-document.test.ts \
  tests/research-cli.test.ts \
  tests/benchmark-environment.test.ts \
  tests/benchmark-state.test.ts \
  tests/benchmark-results.test.ts \
  tests/benchmark-companion.test.ts \
  tests/benchmark-cli.test.ts \
  tests/draft-frontmatter.test.ts \
  tests/draft-state.test.ts \
  tests/draft-benchmark-data.test.ts \
  tests/draft-tags.test.ts \
  tests/draft-cli.test.ts
```

### What each test covers

**Phase 1 — Foundation (feature/phase-1-foundation)**

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/db.test.ts` (7 tests) | SQLite schema + connection | All 8 tables created (posts, sources, benchmarks, pipeline_steps, assets, evaluations, evaluation_synthesis, metrics); `user_version` matches `SCHEMA_VERSION`; WAL mode enabled on file-backed DB; foreign keys enforced; CHECK constraints reject invalid phase values; insert/retrieve round-trip works |
| `tests/config.test.ts` (6 tests) | `.blogrc.yaml` loader | Valid config parses with repo_path resolved relative to config dir; missing `site.repo_path` / `author.name` / `author.github` throw descriptive errors; optional sections get sensible defaults; non-existent config file throws |
| `tests/import.test.ts` (5 tests) | m0lz.00 post import | Posts imported from fixture directory with correct frontmatter mapping (slug, title, phase=published, mode=imported, site_url pattern, project_id, repo_url); idempotent on re-run (INSERT OR IGNORE); throws on missing posts directory; skips posts with malformed YAML frontmatter and warns; skips posts missing required title field |
| `tests/ideas.test.ts` (11 tests) | Editorial backlog CRUD | `loadIdeas` returns empty array for missing file; `saveIdeas` creates YAML and handles empty list; appends to existing file; priority sorting; `startIdea` creates DB row with phase=research and removes from YAML; `startIdea` throws on invalid index; `removeIdea` removes correct entry by priority-sorted index; `removeIdea` throws on invalid index; `saveIdeas` idempotent on identical content; `startIdea` honors INSERT OR IGNORE on slug collision |
| `tests/content-types.test.ts` (6 tests) | Content type detection | Catalog project IDs (`m0lz.XX`) return `project-launch`; benchmark keywords return `technical-deep-dive`; generic prompts return `analysis-opinion`; project ID takes priority over benchmark keywords; empty prompt returns default; "test-driven development" does NOT false-positive as benchmark |
| `tests/cli.test.ts` (13 tests) | CLI handler integration | `runStatus` prints formatted table and empty-state message; exits with error when DB missing; `computeMetrics` returns correct aggregates (posts, platforms, companion repos, evaluation pass rate); `runMetrics` prints output; `runInit` creates `.blog-agent/` with all subdirs and state.db; init with `--import` uses `config.site.content_dir`; init with `--import` prints clean error message and sets exitCode=1 on config/repo failure; `runInit` idempotent on re-run |

**Phase 2 — Research (feature/phase-2-research)**

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/db-migration.test.ts` (3 tests) | Schema v1->v2 migration | Fresh DB opens at SCHEMA_VERSION=2 with unique source index; seeded v1 DB upgrades to v2 preserving data; re-opening v2 DB is idempotent |
| `tests/research-state.test.ts` (9 tests) | Research post lifecycle | `initResearchPost` creates row with phase=research; idempotent re-init returns existing row unchanged; cross-phase slug collision throws; `getResearchPost` returns row or undefined; `getResearchPost` enforces phase=research boundary; `advancePhase` updates phase and bumps timestamp; rejects invalid phase; rejects missing slug |
| `tests/research-sources.test.ts` (11 tests) | Source management | Inserts source with title/excerpt; deduplicates on (post_slug,url); reports existing source id; errors for missing post; detects source_type; orders by accessed_at; lists all sources; returns empty for no sources; counts correctly; returns 0 for unknown slug; rejects non-research phase posts |
| `tests/research-document.test.ts` (18 tests) | Research documents | Writes template with all required sections; reads back losslessly; refuses overwrite without force; overwrites with force; validates missing file throws; validates all sections present; detects missing sections; detects empty sections; detects malformed frontmatter; documentPath joins correctly; YAML round-trips colons in topic; YAML round-trips quotes and hashes; validateSlug accepts kebab-case; rejects path separators; rejects uppercase/special chars; rejects empty slugs; rejects path traversal |
| `tests/research-cli.test.ts` (13 tests) | Research CLI handlers | `runResearchInit` creates post+doc; refuses overwrite without --force; overwrites with --force; cross-phase safety rejects non-research slugs; rejects path traversal slugs; `runResearchAddSource` inserts and logs; deduplication is idempotent; missing post sets exitCode=1; `runResearchShow` prints fields; missing slug sets exitCode=1; `runResearchFinalize` fails on insufficient sources; fails on empty sections; passes when requirements met |

**Phase 3 — Benchmark (feature/phase-3-benchmark)**

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/benchmark-environment.test.ts` (4 tests) | Environment capture | `captureEnvironment` returns all required fields as non-empty strings; `total_memory_gb` is a positive integer; values stable across consecutive calls; `formatEnvironmentMarkdown` includes OS, architecture, Node.js version |
| `tests/benchmark-state.test.ts` (15 tests) | Benchmark state lifecycle | `initBenchmark` transitions research→benchmark and parses targets; rejects non-research and missing posts; `getBenchmarkPost` returns benchmark-phase post, undefined for missing, throws for wrong phase; `skipBenchmark` transitions to draft with `has_benchmarks=0`; rejects non-research; `createBenchmarkRun` inserts pending row; `updateBenchmarkStatus` transitions pending→running→completed; `listBenchmarkRuns` returns ordered; `completeBenchmark` sets `has_benchmarks=1` and advances to draft; rejects non-benchmark and missing posts; `getBenchmarkRequirement` routes content types correctly |
| `tests/benchmark-results.test.ts` (5 tests) | Results storage | `writeResults` / `readResults` round-trip data; returns null for nonexistent; `writeEnvironment` / `readEnvironment` round-trip; slug validation rejects path traversal for all four functions |
| `tests/benchmark-companion.test.ts` (6 tests) | Companion repo scaffolding | Creates `src/`, `results/`, `METHODOLOGY.md`, `LICENSE`, `README.md`; `METHODOLOGY.md` contains environment details; `README.md` lists targets; `LICENSE` contains MIT; idempotent re-scaffold preserves existing files; `writeMethodology` replaces all template placeholders |
| `tests/benchmark-cli.test.ts` (14 tests) | Benchmark CLI handlers | `runBenchmarkInit` transitions and prints targets; rejects non-research; rejects skip content type; warns optional but proceeds for project-launch; `runBenchmarkEnv` captures and writes file; rejects non-benchmark; `runBenchmarkRun` stores results and marks completed; rejects missing environment; `runBenchmarkShow` displays state with run count; `runBenchmarkSkip` advances analysis-opinion to draft; refuses required; `runBenchmarkComplete` advances to draft; rejects non-benchmark; all handlers reject invalid slugs |

**Phase 4 — Draft (feature/phase-4-draft)**

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/draft-frontmatter.test.ts` (24 tests) | PostFrontmatter schema | `generateFrontmatter` produces canonical URL, `companion_repo` when `has_benchmarks`, `project` from `project_id`, `published=false`, placeholder title/description; `validateFrontmatter` passes valid, fails missing/placeholder title/description/date/tags/published, rejects non-YYYY-MM-DD date and empty tags; `serializeFrontmatter` / `parseFrontmatter` round-trip with optional fields omitted; `parseFrontmatter` extracts from MDX, throws on missing delimiters and invalid YAML, does not coerce `"false"` to true, does not mis-split on body thematic break |
| `tests/draft-state.test.ts` (16 tests) | Draft state lifecycle | `getDraftPost` returns draft-phase post, throws for wrong phase, undefined for missing; `initDraft` creates directory structure and template MDX, is idempotent (does not overwrite valid existing draft), includes content-type-specific sections (technical-deep-dive has benchmarks, project-launch preserves benchmarks when present, analysis-opinion has analysis), throws for missing post; `completeDraft` advances to evaluate, rejects placeholder sections, rejects missing asset files, throws for wrong phase and missing post; `registerAsset` inserts and is idempotent (transactional); `listAssets` returns ordered list, empty for unknown slug |
| `tests/draft-benchmark-data.test.ts` (8 tests) | Benchmark data formatting | `formatBenchmarkTable` produces markdown from simple key-value, handles empty data, array values as rows, nested objects flattened one level; `formatMethodologyRef` produces correct reference string and honors `githubUser` from config (no hardcoded user); `getBenchmarkContext` reads existing results/environment, returns nulls for missing files |
| `tests/draft-tags.test.ts` (6 tests) | Tag taxonomy reader | `readExistingTags` reads tags from MDX files (flat and subdirectory-based), deduplicates, returns sorted; returns empty for missing directory, no MDX files, files without tags field |
| `tests/draft-cli.test.ts` (25 tests) | Draft CLI handlers | `runDraftInit` creates draft directory and template MDX with content-type-aware sections (technical-deep-dive, analysis-opinion, project-launch), errors for wrong phase; `runDraftShow` prints status, errors for wrong phase, treats malformed config as best-effort; `runDraftValidate` fails for placeholders, passes for complete draft, fails for missing assets; `runDraftAddAsset` registers existing file, errors for missing file, invalid type, and path-traversal filenames; `runDraftComplete` advances to evaluate, errors for wrong phase; rejects 6 invalid slug patterns |

### Source files these tests protect

- `src/core/db/schema.ts` — SQL schema for all 8 tables, SCHEMA_VERSION constant
- `src/core/db/database.ts` — `getDatabase`, `closeDatabase`, migration logic, WAL + foreign keys
- `src/core/db/types.ts` — Row interfaces, ContentType/Phase/Mode/etc. enums
- `src/core/config/loader.ts` — `loadConfig`, `validateConfig`, path resolution, defaults
- `src/core/config/types.ts` — BlogConfig and subsection interfaces
- `src/core/migrate/import-posts.ts` — `importPosts` with frontmatter parsing and content_dir parameter
- `src/core/draft/content-types.ts` — `detectContentType`, BENCHMARK_KEYWORDS list
- `src/cli/index.ts` — Commander.js entry point, command registration
- `src/cli/init.ts` — `runInit` with injectable baseDir, subdirectory + DB + template copy
- `src/cli/status.ts` — `runStatus` with formatted table output
- `src/cli/metrics.ts` — `runMetrics`, `computeMetrics` with aggregate queries
- `src/cli/ideas.ts` — `addIdea`/`listIdeas`/`startIdea`/`removeIdea`, YAML persistence
- `src/cli/research.ts` — `runResearchInit`/`runResearchAddSource`/`runResearchShow`/`runResearchFinalize`, slug validation, phase boundary
- `src/core/research/state.ts` — `initResearchPost`, `getResearchPost`, `advancePhase`, phase boundary enforcement
- `src/core/research/sources.ts` — `addSource`, `listSources`, `countSources`, phase boundary enforcement
- `src/core/research/document.ts` — `writeResearchDocument`, `readResearchDocument`, `validateResearchDocument`, `validateSlug`, path traversal guard
- `src/cli/benchmark.ts` — `runBenchmarkInit`/`runBenchmarkEnv`/`runBenchmarkRun`/`runBenchmarkShow`/`runBenchmarkSkip`/`runBenchmarkComplete`, `BenchmarkPaths`, slug validation, phase boundary
- `src/core/benchmark/environment.ts` — `captureEnvironment`, `formatEnvironmentMarkdown`
- `src/core/benchmark/state.ts` — `initBenchmark`, `getBenchmarkPost`, `skipBenchmark`, `completeBenchmark`, `createBenchmarkRun`, `updateBenchmarkStatus`, `listBenchmarkRuns`, `getBenchmarkRequirement`
- `src/core/benchmark/results.ts` — `writeResults`, `readResults`, `writeEnvironment`, `readEnvironment`, slug validation
- `src/core/benchmark/companion.ts` — `scaffoldCompanionRepo`, `writeMethodology`, template rendering
- `templates/benchmark/methodology.md` — METHODOLOGY.md scaffold template
- `src/cli/draft.ts` — `runDraftInit`/`runDraftShow`/`runDraftValidate`/`runDraftAddAsset`/`runDraftComplete`, `DraftPaths`, slug validation, phase boundary
- `src/core/draft/frontmatter.ts` — `PostFrontmatter` schema, `generateFrontmatter`, `validateFrontmatter`, `serializeFrontmatter`, `parseFrontmatter`
- `src/core/draft/state.ts` — `getDraftPost`, `initDraft`, `completeDraft`, `registerAsset`, `listAssets`, `PLACEHOLDER_PATTERN`
- `src/core/draft/benchmark-data.ts` — `formatBenchmarkTable`, `formatMethodologyRef`, `getBenchmarkContext` (config-driven `githubUser`)
- `src/core/draft/tags.ts` — `readExistingTags` with graceful fallback
- `src/core/draft/template.ts` — `renderDraftTemplate`, content-type-aware sections

### Expected results

All tests should pass. If any fail after your changes:

1. Check if you modified the source files listed above
2. Read the failing test to understand what behavior it expects
3. Fix your code to preserve the expected behavior, or update the test if the behavior change is intentional

### Updating the regression suite

After running the regression suite and before finishing the review, check if any test files touched in this session are NOT already in the suite above:

```bash
# Compare test files modified in uncommitted changes against the suite list
git diff --name-only HEAD -- 'tests/*.test.ts'
git status --short -- 'tests/*.test.ts'
```

For each test file that exercises a newly shipped or migrated feature and is NOT already in the regression suite:

1. **Add it to the `npx vitest run` command** in the bash block above
2. **Add a row to the "What each test covers" table** with: file name, test count, feature name, what it validates
3. **Add any new source files to the "Source files these tests protect" list**
4. **Add a line to the Phase 4 output format** checklist under the current milestone
5. **Start a new milestone section** (e.g., `**Phase 2 — Research (feature/phase-2-research)**`) when the next phase ships

This ensures the suite is always exhaustive: every feature we ship gets regression-protected automatically.

## Phase 2: Full Validation

After regression tests pass, run the full suite:

```bash
npx tsc --noEmit
npm test
npm run build
```

Expected baseline: **0 TypeScript errors, 225 tests passing across 21 suites, clean build** (as of feature/phase-4-draft). Any drift from this baseline is a signal to investigate before merging.

## Phase 3: Code Review of Current Changes

```bash
git branch --show-current
git status
```

**If on a feature branch**, diff against main to see the full feature scope:

```bash
git diff main...HEAD
git diff main...HEAD --stat
```

**If on main**, diff against the last commit:

```bash
git diff HEAD
```

If reviewing a specific commit, check it out or diff against it.

### Focus Areas

1. **Logic errors** and incorrect behavior
2. **Edge cases** that aren't handled
3. **Null/undefined reference** issues
4. **Race conditions** or concurrency issues — especially relevant when CLI and Claude Code skills both write to `state.db`
5. **Security vulnerabilities** — SQL injection (check for string interpolation instead of `?` placeholders), path traversal in import, env var leakage
6. **Resource management** — unclosed database connections (`closeDatabase` called on all paths?), leaked file handles, temp dirs not cleaned in tests
7. **API contract violations** — PostFrontmatter schema drift vs m0lz.00, CLI flag changes that break scripts
8. **Caching bugs** — the SQLite layer has no caching, but watch for prepared-statement reuse across closed DBs
9. **Pattern violations** — check CLAUDE.md and `.claude/rules/` for project conventions:
   - ESM imports MUST use `.js` extension on internal imports
   - SQL queries MUST use parameterized statements (`?` or `@named`)
   - better-sqlite3 is synchronous — no `async/await` for DB operations
   - CLI commands are non-interactive (Commander.js options only, no readline prompts)
   - No emojis in content or user-facing output
   - Pipeline operations must be idempotent

### Rules

- Use sub-agents to explore the codebase in parallel for efficiency
- Report pre-existing bugs found near the changed code — code quality matters everywhere
- Do NOT report speculative or low-confidence issues — conclusions must be based on actual code understanding
- If reviewing a specific git commit, note that local code may differ from that commit

## Phase 4: Output Format

### Migration Status

```
Schema Drift: NONE / DETECTED (tables/columns affected)
SCHEMA_VERSION Bumped: YES / NO / N/A
Fresh init works: PASS / FAIL
Action: Bump SCHEMA_VERSION and add migration block, or N/A
```

### Regression Suite Results

```
Regression Suite: PASS / FAIL

Phase 1 — Foundation:
  - Database schema + connection (7 tests): ✓ / ✗
  - Config loader (6 tests): ✓ / ✗
  - Post import (5 tests): ✓ / ✗
  - Ideas backlog CRUD (11 tests): ✓ / ✗
  - Content type detection (6 tests): ✓ / ✗
  - CLI handlers (13 tests): ✓ / ✗

Phase 2 — Research:
  - Schema v1->v2 migration (3 tests): ✓ / ✗
  - Research post lifecycle (9 tests): ✓ / ✗
  - Source management (11 tests): ✓ / ✗
  - Research documents (18 tests): ✓ / ✗
  - Research CLI handlers (13 tests): ✓ / ✗

Phase 3 — Benchmark:
  - Environment capture (4 tests): ✓ / ✗
  - Benchmark state lifecycle (15 tests): ✓ / ✗
  - Results storage (5 tests): ✓ / ✗
  - Companion repo scaffolding (6 tests): ✓ / ✗
  - Benchmark CLI handlers (14 tests): ✓ / ✗

Phase 4 — Draft:
  - PostFrontmatter schema (24 tests): ✓ / ✗
  - Draft state lifecycle (16 tests): ✓ / ✗
  - Benchmark data formatting (8 tests): ✓ / ✗
  - Tag taxonomy reader (6 tests): ✓ / ✗
  - Draft CLI handlers (25 tests): ✓ / ✗

Full Suite: X passing, Y failing  (baseline: 225 passing)
Lint: {error count} errors  (baseline: 0)
Build: PASS / FAIL
```

### Contract Evaluation (if applicable)

```
Contract: {feature name} — Tier {N}
Evaluator: Isolated sub-agent (no implementation context)

| Criterion | Threshold | Score | Pass |
|-----------|-----------|-------|------|
| {name} | {T}/10 | {S}/10 | YES/NO |

Overall: PASS / FAIL
```

If no contract was found in the plan, output: `Contract: N/A — no contract in plan`

### Code Review Findings

Group findings by severity:

**Critical** — Must fix before merge (bugs, security, data loss)

- `file:line` — description of the issue and recommended fix

**Warning** — Should fix (performance, maintainability, pattern violations)

- `file:line` — description and suggestion

**Suggestion** — Consider improving (readability, minor optimizations)

- `file:line` — description and suggestion

**Positive** — What's done well (reinforce good patterns)

- Description of what was done right
