---
paths:
  - "src/core/db/**"
  - "src/core/migrate/**"
  - "tests/db.test.ts"
  - "tests/import.test.ts"
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
- Pipeline steps: `UNIQUE(post_slug, step_name)` constraint
- Always check before creating external resources

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
