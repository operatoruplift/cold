import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../../db";
import type { Touch } from "../../touches";
import type { XFetch } from "../../xApi";
import { createApi } from "../api";
import { WebContext } from "../context";
import type { ActionResponse, Campaign, PlanResponse, PlanRow, XSendResponse, XStatusResponse } from "../types";
import { xCallback, xRoutes } from ".";

const REPO = path.resolve(import.meta.dir, "../../../..");
const ORIGIN = "http://127.0.0.1:4100";
let now = new Date("2026-11-02T15:00:00Z");
let root: string;
let ctx: WebContext;
let api: (request: Request) => Promise<Response>;
let callback: (url: URL) => Promise<Response>;
const before = { id: process.env.X_CLIENT_ID, secret: process.env.X_CLIENT_SECRET };

type RawEvent = { id: string; text: string; sender_id: string; created_at: string; dm_conversation_id: string };

/** A fake X: who exists, whose inbox is closed, what was sent, and every conversation. The owner is user 999. */
const x = {
  users: new Map([
    ["clearviewtint", "101"],
    ["shinedetailco", "103"],
  ]),
  closed: new Set<string>(),
  sent: [] as Array<{ to: string; text: string }>,
  events: [] as RawEvent[],
  requests: [] as string[],
};

const fakeX: XFetch = async (url, init = {}) => {
  const u = new URL(url);
  const method = init.method ?? "GET";
  x.requests.push(`${method} ${u.pathname}`);
  const reply = (body: unknown, status = 200) => Response.json(body, { status });
  if (u.pathname === "/2/oauth2/token") return reply({ access_token: "at1", refresh_token: "rt1", expires_in: 7200, scope: "dm.read dm.write tweet.read users.read offline.access" });
  if (u.pathname === "/2/oauth2/revoke") return reply({ revoked: true });
  if (u.pathname === "/2/users/me") return reply({ data: { id: "999", username: "alexsells", name: "Alex" } });
  const byName = /^\/2\/users\/by\/username\/(.+)$/.exec(u.pathname);
  if (byName) {
    const id = x.users.get(decodeURIComponent(byName[1]!).toLowerCase());
    return id ? reply({ data: { id, username: byName[1] } }) : reply({ errors: [{ title: "Not Found Error" }] });
  }
  const send = /^\/2\/dm_conversations\/with\/(\d+)\/messages$/.exec(u.pathname);
  if (send && method === "POST") {
    if (x.closed.has(send[1]!)) return reply({ title: "Forbidden", detail: "You are not permitted to send Direct Messages to this user.", status: 403 }, 403);
    const text = (JSON.parse(String(init.body)) as { text: string }).text;
    x.sent.push({ to: send[1]!, text });
    const id = `ev${x.sent.length}`;
    x.events.push({ id, text, sender_id: "999", created_at: now.toISOString(), dm_conversation_id: `999-${send[1]}` });
    return reply({ data: { dm_event_id: id, dm_conversation_id: `999-${send[1]}` } }, 201);
  }
  const conversation = /^\/2\/dm_conversations\/with\/(\d+)\/dm_events$/.exec(u.pathname);
  if (conversation) return reply({ data: x.events.filter((e) => e.dm_conversation_id === `999-${conversation[1]}`).reverse(), meta: {} });
  if (u.pathname === "/2/dm_events") return reply({ data: [...x.events].reverse(), meta: {} });
  return reply({ title: "Not Found" }, 404);
};

