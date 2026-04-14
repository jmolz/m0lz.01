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
- **Standalone CLI** (mechanical, no AI): `blog init`, `blog publish`, `blog status`, `blog metrics`, `blog ideas`

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
blog init              # Create .blog-agent/ workspace and state DB
blog init --import     # Also import existing posts from m0lz.00
blog status            # Table of all posts and their pipeline phase
blog metrics           # Aggregate stats (published, platforms, companion repos)
blog ideas             # List editorial backlog
blog ideas add "topic" --priority high --type technical-deep-dive
blog ideas start 1     # Promote idea 1 to the research phase
```

## Tech Stack

- TypeScript + Node.js 20+ (ESM)
- Commander.js — CLI
- better-sqlite3 — state management (synchronous, WAL mode)
- js-yaml — `.blogrc.yaml` config
- Vitest — tests
- Claude Code skills (Phase 2+) — AI-heavy work

## Status

**Phase 1 — Foundation** complete: CLI skeleton, SQLite schema, config loader, m0lz.00 import, ideas backlog, test harness (48 tests).

Next: Phase 2 — research skill.

See `.claude/PRD.md` for the full scope and `.claude/plans/` for phase plans.

## License

MIT
