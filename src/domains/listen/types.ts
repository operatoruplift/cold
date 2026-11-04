/**
 * Listening: posts where someone asks for what you sell, found by OpenMagpie
 * (the self-hostable social listener behind ListeningKit) and delivered to
 * cold by its webhook action. Each one becomes a prospect whose trigger line
 * is the post itself.
 */

/**
 * OpenMagpie's webhook body (openmagpie_schema/watch_actions/webhook.py,
 * WebhookPayload): one item on instant delivery, several on a digest. Each
 * item's body is the connector's payload: title, content, url and the
 * connector's own fields (Reddit's author, permalink and subreddit, X's
 * author and handle, RSS's author and feed_url, GitHub's owner and homepage).
 */
export interface MagpiePayload {
  watch: { id: string; name: string };
  action_id?: string;
  delivery?: string;
  items: Array<{ key: string; source?: { label?: string; kind?: string }; item?: Record<string, unknown> }>;
}

/** One match, as cold keeps it. */
export interface ListenItem {
  /** OpenMagpie's stable key, source:external_id. Delivery is at least once, so this dedupes. */
  key: string;
  watchId: string;
  watchName: string;
  /** The connector: reddit_subreddit, twitter_search, hackernews, github_search, rss... */
  sourceKind: string;
  /** "r/smallbusiness", a feed's name... */
  sourceLabel: string;
  title: string;
  content: string;
  /** Where the post is. */
  url: string;
  author?: string;
  /** Their X handle, when the post came from X. */
  handle?: string;
  subreddit?: string;
  /** A site the author runs: a GitHub project's homepage, the blog an RSS post is on. */
  website?: string;
  occurredAt?: string;
  receivedAt: string;
}

export const LISTEN_PREFIX = "listen:";
/** One delivery's limits, so a runaway digest can't fill the database. */
export const MAX_LISTEN_ITEMS = 500;
export const MAX_LISTEN_BYTES = 2_000_000;
