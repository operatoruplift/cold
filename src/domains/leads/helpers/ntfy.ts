import type { NtfyMessage, NtfyTarget } from "../types";

/**
 * The alert target from the environment: COLD_NTFY_URL is the topic's
 * address (https://ntfy.sh/<topic>, or the topic on your own server) and
 * COLD_NTFY_TOKEN an access token for a topic that needs one. Unset means no
 * alerts; set but unusable comes back as a problem, in words. Pure.
 */
export function readNtfy(env: Record<string, string | undefined> = process.env): { target?: NtfyTarget; problem?: string } {
  const raw = env.COLD_NTFY_URL?.trim();
  if (!raw) return {};
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: "COLD_NTFY_URL is not a URL: use the topic's address, e.g. https://ntfy.sh/cold-leads-7f3k2q." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { problem: "COLD_NTFY_URL must start with https://." };
  if (url.username || url.password) return { problem: "Put an access token in COLD_NTFY_TOKEN instead of a login in COLD_NTFY_URL." };
  const parts = url.pathname.split("/").filter(Boolean);
  const topic = parts.pop();
  if (!topic || !/^[\w-]{1,64}$/.test(topic)) return { problem: "COLD_NTFY_URL must end in the topic's name (letters, digits, - and _), e.g. https://ntfy.sh/cold-leads-7f3k2q." };
  const server = `${url.origin}/${parts.map((p) => `${p}/`).join("")}`;
  return { target: { server, topic, token: env.COLD_NTFY_TOKEN?.trim() || undefined } };
}

/** Publish one push, as JSON to the server's root. Throws with ntfy's answer when it refuses. */
export async function sendNtfy(target: NtfyTarget, message: Omit<NtfyMessage, "topic">, fetchImpl: typeof fetch = fetch): Promise<void> {
  const body: NtfyMessage = { ...message, topic: target.topic };
  const response = await fetchImpl(target.server, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.ok) return;
  const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
  const hint = response.status === 401 || response.status === 403 ? " (check COLD_NTFY_TOKEN)" : "";
  throw new Error(`ntfy answered ${response.status}${detail ? `: ${detail}` : ""}${hint}`);
}
