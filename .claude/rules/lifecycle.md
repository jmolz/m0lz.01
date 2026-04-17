# Post Lifecycle Conventions (Phase 7)

Rules for `src/core/update/**`, `src/core/unpublish/**`, `src/cli/update.ts`,
`src/cli/unpublish.ts`. Phase 7 introduces two new lifecycle flows —
updates and unpublish — while preserving every Phase 6 invariant.

## Two flows, one runner

- **Updates are a mode of the publish pipeline.** `PipelineContext` carries
  `publishMode: 'initial' | 'update'` + `cycleId`. `pipeline-runner.ts` is
  shared; step registry entries declare their mode fit via the
  `UPDATE_STEP_NAMES` / `PUBLISH_STEP_NAMES` tuples in
  `src/core/publish/types.ts`. `stepNamesForMode(mode)` is the single
  choke point for "what steps exist in this mode"; every caller uses it.
- **Unpublish is its own pipeline** (`src/core/unpublish/*`). Separate
  `unpublish_steps` table, seven persisted steps, runner-owned
  finalization. Shares the per-slug publish lock for mutual exclusion
  with publish and update — acquire via `acquirePublishLock` from
  `src/core/publish/lock.ts`.

## Posts.phase never moves backward during an update

The post's lifecycle phase stays `published` throughout an update cycle.
Update state lives in `update_cycles` (one open row max per post,
enforced by the partial unique index `idx_update_cycles_open`).
`benchmark`/`draft`/`evaluate` module phase-boundary guards remain
strict — Phase 7 does NOT add a `published`-is-also-allowed escape
hatch. The update CLI subcommands (`blog update benchmark/draft/evaluate`)
call library functions directly with their own guards:

- `blog update benchmark` → `createBenchmarkRun({ isUpdate: true, previousRunId })`
  — bypasses the benchmark-phase guard entirely because updates never
  leave `published`.
- `blog update draft` → `appendUpdateNotice(mdxPath, cycleId, date, summary, config)`
  — operates on `.blog-agent/drafts/<slug>/index.mdx` directly, no
  phase transition.
- `blog update evaluate` → `initEvaluation(db, slug, evalDir, { isUpdateReview: true })`
  — that option relaxes the phase check to accept `published` and
  avoids the draft→evaluate advancement.

## Explicit is_update_review flag — NOT inferred

`EvaluationCycle.is_update_cycle` is set explicitly on manifest write by
`initEvaluation({ isUpdateReview: true })`. `recordReview` reads that
flag and sets `is_update_review=1` on every inserted row. Do NOT revert
to the pre-Phase-7 `manifest.cycles.length > 1` inference — it falsely
tagged reject-retry cycles as updates and couldn't fire until the first
reject.

## Cycle-keyed notice marker

`appendUpdateNotice` keys on `cycle=<id>` in an HTML comment marker, not
on date. Re-running within the same cycle replaces the block (even
across midnight); completed cycles preserve their historical blocks.
Marker regex lives in `src/core/update/notice.ts`; do not inline
date-based matching anywhere.

## Publish guard

`runPublishStart` calls `getOpenUpdateCycle(db, slug)` immediately after
DB open. A non-null result refuses the command with an actionable error
pointing to `blog update publish` or `blog update abort`. Keeps initial
publish and update publish on strictly disjoint paths; tests in
`tests/publish-guard.test.ts` lock this invariant in.

## Shared finalize helper

`finalizePipelineUnderLock(publishDir, slug, body)` in
`src/core/publish/phase.ts` is the single PID-ownership choke point for
every finalizer:

- `completePublishUnderLock` (initial publish → `published`)
- `completeUpdateUnderLock` (update cycle close; phase unchanged)
- `completeUnpublishUnderLock` (→ `unpublished`)

Every new finalizer MUST route through this helper. Inlining the
lockfile PID check in a new function is a bypass of a proven
crash-safety guard and is rejected at review.

## Metrics audit — every destructive/cycle action writes a row

- `initUnpublish` → `unpublish_started`
- `completeUnpublishUnderLock` → `unpublished`
- `openUpdateCycle` → `update_opened`
- `closeUpdateCycle` (reason='aborted') → `update_aborted`
- `completeUpdateUnderLock` → `update_completed`
- `completePublishUnderLock` → `published`

Contract criterion #23 tests each explicitly. Adding a new lifecycle
transition without a metrics write is a regression — pair the state
change with the event name in the same transaction.

## Phase 6 invariants are inherited wholesale

Every Phase 6 invariant carries through Phase 7:

- Lock held continuously through finalization (no release-then-reacquire).
- Probe-then-mutate for external APIs — Dev.to PUT publish:false ALWAYS
  probes first via `GET /api/articles/me/all` pagination; probe-miss is
  a successful skip, not a blind PUT.
- Per-step URL persistence via COALESCE first-writer-wins.
- `assertIndexClean` + strict ahead-commit match before every repo touch.
- Origin URL verification (`assertOriginMatches` / `parseRepoCoords`)
  for every site / project-repo touch. `revert-site-pr` and
  `readme-revert` use the same trust boundary as their initial-publish
  counterparts.
- Stale `running` rows reclaimed under the lock at resume time.

## Trust boundaries (unpublish)

- **Site repo**: `createSiteRevertPR` refuses any dirty state outside
  the post's own `{content_dir}/<slug>/` path. Parses `gh pr list` JSON
  for idempotency. PR-only — there is no `site_revert_mode` config flag
  and no direct-push code path. Grep-verifiable: no `push origin main`
  references in `src/core/unpublish/site.ts`.
- **Project README**: `revertProjectReadmeLink` has three explicit
  skip paths (no `project_id`, `config.projects[id]` absent, link not
  in README). Dirty-state check is path-scoped to `README.md`;
  unrelated changes throw.
- **Forem PUT**: `unpublishFromDevTo` body is `{ article: { published: false } }`
  per `docs/spikes/forem-put-semantics.md`. The spike is the canonical
  source for the request shape; if Forem's contract changes, update the
  spike AND the helper in the same commit.
