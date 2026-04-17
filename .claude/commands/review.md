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
  tests/evaluate-cli.test.ts \
  tests/publish-state.test.ts \
  tests/publish-pipeline.test.ts \
  tests/publish-convert.test.ts \
  tests/publish-site.test.ts \
  tests/publish-crosspost.test.ts \
  tests/publish-social.test.ts \
  tests/publish-research-page.test.ts \
  tests/publish-repo.test.ts \
  tests/publish-cli.test.ts \
  tests/publish-site-updates.test.ts
```

### What each test covers

**Phase 1 — Foundation (feature/phase-1-foundation)**

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/db.test.ts` (7 tests) | SQLite schema + connection | All 8 tables created (posts, sources, benchmarks, pipeline_steps, assets, evaluations, evaluation_synthesis, metrics); `user_version` matches `SCHEMA_VERSION`; WAL mode enabled on file-backed DB; foreign keys enforced; CHECK constraints reject invalid phase values; insert/retrieve round-trip works |
| `tests/config.test.ts` (10 tests) | `.blogrc.yaml` loader | Valid config parses with repo_path resolved relative to config dir; missing `site.repo_path` / `author.name` / `author.github` throw descriptive errors; optional sections get sensible defaults; non-existent config file throws; Phase 6 adds: `site.research_dir` defaults to `content/posts/research` when omitted; `projects` field accepted as optional map; `projects` validation rejects non-object entries; `projects` keys allowed to use dots (e.g., `m0lz.02`) |
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

