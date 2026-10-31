import { describe, expect, test } from "bun:test";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { AiError, DEFAULT_MODEL, type MessagesCall } from "../ai";
import { claudeDecider } from "./claude";
import { jevProvider, readAnswer } from "./jev";
import { chanceBest, concentration, normalize, sampleBeta, seeded, wilson } from "./math";
import type { Fetch, Question } from "./types";

const questions: Record<string, Question> = {
  fit: { type: "noul", instructions: "Do they fit?", criteria: { true: "They do", false: "They don't" } },
  tone: { type: "choice", instructions: "Which tone?", criteria: { formal: "Formal", casual: "Casual" } },
  budget: { type: "score", instructions: "Can they pay?", criteria: ["No", "Maybe", "Yes"] },
};

/** A fake TypeSafe: records requests and answers in its documented shape. */
function typesafe(reply: (body: { questions: Record<string, Question> }) => Response | Promise<Response>) {
  const requests: Array<{ url: string; headers: Record<string, string>; body: { model: string; state: unknown; questions: Record<string, Question> } }> = [];
  const fetch: Fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url, headers: init?.headers as Record<string, string>, body });
    return reply(body);
  };
  return { fetch, requests };
}

const answersFor = (ids: string[]) =>
  Object.fromEntries(
    ids.map((id) => [
      id,
      id === "tone"
        ? { type: "choice", choice: "casual", confidence: 0.82, probabilities: { formal: 0.09, casual: 0.91 } }
        : id === "budget"
          ? { type: "score", score: 1.75, confidence: 0.6, probabilities: { "0": 0, "1": 0.25, "2": 0.75 } }
          : { type: "noul", noul: 0.84 },
    ]),
  );

describe("Jev, by TypeSafe", () => {
  test("sends the state and typed questions as TypeSafe documents them, and reads the answers back", async () => {
    const api = typesafe((body) => Response.json({ model: "jev-1.14.0", answers: answersFor(Object.keys(body.questions)), usage: { input_tokens: 900, output_tokens: 12 } }));
    const jev = jevProvider({ apiKey: "ts-test", fetch: api.fetch, env: {} });
    const result = await jev.decide({ state: { prospect: "Dana, Clearview Tint" }, questions });
    expect(api.requests[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(api.requests[0]!.headers.authorization).toBe("Bearer ts-test");
    expect(api.requests[0]!.body).toEqual({ model: "jev-latest", state: { prospect: "Dana, Clearview Tint" }, questions });
    expect(result.answers.fit).toEqual({ type: "noul", noul: 0.84 });
    expect(result.answers.tone).toMatchObject({ choice: "casual", confidence: 0.82 });
    expect(result.answers.budget).toMatchObject({ score: 1.75, confidence: 0.6 });
    expect(result.model).toBe("jev-1.14.0");
    expect(result.usage).toMatchObject({ inputTokens: 900, outputTokens: 12 });
  });

  test("more than ten questions go out in several requests over the same state", async () => {
    const api = typesafe((body) => Response.json({ answers: answersFor(Object.keys(body.questions)) }));
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`q${i}`, questions.fit!]));
    const result = await jevProvider({ apiKey: "k", fetch: api.fetch, env: {} }).decide({ state: "s", questions: many });
    expect(api.requests.map((r) => Object.keys(r.body.questions).length)).toEqual([10, 2]);
    expect(Object.keys(result.answers)).toHaveLength(12);
  });

  test("a gateway address and a pinned model come from the settings", async () => {
    const api = typesafe((body) => Response.json({ answers: answersFor(Object.keys(body.questions)) }));
    await jevProvider({ fetch: api.fetch, env: { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "https://gateway.example/typesafe/v1/", JEV_MODEL: "jev-1.13.0" } }).decide({ state: "s", questions: { fit: questions.fit! } });
    expect(api.requests[0]!.url).toBe("https://gateway.example/typesafe/v1/systemone");
    expect(api.requests[0]!.body.model).toBe("jev-1.13.0");
  });

  test("answers in other gateways' shapes still read, and a missing confidence is worked out", () => {
    expect(readAnswer("fit", questions.fit!, { probability: 0.3 })).toEqual({ type: "noul", noul: 0.3 });
    expect(readAnswer("fit", questions.fit!, { noul: 1.7 })).toEqual({ type: "noul", noul: 1 });
    const choice = readAnswer("tone", questions.tone!, { probabilities: { formal: 1, casual: 3 } });
    expect(choice).toMatchObject({ choice: "casual", probabilities: { formal: 0.25, casual: 0.75 } });
    expect((choice as { confidence: number }).confidence).toBeCloseTo(concentration({ formal: 0.25, casual: 0.75 }), 6);
    expect(readAnswer("budget", questions.budget!, { probabilities: { "0": 0, "1": 0.5, "2": 0.5 } })).toMatchObject({ score: 1.5 });
    expect(() => readAnswer("tone", questions.tone!, { choice: "loud" })).toThrow('Jev did not answer "tone"');
  });

  test("no key, a refused key, and a rate limit each say what to do; the key is never repeated", async () => {
    expect(() => jevProvider({ env: {} })).toThrow("TYPESAFE_API_KEY");
    const refused = typesafe(() => Response.json({ error: { message: "bad key ts-secret" } }, { status: 401, headers: { "x-request-id": "req_9" } }));
    const err = await jevProvider({ apiKey: "ts-secret", fetch: refused.fetch, env: {} })
      .decide({ state: "s", questions })
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).message).toBe("TypeSafe did not accept the API key. Check TYPESAFE_API_KEY in Settings. (request req_9)");
    let calls = 0;
    const busy = typesafe((body) => (++calls === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : Response.json({ answers: answersFor(Object.keys(body.questions)) })));
    const waited: number[] = [];
    await jevProvider({ apiKey: "k", fetch: busy.fetch, env: {}, sleep: async (ms) => void waited.push(ms) }).decide({ state: "s", questions });
    expect(calls).toBe(2);
    expect(waited).toHaveLength(1);
    const bad = typesafe(() => Response.json({ error: { message: "state is empty" } }, { status: 422 }));
    await expect(jevProvider({ apiKey: "k", fetch: bad.fetch, env: {} }).decide({ state: "", questions })).rejects.toThrow("TypeSafe rejected the request: state is empty.");
  });
});

