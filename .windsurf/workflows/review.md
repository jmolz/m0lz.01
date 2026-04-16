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
  tests/draft-cli.test.ts \
  tests/evaluate-reviewer.test.ts \
  tests/evaluate-autocheck.test.ts \
  tests/evaluate-synthesize.test.ts \
  tests/evaluate-report.test.ts \
  tests/evaluate-state.test.ts \
  tests/evaluate-cli.test.ts
```

### What each test covers

#### Phase 1 — Foundation

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/db.test.ts` (7 tests) | SQLite schema + connection | All 8 tables created; `user_version` matches `SCHEMA_VERSION`; WAL mode enabled on file-backed DB; foreign keys enforced; CHECK constraints reject invalid phase values; insert/retrieve round-trip works |
| `tests/config.test.ts` (6 tests) | `.blogrc.yaml` loader | Valid config parses with repo_path resolved relative to config dir; missing required fields throw descriptive errors; optional sections get sensible defaults; non-existent config file throws |
| `tests/import.test.ts` (5 tests) | m0lz.00 post import | Posts imported from fixture directory with correct frontmatter mapping; idempotent on re-run (INSERT OR IGNORE); throws on missing posts directory; skips posts with malformed YAML frontmatter and warns; skips posts missing required title field |
| `tests/ideas.test.ts` (11 tests) | Editorial backlog CRUD | `loadIdeas` returns empty array for missing file; `saveIdeas` creates YAML and handles empty list; appends to existing file; priority sorting; `startIdea` creates DB row; `startIdea` throws on invalid index; `removeIdea` removes correct entry; `removeIdea` throws on invalid index; `saveIdeas` idempotent; `startIdea` honors INSERT OR IGNORE on slug collision |
| `tests/content-types.test.ts` (6 tests) | Content type detection | Catalog project IDs return `project-launch`; benchmark keywords return `technical-deep-dive`; generic prompts return `analysis-opinion`; project ID takes priority; empty prompt returns default; no false-positives |
| `tests/cli.test.ts` (13 tests) | CLI handler integration | `runStatus` prints formatted table and empty-state message; exits with error when DB missing; `computeMetrics` returns correct aggregates; `runMetrics` prints output; `runInit` creates `.blog-agent/` with all subdirs and state.db; init with `--import` works; init with `--import` prints clean error on failure; `runInit` idempotent on re-run |

