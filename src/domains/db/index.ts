import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Each entry upgrades the schema by one version; PRAGMA user_version records
 * how far a database has come. Only ever append: a released step never changes.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE owner (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     email TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     user_agent TEXT,
     ip TEXT
   );
   CREATE TABLE waitlist (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     email TEXT NOT NULL UNIQUE COLLATE NOCASE,
     name TEXT,
     company TEXT,
     role TEXT,
     channels TEXT,
     note TEXT,
     source TEXT,
     referrer TEXT,
     ip_hash TEXT,
     user_agent TEXT,
     status TEXT NOT NULL DEFAULT 'waiting',
     owner_note TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX waitlist_created ON waitlist (created_at);`,
  `CREATE TABLE ai_runs (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     subject TEXT,
     status TEXT NOT NULL,
     input TEXT NOT NULL,
     output TEXT,
     error TEXT,
     model TEXT,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     searches INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     finished_at TEXT
   );
   CREATE INDEX ai_runs_kind ON ai_runs (kind, created_at);
   CREATE TABLE ai_drafts (
     campaign_id TEXT NOT NULL,
     prospect_key TEXT NOT NULL,
     step INTEGER NOT NULL,
     subject TEXT,
     body TEXT NOT NULL,
     status TEXT NOT NULL,
     run_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (campaign_id, prospect_key, step)
   );`,
];

/** Open (or create) the app's SQLite file and bring its schema up to date. */
export function openDatabase(file: string): Database {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const { user_version: version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
  for (let next = version; next < MIGRATIONS.length; next++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[next]!);
      db.exec(`PRAGMA user_version = ${next + 1}`);
    })();
  }
}

/** A value stored once and kept: the first call makes it, later calls read it. */
export function metaValue(db: Database, key: string, make: () => string): string {
  const found = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
  if (found) return found.value;
  const value = make();
  db.query("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  return db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)!.value;
}

export type { Database };
