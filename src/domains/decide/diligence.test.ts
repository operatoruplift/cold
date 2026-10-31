import { describe, expect, test } from "bun:test";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { DEFAULT_MODEL, type MessagesCall } from "../ai";
import type { Touch } from "../touches";
import { diligenceWithClaude, diligenceWithSubq, historyLines, type DiligenceInput } from "./diligence";
import { extractJson, subqReader, type LongReader } from "./subq";
import type { Fetch } from "./types";

const input: DiligenceInput = {
  offer: { audience: "owner-run auto shops", offer: "an AI receptionist that answers every call", pain: "missed calls" },
  prospect: { name: "Dana Reyes (Clearview Tint)", company: "Clearview Tint", title: "Owner", notes: "Calls go to voicemail at lunch" },
  history: [{ kind: "SENT", channel: "EMAIL", step: 1, sequence: "email/personal/founder-direct", prospectKey: "csv:1", occurredAt: "2026-10-02T15:00:00Z" } as Touch],
  pages: [
    { url: "https://clearview.example/", title: "Clearview Tint", text: "Family-owned since 2014.\nNow with a second bay in Round Rock.\nCall us: we answer when we can!" },
    { url: "https://clearview.example/careers", title: "Careers", text: "We're hiring a front desk coordinator to answer phones and book appointments." },
  ],
  skipped: [{ url: "https://clearview.example/team", reason: "The site answered 404." }],
};

const answer = {
  summary: "A family-owned window tint shop in Round Rock with two bays.",
  offerings: ["Car tint", "Home tint"],
  needs: [
    { need: "Phones go unanswered while they work", evidence: "We're hiring a front desk coordinator to answer phones", source: "https://clearview.example/careers", strength: "strong" },
    { need: "Calls missed when busy", evidence: "we always pick up eventually", source: "https://clearview.example/", strength: "moderate" },
    { need: "Lunchtime voicemail", evidence: "Calls go to voicemail at lunch", source: "list", strength: "strong" },
    { need: "Wants a new website", evidence: "our site is old", source: "https://made-up.example/blog", strength: "weak" },
  ],
  triggers: [
    { sentence: "Saw you just opened a second bay in Round Rock.", when: null, source: "https://clearview.example/" },
    { sentence: "Saw you won Best of Austin.", when: "2026", source: "https://invented.example/awards" },
  ],
  tools: ["Square Appointments"],
  people: [{ name: "Dana Reyes", title: "Owner", source: "list" }],
  size: "Two bays",
  voice: "Warm and casual",
  risks: [],
  unknowns: ["Who answers the phone today?"],
};