#### Phase 2 — Research

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/db-migration.test.ts` (3 tests) | Schema v1->v2 migration | Fresh DB opens at SCHEMA_VERSION=2 with unique source index; seeded v1 DB upgrades to v2 preserving data; re-opening v2 DB is idempotent |
| `tests/research-state.test.ts` (9 tests) | Research post lifecycle | `initResearchPost` creates row with phase=research; idempotent re-init returns existing row unchanged; cross-phase slug collision throws; `getResearchPost` returns row or undefined; `getResearchPost` enforces phase=research boundary; `advancePhase` updates phase and bumps timestamp; rejects invalid phase; rejects missing slug |
| `tests/research-sources.test.ts` (11 tests) | Source management | Inserts source with title/excerpt; deduplicates on (post_slug,url); reports existing source id; errors for missing post; detects source_type; orders by accessed_at; lists all sources; returns empty for no sources; counts correctly; returns 0 for unknown slug; rejects non-research phase posts |
| `tests/research-document.test.ts` (18 tests) | Research documents | Writes template with all required sections; reads back losslessly; refuses overwrite without force; overwrites with force; validates missing file throws; validates all sections present; detects missing sections; detects empty sections; detects malformed frontmatter; documentPath joins correctly; YAML round-trips colons in topic; YAML round-trips quotes and hashes; validateSlug accepts kebab-case; rejects path separators; rejects uppercase/special chars; rejects empty slugs; rejects path traversal |
| `tests/research-cli.test.ts` (13 tests) | Research CLI handlers | `runResearchInit` creates post+doc; refuses overwrite without --force; overwrites with --force; cross-phase safety rejects non-research slugs; rejects path traversal slugs; `runResearchAddSource` inserts and logs; deduplication is idempotent; missing post sets exitCode=1; `runResearchShow` prints fields; missing slug sets exitCode=1; `runResearchFinalize` fails on insufficient sources; fails on empty sections; passes when requirements met |

#### Phase 3 — Benchmark

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/benchmark-environment.test.ts` (4 tests) | Environment capture | `captureEnvironment` returns all required fields as non-empty strings; total_memory_gb is positive integer; values stable across consecutive calls; `formatEnvironmentMarkdown` includes OS, architecture, Node.js version |
| `tests/benchmark-state.test.ts` (15 tests) | Benchmark state lifecycle | `initBenchmark` transitions research→benchmark and parses targets; rejects non-research and missing posts; `getBenchmarkPost` returns benchmark-phase post, undefined for missing, throws for wrong phase; `skipBenchmark` transitions to draft with has_benchmarks=0; rejects non-research; `createBenchmarkRun` inserts pending row; `updateBenchmarkStatus` transitions pending→running→completed; `listBenchmarkRuns` returns ordered; `completeBenchmark` sets has_benchmarks=1 and advances to draft; rejects non-benchmark and missing posts; `getBenchmarkRequirement` routes content types correctly |
| `tests/benchmark-results.test.ts` (5 tests) | Results storage | `writeResults`/`readResults` round-trip data; returns null for nonexistent; `writeEnvironment`/`readEnvironment` round-trip; slug validation rejects path traversal for all four functions |
| `tests/benchmark-companion.test.ts` (6 tests) | Companion repo scaffolding | Creates src/, results/, METHODOLOGY.md, LICENSE, README.md; METHODOLOGY.md contains environment details; README.md lists targets; LICENSE contains MIT; idempotent re-scaffold preserves existing files; `writeMethodology` replaces all template placeholders |
| `tests/benchmark-cli.test.ts` (14 tests) | Benchmark CLI handlers | `runBenchmarkInit` transitions and prints targets; rejects non-research; rejects skip content type; warns optional but proceeds for project-launch; `runBenchmarkEnv` captures and writes file; rejects non-benchmark; `runBenchmarkRun` stores results and marks completed; rejects missing environment; `runBenchmarkShow` displays state with run count; `runBenchmarkSkip` advances analysis-opinion to draft; refuses required; `runBenchmarkComplete` advances to draft; rejects non-benchmark; all handlers reject invalid slugs |

