import type { Touch, TouchStore } from "../../touches";
import { connectUrl, finishConnect, handleOf, xReplies, xUserIdOf, withXToken, type AwaitingOnX, type XClient, type XStore } from "../../xApi";
import { HttpError, json, readBody, xHttpError, xTools, type Route } from "../api";
import type { WebContext } from "../context";
import type { ActionResponse, XStatusResponse } from "../types";

/** X keeps DMs for 30 days, so that is as far back as replies can be read. */
const REPLY_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** New handles looked up per reply check, so one check can't spend the app's lookup limit. */
const LOOKUPS_PER_CHECK = 25;

export const X_CALLBACK_PATH = "/api/x/callback";

const callbackUrl = (request: Request) => new URL(X_CALLBACK_PATH, new URL(request.url).origin).href;

/**
 * Every X touch an account made in the last 30 days, newest last: who is
 * still waiting for an answer (their latest X touch is a send), and which
 * messages are already logged as replies.
 */
function awaitingOf(touches: Touch[]): { sends: Map<string, Touch>; logged: Set<string> } {
  const latest = new Map<string, Touch>();
  const logged = new Set<string>();
  for (const t of [...touches].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
    latest.set(t.prospectKey, t);
    if (t.kind === "REPLIED" && t.messageId) logged.add(t.messageId);
  }
  return { sends: new Map([...latest].filter(([, t]) => t.kind === "SENT")), logged };
}

/**
 * Read an account's X DMs and log a reply for everyone who answered after
 * cold's last DM to them. A reply stops their sequences, like a reply to an
 * email. Returns one line per reply.
 */
export async function logXReplies(input: { store: XStore; client: XClient; touches: TouchStore; account: string; voice: "personal" | "company"; now: () => Date }): Promise<{ lines: string[]; skipped: number }> {
  const since = new Date(input.now().getTime() - REPLY_WINDOW_MS).toISOString();
  const { sends, logged } = awaitingOf(await input.touches.since(since, { account: input.account, channel: "X" }));
  if (!sends.size) return { lines: [], skipped: 0 };

  const byUser = new Map<string, Touch>();
  const awaiting = new Map<string, AwaitingOnX>();
  let lookups = 0;
  let skipped = 0;
  await withXToken(input.store, input.client, input.account, input.now, async (token) => {
    for (const touch of sends.values()) {
      const handle = handleOf(touch.toAddress);
      if (!handle) continue;
      let userId = await input.store.cachedUserId(handle);
      if (!userId) {
        if (lookups >= LOOKUPS_PER_CHECK) {
          skipped++;
          continue;
        }
        lookups++;
        userId = await xUserIdOf(input.store, input.client, token, handle).catch(() => undefined);
      }
      if (!userId) continue;
      byUser.set(userId, touch);
      awaiting.set(userId, { userId, sentAt: touch.occurredAt });
    }
  });

  const replies = await xReplies({ store: input.store, client: input.client, account: input.account, now: input.now, awaiting, logged });
  const lines: string[] = [];
  for (const reply of replies) {
    const sent = byUser.get(reply.senderId)!;
    await input.touches.record({
      kind: "REPLIED",
      channel: "X",
      voice: input.voice === "personal" ? "PERSONAL" : "COMPANY",
      account: input.account,
      sequence: sent.sequence,
      step: sent.step,
      templateId: sent.templateId,
      prospectKey: sent.prospectKey,
      prospectLabel: sent.prospectLabel,
      toAddress: sent.toAddress,
      body: reply.text,
      messageId: reply.id,
      occurredAt: reply.createdAt,
      links: sent.links,
    });
    lines.push(`${sent.prospectLabel ?? sent.prospectKey}: ${reply.text.replace(/\s+/g, " ").slice(0, 120)}`);
  }
  return { lines, skipped };
}

