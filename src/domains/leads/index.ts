import { DEFAULT_CALL_HOURS, type CallHours } from "../config";
import { claimRun, type Db } from "../db";
import { loadAgencyLeads } from "../prospects";
import type { Touch } from "../touches";
import { filterValue, type TwentyClient } from "../twenty";
import { countPush, lastCall, leadPush, quizLead, rankLeads, readNtfy, sendNtfy } from "./helpers";
import { LEAD_CHECK_MS, LEAD_WINDOW_DAYS, MAX_LEAD_PUSHES, MAX_LEADS_PER_CHECK, type LeadCheck, type NtfyTarget, type QuizLead } from "./types";

export * from "./types";
export * from "./helpers";

/** When the last look ran, and the newest lead it has seen (meta keys). */
const LOOKED_KEY = "leads_looked_at";
const SEEN_KEY = "leads_seen_until";
/** A look counts as recent for a little less than a minute, so a cron that fires a moment early still looks. */
const CLAIM_MS = LEAD_CHECK_MS - 5000;

export interface LeadWatchOptions {
  db: Db;
  /** Twenty, read on each look so keys saved in Settings apply. */
  client: () => TwentyClient | undefined;
  /** Where pushes go; COLD_NTFY_URL by default. */
  target?: () => NtfyTarget | undefined;
  /** The app's address, for the link a push opens: "https://cold.example.com/app/". */
  appUrl?: string;
  /** Calling hours, so a push says when a lead can be called; cold.yaml's calls: by default 8am to 9pm. */
  hours?: () => Promise<CallHours>;
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * Watches offer's quiz leads and pushes one alert per new qualified lead, so
 * they get a call while the quiz is fresh. It looks at most once a minute
 * across every server on the database (the look is claimed in it), and only
 * at leads newer than the last one it saw. The first look only marks the
 * time: leads from before alerts were set up are never pushed.
 */
export class LeadWatch {
  private nextAt = 0;

  constructor(private readonly options: LeadWatchOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async tick(): Promise<LeadCheck> {
    const skipped: LeadCheck = { looked: false, alerted: 0, found: 0 };
    const target = (this.options.target ?? (() => readNtfy().target))();
    const client = target ? this.options.client() : undefined;
    if (!target || !client) return skipped;
    const now = this.now();
    if (now.getTime() < this.nextAt) return skipped;
    this.nextAt = now.getTime() + CLAIM_MS;
    if (!(await claimRun(this.options.db, LOOKED_KEY, now, CLAIM_MS))) return skipped;

    const seen = await this.options.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", SEEN_KEY);
    if (!seen) {
      await this.setSeen(now.toISOString());
      return { looked: true, alerted: 0, found: 0 };
    }
    let alerted = 0;
    let found = 0;
    try {
      const hours = (await this.options.hours?.()) ?? DEFAULT_CALL_HOURS;
      const rows = await loadAgencyLeads(client, { where: `createdAt[gt]:${filterValue(seen.value)}`, limit: MAX_LEADS_PER_CHECK });
      const leads = rows
        .map(({ record, prospect }) => quizLead(record, prospect, undefined, { hours, now }))
        .filter((l) => l.createdAt && l.createdAt > seen.value)
        .sort((a, b) => a.createdAt!.localeCompare(b.createdAt!));
      found = leads.length;
      const due = leads.filter((l) => l.qualified && !l.doNotContact);
      const newest = leads.at(-1)?.createdAt;
      const lots = rows.length >= MAX_LEADS_PER_CHECK;
      if (due.length > MAX_LEAD_PUSHES || (lots && due.length)) {
        await sendNtfy(target, countPush(due, this.options.appUrl, lots), this.options.fetch);
        alerted = 1;
        if (newest) await this.setSeen(newest);
        return { looked: true, alerted, found };
      }
      for (const [i, lead] of leads.entries()) {
        if (lead.qualified && !lead.doNotContact) {
          await sendNtfy(target, leadPush(lead, this.options.appUrl), this.options.fetch);
          alerted++;
        }
        // Leads that came in the same millisecond are marked seen together, so a failed push is retried, never skipped.
        if (leads[i + 1]?.createdAt !== lead.createdAt) await this.setSeen(lead.createdAt!);
      }
      return { looked: true, alerted, found };
    } catch (err) {
      return { looked: true, alerted, found, error: (err as Error).message };
    }
  }

  private async setSeen(at: string): Promise<void> {
    await this.options.db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", SEEN_KEY, at);
  }

  /** When the watch last looked, and the newest lead it has seen. */
  async state(): Promise<{ lookedAt?: string; seenUntil?: string }> {
    const rows = await this.options.db.all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key IN (?, ?)", LOOKED_KEY, SEEN_KEY);
    const value = (key: string) => rows.find((r) => r.key === key)?.value;
    return { lookedAt: value(LOOKED_KEY), seenUntil: value(SEEN_KEY) };
  }
}

/**
 * The quiz leads of the last days, best to call first, each with when it was
 * last called. calls gives the touch log's calls since a time.
 */
export async function recentLeads(client: TwentyClient, options: { now: Date; days?: number; hours?: CallHours; calls?: (since: string) => Promise<Touch[]> }): Promise<QuizLead[]> {
  const since = new Date(options.now.getTime() - (options.days ?? LEAD_WINDOW_DAYS) * 86_400_000).toISOString();
  const rows = await loadAgencyLeads(client, { where: `createdAt[gte]:${filterValue(since)}`, limit: 200 });
  const calls = (await options.calls?.(since)) ?? [];
  const clock = { hours: options.hours ?? DEFAULT_CALL_HOURS, now: options.now };
  return rankLeads(rows.map(({ record, prospect }) => quizLead(record, prospect, lastCall(prospect, calls), clock)));
}