#### Phase 4 — Draft

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/draft-frontmatter.test.ts` (24 tests) | PostFrontmatter schema | `generateFrontmatter` produces canonical URL, companion_repo when has_benchmarks, project from project_id, published=false, placeholder title/description; `validateFrontmatter` passes valid, fails missing/placeholder title/description/date/tags/published, rejects invalid date format, empty tags, non-boolean published; `serializeFrontmatter`/`parseFrontmatter` round-trip with optional fields omitted; `parseFrontmatter` extracts from MDX, throws on missing delimiters and invalid YAML, does not coerce `"false"` to true, does not mis-split on body thematic break |
| `tests/draft-state.test.ts` (16 tests) | Draft state lifecycle | `getDraftPost` returns draft-phase post, throws for wrong phase, undefined for missing; `initDraft` creates directory structure and template MDX, is idempotent, includes content-type-specific sections (technical-deep-dive has benchmarks, analysis-opinion has analysis), throws for missing post; `completeDraft` advances to evaluate, rejects placeholder sections, rejects missing asset files, throws for wrong phase and missing post; `registerAsset` inserts and is idempotent (transactional); `listAssets` returns ordered list, empty for unknown slug |
| `tests/draft-benchmark-data.test.ts` (8 tests) | Benchmark data formatting | `formatBenchmarkTable` produces markdown from simple key-value, handles empty data, array values as rows, nested objects flattened one level; `formatMethodologyRef` produces correct reference string and honors `githubUser` from config (no hardcoded user); `getBenchmarkContext` reads existing results/environment, returns nulls for missing files |
| `tests/draft-tags.test.ts` (6 tests) | Tag taxonomy reader | `readExistingTags` reads tags from MDX files, subdirectory-based posts, deduplicates, returns sorted; returns empty for missing directory, no MDX files, files without tags field |
| `tests/draft-cli.test.ts` (25 tests) | Draft CLI handlers | `runDraftInit` creates draft directory and template MDX with content-type-aware sections (technical-deep-dive, analysis-opinion, project-launch, project-launch with benchmarks), errors for wrong phase; `runDraftShow` prints status, errors for wrong phase, treats malformed config as best-effort; `runDraftValidate` fails for placeholders, passes for complete draft, fails for missing assets; `runDraftAddAsset` registers existing file, errors for missing file and invalid type, rejects path traversal and subdirectory filenames; `runDraftComplete` advances to evaluate, errors for wrong phase; rejects 6 invalid slug patterns |

#### Phase 5 — Evaluate

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/evaluate-reviewer.test.ts` (21 tests) | ReviewerOutput schema | `normalizeText` lowercases, strips punctuation, collapses whitespace; `issueFingerprint` is deterministic, normalizes case/whitespace, differs by reviewer, returns 12-char hex; `validateReviewerOutput` accepts valid outputs and empty issues, rejects missing reviewer, unknown enum, non-boolean passed, non-array issues, malformed Issue fields; `parseReviewerOutput` parses valid JSON, throws descriptive errors for invalid JSON and schema violations |
| `tests/evaluate-autocheck.test.ts` (15 tests) | Deterministic structural lints | Two runs produce byte-identical output; issues sorted by (category, id); valid draft yields zero issues; missing draft returns empty list; catches frontmatter-placeholder, frontmatter-schema, placeholder-section, broken-internal-link (both /writing/ and anchor), mdx-parse unbalanced fences, benchmark-claim-unbacked for numbers not in results.json; skips benchmark-claim-unbacked silently when no results.json; catches missing-companion-repo when has_benchmarks=1 without companion_repo; does not flag when companion_repo is present; every issue tagged source=autocheck |
| `tests/evaluate-synthesize.test.ts` (24 tests) | Two-tier issue matching + categorization | `tokenize` produces unique token set; `jaccardSimilarity` returns 1 for identical, 0 for disjoint, partial ratio for overlap; Tier 1 fingerprint clusters identical issues across reviewers, handles whitespace/case differences; Tier 2 Jaccard matches paraphrased issues >= 0.6, does not match below threshold; same-reviewer dedupes to one cluster with reviewers.size=1; `categorize` returns consensus/majority/single by reviewer count; two-reviewer analysis-opinion uses 2/2=consensus, 1/2=single (no majority bucket); `computeVerdict` is pass iff consensus=0 AND majority=0; synthesize end-to-end produces 1 consensus + 1 majority + 1 single for canonical scenario; all-empty reviewers yield pass with zero counts; `JACCARD_THRESHOLD` exported as 0.6 |
| `tests/evaluate-report.test.ts` (4 tests) | Synthesis report renderer | Renders all five sections (Consensus, Majority, Single, Disagreements, Per-Reviewer Summaries); fail verdict shows FAIL badge; empty categories render as "(none)"; per-reviewer block includes model name and issue count |
| `tests/evaluate-state.test.ts` (78 tests) | Evaluation state lifecycle | `expectedReviewers` routes content types to 3 vs 2 reviewers; `getEvaluatePost` enforces phase boundary; `initEvaluation` creates manifest with correct reviewers, is idempotent, promotes from draft, rejects wrong phase, purges stale reviewer artifacts when rolling a new cycle; `recordReview` inserts row, rejects reviewer mismatch between arg and output, rejects reviewer not in expected list for analysis-opinion, allows re-record with dedupe on list, enforces phase boundary; `runSynthesis` throws on missing reviewers, writes row + report on success, updates posts.evaluation_passed, throws on corrupt issues_json without writing partial row, captures MAX(id) inside the synthesis transaction (race-free pin); `completeEvaluation` advances on pass, throws on fail, throws without synthesis, fail-closed when synthesis pin is missing; `rejectEvaluation` moves back to draft with .rejected_at marker, flags subsequent records with is_update_review=1, enforces phase; `readReviewerOutputFromFile` validates; `listRecordedReviewers`/`readManifest` return correct shape |
| `tests/evaluate-cli.test.ts` (21 tests) | Evaluate CLI handlers | `runEvaluateInit` creates 3-reviewer manifest for technical-deep-dive, 2-reviewer for analysis-opinion, promotes draft-phase posts; all 7 handlers set exitCode=1 for invalid slugs; `runEvaluateAutocheck` writes structural.lint.json that is byte-equal across reruns; `runEvaluateRecord` rejects malformed JSON with descriptive error, rejects reviewer not in expected list (methodology for analysis-opinion), rejects invalid reviewer enum; `runEvaluateShow` prints status table and verdict, cycle-scoped after reject+re-init (prior reviewers render as pending, old verdict not shown as current, historical cycles summarized); `runEvaluateSynthesize` refuses when reviewers missing, prints pass verdict after all recorded; `runEvaluateComplete` advances to publish on pass, exitCode=1 on fail; `runEvaluateReject` moves to draft (verified via direct DB query), enforces phase boundary |

