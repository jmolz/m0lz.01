# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

m0lz.01 is a local idea-to-distribution pipeline that orchestrates the full lifecycle of technical content: research, benchmark, draft, evaluate, publish, and distribute. It publishes to [m0lz.dev](https://m0lz.dev) (m0lz.00) as the canonical hub, with cross-post platforms and project repos as spokes. The agent runs locally using Claude Code for interactive AI work and a standalone CLI for mechanical operations.

---

## Tech Stack

| Technology | Purpose |
|------------|---------|
| TypeScript / Node.js | Runtime (ESM modules, Node 20+) |
| Commander.js | CLI framework for standalone commands |
| better-sqlite3 | SQLite state management (synchronous API) |
| js-yaml | YAML config parsing (.blogrc.yaml) |
| dotenv | Environment variable loading |
| Vitest | Unit and integration testing |

---

## Commands

```bash
# Build
npm run build              # TypeScript compilation (tsc)
npm run dev                # Watch mode (tsc --watch)

# Test
npm test                   # Run all tests (vitest run)
npm run test:watch         # Watch mode (vitest)

# Lint & Type Check
npm run lint               # Type check only (tsc --noEmit)

# Full Validation (run before every commit)
npm run lint && npm test && npm run build
```

---

## Project Structure

```text
m0lz.01/
  src/
    cli/                   # Commander.js command definitions
      index.ts             # Entry point (#!/usr/bin/env node)
      init.ts              # blog init + --import
      publish.ts           # Cross-post pipeline with resume
      unpublish.ts         # Rollback
      status.ts            # Pipeline state viewer
      metrics.ts           # Aggregate stats
      ideas.ts             # Editorial backlog
      research.ts          # Research phase (init, add-source, show, finalize)
      draft.ts             # Draft phase (init, show, validate, add-asset, complete)
    skills/                # Claude Code skill definitions (later phases)
    core/                  # Shared business logic
      db/                  # SQLite schema, connection, types
      config/              # .blogrc.yaml loader + types
      migrate/             # Import existing m0lz.00 posts
      research/            # Research orchestration
      benchmark/           # Test harness scaffolding + execution
      draft/               # MDX generation + content types
      evaluate/            # Three-reviewer evaluation panel
      publish/             # Cross-posting pipeline (idempotent)
      visuals/             # Excalidraw + benchmark charts
      social/              # LinkedIn + Hacker News text generation
      repo/                # Companion repo scaffolding
      research-page/       # Auto-generate m0lz.00 research pages
      update/              # Content update pipeline
      ideas/               # Editorial backlog management
  templates/               # Repo, methodology, social, research-page templates
  tests/                   # Vitest test files
  .blog-agent/             # Runtime state (gitignored)
    state.db               # SQLite database
    ideas.yaml             # Editorial backlog
    research/              # Research documents
    benchmarks/            # Benchmark results + environment snapshots
    drafts/                # MDX drafts + assets
    repos/                 # Companion repo scaffolds
    social/                # Social post text
    evaluations/           # Evaluation reports
    research-pages/        # Generated research page MDX
```

---

## Architecture

### Dual-Layer Design

**Claude Code Skills** (interactive, uses subscription): `/blog-research`, `/blog-benchmark`, `/blog-draft`, `/blog-evaluate`, `/blog-pipeline`, `/blog-update` — these handle AI-heavy work in Claude Code sessions.

**Standalone CLI** (mechanical, no AI needed): `blog init`, `blog publish`, `blog unpublish`, `blog status`, `blog metrics`, `blog ideas`, `blog research init|add-source|show|finalize`, `blog benchmark init|env|run|show|skip|complete`, `blog draft init|show|validate|add-asset|complete` — these run independently for API calls, state queries, and pipeline execution.

**Shared state**: Both layers read/write the same SQLite database and file system artifacts.

### Data Flow

```text
Prompt -> Detect mode (directed vs exploratory) + content type
  -> Research (web search, source gathering)
  -> Benchmark (scaffold test harness, run, collect data) [skip for analysis/opinion, optional for project-launch]
  -> Draft (MDX with benchmark data, Excalidraw diagrams)
  -> Evaluate (three-reviewer panel: Claude + GPT-5.4 high + GPT-5.4 xhigh)
  -> Publish (PR to m0lz.00, cross-post, companion repo, social text)
```

### Pipeline Resume

Every publish sub-step is idempotent and checkpointed in SQLite `pipeline_steps` table. Failure at step N means `blog publish` resumes from step N+1.

### Three-Reviewer Evaluation Panel

| Reviewer | Model | Role |
|----------|-------|------|
| Structural | Claude Code | Content quality, schema, MDX, sources |
| Adversarial | GPT-5.4 high (Codex CLI) | Thesis challenge, bias, argument gaps |
| Methodology | GPT-5.4 xhigh (Codex CLI) | Benchmark validity, statistics, reproducibility |

Issues categorized by consensus (all 3 = must fix), majority (2/3 = should fix), single (1/3 = advisory).

---

## Code Patterns

### Naming

- Files: `kebab-case.ts` (e.g., `content-types.ts`, `import-posts.ts`)
- Functions: `camelCase` (e.g., `loadConfig`, `importPosts`, `getDatabase`)
- Interfaces/Types: `PascalCase` (e.g., `PostRow`, `BlogConfig`, `IdeaEntry`)
- Constants: `UPPER_SNAKE_CASE` (e.g., `SCHEMA_VERSION`, `DEFAULT_CONFIG`)
- CLI commands: `kebab-case` in Commander (displayed as `blog init`, `blog status`)

### Imports

```typescript
// 1. Node built-ins (node: prefix)
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

// 2. External dependencies
import Database from 'better-sqlite3';
import yaml from 'js-yaml';

// 3. Internal modules (MUST use .js extension — ESM convention)
import { BlogConfig } from '../config/types.js';
import { getDatabase } from '../db/database.js';
```

**Critical**: All internal imports use `.js` extension, even though source files are `.ts`. This is required by TypeScript's Node16 module resolution with ESM.

### Error Handling

```typescript
// Pre-resource-acquisition: process.exit(1) is acceptable
if (!existsSync(dbPath)) {
  console.error("No state database found. Run 'blog init' first.");
  process.exit(1);
}

// Post-resource-acquisition: use process.exitCode so finally blocks run
const db = getDatabase(dbPath);
try {
  try {
    result = initResearchPost(db, slug, topic, mode, contentType);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }
} finally {
  closeDatabase(db);
}

// Library functions: throw typed errors
throw new Error(`Missing required config field: site.repo_path`);
```

Library functions **throw** typed errors. CLI handlers **catch** at the boundary and format output. Use `process.exitCode = 1` (not `process.exit(1)`) after any resource acquisition to ensure `finally` blocks run.

### Input Validation

Validate user input (slugs, paths) at the CLI boundary before touching DB or filesystem:

```typescript
try {
  validateSlug(slug);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
  return;
}
```

Slug regex: `/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/` — lowercase alphanumeric with hyphens, no leading/trailing hyphens, no path separators.

### Database

```typescript
// Always use prepared statements with parameters — never interpolate
const stmt = db.prepare('SELECT * FROM posts WHERE slug = ?');
const post = stmt.get(slug) as PostRow | undefined;

// Mutations return RunResult
const info = db.prepare('INSERT INTO posts (slug, phase) VALUES (?, ?)').run(slug, 'research');

// Wrap multi-step mutations in transactions
const insertMany = db.transaction((posts: PostRow[]) => {
  for (const post of posts) insertStmt.run(post);
});
```

better-sqlite3 is synchronous. Do not introduce async/await for database operations.

### Config Path Resolution

Paths in `.blogrc.yaml` (like `site.repo_path: "../m0lz.00"`) are resolved relative to the config file's directory, not CWD:

```typescript
const resolvedPath = resolve(dirname(configPath), rawPath);
```

---

## Testing

- **Framework**: Vitest
- **Location**: `tests/*.test.ts`
- **Run**: `npm test`
- **Baseline**: 225 tests across 21 suites (Phase 1: 48, Phase 2: 54, Phase 3: 44, Phase 4: 79)
- **Minimum**: Each module needs: 1 happy path, 1 edge case, 1 error case
- **DB tests**: Use in-memory SQLite (`getDatabase(':memory:')`)
- **File tests**: Use `mkdtemp` for temporary directories, clean up in `afterEach`
- **CLI tests**: Import command handler functions directly, pass mock paths via `XPaths` interface

---

## Adversarial Evaluation (Codex Plugin)

This project uses **three-reviewer adversarial evaluation** via the Codex CLI (GPT-5.4). Codex acts as peer-level adversary to Claude, challenging both arguments and methodology.

- **Tier 2+ features**: Run Codex adversarial review (GPT-5.4 high) in parallel with Claude evaluation
- **Tier 3 architectural changes**: Use GPT-5.4 xhigh for deep methodology review
- **Evaluation synthesis**: Consensus/majority/single-reviewer categorization

---

## Validation (Pre-Commit)

Run these before every commit:

```bash
npx tsc --noEmit
npm test
npm run build
```

---

## On-Demand Context

### Auto-loaded rules (path-scoped)

These load automatically when editing files in their scope:

| File | Scope | Covers |
|------|-------|--------|
| `.claude/rules/database.md` | schema/DB files | SQLite conventions, WAL, foreign keys, migrations, type mapping |
| `.claude/rules/cli.md` | `src/cli/**` | Handler shape, injectable paths, exit codes, DB cleanup, error boundary, best-effort config for show commands |
| `.claude/rules/testing.md` | `tests/**`, `*.test.ts` | Temp dirs, `:memory:` DBs, mocking console/exit, fixtures, regression suite |
| `.claude/rules/drafting.md` | `src/core/draft/**`, `src/cli/draft.ts`, `templates/draft/**` | PostFrontmatter contract, MDX parsing, placeholder tokens, content-type routing, asset safety |

### Read on demand

| Area | File | When |
|------|------|------|
| Full product spec | `.claude/PRD.md` | Understanding scope, features, architecture |
| Phase 1 plan | `.claude/plans/phase-1-foundation.md` | Implementing foundation |
| Phase 2 plan | `.claude/plans/phase-2-research.md` | Research pipeline + contract |
| Phase 3 plan | `.claude/plans/phase-3-benchmark.md` | Benchmark test harness + contract |
| Phase 4 plan | `.claude/plans/phase-4-draft.md` | Draft + visuals + contract |
| Drafting rules | `.claude/rules/drafting.md` | MDX parsing pitfalls, PostFrontmatter contract, placeholder tokens |
| Original brainstorm | `.claude/plans/blog-agent-prd.md` | Historical context |
| PICE workflow | `.claude/docs/PLAYBOOK.md` | Plan/Implement/Evaluate loop |
| Agent teams | `.claude/docs/AGENT-TEAMS-PLAYBOOK.md` | Parallel agent coordination |

---

## Key Rules

- **ESM imports require `.js` extension** — every internal import must end in `.js` even for `.ts` source files. This is non-negotiable with Node16 module resolution.
- **All database queries use parameterized statements** — never string interpolation for SQL. Use `?` placeholders or `@named` parameters.
- **Config values are threaded, never hardcoded** — `config.author.github`, `config.site.base_url`, `config.site.content_dir`, and similar identity/URL values must flow into library functions via option parameters. Baking `jmolz` or `m0lz.dev` into a module breaks the moment another author uses the agent.
- **Phase boundary enforcement** — research commands (`add-source`, `show`, `finalize`) must reject posts not in the `research` phase. Benchmark commands (`env`, `run`, `complete`) must reject posts not in the `benchmark` phase. Draft commands (`init`, `show`, `validate`, `add-asset`, `complete`) must reject posts not in the `draft` phase. Library functions throw; CLI handlers catch and set `exitCode=1`.
- **CLI commands are non-interactive** — use Commander.js options/arguments, not readline prompts. Interactive collaboration happens in Claude Code skills, not the CLI.
- **Pipeline operations are idempotent** — running any publish step twice must not create duplicates or corrupt state. Use `INSERT OR IGNORE`, check-before-act patterns.
- **Never commit secrets** — `.env`, `.blogrc.yaml`, and `.blog-agent/` are gitignored. Only `.env.example` and `.blogrc.example.yaml` are committed.
- **No emojis in content** — design constraint inherited from m0lz.00. Applies to generated MDX, social text, and all user-facing output.
- **Canonical URL is permanent** — never rename a post slug after publishing. `https://m0lz.dev/writing/{slug}` is the canonical URL forever.
- **Benchmark data is sacred** — never discard raw results, even if they contradict the thesis. Store everything. METHODOLOGY.md must be complete and reproducible.
- **Fallback is structural** — Medium and Substack API failures generate paste-ready markdown. The pipeline never blocks on unreliable APIs.

---

## Hub-Spoke Content Architecture

m0lz.dev owns all content and SEO authority. The agent commits MDX to `m0lz.00/content/posts/{slug}/`. Cross-posts set `canonical_url` to `https://m0lz.dev/writing/{slug}`. Project repo READMEs link back to the hub.

### PostFrontmatter Schema (contract with m0lz.00)

```typescript
interface PostFrontmatter {
  title: string           // "{catalogId} -- Description" for catalog projects
  description: string     // One-line for SEO
  date: string            // "YYYY-MM-DD"
  tags: string[]          // Agent-driven taxonomy
  published: boolean
  canonical?: string      // "https://m0lz.dev/writing/{slug}"
  companion_repo?: string
  project?: string        // Catalog ID (e.g., "m0lz.02")
  medium_url?: string     // Populated after cross-post
  devto_url?: string      // Populated after cross-post
}
```

### Content Types

| Type | Benchmark | Companion Repo | HN Prefix |
|------|-----------|---------------|-----------|
| project-launch | Optional | Existing | Show HN: |
| technical-deep-dive | Required | New test suite | (none) |
| analysis-opinion | Skip | Optional | (none) |
