import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { AiError, askStructured, askWithResearch, DEFAULT_MODEL, draftMessage, researchProspect, type MessagesCall } from "../../ai";
import type { AiRun } from "../../ai/store";
import { openDatabase } from "../../db";
import type { EmailDraft, MailTransport } from "../../email";
import { createApi } from "../api";
import { WebContext } from "../context";
import type { Campaign, JobResponse, PlanResponse, ProspectSummary } from "../types";
import { aiRoutes } from ".";

type Params = Parameters<MessagesCall>[0];
type Block = BetaMessage["content"][number];

/** A finished message as the API returns it. */
function message(content: unknown[], stop_reason: BetaMessage["stop_reason"] = "end_turn", extra: Partial<BetaMessage> = {}): BetaMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: DEFAULT_MODEL,
    content: content as Block[],
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } },
    ...extra,
  } as unknown as BetaMessage;
}
const text = (t: string) => ({ type: "text", text: t, citations: null });
const searched = (...urls: string[]) => ({ type: "web_search_tool_result", tool_use_id: "srv_1", content: urls.map((url) => ({ type: "web_search_result", url, title: url, encrypted_content: "x", page_age: null })) });
const submit = (name: string, input: unknown) => ({ type: "tool_use", id: "toolu_1", name, input });

describe("asking Claude", () => {
  test("a structured answer: schema, effort, fallback and cached instructions are all sent", async () => {
    let sent: Params | undefined;
    const call: MessagesCall = async (params) => {
      sent = params;
      return message([{ type: "thinking", thinking: "", signature: "s" }, text('{"answer":42}')]);
    };
    const result = await askStructured<{ answer: number }>({ call, system: "Be brief.", prompt: "What is it?", schema: { type: "object" }, effort: "low" });
    expect(result.output).toEqual({ answer: 42 });
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 50, searches: 1 });
    const p = sent as unknown as Record<string, unknown>;
    expect(p.model).toBe(DEFAULT_MODEL);
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(p.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema: { type: "object" } } });
    expect((p.system as Array<{ cache_control: unknown }>)[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(p).not.toHaveProperty("thinking");
    expect(p).not.toHaveProperty("temperature");
  });

  test("refusals and cut-off answers become plain errors", async () => {
    const refused: MessagesCall = async () => message([], "refusal", { stop_details: { type: "refusal", category: "cyber", explanation: null } } as Partial<BetaMessage>);
    await expect(askStructured({ call: refused, system: "s", prompt: "p", schema: {} })).rejects.toThrow("declined this request (cyber)");
    const cut: MessagesCall = async () => message([text('{"a":')], "max_tokens");
    await expect(askStructured({ call: cut, system: "s", prompt: "p", schema: {} })).rejects.toBeInstanceOf(AiError);
  });

  test("research resumes a paused turn and returns what the submit tool was given, with the pages seen", async () => {
    const calls: Params[] = [];
    const call: MessagesCall = async (params) => {
      calls.push(params);
      if (calls.length === 1) return message([searched("https://ortizautoglass.example/news")], "pause_turn");
      return message([text("Found it."), submit("submit_x", { ok: true })], "tool_use");
    };
    const result = await askWithResearch<{ ok: boolean }>({ call, system: "s", prompt: "p", submit: { name: "submit_x", description: "d", schema: { type: "object" } } });
    expect(result.output).toEqual({ ok: true });
    expect(result.seen.map((s) => s.url)).toEqual(["https://ortizautoglass.example/news"]);
    expect(calls).toHaveLength(2);
    // The paused turn is sent back as it came, so the server can carry on.
    expect((calls[1] as unknown as { messages: Array<{ role: string }> }).messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const tools = (calls[0] as unknown as { tools: Array<{ type?: string; name: string; strict?: boolean }> }).tools;
    expect(tools.map((t) => t.type ?? t.name)).toEqual(["web_search_20260209", "web_fetch_20260209", "submit_x"]);
    expect(tools[2]!.strict).toBe(true);
  });

  test("a trigger from a page Claude never opened is dropped", async () => {
    const call: MessagesCall = async () =>
      message([
        searched("https://ortizautoglass.example/about"),
        submit("submit_research", {
          summary: "An auto glass shop in Pflugerville.",
          triggers: [
            { sentence: "Saw you added mobile windshield repair.", when: "Sep 2026", source: "https://ortizautoglass.example/services" },
            { sentence: "Saw you won Best of Austin.", when: null, source: "https://made-up.example/awards" },
          ],
          best_trigger: "Saw you won Best of Austin.",
          talking_points: ["Mobile jobs mean more calls to book."],
          watch_outs: [],
          fit: "strong",
          fit_reason: "Small, owner-run, busy phones.",
        }),
      ]);
    const { output } = await researchProspect({ call, offer: {}, prospect: { company: "Ortiz Auto Glass" } });
    expect(output.triggers.map((t) => t.sentence)).toEqual(["Saw you added mobile windshield repair."]);
    expect(output.best_trigger).toBe("Saw you added mobile windshield repair.");
  });

  test("a draft with a leftover variable or over the limit is refused", async () => {
    const answer = (body: string): MessagesCall => async () => message([text(JSON.stringify({ subject: "s", body, personal_line: null, changes: "c" }))]);
    const base = { channel: "dm" as const, sender: { voice: "personal" as const }, offer: {}, prospect: {}, template: { body: "Hi" } };
    await expect(draftMessage({ ...base, call: answer("Hi {{first_name}}") })).rejects.toThrow("unfilled");
    await expect(draftMessage({ ...base, call: answer("x".repeat(250)), maxChars: 200 })).rejects.toThrow("over the 200 limit");
    const ok = await draftMessage({ ...base, call: answer("Hi Dana") });
    expect(ok.output.subject).toBeNull();
  });
});

