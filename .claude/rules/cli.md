---
paths:
  - "src/cli/**"
---

# CLI Handler Conventions

Rules for writing Commander.js command handlers in `src/cli/`. These patterns emerged during Phase 1-2 and keep the CLI testable and robust.

## Handler shape

Every CLI command has two layers:

1. **`registerX(program)`** — thin Commander.js wrapper that calls the handler
2. **`runX(...)`** — the actual work, exported and testable. Always prefix with `run` so CLI entry points are discoverable by a single grep (`grep -r "export function run"`). For library functions that happen to also be invoked by the CLI (e.g., `startIdea`, `removeIdea` in `ideas.ts`), use the verb-noun library name — these represent domain operations, not CLI entry points.

```typescript
// Good — exported, accepts injectable paths, testable without CWD chdir
export function runStatus(dbPath = DB_PATH): void {
  if (!existsSync(dbPath)) {
    console.error("No state database found. Run 'blog init' first.");
    process.exit(1);
  }
  const db = getDatabase(dbPath);
  try {
    // ... work
  } finally {
    closeDatabase(db);
  }
}

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Show all posts and their pipeline status')
    .action(() => runStatus());
}
```

## Injectable paths

Handlers that touch `.blog-agent/` **must** accept optional path parameters that default to the module-level constants. This makes them callable from tests without `process.chdir()` hacks.

```typescript
// Good
export function runInit(shouldImport: boolean, baseDir: string = process.cwd()): void { ... }
export function runMetrics(dbPath = DB_PATH): void { ... }
export function startIdea(index: number, ideasPath = IDEAS_PATH, dbPath = DB_PATH): void { ... }

// Bad — not testable
export function runMetrics(): void {
  const db = getDatabase(DB_PATH); // hardcoded, can't inject test DB
}
```

For handlers with multiple injectable paths, group them in an interface with defaults:

```typescript
export interface ResearchPaths {
  dbPath?: string;
  researchDir?: string;
  configPath?: string;
}

export function runResearchInit(slug: string, opts: InitOptions, paths: ResearchPaths = {}): void {
  const dbPath = paths.dbPath ?? DB_PATH;
  const researchDir = paths.researchDir ?? RESEARCH_DIR;
  // ...
}
```

## Exit codes — use `process.exitCode`, not `process.exit()`

`process.exit()` terminates immediately and **skips pending `finally` blocks**, causing resource leaks. Use `process.exitCode = 1` instead so cleanup runs during normal termination.

```typescript
// Good — DB gets closed even on failure
const db = getDatabase(dbPath);
try {
  if (shouldImport) {
    try {
      importPosts(db, ...);
    } catch (e) {
      console.error(`Import failed: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
} finally {
  closeDatabase(db);
}

// Acceptable only before any resources are acquired
if (!existsSync(dbPath)) {
  console.error("No state database found.");
  process.exit(1);
}
```

## Database cleanup

Every `getDatabase()` call **must** be paired with a `closeDatabase()` in a `finally` block if any intervening code can throw:

```typescript
const db = getDatabase(dbPath);
try {
  db.prepare(`INSERT INTO posts ...`).run(...);
} finally {
  closeDatabase(db);
}
```

## Functional core, imperative shell

Split pure data transformations from I/O. This makes them trivially unit-testable.

```typescript
// Pure: takes DB, returns data. No console, no process.exit.
export function computeMetrics(db: Database.Database): MetricsSummary { ... }

// Shell: thin wrapper over the pure function
export function runMetrics(dbPath = DB_PATH): void {
  const db = getDatabase(dbPath);
  try {
    const m = computeMetrics(db);
    console.log(`Total: ${m.total}`);
    // ...
  } finally {
    closeDatabase(db);
  }
}
```

## Error handling at the CLI boundary

Library functions **throw** typed errors with descriptive messages. CLI action handlers **catch** them and format output. Never let raw stack traces reach the user.

```typescript
// Library (throws)
export function startIdea(index: number, ...): void {
  if (index < 1 || index > ideas.length) {
    throw new Error(`Invalid index: ${index}. Valid range: 1-${ideas.length}.`);
  }
  // ...
}

// CLI (catches + formats)
ideas
  .command('start <index>')
  .action((index: string) => {
    try {
      startIdea(parseInt(index, 10));
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });
```

## Input validation at the CLI boundary

Validate user-provided slugs, paths, and identifiers **before** touching the database or filesystem. Use `validateSlug()` from `src/core/research/document.ts` for slugs:

```typescript
try {
  validateSlug(slug);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
  return;
}
```

## Phase boundary enforcement

Library functions like `getResearchPost()` and `addSource()` throw when a post is not in the expected phase. CLI handlers must catch these throws:

```typescript
let post;
try {
  post = getResearchPost(db, slug);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
  return;
}
```

Never let a phase-boundary error propagate uncaught — it will crash the CLI with a raw stack trace.

## Non-interactive

CLI commands **must** be non-interactive — Commander options/arguments only, no `readline` prompts. Interactive collaboration happens in Claude Code skills, not the CLI. This keeps the CLI scriptable (cron, CI, pipelines).

## Output

- **No emojis** in any user-facing output. Design constraint inherited from m0lz.00.
- Use `console.log` for normal output, `console.error` for errors. Errors go to stderr so they don't pollute pipes.
- For tables, use `String.padEnd()` with dynamic column widths computed from the data. No external table libraries.
