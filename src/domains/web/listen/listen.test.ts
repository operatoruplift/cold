import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../../db";
import { createApi } from "../api";
import { WebContext } from "../context";
import type { Campaign, ListenStatusResponse, PlanResponse, ProspectSummary, SourceOption } from "../types";
import { listenRoutes, listenWebhook } from ".";

const REPO = path.resolve(import.meta.dir, "../../../..");
const ORIGIN = "http://127.0.0.1:4100";
let root: string;
let ctx: WebContext;
let api: (request: Request) => Promise<Response>;
let webhook: (request: Request) => Promise<Response>;
const before = process.env.COLD_LISTEN_SECRET;

const delivery = {
  watch: { id: "01JWATCH", name: "Needs booking software" },
  action_id: "01JACTION",
  delivery: "digest",
  items: [
    { key: "reddit_subreddit:t3_abc", source: { label: "r/smallbusiness", kind: "reddit_subreddit" }, item: { occurred_at: "2026-11-02T14:10:00Z", title: "Any booking tool for a two-person detailing shop?", permalink: "/r/smallbusiness/comments/abc/x/", author: "shinyhands", subreddit: "smallbusiness" } },
    { key: "twitter_search:1850", source: { label: "X search", kind: "twitter_search" }, item: { occurred_at: "2026-11-02T14:20:00Z", content: "Is there a booking page that turns Google reviews into appointments?", url: "https://x.com/clearviewtint/status/1850", author: "Dana Reyes", handle: "clearviewtint" } },
  ],
};

const post = (body: unknown, headers: Record<string, string> = {}) =>
  webhook(new Request(`${ORIGIN}/api/listen/magpie`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));

