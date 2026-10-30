import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessage, BetaMessageParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";

/** The model COLD asks, unless COLD_AI_MODEL names another. */
export const DEFAULT_MODEL = "claude-opus-5-5";
export const aiModel = (env: Record<string, string | undefined> = process.env) => env.COLD_AI_MODEL?.trim() || DEFAULT_MODEL;
export const aiConfigured = (env: Record<string, string | undefined> = process.env) => !!env.ANTHROPIC_API_KEY?.trim();

export type Effort = "low" | "medium" | "high";
type CreateParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

/** One request to Claude, returning the finished message. Tests pass a fake. */
export type MessagesCall = (params: CreateParams) => Promise<BetaMessage>;

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  searches: number;
  fetches: number;
}

export interface AiResult<T> {
  output: T;
  model: string;
  usage: AiUsage;
  /** Every page Claude searched up or read, so claims can be checked against them. */
  seen: Array<{ url: string; title?: string }>;
}

/** A failure worth showing as is: no key, a refusal, a cut-off answer, an API error in words. */
export class AiError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

let cached: { key: string; call: MessagesCall } | undefined;

/**
 * Talk to Claude with ANTHROPIC_API_KEY. Requests stream (research can run for
 * minutes) and ask for the server-side fallback, so a request the model
 * declines for policy reasons is retried on Anthropic's recommended fallback
 * model instead of failing.
 */
export function claudeCall(env: Record<string, string | undefined> = process.env): MessagesCall {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new AiError("Add your Anthropic API key (ANTHROPIC_API_KEY) in Settings to use the AI features.", 400);
  if (cached?.key === key) return cached.call;
  const client = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 10 * 60 * 1000 });
  const call: MessagesCall = (params) => client.beta.messages.stream(params).finalMessage();
  cached = { key, call };
  return call;
}

/** What went wrong, in words for the screen. */
export function explainError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new AiError("Anthropic did not accept the API key. Check ANTHROPIC_API_KEY in Settings.", 400);
  if (err instanceof Anthropic.PermissionDeniedError) return new AiError(`Anthropic refused the request: ${err.message}`, 403);
  if (err instanceof Anthropic.RateLimitError) return new AiError("Anthropic's rate limit was hit. Wait a minute and try again.", 429);
  if (err instanceof Anthropic.BadRequestError) {
    if (/web.?search|web.?fetch/i.test(err.message)) return new AiError(`Web search is not available for this API key: ${err.message}. An organization admin can turn it on in the Claude Console.`, 400);
    return new AiError(`Anthropic rejected the request: ${err.message}`, 400);
  }
  if (err instanceof Anthropic.APIConnectionError) return new AiError("Could not reach Anthropic. Check the server's internet connection.", 502);
  if (err instanceof Anthropic.APIError) return new AiError(`Anthropic error ${err.status ?? ""}: ${err.message}`.trim(), 502);
  return new AiError((err as Error).message ?? String(err), 500);
}

function addUsage(total: AiUsage, message: BetaMessage): void {
  const u = message.usage;
  total.inputTokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  total.outputTokens += u.output_tokens ?? 0;
  total.searches += u.server_tool_use?.web_search_requests ?? 0;
  total.fetches += u.server_tool_use?.web_fetch_requests ?? 0;
}

