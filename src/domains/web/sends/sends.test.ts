import { describe, expect, test } from "bun:test";
import type { Account } from "../../config";
import { openDatabase, type Db } from "../../db";
import type { EmailDraft, MailTransport, SendPlan } from "../../email";
import { DbStore } from "../../touches";
import { SendJobs } from ".";

const account = {
  key: "personal",
  voice: "personal",
  variables: {},
  dm: { dailyCaps: {} },
  email: { from: "Alex Morgan <alex@brightside.example>", smtpUrlEnv: "SMTP_URL_TEST", dailyCap: 50, minDelaySeconds: 120, maxDelaySeconds: 120, footer: "123 Example St" },
} as unknown as Account;

const plan = (count: number): SendPlan => ({
  sequenceId: "email/personal/founder-direct",
  account,
  items: Array.from({ length: count }, (_, i) => ({
    step: 1,
    templateId: "email/personal/founder-direct/1-first-touch",
    prospectKey: `csv:${i + 1}`,
    prospectLabel: `Prospect ${i + 1}`,
    address: `p${i + 1}@example.com`,
    draft: { from: account.email!.from, to: `p${i + 1}@example.com`, subject: "hi", text: "hello", messageId: `<${i}@brightside.example>`, headers: {} },
  })),
});

/** A clock that only moves when the runner waits, and a mailbox that keeps what it gets. */
async function setup() {
  const db = await openDatabase(":memory:");
  let now = Date.parse("2026-11-02T15:00:00Z");
  const sent: EmailDraft[] = [];
  const transport: MailTransport = { verify: async () => true, sendMail: async (draft) => void sent.push(draft) };
  const jobs = new SendJobs(db, {
    tools: async () => ({ store: new DbStore(db), transport }),
    clock: () => now,
    now: () => new Date(now),
    random: () => 0.5,
    sleep: async (ms) => {
      now += ms;
    },
  });
  return { db, jobs, sent, advance: (ms: number) => (now += ms), at: () => now };
}

const touches = async (db: Db) => (await db.all<{ kind: string; prospect_key: string }>("SELECT kind, prospect_key FROM touches ORDER BY id")).map((t) => `${t.kind} ${t.prospect_key}`);

describe("sends that outlive the server", () => {
  test("on your computer a send runs to the end, waiting out each pause", async () => {
    const { db, jobs, sent } = await setup();
    const id = await jobs.start("personal", plan(3), false);
    await jobs.tick();
    expect(sent.map((d) => d.to)).toEqual(["p1@example.com", "p2@example.com", "p3@example.com"]);
    const view = (await jobs.view(id))!;
    expect(view.status).toBe("done");
    expect(view.result).toEqual({ sent: 3, failed: 0, skipped: 0 });
    expect(view.events.map((e) => e.type)).toEqual(["sent", "pause", "sent", "pause", "sent"]);
    expect(await touches(db)).toEqual(["SENT csv:1", "SENT csv:2", "SENT csv:3"]);
  });

  test("on Vercel each function stops before its deadline, and the next tick carries on where it left off", async () => {
    const { jobs, sent, at } = await setup();
    const id = await jobs.start("personal", plan(3), false);
    // A function with 150 seconds left: room for the first email, not for the two-minute pause.
    await jobs.tick({ deadline: at() + 150_000 });
    expect(sent.length).toBe(1);
    expect((await jobs.view(id))!.status).toBe("running");
    // A minute later, a cron tick that can look a minute ahead: the email isn't due yet.
    await jobs.tick({ deadline: at() + 800_000, lookaheadMs: 0 });
    expect(sent.length).toBe(1);
    await jobs.tick({ deadline: at() + 800_000, lookaheadMs: 120_000 });
    expect(sent.length).toBe(3);
    const view = (await jobs.view(id, 2))!;
    expect(view.status).toBe("done");
    expect(view.events.map((e) => e.type)).toEqual(["sent", "pause", "sent"]);
  });

  test("a stop ends a send in its pause: nothing after it goes out", async () => {
    const { jobs, sent, at } = await setup();
    const id = await jobs.start("personal", plan(3), false);
    await jobs.tick({ deadline: at() + 150_000 });
    expect(await jobs.stop(id)).toBe(true);
    await jobs.tick({ deadline: at() + 800_000 });
    expect(sent.length).toBe(1);
    const view = (await jobs.view(id))!;
    expect(view.status).toBe("done");
    expect(view.result?.aborted).toContain("stopped by you; 2 left");
    expect(await jobs.stop(id)).toBe(false);
  });

  test("an email that was going out when the server stopped is never sent twice", async () => {
    const { db, jobs, sent } = await setup();
    const id = await jobs.start("personal", plan(2), false);
    // As if the server died after marking the first email in flight, before it was saved as sent.
    await db.run("UPDATE send_jobs SET state = ? WHERE id = ?", JSON.stringify({ index: 0, sent: 0, failed: 0, skipped: 0, failuresInARow: 0, verified: true, inflight: 0, done: false }), id);
    await jobs.tick();
    expect(sent.map((d) => d.to)).toEqual(["p2@example.com"]);
    const view = (await jobs.view(id))!;
    expect(view.result).toEqual({ sent: 1, failed: 0, skipped: 1 });
    expect(view.events[0]).toMatchObject({ type: "skipped", address: "p1@example.com" });
  });

  test("one send at a time per account", async () => {
    const { jobs } = await setup();
    await jobs.start("personal", plan(1), false);
    expect(await jobs.running("personal")).toBeDefined();
    await expect(jobs.start("personal", plan(1), false)).rejects.toThrow("Already sending from personal");
    await jobs.start("company", plan(1), false);
    await jobs.tick();
    expect(await jobs.running("personal")).toBeUndefined();
  });

  test("a send that cannot open its touch log ends with the reason, rather than retrying forever", async () => {
    const db = await openDatabase(":memory:");
    const jobs = new SendJobs(db, {
      tools: async () => {
        throw new Error("Twenty is down");
      },
    });
    const id = await jobs.start("personal", plan(1), false);
    await jobs.tick();
    const view = (await jobs.view(id))!;
    expect(view.status).toBe("done");
    expect(view.events).toEqual([expect.objectContaining({ type: "error", reason: "Twenty is down" })]);
  });
});
