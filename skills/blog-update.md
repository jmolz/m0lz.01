---
name: blog-update
description: Re-run benchmarks against current software versions and republish a previously-published post with an update notice. Use when content drifts (new library versions, changed numbers, corrected claims). Does NOT move the post's phase backward — updates happen in-place on a `published` post.
---

# /blog-update

Drives the Phase 7 update flow for a post already in `published`. The
post's phase never moves backward during an update — the cycle is tracked
separately in `update_cycles` with one open row per post at most.

## Preflight

- Run `/prime` first in a fresh session.
- Post is in `published` phase (`blog status` shows it).
- You have a one-line summary of why the update is happening — Dev.to
  body PUT, Medium/Substack paste files, and social text all reuse it.
  `config.updates.require_summary=true` (default) enforces this.
- For benchmark posts: the updated benchmark results file is ready.
- No open unpublish pipeline for this slug (the per-slug lock enforces
  mutual exclusion — unpublish and update cannot run concurrently).

## Workflow

1. **Open cycle**.
   ```bash
   blog update start <slug> --summary "Re-ran benchmarks on Q2 2026 versions"
   ```
2. **Re-run benchmark** (technical-deep-dive / project-launch with
   benchmarks).
   ```bash
   blog update benchmark <slug> --results <file>
   ```
   Records an entry with `is_update=1` and `previous_run_id` pointing at
   the most recent baseline.
3. **Regenerate draft + append update notice**.
   ```bash
   blog update draft <slug>
   ```
   Writes a cycle-keyed HTML-comment block to the MDX. Re-running within
   the same cycle replaces the block; closed cycles preserve their
   historical blocks.
4. **Open a fresh evaluation cycle** tagged as update-review.
   ```bash
   blog update evaluate <slug>
   ```
   Internally calls `initEvaluation({ isUpdateReview: true })`. Every
   reviewer row inserted in this cycle gets `is_update_review=1`
   explicitly.
5. **Run the three reviewers** via `/blog-evaluate`. Then:
   ```bash
   blog evaluate record <slug> --reviewer <id> --file <file>
   blog evaluate synthesize <slug>
   blog evaluate complete <slug>
   ```
6. **Update publish**.
   ```bash
   blog update publish <slug>
   ```
   Runs the publish pipeline in `publishMode='update'`. Skips
   `companion-repo` and `update-readme`; replaces `site-pr` with a new
   `site-update` step that commits regenerated MDX to the site repo on
   an update branch and opens a PR. The `preview-gate` still pauses
   until merge. `crosspost-devto` in update mode PUTs the refreshed
   body (probe-miss falls through to POST for recovery from manual
   deletion). On completion the update cycle closes,
   `posts.update_count` increments, and `posts.last_updated_at` is set.

## CLI Reference

```
blog update start
blog update benchmark
blog update draft
blog update evaluate
blog update publish
blog update abort
blog update show
blog evaluate record
blog evaluate synthesize
blog evaluate complete
blog status
```

## Troubleshooting

- **"already has an open update cycle"** — finish it with
  `blog update publish <slug>` or cancel with `blog update abort
  <slug>`. At most one open cycle per post at the DB level.
- **`blog publish start` exits 1** — initial-publish is refused while an
  update is open. Switch to `blog update publish` or abort the cycle.
- **`update publish` paused at `preview-gate`** — merge the
  `update/<slug>-cycle-<N>` PR in the site repo, then re-run.
- **Dev.to probe missed (article not found)** — update mode falls
  through to POST, recovering from manual deletion.
- **Evaluation fail-closed on re-record** — a reviewer updated their
  judgment after synthesis; re-run `blog evaluate synthesize <slug>`
  before completing.

## Degraded Mode

- **Abort mid-cycle**: `blog update abort <slug>` closes the cycle with
  `ended_reason='aborted'` and writes `update_aborted` to metrics.
  Regenerated artifacts on disk are preserved.
- **Resume after crash**: re-running `blog update publish <slug>` picks
  up from the first pending/failed step — stale `running` rows are
  reclaimed under the slug-scoped lock.
- **Dev.to PUT 422**: surfaced to stdout with the Forem error text.
  Fix the body, `blog update draft <slug>` again, then
  `blog update publish <slug>`.
