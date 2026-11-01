import { MAX_LISTEN_ITEMS, type ListenItem, type MagpiePayload } from "../types";

type Rec = Record<string, unknown>;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, max) : "");
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

/** A site's origin, for an author's own site. Undefined for the big platforms, which are no one's own site. */
function siteOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || /(^|\.)(reddit|x|twitter|github|ycombinator|youtube|medium|substack)\.com$/i.test(u.hostname)) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/** Where the post is: Reddit's permalink (made absolute), else the item's own URL. */
function postUrl(item: Rec): string {
  const permalink = text(item.permalink, 600);
  if (permalink) return permalink.startsWith("/") ? `https://www.reddit.com${permalink}` : permalink;
  return text(item.url, 600) || text(item.external_url, 600);
}

/** One OpenMagpie item as a match. Pure. */
function toItem(entry: MagpiePayload["items"][number], watch: MagpiePayload["watch"], receivedAt: string): ListenItem | undefined {
  const key = text(entry.key, 300);
  if (!key) return undefined;
  const item = isRec(entry.item) ? entry.item : {};
  const sourceKind = text(entry.source?.kind, 64) || text(item.source, 64) || "unknown";
  const url = postUrl(item);
  const handle = /twitter|^x_/i.test(sourceKind) ? text(item.handle, 30).replace(/^@/, "") || undefined : undefined;
  const homepage = text(item.homepage, 300);
  const occurred = text(item.occurred_at, 40);
  return {
    key,
    watchId: text(watch.id, 64),
    watchName: text(watch.name, 200) || "Listening",
    sourceKind,
    sourceLabel: text(entry.source?.label, 200),
    title: text(item.title, 300),
    content: text(item.content, 2000),
    url,
    author: text(item.author, 120) || text(item.owner, 120) || undefined,
    handle,
    subreddit: text(item.subreddit, 80).replace(/^r\//i, "") || undefined,
    website: (homepage && siteOf(homepage)) || (/rss/i.test(sourceKind) ? siteOf(url) : undefined),
    occurredAt: occurred && !Number.isNaN(Date.parse(occurred)) ? new Date(occurred).toISOString() : undefined,
    receivedAt,
  };
}

/**
 * OpenMagpie's webhook body, read and checked: the matches in it, or what is
 * wrong with it. Unknown fields are ignored; a body with too many items is
 * refused rather than cut. Pure.
 */
export function readMagpie(body: unknown, now: Date): { items: ListenItem[]; error?: string } {
  if (!isRec(body) || !isRec(body.watch) || !Array.isArray(body.items)) return { items: [], error: "Not an OpenMagpie webhook body: it needs watch and items." };
  if (body.items.length > MAX_LISTEN_ITEMS) return { items: [], error: `Too many items in one delivery (${body.items.length}, at most ${MAX_LISTEN_ITEMS}): use a shorter digest interval.` };
  const watch = body.watch as MagpiePayload["watch"];
  const receivedAt = now.toISOString();
  const items = (body.items as MagpiePayload["items"]).flatMap((entry) => (isRec(entry) ? toItem(entry, watch, receivedAt) ?? [] : []));
  return { items };
}