function collectSeen(blocks: BetaContentBlock[], seen: Map<string, { url: string; title?: string }>): void {
  for (const block of blocks) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) seen.set(normalizeUrl(r.url), { url: r.url, title: r.title });
    } else if (block.type === "web_fetch_tool_result" && block.content.type === "web_fetch_result") {
      seen.set(normalizeUrl(block.content.url), { url: block.content.url, title: block.content.content.title ?? undefined });
    }
  }
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export const hostOf = (url: string) => {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

function refusalText(message: BetaMessage): string {
  const category = message.stop_details?.type === "refusal" ? message.stop_details.category : null;
  return `Claude declined this request${category ? ` (${category})` : ""}. Rephrase it, or try another prospect.`;
}

interface Base {
  call: MessagesCall;
  model?: string;
  system: string;
  prompt: string;
  effort?: Effort;
  maxTokens?: number;
}

function request(base: Base, extra: Partial<CreateParams>, messages: BetaMessageParam[]): CreateParams {
  return {
    model: base.model ?? aiModel(),
    max_tokens: base.maxTokens ?? 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // The instructions never change between calls of one kind, so they are cached.
    system: [{ type: "text", text: base.system, cache_control: { type: "ephemeral" } }],
    messages,
    ...extra,
  } as CreateParams;
}

/** One question, one JSON answer in the given schema. No tools. */
export async function askStructured<T>(base: Base & { schema: Record<string, unknown> }): Promise<AiResult<T>> {
  const usage: AiUsage = { inputTokens: 0, outputTokens: 0, searches: 0, fetches: 0 };
  let message: BetaMessage;
  try {
    message = await base.call(request(base, { output_config: { effort: base.effort ?? "medium", format: { type: "json_schema", schema: base.schema } } }, [{ role: "user", content: base.prompt }]));
  } catch (err) {
    throw explainError(err);
  }
  addUsage(usage, message);
  if (message.stop_reason === "refusal") throw new AiError(refusalText(message), 422);
  if (message.stop_reason === "max_tokens") throw new AiError("The answer was cut off before it finished. Try again.", 502);
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    return { output: JSON.parse(text) as T, model: message.model, usage, seen: [] };
  } catch {
    throw new AiError("Claude's answer was not in the expected shape. Try again.", 502);
  }
}

/**
 * Research on the web, then hand the findings over by calling one strict
 * tool. Web search and web fetch run on Anthropic's side; a long turn that
 * pauses is resumed. If Claude stops without calling the tool, it is asked
 * once more.
 */
export async function askWithResearch<T>(
  base: Base & { submit: { name: string; description: string; schema: Record<string, unknown> }; maxSearches?: number; maxFetches?: number },
): Promise<AiResult<T>> {
  const usage: AiUsage = { inputTokens: 0, outputTokens: 0, searches: 0, fetches: 0 };
  const seen = new Map<string, { url: string; title?: string }>();
  const tools: BetaToolUnion[] = [
    { type: "web_search_20260209", name: "web_search", max_uses: base.maxSearches ?? 6 },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: base.maxFetches ?? 6 },
    { name: base.submit.name, description: base.submit.description, input_schema: base.submit.schema as { type: "object" }, strict: true },
  ];
  const messages: BetaMessageParam[] = [{ role: "user", content: base.prompt }];
  let nudged = false;
  for (let turn = 0; turn < 8; turn++) {
    let message: BetaMessage;
    try {
      message = await base.call(request(base, { tools, output_config: { effort: base.effort ?? "medium" } }, messages));
    } catch (err) {
      throw explainError(err);
    }
    addUsage(usage, message);
    collectSeen(message.content, seen);
    const submitted = message.content.find((b) => b.type === "tool_use" && b.name === base.submit.name);
    if (submitted && submitted.type === "tool_use") return { output: submitted.input as T, model: message.model, usage, seen: [...seen.values()] };
    if (message.stop_reason === "refusal") throw new AiError(refusalText(message), 422);
    if (message.stop_reason === "max_tokens") throw new AiError("The research ran out of room before it finished. Ask for fewer results.", 502);
    messages.push({ role: "assistant", content: message.content as BetaMessageParam["content"] });
    if (message.stop_reason === "pause_turn") continue;
    if (nudged) break;
    nudged = true;
    messages.push({ role: "user", content: `Call ${base.submit.name} now with what you found. If nothing fits, call it with an empty list.` });
  }
  throw new AiError("The research did not finish. Try again, or narrow it down.", 502);
}
