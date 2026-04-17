<p align="center">
  <img src="branch-mark.svg" width="48" height="48" alt="m0lz.01 branch mark">
</p>

<h1 align="center">m0lz.01</h1>

<p align="center">
  <strong>Idea-to-distribution pipeline for technical content</strong><br>
  Research, benchmark, draft, evaluate, publish, and distribute — all from one prompt.
</p>

---

## Overview

m0lz.01 orchestrates the full lifecycle of technical content. A single prompt can trigger deep research, scaffold a benchmark test suite, run it, draft an MDX post with the original data, adversarially evaluate the result against three reviewers, and distribute across platforms.

Content goes to [m0lz.dev](https://m0lz.dev) as the canonical hub, with Dev.to (cross-post), Medium/Substack (paste-ready fallback), GitHub (companion repos), LinkedIn, and Hacker News as spokes.

Runs locally. No server, no SaaS. Uses Claude Max 20x and OpenAI Codex CLI subscriptions — no separate API billing.

## Architecture

Dual-layer:

- **Claude Code skills** (interactive, subscription-backed): `/blog-research`, `/blog-benchmark`, `/blog-draft`, `/blog-evaluate`, `/blog-pipeline`, `/blog-update`
- **Standalone CLI** (mechanical, no AI): `blog init`, `blog publish`, `blog status`, `blog metrics`, `blog ideas`, `blog research`

Both layers share state via SQLite (`.blog-agent/state.db`) and file artifacts (`.blog-agent/`).

Three-reviewer adversarial evaluation: Claude (structural) + GPT-5.4 high (adversarial) + GPT-5.4 xhigh (methodology).

## Install

```bash
npm install
npm run build
node dist/cli/index.js init --import
```

## Commands

```bash
blog init                                  # Create .blog-agent/ workspace + state DB
blog init --import                         # Import existing posts from m0lz.00
blog status                                # Table of all posts + current phase
blog metrics                               # Aggregate stats (published, platforms, repos)
blog ideas                                 # List editorial backlog
blog ideas add "topic" --priority high --type technical-deep-dive
blog ideas start 1                         # Promote idea 1 to the research phase

# Research phase
blog research init <slug> --topic "..."
blog research add-source <slug> --url "..."
blog research show <slug>
blog research finalize <slug>

# Benchmark phase
blog benchmark init <slug>
blog benchmark env <slug>                  # Capture environment snapshot
blog benchmark run <slug> --results <file> # Store results, mark completed
blog benchmark show <slug>
blog benchmark skip <slug>                 # Analysis-opinion path
blog benchmark complete <slug>             # Advance to draft phase

# Draft phase
blog draft init <slug>
blog draft show <slug>
blog draft validate <slug>
blog draft add-asset <slug> --path <file> --type excalidraw|chart|image
blog draft complete <slug>                 # Advance to evaluate phase

# Evaluate phase (three-reviewer adversarial panel)
blog evaluate init <slug>                  # Seed reviewer manifest
blog evaluate structural-autocheck <slug>  # Deterministic structural lints
blog evaluate record <slug> --reviewer <id> --file <reviewer.json>
blog evaluate show <slug>
blog evaluate synthesize <slug>            # Compute consensus / majority / single
blog evaluate complete <slug>              # Advance to publish phase
blog evaluate reject <slug>                # Kick back to draft for revision

# Publish phase (11-step pipeline with resume)
blog publish start <slug>                  # Initialize or resume the pipeline
blog publish show <slug>                   # Display per-step status table
```

## Tech Stack

- TypeScript + Node.js 20+ (ESM)
- Commander.js — CLI
- better-sqlite3 — state management (synchronous, WAL mode)
- js-yaml — `.blogrc.yaml` config
- Vitest — tests
- Claude Code skills (Phase 2+) — AI-heavy work

## Status

**Phase 6 — Publish** complete: 11-step sequential pipeline with resume via SQLite `pipeline_steps` + slug-scoped filesystem lock. Pipeline covers:

1. `verify` — evaluation-passed gate
2. `research-page` — generate m0lz.00 research companion MDX
3. `site-pr` — copy MDX + assets + research page to site repo, open PR
4. `preview-gate` — pause until PR merged (manual gate)
5. `crosspost-devto` — Dev.to draft via Forem API (probe-then-create)
6. `paste-medium` — paste-ready Markdown for Medium editor
7. `paste-substack` — paste-ready Markdown for Substack editor
8. `companion-repo` — `gh repo view` probe → `gh repo create --source=. --push`
9. `update-frontmatter` — add platform URLs, direct push to site repo main
10. `update-readme` — add writing link to project repo, direct push to main
11. `social-text` — LinkedIn + Hacker News paste text

Crash-safety invariants: stale `running` rows reclaimed on resume; URLs persisted per-step (first-writer-wins via COALESCE); lock held continuously through completion (no release-then-reacquire race); every direct-push step verifies index cleanness + strict ahead-commit matching before any `git push`; companion repo push verifies origin URL matches the expected GitHub target.

Test suite: **583 tests across 37 suites**. Phase breakdown: Phase 1 foundation 48 · Phase 2 research 54 · Phase 3 benchmark 44 · Phase 4 draft 79 · Phase 5 evaluate 163 · Phase 6 publish 195.

Three-reviewer adversarial evaluation (Claude structural + Codex GPT-5.4 high adversarial + Codex GPT-5.4 xhigh methodology) implemented in Phase 5 and used to harden Phase 6 across 7 iteration passes.

Next: Phase 7 — `blog unpublish` rollback + `/blog-pipeline` full orchestrator skill + `/blog-update` content update workflow.

See `.claude/PRD.md` for the full scope and `.claude/plans/` for phase plans.

## License

MIT
