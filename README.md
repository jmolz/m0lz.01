<p align="center">
  <img src="branch-mark.svg" width="48" height="48" alt="m0lz.01 branch mark">
</p>

<h1 align="center">m0lz.01</h1>

<p align="center">
  <strong>Idea-to-distribution pipeline for technical content</strong><br>
  Research, benchmark, draft, evaluate, publish, and distribute — all from one prompt.
</p>

<p align="center">
  <a href="https://github.com/jmolz/m0lz.01/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/jmolz/m0lz.01/ci.yml?branch=main&style=flat-square&label=ci&labelColor=404040&color=171717"></a>
  &nbsp;
  <a href="https://www.npmjs.com/package/m0lz-01"><img alt="npm version" src="https://img.shields.io/npm/v/m0lz-01?style=flat-square&label=npm&labelColor=404040&color=171717"></a>
  &nbsp;
  <a href="https://www.npmjs.com/package/m0lz-01"><img alt="Node.js version" src="https://img.shields.io/node/v/m0lz-01?style=flat-square&label=node&labelColor=404040&color=171717"></a>
  &nbsp;
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/jmolz/m0lz.01?style=flat-square&labelColor=404040&color=171717"></a>
</p>

<p align="center">
  <img src="readme-quickstart.gif" width="760" alt="Animated terminal demo showing the first m0lz.01 steps: install the CLI, initialize a workspace, start research, add a source, and check status.">
</p>

---

## Overview

m0lz.01 orchestrates the full lifecycle of technical content. A single prompt can trigger deep research, scaffold a benchmark test suite, run it, draft an MDX post with the original data, adversarially evaluate the result against three reviewers, and distribute across platforms.

Content goes to a hub site (canonical URL, your choice of domain) with Dev.to (cross-post), Medium/Substack (paste-ready fallback), GitHub (companion repos), LinkedIn, and Hacker News as spokes.

Runs locally. No server, no SaaS. The mechanical pipeline is the standalone `blog` CLI; AI-heavy authoring can run from Claude Code or Codex, with Codex also serving the adversarial and methodology reviewer roles.

<p align="center">
  <img src="readme-system-map.png" width="920" alt="Diagram showing Codex commands, the Claude /blog skill, and the standalone blog CLI flowing through a CLI safety boundary into a shared local workspace, then publishing through the m0lz.00 hub to Dev.to, Medium and Substack, project READMEs, LinkedIn, and Hacker News.">
</p>

---

## Prerequisites

### Required

