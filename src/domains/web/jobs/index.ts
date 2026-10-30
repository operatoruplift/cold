import { randomUUID } from "node:crypto";
import type { EmailRunResult } from "../../email";
import type { JobEvent, JobEventInput, JobResponse } from "../types";

/** What a running job can do: report, notice a stop, and wait without blocking a stop. */
export interface JobHandle {
  emit(event: JobEventInput): void;
  shouldStop(): boolean;
  sleep(ms: number): Promise<void>;
}

interface Job {
  id: string;
  /** e.g. the account key: one email job per account at a time. */
  lane: string;
  status: "running" | "done";
  events: JobEvent[];
  result?: EmailRunResult;
  stopRequested: boolean;
  wake?: () => void;
}

/** Background email sends, kept in memory while the UI server runs. */
export class JobRegistry {
  private readonly jobs = new Map<string, Job>();

  running(lane: string): Job | undefined {
    return [...this.jobs.values()].find((j) => j.lane === lane && j.status === "running");
  }

  start(lane: string, run: (handle: JobHandle) => Promise<EmailRunResult>): string {
    const job: Job = { id: randomUUID().slice(0, 8), lane, status: "running", events: [], stopRequested: false };
    this.jobs.set(job.id, job);
    const handle: JobHandle = {
      emit: (event) => job.events.push({ ...event, at: new Date().toISOString() } as JobEvent),
      shouldStop: () => job.stopRequested,
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(done, ms);
          function done() {
            clearTimeout(timer);
            job.wake = undefined;
            resolve();
          }
          job.wake = done;
        }),
    };
    run(handle)
      .then((result) => {
        job.result = result;
      })
      .catch((err: Error) => {
        handle.emit({ type: "error", reason: err.message });
        job.result = { sent: 0, failed: 0, skipped: 0, aborted: err.message };
      })
      .finally(() => {
        job.status = "done";
      });
    return job.id;
  }

  /** Ask a job to stop: it finishes the email in flight, logs it, and stops before the next. */
  stop(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return false;
    job.stopRequested = true;
    job.wake?.();
    return true;
  }

  view(id: string, after = 0): JobResponse | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    return { id: job.id, status: job.status, events: job.events.slice(after), next: job.events.length, result: job.result };
  }
}
