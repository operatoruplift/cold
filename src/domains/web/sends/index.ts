import { randomUUID } from "node:crypto";
import type { Db, Statement } from "../../db";
import { newSendState, sendResult, sendStep, type MailTransport, type SendPlan, type SendState, type Verifier } from "../../email";
import type { TouchStore } from "../../touches";
import type { JobEventInput, JobResponse } from "../types";

/** What a send needs when it runs, opened fresh each time it picks up: the touch log, the mailbox, the address checker. */
export interface SendTools {
  store: TouchStore;
  transport: MailTransport;
  verifier?: Verifier;
}

export interface SendJobsOptions {
  tools: (plan: SendPlan) => Promise<SendTools>;
  /** The time touches and the sending window see (tests fix it). */
  now?: () => Date;
  random?: () => number;
  /** Real time, for waiting between emails. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface JobRow {
  id: string;
  lane: string;
  status: "running" | "done";
  plan: string;
  state: string;
  next_at: string;
  lease_until: string | null;
  stop_requested: number;
}

type StoredPlan = SendPlan & { ignoreWindow: boolean };

/** How long a runner holds a send between check-ins; another takes over after that if it vanished. */
const LEASE_MS = 2 * 60_000;
/** Time kept back before a function's deadline: enough to send one email and save it. */
const MARGIN_MS = 75_000;
/** A waiting send checks for a stop this often. */
const SLICE_MS = 5_000;

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Email sends kept in the database, so they outlive the server: one email at
 * a time, the state saved after each, the pause between emails waited out
 * here when it fits, or left for the next tick. On your computer a timer
 * ticks every few seconds; on Vercel the cron job does, every minute.
 */
export class SendJobs {
  /** Sends this server is waiting on, to cut a pause short when you stop one. */
  private readonly waiting = new Map<string, () => void>();

  constructor(
    private readonly db: Db,
    private readonly options: SendJobsOptions,
  ) {}

  private clock(): number {
    return this.options.clock?.() ?? Date.now();
  }

  /** Queue a send. One at a time per lane (an account): a second gets an error. */
  async start(lane: string, plan: SendPlan, ignoreWindow: boolean): Promise<string> {
    const id = randomUUID().slice(0, 8);
    const at = iso(this.clock());
    try {
      await this.db.run(
        "INSERT INTO send_jobs (id, lane, status, plan, state, next_at, created_at, updated_at) VALUES (?, ?, 'running', ?, ?, ?, ?, ?)",
        id,
        lane,
        JSON.stringify({ ...plan, ignoreWindow } satisfies StoredPlan),
        JSON.stringify(newSendState()),
        at,
        at,
        at,
      );
    } catch (err) {
      if (/unique/i.test((err as Error).message)) throw new Error(`Already sending from ${lane}. Wait for it to finish, or stop it.`);
      throw err;
    }
    return id;
  }

  async running(lane: string): Promise<string | undefined> {
    return (await this.db.get<{ id: string }>("SELECT id FROM send_jobs WHERE lane = ? AND status = 'running'", lane))?.id;
  }

  async view(id: string, after = 0): Promise<JobResponse | undefined> {
    const row = await this.db.get<JobRow>("SELECT * FROM send_jobs WHERE id = ?", id);
    if (!row) return undefined;
    const events = await this.db.all<{ seq: number; at: string; event: string }>("SELECT seq, at, event FROM send_events WHERE job_id = ? AND seq >= ? ORDER BY seq", id, after);
    return {
      id,
      status: row.status,
      events: events.map((e) => ({ ...(JSON.parse(e.event) as JobEventInput), at: e.at })),
      next: events.length ? events.at(-1)!.seq + 1 : after,
      result: row.status === "done" ? sendResult(JSON.parse(row.state) as SendState) : undefined,
    };
  }

  /** Ask a send to stop: the email in flight finishes and is logged, nothing after it goes out. */
  async stop(id: string): Promise<boolean> {
    const changed = await this.db.run("UPDATE send_jobs SET stop_requested = 1, next_at = ?, updated_at = ? WHERE id = ? AND status = 'running'", iso(this.clock()), iso(this.clock()), id);
    this.waiting.get(id)?.();
    return changed.changes > 0;
  }

  /**
   * Work on sends that are due by now (plus `lookaheadMs`, waited out here)
   * until the deadline, then put them back for the next tick.
   */
  async tick(options: { deadline?: number; lookaheadMs?: number } = {}): Promise<void> {
    const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
    for (;;) {
      if (this.clock() > deadline - MARGIN_MS) return;
      // Never claim one that would only be put back: it has to be due before this run must stop.
      const job = await this.claim(Math.min(this.clock() + (options.lookaheadMs ?? 0), deadline - MARGIN_MS), deadline);
      if (!job) return;
      await this.work(job, deadline);
    }
  }

