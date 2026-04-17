import Database from 'better-sqlite3';

import {
  SCHEMA_VERSION,
  SCHEMA_V1_SQL,
  SCHEMA_V2_SQL,
  SCHEMA_V3_SQL,
} from './schema.js';

export function getDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Enable WAL mode for concurrent read access
  db.pragma('journal_mode = WAL');

  // Enable foreign key enforcement (off by default in SQLite)
  db.pragma('foreign_keys = ON');

  // Check schema version and migrate if needed
  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  if (currentVersion < SCHEMA_VERSION) {
    migrate(db, currentVersion);
  }

  return db;
}

function migrate(db: Database.Database, fromVersion: number): void {
  // v3 uses the SQLite canonical transactional table-rebuild pattern for
  // pipeline_steps. PRAGMA foreign_keys cannot be changed from inside a
  // transaction, so we toggle it off BEFORE opening the transaction and
  // restore it in the finally block. The rebuild (rename -> create ->
  // INSERT..SELECT -> drop) still runs inside the transaction, giving us
  // all-or-nothing atomicity while also avoiding cascade behavior against
  // referencing columns during the interim rename state.
  const needsV3Rebuild = fromVersion < 3;
  if (needsV3Rebuild) {
    db.pragma('foreign_keys = OFF');
  }
  try {
    db.transaction(() => {
      if (fromVersion < 1) {
        db.exec(SCHEMA_V1_SQL);
      }
      if (fromVersion < 2) {
        db.exec(SCHEMA_V2_SQL);
      }
      if (fromVersion < 3) {
        db.exec(SCHEMA_V3_SQL);
      }

      // SQLite pragmas do not accept bound parameters. SCHEMA_VERSION is a
      // compile-time integer constant, so string interpolation here is safe.
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  } finally {
    if (needsV3Rebuild) {
      db.pragma('foreign_keys = ON');
    }
  }
}

export function closeDatabase(db: Database.Database): void {
  db.close();
}
