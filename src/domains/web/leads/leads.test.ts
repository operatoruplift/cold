import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../../db";
import { TwentyClient } from "../../twenty";
import { createApi } from "../api";
import { WebContext } from "../context";
import type { CallSheet } from "../../call";
import type { ActionResponse, LeadAlertsResponse, LeadsResponse, SourceOption } from "../types";
import { leadRoutes } from ".";

const REPO = path.resolve(import.meta.dir, "../../../..");
const ORIGIN = "http://127.0.0.1:4100";
const saved = { url: process.env.COLD_NTFY_URL, token: process.env.COLD_NTFY_TOKEN, twentyUrl: process.env.TWENTY_BASE_URL, twentyKey: process.env.TWENTY_API_KEY };
let root: string;
let ctx: WebContext;
let api: (request: Request) => Promise<Response>;
const pushed: Array<Record<string, unknown>> = [];

const note = (name: string) => `Name: ${name}\nEmail: —\nPhone: 512 555 0147\n\nQuiz answers: ${JSON.stringify({ "Cars a week": "10-20" }, null, 2)}`;
const leads = [
  { id: "sam", contactName: "Sam Lee", note: note("Sam Lee"), qualificationStatus: "QUALIFIED", createdAt: "2026-11-01T16:00:00.000Z" },
  { id: "ana", contactName: "Ana Ruiz", note: note("Ana Ruiz"), qualificationStatus: "QUALIFIED", createdAt: "2026-11-01T17:00:00.000Z" },
  { id: "dq", contactName: "Bo Diaz", note: note("Bo Diaz"), qualificationStatus: "DISQUALIFIED", createdAt: "2026-11-01T17:30:00.000Z" },
];
const twentyFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  return Response.json({ data: { [url.pathname.slice(6)]: url.pathname === "/rest/agencyLeads" ? leads : [] } });
}) as typeof fetch;
const ntfyFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  pushed.push(JSON.parse(String(init?.body)));
  return Response.json({ id: "m1" });
}) as typeof fetch;

async function call<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await api(new Request(`${ORIGIN}${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: response.status, data: (await response.json()) as T };
}

beforeAll(async () => {
  delete process.env.COLD_CONFIG;
  delete process.env.COLD_NTFY_URL;
  delete process.env.COLD_NTFY_TOKEN;
  root = mkdtempSync(path.join(tmpdir(), "cold-leads-"));
  cpSync(path.join(REPO, "messages"), path.join(root, "messages"), { recursive: true });
  writeFileSync(path.join(root, "cold.yaml"), readFileSync(path.join(REPO, "cold.example.yaml"), "utf8").replace("store: auto", "store: file"));
  ctx = new WebContext({
    root,
    db: await openDatabase(":memory:"),
    now: () => new Date("2026-11-01T18:00:00Z"),
    twenty: () => new TwentyClient({ baseUrl: "https://crm.example", apiKey: "k" }, twentyFetch),
    ntfyFetch,
  });
  api = createApi(ctx, leadRoutes(ctx));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [name, value] of [["COLD_NTFY_URL", saved.url], ["COLD_NTFY_TOKEN", saved.token]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("lead routes", () => {
  test("alerts say what is missing, without reading any leads", async () => {
    const off = await call<LeadAlertsResponse>("GET", "/api/leads/alerts");
    expect(off.data).toEqual({ twenty: true, alerts: { configured: false, problem: undefined, available: true, lookedAt: undefined, seenUntil: undefined } });
    process.env.COLD_NTFY_URL = "https://ntfy.sh/";
    expect((await call<LeadAlertsResponse>("GET", "/api/leads/alerts")).data.alerts.problem).toMatch(/topic's name/);
    process.env.COLD_NTFY_URL = "https://ntfy.sh/cold-leads-7f3k2q";
    expect((await call<LeadAlertsResponse>("GET", "/api/leads/alerts")).data.alerts.configured).toBe(true);
  });

  test("a test alert goes to the topic, and says so", async () => {
    delete process.env.COLD_NTFY_URL;
    expect((await call<{ error: string }>("POST", "/api/leads/test")).status).toBe(409);
    process.env.COLD_NTFY_URL = "https://ntfy.sh/cold-leads-7f3k2q";
    const sent = await call<ActionResponse>("POST", "/api/leads/test");
    expect(sent.status).toBe(200);
    expect(sent.data.message).toMatch(/Sent to cold-leads-7f3k2q/);
    expect(pushed.at(-1)).toMatchObject({ topic: "cold-leads-7f3k2q", title: "COLD lead alerts work" });
  });

  test("the Calls page's leads: the ones to call first on top, called ones after, with when", async () => {
    const config = await ctx.requireConfig();
    await (await ctx.store(config)).record({ kind: "CALLED", channel: "CALL", prospectKey: "agencyLeads:ana", occurredAt: "2026-11-01T17:45:00.000Z" });
    const { status, data } = await call<LeadsResponse>("GET", "/api/leads");
    expect(status).toBe(200);
    expect(data.twenty).toBe(true);
    expect(data.leads.map((l) => [l.id, l.qualified, l.calledAt])).toEqual([
      ["sam", true, undefined],
      ["ana", true, "2026-11-01T17:45:00.000Z"],
      ["dq", false, undefined],
    ]);
    expect(data.leads[0]).toMatchObject({ prospectKey: "agencyLeads:sam", phone: "512 555 0147", answers: ["Cars a week: 10-20"] });
  });

  test("each lead says whether it is a time to call them", async () => {
    const { data } = await call<LeadsResponse>("GET", "/api/leads");
    expect(data.leads[0]!.callTime).toMatchObject({ ok: true, local: "12:00 PM CST", zones: ["America/Chicago"], from: ["phone"] });
  });

  test("a call sheet for a lead is filled in for them, with their time", async () => {
    const sheet = await call<CallSheet>("GET", `/api/calls/sheet?${new URLSearchParams({ id: "call/personal/founder-direct", source: "twenty:agencyLeads", prospect: "agencyLeads:sam" })}`);
    expect(sheet.status).toBe(200);
    expect(sheet.data.sections[0]!.text).toStartWith("Hi Sam,");
    expect(sheet.data.callTime?.note).toBe("12:00 PM CST their time (from their phone number).");
    const plain = await call<CallSheet>("GET", "/api/calls/sheet?id=call/personal/founder-direct");
    expect(plain.data.callTime).toBeUndefined();
  });

  test("the leads are a prospect source, so a call script fills in for one", async () => {
    process.env.TWENTY_BASE_URL = "https://crm.example";
    process.env.TWENTY_API_KEY = "k";
    try {
      const all = createApi(ctx);
      const response = await all(new Request(`${ORIGIN}/api/sources`, { headers: { "content-type": "application/json" } }));
      const sources = (await response.json()) as SourceOption[];
      expect(sources.find((s) => s.id === "twenty:agencyLeads")?.label).toBe("Twenty: quiz leads from offer");
      const prospects = await ctx.prospects("twenty:agencyLeads");
      expect(prospects.map((p) => p.label)).toEqual(["Sam Lee", "Ana Ruiz", "Bo Diaz"]);
    } finally {
      if (saved.twentyUrl === undefined) delete process.env.TWENTY_BASE_URL;
      else process.env.TWENTY_BASE_URL = saved.twentyUrl;
      if (saved.twentyKey === undefined) delete process.env.TWENTY_API_KEY;
      else process.env.TWENTY_API_KEY = saved.twentyKey;
    }
  });
});
