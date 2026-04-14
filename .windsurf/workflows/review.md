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
  tests/research-cli.test.ts
```

### What each test covers

**Phase 1 — Foundation (feature/phase-1-foundation)**

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/db.test.ts` (7 tests) | SQLite schema + connection | All 8 tables created; `user_version` matches `SCHEMA_VERSION`; WAL mode enabled on file-backed DB; foreign keys enforced; CHECK constraints reject invalid phase values; insert/retrieve round-trip works |
| `tests/config.test.ts` (6 tests) | `.blogrc.yaml` loader | Valid config parses with repo_path resolved relative to config dir; missing required fields throw descriptive errors; optional sections get sensible defaults; non-existent config file throws |
| `tests/import.test.ts` (5 tests) | m0lz.00 post import | Posts imported from fixture directory with correct frontmatter mapping; idempotent on re-run (INSERT OR IGNORE); throws on missing posts directory; skips posts with malformed YAML frontmatter and warns; skips posts missing required title field |
| `tests/ideas.test.ts` (11 tests) | Editorial backlog CRUD | `loadIdeas` returns empty array for missing file; `saveIdeas` creates YAML and handles empty list; appends to existing file; priority sorting; `startIdea` creates DB row; `startIdea` throws on invalid index; `removeIdea` removes correct entry; `removeIdea` throws on invalid index; `saveIdeas` idempotent; `startIdea` honors INSERT OR IGNORE on slug collision |
| `tests/content-types.test.ts` (6 tests) | Content type detection | Catalog project IDs return `project-launch`; benchmark keywords return `technical-deep-dive`; generic prompts return `analysis-opinion`; project ID takes priority; empty prompt returns default; no false-positives |
| `tests/cli.test.ts` (13 tests) | CLI handler integration | `runStatus` prints formatted table and empty-state message; exits with error when DB missing; `computeMetrics` returns correct aggregates; `runMetrics` prints output; `runInit` creates `.blog-agent/` with all subdirs and state.db; init with `--import` works; init with `--import` prints clean error on failure; `runInit` idempotent on re-run |

**Phase 2 — Research (feature/phase-2-research)**

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/db-migration.test.ts` (3 tests) | Schema v1->v2 migration | Fresh DB opens at SCHEMA_VERSION=2 with unique source index; seeded v1 DB upgrades to v2 preserving data; re-opening v2 DB is idempotent |
| `tests/research-state.test.ts` (9 tests) | Research post lifecycle | `initResearchPost` creates row with phase=research; idempotent re-init returns existing row unchanged; cross-phase slug collision throws; `getResearchPost` returns row or undefined; `getResearchPost` enforces phase=research boundary; `advancePhase` updates phase and bumps timestamp; rejects invalid phase; rejects missing slug |
| `tests/research-sources.test.ts` (11 tests) | Source management | Inserts source with title/excerpt; deduplicates on (post_slug,url); reports existing source id; errors for missing post; detects source_type; orders by accessed_at; lists all sources; returns empty for no sources; counts correctly; returns 0 for unknown slug; rejects non-research phase posts |
| `tests/research-document.test.ts` (18 tests) | Research documents | Writes template with all required sections; reads back losslessly; refuses overwrite without force; overwrites with force; validates missing file throws; validates all sections present; detects missing sections; detects empty sections; detects malformed frontmatter; documentPath joins correctly; YAML round-trips colons in topic; YAML round-trips quotes and hashes; validateSlug accepts kebab-case; rejects path separators; rejects uppercase/special chars; rejects empty slugs; rejects path traversal |
| `tests/research-cli.test.ts` (13 tests) | Research CLI handlers | `runResearchInit` creates post+doc; refuses overwrite without --force; overwrites with --force; cross-phase safety rejects non-research slugs; rejects path traversal slugs; `runResearchAddSource` inserts and logs; deduplication is idempotent; missing post sets exitCode=1; `runResearchShow` prints fields; missing slug sets exitCode=1; `runResearchFinalize` fails on insufficient sources; fails on empty sections; passes when requirements met |

### Source files these tests protect

- `src/core/db/schema.ts`, `src/core/db/database.ts`, `src/core/db/types.ts`
- `src/core/config/loader.ts`, `src/core/config/types.ts`
- `src/core/migrate/import-posts.ts`
- `src/core/draft/content-types.ts`
- `src/cli/index.ts`, `src/cli/init.ts`, `src/cli/status.ts`, `src/cli/metrics.ts`, `src/cli/ideas.ts`
- `src/cli/research.ts`
- `src/core/research/state.ts`, `src/core/research/sources.ts`, `src/core/research/document.ts`

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

Expected baseline: **0 TypeScript errors, 102 tests passing across 11 suites, clean build** (as of feature/phase-2-research). Any drift from this baseline is a signal to investigate before merging.

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

Full Suite: X passing, Y failing  (baseline: 102 passing)
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
