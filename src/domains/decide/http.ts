import { AiError } from "../ai";
import type { Fetch } from "./types";

export interface PostJson {
  /** The service's name, for messages: "TypeSafe", "SubQ". */
  service: string;
  /** The setting that holds its key, for messages: "TYPESAFE_API_KEY". */
  keyName: string;
  url: string;
  apiKey: string;
  body: unknown;
  fetch?: Fetch;
  timeoutMs?: number;
  /** Tries again after a rate limit or a server error, this many times. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The message a JSON error body carries, whatever shape the service uses. */
function errorText(body: string): string {
  try {
    const data = JSON.parse(body) as { error?: unknown; message?: unknown; detail?: unknown };
    const error = data.error as { message?: unknown } | string | undefined;
    const found = (typeof error === "object" ? error?.message : error) ?? data.message ?? data.detail;
    if (typeof found === "string" && found.trim()) return found.trim().slice(0, 300);
  } catch {
    // Not JSON: fall through to the text itself.
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** A failed response, in words for the screen. Never repeats the key. */
export function explainHttp(service: string, keyName: string, status: number, body: string, requestId?: string): AiError {
  const detail = errorText(body);
  const ref = requestId ? ` (request ${requestId})` : "";
  if (status === 401 || status === 403) return new AiError(`${service} did not accept the API key. Check ${keyName} in Settings.${ref}`, 400);
  if (status === 404) return new AiError(`${service} has no such endpoint or model${detail ? `: ${detail}` : ""}. Check the model name and address.${ref}`, 400);
  if (status === 413) return new AiError(`That was too much for ${service} in one request.${ref}`, 413);
  if (status === 429) return new AiError(`${service}'s rate limit was hit. Wait a minute and try again.${ref}`, 429);
  if (status >= 500) return new AiError(`${service} is having trouble (error ${status}). Try again in a minute.${ref}`, 502);
  return new AiError(`${service} rejected the request${detail ? `: ${detail}` : ""}.${ref}`, 400);
}

/**
 * POST JSON with a bearer key and read JSON back. Waits out a rate limit or a
 * server error and tries again; everything else fails at once, in words.
 */
export async function postJson<T>(input: PostJson): Promise<{ data: T; requestId?: string }> {
  const doFetch = input.fetch ?? ((url, init) => fetch(url, init));
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = input.retries ?? 1;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await doFetch(input.url, {
        method: "POST",
        headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(input.body),
        signal: AbortSignal.timeout(input.timeoutMs ?? 90_000),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === "TimeoutError" || name === "AbortError") throw new AiError(`${input.service} took too long to answer. Try again.`, 504);
      throw new AiError(`Could not reach ${input.service}: ${(err as Error).message}`, 502);
    }
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const body = await response.text();
    if (response.ok) {
      try {
        return { data: JSON.parse(body) as T, requestId };
      } catch {
        throw new AiError(`${input.service} sent back something COLD could not read.`, 502);
      }
    }
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      const after = Number(response.headers.get("retry-after"));
      await sleep(Math.min(10_000, Number.isFinite(after) && after > 0 ? after * 1000 : 1500 * (attempt + 1)));
      continue;
    }
    throw explainHttp(input.service, input.keyName, response.status, body, requestId);
  }
}
