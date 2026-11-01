import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../db";
import { AlreadyScoring, JobStop, ScoreJobs, type ScoreJobSpec, type ScoreProcessor } from "./jobs";

const spec: ScoreJobSpec = { source: "csv:prospects-austin.csv", offer: "booking-pages", deep: false };
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `csv:${i + 1}`, label: `Prospect ${i + 1}` }));

/** A database, a clock that only moves when told, and the jobs runner over them. */
async function setup(process: ScoreProcessor) {
  const db = await openDatabase(":memory:");
  let now = Date.parse("2026-11-02T15:00:00Z");
  const jobs = new ScoreJobs(db, { process, clock: () => now, concurrency: () => 2 });
  return { db, jobs, at: () => now, advance: (ms: number) => (now += ms) };
}

describe("scoring a list on the server", () => {
  test("everyone is scored, a few at a time, and the job finishes", async () => {
    let inFlight = 0;
    let most = 0;
    const { jobs } = await setup(async (_spec, item) => {
      most = Math.max(most, ++inFlight);
      await Bun.sleep(1);
      inFlight--;
      return { status: "done", score: 50 + item.seq, tier: "B" };
    });
    const { id, total } = await jobs.start(spec, people(5));
    expect(total).toBe(5);
    await jobs.tick();
    const view = (await jobs.view(id))!;
    expect(view.status).toBe("done");
    expect(view.counts).toEqual({ pending: 0, working: 0, done: 5, skipped: 0, failed: 0 });
    expect(view.recent).toHaveLength(5);
    expect(view.recent.map((r) => r.score).sort()).toEqual([50, 51, 52, 53, 54]);
    expect(most).toBe(2);
  });

  test("someone left alone is skipped; a failure is tried again, then marked failed with the reason", async () => {
    const tries: Record<string, number> = {};
    const { jobs } = await setup(async (_spec, item) => {
      tries[item.key] = (tries[item.key] ?? 0) + 1;
      if (item.key === "csv:2") return { status: "skipped", note: "Asked not to be contacted." };
      if (item.key === "csv:3" && tries[item.key]! < 3) throw new Error("Anthropic's rate limit was hit.");
      if (item.key === "csv:4") throw new Error("Jev is having trouble (error 503).");
      return { status: "done", score: 70, tier: "A" };
    });
    const { id } = await jobs.start(spec, people(5));
    await jobs.tick();
    const view = (await jobs.view(id))!;
    expect(view.status).toBe("done");
    expect(view.counts).toMatchObject({ done: 3, skipped: 1, failed: 1, pending: 0 });
    expect(tries).toEqual({ "csv:1": 1, "csv:2": 1, "csv:3": 3, "csv:4": 3, "csv:5": 1 });
    expect(view.recent.find((r) => r.label === "Prospect 4")).toMatchObject({ status: "failed", note: "Jev is having trouble (error 503)." });
    expect(view.recent.find((r) => r.label === "Prospect 2")).toMatchObject({ status: "skipped", note: "Asked not to be contacted." });
  });

  test("a problem every prospect would hit ends the job with the reason, without using up anyone's tries", async () => {
    const { db, jobs } = await setup(async () => {
      throw new JobStop("Add a TypeSafe API key or an Anthropic API key in Settings to score prospects.");
    });
    const { id } = await jobs.start(spec, people(4));
    await jobs.tick();
    const view = (await jobs.view(id))!;
    expect(view).toMatchObject({ status: "done", error: "Add a TypeSafe API key or an Anthropic API key in Settings to score prospects.", counts: { pending: 4 } });
    expect(await db.all("SELECT DISTINCT attempts FROM score_job_items WHERE job_id = ?", id)).toEqual([{ attempts: 0 }]);
  });

  test("a function stops starting prospects before its deadline, and the next tick carries on", async () => {
    let clock = () => 0;
    let advance = (_ms: number) => {};
    const s = await setup(async () => {
      advance(60_000);
      return { status: "done", score: 60, tier: "B" };
    });
    clock = s.at;
    advance = s.advance;
    const { id } = await s.jobs.start(spec, people(5));
    // 2.5 minutes left, and two are kept back: room for one round of two.
    await s.jobs.tick({ deadline: clock() + 150_000 });
    let view = (await s.jobs.view(id))!;
    expect(view.status).toBe("running");
    expect(view.counts).toMatchObject({ done: 2, pending: 3 });
    await s.jobs.tick({ deadline: clock() + 3_600_000 });
    view = (await s.jobs.view(id))!;
    expect(view.status).toBe("done");
    expect(view.counts.done).toBe(5);
  });

  test("stop lets the prospects in hand finish, and starts no more", async () => {
    let jobId = "";
    let jobs!: ScoreJobs;
    const s = await setup(async () => {
      await jobs.stop(jobId);
      return { status: "done", score: 40, tier: "C" };
    });
    jobs = s.jobs;
    jobId = (await jobs.start(spec, people(5))).id;
    await jobs.tick();
    const view = (await jobs.view(jobId))!;
    expect(view.status).toBe("stopped");
    expect(view.counts).toMatchObject({ done: 2, pending: 3 });
    expect(await jobs.stop(jobId)).toBe(false);
  });

  test("two runners never work one job at once; one that vanished is taken over after its lease", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const s = await setup(async () => {
      calls++;
      await held;
      return { status: "done", score: 55, tier: "B" };
    });
    const { id } = await s.jobs.start(spec, people(2));
    const first = s.jobs.tick();
    await Bun.sleep(5);
    // A second runner (another function, the next cron tick) finds the job held and leaves it.
    await s.jobs.tick();
    expect(calls).toBe(2);
    release();
    await first;
    expect((await s.jobs.view(id))!.counts.done).toBe(2);

    // A runner that died mid-prospect: once its lease has passed, the prospect goes back in the queue.
    const again = await s.jobs.start({ ...spec, offer: "social-listening" }, people(2));
    await s.db.run("UPDATE score_job_items SET status = 'working', attempts = 1 WHERE job_id = ? AND seq = 0", again.id);
    await s.db.run("UPDATE score_job_items SET status = 'working', attempts = 3 WHERE job_id = ? AND seq = 1", again.id);
    await s.db.run("UPDATE score_jobs SET lease_until = ? WHERE id = ?", new Date(s.at() + 60_000).toISOString(), again.id);
    await s.jobs.tick();
    expect((await s.jobs.view(again.id))!.status).toBe("running");
    s.advance(120_000);
    await s.jobs.tick();
    const view = (await s.jobs.view(again.id))!;
    expect(view.counts).toMatchObject({ done: 1, failed: 1 });
    expect(view.recent.find((r) => r.status === "failed")!.note).toBe("Stopped part-way too many times.");
  });

  test("one job per list and offer at a time", async () => {
    const { jobs } = await setup(async () => ({ status: "done" }));
    const first = await jobs.start(spec, people(2));
    const err = await jobs.start(spec, people(2)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AlreadyScoring);
    expect((err as AlreadyScoring).jobId).toBe(first.id);
    expect((await jobs.start({ ...spec, offer: "social-listening" }, people(2))).total).toBe(2);
    expect((await jobs.recent(spec)).map((j) => j.id)).toEqual([first.id]);
  });
});