describe("Claude, answering the same questions", () => {
  test("asks for every option's probability in a strict schema and answers like Jev, with reasons", async () => {
    let sent: Record<string, unknown> | undefined;
    const call: MessagesCall = async (params) => {
      sent = params as unknown as Record<string, unknown>;
      const output = {
        fit: { probability: 0.9, reason: "An owner-run tint shop, the audience exactly." },
        tone: { probabilities: { formal: 1, casual: 3 }, reason: "Their Instagram is relaxed." },
        budget: { probabilities: { "0": 0, "1": 1, "2": 1 }, reason: "Two locations." },
      };
      return { id: "m", type: "message", role: "assistant", model: DEFAULT_MODEL, content: [{ type: "text", text: JSON.stringify(output) }], stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 10, output_tokens: 5 } } as unknown as BetaMessage;
    };
    const result = await claudeDecider({ call }).decide({ state: { prospect: "Dana" }, questions });
    const schema = (sent!.output_config as { format: { schema: { required: string[]; properties: Record<string, { properties: Record<string, { required?: string[] }> }> } } }).format.schema;
    expect(schema.required).toEqual(["fit", "tone", "budget"]);
    expect(schema.properties.tone!.properties.probabilities!.required).toEqual(["formal", "casual"]);
    expect(schema.properties.budget!.properties.probabilities!.required).toEqual(["0", "1", "2"]);
    expect(String((sent!.messages as Array<{ content: string }>)[0]!.content)).toContain('<question id="tone" type="choice">');
    expect(result.answers.fit).toEqual({ type: "noul", noul: 0.9, reason: "An owner-run tint shop, the audience exactly." });
    expect(result.answers.tone).toMatchObject({ choice: "casual", probabilities: { formal: 0.25, casual: 0.75 } });
    expect(result.answers.budget).toMatchObject({ score: 1.5 });
  });
});

describe("the numbers", () => {
  test("probabilities are normalised over the options, and even when nothing usable came back", () => {
    expect(normalize({ a: 2, b: 2, c: "x" }, ["a", "b", "c"])).toEqual({ a: 0.5, b: 0.5, c: 0 });
    expect(normalize(undefined, ["a", "b"])).toEqual({ a: 0.5, b: 0.5 });
    expect(concentration({ a: 1, b: 0 })).toBe(1);
    expect(concentration({ a: 0.5, b: 0.5 })).toBeCloseTo(0, 9);
  });

  test("Beta draws centre on their mean, and the interval and best-arm chances behave", () => {
    const random = seeded(42);
    const draws = Array.from({ length: 4000 }, () => sampleBeta(3, 27, random));
    expect(draws.reduce((a, b) => a + b, 0) / draws.length).toBeCloseTo(0.1, 2);
    const small = Array.from({ length: 2000 }, () => sampleBeta(0.4, 19.6, random));
    expect(small.every((x) => x >= 0 && x <= 1)).toBe(true);
    const { low, high } = wilson(5, 50);
    expect(low).toBeGreaterThan(0.03);
    expect(high).toBeLessThan(0.2);
    const best = chanceBest({ casual: { wins: 12, n: 60 }, formal: { wins: 2, n: 60 } });
    expect(best.casual).toBeGreaterThan(0.99);
  });
});
