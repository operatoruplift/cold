import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase, type Db } from "../../db";
import type { EmailDraft, MailTransport } from "../../email";
import { seedMessagesInto } from "../../messages";
import { DbFiles, DbSecrets, type Files } from "../../storage";
import { WebContext } from "../context";
import type { Campaign, JobResponse, LibraryResponse, PlanResponse, PreviewResponse, StatusResponse } from "../types";
import { createApi } from ".";

const REPO = path.resolve(import.meta.dir, "../../../..");
// Monday 2 November 2026, 09:00 in Chicago: inside the example's sending window.
const MONDAY = new Date("2026-11-02T15:00:00Z");
const CONFIG = readFileSync(path.join(REPO, "cold.example.yaml"), "utf8").replace("store: auto", "store: file").replaceAll(/(min|max)_delay_seconds: \d+/g, "$1_delay_seconds: 0");

// The same API twice: with your files in a folder (bun run ui), and in the
// database (Vercel, where a function has no disk that lasts).
for (const storage of ["disk", "database"] as const) {
  let root: string;
  let db: Db;
  let files: Files;
  let api: (request: Request) => Promise<Response>;
  const sent: EmailDraft[] = [];

  beforeAll(async () => {
    delete process.env.COLD_CONFIG;
    const transport: MailTransport = { verify: async () => true, sendMail: async (draft) => void sent.push(draft) };
    db = await openDatabase(":memory:");
    let ctx: WebContext;
    if (storage === "disk") {
      root = mkdtempSync(path.join(tmpdir(), "cold-web-"));
      cpSync(path.join(REPO, "messages"), path.join(root, "messages"), { recursive: true });
      cpSync(path.join(REPO, "examples"), path.join(root, "examples"), { recursive: true });
      writeFileSync(path.join(root, "cold.yaml"), CONFIG);
      ctx = new WebContext({ root, db, transport: () => transport, now: () => MONDAY });
      files = ctx.files;
    } else {
      files = new DbFiles(db);
      await seedMessagesInto(files);
      await files.write("cold.yaml", CONFIG);
      ctx = new WebContext({ files, secrets: new DbSecrets(db, Buffer.alloc(32, 7)), db, transport: () => transport, now: () => MONDAY });
    }
    api = createApi(ctx);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function call<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
    const response = await api(new Request(`http://127.0.0.1:4100${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: response.status, data: (await response.json()) as T };
  }

  describe(`the app's API, files on ${storage}`, () => {
    test("status describes the config, accounts and the touch log", async () => {
      const { data } = await call<StatusResponse>("GET", "/api/status");
      expect(data.isExample).toBe(false);
      expect(data.storage).toBe(storage);
      expect(data.configFile).toBe(storage === "disk" ? "cold.yaml" : "cold.yaml (in the database)");
      expect(data.accounts.map((a) => [a.key, a.voice, a.email?.smtpSet])).toEqual([
        ["personal", "personal", false],
        ["company", "company", false],
      ]);
      expect(data.store).toEqual(storage === "disk" ? { kind: "file", where: expect.stringContaining("touches.jsonl") } : { kind: "database", where: "the database" });
    });

    test("library lists every sequence and call script", async () => {
      const { data } = await call<LibraryResponse>("GET", "/api/library");
      expect(data.sequences.length).toBe(14);
      expect(data.callScripts.length).toBe(7);
      expect(data.issues).toEqual([]);
    });

    test("a campaign must use an account in its own voice", async () => {
      const bad = await call<{ error: string }>("POST", "/api/campaigns", { name: "x", sequence: "email/company/problem-proof", account: "personal", source: "csv:examples/prospects.csv" });
      expect(bad.status).toBe(400);
      expect(bad.data.error).toContain("company voice");
    });

    test("an email campaign: plan, send through a job, and the plan moves on", async () => {
      const created = await call<Campaign>("POST", "/api/campaigns", { name: "Austin tint", sequence: "email/personal/founder-direct", account: "personal", offer: "booking-pages", source: "csv:examples/prospects.csv" });
      expect(created.status).toBe(201);
      const id = created.data.id;

      const { data: plan } = await call<PlanResponse>("GET", `/api/campaigns/${id}/plan`);
      expect(plan.channel).toBe("email");
      expect(plan.due.length).toBe(4);
      expect(plan.held.map((h) => [h.label, h.reason])).toEqual([["Tom Becker (Becker Window Films)", "missing {{trigger}}"]]);
      expect(plan.due[0]!.subject).toMatch(/about Clearview Tint$/);
      expect(plan.due[0]!.text).toContain("123 Example St");
      expect(plan.window).toEqual({ open: true, text: "mon-thu 08:00-17:00 America/Chicago" });

      const started = await call<{ job: string; total: number }>("POST", `/api/campaigns/${id}/send`, {});
      expect(started.status).toBe(202);
      let job: JobResponse;
      for (;;) {
        job = (await call<JobResponse>("GET", `/api/jobs/${started.data.job}`)).data;
        if (job.status === "done") break;
        await Bun.sleep(10);
      }
      expect(job.result).toMatchObject({ sent: 4, failed: 0 });
      expect(job.events.filter((e) => e.type === "sent").length).toBe(4);
      expect(sent.length).toBe(4);

      const { data: after } = await call<PlanResponse>("GET", `/api/campaigns/${id}/plan`);
      expect(after.due.length).toBe(0);
      expect(after.waiting.length).toBe(4);
      expect(after.sentToday).toBe(4);

      const again = await call<{ error: string }>("POST", `/api/campaigns/${id}/send`, {});
      expect(again.status).toBe(409);
    });

    test("a DM campaign: log outcomes from the queue", async () => {
      const { data: campaign } = await call<Campaign>("POST", "/api/campaigns", { name: "LinkedIn", sequence: "dm/personal/linkedin", account: "personal", source: "csv:examples/prospects.csv" });
      const { data: plan } = await call<PlanResponse>("GET", `/api/campaigns/${campaign.id}/plan`);
      expect(plan.channel).toBe("dm");
      expect(plan.platform).toBe("linkedin");
      expect(plan.due.length).toBe(4);
      expect(plan.due[0]!.url).toBe("https://www.linkedin.com/in/dana-reyes-example");

      expect((await call("POST", `/api/campaigns/${campaign.id}/dm`, { prospect: plan.due[0]!.key, outcome: "SENT" })).status).toBe(200);
      expect((await call("POST", `/api/campaigns/${campaign.id}/dm`, { prospect: plan.due[1]!.key, outcome: "OPTED_OUT" })).status).toBe(200);
      const twice = await call<{ error: string }>("POST", `/api/campaigns/${campaign.id}/dm`, { prospect: plan.due[0]!.key, outcome: "SENT" });
      expect(twice.status).toBe(409);

      const { data: after } = await call<PlanResponse>("GET", `/api/campaigns/${campaign.id}/plan`);
      expect(after.due.length).toBe(2);
      expect(after.skipped.map((s) => s.reason)).toContain("opted out");
    });

    test("previews a message with example values or a real prospect", async () => {
      const example = await call<PreviewResponse>("POST", "/api/preview", { id: "email/personal/founder-direct/1-first-touch" });
      expect(example.data.body).toContain("Hi Dana,");
      expect(example.data.footer).toContain("123 Example St");
      const real = await call<PreviewResponse>("POST", "/api/preview", { id: "dm/personal/x/1-opener", source: "csv:examples/prospects.csv", prospect: "Shine Detail" });
      expect(real.data.body).toStartWith("Hey Priya,");
      const sheet = await call<PreviewResponse>("POST", "/api/preview", { id: "call/company/gatekeeper" });
      expect(sheet.data.sheet!.sections[0]!.heading).toBe("Opener");
    });

    test("an edit is saved only when it passes lint", async () => {
      const id = "email/personal/founder-direct/2-bump";
      const { data: original } = await call<{ source: string }>("GET", `/api/messages?id=${id}`);
      const broken = await call<{ issues: Array<{ rule: string }> }>("PUT", "/api/messages", { id, source: original.source.replace("{{offer}}", "{{ofer}}") });
      expect(broken.status).toBe(422);
      expect(broken.data.issues.map((i) => i.rule)).toContain("unknown-variable");
      const fixed = await call("PUT", "/api/messages", { id, source: original.source.replace("floating this back up", "bringing this back up") });
      expect(fixed.status).toBe(200);
      expect(await files.read(`messages/${id}.md`)).toContain("bringing this back up");
      const escape = await call("PUT", "/api/messages", { id: "../../cold", source: "x" });
      expect(escape.status).toBe(400);
    });

    test("a CSV upload becomes a prospect list", async () => {
      const { data } = await call<{ source: string; rows: number }>("POST", "/api/sources/csv", { name: "Denver Detailers.csv", content: "first_name,email,company\nSam,sam@x.example,X Detail\n" });
      expect(data).toMatchObject({ source: "csv:prospects-denver-detailers.csv", rows: 1 });
      expect(await files.read("prospects-denver-detailers.csv")).toContain("sam@x.example");
      const { data: sources } = await call<Array<{ id: string }>>("GET", "/api/sources");
      expect(sources.map((s) => s.id)).toEqual(["csv:prospects-denver-detailers.csv", "csv:examples/prospects.csv"]);
      const { data: listed } = await call<{ total: number }>("GET", "/api/prospects?source=csv:prospects-denver-detailers.csv");
      expect(listed.total).toBe(1);
    });

    test("settings: a bad cold.yaml is refused; secrets are saved and used straight away", async () => {
      const bad = await call<{ errors: string[] }>("PUT", "/api/settings/config", { yaml: "accounts:\n  me:\n    voice: solo\n" });
      expect(bad.status).toBe(422);
      expect(bad.data.errors.some((e) => e.includes("voice"))).toBe(true);
      const before = process.env.SMTP_URL_PERSONAL;
      try {
        const ok = await call("PUT", "/api/settings/env", { values: { SMTP_URL_PERSONAL: "smtp://127.0.0.1:2525" } });
        expect(ok.status).toBe(200);
        expect(process.env.SMTP_URL_PERSONAL).toBe("smtp://127.0.0.1:2525");
        if (storage === "disk") expect(readFileSync(path.join(root, ".env.local"), "utf8")).toContain("SMTP_URL_PERSONAL=smtp://127.0.0.1:2525");
        // In the database the value is encrypted: the password never sits there in the clear.
        else expect(JSON.stringify(await db.all("SELECT * FROM secrets"))).not.toContain("127.0.0.1:2525");
        const notAllowed = await call("PUT", "/api/settings/env", { values: { PATH: "/tmp" } });
        expect(notAllowed.status).toBe(400);
      } finally {
        if (before === undefined) delete process.env.SMTP_URL_PERSONAL;
        else process.env.SMTP_URL_PERSONAL = before;
      }
    });
  });
}
