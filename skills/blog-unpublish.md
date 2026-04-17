---
name: blog-unpublish
description: Retract a published post. Flips `published: false` in the site repo via PR, PUTs Dev.to `published: false`, emits manual-removal instructions for Medium and Substack, removes the writing link from the project README. Destructive and irreversible — slugs are reserved forever once used.
---

# /blog-unpublish

Phase 7 inverse-shaped pipeline. Removes a post from active distribution
but preserves its slug + workspace artifacts for audit. Re-publish under
the same slug later is supported; the canonical URL never gets reused.

## Preflight

- Post is in `published` phase.
- You are sure. Canonical URL is reserved forever after unpublish — the
  slug cannot be claimed for a new post.
- No open update cycle (the per-slug lock would block anyway; this is an
  explicit CLI check too for clarity).
- `DEVTO_API_KEY` is set (otherwise the Dev.to step auto-skips with a
  reason).
- `gh` CLI is authenticated for the site repo (revert PR is gh-driven).

## Workflow

1. **Start**.
   ```bash
   blog unpublish start <slug> --confirm
   ```
   Missing `--confirm` exits 1 before any DB mutation or network call.
   Already-unpublished posts return success without side effects.
2. **Seven persisted steps run sequentially** (finalization is
   runner-owned and not a persisted step):
   1. `verify-published` — phase check
   2. `devto-unpublish` — probe-then-PUT `{ published: false }` on
      Dev.to; probe-miss is a successful skip
   3. `medium-instructions` — write `.blog-agent/social/<slug>/medium-removal.md`
   4. `substack-instructions` — write `.blog-agent/social/<slug>/substack-removal.md`
   5. `revert-site-pr` — open a PR on branch `unpublish/<slug>` that
      flips `published: false` in the post's MDX frontmatter
   6. `revert-preview-gate` — pause until the PR merges
   7. `readme-revert` — direct-push removal of the writing link from the
      project README; three explicit skip paths (no `project_id`,
      `config.projects[id]` absent, link not in README)
3. **Merge the revert PR** in the site repo. Re-run `blog unpublish
   start <slug> --confirm` to resume past the preview gate.
4. **Follow the manual instructions** for Medium and Substack (no API).
5. **Finalize**. When every step is terminal, the runner calls
   `completeUnpublishUnderLock`: phase becomes `unpublished`,
   `posts.unpublished_at` is set, a metrics row `event='unpublished'`
   is written.
6. `blog unpublish show <slug>` confirms state; `blog status` renders
   the post as unpublished.

## CLI Reference

```
blog unpublish start <slug> --confirm
blog unpublish show <slug>
blog status
```

## Troubleshooting

- **"open update cycle exists"** — run `blog update abort <slug>` first;
  unpublish and update use the same per-slug lock and the CLI refuses to
  clobber an in-progress update.
- **Dev.to probe miss** — expected when the article was manually deleted;
  the step marks skipped and the pipeline continues.
- **Origin URL mismatch** — the site-revert PR step parses
  `remote.origin.url` and opens the PR against that repo. A misconfigured
  remote fails the step loudly rather than PRing against the wrong repo.
- **Dirty site repo** — the site-revert step refuses to run if the site
  repo has unrelated uncommitted changes. Commit, stash, or discard them
  first.
- **README-revert skips** — three explicit reasons, each printed as the
  step's skip message. Verify `post.project_id` and
  `config.projects[project_id]` if you expected the link removal.

## Degraded Mode

- **Re-publish later**: `blog publish start <slug>` on the same slug
  re-runs the initial publish pipeline. Canonical URL is preserved; the
  site repo's `published: true` flips back on merge.
- **Medium/Substack not actually removed by operator**: the pipeline
  still advances (the step only generates instructions). Track follow-up
  in your ops log; the DB has no back-channel to those platforms.
- **Crash mid-cycle**: re-run `blog unpublish start <slug> --confirm`.
  Stale `running` rows are reclaimed under the slug-scoped lock and the
  next pending step is picked up.
