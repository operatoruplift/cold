import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../../db";
import { TwentyClient } from "../../twenty";
import { createApi } from "../api";
import { WebContext } from "../context";
import { leadRoutes } from "../leads";
import type { ActionResponse, LeadsResponse } from "../types";
import { callRoutes } from ".";

const REPO = path.resolve(import.meta.dir, "../../../..");
const ORIGIN = "http://127.0.0.1:4100";
let root: string;
let ctx: WebContext;
let api: (request: Request) => Promise<Response>;
let clock = new Date("2026-11-02T18:00:00Z");

const leads = [{ id: "sam", contactName: "Sam Lee", note: "Name: Sam Lee\nEmail: —\nPhone: 512 555 0147", qualificationStatus: "QUALIFIED", createdAt: "2026-11-02T15:00:00.000Z" }];
const calls = [
  { id: "c1", disposition: "APPOINTMENT_SET", status: "COMPLETED", direction: "OUTBOUND", toNumber: "+15125550147", startedAt: "2026-11-02T16:00:00.000Z", endedAt: "2026-11-02T16:06:00.000Z", aiAnalyzedAt: "2026-11-02T16:07:00.000Z", aiScore: 90, aiSummary: "Booked a demo for Tuesday.", agencyLeadId: "sam", createdAt: "2026-11-02T16:00:00.000Z" },
];
const twentyFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const plural = url.pathname.slice(6);
  return Response.json({ data: { [plural]: plural === "agencyCalls" ? calls : plural === "agencyLeads" ? leads : [] } });
}) as typeof fetch;

async function call<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await api(new Request(`${ORIGIN}${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: response.status, data: (await response.json()) as T };
}

beforeAll(async () => {
  delete process.env.COLD_CONFIG;
  root = mkdtempSync(path.join(tmpdir(), "cold-calls-"));
  cpSync(path.join(REPO, "messages"), path.join(root, "messages"), { recursive: true });
  writeFileSync(path.join(root, "cold.yaml"), readFileSync(path.join(REPO, "cold.example.yaml"), "utf8").replace("store: auto", "store: file"));
  ctx = new WebContext({ root, db: await openDatabase(":memory:"), now: () => clock, twenty: () => new TwentyClient({ baseUrl: "https://crm.example", apiKey: "k" }, twentyFetch) });
  api = createApi(ctx, [...callRoutes(ctx), ...leadRoutes(ctx)]);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("logging the dialer's calls", () => {
  test("a dry run says what it would log, and writes nothing", async () => {
    const { status, data } = await call<ActionResponse>("POST", "/api/calls/log", { dryRun: true });
    expect(status).toBe(200);
    expect(data.message).toBe("1 call from the dialer would be logged.");
    expect((await call<LeadsResponse>("GET", "/api/leads")).data.leads[0]!.calledAt).toBeUndefined();
  });

  test("by hand: logged once, never twice at once, and the quiz lead shows as called", async () => {
    const { status, data } = await call<ActionResponse>("POST", "/api/calls/log", {});
    expect(status).toBe(200);
    expect(data.message).toBe("Logged 1 call from the dialer.");
    expect(data.lines).toEqual(["2026-11-02 16:00  Sam Lee: Appointment set, AI score 90"]);
    expect((await call<{ error: string }>("POST", "/api/calls/log", {})).status).toBe(409);
    const lead = (await call<LeadsResponse>("GET", "/api/leads")).data.leads[0]!;
    expect(lead.calledAt).toBe("2026-11-02T16:00:00.000Z");
    expect(lead.callOutcome).toBe("Appointment set");
  });

  test("in the background every ten minutes, across servers, and never the same call twice", async () => {
    expect(await ctx.callLog!.tick()).toBeUndefined();
    clock = new Date(clock.getTime() + 11 * 60_000);
    const sync = await ctx.callLog!.tick();
    expect(sync).toMatchObject({ logged: [], known: 1 });
    clock = new Date(clock.getTime() + 60_000);
    expect(await ctx.callLog!.tick()).toBeUndefined();
  });
});
