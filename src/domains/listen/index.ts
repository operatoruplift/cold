import type { Db } from "../db";
import type { ListenItem } from "./types";

export * from "./types";
export * from "./helpers";

/** A watch that has sent matches: which, how many, the latest. */
export interface ListenWatch {
  id: string;
  name: string;
  count: number;
  latest: string;
}

/** The matches OpenMagpie sent, in the app's database. Each key is kept once. */
export class ListenStore {
  constructor(private readonly db: Db) {}

  /** Keep new matches; one already kept (a redelivery) is left as it is. */
  async receive(items: ListenItem[]): Promise<{ added: number }> {
    let added = 0;
    for (const item of items) {
      const { changes } = await this.db.run(
        "INSERT INTO listen_items (key, watch_id, watch_name, source_kind, occurred_at, received_at, item) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING",
        item.key,
        item.watchId,
        item.watchName,
        item.sourceKind,
        item.occurredAt ?? item.receivedAt,
        item.receivedAt,
        JSON.stringify(item),
      );
      added += changes;
    }
    return { added };
  }

  /** Matches, newest post first: every watch's, or one's. */
  async items(options: { watch?: string; limit?: number } = {}): Promise<ListenItem[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 500, 5000));
    const rows = options.watch
      ? await this.db.all<{ item: string }>("SELECT item FROM listen_items WHERE watch_id = ? ORDER BY occurred_at DESC LIMIT ?", options.watch, limit)
      : await this.db.all<{ item: string }>("SELECT item FROM listen_items ORDER BY occurred_at DESC LIMIT ?", limit);
    return rows.map((r) => JSON.parse(r.item) as ListenItem);
  }

  async watches(): Promise<ListenWatch[]> {
    return (
      await this.db.all<{ id: string; name: string; count: number; latest: string }>(
        "SELECT watch_id AS id, MAX(watch_name) AS name, COUNT(*) AS count, MAX(received_at) AS latest FROM listen_items GROUP BY watch_id ORDER BY latest DESC",
      )
    ).map((w) => ({ id: w.id, name: w.name, count: Number(w.count), latest: w.latest }));
  }
}