/** Settings, X: connect, disconnect and read replies. All behind the login. */
export function xRoutes(ctx: WebContext): Route[] {
  return [
    [
      "GET",
      /^\/api\/x$/,
      async (request) => {
        const { config } = await ctx.config();
        const connected = new Map((await ctx.x?.accounts())?.map((a) => [a.account, a]) ?? []);
        const response: XStatusResponse = {
          configured: !!ctx.xClient(),
          available: !!ctx.x,
          callbackUrl: callbackUrl(request),
          accounts: Object.values(config?.accounts ?? {}).map((a) => ({ key: a.key, voice: a.voice, username: connected.get(a.key)?.username, connectedAt: connected.get(a.key)?.connectedAt })),
        };
        return json(response);
      },
    ],
    [
      "POST",
      /^\/api\/x\/connect$/,
      async (request) => {
        const { account } = await readBody<{ account: string }>(request);
        const { store, client, config } = await xTools(ctx);
        if (!config.accounts[account]) throw new HttpError(400, `There is no account "${account}" in cold.yaml.`);
        try {
          return json({ url: await connectUrl(store, client.app, account, callbackUrl(request)) });
        } catch (err) {
          throw xHttpError(err);
        }
      },
    ],
    [
      "POST",
      /^\/api\/x\/disconnect$/,
      async (request) => {
        const { account } = await readBody<{ account: string }>(request);
        if (!ctx.x) throw new HttpError(409, "There is no X connection on this server.");
        const removed = await ctx.x.remove(account);
        if (removed) await ctx.xClient()?.revoke(removed.tokens.accessToken);
        return json({ ok: true, message: removed ? `Disconnected @${removed.username} from ${account}. cold no longer sends or reads its DMs.` : `${account} was not connected to X.` } satisfies ActionResponse);
      },
    ],
    [
      "POST",
      /^\/api\/x\/replies$/,
      async () => {
        const { store, client, config } = await xTools(ctx);
        const touches = await ctx.store(config);
        const lines: string[] = [];
        const notes: string[] = [];
        for (const { account } of await store.accounts()) {
          const a = config.accounts[account];
          if (!a) continue;
          try {
            const found = await logXReplies({ store, client, touches, account, voice: a.voice, now: () => ctx.now() });
            lines.push(...found.lines);
            if (found.skipped) notes.push(`${found.skipped} people on ${account} wait for the next check (X lookups are limited).`);
          } catch (err) {
            notes.push(`${account}: ${(err as Error).message}`);
          }
        }
        const message = lines.length ? `${lines.length} new ${lines.length === 1 ? "reply" : "replies"} on X, logged: ${lines.length === 1 ? "that sequence stops" : "those sequences stop"}.` : "No new replies on X.";
        return json({ ok: true, message: [message, ...notes].join(" "), lines } satisfies ActionResponse);
      },
    ],
  ];
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A small page after Connect X: what happened, and the way back to Settings. */
function page(title: string, text: string, ok: boolean): Response {
  const back = "/app/settings";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${ok ? `<meta http-equiv="refresh" content="2;url=${back}">` : ""}<title>${escape(title)}</title></head><body><h1>${escape(title)}</h1><p>${escape(text)}</p><p><a href="${back}">Back to Settings</a></p></body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** Where X sends the owner back: trade the one-time state and code for a connection. */
export function xCallback(ctx: WebContext): (url: URL) => Promise<Response> {
  return async (url) => {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const denied = url.searchParams.get("error");
    try {
      if (denied) {
        if (state) await ctx.x?.take(state);
        throw new Error(denied === "access_denied" ? "You didn't allow cold on X, so nothing changed." : `X said: ${denied}`);
      }
      if (!ctx.x) throw new Error("This server has no database to keep the X sign-in.");
      const client = ctx.xClient();
      if (!client) throw new Error("X_CLIENT_ID is not set on this server: add it in Settings and press Connect X again.");
      if (!state || !code) throw new Error("X sent you back without a sign-in code: press Connect X again.");
      const connection = await finishConnect(ctx.x, client, { state, code }, () => ctx.now());
      return page("X connected", `${connection.account} sends X DMs as @${connection.username} now. Taking you back to Settings.`, true);
    } catch (err) {
      return page("X is not connected", (err as Error).message, false);
    }
  };
}