async function call<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await api(new Request(`${ORIGIN}${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: response.status, data: (await response.json()) as T };
}

async function touchesOf(key: string): Promise<Touch[]> {
  return (await ctx.store(await ctx.requireConfig())).forProspects([key]);
}

beforeAll(async () => {
  delete process.env.COLD_CONFIG;
  process.env.X_CLIENT_ID = "app1";
  process.env.X_CLIENT_SECRET = "secret1";
  root = mkdtempSync(path.join(tmpdir(), "cold-x-"));
  cpSync(path.join(REPO, "messages"), path.join(root, "messages"), { recursive: true });
  cpSync(path.join(REPO, "examples"), path.join(root, "examples"), { recursive: true });
  writeFileSync(path.join(root, "cold.yaml"), readFileSync(path.join(REPO, "cold.example.yaml"), "utf8").replace("store: auto", "store: file"));
  ctx = new WebContext({ root, db: await openDatabase(":memory:"), xFetch: fakeX, now: () => now });
  api = createApi(ctx, xRoutes(ctx));
  callback = xCallback(ctx);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [name, value] of [
    ["X_CLIENT_ID", before.id],
    ["X_CLIENT_SECRET", before.secret],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("X DMs through X's API, one approved message per click", () => {
  let campaign: Campaign;
  let dana: PlanRow;
  let priya: PlanRow;

  test("Settings shows the app, the callback URL to register at developer.x.com, and the accounts to connect", async () => {
    const { data } = await call<XStatusResponse>("GET", "/api/x");
    expect(data).toMatchObject({ configured: true, available: true, callbackUrl: `${ORIGIN}/api/x/callback` });
    expect(data.accounts.map((a) => [a.key, a.username])).toEqual([
      ["personal", undefined],
      ["company", undefined],
    ]);
  });

  test("before X is connected the plan says how to send from here, and a send is refused in words with a 409, not a 401", async () => {
    campaign = (await call<Campaign>("POST", "/api/campaigns", { name: "X openers", sequence: "dm/personal/x", account: "personal", source: "csv:examples/prospects.csv" })).data;
    const { data: plan } = await call<PlanResponse>("GET", `/api/campaigns/${campaign.id}/plan`);
    expect(plan.x).toEqual({ ready: false, why: "Connect X for personal in Settings to send from here." });
    dana = plan.due.find((r) => r.label.includes("Dana"))!;
    priya = plan.due.find((r) => r.label.includes("Priya"))!;
    expect(dana && priya).toBeTruthy();
    const refused = await call<{ error: string }>("POST", `/api/campaigns/${campaign.id}/dm/x`, { prospect: dana.key });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toBe("Account personal is not connected to X: connect it in Settings.");
    expect(x.sent).toEqual([]);
  });

  test("Connect X sends the owner to X with a one-time state, and the callback keeps the sign-in", async () => {
    const { data } = await call<{ url: string }>("POST", "/api/x/connect", { account: "personal" });
    const url = new URL(data.url);
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/x/callback`);
    const page = await callback(new URL(`${ORIGIN}/api/x/callback?state=${url.searchParams.get("state")}&code=c1`));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("personal sends X DMs as @alexsells now");
    expect((await call<XStatusResponse>("GET", "/api/x")).data.accounts[0]).toMatchObject({ key: "personal", username: "alexsells" });
    const replay = await callback(new URL(`${ORIGIN}/api/x/callback?state=${url.searchParams.get("state")}&code=c1`));
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("press Connect X again");
  });

  test("Send on X posts one DM, the approved text, and logs it with X's message id; a second click sends nothing", async () => {
    const { data: plan } = await call<PlanResponse>("GET", `/api/campaigns/${campaign.id}/plan`);
    expect(plan.x).toEqual({ ready: true, username: "alexsells" });
    const { status, data } = await call<XSendResponse>("POST", `/api/campaigns/${campaign.id}/dm/x`, { prospect: dana.key });
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true, outcome: "SENT", message: "Sent on X to @clearviewtint." });
    expect(x.sent).toEqual([{ to: "101", text: dana.text! }]);
    expect(dana.text).toContain("second bay in Round Rock");
    expect(await touchesOf(dana.key)).toEqual([expect.objectContaining({ kind: "SENT", channel: "X", step: 1, messageId: "ev1", toAddress: "https://x.com/clearviewtint" })]);
    const again = await call<{ error: string }>("POST", `/api/campaigns/${campaign.id}/dm/x`, { prospect: dana.key });
    expect(again.status).toBe(409);
    expect(x.sent).toHaveLength(1);
  });

  test("a closed inbox is refused in words, nothing is held, and the step can be tried again", async () => {
    x.closed.add("103");
    const refused = await call<{ error: string }>("POST", `/api/campaigns/${campaign.id}/dm/x`, { prospect: priya.key });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toContain("their messages are closed to you");
    expect(await touchesOf(priya.key)).toEqual([]);
    x.closed.delete("103");
    const sent = await call<XSendResponse>("POST", `/api/campaigns/${campaign.id}/dm/x`, { prospect: priya.key });
    expect(sent.data.outcome).toBe("SENT");
    expect(x.sent.map((s) => s.to)).toEqual(["101", "103"]);
  });

  test("Check X DMs logs an answer to an earlier send, and stops that sequence", async () => {
    x.events.push({ id: "r2", text: "Not for us right now, thanks", sender_id: "103", created_at: new Date(now.getTime() + 60_000).toISOString(), dm_conversation_id: "999-103" });
    const { data } = await call<ActionResponse>("POST", "/api/x/replies", {});
    expect(data.message).toBe("1 new reply on X, logged: that sequence stops.");
    expect(data.lines).toEqual([expect.stringContaining("Not for us right now, thanks")]);
    expect((await touchesOf(priya.key)).find((t) => t.kind === "REPLIED")).toMatchObject({ channel: "X", messageId: "r2", step: 1 });
    expect((await call<ActionResponse>("POST", "/api/x/replies", {})).data.message).toBe("No new replies on X.");
  });

  test("on the follow-up's day, someone who answered since gets nothing: their reply is logged instead", async () => {
    x.events.push({ id: "r1", text: "Sounds good, send the video", sender_id: "101", created_at: "2026-11-03T09:00:00Z", dm_conversation_id: "999-101" });
    now = new Date("2026-11-09T15:00:00Z");
    const { data: plan } = await call<PlanResponse>("GET", `/api/campaigns/${campaign.id}/plan?refresh=1`);
    expect(plan.due.find((r) => r.key === dana.key)?.step).toBe(2);
    const { data } = await call<XSendResponse>("POST", `/api/campaigns/${campaign.id}/dm/x`, { prospect: dana.key });
    expect(data).toEqual({ ok: true, outcome: "REPLIED", message: `${dana.label} replied on X, so nothing was sent: the reply is logged and their sequence stops.` });
    expect(x.sent).toHaveLength(2);
    expect((await touchesOf(dana.key)).find((t) => t.kind === "REPLIED")).toMatchObject({ messageId: "r1", body: "Sounds good, send the video", step: 1 });
    const after = (await call<PlanResponse>("GET", `/api/campaigns/${campaign.id}/plan?refresh=1`)).data;
    expect(after.due.some((r) => r.key === dana.key)).toBe(false);
  });

  test("Disconnect forgets the sign-in and asks X to revoke it", async () => {
    const { data } = await call<ActionResponse>("POST", "/api/x/disconnect", { account: "personal" });
    expect(data.message).toBe("Disconnected @alexsells from personal. cold no longer sends or reads its DMs.");
    expect(x.requests).toContain("POST /2/oauth2/revoke");
    expect((await call<XStatusResponse>("GET", "/api/x")).data.accounts[0]!.username).toBeUndefined();
  });

  test("a sign-in the owner refused on X explains itself and keeps nothing", async () => {
    const { data } = await call<{ url: string }>("POST", "/api/x/connect", { account: "company" });
    const state = new URL(data.url).searchParams.get("state");
    const page = await callback(new URL(`${ORIGIN}/api/x/callback?error=access_denied&state=${state}`));
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("You didn&#39;t allow cold on X, so nothing changed.");
    expect((await call<XStatusResponse>("GET", "/api/x")).data.accounts.every((a) => !a.username)).toBe(true);
  });
});