async function call<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await api(new Request(`${ORIGIN}${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: response.status, data: (await response.json()) as T };
}

beforeAll(async () => {
  delete process.env.COLD_CONFIG;
  root = mkdtempSync(path.join(tmpdir(), "cold-listen-"));
  cpSync(path.join(REPO, "messages"), path.join(root, "messages"), { recursive: true });
  writeFileSync(path.join(root, "cold.yaml"), readFileSync(path.join(REPO, "cold.example.yaml"), "utf8").replace("store: auto", "store: file"));
  ctx = new WebContext({ root, db: await openDatabase(":memory:"), now: () => new Date("2026-11-02T15:00:00Z") });
  api = createApi(ctx, listenRoutes(ctx));
  webhook = listenWebhook(ctx);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (before === undefined) delete process.env.COLD_LISTEN_SECRET;
  else process.env.COLD_LISTEN_SECRET = before;
});

describe("OpenMagpie's webhook", () => {
  test("until COLD_LISTEN_SECRET is set, it says how to set it up", async () => {
    delete process.env.COLD_LISTEN_SECRET;
    const response = await post(delivery, { authorization: "Bearer anything" });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain("set COLD_LISTEN_SECRET");
  });

  test("a missing or wrong secret is refused and nothing is kept", async () => {
    process.env.COLD_LISTEN_SECRET = "a-long-listening-secret";
    expect((await post(delivery)).status).toBe(401);
    expect((await post(delivery, { authorization: "Bearer wrong" })).status).toBe(401);
    expect(await ctx.listening!.items()).toEqual([]);
  });

  test("a delivery is kept, and the same delivery again adds nothing", async () => {
    const auth = { authorization: "Bearer a-long-listening-secret" };
    const first = await post(delivery, auth);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, received: 2, added: 2 });
    expect(await (await post(delivery, auth)).json()).toEqual({ ok: true, received: 2, added: 0 });
    expect((await post("not json", auth)).status).toBe(400);
    expect((await post({ hello: "world" }, auth)).status).toBe(400);
  });
});

describe("matches as prospects", () => {
  test("Settings shows where to point OpenMagpie, and the watches that delivered", async () => {
    const { data } = await call<ListenStatusResponse>("GET", "/api/listen");
    expect(data).toMatchObject({ configured: true, available: true, webhookUrl: `${ORIGIN}/api/listen/magpie` });
    expect(data.watches).toEqual([{ id: "01JWATCH", name: "Needs booking software", count: 2, latest: "2026-11-02T15:00:00.000Z" }]);
  });

  test("each watch is a prospect list, with the post as the trigger line", async () => {
    const { data: sources } = await call<SourceOption[]>("GET", "/api/sources");
    expect(sources.filter((s) => s.kind === "listen")).toEqual([{ id: "listen:01JWATCH", label: "Listening: Needs booking software (2 matches)", kind: "listen" }]);
    const { data } = await call<{ prospects: ProspectSummary[] }>("GET", "/api/prospects?source=listen:01JWATCH");
    expect(data.prospects.map((p) => [p.label, p.trigger])).toEqual([
      ["Dana Reyes @clearviewtint on X", 'Saw your post on X: "Is there a booking page that turns Google reviews into appointments?".'],
      ["u/shinyhands on r/smallbusiness", 'Saw your post in r/smallbusiness: "Any booking tool for a two-person detailing shop?".'],
    ]);
  });

  test("a campaign runs on it like any list: the X poster waits for their company, the Reddit one has no channel", async () => {
    const { status, data: campaign } = await call<Campaign>("POST", "/api/campaigns", { name: "Booking askers", sequence: "dm/personal/x", account: "personal", source: "listen:01JWATCH" });
    expect(status).toBe(201);
    const { data: plan } = await call<PlanResponse>("GET", `/api/campaigns/${campaign.id}/plan`);
    expect(plan.due).toEqual([]);
    expect(plan.held.map((r) => [r.label, r.reason])).toEqual([["Dana Reyes @clearviewtint on X", "missing {{company}}"]]);
    expect(plan.skipped.map((r) => [r.label, r.reason])).toEqual([["u/shinyhands on r/smallbusiness", "no x profile"]]);
  });

  test("saved as a list, a match can be filled in, and saving again only adds what is new", async () => {
    const { data } = await call<{ source: string; added: number; rows: number; message: string }>("POST", "/api/listen/export", { watch: "01JWATCH" });
    expect(data).toMatchObject({ source: "csv:prospects-listen-needs-booking-software-01jwatch.csv", added: 2, rows: 2 });
    const file = path.join(root, "prospects-listen-needs-booking-software-01jwatch.csv");
    const text = readFileSync(file, "utf8");
    expect(text.split("\n")[0]).toBe("id,first_name,full_name,company,email,website,x_handle,trigger,post_url,post_title,post_text,posted_at,listen_source,listen_watch");
    writeFileSync(file, text.replace("twitter_search:1850,Dana,Dana Reyes,,", "twitter_search:1850,Dana,Dana Reyes,Clearview Tint,"));
    expect((await call<{ added: number; rows: number }>("POST", "/api/listen/export", { watch: "01JWATCH" })).data).toMatchObject({ added: 0, rows: 2 });
    expect(readFileSync(file, "utf8")).toContain("Clearview Tint");
    const { data: campaign } = await call<Campaign>("POST", "/api/campaigns", { name: "Booking askers, filled in", sequence: "dm/personal/x", account: "personal", source: data.source });
    const { data: plan } = await call<PlanResponse>("GET", `/api/campaigns/${campaign.id}/plan?refresh=1`);
    expect(plan.due.map((r) => r.key)).toEqual(["x:clearviewtint"]);
    expect(plan.due[0]!.text).toContain('Saw your post on X: "Is there a booking page that turns Google reviews into appointments?".');
    expect(plan.due[0]!.text).toContain("for Clearview Tint?");
  });

  test("two watches with the same name keep a list each", async () => {
    const twin = { ...delivery, watch: { id: "01JTWIN", name: "Needs booking software" }, items: [{ key: "hackernews:991", source: { label: "Hacker News", kind: "hackernews" }, item: { occurred_at: "2026-11-02T14:40:00Z", title: "Ask HN: booking software for a small shop?", url: "https://news.ycombinator.com/item?id=991", author: "pg_fan" } }] };
    expect((await post(twin, { authorization: "Bearer a-long-listening-secret" })).status).toBe(200);
    const { data } = await call<{ source: string; added: number; rows: number }>("POST", "/api/listen/export", { watch: "01JTWIN" });
    expect(data).toMatchObject({ source: "csv:prospects-listen-needs-booking-software-01jtwin.csv", added: 1, rows: 1 });
    expect(readFileSync(path.join(root, "prospects-listen-needs-booking-software-01jwatch.csv"), "utf8")).not.toContain("hackernews:991");
  });
});
