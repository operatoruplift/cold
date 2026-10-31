import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { DEFAULT_MODEL, type AiRun, type MessagesCall } from "../../ai";
import { openDatabase } from "../../db";
import { seeded, type Answer, type Decision, type DecisionProvider, type Dossier, type LongReader } from "../../decide";
import type { EmailDraft, MailTransport } from "../../email";
import { createApi } from "../api";
import { aiRoutes } from "../ai";
import { WebContext } from "../context";
import type { Campaign, DecideStatusResponse, InsightsResponse, JobResponse, PlanResponse, ProspectDecisionResponse, ScoresResponse } from "../types";
import { decideRoutes, websiteOf } from ".";

const REPO = path.resolve(import.meta.dir, "../../../..");
const MONDAY = new Date("2026-11-02T15:00:00Z");
const LIST = "csv:examples/prospects.csv";
let root: string;
let ctx: WebContext;
let api: (request: Request) => Promise<Response>;
const sent: EmailDraft[] = [];
const prompts: string[] = [];

/** Jev, faked: a strong yes for Clearview Tint, lukewarm for everyone else. */
const fakeJev: DecisionProvider = {
  name: "jev",
  model: "jev-test",
  async decide({ state, questions }) {
    const strong = (state as { prospect: { company?: string } }).prospect.company === "Clearview Tint";
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === "noul") answers[id] = { type: "noul", noul: strong ? 0.9 : 0.45 };
      else if (q.type === "score") answers[id] = { type: "score", score: strong ? 3 : 1, confidence: 0.8, probabilities: {} };
      else {
        const options = Object.keys(q.criteria);
        const choice = id === "tone" ? "conversational" : id === "action" ? (strong ? "contact_now" : "nurture") : id === "angle" && options.includes("trigger") ? "trigger" : options[0]!;
        answers[id] = { type: "choice", choice, confidence: 0.9, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? 0.85 : 0.15 / (options.length - 1)])) };
      }
    }
    return { answers, model: "jev-test", usage: { inputTokens: 800, outputTokens: 20, searches: 0, fetches: 0 } };
  },
};

/** SubQ, faked: reads the pages it is given and cites them. */
const fakeSubq: LongReader = {
  name: "subq",
  model: "subq-test",
  async chat({ prompt }) {
    prompts.push(prompt);
    return {
      text: JSON.stringify({
        summary: "A family-owned tint shop that just added a second bay.",
        offerings: ["Car tint"],
        needs: [{ need: "Missed calls while they work", evidence: "we call you back as soon as we can", source: "https://clearviewtint.example/", strength: "strong" }],
        triggers: [{ sentence: "Saw you just opened a second bay in Round Rock.", when: "October 2026", source: "https://clearviewtint.example/" }],
        tools: [],
        people: [{ name: "Dana Reyes", title: "Owner", source: "list" }],
        size: "Two bays",
        voice: "Warm and casual",
        risks: [],
        unknowns: ["Who picks up the phone today?"],
      }),
      model: "subq-test",
      usage: { inputTokens: 4000, outputTokens: 300, searches: 0, fetches: 0 },
    };
  },
};

const message = (content: unknown[], stop_reason: BetaMessage["stop_reason"] = "end_turn") =>
  ({ id: "m", type: "message", role: "assistant", model: DEFAULT_MODEL, content, stop_reason, stop_sequence: null, stop_details: null, usage: { input_tokens: 10, output_tokens: 5 } }) as unknown as BetaMessage;

/** Claude, faked: diligence when SubQ has nothing to read, and drafts. */
const fakeClaude: MessagesCall = async (params) => {
  const p = params as unknown as { tools?: Array<{ name: string }>; output_config?: { format?: { schema?: { required?: string[] } } }; messages: Array<{ content: unknown }> };
  if (p.tools?.some((t) => t.name === "submit_diligence"))
    return message([{ type: "tool_use", id: "t", name: "submit_diligence", input: { summary: "A window film installer.", offerings: [], needs: [], triggers: [], tools: [], people: [], size: null, voice: null, risks: [], unknowns: ["Do they install for homes?"] } }], "tool_use");
  if (p.output_config?.format?.schema?.required?.includes("personal_line")) {
    prompts.push(String(p.messages[0]!.content));
    return message([{ type: "text", text: JSON.stringify({ subject: "your second bay", body: "Hi Dana,\n\nSaw you just opened a second bay. Congrats!\n\nWorth a quick look?\n\nAlex", personal_line: null, changes: "Conversational, opened with the new bay." }) }]);
  }
  throw new Error("unexpected request");
};

const pages: Record<string, string> = {
  "https://clearviewtint.example/": "<html><head><title>Clearview Tint</title></head><body><p>Family-owned since 2014. Busy? We call you back as soon as we can.</p><a href='/about'>About us</a></body></html>",
  "https://clearviewtint.example/about": "<html><body><p>Dana started Clearview in a one-bay garage.</p></body></html>",
};

