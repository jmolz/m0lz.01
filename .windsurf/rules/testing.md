---
trigger: glob
globs:
  - "tests/**"
  - "**/*.test.ts"
---

# Testing Conventions

Rules for Vitest tests in `tests/`. These patterns emerged during Phases 1-3 and keep tests fast, isolated, and meaningful.

## Framework and location

- **Framework**: Vitest (`npm test` runs `vitest run`)
- **Location**: `tests/*.test.ts` (flat, not mirroring `src/`)
- **Minimum coverage per module**: 1 happy path + 1 edge case + 1 error case

## Isolation: temp dirs + in-memory DBs

**Never** touch `.blog-agent/`, `.blogrc.yaml`, or any project-level path from a test. Use temp directories or in-memory databases.

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;
let db: Database.Database;

afterEach(() => {
  if (db) closeDatabase(db);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

it('creates expected output', () => {
  tempDir = mkdtempSync(join(tmpdir(), 'blog-test-'));
  db = getDatabase(':memory:'); // or getDatabase(join(tempDir, 'test.db')) for file-backed
  // ...
});
```

## When to use `:memory:` vs file-backed

- **`:memory:`** — default choice for schema, query, and logic tests. Fastest.
- **File-backed** (`join(tempDir, 'test.db')`) — required when testing behavior that differs on disk, e.g., WAL mode, or when the code under test passes a path string.

```typescript
// file-backed — WAL mode only works on disk
it('enables WAL mode on file-backed database', () => {
  tempDir = mkdtempSync(join(tmpdir(), 'blog-db-'));
  db = getDatabase(join(tempDir, 'test.db'));
  expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
});
```

## Testing CLI handlers

Handlers accept injectable path parameters (see `cli.md`). Tests pass temp paths directly — no `process.chdir()`.

```typescript
it('runStatus prints table when posts exist', () => {
  tempDir = mkdtempSync(join(tmpdir(), 'blog-cli-'));
  const dbPath = join(tempDir, 'state.db');
  db = getDatabase(dbPath);
  insertPost(db, 'alpha');
  closeDatabase(db);
  db = undefined as unknown as Database.Database;

  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((msg: string) => { logs.push(msg); });

  runStatus(dbPath);

  expect(logs.join('\n')).toContain('alpha');
});
```

## Capturing console output

Use `vi.spyOn(console, 'log' | 'error' | 'warn').mockImplementation(...)` and collect into an array. Restore with `vi.restoreAllMocks()` in `afterEach`.

```typescript
afterEach(() => {
  vi.restoreAllMocks();
});

it('warns on malformed frontmatter', () => {
  const warnings: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((msg: string) => { warnings.push(msg); });

  importPosts(db, tempDir, 'https://m0lz.dev');

  expect(warnings.some((w) => w.includes('bad-post'))).toBe(true);
});
```

For tests that need both `logs` and `errors`, use a helper that captures all channels at once and auto-restores:

```typescript
function captureLogs(): { logs: string[]; errors: string[] } {
  vi.restoreAllMocks();
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  return { logs, errors };
}
```

This pattern is used extensively in `benchmark-cli.test.ts` and `research-cli.test.ts`.

## Testing `process.exit()` paths

Mock `process.exit` to throw a distinguishable error. The test catches it and asserts the exit code.

```typescript
it('exits with code 1 when database is missing', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(
    ((code?: number) => { throw new Error(`exit:${code}`); }) as never
  );

  expect(() => runStatus('/nonexistent.db')).toThrow('exit:1');
});
```

## Testing `process.exitCode` paths

For handlers that set `process.exitCode` instead of calling `process.exit()` (preferred — see `cli.md`), save and restore around the test so it doesn't bleed into other tests.

```typescript
it('sets exitCode=1 on import failure', () => {
  const savedExitCode = process.exitCode;
  try {
    runInit(true, tempDir);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = savedExitCode;
  }
});
```

## Fixtures

For tests that exercise file-based code (import, config loader), write minimal fixtures directly to `tempDir`. Don't create shared fixture directories in the repo — they drift.

```typescript
function createFixturePost(postsDir: string, slug: string, frontmatter: string): void {
  const postDir = join(postsDir, slug);
  mkdirSync(postDir, { recursive: true });
  writeFileSync(join(postDir, 'index.mdx'), `---\n${frontmatter}\n---\n\nPost content.`);
}
```

## What to test

Per module, include at minimum:

1. **Happy path** — correct output for valid input
2. **Edge case** — empty input, boundary values, unusual-but-valid input
3. **Error case** — invalid input, missing resources, malformed data

**Idempotency is required** for any function that modifies persistent state (DB inserts, file writes, YAML mutations, external API calls). Run the operation twice in one test, assert the second call produces no new rows/files/side effects. CLAUDE.md enforces idempotency as a project-wide invariant — the test is how we prove it.

```typescript
it('is idempotent on re-run', () => {
  importPosts(db, tempDir, baseUrl);
  importPosts(db, tempDir, baseUrl);
  const count = (db.prepare('SELECT COUNT(*) as c FROM posts').get() as { c: number }).c;
  expect(count).toBe(expectedCount);
});
```

## Regression suite

Every test file must be registered in **both** `.windsurf/workflows/review.md` and `.claude/commands/review.md` under the current milestone. When shipping a feature:

1. Add the new `.test.ts` to the `npx vitest run` command
2. Add a row to the "What each test covers" table
3. Add protected source files to the "Source files these tests protect" list
4. Update the baseline test count and output format template

If a test exists but isn't in both regression suites, it's invisible to future `/review` runs.

## Testing content-type routing

When CLI handlers branch on content type (required/optional/skip), test all three paths:

- **required** (`technical-deep-dive`): verify init succeeds
- **optional** (`project-launch`): verify warning is printed AND operation proceeds
- **skip** (`analysis-opinion`): verify `exitCode=1` is set with descriptive error

The optional path is easy to miss — always write an explicit test asserting both the warning message and the successful state transition.

## Testing around phase boundaries

When library functions enforce phase boundaries (e.g., `getResearchPost` throws for non-research posts, `completeBenchmark` throws for non-benchmark posts), tests that intentionally advance a post to a later phase must use **direct DB queries** for assertions instead of the library function:

```typescript
// Bad — getResearchPost throws because we just advanced past research
advancePhase(db, 'my-slug', 'draft');
const post = getResearchPost(db, 'my-slug'); // THROWS!

// Good — query the DB directly to verify state
advancePhase(db, 'my-slug', 'draft');
const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get('my-slug') as PostRow;
expect(post.phase).toBe('draft');
```