  private leaseUntil(deadline: number): string {
    return iso(Math.min(deadline, this.clock() + LEASE_MS));
  }

  private claim(dueBy: number, deadline: number): Promise<JobRow | undefined> {
    const now = iso(this.clock());
    return this.db.get<JobRow>(
      `UPDATE send_jobs SET lease_until = ?
       WHERE id = (SELECT id FROM send_jobs WHERE status = 'running' AND next_at <= ? AND (lease_until IS NULL OR lease_until < ?) ORDER BY next_at LIMIT 1)
         AND (lease_until IS NULL OR lease_until < ?)
       RETURNING *`,
      this.leaseUntil(deadline),
      iso(dueBy),
      now,
      now,
    );
  }

  /** Wait out a pause in slices, holding on to the send and noticing a stop. True when a stop came in. */
  private async pause(id: string, ms: number, deadline: number): Promise<boolean> {
    const until = this.clock() + ms;
    const sleep = this.options.sleep ?? ((wait: number) => new Promise<void>((resolve) => setTimeout(resolve, wait)));
    while (this.clock() < until) {
      const slice = Math.min(SLICE_MS, until - this.clock());
      await Promise.race([sleep(slice), new Promise<void>((resolve) => this.waiting.set(id, resolve))]);
      this.waiting.delete(id);
      const row = await this.db.get<{ stop_requested: number }>("UPDATE send_jobs SET lease_until = ? WHERE id = ? RETURNING stop_requested", this.leaseUntil(deadline), id);
      if (!row || row.stop_requested) return true;
    }
    return false;
  }

  private async work(row: JobRow, deadline: number): Promise<void> {
    const plan = JSON.parse(row.plan) as StoredPlan;
    let state = JSON.parse(row.state) as SendState;
    let nextAt = Date.parse(row.next_at);
    let seq = (await this.db.get<{ next: number }>("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM send_events WHERE job_id = ?", row.id))!.next;
    const eventRows = (events: JobEventInput[]): Statement[] => events.map((event) => ["INSERT INTO send_events (job_id, seq, at, event) VALUES (?, ?, ?, ?)", row.id, seq++, iso(this.clock()), JSON.stringify(event)]);
    let tools: SendTools | undefined;
    try {
      for (;;) {
        const wait = nextAt - this.clock();
        if (wait > 0) {
          if (this.clock() + wait > deadline - MARGIN_MS) {
            // Not before this function has to stop: leave it for the next tick.
            await this.db.run("UPDATE send_jobs SET lease_until = NULL WHERE id = ?", row.id);
            return;
          }
          await this.pause(row.id, wait, deadline);
        }
        if (this.clock() > deadline - MARGIN_MS) {
          await this.db.run("UPDATE send_jobs SET lease_until = NULL WHERE id = ?", row.id);
          return;
        }
        tools ??= await this.options.tools(plan);
        const events: JobEventInput[] = [];
        const step = await sendStep(plan, state, {
          ...tools,
          ignoreWindow: plan.ignoreWindow,
          now: () => this.options.now?.() ?? new Date(),
          random: this.options.random ?? Math.random,
          log: () => {},
          emit: (event) => events.push(event),
          shouldStop: async () => !!(await this.db.get<{ stop_requested: number }>("SELECT stop_requested FROM send_jobs WHERE id = ?", row.id))?.stop_requested,
          beforeSend: async (inflight) => void (await this.db.run("UPDATE send_jobs SET state = ?, lease_until = ?, updated_at = ? WHERE id = ?", JSON.stringify(inflight), this.leaseUntil(deadline), iso(this.clock()), row.id)),
        });
        state = step.state;
        nextAt = this.clock() + step.waitMs;
        await this.db.batch([
          [
            "UPDATE send_jobs SET state = ?, status = ?, next_at = ?, lease_until = ?, updated_at = ? WHERE id = ?",
            JSON.stringify(state),
            state.done ? "done" : "running",
            iso(nextAt),
            state.done ? null : this.leaseUntil(deadline),
            iso(this.clock()),
            row.id,
          ],
          ...eventRows(events),
        ]);
        if (state.done) return;
      }
    } catch (err) {
      // Something outside the send itself broke (the database, the touch log): end it in words, rather than retry forever.
      const reason = (err as Error).message ?? String(err);
      await this.db.batch([
        ["UPDATE send_jobs SET state = ?, status = 'done', lease_until = NULL, updated_at = ? WHERE id = ?", JSON.stringify({ ...state, done: true, aborted: reason }), iso(this.clock()), row.id],
        ...eventRows([{ type: "error", reason }]),
      ]);
    } finally {
      tools?.transport.close?.();
    }
  }
}
