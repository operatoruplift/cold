import { describe, expect, test } from "bun:test";
import type { Message, Sequence } from "../../messages";
import { fromCsvRow, type Prospect } from "../../prospects";
import type { Touch } from "../types";
import { planSequence, suppressionReason } from "./planSequence";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-02T15:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();

const step = (n: number, day: number): Message => ({
  id: `email/personal/founder-direct/${n}-x`,
  file: "",
  channel: "email",
  voice: "personal",
  sequence: "email/personal/founder-direct",
  step: n,
  day,
  title: `Step ${n}`,
  allowLinks: false,
  customVariables: [],
  body: "Hi",
});
const sequence: Sequence = { id: "email/personal/founder-direct", channel: "email", voice: "personal", steps: [step(1, 0), step(2, 3), step(3, 7), step(4, 14)] };

const prospect = (id: string, email: string, extra: string[] = []): Prospect =>
  fromCsvRow(["id", "first_name", "email", ...extra.map((_, i) => `x${i}`)], [id, "Dana", email, ...extra], 0);

const sent = (p: Prospect, stepNo: number, daysAgo: number, seq = sequence.id): Touch => ({
  kind: "SENT",
  channel: "EMAIL",
  sequence: seq,
  step: stepNo,
  prospectKey: p.key,
  toAddress: p.email,
  occurredAt: ago(daysAgo),
});

const plan = (prospects: Prospect[], history: Touch[], suppressions: Touch[] = []) =>
  planSequence({ sequence, channel: "EMAIL", prospects, history, suppressions, now, reachable: (p) => p.email });

describe("planSequence", () => {
  test("a new prospect gets step 1", () => {
    const p = prospect("a", "a@x.example");
    const result = plan([p], []);
    expect(result.due.map((d) => [d.prospect.key, d.step.step, d.address])).toEqual([["email:a@x.example", 1, "a@x.example"]]);
  });

  test("step 2 waits until its day, counted from step 1", () => {
    const p = prospect("a", "a@x.example");
    const early = plan([p], [sent(p, 1, 2)]);
    expect(early.due).toEqual([]);
    expect(early.waiting[0]!.step.step).toBe(2);
    expect(early.waiting[0]!.dueAt.toISOString()).toBe(new Date(new Date(ago(2)).getTime() + 3 * DAY).toISOString());
    const onTime = plan([p], [sent(p, 1, 3)]);
    expect(onTime.due[0]!.step.step).toBe(2);
    expect(onTime.due[0]!.previous!.step).toBe(1);
  });

  test("a late step keeps the gap to the next one", () => {
    const p = prospect("a", "a@x.example");
    // Step 1 ten days ago, step 2 sent late yesterday: step 3 (day 7) still waits 4 days after step 2.
    const result = plan([p], [sent(p, 1, 10), sent(p, 2, 1)]);
    expect(result.due).toEqual([]);
    expect(result.waiting[0]!.step.step).toBe(3);
  });

  test("a reply, a bounce or an opt-out ends the sequence", () => {
    const p = prospect("a", "a@x.example");
    for (const kind of ["REPLIED", "BOUNCED", "OPTED_OUT"] as const) {
      const result = plan([p], [sent(p, 1, 5), { ...sent(p, 1, 4), kind }]);
      expect(result.due).toEqual([]);
      expect(result.skipped[0]!.reason).toMatch(/replied|bounced|opted out/);
    }
  });

  test("the last step finishes it", () => {
    const p = prospect("a", "a@x.example");
    expect(plan([p], [sent(p, 1, 20), sent(p, 2, 17), sent(p, 3, 13), sent(p, 4, 6)]).skipped[0]!.reason).toBe("finished the sequence");
  });

  test("suppressed prospects are skipped: Do Not Contact, opted out anywhere, bounced", () => {
    const p = prospect("a", "a@x.example");
    const dnc = { ...prospect("b", "b@x.example"), doNotContact: true };
    const optOut: Touch = { kind: "OPTED_OUT", channel: "LINKEDIN", prospectKey: p.key, occurredAt: ago(90) };
    const result = plan([p, dnc], [], [optOut]);
    expect(result.due).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["opted out", "marked Do Not Contact"]);
    const bounce: Touch = { kind: "BOUNCED", channel: "EMAIL", prospectKey: "csv:old", toAddress: "a@x.example", occurredAt: ago(30) };
    expect(suppressionReason(p, [bounce], "EMAIL")).toBe("email bounced");
    expect(suppressionReason(p, [bounce], "LINKEDIN")).toBeUndefined();
  });

  test("history matches on any identity, including the email address", () => {
    const p = prospect("a", "a@x.example");
    const underOldKey: Touch = { ...sent(p, 1, 5), prospectKey: "person:123" };
    expect(plan([p], [underOldKey]).due[0]!.step.step).toBe(2);
  });

  test("no new sequence within 30 days of another on the same channel", () => {
    const p = prospect("a", "a@x.example");
    const other = sent(p, 1, 10, "email/company/problem-proof");
    expect(plan([p], [other]).skipped[0]!.reason).toBe("already in email/company/problem-proof");
    expect(plan([p], [sent(p, 1, 45, "email/company/problem-proof")]).due.length).toBe(1);
  });

  test("a reply anywhere in the last 90 days holds every new sequence", () => {
    const p = prospect("a", "a@x.example");
    const reply: Touch = { kind: "REPLIED", channel: "LINKEDIN", sequence: "dm/personal/linkedin", prospectKey: p.key, occurredAt: ago(20) };
    expect(plan([p], [reply]).skipped[0]!.reason).toMatch(/^replied on .*dm\/personal\/linkedin.*by hand$/);
    expect(plan([p], [{ ...reply, occurredAt: ago(120) }]).due.length).toBe(1);
  });

  test("prospects without an address are skipped with a reason", () => {
    const p = prospect("a", "");
    expect(plan([p], []).skipped[0]!.reason).toBe("no email address");
  });
});
