import { describe, expect, test } from "bun:test";
import { openDatabase } from "../db";
import { ListenStore, listenProspect, quoteOf, readMagpie, triggerOf, type ListenItem } from ".";

const NOW = new Date("2026-11-02T15:00:00Z");

/** A digest as OpenMagpie's webhook action sends it: one Reddit post, one X post, one GitHub repo, one blog post. */
const digest = {
  watch: { id: "01JWATCH", name: "Needs booking software" },
  action_id: "01JACTION",
  delivery: "digest",
  window: { since: "2026-11-02T14:00:00Z", until: "2026-11-02T15:00:00Z" },
  items: [
    {
      key: "reddit_subreddit:t3_abc",
      source: { label: "r/smallbusiness", kind: "reddit_subreddit" },
      item: { external_id: "t3_abc", occurred_at: "2026-11-02T14:10:00Z", title: "Any booking tool for a two-person detailing shop? We keep missing calls", content: "We tried three apps.", url: "https://example.com/linked", permalink: "/r/smallbusiness/comments/abc/any_booking_tool/", author: "shinyhands", subreddit: "smallbusiness" },
    },
    {
      key: "twitter_search:1850",
      source: { label: "X search: booking app", kind: "twitter_search" },
      item: { external_id: "1850", occurred_at: "2026-11-02T14:20:00Z", title: "", content: "Is there a booking page that turns Google reviews into appointments? Asking for my tint shop", url: "https://x.com/clearviewtint/status/1850", author: "Dana Reyes", handle: "@ClearviewTint" },
    },
    {
      key: "github_search:42",
      source: { label: "GitHub: booking", kind: "github_search" },
      item: { external_id: "42", occurred_at: "2026-11-02T13:00:00Z", title: "acme/bookit", content: "A tiny booking widget", url: "https://github.com/acme/bookit", owner: "acme", homepage: "https://bookit.acme.example/docs" },
    },
    {
      key: "rss:entry-9",
      source: { label: "Detailing Weekly", kind: "rss" },
      item: { external_id: "entry-9", occurred_at: "2026-11-01T09:00:00Z", title: "Why we stopped taking bookings by phone", content: "", url: "https://detailingweekly.example/posts/phones", author: "Priya" },
    },
  ],
};

describe("OpenMagpie's webhook body", () => {
  test("each connector's item becomes a match with its link, author and handle", () => {
    const { items, error } = readMagpie(digest, NOW);
    expect(error).toBeUndefined();
    expect(items.map((i) => [i.key, i.url, i.author, i.handle, i.website])).toEqual([
      ["reddit_subreddit:t3_abc", "https://www.reddit.com/r/smallbusiness/comments/abc/any_booking_tool/", "shinyhands", undefined, undefined],
      ["twitter_search:1850", "https://x.com/clearviewtint/status/1850", "Dana Reyes", "ClearviewTint", undefined],
      ["github_search:42", "https://github.com/acme/bookit", "acme", undefined, "https://bookit.acme.example"],
      ["rss:entry-9", "https://detailingweekly.example/posts/phones", "Priya", undefined, "https://detailingweekly.example"],
    ]);
    expect(items[0]).toMatchObject({ watchId: "01JWATCH", watchName: "Needs booking software", subreddit: "smallbusiness", occurredAt: "2026-11-02T14:10:00.000Z", receivedAt: NOW.toISOString() });
  });

  test("a body that isn't one, or a digest too big to keep, is refused in words", () => {
    expect(readMagpie({ hello: 1 }, NOW).error).toContain("Not an OpenMagpie webhook body");
    expect(readMagpie({ watch: { id: "w", name: "n" }, items: Array.from({ length: 501 }, (_, i) => ({ key: `k${i}` })) }, NOW).error).toContain("at most 500");
    expect(readMagpie({ watch: { id: "w", name: "n" }, items: [{ key: "" }, "nonsense", { key: "ok" }] }, NOW).items.map((i) => i.key)).toEqual(["ok"]);
  });
});

describe("a match as a prospect", () => {
  const [reddit, tweet, repo, post] = readMagpie(digest, NOW).items as [ListenItem, ListenItem, ListenItem, ListenItem];

  test("the trigger line is the post itself, quoted short", () => {
    expect(triggerOf(reddit)).toBe('Saw your post in r/smallbusiness: "Any booking tool for a two-person detailing shop? We keep missing calls".');
    expect(triggerOf(tweet)).toBe('Saw your post on X: "Is there a booking page that turns Google reviews into appointments? Asking for my tint…".');
    expect(triggerOf(repo)).toBe("Came across acme/bookit on GitHub.");
    expect(triggerOf(post)).toBe('Read your post "Why we stopped taking bookings by phone".');
    expect(quoteOf("one two three four five six seven", 20)).toBe("one two three four…");
  });

  test("an X post is reachable by X DM and keyed by the handle, so opt-outs elsewhere apply", () => {
    const p = listenProspect(tweet);
    expect(p.key).toBe("x:clearviewtint");
    expect(p.identities).toEqual(["x:clearviewtint", "listen:twitter_search:1850"]);
    expect(p.xHandle).toBe("clearviewtint");
    expect(p.label).toBe("Dana Reyes @ClearviewTint on X");
    expect(p.variables).toMatchObject({ first_name: "Dana", post_url: "https://x.com/clearviewtint/status/1850", listen_watch: "Needs booking software" });
  });

  test("a Reddit username is never a first name", () => {
    const p = listenProspect(reddit);
    expect(p.key).toBe("listen:reddit_subreddit:t3_abc");
    expect(p.label).toBe("u/shinyhands on r/smallbusiness");
    expect(p.variables.first_name).toBeUndefined();
    expect(p.variables.trigger).toStartWith("Saw your post in r/smallbusiness");
  });
});

describe("the matches kept", () => {
  test("a redelivery is kept once, and lists come newest post first, per watch", async () => {
    const store = new ListenStore(await openDatabase(":memory:"));
    const { items } = readMagpie(digest, NOW);
    expect(await store.receive(items)).toEqual({ added: 4 });
    expect(await store.receive(items)).toEqual({ added: 0 });
    expect((await store.items()).map((i) => i.key)).toEqual(["twitter_search:1850", "reddit_subreddit:t3_abc", "github_search:42", "rss:entry-9"]);
    expect((await store.items({ watch: "nope" })).length).toBe(0);
    expect(await store.watches()).toEqual([{ id: "01JWATCH", name: "Needs booking software", count: 4, latest: NOW.toISOString() }]);
  });
});
