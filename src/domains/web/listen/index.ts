import { createHash, timingSafeEqual } from "node:crypto";
import { listenCsv, MAX_LISTEN_BYTES, readMagpie } from "../../listen";
import { HttpError, json, readBody, type Route } from "../api";
import type { WebContext } from "../context";
import type { ListenStatusResponse } from "../types";

export const LISTEN_WEBHOOK_PATH = "/api/listen/magpie";

/** Two secrets compared in constant time, whatever their lengths. */
function sameSecret(given: string | null, expected: string): boolean {
  const a = createHash("sha256").update(given ?? "").digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * OpenMagpie's webhook action delivers matches here (POST, instant or
 * digest). It proves itself with `Authorization: Bearer <COLD_LISTEN_SECRET>`,
 * set in the action's headers. Delivery is at least once: a key already kept
 * is counted as received, not added again.
 */
export function listenWebhook(ctx: WebContext): (request: Request) => Promise<Response> {
  return async (request) => {
    const secret = process.env.COLD_LISTEN_SECRET?.trim();
    if (!secret) return json({ error: "Listening is not set up here: set COLD_LISTEN_SECRET in cold's Settings, and the same value in OpenMagpie's webhook headers." }, 503);
    if (!sameSecret(request.headers.get("authorization"), `Bearer ${secret}`)) return json({ error: "Not for you: the Authorization header must be Bearer and COLD_LISTEN_SECRET." }, 401);
    if (!ctx.listening) return json({ error: "This server has no database to keep matches." }, 503);
    if (Number(request.headers.get("content-length") ?? 0) > MAX_LISTEN_BYTES) return json({ error: "That delivery is too large: use a shorter digest interval." }, 413);
    const text = await request.text();
    if (text.length > MAX_LISTEN_BYTES) return json({ error: "That delivery is too large: use a shorter digest interval." }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: "The body must be JSON." }, 400);
    }
    const { items, error } = readMagpie(body, ctx.now());
    if (error) return json({ error }, 400);
    const { added } = await ctx.listening.receive(items);
    if (added) ctx.invalidate();
    return json({ ok: true, received: items.length, added });
  };
}

/** Settings, Listening: where OpenMagpie should deliver, and what has come in. Behind the login. */
export function listenRoutes(ctx: WebContext): Route[] {
  return [
    [
      "GET",
      /^\/api\/listen$/,
      async (request) => {
        const response: ListenStatusResponse = {
          configured: !!process.env.COLD_LISTEN_SECRET?.trim(),
          available: !!ctx.listening,
          webhookUrl: new URL(LISTEN_WEBHOOK_PATH, new URL(request.url).origin).href,
          watches: (await ctx.listening?.watches()) ?? [],
        };
        return json(response);
      },
    ],
    [
      "POST",
      /^\/api\/listen\/export$/,
      async (request) => {
        // A watch's matches as one of your own lists, to fill in and research; saving again only adds new matches.
        const { watch } = await readBody<{ watch: string }>(request);
        if (!ctx.listening) throw new HttpError(409, "Listening needs the app's database.");
        if (!/^[\w-]+$/.test(watch ?? "")) throw new HttpError(400, "Pick a watch, or all.");
        const name = watch === "all" ? "all" : (await ctx.listening.watches()).find((w) => w.id === watch)?.name;
        if (!name) throw new HttpError(404, "No matches have come in from that watch yet.");
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "matches";
        const file = `prospects-listen-${slug}.csv`;
        const existing = await ctx.files.read(file).catch(() => undefined);
        const { text, added, rows } = listenCsv(await ctx.listening.items({ watch: watch === "all" ? undefined : watch, limit: 5000 }), existing);
        await ctx.files.write(file, text);
        ctx.invalidate();
        const message = `${added ? `Added ${added} new ${added === 1 ? "match" : "matches"} to` : "Nothing new for"} ${file} (${rows} in all). Fill in company where it's empty, or research them, then run a campaign on it.`;
        return json({ ok: true, source: `csv:${file}`, added, rows, message });
      },
    ],
  ];
}
