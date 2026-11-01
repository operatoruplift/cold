import { finishProspect, type Prospect } from "../../prospects";
import type { ListenItem } from "../types";

/** A post's words cut at a word, for quoting in one line. Pure. */
export function quoteOf(words: string, max = 90): string {
  const flat = words.replace(/\s+/g, " ").trim().replace(/^["“]+|["”]+$/g, "");
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.!?-]+$/, "")}…`;
}

const isReddit = (item: ListenItem) => !!item.subreddit || /reddit/i.test(item.sourceKind);
const isX = (item: ListenItem) => !!item.handle || /twitter|^x_/i.test(item.sourceKind);

/**
 * The {{trigger}} line for a match: why you're writing, in one true sentence
 * built from the post itself. Pure.
 */
export function triggerOf(item: ListenItem): string {
  const what = quoteOf(item.title || item.content);
  if (/github/i.test(item.sourceKind)) return `Came across ${item.title || "your project"} on GitHub.`;
  if (!what) return `Saw your post${item.sourceLabel ? ` in ${item.sourceLabel}` : ""}.`;
  if (isReddit(item)) return `Saw your post in r/${item.subreddit ?? item.sourceLabel.replace(/^r\//, "")}: "${what}".`;
  if (isX(item)) return `Saw your post on X: "${what}".`;
  if (/hacker ?news|hackernews|^hn/i.test(item.sourceKind)) return `Saw your post on Hacker News: "${what}".`;
  if (/rss/i.test(item.sourceKind)) return `Read your post "${what}".`;
  return `Saw your post: "${what}".`;
}

/** Who wrote it, for lists: "u/name on r/sub", "@handle on X", "name (source)". Pure. */
export function listenLabel(item: ListenItem): string {
  if (isX(item) && item.handle) return `${item.author && item.author !== item.handle ? `${item.author} ` : ""}@${item.handle} on X`;
  if (isReddit(item)) return `${item.author ? `u/${item.author}` : "Someone"} on r/${item.subreddit ?? item.sourceLabel.replace(/^r\//, "")}`;
  return `${item.author ?? "Someone"}${item.sourceLabel ? ` (${item.sourceLabel})` : ""}`;
}

/**
 * A match as a prospect: the post is the trigger line, the author's X handle
 * (when it came from X) makes them reachable by an X DM, and the post's link
 * and words are variables for research and drafts. Reddit usernames are not
 * names, so they are never used as first_name. Pure.
 */
export function listenProspect(item: ListenItem): Prospect {
  const variables: Record<string, string> = Object.fromEntries(
    Object.entries({
      full_name: isX(item) && item.author && item.author !== item.handle ? item.author : undefined,
      x_handle: item.handle,
      website: item.website,
      trigger: triggerOf(item),
      post_url: item.url,
      post_title: item.title,
      post_text: quoteOf(item.content, 400),
      posted_at: item.occurredAt,
      listen_source: item.sourceLabel,
      listen_watch: item.watchName,
    }).filter((e): e is [string, string] => !!e[1]),
  );
  const prospect = finishProspect({ source: "listen", variables, doNotContact: false, links: {}, sourceId: item.key });
  return { ...prospect, label: listenLabel(item) };
}
