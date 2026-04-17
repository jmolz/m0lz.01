---
name: blog-pipeline
description: Walk a new post through the full initial-publish lifecycle (research → benchmark → draft → evaluate → publish). Use for first-time posts; use /blog-update for republishing existing posts and /blog-unpublish for rollback.
---

# /blog-pipeline

Drives a single post through the full initial-publish lifecycle. Mechanical
steps run via the standalone `blog` CLI; AI-heavy steps happen interactively
inside this Claude Code session.

## Preflight

- Run `/prime` first in a fresh session so CLAUDE.md and the phase-plan
  docs are loaded.
- `blog init` has been run (the `.blog-agent/` workspace + SQLite DB exist).
- `.blogrc.yaml` is configured (at minimum: `site`, `author`, `content_types`).
- For `technical-deep-dive`: a topic, thesis sketch, and benchmark scaffold
  outline. Benchmarks are **required** for this content type.
- For `project-launch`: the companion repo already exists; benchmarks are
  optional.
- For `analysis-opinion`: no benchmarks; the research and draft phases do
  the heavy lifting.
- No open update cycle for this slug (check with `blog update show <slug>`
  — if there is one, use `/blog-update` instead or abort it first).

## Workflow

Content-type dispatch:

| content type | benchmark | repo | social prefix |
|--------------|-----------|------|---------------|
| technical-deep-dive | required | new | (none) |
| project-launch | optional | existing | Show HN: |
| analysis-opinion | skip | optional | (none) |

1. **Research**.
   ```bash
   blog research init <slug> --topic "..." [--mode directed|exploratory]
   blog research add-source <slug> --url "..."
   blog research show <slug>
   blog research finalize <slug>
   ```
2. **Benchmark** (skip for `analysis-opinion`; optional for `project-launch`).
   ```bash
   blog benchmark init <slug>
   blog benchmark env <slug>
   blog benchmark run <slug> --results <file>
   blog benchmark complete <slug>
   ```
3. **Draft** (MDX with data + diagrams).
   ```bash
   blog draft init <slug>
   blog draft show <slug>
   blog draft validate <slug>
   blog draft complete <slug>
   ```
4. **Evaluate** (three-reviewer adversarial panel — Claude structural,
   Codex GPT-5.4 high adversarial, Codex GPT-5.4 xhigh methodology).
   ```bash
   blog evaluate init <slug>
   blog evaluate structural-autocheck <slug>
   blog evaluate record <slug> --reviewer <id> --file <file>
   blog evaluate synthesize <slug>
   blog evaluate complete <slug>
   ```
5. **Publish** (11-step sequential pipeline with resume + PR gate).
   ```bash
   blog publish start <slug>
   blog publish show <slug>
   ```

## CLI Reference

```
blog init
blog research init
blog research add-source
blog research show
blog research finalize
blog benchmark init
blog benchmark env
blog benchmark run
blog benchmark show
blog benchmark skip
blog benchmark complete
blog draft init
blog draft show
blog draft validate
blog draft add-asset
blog draft complete
blog evaluate init
blog evaluate structural-autocheck
blog evaluate record
blog evaluate show
blog evaluate synthesize
blog evaluate complete
blog evaluate reject
blog publish start
blog publish show
blog status
```

## Troubleshooting

- **`blog publish start` exits 1 with "open update cycle exists"** — the
  post is mid-update. Either `blog update publish <slug>` (finish) or
  `blog update abort <slug>` (cancel) before retrying.
- **`publish` paused at `preview-gate`** — the site PR is still open.
  Merge it in the site repo, then re-run `blog publish start <slug>`.
- **`publish` failed at `crosspost-devto`** — check `DEVTO_API_KEY`; the
  step is idempotent (probe-then-create) and safe to retry.
- **`evaluate` fail-closed on missing pin / drifted artifacts** — re-run
  `blog evaluate synthesize <slug>` to reattach the pin before completing.

## Degraded Mode

- **Dev.to down**: the crosspost step fails loudly; re-run after
  service recovers.
- **Medium / Substack API not supported**: the `paste-medium` and
  `paste-substack` steps always generate paste-ready markdown files
  under `.blog-agent/social/<slug>/`. Manual paste into the web editor
  is the intended recovery.
- **Operator needs to reject during evaluate**: `blog evaluate reject
  <slug>` moves the post back to `draft` and closes the current
  evaluation cycle. Re-run `blog evaluate init` to open a fresh cycle
  after fixes.
