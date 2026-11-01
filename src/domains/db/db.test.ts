import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client, InStatement, ResultSet } from "@libsql/client/web";
import { databaseFromEnv, libsqlDb, metaValue, migrate, openDatabase } from ".";

/**
 * A libSQL client that answers from a SQLite database in memory, shaped the
 * way @libsql/client answers over the network: rows that are arrays with
 * column names, rowsAffected, and transactional batches.
 */
function fakeLibsql(): Pick<Client, "execute" | "batch" | "close"> {
  const sqlite = new Database(":memory:", { strict: true });
  const execute = async (stmt: InStatement): Promise<ResultSet> => {
    const { sql, args = [] } = typeof stmt === "string" ? { sql: stmt } : stmt;
    const query = sqlite.query(sql);
    const params = args as Array<string | number | null>;
    if (query.columnNames.length) {
      const rows = query.values(...params);
      return { columns: query.columnNames, columnTypes: [], rows: rows as never, rowsAffected: 0, lastInsertRowid: undefined, toJSON: () => ({}) };
    }
    const result = query.run(...params);
    return { columns: [], columnTypes: [], rows: [], rowsAffected: result.changes, lastInsertRowid: BigInt(result.lastInsertRowid), toJSON: () => ({}) };
  };
  return {
    execute: execute as Client["execute"],
    batch: (async (stmts: InStatement[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const stmt of stmts) results.push(await execute(stmt));
        sqlite.exec("COMMIT");
        return results;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    }) as Client["batch"],
    close: () => sqlite.close(),
  };
}

describe("the database", () => {
  test("a new database gets every table, and migrating again changes nothing", async () => {
    const db = await openDatabase(":memory:");
    const tables = (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((t) => t.name);
    expect(tables).toEqual(["ai_drafts", "ai_runs", "decisions", "files", "meta", "owner", "rate_limits", "score_job_items", "score_jobs", "secrets", "send_events", "send_jobs", "sessions", "style_assignments", "touches", "waitlist"]);
    expect((await db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'"))?.value).toBe("5");
    await migrate(db);
    expect((await db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'"))?.value).toBe("5");
  });

  test("a file from before the version moved into meta keeps its data and gains the new tables", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cold-db-"));
    try {
      const file = path.join(dir, "cold.db");
      // What 0.3.0 left behind: two migrations, counted in PRAGMA user_version.
      const old = new Database(file, { create: true });
      old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE waitlist (id INTEGER PRIMARY KEY, email TEXT); CREATE TABLE ai_runs (id TEXT); INSERT INTO waitlist (email) VALUES ('dana@example.com'); PRAGMA user_version = 2;");
      old.close();
      const db = await openDatabase(file);
      expect(await db.get("SELECT email FROM waitlist")).toEqual({ email: "dana@example.com" });
      expect(await db.get("SELECT name FROM sqlite_master WHERE name = 'send_jobs'")).toEqual({ name: "send_jobs" });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the network driver turns libSQL rows into plain objects and runs batches together", async () => {
    const db = libsqlDb(fakeLibsql());
    await migrate(db);
    await db.run("INSERT INTO meta (key, value) VALUES (?, ?)", "a", "1");
    expect(await db.get("SELECT key, value FROM meta WHERE key = ?", "a")).toEqual({ key: "a", value: "1" });
    expect(await db.get("SELECT value FROM meta WHERE key = ?", "missing")).toBeUndefined();
    expect((await db.run("UPDATE meta SET value = ? WHERE key = ?", "2", "a")).changes).toBe(1);
    await expect(db.batch([["INSERT INTO meta (key, value) VALUES ('b', '1')"], ["INSERT INTO meta (key, value) VALUES ('a', 'duplicate')"]])).rejects.toThrow();
    // The failed batch left nothing behind.
    expect(await db.get("SELECT value FROM meta WHERE key = 'b'")).toBeUndefined();
    expect(await metaValue(db, "salt", () => "first")).toBe("first");
    expect(await metaValue(db, "salt", () => "second")).toBe("first");
  });

  test("finds the database in the environment the Turso integration sets", () => {
    expect(databaseFromEnv({})).toBeUndefined();
    expect(databaseFromEnv({ TURSO_DATABASE_URL: "libsql://cold.turso.io", TURSO_AUTH_TOKEN: "t" })).toEqual({ url: "libsql://cold.turso.io", authToken: "t", from: "TURSO_DATABASE_URL" });
    expect(databaseFromEnv({ COLD_DATABASE_URL: "libsql://mine", TURSO_DATABASE_URL: "libsql://other" })).toEqual({ url: "libsql://mine", authToken: undefined, from: "COLD_DATABASE_URL" });
    // A database pinned with COLD_DATABASE_URL takes its own token, never the integration's.
    expect(databaseFromEnv({ COLD_DATABASE_URL: "libsql://mine", COLD_DATABASE_TOKEN: "m", TURSO_DATABASE_URL: "libsql://other", TURSO_AUTH_TOKEN: "theirs" })).toEqual({ url: "libsql://mine", authToken: "m", from: "COLD_DATABASE_URL" });
    expect(databaseFromEnv({ COLD_DATABASE_URL: "libsql://mine", TURSO_AUTH_TOKEN: "theirs" })?.authToken).toBeUndefined();
    // A blank one is skipped, not taken as "no database".
    expect(databaseFromEnv({ COLD_DATABASE_URL: " ", TURSO_DATABASE_URL: "libsql://other" })?.from).toBe("TURSO_DATABASE_URL");
  });
});