/* ------------------------------------------------------------------ the routes, end to end */

const REPO = path.resolve(import.meta.dir, "../../../..");
const MONDAY = new Date("2026-11-02T15:00:00Z");
let root: string;
let api: (request: Request) => Promise<Response>;
const sent: EmailDraft[] = [];

/** Claude, faked: answers each kind of request the way the real one would. */
const fakeClaude: MessagesCall = async (params) => {
  const p = params as unknown as { tools?: Array<{ name: string }>; output_config?: { format?: { schema?: { required?: string[] } } }; messages: Array<{ content: unknown }> };
  const tool = p.tools?.find((t) => t.name.startsWith("submit_"))?.name;
  if (tool === "submit_prospects")
    return message([
      searched("https://lonestarglass.example/", "https://hillcountrydetail.example/jobs"),
      submit("submit_prospects", {
        searched_for: "Auto glass and detailing shops in Austin.",
        prospects: [
          { company: "Lone Star Glass", website: "https://lonestarglass.example", city: "Austin, TX", contact_name: "Rosa Diaz", contact_title: "Owner", email: "hello@lonestarglass.example", phone: "+1 512 555 0101", linkedin_url: null, instagram_handle: null, facebook_url: null, trigger: "Saw you just opened a second shop on Burnet Rd.", trigger_date: "October 2026", fit: "Owner-run, phones busy.", sources: ["https://lonestarglass.example/"] },
          { company: "Hill Country Detail", website: "https://hillcountrydetail.example", city: "Austin, TX", contact_name: null, contact_title: null, email: null, phone: null, linkedin_url: null, instagram_handle: "hcdetail", facebook_url: null, trigger: null, trigger_date: null, fit: "Hiring a front desk.", sources: ["https://hillcountrydetail.example/jobs", "https://invented.example/x"] },
        ],
      }),
    ]);
  const required = p.output_config?.format?.schema?.required ?? [];
  if (required.includes("personal_line"))
    return message([text(JSON.stringify({ subject: "your new shop", body: "Hi Dana,\n\nSaw you just opened a second bay in Round Rock. Congrats.\n\nWorth a quick look?\n\nAlex", personal_line: "Saw you just opened a second bay in Round Rock.", changes: "Opened with the new bay." }))]);
  if (required.includes("intent")) return message([text(JSON.stringify({ intent: "unsubscribe", summary: "Wants off the list.", next_step: "Record the opt-out.", follow_up_when: null, draft_reply: null }))]);
  throw new Error("unexpected request");
};

