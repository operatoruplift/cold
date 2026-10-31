import type { Db } from "../../db";
import type { Touch, TouchStore } from "../types";

const SUPPRESSING = ["OPTED_OUT", "BOUNCED", "UNDELIVERABLE"];

/**
 * The touch log in the app's database: used on a server without a disk when
 * Twenty is not configured, as the JSON-lines file is on your computer.
 * Append-only, like the file.
 */
export class DbStore implements TouchStore {
  readonly kind = "database" as const;
  readonly where = "the database";

  constructor(private readonly db: Db) {}

  async record(touch: Touch): Promise<void> {
    await this.db.run(
      "INSERT INTO touches (kind, channel, account, prospect_key, to_address, occurred_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
      touch.kind,
      touch.channel,
      touch.account ?? null,
      touch.prospectKey,
      touch.toAddress?.toLowerCase() ?? null,
      touch.occurredAt,
      JSON.stringify(touch),
    );
  }

  private async select(where: string, params: Array<string | null>): Promise<Touch[]> {
    const rows = await this.db.all<{ id: number; data: string }>(`SELECT id, data FROM touches WHERE ${where} ORDER BY occurred_at, id`, ...params);
    return rows.flatMap((row) => {
      try {
        return [{ ...(JSON.parse(row.data) as Touch), id: String(row.id) }];
      } catch {
        return [];
      }
    });
  }

  async forProspects(identities: string[]): Promise<Touch[]> {
    const unique = [...new Set(identities)];
    const out = new Map<string, Touch>();
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200);
      const emails = chunk.filter((id) => id.startsWith("email:")).map((id) => id.slice(6).toLowerCase());
      const marks = (list: string[]) => list.map(() => "?").join(",");
      const where = emails.length ? `prospect_key IN (${marks(chunk)}) OR to_address IN (${marks(emails)})` : `prospect_key IN (${marks(chunk)})`;
      for (const touch of await this.select(where, [...chunk, ...emails])) out.set(touch.id!, touch);
    }
    return [...out.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  async suppressions(): Promise<Touch[]> {
    return this.select(`kind IN (${SUPPRESSING.map(() => "?").join(",")})`, SUPPRESSING);
  }

  async since(isoTime: string, filter: { account?: string; channel?: Touch["channel"]; kind?: Touch["kind"] } = {}): Promise<Touch[]> {
    const where = ["occurred_at >= ?"];
    const params: string[] = [isoTime];
    for (const [column, value] of [
      ["account", filter.account],
      ["channel", filter.channel],
      ["kind", filter.kind],
    ] as const) {
      if (!value) continue;
      where.push(`${column} = ?`);
      params.push(value);
    }
    return this.select(where.join(" AND "), params);
  }

  async markDoNotContact(): Promise<void> {
    // As with the file: there is no source record to mark. The OPTED_OUT touch is the record.
  }
}
