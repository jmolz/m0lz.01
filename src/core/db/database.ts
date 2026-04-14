import Database from 'better-sqlite3';

import { SCHEMA_VERSION, SCHEMA_V1_SQL, SCHEMA_V2_SQL } from './schema.js';

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
  db.transaction(() => {
    if (fromVersion < 1) {
      db.exec(SCHEMA_V1_SQL);
    }
    if (fromVersion < 2) {
      db.exec(SCHEMA_V2_SQL);
    }

    // SQLite pragmas do not accept bound parameters. SCHEMA_VERSION is a
    // compile-time integer constant, so string interpolation here is safe.
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

export function closeDatabase(db: Database.Database): void {
  db.close();
}