async function call<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await api(new Request(`http://127.0.0.1:4100${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: response.status, data: (await response.json()) as T };
}
async function finished<T>(runId: string): Promise<AiRun<T>> {
  for (let i = 0; i < 100; i++) {
    const { data } = await call<AiRun<T>>("GET", `/api/ai/runs/${runId}`);
    if (data.status !== "running") return data;
    await Bun.sleep(10);
  }
  throw new Error("the run never finished");
}
const keyOf = async (company: string) => {
  const { data } = await call<{ prospects: Array<{ key: string; company?: string }> }>("GET", `/api/prospects?source=${encodeURIComponent(LIST)}`);
  return data.prospects.find((p) => p.company === company)!.key;
};

beforeAll(async () => {
  delete process.env.COLD_CONFIG;
  root = mkdtempSync(path.join(tmpdir(), "cold-decide-"));
  cpSync(path.join(REPO, "messages"), path.join(root, "messages"), { recursive: true });
  cpSync(path.join(REPO, "examples"), path.join(root, "examples"), { recursive: true });
  const example = readFileSync(path.join(REPO, "cold.example.yaml"), "utf8");
  writeFileSync(path.join(root, "cold.yaml"), `${example.replace("store: auto", "store: file").replaceAll(/(min|max)_delay_seconds: \d+/g, "$1_delay_seconds: 0")}\ndecide:\n  explore: false\n`);
  process.env.SMTP_URL_PERSONAL = "smtp://unused";
  const transport: MailTransport = { verify: async () => true, sendMail: async (draft) => void sent.push(draft) };
  ctx = new WebContext({
    root,
    db: await openDatabase(":memory:"),
    aiCall: () => fakeClaude,
    decider: () => fakeJev,
    reader: () => fakeSubq,
    pages: {
      fetch: async (url) => (pages[url] ? new Response(pages[url], { headers: { "content-type": "text/html" } }) : new Response("missing", { status: 404 })),
      resolve: async () => ["93.184.216.34"],
    },
    transport: () => transport,
    now: () => MONDAY,
    random: seeded(5),
  });
  api = createApi(ctx, [...aiRoutes(ctx), ...decideRoutes(ctx)]);
});

afterAll(() => {
  delete process.env.SMTP_URL_PERSONAL;
  rmSync(root, { recursive: true, force: true });
});

describe("the decision engine, end to end", () => {
  test("status says who decides and who does diligence", async () => {
    const { data } = await call<DecideStatusResponse>("GET", "/api/decide/status");
    expect(data.decide).toEqual({ provider: "jev", model: "jev-test" });
    expect(data.diligence).toEqual({ provider: "subq", model: "subq-test" });
    expect(data.settings).toEqual({ provider: "auto", diligence: "auto", reviewBelow: 0.75, explore: false });
  });

  test("diligence reads the prospect's site and keeps what it can trace; a site that can't be read goes to Claude", async () => {
    const dana = await keyOf("Clearview Tint");
    const started = await call<{ runId: string }>("POST", "/api/decide/diligence", { source: LIST, prospect: dana });
    expect(started.status).toBe(202);
    const run = await finished<Dossier>(started.data.runId);
    expect(run.status).toBe("done");
    expect(run.output!.pages.map((p) => p.url)).toEqual(["https://clearviewtint.example/", "https://clearviewtint.example/about"]);
    expect(run.output!.needs).toEqual([{ need: "Missed calls while they work", evidence: "we call you back as soon as we can", source: "https://clearviewtint.example/", strength: "strong", confirmed: true }]);
    expect(prompts.at(-1)).toContain("Dana started Clearview in a one-bay garage.");

    const tom = await keyOf("Becker Window Films");
    const fallback = await finished<Dossier>((await call<{ runId: string }>("POST", "/api/decide/diligence", { source: LIST, prospect: tom })).data.runId);
    expect(fallback.output!.provider).toBe("claude");
    expect(fallback.output!.skipped[0]!.reason).toBe("The site answered 404.");
  });

  test("scoring ranks the list: each decision is saved per prospect and offer, with diligence behind it", async () => {
    for (const company of ["Clearview Tint", "Hill Country Auto Body"]) {
      const run = await finished<Decision>((await call<{ runId: string }>("POST", "/api/decide/score", { source: LIST, prospect: await keyOf(company) })).data.runId);
      expect(run.status).toBe("done");
    }
    const { data } = await call<ScoresResponse>("GET", `/api/decide/scores?source=${encodeURIComponent(LIST)}`);
    const dana = data.scores[await keyOf("Clearview Tint")]!;
    const marcus = data.scores[await keyOf("Hill Country Auto Body")]!;
    expect(dana).toMatchObject({ tier: "A", action: "contact_now", tone: "conversational", angle: "trigger", evidence: "diligence", need: "Missed calls while they work", review: false });
    expect(marcus).toMatchObject({ action: "nurture", evidence: "list", review: true });
    expect(dana.score).toBeGreaterThan(marcus.score);
    expect(Object.keys(data.diligence)).toContain(await keyOf("Clearview Tint"));
    const detail = (await call<ProspectDecisionResponse>("GET", `/api/decide/prospect?prospect=${encodeURIComponent(await keyOf("Clearview Tint"))}`)).data;
    expect(detail.decision!.factors.fit.value).toBe(0.9);
    expect(detail.dossier!.summary).toContain("second bay");
  });

  test("someone who asked not to be contacted isn't scored", async () => {
    const priya = await keyOf("Shine Detail Co");
    expect((await call("POST", "/api/ai/opt-out", { prospectKey: priya, prospectLabel: "Priya Shah", account: "personal" })).status).toBe(200);
    const refused = await call<{ error: string }>("POST", "/api/decide/score", { source: LIST, prospect: priya });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toContain("asked not to be contacted");
  });

  test("a campaign by score sends to the best first; the draft is written in their style, and a reply teaches the engine", async () => {
    const { data: campaign } = await call<Campaign>("POST", "/api/campaigns", { name: "Best first", sequence: "email/personal/founder-direct", account: "personal", offer: "booking-pages", source: LIST, order: "score" });
    expect(campaign.order).toBe("score");
    const { data: plan } = await call<PlanResponse>("GET", `/api/campaigns/${campaign.id}/plan`);
    expect(plan.due.map((r) => r.label.split(" ")[0])).toEqual(["Dana", "Marcus", "Elena"]);
    expect(plan.due[0]).toMatchObject({ tier: "A", action: "contact_now" });
    expect(plan.due[2]!.score).toBeUndefined();

    const dana = plan.due[0]!;
    const drafted = await finished<{ style: { tone: string; angle: string; pickedBy: string; why: string }; score: { tier: string } }>((await call<{ runId: string }>("POST", "/api/ai/draft", { campaignId: campaign.id, prospect: dana.key })).data.runId);
    expect(drafted.output!.style).toEqual({ tone: "conversational", angle: "trigger", pickedBy: "model", why: "Jev's pick for them: conversational, opening with what just happened." });
    expect(drafted.output!.score.tier).toBe("A");
    expect(prompts.at(-1)).toContain("<tone>conversational: Like a note from a peer");
    expect(prompts.at(-1)).toContain("<their_needs>- Missed calls while they work</their_needs>");

    const marcus = await finished<{ style: { tone: string; pickedBy: string } }>((await call<{ runId: string }>("POST", "/api/ai/draft", { campaignId: campaign.id, prospect: plan.due[1]!.key, tone: "formal" })).data.runId);
    expect(marcus.output!.style).toMatchObject({ tone: "formal", pickedBy: "you" });
    expect((await call("POST", "/api/ai/draft", { campaignId: campaign.id, prospect: dana.key, tone: "shouty" })).status).toBe(400);

    // Approve Dana's draft, send, and get a reply.
    expect((await call("PUT", "/api/ai/drafts", { campaignId: campaign.id, prospect: dana.key, step: 1, subject: "your second bay", body: "Hi Dana,\n\nSaw the second bay. Worth a look?\n\nAlex", status: "approved" })).status).toBe(200);
    const sending = await call<{ job: string }>("POST", `/api/campaigns/${campaign.id}/send`, { limit: 1 });
    expect(sending.status).toBe(202);
    let job: JobResponse | undefined;
    for (let i = 0; i < 100 && job?.status !== "done"; i++) {
      await Bun.sleep(10);
      job = (await call<JobResponse>("GET", `/api/jobs/${sending.data.job}`)).data;
    }
    expect(sent.map((d) => d.to)).toEqual(["dana@clearviewtint.example"]);
    const store = await ctx.store(await ctx.requireConfig());
    await store.record({ kind: "REPLIED", channel: "EMAIL", prospectKey: dana.key, sequence: "email/personal/founder-direct", step: 1, occurredAt: new Date(MONDAY.getTime() + 3600_000).toISOString(), messageId: "<reply-1@clearviewtint.example>" });

    const { data: insights } = await call<InsightsResponse>("GET", "/api/decide/insights?refresh=1");
    expect(insights.totals).toMatchObject({ written: 2, approved: 1, sent: 1, withResult: 1, wins: 1 });
    expect(insights.tone.find((t) => t.arm === "conversational")).toMatchObject({ n: 1, wins: 1, rate: 1 });
    expect(insights.tiers.find((t) => t.tier === "A")).toMatchObject({ n: 1, wins: 1 });
    expect(insights.pickedBy).toEqual([{ by: "model", n: 1, wins: 1, rate: 1 }]);
  });

  test("a website comes from the list, else a business email's domain, never a free mailbox's", () => {
    const p = (variables: Record<string, string>, email?: string) => ({ variables, email }) as Parameters<typeof websiteOf>[0];
    expect(websiteOf(p({ website: "clearview.example" }))).toBe("clearview.example");
    expect(websiteOf(p({}, "dana@clearview.example"))).toBe("https://clearview.example");
    expect(websiteOf(p({}, "dana.reyes@gmail.com"))).toBeUndefined();
  });
});