describe("diligence", () => {
  test("with SubQ: every page goes in whole; sources are checked and quotes looked up in the pages", async () => {
    let sent: { system: string; prompt: string } | undefined;
    const reader: LongReader = {
      name: "subq",
      model: "subq-preview",
      chat: async (call) => {
        sent = call;
        return { text: `Here you go:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``, model: "subq-preview", usage: { inputTokens: 5000, outputTokens: 400, searches: 0, fetches: 0 } };
      },
    };
    const { output, usage } = await diligenceWithSubq(reader, input);
    expect(sent!.prompt).toContain('<page url="https://clearview.example/careers" title="Careers">');
    expect(sent!.prompt).toContain("2026-10-02: sent email step 1 (founder-direct)");
    expect(sent!.system).toContain("Reply with one JSON object");
    expect(output.needs.map((n) => [n.need, n.confirmed])).toEqual([
      ["Phones go unanswered while they work", true],
      ["Calls missed when busy", false],
      ["Lunchtime voicemail", true],
    ]);
    expect(output.triggers.map((t) => t.sentence)).toEqual(["Saw you just opened a second bay in Round Rock."]);
    expect(output.pages.map((p) => p.url)).toEqual(["https://clearview.example/", "https://clearview.example/careers"]);
    expect(output.skipped).toEqual(input.skipped);
    expect(output.provider).toBe("subq");
    expect(usage.inputTokens).toBe(5000);
  });

  test("with Claude: its own searches count as sources too", async () => {
    let tools: Array<{ name: string; strict?: boolean }> = [];
    const call: MessagesCall = async (params) => {
      tools = (params as unknown as { tools: typeof tools }).tools;
      return {
        id: "m",
        type: "message",
        role: "assistant",
        model: DEFAULT_MODEL,
        stop_reason: "tool_use",
        stop_details: null,
        usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } },
        content: [
          { type: "web_search_tool_result", tool_use_id: "s", content: [{ type: "web_search_result", url: "https://news.example/clearview-award", title: "Award", encrypted_content: "x", page_age: null }] },
          { type: "tool_use", id: "t", name: "submit_diligence", input: { ...answer, triggers: [{ sentence: "Saw you won Best of Round Rock.", when: "2026", source: "https://news.example/clearview-award" }] } },
        ],
      } as unknown as BetaMessage;
    };
    const { output } = await diligenceWithClaude(call, input);
    expect(tools.map((t) => t.name)).toEqual(["web_search", "web_fetch", "submit_diligence"]);
    expect(tools[2]!.strict).toBe(true);
    expect(output.triggers.map((t) => t.source)).toEqual(["https://news.example/clearview-award"]);
    expect(output.pages.map((p) => p.url)).toContain("https://news.example/clearview-award");
    expect(output.provider).toBe("claude");
  });

  test("the history reads as one line per touch, with what they said", () => {
    const lines = historyLines([
      { kind: "REPLIED", channel: "EMAIL", step: 1, prospectKey: "k", occurredAt: "2026-10-05T10:00:00Z", body: "Not now,\n\nmaybe after the new year." } as Touch,
      { kind: "SENT", channel: "LINKEDIN", prospectKey: "k", occurredAt: "2026-10-01T10:00:00Z" } as Touch,
    ]);
    expect(lines).toEqual(["2026-10-01: sent linkedin", '2026-10-05: replied email step 1: "Not now, maybe after the new year."']);
  });
});

describe("SubQ", () => {
  test("speaks the OpenAI chat format to SubQ's address, with the key as a bearer token", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
    const fetch: Fetch = async (url, init) => {
      requests.push({ url, body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>).authorization ?? "" });
      return Response.json({ model: "subq-preview", choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 120000, completion_tokens: 300 } });
    };
    const reader = subqReader({ apiKey: "sq-test", fetch, env: {} });
    const result = await reader.chat({ system: "s", prompt: "p" });
    expect(requests[0]!.url).toBe("https://api.subq.ai/v1/chat/completions");
    expect(requests[0]!.auth).toBe("Bearer sq-test");
    expect(requests[0]!.body).toMatchObject({ model: "subq-preview", messages: [{ role: "system", content: "s" }, { role: "user", content: "p" }] });
    expect(result).toMatchObject({ text: '{"ok":true}', usage: { inputTokens: 120000, outputTokens: 300 } });
    expect(() => subqReader({ env: {} })).toThrow("SUBQ_API_KEY");
  });

  test("a cut-off or empty answer is an error in words", async () => {
    const cut: Fetch = async () => Response.json({ choices: [{ message: { content: '{"a":' }, finish_reason: "length" }] });
    await expect(subqReader({ apiKey: "k", fetch: cut, env: {} }).chat({ system: "s", prompt: "p" })).rejects.toThrow("cut off");
    const empty: Fetch = async () => Response.json({ choices: [{ message: { content: "" } }] });
    await expect(subqReader({ apiKey: "k", fetch: empty, env: {} }).chat({ system: "s", prompt: "p" })).rejects.toThrow("empty");
  });

  test("JSON is found in an answer with words or a code fence around it, strings with braces included", () => {
    expect(extractJson('Sure! {"a": "has } and { inside", "b": [1, 2]} Hope that helps.')).toEqual({ a: "has } and { inside", b: [1, 2] });
    expect(extractJson('```json\n{"x": 1}\n```')).toEqual({ x: 1 });
    expect(() => extractJson("no json here")).toThrow("expected shape");
  });
});
