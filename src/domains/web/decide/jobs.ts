import { randomUUID } from "node:crypto";
import type { Db, Statement } from "../../db";
import type { Tier } from "../../decide";
import type { ScoreJobView } from "../types";

/** What a scoring job works through: one list, for one offer, optionally reading each site first. */
export interface ScoreJobSpec {
  source: string;
  offer: string;
  account?: string;
  /** Run diligence first for anyone who has none yet. */
  deep: boolean;
}

export interface ScoreItem {
  seq: number;
  key: string;
  label: string;
  /** This try included. */
  attempts: number;
}

export interface ItemOutcome {
  status: "done" | "skipped";
  note?: string;
  score?: number;
  tier?: Tier;
}

/** Score one prospect. Throw JobStop when no prospect could be scored (no key, no config): the job ends with the reason. Anything else thrown is tried again. */
export type ScoreProcessor = (spec: ScoreJobSpec, item: ScoreItem) => Promise<ItemOutcome>;

/** A reason that would stop every prospect the same way, so the job ends instead of failing each one. */
export class JobStop extends Error {}

/** A list already being scored for this offer. */
export class AlreadyScoring extends Error {
  constructor(readonly jobId: string) {
    super("This list is already being scored for this offer.");
  }
}

interface JobRow {
  id: string;
  lane: string;
  status: ScoreJobView["status"];
  spec: string;
  total: number;
  error: string | null;
  lease_until: string | null;
  stop_requested: number;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  seq: number;
  prospect_key: string;
  label: string;
  status: "pending" | "working" | "done" | "skipped" | "failed";
  attempts: number;
  note: string | null;
  score: number | null;
  tier: Tier | null;
}

/** A job holds its list this long between check-ins; longer than one site read and score, so nobody else takes over mid-prospect. */
const LEASE_MS = 10 * 60_000;
/** Tries per prospect before it is marked failed. */
export const MAX_ATTEMPTS = 3;
/** The most prospects one job takes on. */
export const MAX_PROSPECTS = 500;
/** Time kept back before a function's deadline: room to finish the prospects in hand. */
const marginMs = (spec: ScoreJobSpec) => (spec.deep ? 5 : 2) * 60_000;

const iso = (ms: number) => new Date(ms).toISOString();
const laneOf = (spec: ScoreJobSpec) => `${spec.source}|${spec.offer}`;

/**
 * Scoring jobs kept in the database, so a list of hundreds is scored on the
 * server: a few prospects at a time, each one saved as it finishes, the job
 * held by one runner at a time and picked up again after a restart. On your
 * computer a timer ticks every few seconds; on Vercel the request that starts
 * a job begins it and the cron job carries it on, every minute.
 */
export class ScoreJobs {
  constructor(
    private readonly db: Db,
    private readonly options: { process: ScoreProcessor; clock?: () => number; concurrency?: (spec: ScoreJobSpec) => number },
  ) {}

  private clock(): number {
    return this.options.clock?.() ?? Date.now();
  }

  /** Queue a list. One job per list and offer at a time. */
  async start(spec: ScoreJobSpec, prospects: Array<{ key: string; label: string }>): Promise<{ id: string; total: number }> {
    const list = prospects.slice(0, MAX_PROSPECTS);
    const id = randomUUID().slice(0, 8);
    const at = iso(this.clock());
    try {
      await this.db.run(
        "INSERT INTO score_jobs (id, lane, status, spec, total, created_at, updated_at) VALUES (?, ?, 'running', ?, ?, ?, ?)",
        id,
        laneOf(spec),
        JSON.stringify(spec),
        list.length,
        at,
        at,
      );
    } catch (err) {
      if (/unique/i.test((err as Error).message)) {
        const running = await this.db.get<{ id: string }>("SELECT id FROM score_jobs WHERE lane = ? AND status = 'running'", laneOf(spec));
        throw new AlreadyScoring(running?.id ?? "");
      }
      throw err;
    }
    const items: Statement[] = list.map((p, seq) => ["INSERT INTO score_job_items (job_id, seq, prospect_key, label, status) VALUES (?, ?, ?, ?, 'pending')", id, seq, p.key, p.label]);
    for (let i = 0; i < items.length; i += 200) await this.db.batch(items.slice(i, i + 200));
    return { id, total: list.length };
  }

  async view(id: string): Promise<ScoreJobView | undefined> {
    const row = await this.db.get<JobRow>("SELECT * FROM score_jobs WHERE id = ?", id);
    return row ? this.describe(row) : undefined;
  }

  /** The latest jobs for one list and offer, newest first. */
  async recent(spec: Pick<ScoreJobSpec, "source" | "offer">, limit = 3): Promise<ScoreJobView[]> {
    const rows = await this.db.all<JobRow>("SELECT * FROM score_jobs WHERE lane = ? ORDER BY created_at DESC LIMIT ?", laneOf({ ...spec, deep: false }), limit);
    return Promise.all(rows.map((r) => this.describe(r)));
  }

  private async describe(row: JobRow): Promise<ScoreJobView> {
    const spec = JSON.parse(row.spec) as ScoreJobSpec;
    const counts = { pending: 0, working: 0, done: 0, skipped: 0, failed: 0 };
    for (const c of await this.db.all<{ status: ItemRow["status"]; n: number }>("SELECT status, COUNT(*) AS n FROM score_job_items WHERE job_id = ? GROUP BY status", row.id)) counts[c.status] = c.n;
    const recent = await this.db.all<ItemRow>("SELECT * FROM score_job_items WHERE job_id = ? AND status IN ('done', 'skipped', 'failed') ORDER BY updated_at DESC, seq DESC LIMIT 6", row.id);
    return {
      id: row.id,
      status: row.status,
      source: spec.source,
      offer: spec.offer,
      deep: spec.deep,
      total: row.total,
      counts,
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      recent: recent.map((i) => ({ label: i.label, status: i.status as "done" | "skipped" | "failed", note: i.note ?? undefined, score: i.score ?? undefined, tier: i.tier ?? undefined })),
    };
  }