- **Node.js ≥ 20.3** — required by the local `sharp` image pipeline and packaging checks. Check: `node --version`.
- **git** — publish/update/unpublish steps invoke git directly.
- **GitHub CLI (`gh`)** — PR creation, companion-repo scaffolding, release verification. Install from [cli.github.com](https://cli.github.com/). Run `gh auth login` once before first publish.
- **A hub site repo** — somewhere on GitHub to commit canonical MDX. Must have a posts directory (default `content/posts/`) and optionally a research directory (default `content/research/`). See [Configuration](#configuration) for the full shape.

### Optional — required for AI-heavy authoring/review

- **OpenAI Codex CLI** (`codex`) — Codex-first local authoring surface in this repo via `.codex/commands/*` wrappers and `.agents/skills/source-command-*`; also used as the adversarial + methodology reviewer (GPT-5.5 high / xhigh).
- **Claude Code** (`claude` CLI) — supported authoring surface via the packaged `.claude-plugin/` `/blog` skill and used as the structural reviewer. Falls back to `ANTHROPIC_API_KEY` if not installed for supported paths.

Both CLIs authenticate against your subscription. The npm package currently ships the Claude Code plugin; Codex support is repo-local command and skill guidance plus the standalone CLI.

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

Start here even if you know the commands. The first thing to understand is that `blog` is not an autonomous writer.

`blog` is the local state machine. It creates the SQLite row, writes template files, tracks which phase a post is in, validates required artifacts, and runs publish operations.

Codex, Claude Code, or a human author do the judgment work. That means inspecting a repo, running tests, researching sources, writing prose, filling the research template, interpreting benchmark results, and deciding what to publish.

Keep these names separate:

- **Workspace**: the folder that contains `.blog-agent/`, `.blogrc.yaml`, and `.env`.
- **Slug**: the permanent post ID, such as `m0lz-02-stack-loops`.
- **Source URL**: evidence for the post, such as `https://github.com/jmolz/m0lz.02.git`. A URL is not a slug.

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

If you already have a workspace, do not run `blog init` again. Go to that folder before running commands:

```bash
cd ~/blog
blog status
```

From any other directory, pass the workspace explicitly:

```bash
blog --workspace ~/blog status
```

### 3. Pick an authoring surface

Codex can drive the repo-local command wrappers when you are working from this repository:

```text
.codex/commands/prime.md
.codex/commands/plan-feature.md <topic>
.codex/commands/execute.md <plan-file>
```

For Claude Code, load the packaged `/blog` plugin:

```bash
# npm-bundled install — plugin ships inside the tarball at .claude-plugin/
claude --plugin-dir "$(npm root -g)/m0lz-01/.claude-plugin"
```

Other install paths (repo clone, contributor symlink) in [`docs/plugin-install.md`](docs/plugin-install.md).

### 4. Use the authoring layer

Ask the authoring layer to do the thinking and writing, then let it call the CLI for state changes:

```
/blog In workspace ~/blog, create a project-launch post for m0lz.02 Stack Loops. Use https://github.com/jmolz/m0lz.02.git as the primary source, run the relevant tests, fill the research doc, draft the launch post, evaluate it, and prepare the distribution kit.
```

The authoring layer classifies intent, proposes a concrete plan, asks you to approve it, then hands off to `blog agent apply`, which runs each step under a SHA256-bound approval gate. All destructive work is CLI-native; Codex and Claude are orchestration surfaces over the same state.

Read [`docs/plugin-install.md`](docs/plugin-install.md) for troubleshooting.

---

## Using the CLI underneath

The direct CLI exposes the same state machine and publishing controls that `/blog` uses. It does not replace the authoring layer. Commands such as `research init` and `draft init` create records and templates; a human, Codex, or Claude still has to fill them.

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

Start with a slug. Do not pass the GitHub URL as the first argument.

```bash
# Correct: first argument is the slug
blog research init m0lz-02-stack-loops \
  --topic "m0lz.02 Stack Loops launch and testing write-up" \
  --content-type project-launch \
  --project m0lz.02

# Then record the repo as a source
blog research add-source m0lz-02-stack-loops \
  --url "https://github.com/jmolz/m0lz.02.git" \
  --type primary \
  --title "m0lz.02 repository"

blog research show m0lz-02-stack-loops
```

If `blog research show` prints something like `doc status: 7 empty`, the command worked. It means the CLI created the research template and is waiting for authored content.

At this point, switch to Codex or Claude Code if you want AI help doing the research and writing. Use a prompt like this:

```text
In workspace ~/blog, continue m0lz-02-stack-loops.
Inspect https://github.com/jmolz/m0lz.02.git as the primary source.
Run the relevant tests for the project.
Fill every empty section in /Users/jacobmolz/blog/.blog-agent/research/m0lz-02-stack-loops.md.
Then run blog research show m0lz-02-stack-loops.
Do not run blog research finalize m0lz-02-stack-loops until doc status is ok.
```

If you are working manually instead, fill the sections in the research document printed by `blog research show`, or write sections through the CLI:

```bash
blog research set-section m0lz-02-stack-loops --section thesis --from-file thesis.md
blog research set-section m0lz-02-stack-loops --section findings --from-file findings.md
```

When `blog research show` reports the document is complete, validate the phase:

```bash
blog research finalize m0lz-02-stack-loops
```

`research finalize` validates the research artifact. It does not draft the post and it does not advance to the next phase. To move on, choose the benchmark path:

```bash
# For optional benchmarking, run a benchmark cycle
blog benchmark init m0lz-02-stack-loops

# Or skip benchmarking when the content type allows it, which advances to draft
blog benchmark skip m0lz-02-stack-loops
```

Then continue through draft, evaluate, and publish:

```bash
blog draft init m0lz-02-stack-loops
blog draft show m0lz-02-stack-loops
blog draft validate m0lz-02-stack-loops
blog draft complete m0lz-02-stack-loops

blog evaluate init m0lz-02-stack-loops
blog evaluate structural-autocheck m0lz-02-stack-loops
# record reviewer JSON, synthesize, then complete when it passes

blog publish start m0lz-02-stack-loops
blog publish distribution-kit m0lz-02-stack-loops --image-mode generate
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
blog init                                  # create .blog-agent/ + templates
blog init --import                         # also import existing posts from hub
blog status                                # table of all posts + phase
blog --workspace ~/blog status             # run against an existing workspace from anywhere
blog metrics                               # aggregate stats

# Editorial backlog
blog ideas                                 # list ideas.yaml
blog ideas add "title" --priority high --type technical-deep-dive
blog ideas start <index>                   # promote to research phase

# Research phase
blog research init <slug> --topic "..."    # create DB row + research template; does not research
blog research add-source <slug> --url "..." # track a source URL; does not fetch or analyze it
blog research show <slug>                  # print doc path + empty/missing section count
blog research set-section <slug> --section thesis --from-file thesis.md
blog research finalize <slug>              # validate filled doc; does not advance phase

# Benchmark phase
blog benchmark init <slug>                 # advance research -> benchmark
blog benchmark env <slug>                       # capture environment
blog benchmark run <slug> --results <file>
blog benchmark show <slug>
blog benchmark skip <slug>                      # skip/optional content only; advance research -> draft
blog benchmark complete <slug>                  # → draft phase

# Draft phase
blog draft init <slug>
blog draft show <slug>
blog draft validate <slug>
blog draft add-asset <slug> --path <file> --type excalidraw|chart|image
blog draft platform-images <slug>              # generate Dev.to/Medium/Substack PNG assets
blog draft regenerate-frontmatter <slug> [--project <id>]
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
blog publish distribution-kit <slug> \
  [--commit-site] [--image-mode off|prompt-only|generate|required] [--force]

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

`blog draft platform-images` writes deterministic local distribution images to
`.blog-agent/drafts/<slug>/assets/`: `devto-cover.png` (`1000x420`),
`medium-featured.png` (`1200x675`), and `substack-preview.png` (`1200x630`).
All three use the same article-card framework with platform-specific
dimensions. The command updates draft frontmatter with `devto_main_image`,
`medium_featured_image`, and `substack_preview_image`; later `site-pr` /
`site-update` verifies those fields without rewriting the evaluated draft.

`blog publish start` and `blog update publish` also generate a durable
distribution kit before the site repo is mutated. Local artifacts land in
`.blog-agent/social/<slug>/`: `linkedin.md`, `hackernews.md`,
`linkedin-image-prompt.md`, and `manifest.json`; generated LinkedIn feed
images use the fixed PNG path `.blog-agent/drafts/<slug>/assets/linkedin-feed.png`.
The `social-text` pipeline step is now persist-only: after the preview gate and
URL/README updates, it copies the already-generated kit to
`content/posts/<slug>/distribution/` and the optional image to
`content/posts/<slug>/assets/linkedin-feed.png`.

LinkedIn image generation is controlled by `.blogrc.yaml`:

```yaml
social:
  distribution_kit:
    enabled: true
    persist_to_site: true
    directory: "distribution"
  linkedin_image:
    mode: "prompt-only" # off | prompt-only | generate | required
    model: "gpt-image-2-2026-04-21"
    size: "1200x1200"
    quality: "high"
```

`prompt-only` is the default and never calls OpenAI. `generate` and `required`
use `OPENAI_API_KEY` with GPT Image 2 and fail before site checkout/copy/commit
if image generation is unavailable. Use
`blog publish distribution-kit <slug> --image-mode prompt-only` to backfill a
published post without an image API call.

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

Three-layer local workflow:

- **Standalone CLI** (what `npm install -g m0lz-01` gives you) — mechanical operations: state management, pipeline execution, git/GitHub/Dev.to API calls. No AI dependency.
- **Codex repo guidance** (`.codex/commands/*` + `.agents/skills/source-command-*`) — Codex-first planning, execution, review, and maintenance commands for local development.
- **Claude Code skills** (`.claude-plugin/`, shipped in the npm tarball) — interactive `/blog` work: research, drafting, structural review. Skills call the CLI for all state mutations.

Both layers share state via SQLite (`.blog-agent/state.db`) and file artifacts (`.blog-agent/`). Every publish/update/unpublish step is **idempotent** and **checkpointed** — failures resume from the last good step.

Three-reviewer adversarial evaluation:

| Reviewer | Model | Role |
|----------|-------|------|
| Structural | Claude Code | Content quality, MDX schema, sources |
| Adversarial | GPT-5.5 high (Codex) | Thesis challenge, bias, argument gaps |
| Methodology | GPT-5.5 xhigh (Codex) | Benchmark validity, statistics, reproducibility |

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
npm test              # vitest run (new distribution-kit coverage included)
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

## Writing

- [m0lz-01-launch](https://m0lz.dev/writing/m0lz-01-launch)