async function call<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await api(new Request(`http://127.0.0.1:4100${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: response.status, data: (await response.json()) as T };
}
async function finished<T>(runId: string): Promise<AiRun<T>> {
  for (let i = 0; i < 50; i++) {
    const { data } = await call<AiRun<T>>("GET", `/api/ai/runs/${runId}`);
    if (data.status !== "running") return data;
    await Bun.sleep(10);
  }
  throw new Error("the run never finished");
}

beforeAll(() => {
  delete process.env.COLD_CONFIG;
  root = mkdtempSync(path.join(tmpdir(), "cold-ai-"));
  cpSync(path.join(REPO, "messages"), path.join(root, "messages"), { recursive: true });
  cpSync(path.join(REPO, "examples"), path.join(root, "examples"), { recursive: true });
  const example = readFileSync(path.join(REPO, "cold.example.yaml"), "utf8");
  writeFileSync(path.join(root, "cold.yaml"), example.replace("store: auto", "store: file").replaceAll(/(min|max)_delay_seconds: \d+/g, "$1_delay_seconds: 0"));
  process.env.SMTP_URL_PERSONAL = "smtp://unused";
  const transport: MailTransport = { verify: async () => true, sendMail: async (draft) => void sent.push(draft) };
  const ctx = new WebContext({ root, messagesDir: path.join(root, "messages"), db: openDatabase(":memory:"), aiCall: () => fakeClaude, transport: () => transport, now: () => MONDAY });
  api = createApi(ctx, aiRoutes(ctx));
});

afterAll(() => {
  delete process.env.SMTP_URL_PERSONAL;
  rmSync(root, { recursive: true, force: true });
});

describe("the AI routes", () => {
  test("find prospects in the background, keep only sources Claude opened, save them as a list", async () => {
    const started = await call<{ runId: string }>("POST", "/api/ai/find", { area: "Austin, TX", count: 5 });
    expect(started.status).toBe(202);
    const run = await finished<{ prospects: Array<{ company: string; verified_sources: string[] }> }>(started.data.runId);
    expect(run.status).toBe("done");
    expect(run.output!.prospects[1]!.verified_sources).toEqual(["https://hillcountrydetail.example/jobs"]);

    const saved = await call<{ source: string; added: number }>("POST", "/api/ai/prospects/save", { runId: started.data.runId, picks: [0, 1], list: "Austin glass" });
    expect(saved.data).toMatchObject({ source: "csv:prospects-austin-glass.csv", added: 2 });
    const again = await call<{ added: number; skipped: number }>("POST", "/api/ai/prospects/save", { runId: started.data.runId, picks: [0], list: "Austin glass" });
    expect(again.data).toMatchObject({ added: 0, skipped: 1 });

    const list = await call<{ prospects: ProspectSummary[] }>("GET", `/api/prospects?source=${encodeURIComponent(saved.data.source)}`);
    expect(list.data.prospects.map((p) => p.label)).toEqual(["Rosa Diaz (Lone Star Glass)", "Hill Country Detail"]);
    expect(list.data.prospects[0]!.trigger).toBe("Saw you just opened a second shop on Burnet Rd.");

    // A trigger is saved into your own list, and never into the bundled example or a path outside your folder.
    const hill = list.data.prospects[1]!;
    const applied = await call<{ message: string }>("POST", "/api/ai/research/apply", { source: saved.data.source, prospect: hill.key, trigger: "Saw you're hiring a front-desk lead." });
    expect(applied.status).toBe(200);
    const after = await call<{ prospects: ProspectSummary[] }>("GET", `/api/prospects?source=${encodeURIComponent(saved.data.source)}&refresh=1`);
    expect(after.data.prospects[1]!.trigger).toBe("Saw you're hiring a front-desk lead.");
    const example = await call<{ prospects: ProspectSummary[] }>("GET", "/api/prospects?source=csv:examples/prospects.csv");
    const refused = await call<{ error: string }>("POST", "/api/ai/research/apply", { source: "csv:examples/prospects.csv", prospect: example.data.prospects[0]!.key, trigger: "Saw it." });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toContain("your own lists");
    expect((await call("POST", "/api/ai/research", { source: "file:/etc/passwd", prospect: "x" })).status).toBe(400);
  });

  test("an approved draft is what goes out; a plain draft is not", async () => {
    const { data: campaign } = await call<Campaign>("POST", "/api/campaigns", { name: "Austin tint", sequence: "email/personal/founder-direct", account: "personal", offer: "booking-pages", source: "csv:examples/prospects.csv" });
    const { data: plan } = await call<PlanResponse>("GET", `/api/campaigns/${campaign.id}/plan`);
    const dana = plan.due.find((r) => r.label.startsWith("Dana"))!;

    const drafted = await call<{ draft: { status: string; body: string } }>("POST", "/api/ai/draft", { campaignId: campaign.id, prospect: dana.key });
    expect(drafted.status).toBe(200);
    expect(drafted.data.draft.status).toBe("draft");
    let after = (await call<PlanResponse>("GET", `/api/campaigns/${campaign.id}/plan`)).data;
    expect(after.due.find((r) => r.key === dana.key)!.custom).toBe(false);

    const edited = "Hi Dana,\n\nSaw the second bay in Round Rock. Congrats.\n\nWorth a look?\n\nAlex";
    expect((await call("PUT", "/api/ai/drafts", { campaignId: campaign.id, prospect: dana.key, step: 1, subject: "{{oops}}", body: edited, status: "approved" })).status).toBe(400);
    expect((await call("PUT", "/api/ai/drafts", { campaignId: campaign.id, prospect: dana.key, step: 1, subject: "your second bay", body: edited, status: "approved" })).status).toBe(200);
    after = (await call<PlanResponse>("GET", `/api/campaigns/${campaign.id}/plan`)).data;
    const row = after.due.find((r) => r.key === dana.key)!;
    expect(row.custom).toBe(true);
    expect(row.subject).toBe("your second bay");
    expect(row.text).toStartWith(edited);
    // COLD's footer, with the postal address and opt-out, still follows your words.
    expect(row.text).toContain("123 Example St");

    const started = await call<{ job: string }>("POST", `/api/campaigns/${campaign.id}/send`, { limit: 5 });
    let job: JobResponse | undefined;
    for (let i = 0; i < 100 && job?.status !== "done"; i++) {
      await Bun.sleep(10);
      job = (await call<JobResponse>("GET", `/api/jobs/${started.data.job}`)).data;
    }
    const toDana = sent.find((d) => d.to.startsWith("dana@"))!;
    expect(toDana.subject).toBe("your second bay");
    expect(toDana.text).toStartWith(edited);
  });

  test("a reply that asks to stop: read, and the opt-out recorded keeps them out of every campaign", async () => {
    const read = await call<{ output: { intent: string } }>("POST", "/api/ai/triage", { messageId: "<r1@example>", prospectKey: "email:priya@shinedetail.example", body: "Please remove me from your list." });
    expect(read.data.output.intent).toBe("unsubscribe");
    expect((await call<Record<string, { intent: string }>>("GET", "/api/ai/triage?ids=%3Cr1%40example%3E")).data["<r1@example>"]!.intent).toBe("unsubscribe");

    expect((await call("POST", "/api/ai/opt-out", { prospectKey: "email:priya@shinedetail.example", prospectLabel: "Priya Shah", account: "personal" })).status).toBe(200);
    const { data: campaign } = await call<Campaign>("POST", "/api/campaigns", { name: "LinkedIn", sequence: "dm/personal/linkedin", account: "personal", source: "csv:examples/prospects.csv" });
    const { data: plan } = await call<PlanResponse>("GET", `/api/campaigns/${campaign.id}/plan`);
    expect(plan.due.some((r) => r.label.startsWith("Priya"))).toBe(false);
    expect(plan.skipped.find((r) => r.label.startsWith("Priya"))?.reason).toMatch(/opted out/i);
  });

  test("without an API key, the AI routes say how to add one", async () => {
    const ctx = new WebContext({ root, messagesDir: path.join(root, "messages"), db: openDatabase(":memory:"), now: () => MONDAY });
    const bare = createApi(ctx, aiRoutes(ctx));
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const response = await bare(new Request("http://127.0.0.1:4100/api/ai/find", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ area: "Austin" }) }));
      expect(((await response.json()) as { error: string }).error).toContain("ANTHROPIC_API_KEY");
    } finally {
      if (saved) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
