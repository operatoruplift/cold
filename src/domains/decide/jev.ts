import { AiError, type AiUsage } from "../ai";
import { postJson } from "./http";
import { argmax, clamp01, concentration, normalize } from "./math";
import type { Answer, DecisionProvider, DecisionRequest, DecisionResult, Fetch, Question } from "./types";

/** TypeSafe's API, unless TYPESAFE_BASE_URL names a gateway in front of it. */
export const TYPESAFE_BASE_URL = "https://api.typesafe.ai/v1";
/** TypeSafe takes up to ten questions in one request. */
export const JEV_MAX_QUESTIONS = 10;

type Env = Record<string, string | undefined>;
export const jevConfigured = (env: Env = process.env) => !!env.TYPESAFE_API_KEY?.trim();
export const jevModel = (env: Env = process.env) => env.JEV_MODEL?.trim() || "jev-latest";
const jevUrl = (env: Env) => `${(env.TYPESAFE_BASE_URL?.trim() || TYPESAFE_BASE_URL).replace(/\/+$/, "")}/systemone`;

interface JevResponse {
  model?: string;
  answers?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function usageOf(usage: Record<string, unknown> | undefined): AiUsage {
  return {
    inputTokens: num(usage?.input_tokens) ?? num(usage?.prompt_tokens) ?? num(usage?.total_tokens) ?? 0,
    outputTokens: num(usage?.output_tokens) ?? num(usage?.completion_tokens) ?? 0,
    searches: 0,
    fetches: 0,
  };
}

/**
 * One answer, read the way TypeSafe documents it (noul: a probability;
 * choice: the option, its probabilities, a confidence; score: the expected
 * level, its probabilities, a confidence), tolerating the field names other
 * gateways use. A missing confidence is worked out from the probabilities.
 */
export function readAnswer(id: string, question: Question, raw: unknown): Answer {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const missing = () => new AiError(`Jev did not answer "${id}". Try again.`, 502);
  if (question.type === "noul") {
    const value = a.noul ?? a.probability ?? a.p ?? a.value;
    if (typeof value === "boolean") return { type: "noul", noul: value ? 1 : 0 };
    if (num(value) === undefined) throw missing();
    return { type: "noul", noul: clamp01(value) };
  }
  if (question.type === "choice") {
    const options = Object.keys(question.criteria);
    const given = a.probabilities && typeof a.probabilities === "object" ? normalize(a.probabilities as Record<string, unknown>, options) : undefined;
    let choice = [a.choice, a.answer, a.label].find((c): c is string => typeof c === "string" && options.includes(c));
    if (!choice && given) choice = argmax(given);
    if (!choice) throw missing();
    const probabilities = given ?? Object.fromEntries(options.map((o) => [o, o === choice ? 1 : 0]));
    return { type: "choice", choice, confidence: num(a.confidence) !== undefined ? clamp01(a.confidence) : concentration(probabilities), probabilities };
  }
  const levels = question.criteria.map((_, i) => String(i));
  const given = a.probabilities && typeof a.probabilities === "object" ? normalize(a.probabilities as Record<string, unknown>, levels) : undefined;
  const expected = given ? levels.reduce((sum, l) => sum + Number(l) * given[l]!, 0) : undefined;
  const score = num(a.score) ?? expected;
  if (score === undefined) throw missing();
  const probabilities = given ?? Object.fromEntries(levels.map((l) => [l, Number(l) === Math.round(score) ? 1 : 0]));
  return {
    type: "score",
    score: Math.min(levels.length - 1, Math.max(0, score)),
    confidence: num(a.confidence) !== undefined ? clamp01(a.confidence) : concentration(probabilities),
    probabilities,
  };
}

/**
 * Jev, TypeSafe's System One decision model: it reads the state once and
 * answers every typed question with calibrated probabilities. More than ten
 * questions go out as several requests over the same state.
 */
export function jevProvider(options: { apiKey?: string; model?: string; url?: string; fetch?: Fetch; sleep?: (ms: number) => Promise<void>; env?: Env } = {}): DecisionProvider {
  const env = options.env ?? process.env;
  const apiKey = options.apiKey ?? env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new AiError("Add your TypeSafe API key (TYPESAFE_API_KEY) in Settings to decide with Jev.", 400);
  const model = options.model ?? jevModel(env);
  const url = options.url ?? jevUrl(env);
  return {
    name: "jev",
    model,
    async decide(request: DecisionRequest): Promise<DecisionResult> {
      const ids = Object.keys(request.questions);
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += JEV_MAX_QUESTIONS) chunks.push(ids.slice(i, i + JEV_MAX_QUESTIONS));
      const replies = await Promise.all(
        chunks.map((chunk) =>
          postJson<JevResponse>({
            service: "TypeSafe",
            keyName: "TYPESAFE_API_KEY",
            url,
            apiKey,
            fetch: options.fetch,
            sleep: options.sleep,
            body: { model, state: request.state, questions: Object.fromEntries(chunk.map((id) => [id, request.questions[id]])) },
          }),
        ),
      );
      const answers: Record<string, Answer> = {};
      const usage: AiUsage = { inputTokens: 0, outputTokens: 0, searches: 0, fetches: 0 };
      replies.forEach(({ data }, i) => {
        const found = (data.answers ?? (data as Record<string, unknown>)) as Record<string, unknown>;
        for (const id of chunks[i]!) answers[id] = readAnswer(id, request.questions[id]!, found[id]);
        const used = usageOf(data.usage);
        usage.inputTokens += used.inputTokens;
        usage.outputTokens += used.outputTokens;
      });
      return { answers, model: replies.find((r) => r.data.model)?.data.model ?? model, usage };
    },
  };
}
