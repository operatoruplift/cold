import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { openDatabase } from "../db";
import type { MailTransport } from "../email";
import { createApi } from "../web/api";
import { callRoutes } from "../web/calls";
import { WebContext } from "../web/context";
import { leadRoutes } from "../web/leads";
import type { Campaign } from "../web/types";
import { createColdMcpServer } from ".";

const REPO = path.resolve(import.meta.dir, "../../..");
// Tuesday 3 November 2026, 10:00 in Chicago: inside the example accounts' sending windows.
const NOW = new Date("2026-11-03T16:00:00Z");
const saved = { url: process.env.TWENTY_BASE_URL, key: process.env.TWENTY_API_KEY };
let root: string;
let ctx: WebContext;
let api: (request: Request) => Promise<Response>;
const mailbox: unknown[] = [];
const transport: MailTransport = { verify: async () => true, sendMail: async (draft) => void mailbox.push(draft) };

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };

/** An MCP client on an in-memory pair, speaking JSON-RPC by hand. */
async function connect() {
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  await createColdMcpServer(api, "9.9.9").connect(serverSide);
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  client.onmessage = (message) => {
    const m = message as Record<string, unknown>;
    if (typeof m.id === "number" && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    }
  };
  await client.start();
  let id = 0;
  const rpc = (method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      void client.send({ jsonrpc: "2.0", id: n, method, params } as never);
    });
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" } as never);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).result as ToolResult;
  const text = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).content.map((c) => c.text).join("\n");
  return { init, rpc, call, text };
}

let mcp: Awaited<ReturnType<typeof connect>>;
let campaign: Campaign;

beforeAll(async () => {
  delete process.env.COLD_CONFIG;
  delete process.env.TWENTY_BASE_URL;
  delete process.env.TWENTY_API_KEY;
  root = mkdtempSync(path.join(tmpdir(), "cold-mcp-"));
  cpSync(path.join(REPO, "messages"), path.join(root, "messages"), { recursive: true });
  writeFileSync(path.join(root, "cold.yaml"), readFileSync(path.join(REPO, "cold.example.yaml"), "utf8").replace("store: auto", "store: file"));
  ctx = new WebContext({ root, db: await openDatabase(":memory:"), now: () => NOW, transport: () => transport, random: () => 0 });
  api = createApi(ctx, [...leadRoutes(ctx), ...callRoutes(ctx)]);
  const created = await api(
    new Request("http://cold.local/api/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Tint shops", sequence: "email/personal/founder-direct", account: "personal", source: "csv:examples/prospects.csv" }),
    }),
  );
  campaign = (await created.json()) as Campaign;
  mcp = await connect();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (saved.url !== undefined) process.env.TWENTY_BASE_URL = saved.url;
  if (saved.key !== undefined) process.env.TWENTY_API_KEY = saved.key;
});

