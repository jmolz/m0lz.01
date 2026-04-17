---
paths:
  - "src/core/db/**"
  - "src/core/migrate/**"
  - "src/core/benchmark/state.ts"
  - "tests/db.test.ts"
  - "tests/import.test.ts"
  - "tests/db-migration.test.ts"
  - "tests/benchmark-state.test.ts"
---

# Database Conventions

## SQLite via better-sqlite3

- **Synchronous API only** — do not wrap in async/await
- **WAL mode** — enabled on every database open: `db.pragma('journal_mode = WAL')`
- **Foreign keys** — enabled on every open: `db.pragma('foreign_keys = ON')`
- **Prepared statements** — always use `?` or `@named` parameters, never string interpolation. SQLite does not support parameterized table names — use separate prepared statements per table (branched by literal), never `${table}` template interpolation

## Schema Migrations

Use SQLite `user_version` pragma for schema versioning. Each version increment gets a dedicated `if (fromVersion < N)` block inside a single transaction, so a crash mid-migration leaves the DB at the old version, never halfway. See `src/core/db/database.ts` for the live pattern — v1 and v2 apply monolithic `SCHEMA_V*` strings; v3 calls a dedicated `migrateV3` helper because it rebuilds a populated table.

### Canonical table-rebuild (adding NOT NULL to existing table)

SQLite cannot add a `NOT NULL` column without a default to a populated table. The canonical pattern — **rename → create-new → INSERT..SELECT → drop-old** — is the only safe way. All four statements must run inside the outer migration transaction so they're atomic with the `user_version` bump.

The `migrateV3` helper in `src/core/db/database.ts` is the canonical reference:

1. `ALTER TABLE pipeline_steps RENAME TO pipeline_steps_old`
2. `CREATE TABLE pipeline_steps (... cycle_id INTEGER NOT NULL DEFAULT 0 ...)`
3. `INSERT INTO pipeline_steps (..., cycle_id, ...) SELECT ..., 0, ... FROM pipeline_steps_old` — pre-migration rows get `cycle_id = 0` (initial publish)
4. `DROP TABLE pipeline_steps_old`

**Never** use `DROP TABLE IF EXISTS` + `CREATE TABLE` without the copy — that discards operator data. Test the migration on a seeded v2 DB (see `tests/db-migration-v3.test.ts`) to prove rows survive.

### Partial unique indexes (conditional uniqueness)

When a row has a "life cycle" (open → closed) and you want at most one open row per entity, use a partial unique index rather than a full `UNIQUE` constraint:

```sql
CREATE UNIQUE INDEX idx_update_cycles_open
  ON update_cycles (post_slug)
  WHERE closed_at IS NULL;
```

This lets multiple closed rows coexist for the same `post_slug` (history) while the DB rejects a second open cycle. SQLite enforces this at INSERT time — test it by attempting to open a second cycle and asserting the throw (see `tests/update-cycles.test.ts`).

## Idempotency

- Import: `INSERT OR IGNORE INTO posts` (slug is PRIMARY KEY)
- Sources: `UNIQUE(post_slug, url)` constraint with `INSERT OR IGNORE`
- Pipeline steps: `UNIQUE(post_slug, step_name)` constraint
- Always check before creating external resources

## Phase boundary enforcement

Library functions that operate on posts must verify the post is in the expected phase before proceeding. Throw a descriptive error if not:

```typescript
const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
if (post && post.phase !== 'research') {
  throw new Error(
    `Post '${slug}' is in phase '${post.phase}', not 'research'. ` +
    `Research commands only operate on posts in the research phase.`,
  );
}
```

This pattern applies to `getResearchPost`, `addSource`, `initResearchPost` (cross-phase collision guard), `initBenchmark` (requires research phase), `getBenchmarkPost` (requires benchmark phase), `completeBenchmark` (requires benchmark phase), `skipBenchmark` (requires research phase), `getEvaluatePost` (requires evaluate phase), and `initEvaluation` (accepts draft or evaluate).

## Type Mapping

| SQLite | TypeScript |
|--------|-----------|
| TEXT | string |
| INTEGER | number |
| BOOLEAN | number (0/1) — cast in application code |
| DATETIME | string (ISO 8601 UTC) |
| JSON column | string — parse with JSON.parse() in application |

## Testing

- Use `:memory:` databases for unit tests
- Create fresh DB per test to avoid state leakage
- Verify constraints by testing that invalid data throws
