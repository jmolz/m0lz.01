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
  tests/publish-site-updates.test.ts \
  tests/db-migration-v3.test.ts \
  tests/update-cycles.test.ts \
  tests/update-notice.test.ts \
  tests/update-cli.test.ts \
  tests/update-devto.test.ts \
  tests/update-publish-pipeline.test.ts \
  tests/publish-guard.test.ts \
  tests/unpublish-state.test.ts \
  tests/unpublish-cli.test.ts \
  tests/unpublish-readme.test.ts \
  tests/unpublish-site.test.ts \
  tests/unpublish-devto.test.ts \
  tests/unpublish-pipeline.test.ts \
  tests/skills-crossref.test.ts \
  tests/update-runner-pipeline.test.ts \
  tests/cross-flow-lock.test.ts \
  tests/frontmatter-phase7.test.ts \
  tests/origin-guard.test.ts \
  tests/pipeline-registry-integrity.test.ts \
  tests/paths.test.ts \
  tests/cli-templates-cwd-independence.test.ts \
  tests/workspace-root.test.ts \
  tests/cli-json.test.ts \
  tests/plan-file.test.ts \
  tests/skill-smoke.test.ts \
  tests/skill-fixture-integration.test.ts
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
| `tests/cli.test.ts` (15 tests) | CLI handler integration | `runStatus` prints formatted table and empty-state message; exits with error when DB missing; `computeMetrics` returns correct aggregates; `runMetrics` prints output; `runInit` creates `.blog-agent/` with all subdirs and state.db; init with `--import` works; init with `--import` prints clean error on failure; `runInit` idempotent on re-run; hard-fail regression when shipped `.blogrc.example.yaml` or `.env.example` missing from `packageRoot` (Release Prep Pass 1 Codex Finding #4) |

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

#### Phase 6 — Publish

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/publish-state.test.ts` (43 tests) | Phase + steps-crud + lock + crash-safety helpers | Phase boundary; `initPublishFromEvaluate` rejects non-evaluate / `evaluation_passed=0`; `initPublish` acquires lock, advances phase, seeds 11 pipeline_steps rows via INSERT OR IGNORE; `createPipelineSteps` applies content-type + config pre-skips; step status transitions; `reclaimStaleRunning` demotes running→pending; `reconcilePipelineSteps` downgrades pending/failed → skipped when config disables a destination (sticky-within-cycle: does NOT upgrade skipped back to pending); `persistPublishUrls` first-writer-wins via COALESCE; `completePublishUnderLock` runtime lock-ownership guardrail (throws when lockfile missing / different PID); `acquirePublishLock` stamps PID, reclaims dead-PID + empty/garbage lockfile |
| `tests/publish-pipeline.test.ts` (20 tests) | `runPipeline` orchestrator + crash-safety | Runs steps in order; skips completed; re-runs failed; stops on paused/failed/thrown; merges urlUpdates into ctx.urls AND per-step transactional persistence; completes and advances phase via `completePublishUnderLock`; does NOT advance on failure/pause; releases lock on all terminal paths; reclaims stuck running on resume; does not deadlock at completion (no release-then-reacquire); reconciles pending rows against current config |
| `tests/publish-convert.test.ts` (12 tests) | MDX → Markdown converter | Strips frontmatter, imports, JSX self-closing tags; preserves text children of block JSX; resolves relative asset URLs to absolute `{base}/writing/{slug}/assets/x`; preserves code blocks verbatim (no JSX stripping / no URL resolution inside ``` fences, including nested backtick fences); preserves tables/headings/lists; collapses 3+ blank lines to 2 |
| `tests/publish-site.test.ts` (18 tests) | Site PR + preview gate + dirty-state + rename/copy guardrail | `createSitePR` copies MDX + assets + research page to site repo; branch `post/{slug}` idempotent; `feat(post):` commit; `gh pr create` idempotent on existing PR; `pr-number.txt` written for preview-gate; dirty-state guardrail throws on uncommitted unrelated changes; tolerates dirty state under pipeline-owned paths; stages only `content/posts/{slug}` + optional `content/research/{slug}`; rename/copy porcelain parsing rejects R/C records that escape owned prefixes; `checkPreviewGate` polls gh pr view; all subprocess via execFileSync (no shell) |
| `tests/publish-crosspost.test.ts` (18 tests) | Dev.to probe-then-create + Medium + Substack paste | `mapDevToTags` lowercases/hyphenates/caps at 4; `crosspostToDevTo` skips when DEVTO_API_KEY unset; builds POST with api-key header, canonical_url, published:false, tags, description; throws on 422/503+; probe-then-create: GET `/api/articles/me/all` before POST returns existing id/url if canonical matches; trailing-slash normalization; probe failure throws; pagination beyond page 1; short-page stops; `generateMediumPaste` / `generateSubstackPaste` write H1/H2 layouts with canonical footer preserving code blocks |
| `tests/publish-social.test.ts` (14 tests) | LinkedIn + Hacker News text generation | `containsEmoji` detects emoji ranges; `generateLinkedIn` fills template, throws on emojis in output, includes timing when configured; `generateHackerNews` title ≤80 chars (truncate with ellipsis); `Show HN:` prefix ONLY for project-launch; includes first-comment, canonical_url, repo link; throws on emoji; writes linkedin.md/hackernews.md |
| `tests/publish-research-page.test.ts` (10 tests) | Research page MDX generator | Generates from research doc + benchmark results; includes thesis/findings/bibliography; cross-links to post canonical + companion repo; skips analysis-opinion without research doc; generates for analysis-opinion when research doc present; fills template placeholders; reads description from draft frontmatter (schema has no description column); idempotent; throws when template or post missing |
| `tests/publish-repo.test.ts` (21 tests) | Companion repo probe-then-create + origin-URL guardrail | Skips analysis-opinion / project-launch; probes with gh repo view → ensures remote + push, or gh repo create --public --source=. --push; race fallback on "already exists"; repo name from config.author.github (not hardcoded); origin-URL guardrail throws on different GitHub repo (SSH or HTTPS), non-GitHub remotes, wrong owner/name — applied on race-fallback branch too; parseGitHubRemoteUrl handles SSH-with/without-.git, HTTPS, non-GitHub |
| `tests/publish-cli.test.ts` (15 tests) | Publish CLI handlers + ctx.urls hydration | Invalid slug → exitCode=1 before DB open; wrong phase → valid-phases hint; evaluate → promote + seed 11 + runPipeline; publish phase → resume; pausedStep → info (not error); failedStep → exitCode=1; runner throws → "pipeline crashed"; runPublishShow table + empty-state; malformed config best-effort; ctx.urls hydrated from posts row before runPipeline (resumed runs see prior URLs); fresh publish hydrates to empty object |
| `tests/publish-site-updates.test.ts` (20 tests) | `updateFrontmatter` + `updateProjectReadme` (direct-push) | Switches to main BEFORE file mutation; writes published:true + canonical + devto_url + companion_repo; `chore(post):` prefix; push origin main via execFileSync argv; idempotent when nothing staged AND HEAD not ahead; crash-replay push-ahead strict match (exactly 1 ahead commit, subject == expected, touched file scoped); throws on wrong subject/file/2+ commits; `assertIndexClean` refuses operator-staged unrelated files; `updateProjectReadme` resolves config.projects[id] against dirname(configPath); inserts link under `## Writing`; creates heading when absent; `chore:` prefix (not docs); skip paths for missing project_id/config/dir; idempotent when canonical URL already in README |

