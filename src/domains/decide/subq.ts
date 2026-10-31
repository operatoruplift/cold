import { AiError, type AiUsage } from "../ai";
import { postJson } from "./http";
import type { Fetch } from "./types";

/** Subquadratic's API, which speaks the OpenAI chat format. SUBQ_BASE_URL can point elsewhere. */
export const SUBQ_BASE_URL = "https://api.subq.ai/v1";

type Env = Record<string, string | undefined>;
export const subqConfigured = (env: Env = process.env) => !!env.SUBQ_API_KEY?.trim();
export const subqModel = (env: Env = process.env) => env.SUBQ_MODEL?.trim() || "subq-preview";

export interface ChatResult {
  text: string;
  model: string;
  usage: AiUsage;
}

/** A long-context model that reads everything in one pass and answers in text. */
export interface LongReader {
  readonly name: "subq";
  readonly model: string;
  chat(input: { system: string; prompt: string; maxTokens?: number }): Promise<ChatResult>;
}

interface ChatResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * SubQ, Subquadratic's long-context model: a whole site, the list row and the
 * history fit in one request, so nothing has to be summarised away first.
 */
export function subqReader(options: { apiKey?: string; model?: string; baseUrl?: string; fetch?: Fetch; env?: Env } = {}): LongReader {
  const env = options.env ?? process.env;
  const apiKey = options.apiKey ?? env.SUBQ_API_KEY?.trim();
  if (!apiKey) throw new AiError("Add your SubQ API key (SUBQ_API_KEY) in Settings to run diligence with SubQ.", 400);
  const model = options.model ?? subqModel(env);
  const url = `${(options.baseUrl ?? env.SUBQ_BASE_URL?.trim() ?? SUBQ_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
  return {
    name: "subq",
    model,
    async chat({ system, prompt, maxTokens = 8000 }) {
      const { data } = await postJson<ChatResponse>({
        service: "SubQ",
        keyName: "SUBQ_API_KEY",
        url,
        apiKey,
        fetch: options.fetch,
        timeoutMs: 5 * 60 * 1000,
        body: { model, max_tokens: maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] },
      });
      const choice = data.choices?.[0];
      const content = choice?.message?.content;
      const text = typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
      if (choice?.finish_reason === "length") throw new AiError("SubQ's answer was cut off before it finished. Try again.", 502);
      if (!text.trim()) throw new AiError("SubQ sent back an empty answer. Try again.", 502);
      return { text, model: data.model ?? model, usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0, searches: 0, fetches: 0 } };
    },
  };
}

/** The JSON object in a model's text answer: inside a code fence or bare, ignoring words around it. */
export function extractJson(text: string): unknown {
  const source = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text;
  const start = source.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new AiError("The answer was not in the expected shape. Try again.", 502);
}
