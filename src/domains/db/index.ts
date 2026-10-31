import { Database as Sqlite } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Client, ResultSet } from "@libsql/client/web";

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Statement = [sql: string, ...params: SqlValue[]];

/**
 * The app's database: a SQLite file on your computer, Turso (SQLite over the
 * network) on Vercel. Every call is async so either can sit behind it; the
 * SQL is the same.
 */
export interface Db {
  get<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
  all<T>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  run(sql: string, ...params: SqlValue[]): Promise<{ changes: number }>;
  /** Several writes that succeed or fail together. */
  batch(statements: Statement[]): Promise<void>;
  close(): void;
}

class SqliteDb implements Db {
  constructor(private readonly sqlite: Sqlite) {}

  async get<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
    return (this.sqlite.query(sql).get(...params) as T | null) ?? undefined;
  }

  async all<T>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    return this.sqlite.query(sql).all(...params) as T[];
  }

  async run(sql: string, ...params: SqlValue[]): Promise<{ changes: number }> {
    return { changes: this.sqlite.query(sql).run(...params).changes };
  }

  async batch(statements: Statement[]): Promise<void> {
    this.sqlite.transaction(() => {
      for (const [sql, ...params] of statements) this.sqlite.query(sql).run(...params);
    })();
  }

  close(): void {
    this.sqlite.close();
  }
}

class LibsqlDb implements Db {
  constructor(private readonly client: Pick<Client, "execute" | "batch" | "close">) {}

  /** libSQL rows answer to an index and a name; the app wants plain objects. */
  private rows<T>(result: ResultSet): T[] {
    return result.rows.map((row) => Object.fromEntries(result.columns.map((column, i) => [column, row[i]])) as T);
  }

  async get<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
    return this.rows<T>(await this.client.execute({ sql, args: params }))[0];
  }

  async all<T>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    return this.rows<T>(await this.client.execute({ sql, args: params }));
  }

  async run(sql: string, ...params: SqlValue[]): Promise<{ changes: number }> {
    return { changes: (await this.client.execute({ sql, args: params })).rowsAffected };
  }

  async batch(statements: Statement[]): Promise<void> {
    await this.client.batch(
      statements.map(([sql, ...args]) => ({ sql, args })),
      "write",
    );
  }

  close(): void {
    this.client.close();
  }
}

/**
 * Each entry upgrades the schema by one version, recorded as schema_version
 * in meta (databases from before that kept it in PRAGMA user_version). Only
 * ever append: a released step never changes.
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
  // Everything a server without a disk keeps here instead: your files, the
  // touch log, saved keys, rate limits, and email sends that outlive a restart.
  `CREATE TABLE files (path TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE touches (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     channel TEXT NOT NULL,
     account TEXT,
     prospect_key TEXT NOT NULL,
     to_address TEXT,
     occurred_at TEXT NOT NULL,
     data TEXT NOT NULL
   );
   CREATE INDEX touches_prospect ON touches (prospect_key);
   CREATE INDEX touches_address ON touches (to_address);
   CREATE INDEX touches_when ON touches (occurred_at);
   CREATE INDEX touches_kind ON touches (kind);
   CREATE TABLE secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
   CREATE TABLE send_jobs (
     id TEXT PRIMARY KEY,
     lane TEXT NOT NULL,
     status TEXT NOT NULL,
     plan TEXT NOT NULL,
     state TEXT NOT NULL,
     next_at TEXT NOT NULL,
     lease_until TEXT,
     stop_requested INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX send_jobs_due ON send_jobs (status, next_at);
   CREATE TABLE send_events (
     job_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     at TEXT NOT NULL,
     event TEXT NOT NULL,
     PRIMARY KEY (job_id, seq)
   );`,
];

const statements = (script: string): Statement[] =>
  script
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((sql) => [sql]);

async function schemaVersion(db: Db): Promise<number> {
  if (!(await db.get("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'meta'"))) return 0;
  const row = await db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
  if (row) return Number(row.value) || 0;
  const legacy = await db.get<{ user_version: number }>("PRAGMA user_version").catch(() => undefined);
  return legacy?.user_version ?? 0;
}

/** Bring the schema up to date. Safe when two servers start at once: the loser looks again. */
export async function migrate(db: Db): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const version = await schemaVersion(db);
    if (version >= MIGRATIONS.length) return;
    try {
      await db.batch([
        ...statements(MIGRATIONS[version]!),
        ["INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", String(version + 1)],
      ]);
    } catch (err) {
      if (attempt >= 3 || (await schemaVersion(db)) <= version) throw err;
    }
  }
}

/** Open (or create) the app's SQLite file and bring its schema up to date. */
export async function openDatabase(file: string): Promise<Db> {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Sqlite(file, { create: true, strict: true });
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const db = new SqliteDb(sqlite);
  await migrate(db);
  return db;
}

/** Connect to Turso (or any libSQL server) over HTTP and bring its schema up to date. */
export async function connectDatabase(options: { url: string; authToken?: string }): Promise<Db> {
  const { createClient } = await import("@libsql/client/web");
  const db = new LibsqlDb(createClient({ url: options.url, authToken: options.authToken }));
  await migrate(db);
  return db;
}

/** A libSQL-shaped client, for tests that check the network driver without a network. */
export function libsqlDb(client: Pick<Client, "execute" | "batch" | "close">): Db {
  return new LibsqlDb(client);
}

/**
 * Where the database is, from the environment: COLD_DATABASE_URL, or what the
 * Turso integration sets (TURSO_DATABASE_URL, or LIBSQL_URL), with its token.
 */
export function databaseFromEnv(env: Record<string, string | undefined> = process.env): { url: string; authToken?: string } | undefined {
  const url = (env.COLD_DATABASE_URL ?? env.TURSO_DATABASE_URL ?? env.LIBSQL_URL)?.trim();
  if (!url) return undefined;
  const authToken = (env.COLD_DATABASE_TOKEN ?? env.TURSO_AUTH_TOKEN ?? env.LIBSQL_AUTH_TOKEN)?.trim() || undefined;
  return { url, authToken };
}

/** A value stored once and kept: the first call makes it, later calls read it. */
export async function metaValue(db: Db, key: string, make: () => string): Promise<string> {
  const found = await db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key);
  if (found) return found.value;
  await db.run("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", key, make());
  return (await db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key))!.value;
}