#### Phase 7 — Lifecycle

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/db-migration-v3.test.ts` (12 tests) | Schema v2→v3 canonical table-rebuild | Fresh opens at SCHEMA_VERSION=3; v1→v3 preserves pipeline_steps with cycle_id=0 via rename→create→INSERT..SELECT→drop; v2→v3 preserves all pre-v3 data; update_cycles + unpublish_steps created additively; partial unique index `idx_update_cycles_open` rejects second INSERT when closed_at IS NULL; multiple closed cycles per post allowed; re-open is no-op; FK enforcement through rebuild |
| `tests/update-cycles.test.ts` (17 tests) | Update-cycle lifecycle | `openUpdateCycle` validates phase=='published' + single-open invariant + writes update_opened metric in one transaction; rejects duplicate open with actionable error; `closeUpdateCycle` sets closed_at + ended_reason + writes update_aborted OR update_completed metric; `getOpenUpdateCycle` returns row or null; `listUpdateCycles` ordered by cycle_number |
| `tests/update-notice.test.ts` (13 tests) | Cycle-keyed update-notice marker | Marker regex `update-notice cycle=(\d+) date=(\d{4}-\d{2}-\d{2})`; same-cycle re-run replaces in-place regardless of date; multi-cycle preserves historical blocks; atomic temp+rename writes; no date-based matching inlined anywhere |
| `tests/update-cli.test.ts` (5 tests) | `blog update abort/start/show` | abort closes cycle + writes metric + PRESERVES `.blog-agent/drafts/{slug}/` artifacts; exit 1 when no open cycle; invalid slug exit 1 before DB open; start refuses empty --summary when require_summary=true; show prints phase/update_count/cycle table |
| `tests/update-devto.test.ts` (4 tests) | `updateDevToArticle` probe→PUT / miss→POST | Probe match → PUT body contains title + body_markdown + canonical_url + tags + description; probe miss → POST fallthrough (recovers from manual Dev.to deletion); PUT 500 throws; PUT 422 throws with validation context |
| `tests/update-publish-pipeline.test.ts` (5 tests) | `createSiteUpdate` + `completeUpdateUnderLock` | site-update uses `update/<slug>-cycle-<N>` branch, `chore(site): update <slug> (cycle <N>)` commit, `Update <title> (cycle <N>)` PR title; MDX body lands in site repo (not just frontmatter); closes cycle, increments update_count, sets last_updated_at, phase stays published, writes update_completed metric with value=cycleId; update finalizer does NOT advancePhase; throws when no open cycle |
| `tests/publish-guard.test.ts` (2 tests) | Publish refuses on open update cycle | getOpenUpdateCycle check runs early; exit 1 with message mentioning BOTH `blog update publish` and `blog update abort`; no pipeline_steps rows created |
| `tests/unpublish-state.test.ts` (6 tests) | Unpublish init + finalize state | `initUnpublish` seeds 7 step rows + writes unpublish_started metric; pre-skips config-disabled rows; alreadyUnpublished:true for already-unpublished; rejects non-published with phase error; rejects missing posts; `completeUnpublishUnderLock` advances phase + sets unpublished_at + writes unpublished metric via finalizePipelineUnderLock |
| `tests/unpublish-cli.test.ts` (3 tests) | `blog unpublish start/show` | --confirm required: missing flag → exit 1 + zero DB writes + zero fetch calls (fetch-spy asserted); rejects non-published with phase error; show prints status + "No unpublish steps recorded" |
| `tests/unpublish-readme.test.ts` (5 tests) | revertProjectReadmeLink trust boundaries | Three skip paths (no project_id, config.projects[id] absent, link not in README); assertIndexClean throws on staged unrelated file; requireOriginMatch throws on wrong origin (real git repos, not mocked) |
| `tests/unpublish-site.test.ts` (5 tests) | createSiteRevertPR PR-only | Happy path: `unpublish/<slug>` branch + MDX flipped to published:false + PR via gh; idempotent on existing PR; requireOriginMatch throws on wrong origin (no push/PR); throws on unparseable GitHub URL; grep-verified: no `push origin main` / `site_revert_mode` in source |
| `tests/unpublish-devto.test.ts` (7 tests) | unpublishFromDevTo Forem PUT | Skips when DEVTO_API_KEY unset; probe match → PUT `{article:{published:false}}` per spike; probe miss → skip with reason; probe HTTP 500 throws; PUT 500/422 throws; probe pagination stops on short page |
| `tests/unpublish-pipeline.test.ts` (4 tests) | runUnpublishPipeline E2E | Happy path drives all 7 steps → phase=unpublished + unpublished_at set + metrics [unpublish_started, unpublished]; per-slug lock contention via acquirePublishLock; runner imports from `../publish/lock.js` (trust-boundary proof); failure path leaves phase=published and records failedStep |
| `tests/skills-crossref.test.ts` (2 tests) | Orchestrator skill files contract | All three (blog-pipeline, blog-update, blog-unpublish) contain exactly H2 {Preflight, Workflow, CLI Reference, Troubleshooting, Degraded Mode}; every `blog <cmd>` in fenced blocks resolves to a registered Commander handler in src/cli/index.ts (AST parse, not grep) |
| `tests/update-runner-pipeline.test.ts` (3 tests) | TRUE E2E update-mode runPipeline | Every UPDATE_STEP_NAMES step runs in order via real runPipeline({publishMode:'update', cycleId}); cycle_id persists on every pipeline_steps row (no cycle_id=0 leakage); post.phase stays 'published'; update_count increments; update_completed metric with value=cycleId; pause/resume works in update mode |
| `tests/cross-flow-lock.test.ts` (3 tests) | Cross-flow lock mutual exclusion | TRUE same-slug contention: runPipeline(alpha) blocks on step 2 → lockfile contains process.pid → runUnpublishPipeline(alpha, lockTimeoutMs=100) throws with contention error (real runner); release-then-reacquire succeeds; disjoint slugs don't contend (concurrent publish+unpublish) |
| `tests/frontmatter-phase7.test.ts` (15 tests) | PostFrontmatter Phase 7 round-trip + cross-repo fixtures | serialize+parse preserves unpublished_at / updated_at / update_count (numeric); emits all three together; omits when unset (legacy compat); parses legacy MDX with new fields undefined; parses production-shape Phase 7 MDX with all platform + lifecycle fields; tolerates update_count as YAML string `"5"`; reads 6 fixture files from `fixtures/frontmatter-phase7/`; drift guard: every .mdx on disk appears in REGISTERED_FIXTURES and vice versa |
| `tests/origin-guard.test.ts` (16 tests) | Split tolerant/strict origin APIs | parseGitHubRemoteUrl handles SSH/HTTPS; null for non-GitHub; getOriginState returns 'matches'/'absent'; narrows catch to 'No such remote' stderr only (re-throws environment errors); throws on wrong-target or unparseable; normalizes case; forces LC_ALL=C/LANG=C on subprocess; requireOriginMatch throws on absent (unlike tolerant); expectedSiteCoords prefers config.site.github_repo over basename(repo_path) fallback; handles trailing slash |
| `tests/pipeline-registry-integrity.test.ts` (8 tests) | Registry ↔ step-tuple invariants | PIPELINE_STEPS exports every PUBLISH_STEP_NAMES entry; every UPDATE_STEP_NAMES entry; pairwise unique names; numbers cover 1..11 with slot 3 shared between site-pr and site-update; each name maps to consistent number; every step has callable execute; no step name outside union of publish+update tuples; createPipelineSteps seeds DB step_numbers that match tuple positions per mode |

#### Release Prep

Ships the v0.1.0-readiness bundle: shared package-root resolver fixing a latent CWD-relative template-loading bug, four-layer packaging gate (`verify-pack.mjs`), clean build (`node scripts/clean-dist.mjs && tsc`), adversarially-reviewed release runbook, CI. Validated against Tier-2 contract with seven adversarial passes (1 Claude evaluator + 6 Codex GPT-5.4 high — final verdict `clean / approve`).

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/paths.test.ts` (4 tests) | Shared package-root resolver | `findPackageRoot(import.meta.url)` from the test file returns a real path ending in `/m0lz.01`; synthetic src-layout URL walks up to seeded package.json; synthetic dist-layout URL resolves identically (no offset-arithmetic brittleness between src/ and dist/ layouts); missing-package.json throws with URL in error (uses a path whose ancestors definitionally have none) |
| `tests/cli-templates-cwd-independence.test.ts` (1 test) | CLI works from arbitrary CWD | `beforeAll` unconditionally rebuilds dist (prevents stale-artifact false-positives — Release Prep Pass 1 Codex Finding #1); `spawnSync('node', [distPath, 'init'], { cwd: mkdtempSync })` from an empty OS-tmpdir (physically outside repo ancestry so findPackageRoot cannot accidentally resolve against the real package.json); asserts exit 0, `.blog-agent/state.db`, AND byte-equal `.blogrc.yaml` / `.env` against shipped examples (proves both the templates/ helper fix AND the init.ts hard-fail path) |

#### /blog Skill Plugin

| Test File | Feature | What It Validates |
| --------- | ------- | ----------------- |
| `tests/workspace-root.test.ts` (11 tests) | Workspace-root detection | `findWorkspaceRoot` ancestor-walks to `.blog-agent/state.db`; honors `override`/`envVar` with override-over-env precedence; throws `WorkspaceNotFoundError` with `--workspace` + `BLOG_WORKSPACE` hints; `resolveUserPath` preserves `_BLOG_ORIGINAL_CWD` for relative paths |
| `tests/cli-json.test.ts` (6 tests) | `--json` envelope surface | versioned `schema_version='1'` envelope with `kind`/`generated_at`/`data`; `WorkspaceStatus`/`PublishPipeline`/`UpdatePipeline`/`UnpublishPipeline`/`EvaluationState` shapes; empty-DB graceful fallback |
| `tests/plan-file.test.ts` (61 tests) | Plan schema + hash + validator + apply runner + receipt + apply-lock | canonicalPlanJSON stable-stringify; computePlanHash deterministic; schema rejects park-research, abstract commands, empty steps/venues, `blog agent` nesting, flag-like tokens in command, BANNED_ARG_FLAGS in args (--workspace/--help/-h/--version/-V + `=` forms), slug traversal at shared schema layer, namespace-only commands with args-smuggled subcommand, whitespace variants (double-space/tab/newline), workspace-global mutators (blog init, blog ideas add/start/remove), args[0] != plan.slug for slug-bearing commands; accepts blog status + blog metrics (true leaves); validatePlanForApply throws NO_APPROVAL/HASH_MISMATCH/WORKSPACE_MISMATCH/CRASH_RECOVERY_REQUIRED; applyPlan uses DB-authoritative step state (schema v4), tampered receipt is no-op (forged-skip vector closed), RECEIPT_CONFLICT derived from DB not receipt file, RECEIPT_HASH_MISMATCH on re-approved content, --restart clears ALL open runs for slug, crash-recovery sentinel forces --restart; slug-scoped apply lock serializes different plan_ids for same slug, legacy bare-PID tolerated, honest PID-liveness policy |
| `tests/skill-smoke.test.ts` (22 tests) | Plugin static shape + SKILL discipline + sibling-doc parity + install-docs | plugin.json + frontmatter valid; allowed-tools contains Bash(blog:*) excludes Write/Edit/Bash(gh:*); body ≤200 lines; no `node -e`/`cat `/`head ` in code fences; every read uses `--json`; no bare destructive execs outside `blog agent apply`; sibling docs (JOURNEYS/CHECKPOINTS) share the discipline; skill-content identity hygiene recursive scan with manifest-field whitelist for plugin.json author/homepage; install-docs structural contract (required files ship, plugin.json declares readable SKILL.md, install docs reference files that exist); contributor symlink resolves; `.claude-plugin/**` in package.json#files |
| `tests/skill-fixture-integration.test.ts` (25 tests) | Real skill-to-CLI handoff + crash recovery + workspace pinning | preflight → plan → verify-unapproved (NO_APPROVAL) → approve (atomic) → verify (pass) → apply (receipt written); tamper → HASH_MISMATCH; cross-workspace → WORKSPACE_MISMATCH; abstract command + `blog agent` nesting rejected; --steps-inline / --steps-json mutex; slug traversal + leaf-level symlink rejected; --workspace smuggled in step args rejected; --output path clamp (outside reject, wrong-ext reject, valid accept); hand-authored traversal slug rejected at verify; completed plan doesn't block later plan for same slug; forged receipt cannot force RECEIPT_CONFLICT (DB authority only); --restart clears stale open-run debt across plan_ids; RECEIPT_HASH_MISMATCH on re-approval; receipt-JSON tampering benign; apply resumable; preflight respects --workspace override from outside the workspace; preflight honors --workspace > BLOG_WORKSPACE precedence; apply pins spawned children to plan.workspace_root (BLOG_WORKSPACE cannot redirect via child env scrub + --workspace prepend); --workspace=/path compact form recognized; empty --workspace= rejected explicitly; startup shim --workspace operand excluded from positional walk |

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

**Phase 6 — Publish source files:**

- `src/cli/publish.ts` — runPublishStart/Show, slug validation, phase dispatch (evaluate→promote, publish→resume), ctx.urls hydration
- `src/core/publish/types.ts` — PUBLISH_STEP_NAMES 11-tuple, step enums, PipelineStepRow, PublishUrls, PostRow re-export
- `src/core/publish/lock.ts` — `acquirePublishLock` (O_CREAT|O_EXCL + PID stamp, stale-PID reclaim, empty/garbage lockfile reclaim, Atomics.wait spin, idempotent release)
- `src/core/publish/phase.ts` — getPublishPost, initPublishFromEvaluate, initPublish, completePublishUnderLock (no lock re-entry, idempotent on published, runtime lock-ownership guardrail), persistPublishUrls (COALESCE first-writer-wins)
- `src/core/publish/steps-crud.ts` — createPipelineSteps (content-type + config pre-skips), reclaimStaleRunning, reconcilePipelineSteps (resume-time re-application of config-driven skips)
- `src/core/publish/convert.ts` — mdxToMarkdown, stripFrontmatter, removeImports, removeJsxComponents, resolveAssetUrls, fence-aware state machine with nested-backtick handling
- `src/core/publish/research-page.ts`, `src/core/publish/site.ts` (dirty-state guardrail with rename/copy-aware porcelain parsing + path-scoped staging), `src/core/publish/devto.ts`, `src/core/publish/medium.ts`, `src/core/publish/substack.ts`, `src/core/publish/repo.ts` (origin-URL guardrail + parseGitHubRemoteUrl + assertOriginMatches)
- `src/core/publish/frontmatter.ts` — updateFrontmatter (direct push to main, `chore(post):` prefix, checkout-before-mutation, assertIndexClean precheck, inspectAheadCommits strict subject+file match)
- `src/core/publish/readme.ts` — updateProjectReadme (direct push, `chore:` prefix, config.projects[id] resolved against configPath dir, same guardrails)
- `src/core/publish/social.ts`, `src/core/publish/pipeline-types.ts`, `src/core/publish/pipeline-registry.ts`, `src/core/publish/pipeline-runner.ts` (acquires lock, reclaims stale running, reconciles pending rows, per-step transactional URL persistence)
- `templates/research-page/template.mdx`, `templates/social/linkedin.md`, `templates/social/hackernews.md`
- `skills/blog-publish.md`

**Phase 7 — Lifecycle source files:**

- `src/core/db/schema.ts` — SCHEMA_VERSION=3, pipeline_steps canonical table-rebuild adding cycle_id + UNIQUE(post_slug, cycle_id, step_name), update_cycles + unpublish_steps tables, partial-unique-index idx_update_cycles_open
- `src/core/db/database.ts` — v3 migration block with FK-off toggle around transactional rebuild
- `src/core/db/types.ts` — UpdateCycleRow, UnpublishStepRow, UpdateCycleEndedReason
- `src/core/publish/types.ts` — UPDATE_STEP_NAMES tuple, PublishMode union, stepNamesForMode helper, cycle_id on PipelineStepRow
- `src/core/publish/pipeline-types.ts`, `src/core/publish/pipeline-runner.ts` (mode-aware finalization), `src/core/publish/pipeline-registry.ts` (mode-aware verify step), `src/core/publish/phase.ts` (finalizePipelineUnderLock shared PID-ownership helper + completeUpdateUnderLock + completeUnpublishUnderLock), `src/core/publish/steps-crud.ts` (cycleId + publishMode parameters)
- `src/core/publish/site.ts` (createSitePR calls requireOriginMatch(expectedSiteCoords) + accepts SitePROverrides), `src/core/publish/site-update.ts`, `src/core/publish/devto.ts` (updateDevToArticle probe→PUT + POST fallthrough)
- `src/core/publish/origin-guard.ts` — SHARED trust-boundary: parseGitHubRemoteUrl, getOriginState (tolerant), requireOriginMatch (strict), expectedSiteCoords (config-driven), coordsMatch case-insensitive, readOriginUrl with LC_ALL=C locale pin + narrowed stderr catch
- `src/core/config/types.ts` + `src/core/config/loader.ts` — SiteConfig.github_repo + SiteUpdateMode + UnpublishConfig + extended UpdatesConfig + DEFAULT_UNPUBLISH + github_repo validation
- `src/core/update/cycles.ts`, `src/core/update/notice.ts`, `src/cli/update.ts`
- `src/core/unpublish/state.ts`, `src/core/unpublish/steps-crud.ts`, `src/core/unpublish/steps-registry.ts`, `src/core/unpublish/runner.ts`, `src/core/unpublish/devto.ts`, `src/core/unpublish/medium.ts`, `src/core/unpublish/substack.ts`, `src/core/unpublish/site.ts`, `src/core/unpublish/readme.ts`, `src/cli/unpublish.ts`, `src/cli/publish.ts` (publish guard on open update cycle)
- `src/core/draft/frontmatter.ts` — PostFrontmatter extended with unpublished_at/updated_at/update_count/substack_url; round-trip with update_count normalized to number
- `src/core/evaluate/state.ts` — initEvaluation({ isUpdateReview: true }) sets manifest is_update_cycle=true; recordReview reads flag and sets is_update_review=1 on every row
- `fixtures/frontmatter-phase7/*.mdx` — 6 canonical Phase 7 frontmatter shapes
- `skills/blog-pipeline.md`, `skills/blog-update.md`, `skills/blog-unpublish.md`
- `.claude/rules/lifecycle.md` — path-scoped rule doc
- `docs/spikes/forem-put-semantics.md` — canonical Forem PUT body shapes

**Release Prep source files:**

- `src/core/paths.ts` — shared package-root resolver: findPackageRoot(moduleUrl), PACKAGE_ROOT, TEMPLATES_ROOT. Every template-reading code path routes through one of these two constants — no inline fileURLToPath / offset-arithmetic incantations remain
- `src/cli/init.ts` — hard-fail on missing shipped example files with diagnostic pointing at packaging bug; packageRoot is an injectable third parameter (defaults to PACKAGE_ROOT) so regression tests can exercise the hard-fail path via a tmpdir without monkey-patching
- `src/cli/publish.ts` / `src/cli/update.ts` — use TEMPLATES_ROOT for package-shipped template reads; all `.blog-agent/...` / `.blogrc.yaml` paths remain CWD-relative (operator state, not package state — Negative contract criterion #11)
- `src/core/benchmark/companion.ts` / `src/core/research/document.ts` — same refactor symmetrically applied
- `scripts/verify-pack.mjs` — four-layer packaging gate wired into both `npm run verify-pack` and `prepublishOnly`: (1) ALLOWED_PATTERNS whitelist, (2) FORBIDDEN_PATTERNS denylist (no secrets, `.js.map`, `state.db`, `.blog-agent/`, `src/`, `tests/`, `.claude/`), (3) REQUIRED_FILES manifest of 12 runtime-critical paths, (4) src→dist compiled-closure check walking `src/**/*.ts` and asserting every corresponding `dist/**/*.js` is in the tarball
- `scripts/clean-dist.mjs` — cross-platform `rm -rf dist` via `fs.rmSync` (replaces the POSIX-only form that broke on Windows cmd/PowerShell)
- `package.json` — `build: "node scripts/clean-dist.mjs && tsc"` (cross-platform clean build); `prepublishOnly: "lint && build && test && verify-pack"` (publish-time gate); `files` uses globs; publish surface fields (repository, homepage, bugs, keywords, author); `engines.node: ">=20.1.0"` (pinned for `readdirSync(..., { recursive: true })`)
- `.github/workflows/ci.yml` — single Node 20 job, step order: checkout → setup-node → npm ci → lint → build → test → verify-pack (build BEFORE test — Release Prep Pass 1 Codex Finding #1)
- `CHANGELOG.md` — Keep-a-Changelog format, single [0.1.0] section covering Phases 1–7 plus template-path fix
- `RELEASING.md` — literal v0.1.0 sequence + subsequent-releases template; both with main-branch + clean-tree fail-fast preflight guards; pre-publish `git push --atomic --dry-run`; atomic `git push --atomic origin main refs/tags/vX.Y.Z` (not --follow-tags); `gh release create --verify-tag`; Recovery section around `npm view m0lz-01@X.Y.Z` three-case check (A=live/push-only-with-rebase-and-re-tag, B=E404/retry, C=abandon with --mixed reset + preflights); subsequent-release two-commit recovery with HEAD~2
- `.github/PULL_REQUEST_TEMPLATE.md` — ≤10 line checklist with absolute GitHub URLs to CLAUDE.md
- `.nvmrc` — `20` (contributor convenience)
- `README.md` — CI badge; `## Install` leads with `npx m0lz-01 init --import`; `## Development`, `## Changelog`, `## Project Status` sections

**/blog Skill Plugin source files:**

- `src/core/workspace/root.ts` — `findWorkspaceRoot(cwd, {override, envVar})` ancestor-walks to `.blog-agent/state.db`; throws `WorkspaceNotFoundError` with actionable `--workspace`/`BLOG_WORKSPACE` hint
- `src/core/workspace/user-path.ts` — `resolveUserPath(p)` uses `_BLOG_ORIGINAL_CWD` env (startup-shim-set) to resolve relative path flags against the operator's original cwd post-chdir
- `src/core/workspace/resolve.ts` — `workspaceRelative(subpath)` explicit workspace-relative path helper
- `src/cli/index.ts` — startup shim: parses both `--workspace <path>` and `--workspace=<path>`; rejects empty operands; excludes workspace-operand slots from positional walk so `firstPositional` correctly identifies subcommand; `findWorkspaceRoot` + `process.chdir()` BEFORE dynamic-importing commands so module-level `resolve('.blog-agent/...')` constants work post-chdir; WORKSPACE_FREE_COMMANDS narrowed to `init`, `help`; only `agent preflight` is workspace-free (plan/approve/verify/apply require real workspace)
- `src/core/json-envelope.ts` — `JsonEnvelope<K, D>` + `makeEnvelope` + `printEnvelope` (6 versioned kinds; schema_version='1')
- `src/core/plan-file/schema.ts` — `PlanFile` type, `PLAN_CONTENT_TYPES`, `PLAN_DEPTHS`, `KNOWN_SUBCOMMANDS`, `DENY_STEP_SUBCOMMANDS` (banned `agent` nesting), `BANNED_ARG_FLAGS` (--workspace/--help/-h/--version/-V + `=` forms), `SLUG_BEARING_STEP_COMMANDS`, `KNOWN_LEAF_COMMANDS` (TRUE leaves only — blog status / blog metrics + SLUG_BEARING; `blog ideas` and other namespace parents excluded because Commander default-action would dispatch via args)
- `src/core/plan-file/hash.ts` — `canonicalPlanJSON` + `computePlanHash` (stable key-sort, drops approved_at/payload_hash, SHA-256)
- `src/core/plan-file/validator.ts` — validates required fields, enum values, per-step shape; `validateSlug(plan.slug)` at shared-schema layer (hand-authored traversal slugs rejected); canonical single-space form + KNOWN_LEAF_COMMANDS exact match (closes whitespace + namespace-smuggling bypasses); banned flags in step args; args[0] === plan.slug for slug-bearing commands; `validatePlanForApply` adds NO_APPROVAL / HASH_MISMATCH / WORKSPACE_MISMATCH
- `src/core/plan-file/apply.ts` — slug-scoped exclusive lock; DB-authoritative step state (schema v4 agent_plan_runs + agent_plan_steps); pre-spawn sentinel for crash-recovery (CRASH_RECOVERY_REQUIRED on sentinel-without-completion); spawns step via `--workspace <plan.workspace_root>` prepend + scrubbed BLOG_WORKSPACE from child env (pins child workspace); captures per-step exit/stdout_tail/stderr_tail/duration_ms; writes receipt atomically via renameSync (audit mirror, NOT trust input); RECEIPT_CONFLICT from DB open-runs (not receipt file); --restart clears all open runs for slug + sentinels
- `src/core/plan-file/apply-lock.ts` — O_CREAT|O_EXCL JSON-stamp lockfile (pid + acquiredAt); honest PID-liveness policy; tolerant of legacy bare-PID format; ESRCH reclaim + corrupt/empty lockfile reclaim
- `src/core/db/schema.ts` — `SCHEMA_VERSION=4`, `SCHEMA_V4_SQL` adds `agent_plan_runs` + `agent_plan_steps` with FK CASCADE
- `src/core/db/database.ts` — v4 migration block inside `migrate()` transaction
- `src/cli/agent.ts` — `preflight` (trusts post-chdir cwd, omits envVar so --workspace > BLOG_WORKSPACE precedence holds), `plan` (validateSlug at CLI boundary, clampOutputPath enforces `<workspace>/.blog-agent/plans/*.plan.json` with realpath parent + lstat leaf-symlink rejection), `approve` / `verify` / `apply`; `[AGENT_ERROR] <CODE>: <msg>` on stderr with exit 2 (validation) or 1 (STEP_FAILED)
- `src/cli/status.ts` / `publish.ts` / `update.ts` / `unpublish.ts` / `evaluate.ts` — `--json` flag on show commands; branches before human-table render
- `.claude-plugin/plugin.json` — plugin manifest
- `.claude-plugin/skills/blog/` — SKILL.md (≤200 lines) + REFERENCES.md + JOURNEYS.md + CHECKPOINTS.md
- `.claude/skills/blog` — relative symlink for contributor sessions
- `.claude/rules/skills.md` — path-scoped rules for `.claude-plugin/skills/**`
- `scripts/verify-pack.mjs` — `.claude-plugin/**` in allowlist + required files
- `package.json` — `files` adds `.claude-plugin/**`
- `docs/plugin-install.md` — three install paths

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

Expected baseline: **0 TypeScript errors, 857 tests passing across 63 suites, clean build** (as of feature/blog-skill-plugin after seven adversarial passes converged: +5 new test files — `workspace-root` (11), `cli-json` (6), `plan-file` (61), `skill-smoke` (22), `skill-fixture-integration` (25) = +125 tests across +5 suites over the 730/58 Release Prep baseline; `cli.test.ts` and `db-migration-v3.test.ts` also extended with plan-plugin regressions). Any drift from this baseline is a signal to investigate before merging.

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
  - ReviewerOutput schema (21 tests): PASS / FAIL
  - Structural autocheck lints (15 tests): PASS / FAIL
  - Synthesis + matching (24 tests): PASS / FAIL
  - Report renderer (4 tests): PASS / FAIL
  - Evaluation state lifecycle (78 tests): PASS / FAIL
  - Evaluate CLI handlers (21 tests): PASS / FAIL

Phase 6 — Publish:
  - Phase + steps-crud + lock + crash-safety + reconcile (43 tests): PASS / FAIL
  - Pipeline runner + crash-safety + reconcile regressions (20 tests): PASS / FAIL
  - MDX → Markdown converter (12 tests): PASS / FAIL
  - Site PR + preview gate + dirty-state + rename/copy guardrail (18 tests): PASS / FAIL
  - Dev.to probe-then-create + Medium + Substack paste (18 tests): PASS / FAIL
  - Social text: LinkedIn + Hacker News (14 tests): PASS / FAIL
  - Research page generator (10 tests): PASS / FAIL
  - Companion repo probe-then-create + origin-URL guardrail (21 tests): PASS / FAIL
  - Publish CLI handlers + ctx.urls hydration (15 tests): PASS / FAIL
  - updateFrontmatter + updateProjectReadme + index-clean + crash-replay (20 tests): PASS / FAIL

Phase 7 — Lifecycle:
  - Schema v3 canonical table-rebuild + partial-unique-index (12 tests): PASS / FAIL
  - Update-cycle lifecycle (17 tests): PASS / FAIL
  - Cycle-keyed update-notice marker (13 tests): PASS / FAIL
  - Update CLI handlers (abort artifact preservation) (5 tests): PASS / FAIL
  - Update Dev.to probe→PUT / miss→POST (4 tests): PASS / FAIL
  - Update publish unit coverage: site-update + completeUpdateUnderLock (5 tests): PASS / FAIL
  - Publish guard: refuses on open update cycle (2 tests): PASS / FAIL
  - Unpublish state lifecycle (6 tests): PASS / FAIL
  - Unpublish CLI + --confirm + fetch-spy (3 tests): PASS / FAIL
  - Unpublish readme-revert trust boundaries (5 tests): PASS / FAIL
  - Unpublish site revert PR-only (5 tests): PASS / FAIL
  - Unpublish Dev.to PUT published:false (7 tests): PASS / FAIL
  - Unpublish pipeline E2E (4 tests): PASS / FAIL
  - Orchestrator skills cross-reference (2 tests): PASS / FAIL
  - TRUE E2E update-mode runPipeline (3 tests): PASS / FAIL
  - Cross-flow lock contention (same-slug + disjoint) (3 tests): PASS / FAIL
  - PostFrontmatter Phase 7 round-trip + cross-repo fixtures (15 tests): PASS / FAIL
  - Split origin-guard tolerant/strict APIs (16 tests): PASS / FAIL
  - Pipeline registry ↔ step-tuple invariants (8 tests): PASS / FAIL

Release Prep:
  - Shared package-root resolver (4 tests): PASS / FAIL
  - CLI CWD-independence integration (1 test): PASS / FAIL
  - init.ts hard-fail regression — absent shipped templates (2 tests in cli.test.ts): PASS / FAIL

/blog Skill Plugin:
  - Workspace-root detection (11 tests): PASS / FAIL
  - `--json` envelope surface (6 tests): PASS / FAIL
  - Plan schema + hash + validator + apply + receipt + lock (61 tests): PASS / FAIL
  - Plugin static shape + SKILL discipline + sibling-doc parity + install-docs (22 tests): PASS / FAIL
  - Real skill-to-CLI handoff end-to-end + crash recovery + workspace pinning (25 tests): PASS / FAIL

Full Suite: X passing, Y failing  (baseline: 861 passing across 64 suites)
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
