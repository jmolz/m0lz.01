---
trigger: always
---

# m0lz.01 — Global Project Rules

## Project Overview

m0lz.01 is a local idea-to-distribution pipeline that orchestrates the full lifecycle of technical content: research, benchmark, draft, evaluate, publish, and distribute. It publishes to m0lz.dev (m0lz.00) as the canonical hub. The agent runs locally using Claude Code for interactive AI work and a standalone CLI for mechanical operations.

## Tech Stack

- **TypeScript / Node.js** — Runtime (ESM modules, Node 20+)
- **Commander.js** — CLI framework
- **better-sqlite3** — SQLite state management (synchronous API)
- **js-yaml** — YAML config parsing (.blogrc.yaml)
- **dotenv** — Environment variable loading
- **Vitest** — Unit and integration testing

## Commands

```bash
npm run build              # TypeScript compilation (tsc)
npm run dev                # Watch mode (tsc --watch)
npm test                   # Run all tests (vitest run)
npm run test:watch         # Watch mode (vitest)
npm run lint               # Type check only (tsc --noEmit)
# Full validation (run before every commit):
npm run lint && npm test && npm run build
```

## Key Rules

- **ESM imports require `.js` extension** — every internal import must end in `.js` even for `.ts` source files. Non-negotiable with Node16 module resolution.
- **All database queries use parameterized statements** — never string interpolation for SQL. Use `?` placeholders or `@named` parameters.
- **CLI commands are non-interactive** — use Commander.js options/arguments, not readline prompts.
- **Pipeline operations are idempotent** — running any publish step twice must not create duplicates or corrupt state.
- **Never commit secrets** — `.env`, `.blogrc.yaml`, and `.blog-agent/` are gitignored.
- **No emojis in content** — design constraint inherited from m0lz.00. Applies to generated MDX, social text, and all user-facing output.
- **Canonical URL is permanent** — never rename a post slug after publishing.
- **Benchmark data is sacred** — never discard raw results. METHODOLOGY.md must be complete and reproducible.
- **Fallback is structural** — Medium and Substack API failures generate paste-ready markdown. Pipeline never blocks on unreliable APIs.

## Naming Conventions

- **Files**: `kebab-case.ts`
- **Functions**: `camelCase`
- **Interfaces/Types**: `PascalCase`
- **Constants**: `UPPER_SNAKE_CASE`
- **CLI commands**: `kebab-case` in Commander

## Import Order

```typescript
// 1. Node built-ins (node: prefix)
import { existsSync, readFileSync } from 'node:fs';
// 2. External dependencies
import Database from 'better-sqlite3';
// 3. Internal modules (MUST use .js extension)
import { BlogConfig } from '../config/types.js';
```

## Error Handling

- CLI operations: fail fast with descriptive messages
- Library functions: throw typed errors
- No try/catch wrapping unless there's a specific recovery action
- Let errors propagate to the CLI layer

## On-Demand Context

Read these files when working in their respective areas:
- `.claude/PRD.md` — Full product spec
- `.claude/plans/*.md` — Implementation plans
- `.claude/docs/PLAYBOOK.md` — PICE workflow
- `.claude/docs/AGENT-TEAMS-PLAYBOOK.md` — Parallel agent coordination
