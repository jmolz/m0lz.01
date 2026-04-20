<p align="center">
  <img src="branch-mark.svg" width="48" height="48" alt="m0lz.01 branch mark">
</p>

<h1 align="center">m0lz.01</h1>

<p align="center">
  <strong>Idea-to-distribution pipeline for technical content</strong><br>
  Research, benchmark, draft, evaluate, publish, and distribute — all from one prompt.
</p>

![CI](https://github.com/jmolz/m0lz.01/actions/workflows/ci.yml/badge.svg)

---

## Overview

m0lz.01 orchestrates the full lifecycle of technical content. A single prompt can trigger deep research, scaffold a benchmark test suite, run it, draft an MDX post with the original data, adversarially evaluate the result against three reviewers, and distribute across platforms.

Content goes to a hub site (canonical URL, your choice of domain) with Dev.to (cross-post), Medium/Substack (paste-ready fallback), GitHub (companion repos), LinkedIn, and Hacker News as spokes.

Runs locally. No server, no SaaS. AI-heavy steps use your Claude Code and OpenAI Codex CLI subscriptions — no separate API billing for the interactive work.

---

## Prerequisites

### Required

- **Node.js ≥ 20.1** — `readdirSync` recursive mode is used in packaging. Check: `node --version`.
- **git** — publish/update/unpublish steps invoke git directly.
- **GitHub CLI (`gh`)** — PR creation, companion-repo scaffolding, release verification. Install from [cli.github.com](https://cli.github.com/). Run `gh auth login` once before first publish.
- **A hub site repo** — somewhere on GitHub to commit canonical MDX. Must have a posts directory (default `content/posts/`) and optionally a research directory (default `content/research/`). See [Configuration](#configuration) for the full shape.

### Optional — required for AI-heavy commands

- **Claude Code** (`claude` CLI) — used as the structural reviewer and for interactive drafting/research. Falls back to `ANTHROPIC_API_KEY` if not installed.
- **OpenAI Codex CLI** (`codex`) — used as the adversarial + methodology reviewer (GPT-5.4 high / xhigh). No fallback; evaluate step requires it unless you record reviewer outputs manually.

Both CLIs authenticate against your subscription — no per-call API keys.

### Accounts you'll need

| Service | Purpose | How to get credentials |
|---------|---------|----------------------|
| GitHub | Hub site, companion project repos, releases | `gh auth login` |
| Dev.to | Cross-post target | API key from [dev.to/settings/extensions](https://dev.to/settings/extensions) → `.env` |
| Medium / Substack | Paste-ready fallback (manual publish) | Account only — no API keys |
| LinkedIn / Hacker News | Social distribution (manual paste) | Account only |

---

## Install

```bash
npm install -g m0lz-01
blog --help    # verify installation
```

---

## Quick Start

From install to first post via the `/blog` Claude Code skill.

### 1. Install the CLI

```bash
npm install -g m0lz-01
blog --help    # verify installation
```

### 2. Scaffold a workspace

`blog init` creates `.blog-agent/` (SQLite state + pipeline artifacts) in the current directory. Pick a dedicated location — **not** inside a project repo:

```bash
mkdir -p ~/blog && cd ~/blog
blog init
```

Edit `~/blog/.blogrc.yaml` (site repo + author details) and `~/blog/.env` (DEVTO_API_KEY, etc.) — see [Configuration](#configuration).

### 3. Load the `/blog` Claude Code plugin

```bash
# npm-bundled install — plugin ships inside the tarball at .claude-plugin/
claude --plugin-dir "$(npm root -g)/m0lz-01/.claude-plugin"
```

Other install paths (repo clone, contributor symlink) in [`docs/plugin-install.md`](docs/plugin-install.md).

### 4. Use `/blog`

```
/blog Launch post for new npm package jmolz/m0lz.01 — Show HN target, Dev.to cross-post.
```

The skill classifies intent, proposes a concrete plan, asks you to approve it, then hands off to `blog agent apply`, which runs each step under a SHA256-bound approval gate. All destructive work is CLI-native; the skill is the orchestration layer.

Read [`docs/plugin-install.md`](docs/plugin-install.md) for troubleshooting.

---

## Using the CLI underneath

Everything the `/blog` skill does is also available as direct CLI commands. If you prefer to drive the pipeline without the skill, or you're scripting in CI, the five-minute CLI walkthrough is below.

### 1. Choose a work directory

`blog init` creates `.blog-agent/` (SQLite state + pipeline artifacts) in the current directory. Pick a dedicated location — **not** inside a project repo:

```bash
mkdir -p ~/blog && cd ~/blog
```

### 2. Scaffold the workspace

```bash
blog init
```

This creates three things in `~/blog/`:

- `.blogrc.yaml` — config template (edit next)
- `.env` — secrets template (edit next)
- `.blog-agent/` — SQLite state + subdirs for each phase

### 3. Edit `.blogrc.yaml`

At minimum, set `site.repo_path` and `author`:

```yaml
site:
  repo_path: "../code/m0lz.00"        # ← relative to THIS file, not CWD
  base_url: "https://your-domain.dev" # canonical URL root for all posts
  content_dir: "content/posts"        # posts location within the hub repo
  research_dir: "content/research"    # research companion pages

author:
  name: "Your Name"
  github: "your-gh-handle"
  devto: "your-devto-handle"
  # medium, substack, linkedin as applicable
```

**Watch out:** `repo_path` is resolved relative to `.blogrc.yaml`, not CWD. From `~/blog/.blogrc.yaml`, the path `../code/m0lz.00` correctly resolves to `~/code/m0lz.00`.

Full schema reference in [Configuration](#configuration).

### 4. Fill in `.env`

```env
DEVTO_API_KEY=             # required only if publish.devto = true
ANTHROPIC_API_KEY=         # optional — Claude API fallback when Claude Code unavailable
```

`.env` is gitignored by default.

### 5. Import existing posts (optional)

If your hub repo already has posts, ingest them into state:

```bash
blog init --import
```

Expected output: `Imported N posts from <hub-repo-name>`. Verify:

```bash
blog status
```

### 6. Create your first new post

Queue an idea, promote it to research, walk it through six phases:

```bash
blog ideas add "Show HN: my topic" --type technical-deep-dive --priority high
blog ideas start 1                              # → research phase
blog research init <slug> --topic "..."         # gather sources
# ... benchmark → draft → evaluate → publish
blog status                                     # track progress
```

See [CLI Reference](#cli-reference) below for every subcommand.

---

## Configuration

### `.blogrc.yaml`

Lives alongside `.blog-agent/`. All path fields resolve **relative to this file**, not CWD.

| Section | Required fields | Purpose |
|---------|----------------|---------|
| `site` | `repo_path`, `base_url`, `content_dir` | Hub site repo location + canonical URL |
| `author` | `name`, `github` | Frontmatter, repo URLs, social handles |
| `ai` | — | Reviewer panel assignment (Claude / Codex) |
| `content_types` | (3 type keys) | Per-content-type pipeline behavior |
| `benchmark` | — | Environment capture, methodology template, run count |
| `publish` | — | Per-platform crossposting toggles |
| `evaluation` | — | Reviewer panel thresholds + policies |
| `updates`, `unpublish` | — | Lifecycle flow options |
| `projects` (optional) | map | Catalog-ID → companion project repo path |

**Content types:**

| Type | Benchmark | Companion repo | HN prefix |
|------|-----------|---------------|-----------|
| `technical-deep-dive` | required | scaffold new | (none) |
| `project-launch` | optional | link existing | `Show HN:` |
| `analysis-opinion` | skip | optional | (none) |

Full annotated defaults ship in `.blogrc.example.yaml`. Minimum viable config:

```yaml
site:
  repo_path: "../your-hub-repo"
  base_url: "https://your-domain.dev"
  content_dir: "content/posts"

author:
  name: "Your Name"
  github: "your-gh-handle"
```

### `.env`

| Variable | Required | Purpose |
|----------|----------|---------|
| `DEVTO_API_KEY` | if `publish.devto: true` | Dev.to Forem API auth |
| `ANTHROPIC_API_KEY` | no | Claude API fallback when Claude Code CLI isn't used |

`.env` is loaded via `dotenv` from the directory where you run `blog`. Keep it in your work directory (same place as `.blogrc.yaml`).

---

## CLI Reference

```bash
# Workspace
blog init                        # create .blog-agent/ + templates
blog init --import               # also import existing posts from hub
blog status                      # table of all posts + phase
blog metrics                     # aggregate stats

# Editorial backlog
blog ideas                       # list ideas.yaml
blog ideas add "title" --priority high --type technical-deep-dive
blog ideas start <index>         # promote to research phase

# Research phase
blog research init <slug> --topic "..."
blog research add-source <slug> --url "..."
blog research show <slug>
blog research finalize <slug>

# Benchmark phase
blog benchmark init <slug>
blog benchmark env <slug>                       # capture environment
blog benchmark run <slug> --results <file>
blog benchmark show <slug>
blog benchmark skip <slug>                      # analysis-opinion only
blog benchmark complete <slug>                  # → draft phase

# Draft phase
blog draft init <slug>
blog draft show <slug>
blog draft validate <slug>
blog draft add-asset <slug> --path <file> --type excalidraw|chart|image
blog draft complete <slug>                      # → evaluate phase

# Evaluate phase (three-reviewer adversarial panel)
blog evaluate init <slug>
blog evaluate structural-autocheck <slug>       # deterministic lints
blog evaluate record <slug> --reviewer <id> --file <reviewer.json>
blog evaluate show <slug>
blog evaluate synthesize <slug>                 # consensus/majority/single
blog evaluate complete <slug>                   # → publish phase
blog evaluate reject <slug>                     # → draft phase

# Publish phase (11-step resumable pipeline)
blog publish start <slug>                       # initialize OR resume
blog publish show <slug>                        # per-step status table

# Update an already-published post
blog update start <slug> --summary "what changed"
blog update benchmark <slug>
blog update draft <slug>
blog update evaluate <slug>
blog update publish <slug>
blog update show <slug>
blog update abort <slug>

# Unpublish
blog unpublish start <slug> --confirm
blog unpublish show <slug>

# Agent orchestration (used by the /blog skill; also usable directly)
blog agent preflight [--json]                   # workspace + config + schema snapshot
blog agent plan <slug> \
  --intent "..." --content-type <type> --depth <depth> --venues "v1,v2" \
  [--steps-inline '<json>' | --steps-json <path>] \
  [--output <path-inside-.blog-agent/plans/>]    # write an unapproved plan skeleton
blog agent approve <plan-path>                  # atomic approved_at + payload_hash
blog agent verify  <plan-path>                  # dry-run validate an approved plan
blog agent apply   <plan-path> [--restart]      # execute step-by-step, writes receipt
```

The `agent` family is the skill's handoff surface: `plan` writes an unapproved
plan file, `approve` hash-binds it, `verify` dry-runs the validator, and `apply`
executes each step under the SHA256-bound gate. The apply runner refuses to run
an unapproved plan, a re-approved plan (hash mismatch), a plan from a different
workspace, or a plan whose step list tries to nest `blog agent *` calls.

---

## Troubleshooting

### `blog init --import` says "Posts directory not found"

`site.repo_path` resolved to the wrong location. Paths are relative to `.blogrc.yaml`, **not** CWD. Open the file and fix the path to what your hub repo actually lives at — then re-run.

### Publish pipeline stopped mid-run

Re-run `blog publish start <slug>` — the pipeline picks up at the first non-completed step. State lives in `.blog-agent/state.db` (`pipeline_steps` table). Every step is idempotent.

### "Lock held by PID N" on publish / update / unpublish

Another process is running, OR a previous run crashed without releasing the lock. Check `ps -p N` — if the PID is dead, remove `.blog-agent/locks/<slug>.lock` and retry. (The CLI reclaims stale `running` rows automatically on resume; only the lockfile may need manual cleanup after a hard crash.)

### Dev.to cross-post fails with 429 / 401

- 429 = rate-limited; wait and re-run `blog publish start <slug>` to retry just that step.
- 401 = `DEVTO_API_KEY` missing or invalid; verify at [dev.to/settings/extensions](https://dev.to/settings/extensions).

### `blog evaluate record` rejects reviewer file

Every reviewer output must conform to the `ReviewerOutput` schema: `reviewer`, `passed`, `issues[]`. Run `blog evaluate structural-autocheck <slug>` first to produce a valid example, then pattern-match.

### `git push` failures during publish

The pipeline runs `assertIndexClean` + strict ahead-commit match before any push. If this fails, an unrelated file in your hub / project repo has uncommitted changes. Clean the tree (commit, stash, or revert), then `blog publish start <slug>` to resume.

### Reset a post back to draft for rework

`blog evaluate reject <slug>` — moves back to draft, tags the next evaluation cycle as an update review.

---

## Architecture

Dual-layer:

- **Standalone CLI** (what `npm install -g m0lz-01` gives you) — mechanical operations: state management, pipeline execution, git/GitHub/Dev.to API calls. No AI dependency.
- **Claude Code skills** (installed separately as a plugin) — interactive AI-heavy work: research, drafting, structural review. Skills call the CLI for all state mutations.

Both layers share state via SQLite (`.blog-agent/state.db`) and file artifacts (`.blog-agent/`). Every publish/update/unpublish step is **idempotent** and **checkpointed** — failures resume from the last good step.

Three-reviewer adversarial evaluation:

| Reviewer | Model | Role |
|----------|-------|------|
| Structural | Claude Code | Content quality, MDX schema, sources |
| Adversarial | GPT-5.4 high (Codex) | Thesis challenge, bias, argument gaps |
| Methodology | GPT-5.4 xhigh (Codex) | Benchmark validity, statistics, reproducibility |

Issues categorize as consensus (all 3 = must fix), majority (2/3 = should fix), single (1/3 = advisory).

Full product scope: `.claude/PRD.md`. Per-phase implementation plans: `.claude/plans/`.

---

## Development

Contribute or work from source:

```bash
git clone https://github.com/jmolz/m0lz.01.git
cd m0lz.01
npm install
npm run build
node dist/cli/index.js init --import
```

Validate:

```bash
npm run lint          # tsc --noEmit
npm test              # vitest run (730+ tests)
npm run build         # clean + tsc
npm run verify-pack   # four-layer packaging gate
```

Release workflow: [RELEASING.md](./RELEASING.md) — adversarially-reviewed runbook for `npm publish` + `gh release create`.

---

## Changelog

[CHANGELOG.md](./CHANGELOG.md).

## Project Status

v0.1 — public API is unstable until v1.0. Per [SemVer 0.y.z](https://semver.org/spec/v2.0.0.html#spec-item-4), minor and patch releases before 1.0 MAY contain breaking changes.

## License

MIT