**Phase 5 — Evaluate (feature/phase-5-evaluate)**

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/evaluate-reviewer.test.ts` (21 tests) | ReviewerOutput schema | `normalizeText` lowercases, strips punctuation, collapses whitespace; `issueFingerprint` is deterministic, normalizes case/whitespace, differs by reviewer, returns 12-char hex; `validateReviewerOutput` accepts valid outputs and empty issues, rejects missing reviewer, unknown enum, non-boolean `passed`, non-array issues, malformed Issue fields; `parseReviewerOutput` parses valid JSON, throws descriptive errors for invalid JSON and schema violations |
| `tests/evaluate-autocheck.test.ts` (15 tests) | Deterministic structural lints | Two runs produce byte-identical output; issues sorted by (category, id); valid draft yields zero issues; missing draft returns empty list; catches `frontmatter-placeholder`, `frontmatter-schema`, `placeholder-section`, `broken-internal-link` (both `/writing/` and anchor), `mdx-parse` unbalanced fences, `benchmark-claim-unbacked` for numbers not in `results.json`; skips `benchmark-claim-unbacked` silently when no `results.json`; catches `missing-companion-repo` when `has_benchmarks=1` without `companion_repo`; does not flag when `companion_repo` is present; every issue tagged `source=autocheck` |
| `tests/evaluate-synthesize.test.ts` (24 tests) | Two-tier issue matching + categorization | `tokenize` produces unique token set; `jaccardSimilarity` returns 1 for identical, 0 for disjoint, partial ratio for overlap; Tier 1 fingerprint clusters identical issues across reviewers, handles whitespace/case differences; Tier 2 Jaccard matches paraphrased issues >= 0.6, does not match below threshold; same-reviewer dedupes to one cluster with `reviewers.size=1`; `categorize` returns consensus/majority/single by reviewer count; two-reviewer `analysis-opinion` uses 2/2=consensus, 1/2=single (no majority bucket); `computeVerdict` is pass iff consensus=0 AND majority=0; `synthesize` end-to-end produces 1 consensus + 1 majority + 1 single for canonical scenario; all-empty reviewers yield pass with zero counts; `JACCARD_THRESHOLD` exported as 0.6 |
| `tests/evaluate-report.test.ts` (4 tests) | Synthesis report renderer | Renders all five sections (Consensus, Majority, Single, Disagreements, Per-Reviewer Summaries); fail verdict shows FAIL badge; empty categories render as "(none)"; per-reviewer block includes model name and issue count |
| `tests/evaluate-state.test.ts` (78 tests) | Evaluation state lifecycle | `expectedReviewers` routes content types to 3 vs 2 reviewers; `getEvaluatePost` enforces phase boundary; `initEvaluation` creates manifest with correct reviewers, is idempotent, promotes from draft, rejects wrong phase, purges stale reviewer artifacts when rolling a new cycle; `recordReview` inserts row, rejects reviewer mismatch between arg and output, rejects reviewer not in expected list for `analysis-opinion`, allows re-record with dedupe on `listRecordedReviewers`, enforces phase boundary; `runSynthesis` throws on missing reviewers, writes row + report on success, updates `posts.evaluation_passed`, throws on corrupt `issues_json` without writing partial row, captures `MAX(id)` inside the synthesis transaction (race-free pin); `completeEvaluation` advances on pass, throws on fail, throws without synthesis, fail-closed when synthesis pin is missing; `rejectEvaluation` moves back to draft with `.rejected_at` marker, flags subsequent records with `is_update_review=1`, enforces phase; `readReviewerOutputFromFile` validates; `listRecordedReviewers` / `readManifest` return correct shape |
| `tests/evaluate-cli.test.ts` (21 tests) | Evaluate CLI handlers | `runEvaluateInit` creates 3-reviewer manifest for technical-deep-dive, 2-reviewer for analysis-opinion, promotes draft-phase posts; all 7 handlers set `exitCode=1` for invalid slugs; `runEvaluateAutocheck` writes `structural.lint.json` that is byte-equal across reruns; `runEvaluateRecord` rejects malformed JSON with descriptive error, rejects reviewer not in expected list (methodology for analysis-opinion), rejects invalid reviewer enum; `runEvaluateShow` prints status table and verdict, cycle-scoped after reject+re-init (prior reviewers render as pending, old verdict not shown as current, historical cycles summarized); `runEvaluateSynthesize` refuses when reviewers missing, prints pass verdict after all recorded; `runEvaluateComplete` advances to publish on pass, `exitCode=1` on fail; `runEvaluateReject` moves to draft (verified via direct DB query), enforces phase boundary |

**Phase 6 — Publish (feature/phase-6-publish)**

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/publish-state.test.ts` (43 tests) | Phase + steps-crud + lock + crash-safety helpers | `getPublishPost` phase boundary; `initPublishFromEvaluate` rejects non-evaluate phase, rejects `evaluation_passed=0`, idempotent when already in publish; `initPublish` acquires lock, advances phase, seeds 11 `pipeline_steps` rows via `INSERT OR IGNORE`; `createPipelineSteps` applies content-type + config pre-skips (analysis-opinion skips companion-repo + research-page, project-launch skips companion-repo, `publish.devto/medium/substack=false` skips corresponding steps); `getNextPendingStep` returns first pending OR failed in step_number order; `markStepRunning/Completed/Failed/Skipped` transitions work; `allStepsComplete` requires all 11 rows completed or skipped; `reclaimStaleRunning` demotes `running` → `pending` and returns count (Codex-Critical-1 regression); **`reconcilePipelineSteps` downgrades pending/failed rows to skipped when current config disables them — operator can toggle optional destinations (publish.devto/medium/substack) between runs (Codex Pass 6 regression); does NOT upgrade skipped rows back to pending (sticky-within-cycle policy)**; `persistPublishUrls` first-writer-wins via COALESCE (Codex-Critical-2 regression); `completePublishUnderLock` idempotent on already-published row; **runtime lock-ownership guardrail: throws when lockfile missing (Codex Pass 4 Suggestion); throws when lockfile holds different PID**; `completePublish` gates on `allStepsComplete`, COALESCE URL writes; `acquirePublishLock` stamps PID, blocks live-holder, reclaims dead-PID stale, reclaims empty/garbage lockfile; release is idempotent |
| `tests/publish-pipeline.test.ts` (20 tests) | `runPipeline` orchestrator + crash-safety regressions | Runs steps in step_number order; skips already-completed on resume; re-runs failed steps; stops on `paused` outcome and reverts step to pending; stops on `failed` outcome and records `error_message`; stops on thrown exception; merges `urlUpdates` into `ctx.urls` in-memory AND persists to posts row per-step via transaction (crash-safety); completes pipeline when all steps terminal, advances phase via `completePublishUnderLock`; does NOT advance on failure/pause; releases lock after success + failure; returns `{completed, stepsRun, totalSteps, failedStep?, pausedStep?}`; defensive branch when pipeline_steps table is empty; **regression: reclaims stuck `running` step on resume and re-executes in order (Codex-Critical-1); persists URLs per-step even if process dies before completion (Codex-Critical-2); does not deadlock at completion (no release-then-reacquire); reconciles pending rows against current config so operators can disable optional destinations mid-pipeline (Codex Pass 6 regression)** |
| `tests/publish-convert.test.ts` (12 tests) | MDX → Markdown converter | Strips YAML frontmatter; removes `import` statements outside fences; removes JSX self-closing tags; preserves text children of block JSX; resolves relative `./assets/x` and `assets/x` to absolute `{base}/writing/{slug}/assets/x`; **preserves code blocks verbatim — no JSX stripping / no URL resolution inside ``` fences, including nested backtick fences (```` vs ```)**; preserves tables, headings, lists; collapses 3+ blank lines to 2; passthrough for plain Markdown; handles empty input |
| `tests/publish-site.test.ts` (18 tests) | `createSitePR` + `checkPreviewGate` (site repo PR management) | Copies draft MDX to `{siteRepoPath}/{config.site.content_dir}/{slug}/index.mdx`; copies assets directory recursively; copies research page to `config.site.research_dir`; creates branch `post/{slug}` from main; idempotent on existing branch (checkout vs create); commits with `feat(post):` prefix; pushes and opens PR via `gh pr create`; idempotent on existing PR (skips create); writes `pr-number.txt` for preview-gate lookup; `checkPreviewGate` polls `gh pr view --json state,mergedAt`, returns `merged=true` when MERGED, returns `merged=false` with guidance when open; all subprocess via `execFileSync` with argv arrays (no shell); **dirty-state guardrail: throws when repo has uncommitted unrelated changes (Codex Pass 4 regression); tolerates dirty state under pipeline-owned paths; stages only `content/posts/{slug}` and `content/research/{slug}` — no `git add .`**; **rename/copy porcelain parsing: rejects R/C records whose destination escapes owned prefixes (Codex Pass 5 regression); tolerates renames where both source and destination are owned** |
| `tests/publish-crosspost.test.ts` (18 tests) | Dev.to probe-then-create + Medium + Substack paste | `mapDevToTags` lowercases, hyphenates spaces, strips non-alphanumeric, caps at 4, drops empty; `crosspostToDevTo` skips when `DEVTO_API_KEY` missing or empty; builds POST with api-key header, canonical_url, `published:false`, tags, description; throws on 422 with context; throws on 503+; **probe-then-create: GET `/api/articles/me/all` before POST, returns existing id/url if canonical_url matches (Codex Pass 2 regression); trailing-slash normalization; probe failure throws (no fall-through to POST); paginates beyond page 1 (match on page 2); stops on short page (no unnecessary page 2 fetch) — Codex Pass 3 regression**; `generateMediumPaste` writes file with H1 title, description, body, canonical footer, creates nested `socialDir/slug`; `generateSubstackPaste` same pattern with H1 title + H2 subtitle; both apply mdxToMarkdown preserving code blocks |
| `tests/publish-social.test.ts` (14 tests) | LinkedIn + Hacker News text generation | `containsEmoji` detects U+1F300-1FAFF and U+2600-27BF ranges; `generateLinkedIn` fills template with title, description, takeaway, canonical_url, hashtags from tags; throws if output contains emojis; includes timing recommendation when `config.social.timing_recommendations=true`; writes to `{socialDir}/{slug}/linkedin.md`; `generateHackerNews` title ≤80 chars (truncates with ellipsis); `Show HN:` prefix ONLY for `project-launch`, no prefix for `technical-deep-dive` / `analysis-opinion`; includes first-comment, canonical_url, repo link; throws on emoji; writes `hackernews.md`; creates output dir |
| `tests/publish-research-page.test.ts` (10 tests) | Research page MDX generator | Generates from research doc + benchmark results; includes thesis, key findings, bibliography; cross-links to post canonical URL and companion repo URL; skips for `analysis-opinion` when research doc absent with clear reason; generates for `analysis-opinion` WHEN research doc present; fills template placeholders (`{{title}}`, `{{thesis}}`, etc.); **reads description from draft MDX frontmatter, not from posts table (schema has no description column)**; idempotent (second run overwrites consistently); throws when template file missing; throws when post not in DB |
| `tests/publish-repo.test.ts` (21 tests) | Companion repo probe-then-create + origin-URL guardrail | Skips for `analysis-opinion` with reason "No companion repo for analysis-opinion"; skips for `project-launch` with reason "Existing project repo"; for `technical-deep-dive`: probes with `gh repo view`, success → ensures remote and pushes to main; missing → runs `gh repo create --public --source=. --push` with description; race fallback on "already exists" stderr → adds remote + pushes; builds repo name as `{config.author.github}/{slug}` (not hardcoded); returns `repo_url` for frontmatter propagation; handles `reposDir/{slug}` missing as skip; subprocess via `execFileSync`; **origin-URL guardrail (Codex Pass 5 Critical regression): throws when origin points at a different GitHub repo (SSH or HTTPS form), throws for non-GitHub remotes, accepts when owner/name match; race-fallback branch enforces the same guardrail**; `parseGitHubRemoteUrl` helper validated across SSH-with/without-.git, HTTPS-with/without-.git, non-GitHub hosts, garbage input |
| `tests/publish-cli.test.ts` (15 tests) | Publish CLI handlers (`blog publish start` / `show`) | Invalid slug → exitCode=1 before DB open; post not found → descriptive error; wrong phase (e.g., research) → exitCode=1 with valid-phases hint; evaluate phase → promotes + seeds 11 steps + runs pipeline; publish phase → resumes without duplicating rows; runner `completed:true` → success log; `pausedStep` → info log (NOT error); `failedStep` → exitCode=1; runner throws → "pipeline crashed" message; `runPublishShow` prints slug/phase/step table; empty table prints "No pipeline steps yet"; malformed config is best-effort (show still prints); **ctx.urls hydrated from posts row URL columns before runPipeline (Codex Pass 2 regression) — resumed runs see prior-invocation URLs**; fresh publish hydrates to empty object |
| `tests/publish-site-updates.test.ts` (20 tests) | `updateFrontmatter` + `updateProjectReadme` (direct-push steps 9 & 10) | `updateFrontmatter`: **switches to main BEFORE any file mutation (Codex Pass 4 Critical regression — prior ordering made checkout fail on stale local main)**; writes `published:true`, `canonical`, `devto_url`, `companion_repo` to site MDX frontmatter; commits with `chore(post):` prefix; pushes to `origin main`; uses `execFileSync` with argv arrays; idempotent no-op when nothing staged AND HEAD not ahead of origin; **crash-replay push-ahead uses `inspectAheadCommits` with strict match: requires exactly 1 ahead commit, subject == `chore(post): {slug} add platform URLs`, touched file == `{content_dir}/{slug}/index.mdx` — throws on wrong subject, wrong file, or 2+ commits ahead (Codex Pass 4 High regression prevents shipping operator's unrelated local work)**; throws on missing site repo; throws on missing MDX; **index-cleanness guardrail via `assertIndexClean`: refuses to proceed when operator has staged unrelated files — otherwise the subsequent `git commit` would sweep them into the chore(post): commit and push to origin/main (Codex Pass 6 regression)**; `updateProjectReadme`: resolves `config.projects[id]` against `dirname(configPath)` (relative path works); switches to main before file mutation; same index-cleanness guardrail on project repo; inserts link under `## Writing` heading; creates heading when absent; **commits with `chore:` prefix (not `docs:`) per contract**; skips when no `project_id`, when no `projects` config entry, when project dir missing; idempotent when canonical URL already in README; crash-replay push-ahead uses same strict match; refuses to push unrelated local README commits; throws on missing post |

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
- `src/cli/evaluate.ts` — `runEvaluateInit`/`runEvaluateAutocheck`/`runEvaluateRecord`/`runEvaluateShow`/`runEvaluateSynthesize`/`runEvaluateComplete`/`runEvaluateReject`, `EvaluatePaths`, slug validation, phase boundary
- `src/core/evaluate/reviewer.ts` — `Issue`/`ReviewerOutput` types, `normalizeText`, `issueFingerprint`, `validateReviewerOutput`, `parseReviewerOutput`
- `src/core/evaluate/autocheck.ts` — `runStructuralAutocheck` (deterministic lints: frontmatter, placeholders, broken links, MDX parse, benchmark claims, companion repo)
- `src/core/evaluate/synthesize.ts` — `tokenize`, `jaccardSimilarity`, `matchIssues`, `categorize`, `computeVerdict`, `synthesize`, `JACCARD_THRESHOLD`
- `src/core/evaluate/report.ts` — `renderSynthesisReport`
- `src/core/evaluate/state.ts` — `getEvaluatePost`, `expectedReviewers`, `initEvaluation`, `recordReview`, `runSynthesis`, `completeEvaluation`, `rejectEvaluation`, phase boundary enforcement
- `skills/blog-evaluate.md` — three-reviewer workflow, Codex CLI invocation templates, degraded-mode fallback
- `src/cli/publish.ts` — `runPublishStart`/`runPublishShow`, `PublishCliPaths`, slug validation, phase dispatch (evaluate→promote, publish→resume), ctx.urls hydration from posts row
- `src/core/publish/types.ts` — `PUBLISH_STEP_NAMES` 11-tuple (authoritative ordering), `PublishStepName`/`PublishStepStatus` enums, `PipelineStepRow`, `PublishUrls`, `PublishPaths`, `PostRow` re-export
- `src/core/publish/lock.ts` — `acquirePublishLock` (O_CREAT|O_EXCL + PID stamp, stale-PID reclaim via `process.kill(pid,0)`, empty/garbage lockfile reclaim, Atomics.wait spin, release is idempotent)
- `src/core/publish/phase.ts` — `getPublishPost`, `initPublishFromEvaluate`, `initPublish`, `completePublish`, `completePublishUnderLock` (no lock re-entry, idempotent on `published`, runtime lock-ownership guardrail: reads lockfile + verifies PID matches process.pid), `persistPublishUrls` (COALESCE first-writer-wins)
- `src/core/publish/steps-crud.ts` — `createPipelineSteps` (content-type + config pre-skips), `getNextPendingStep`, `markStepRunning/Completed/Failed/Skipped`, `getPipelineSteps`, `allStepsComplete`, `reclaimStaleRunning` (crash-safety), `reconcilePipelineSteps` (resume-time re-application of config-driven skips so optional destinations can be disabled between runs)
- `src/core/publish/convert.ts` — `mdxToMarkdown`, `stripFrontmatter`, `removeImports`, `removeJsxComponents`, `resolveAssetUrls`, fence-aware state machine with nested-backtick handling
- `src/core/publish/research-page.ts` — `generateResearchPage` (reads thesis/findings/bibliography from research doc + benchmark summary from results.json; description from draft frontmatter; skips analysis-opinion without artifacts)
- `src/core/publish/site.ts` — `createSitePR` (dirty-state guardrail with rename/copy-aware porcelain parsing + path-scoped staging: `content/posts/{slug}` + optional `content/research/{slug}`, no `git add .`), `checkPreviewGate`, `resolveSiteRepoPath`, git/gh subprocess wrappers (execFileSync only)
- `src/core/publish/devto.ts` — `crosspostToDevTo`, `probeDevToForCanonical` (paginated GET + canonical match + trailing-slash normalization), `mapDevToTags`
- `src/core/publish/medium.ts` — `generateMediumPaste` (H1 title + canonical footer)
- `src/core/publish/substack.ts` — `generateSubstackPaste` (H1 title + H2 subtitle layout)
- `src/core/publish/repo.ts` — `pushCompanionRepo` (gh repo view probe → gh repo create --source=. --push, with "already exists" race fallback), `parseGitHubRemoteUrl` helper (SSH/HTTPS normalization), `assertOriginMatches` (trust-boundary guardrail: throws when local origin does not match expected `{author.github}/{slug}`)
- `src/core/publish/frontmatter.ts` — `updateFrontmatter` (direct push to main, `chore(post):` prefix, checkout-before-mutation ordering, `assertIndexClean` precheck against operator-staged files, `inspectAheadCommits` helper with strict subject + file match for crash-replay push-ahead)
- `src/core/publish/readme.ts` — `updateProjectReadme` (direct push to main, `chore:` prefix, `config.projects[id]` resolved against dirname(configPath), checkout-before-mutation ordering, shared `assertIndexClean` guardrail, strict crash-replay push-ahead via shared `inspectAheadCommits`)
- `src/core/publish/social.ts` — `generateSocialText`, `generateLinkedIn`, `generateHackerNews`, `containsEmoji` (throws on emojis in generated output)
- `src/core/publish/pipeline-types.ts` — `PipelineContext`, `StepOutcome`, `StepResult`, `StepDefinition`
- `src/core/publish/pipeline-registry.ts` — `PIPELINE_STEPS` array (ordered 11 step-to-module bindings, translates module results to `StepResult`)
- `src/core/publish/pipeline-runner.ts` — `runPipeline` (acquires lock, reclaims stale `running`, reconciles pending rows against current config, executes steps in order, per-step transactional URL persistence, calls `completePublishUnderLock` without lock re-entry)
- `templates/research-page/template.mdx` — research page scaffold with `{{thesis}}`, `{{findings}}`, `{{bibliography}}`, `{{methodology_summary}}`, `{{open_questions}}`, `{{repo_link}}` placeholders
- `templates/social/linkedin.md` — LinkedIn template with `{{title}}`, `{{description}}`, `{{takeaway}}`, `{{canonical_url}}`, `{{hashtags}}`, `{{timing}}` placeholders
- `templates/social/hackernews.md` — HN template with `{{title}}`, `{{canonical_url}}`, `{{first_comment}}`, `{{repo_url}}`, `{{timing}}` placeholders
- `skills/blog-publish.md` — publish workflow narration, 11-step descriptions, manual preview-gate at step 4, resume semantics, troubleshooting (missing DEVTO_API_KEY, gh auth, PR not merged)

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

Expected baseline: **0 TypeScript errors, 646 tests passing across 45 suites, clean build** (as of feature/phase-7-lifecycle). Any drift from this baseline is a signal to investigate before merging.

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
  - Config loader (10 tests): ✓ / ✗
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

Phase 5 — Evaluate:
  - ReviewerOutput schema (21 tests): ✓ / ✗
  - Structural autocheck lints (15 tests): ✓ / ✗
  - Synthesis + matching (24 tests): ✓ / ✗
  - Report renderer (4 tests): ✓ / ✗
  - Evaluation state lifecycle (78 tests): ✓ / ✗
  - Evaluate CLI handlers (21 tests): ✓ / ✗

Phase 6 — Publish:
  - Phase + steps-crud + lock + crash-safety + reconcile (43 tests): ✓ / ✗
  - Pipeline runner + crash-safety + reconcile regressions (20 tests): ✓ / ✗
  - MDX → Markdown converter (12 tests): ✓ / ✗
  - Site PR + preview gate + dirty-state + rename/copy guardrail (18 tests): ✓ / ✗
  - Dev.to probe-then-create + Medium + Substack paste (18 tests): ✓ / ✗
  - Social text: LinkedIn + Hacker News (14 tests): ✓ / ✗
  - Research page generator (10 tests): ✓ / ✗
  - Companion repo probe-then-create + origin-URL guardrail (21 tests): ✓ / ✗
  - Publish CLI handlers + ctx.urls hydration (15 tests): ✓ / ✗
  - updateFrontmatter + updateProjectReadme + index-clean + crash-replay (20 tests): ✓ / ✗

Full Suite: X passing, Y failing  (baseline: 646 passing)
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
