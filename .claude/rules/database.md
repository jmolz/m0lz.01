---
paths:
  - "src/core/db/**"
  - "src/core/migrate/**"
  - "tests/db.test.ts"
  - "tests/import.test.ts"
  - "tests/db-migration.test.ts"
---

# Database Conventions

## SQLite via better-sqlite3

- **Synchronous API only** — do not wrap in async/await
- **WAL mode** — enabled on every database open: `db.pragma('journal_mode = WAL')`
- **Foreign keys** — enabled on every open: `db.pragma('foreign_keys = ON')`
- **Prepared statements** — always use `?` or `@named` parameters, never string interpolation

## Schema Migrations

Use SQLite `user_version` pragma for schema versioning:

```typescript
const currentVersion = db.pragma('user_version', { simple: true }) as number;
if (currentVersion < SCHEMA_VERSION) {
  db.transaction(() => {
    if (currentVersion < 1) db.exec(SCHEMA_V1);
    if (currentVersion < 2) db.exec(SCHEMA_V2);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}
```

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

This pattern applies to `getResearchPost`, `addSource`, and `initResearchPost` (cross-phase collision guard).

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