### Source files these tests protect

- `src/core/db/schema.ts`, `src/core/db/database.ts`, `src/core/db/types.ts`
- `src/core/config/loader.ts`, `src/core/config/types.ts`
- `src/core/migrate/import-posts.ts`
- `src/core/draft/content-types.ts`
- `src/cli/index.ts`, `src/cli/init.ts`, `src/cli/status.ts`, `src/cli/metrics.ts`, `src/cli/ideas.ts`
- `src/cli/research.ts`
- `src/core/research/state.ts`, `src/core/research/sources.ts`, `src/core/research/document.ts`
- `src/cli/benchmark.ts`
- `src/core/benchmark/environment.ts`, `src/core/benchmark/state.ts`, `src/core/benchmark/results.ts`, `src/core/benchmark/companion.ts`
- `templates/benchmark/methodology.md`
- `src/cli/draft.ts`
- `src/core/draft/frontmatter.ts`, `src/core/draft/state.ts`, `src/core/draft/benchmark-data.ts`, `src/core/draft/tags.ts`, `src/core/draft/template.ts`
- `src/cli/evaluate.ts`
- `src/core/evaluate/reviewer.ts`, `src/core/evaluate/autocheck.ts`, `src/core/evaluate/synthesize.ts`, `src/core/evaluate/report.ts`, `src/core/evaluate/state.ts`
- `skills/blog-evaluate.md`

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

Expected baseline: **0 TypeScript errors, 388 tests passing across 27 suites, clean build** (as of feature/phase-5-evaluate). Any drift from this baseline is a signal to investigate before merging.

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

```text
Schema Drift: NONE / DETECTED (tables/columns affected)
SCHEMA_VERSION Bumped: YES / NO / N/A
Fresh init works: PASS / FAIL
Action: Bump SCHEMA_VERSION and add migration block, or N/A
```

### Regression Suite Results

```text
Regression Suite: PASS / FAIL

Phase 1 — Foundation:
  - Database schema + connection (7 tests): PASS / FAIL
  - Config loader (6 tests): PASS / FAIL
  - Post import (5 tests): PASS / FAIL
  - Ideas backlog CRUD (11 tests): PASS / FAIL
  - Content type detection (6 tests): PASS / FAIL
  - CLI handlers (13 tests): PASS / FAIL

Phase 2 — Research:
  - Schema v1->v2 migration (3 tests): PASS / FAIL
  - Research post lifecycle (9 tests): PASS / FAIL
  - Source management (11 tests): PASS / FAIL
  - Research documents (18 tests): PASS / FAIL
  - Research CLI handlers (13 tests): PASS / FAIL

Phase 3 — Benchmark:
  - Environment capture (4 tests): PASS / FAIL
  - Benchmark state lifecycle (15 tests): PASS / FAIL
  - Results storage (5 tests): PASS / FAIL
  - Companion repo scaffolding (6 tests): PASS / FAIL
  - Benchmark CLI handlers (14 tests): PASS / FAIL

Phase 4 — Draft:
  - PostFrontmatter schema (24 tests): PASS / FAIL
  - Draft state lifecycle (16 tests): PASS / FAIL
  - Benchmark data formatting (8 tests): PASS / FAIL
  - Tag taxonomy reader (6 tests): PASS / FAIL
  - Draft CLI handlers (25 tests): PASS / FAIL

Phase 5 — Evaluate:
  - ReviewerOutput schema (18 tests): PASS / FAIL
  - Structural autocheck lints (15 tests): PASS / FAIL
  - Synthesis + matching (24 tests): PASS / FAIL
  - Report renderer (4 tests): PASS / FAIL
  - Evaluation state lifecycle (46 tests): PASS / FAIL
  - Evaluate CLI handlers (19 tests): PASS / FAIL

Full Suite: X passing, Y failing  (baseline: 388 passing)
Lint: {error count} errors  (baseline: 0)
Build: PASS / FAIL
```

### Contract Evaluation (if applicable)

```text
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
