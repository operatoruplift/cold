import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { openDatabase, type Db } from "../../db";
import { createVercelApp, databaseNote } from ".";

// What Vercel puts in a function's environment, plus the two secrets COLD needs there.
const ENV: Record<string, string> = {
  VERCEL: "1",
  VERCEL_PROJECT_PRODUCTION_URL: "coldthecompany.vercel.app",
  VERCEL_URL: "coldthecompany-abc123-operatoruplift.vercel.app",
  COLD_SECRET_KEY: "k".repeat(48),
  CRON_SECRET: "cron-test-secret",
};
const saved: Record<string, string | undefined> = {};
let db: Db;
let app: (request: Request) => Promise<Response>;
let cookie = "";

beforeAll(async () => {
  for (const [name, value] of Object.entries(ENV)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  delete process.env.COLD_PUBLIC_URL;
  const log = spyOn(console, "log").mockImplementation(() => {});
  db = await openDatabase(":memory:");
  app = await createVercelApp(db);
  log.mockRestore();
});

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function call(method: string, path: string, options: { body?: unknown; headers?: Record<string, string>; host?: string } = {}) {
  const host = options.host ?? "coldthecompany.vercel.app";
  return app(
    new Request(`https://${host}${path}`, {
      method,
      headers: {
        host,
        origin: `https://${host}`,
        "x-cold": "1",
        "x-forwarded-for": "203.0.113.9",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
}

describe("COLD as a Vercel function", () => {
  test("answers health checks, takes waitlist signups, and keeps the rest behind the login", async () => {
    expect((await call("GET", "/api/health", { headers: { "x-cold": "" } })).status).toBe(200);
    expect((await call("POST", "/api/waitlist", { body: { email: "dana@example.com", elapsedMs: 4000 } })).status).toBe(201);
    expect((await call("GET", "/api/status")).status).toBe(401);
    expect((await call("GET", "/api/health", { host: "evil.example" })).status).toBe(200);
    expect((await call("GET", "/api/session", { host: "evil.example" })).status).toBe(403);
    // A deployment's own address works too: that is where Vercel's cron and previews call.
    expect((await call("GET", "/api/session", { host: "coldthecompany-abc123-operatoruplift.vercel.app" })).status).toBe(200);
  });

  test("the login is created with the setup code from the logs, as a Secure cookie", async () => {
    const code = (await db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'setup_code'"))!.value;
    expect((await call("POST", "/api/session/setup", { body: { code: "WRONG-CODE-0000", email: "me@cold.dev", password: "correct horse battery" } })).status).toBe(403);
    const created = await call("POST", "/api/session/setup", { body: { code, email: "me@cold.dev", password: "correct horse battery" } });
    expect(created.status).toBe(201);
    expect(created.headers.get("set-cookie")).toContain("; Secure");
    cookie = created.headers.get("set-cookie")!.split(";")[0]!;
    expect(await db.get("SELECT value FROM meta WHERE key = 'setup_code'")).toBeUndefined();
  });

  test("the app's data lives in the database: files, the touch log, and keys encrypted", async () => {
    const status = (await (await call("GET", "/api/status")).json()) as { storage: string; isExample: boolean; store: { kind: string } };
    expect(status).toMatchObject({ storage: "database", isExample: true });
    expect((await call("POST", "/api/settings/init")).status).toBe(200);
    expect((await (await call("GET", "/api/status")).json()) as { isExample: boolean }).toMatchObject({ isExample: false });
    const saved = await call("PUT", "/api/settings/env", { body: { values: { ANTHROPIC_API_KEY: "sk-ant-test-only" } } });
    expect(((await saved.json()) as { message: string }).message).toContain("the database (encrypted)");
    expect(JSON.stringify(await db.all("SELECT * FROM secrets"))).not.toContain("sk-ant-test-only");
    const library = (await (await call("GET", "/api/library")).json()) as { sequences: unknown[] };
    expect(library.sequences.length).toBe(14);
    const waitlist = (await (await call("GET", "/api/waitlist")).json()) as { counts: { total: number } };
    expect(waitlist.counts.total).toBe(1);
    delete process.env.ANTHROPIC_API_KEY;
  });

  test("the cron route needs Vercel's secret", async () => {
    expect((await call("GET", "/api/cron/tick", { headers: { "x-cold": "" } })).status).toBe(401);
    expect((await call("GET", "/api/cron/tick", { headers: { "x-cold": "", authorization: "Bearer nope" } })).status).toBe(401);
    expect((await call("GET", "/api/cron/tick", { headers: { "x-cold": "", authorization: `Bearer ${ENV.CRON_SECRET}` } })).status).toBe(200);
  });

  test("sign-in limits are counted in the database, so every copy of the function shares them", async () => {
    const saved = cookie;
    cookie = "";
    for (let i = 0; i < 10; i++) expect((await call("POST", "/api/session/login", { body: { email: "me@cold.dev", password: "wrong password!" } })).status).toBe(401);
    expect((await call("POST", "/api/session/login", { body: { email: "me@cold.dev", password: "correct horse battery" } })).status).toBe(429);
    expect(await db.get("SELECT count FROM rate_limits WHERE key = 'login:203.0.113.9'")).toEqual({ count: 11 });
    cookie = saved;
  });

  test("the logs say which database a deployment is on, without saying where it is", async () => {
    const other = await openDatabase(":memory:");
    const where = { url: "libsql://cold-operatoruplift.aws-us-east-1.turso.io", from: "TURSO_DATABASE_URL" };
    const line = await databaseNote(other, where, () => new Date("2026-11-01T11:00:00Z"));
    expect(line).toMatch(/^Database [0-9a-f]{8} \(from TURSO_DATABASE_URL\), first used 2026-11-01T11:00:00.000Z\.$/);
    expect(line).not.toContain("turso.io");
    // The same database a day later: the same line.
    expect(await databaseNote(other, where, () => new Date("2026-11-02T09:00:00Z"))).toBe(line);
    // Another address: another fingerprint.
    const copy = await databaseNote(other, { ...where, url: "libsql://cold-copy-operatoruplift.aws-us-east-1.turso.io" });
    expect(copy.slice(0, 17)).not.toBe(line.slice(0, 17));
  });
});