describe("COLD's MCP server", () => {
  test("says who it is, how to behave, and lists every tool with its hints", async () => {
    const result = mcp.init.result as { serverInfo: { name: string; version: string }; instructions: string };
    expect(result.serverInfo).toEqual({ name: "cold-mcp-server", version: "9.9.9" });
    expect(result.instructions).toContain("confirm=true only after the owner has seen that preview");
    const { tools } = (await mcp.rpc("tools/list", {})).result as { tools: Array<{ name: string; title: string; description: string; annotations: Record<string, boolean> }> };
    expect(tools.map((t) => t.name)).toEqual([
      "cold_status",
      "cold_list_campaigns",
      "cold_campaign_plan",
      "cold_list_sources",
      "cold_list_prospects",
      "cold_recent_activity",
      "cold_stats",
      "cold_list_call_scripts",
      "cold_call_sheet",
      "cold_quiz_leads",
      "cold_log_calls",
      "cold_log_dm",
      "cold_send_emails",
      "cold_send_x_dm",
      "cold_send_status",
      "cold_stop_send",
    ]);
    for (const t of tools) expect(t.title && t.description && t.annotations).toBeTruthy();
    const readOnly = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
    expect(readOnly).not.toContain("cold_send_emails");
    expect(readOnly).toContain("cold_campaign_plan");
    expect(tools.find((t) => t.name === "cold_send_x_dm")!.annotations.openWorldHint).toBe(true);
  });

  test("status reads as Markdown, or as COLD's own JSON", async () => {
    const markdown = await mcp.text("cold_status");
    expect(markdown).toContain("## Accounts");
    expect(markdown).toContain("- personal (personal voice, Alex Morgan)");
    const json = await mcp.call("cold_status", { response_format: "json" });
    expect((json.structuredContent!.accounts as unknown[]).length).toBe(2);
    expect(JSON.parse(json.content[0]!.text).accounts).toEqual(json.structuredContent!.accounts);
  });

  test("campaigns, their plan for today, and pages of it", async () => {
    expect(await mcp.text("cold_list_campaigns")).toContain(`Tint shops (id ${campaign.id})`);
    const plan = await mcp.text("cold_campaign_plan", { campaign: campaign.id, limit: 2 });
    expect(plan).toContain("# Tint shops: email from personal");
    expect(plan).toContain("## Due now");
    expect(plan).toMatch(/1\. Dana Reyes \(Clearview Tint\) <dana@clearviewtint\.example>: step 1/);
    expect(plan).toContain("More: call again with offset=2.");
    const missing = await mcp.call("cold_campaign_plan", { campaign: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toBe("No such campaign.");
  });

  test("prospects, found by a word; arguments outside the schema are refused", async () => {
    const dana = await mcp.text("cold_list_prospects", { source: "csv:examples/prospects.csv", query: "clearview" });
    expect(dana).toContain("# csv:examples/prospects.csv: 1 prospect");
    expect(dana).toContain("Trigger: Saw you just opened a second bay in Round Rock.");
    const refused = await mcp.call("cold_list_prospects", { source: "csv:examples/prospects.csv", limit: 0 });
    expect(refused.isError).toBe(true);
  });

  test("a call sheet filled in for a prospect, with their local time", async () => {
    const sheet = await mcp.text("cold_call_sheet", { script: "call/personal/founder-direct", source: "csv:examples/prospects.csv", prospect: "dana" });
    expect(sheet).toContain("**A good time to call:** 10:00 AM CST their time (from their phone number).");
    expect(sheet).toContain("Hi Dana, it's Alex");
    expect(sheet).toContain("objection answers: call again with include_objections=true.");
    expect((await mcp.call("cold_call_sheet", { script: "call/personal/founder-direct", source: "csv:examples/prospects.csv" })).isError).toBe(true);
    expect(await mcp.text("cold_list_call_scripts")).toContain('id "call/personal/founder-direct"');
  });

  test("quiz leads say what's missing without Twenty; an email campaign has no X DM to send", async () => {
    expect(await mcp.text("cold_quiz_leads")).toContain("Twenty isn't connected");
    const x = await mcp.call("cold_send_x_dm", { campaign: campaign.id, prospect: "email:dana@clearviewtint.example" });
    expect(x.isError).toBe(true);
    expect(x.content[0]!.text).toBe("Only X DM campaigns send through X's API.");
  });

  test("emails are only previewed until confirm=true; then they go out, and can be stopped", async () => {
    const preview = await mcp.text("cold_send_emails", { campaign: campaign.id, limit: 2 });
    expect(preview).toStartWith("Preview only: nothing was sent. 2 emails would go out from Alex Morgan <alex@brightside.example>");
    expect(preview).toContain("Dana Reyes (Clearview Tint)");
    expect(mailbox).toHaveLength(0);

    const started = await mcp.text("cold_send_emails", { campaign: campaign.id, limit: 2, confirm: true });
    const job = /send ([\w-]+)\)/.exec(started)?.[1];
    expect(started).toStartWith("Sending 2 emails");
    expect(job).toBeTruthy();
    for (let i = 0; i < 100 && mailbox.length === 0; i++) await Bun.sleep(20);
    expect(mailbox).toHaveLength(1);
    expect(await mcp.text("cold_send_status", { job })).toContain("Sent 1, failed 0, skipped 0.");

    expect(await mcp.text("cold_stop_send", { job })).toBe(`Stopped send ${job}: nothing more of it goes out.`);
    let status = "";
    for (let i = 0; i < 100 && !status.includes("finished"); i++) {
      status = await mcp.text("cold_send_status", { job });
      if (!status.includes("finished")) await Bun.sleep(20);
    }
    expect(status).toContain(`# Send ${job}: finished`);
    expect(mailbox).toHaveLength(1);

    expect(await mcp.text("cold_recent_activity", { kinds: ["SENT"] })).toMatch(/sent email, Dana Reyes \(Clearview Tint\)/);
    expect(await mcp.text("cold_stats", { days: 7 })).toContain("Sent 1, replies 0");
  });
});