  /** Ask a job to stop: the prospects in hand finish and are saved, no new ones start. */
  async stop(id: string): Promise<boolean> {
    return (await this.db.run("UPDATE score_jobs SET stop_requested = 1, updated_at = ? WHERE id = ? AND status = 'running'", iso(this.clock()), id)).changes > 0;
  }

  /** Work on running jobs until the deadline, then leave them for the next tick. */
  async tick(options: { deadline?: number } = {}): Promise<void> {
    const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
    for (;;) {
      if (this.clock() > deadline - marginMs({ source: "", offer: "", deep: false })) return;
      const job = await this.claim(deadline);
      if (!job) return;
      const spec = JSON.parse(job.spec) as ScoreJobSpec;
      if (this.clock() > deadline - marginMs(spec)) {
        await this.release(job.id);
        return;
      }
      await this.work(job.id, spec, deadline);
    }
  }

  private leaseUntil(deadline: number): string {
    return iso(Math.min(deadline, this.clock() + LEASE_MS));
  }

  private claim(deadline: number): Promise<JobRow | undefined> {
    const now = iso(this.clock());
    return this.db.get<JobRow>(
      `UPDATE score_jobs SET lease_until = ?
       WHERE id = (SELECT id FROM score_jobs WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?) ORDER BY created_at LIMIT 1)
         AND (lease_until IS NULL OR lease_until < ?)
       RETURNING *`,
      this.leaseUntil(deadline),
      now,
      now,
    );
  }

  private release(id: string): Promise<{ changes: number }> {
    return this.db.run("UPDATE score_jobs SET lease_until = NULL WHERE id = ?", id);
  }

  private finish(id: string, status: "done" | "stopped", error?: string): Promise<{ changes: number }> {
    return this.db.run("UPDATE score_jobs SET status = ?, error = ?, lease_until = NULL, updated_at = ? WHERE id = ?", status, error ?? null, iso(this.clock()), id);
  }

  private async work(id: string, spec: ScoreJobSpec, deadline: number): Promise<void> {
    // A runner that vanished left prospects half-done: back in the queue, unless they have had their tries.
    await this.db.batch([
      ["UPDATE score_job_items SET status = 'failed', note = ? WHERE job_id = ? AND status = 'working' AND attempts >= ?", "Stopped part-way too many times.", id, MAX_ATTEMPTS],
      ["UPDATE score_job_items SET status = 'pending' WHERE job_id = ? AND status = 'working'", id],
    ]);
    const size = this.options.concurrency?.(spec) ?? (spec.deep ? 2 : 3);
    for (;;) {
      if (this.clock() > deadline - marginMs(spec)) {
        await this.release(id);
        return;
      }
      if ((await this.db.get<{ stop_requested: number }>("SELECT stop_requested FROM score_jobs WHERE id = ?", id))?.stop_requested) {
        await this.finish(id, "stopped");
        return;
      }
      // Fewest tries first, so a prospect that just failed goes to the back of the line.
      const batch = await this.db.all<ItemRow>("SELECT * FROM score_job_items WHERE job_id = ? AND status = 'pending' ORDER BY attempts, seq LIMIT ?", id, size);
      if (!batch.length) {
        await this.finish(id, "done");
        return;
      }
      const at = iso(this.clock());
      await this.db.batch([
        ...batch.map((i): Statement => ["UPDATE score_job_items SET status = 'working', attempts = attempts + 1, updated_at = ? WHERE job_id = ? AND seq = ?", at, id, i.seq]),
        ["UPDATE score_jobs SET lease_until = ?, updated_at = ? WHERE id = ?", this.leaseUntil(deadline), at, id],
      ]);
      let stopped: string | undefined;
      const outcomes = await Promise.all(
        batch.map(async (i) => {
          const item: ScoreItem = { seq: i.seq, key: i.prospect_key, label: i.label, attempts: i.attempts + 1 };
          try {
            return await this.options.process(spec, item);
          } catch (err) {
            const note = ((err as Error).message ?? String(err)).slice(0, 300);
            if (err instanceof JobStop) {
              stopped = note;
              return { status: "pending" as const, note: undefined };
            }
            return { status: item.attempts >= MAX_ATTEMPTS ? ("failed" as const) : ("pending" as const), note };
          }
        }),
      );
      const done = iso(this.clock());
      await this.db.batch(
        batch.map((i, n): Statement => {
          const o = outcomes[n]!;
          // A job-wide stop doesn't use up this prospect's tries.
          const attempts = stopped && o.status === "pending" && !o.note ? i.attempts : i.attempts + 1;
          return ["UPDATE score_job_items SET status = ?, attempts = ?, note = ?, score = ?, tier = ?, updated_at = ? WHERE job_id = ? AND seq = ?", o.status, attempts, o.note ?? null, "score" in o ? (o.score ?? null) : null, "tier" in o ? (o.tier ?? null) : null, done, id, i.seq];
        }),
      );
      if (stopped) {
        await this.finish(id, "done", stopped);
        return;
      }
    }
  }
}
