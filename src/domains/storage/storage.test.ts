import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../db";
import { DbStore } from "../touches";
import { DbFiles, DbSecrets, DiskFiles, EnvFileSecrets, safePath, secretKey, type Files } from ".";

describe("safePath", () => {
  test("keeps paths inside your folder", () => {
    expect(safePath("./prospects-a.csv")).toBe("prospects-a.csv");
    expect(safePath("messages\\email\\x.md")).toBe("messages/email/x.md");
    for (const bad of ["", "/etc/passwd", "../cold.yaml", "messages/../../x", "a//b", "C:/x"]) expect(() => safePath(bad)).toThrow("Not a path inside your folder");
  });
});

describe("files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cold-files-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const stores: Array<[string, () => Promise<Files>]> = [
    ["on disk", async () => new DiskFiles(dir)],
    ["in the database", async () => new DbFiles(await openDatabase(":memory:"))],
  ];
  for (const [where, make] of stores) {
    test(`read, write, list and remove ${where}`, async () => {
      const files = await make();
      expect(await files.read("cold.yaml")).toBeUndefined();
      await files.write("cold.yaml", "accounts: {}\n");
      await files.writeAll([
        ["messages/email/a.md", "A"],
        ["messages/email/deep/b.md", "B"],
        ["prospects-x.csv", "email\n"],
      ]);
      expect(await files.read("cold.yaml")).toBe("accounts: {}\n");
      expect(await files.list("")).toEqual(["cold.yaml", "prospects-x.csv"]);
      expect(await files.list("messages", { deep: true })).toEqual(["messages/email/a.md", "messages/email/deep/b.md"]);
      expect(await files.list("messages/email")).toEqual(["messages/email/a.md"]);
      expect([...(await files.readAll("messages"))]).toEqual([
        ["messages/email/a.md", "A"],
        ["messages/email/deep/b.md", "B"],
      ]);
      expect(await files.remove("prospects-x.csv")).toBe(true);
      expect(await files.remove("prospects-x.csv")).toBe(false);
      await expect(files.write("../escape.txt", "x")).rejects.toThrow("Not a path inside your folder");
    });
  }

  test("a change in the database moves data_version, so other servers drop their caches", async () => {
    const db = await openDatabase(":memory:");
    const files = new DbFiles(db);
    const version = async () => (await db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'data_version'"))?.value;
    await files.write("cold.yaml", "a");
    const first = await version();
    await files.write("cold.yaml", "b");
    expect(await version()).not.toBe(first);
  });
});

describe("secrets", () => {
  test("in the database: encrypted, applied to the environment, and taken back when removed", async () => {
    const db = await openDatabase(":memory:");
    const key = secretKey({ COLD_SECRET_KEY: "x".repeat(40) })!;
    const name = "COLD_TEST_SECRET";
    process.env[name] = "from the environment";
    try {
      await new DbSecrets(db, key).save({ [name]: "smtps://me:hunter2@smtp.example.com:465" });
      expect(process.env[name]).toBe("smtps://me:hunter2@smtp.example.com:465");
      expect(JSON.stringify(await db.all("SELECT * FROM secrets"))).not.toContain("hunter2");

      // Another server picks it up on its next request, and can read it only with the same key.
      const other = new DbSecrets(db, key);
      delete process.env[name];
      await other.refresh();
      expect(process.env[name]).toBe("smtps://me:hunter2@smtp.example.com:465");
      await expect(new DbSecrets(db, secretKey({ COLD_SECRET_KEY: "y".repeat(40) })).refresh()).rejects.toThrow();

      await other.save({ [name]: "" });
      expect(process.env[name]).toBeUndefined();
      expect(await db.all("SELECT * FROM secrets")).toEqual([]);
    } finally {
      delete process.env[name];
    }
  });

  test("without COLD_SECRET_KEY nothing is saved, and the reason says what to do", async () => {
    const db = await openDatabase(":memory:");
    await expect(new DbSecrets(db, undefined).save({ A: "b" })).rejects.toThrow("COLD_SECRET_KEY");
    expect(() => secretKey({ COLD_SECRET_KEY: "short" })).toThrow("too short");
  });

  test("on disk: written to .env.local, keeping the lines already there", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cold-env-"));
    try {
      const file = path.join(dir, ".env.local");
      const secrets = new EnvFileSecrets(file);
      await secrets.save({ COLD_TEST_A: "one", COLD_TEST_B: "has space" });
      await secrets.save({ COLD_TEST_A: "" });
      expect(readFileSync(file, "utf8")).toBe('COLD_TEST_B="has space"\n');
      expect(process.env.COLD_TEST_A).toBeUndefined();
    } finally {
      delete process.env.COLD_TEST_B;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the touch log in the database", () => {
  test("finds touches by prospect or address, suppressions, and since a time", async () => {
    const store = new DbStore(await openDatabase(":memory:"));
    await store.record({ kind: "SENT", channel: "EMAIL", account: "personal", prospectKey: "csv:1", toAddress: "Dana@Example.com", occurredAt: "2026-11-02T15:00:00.000Z" });
    await store.record({ kind: "OPTED_OUT", channel: "EMAIL", account: "personal", prospectKey: "twenty:person:9", toAddress: "dana@example.com", occurredAt: "2026-11-03T15:00:00.000Z" });
    await store.record({ kind: "SENT", channel: "LINKEDIN", account: "company", prospectKey: "csv:2", occurredAt: "2026-11-04T15:00:00.000Z" });

    expect((await store.forProspects(["csv:1"])).map((t) => t.kind)).toEqual(["SENT"]);
    // The opt-out was keyed to another identity, but went to the same address.
    expect((await store.forProspects(["csv:1", "email:dana@example.com"])).map((t) => t.kind)).toEqual(["SENT", "OPTED_OUT"]);
    expect((await store.suppressions()).map((t) => t.prospectKey)).toEqual(["twenty:person:9"]);
    expect((await store.since("2026-11-03T00:00:00.000Z")).length).toBe(2);
    expect((await store.since("2026-11-01T00:00:00.000Z", { account: "personal", kind: "SENT" })).map((t) => t.prospectKey)).toEqual(["csv:1"]);
    expect((await store.since("2026-11-01T00:00:00.000Z", { channel: "LINKEDIN" })).map((t) => t.prospectKey)).toEqual(["csv:2"]);
  });
});
