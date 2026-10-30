import { describe, expect, test } from "bun:test";
import type { Message, Sequence } from "../../messages";
import { fromCsvRow, type Prospect } from "../../prospects";
import type { Touch } from "../types";
import { addDays, localDay } from "./localDay";
import { planSequence, suppressionReason } from "./planSequence";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-02T15:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();

const step = (n: number, day: number, seq = "email/personal/founder-direct"): Message => ({
  id: `${seq}/${n}-x`,
  file: "",
  channel: "email",
  voice: "personal",
  sequence: seq,
  step: n,
  day,
  title: `Step ${n}`,
  allowLinks: false,
  customVariables: [],
  body: "Hi",
});
const sequence: Sequence = { id: "email/personal/founder-direct", channel: "email", voice: "personal", steps: [step(1, 0), step(2, 3), step(3, 7), step(4, 14)] };

const prospect = (id: string, email: string, name = "Dana"): Prospect => fromCsvRow(["id", "first_name", "email"], [id, name, email], 0);

const sent = (p: Prospect, stepNo: number, at: string, seq = sequence.id): Touch => ({
  kind: "SENT",
  channel: "EMAIL",
  sequence: seq,
  step: stepNo,
  prospectKey: p.key,
  toAddress: p.email,
  occurredAt: at,
});

const plan = (prospects: Prospect[], history: Touch[], suppressions: Touch[] = [], at = now, timeZone = "UTC") =>
  planSequence({ sequence, channel: "EMAIL", prospects, history, suppressions, now: at, reachable: (p) => p.email, timeZone });

describe("localDay", () => {
  test("is the calendar date in the timezone", () => {
    expect(localDay(new Date("2026-11-03T03:30:00Z"), "America/Chicago")).toBe("2026-11-02");
    expect(localDay(new Date("2026-11-03T03:30:00Z"), "UTC")).toBe("2026-11-03");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
  });
});

describe("planSequence", () => {
  test("a new prospect gets step 1", () => {
    const p = prospect("a", "a@x.example");
    expect(plan([p], []).due.map((d) => [d.prospect.key, d.step.step, d.address])).toEqual([["email:a@x.example", 1, "a@x.example"]]);
  });

  test("step 2 falls due on calendar day 3, whatever the hour", () => {
    const p = prospect("a", "a@x.example");
    // Step 1 went out Monday 09:45 Chicago; Thursday's 09:00 run sends step 2.
    const monday = "2026-11-02T15:45:00Z";
    const thursdayMorning = new Date("2026-11-05T15:00:00Z");
    const wednesday = new Date("2026-11-04T22:00:00Z");
    expect(plan([p], [sent(p, 1, monday)], [], thursdayMorning, "America/Chicago").due[0]!.step.step).toBe(2);
    const early = plan([p], [sent(p, 1, monday)], [], wednesday, "America/Chicago");
    expect(early.due).toEqual([]);
    expect(early.waiting[0]).toMatchObject({ dueOn: "2026-11-05" });
  });

  test("a late step keeps the gap to the next one", () => {
    const p = prospect("a", "a@x.example");
    // Step 1 ten days ago, step 2 sent late yesterday: step 3 (day 7) waits 4 days after step 2.
    const result = plan([p], [sent(p, 1, ago(10)), sent(p, 2, ago(1))]);
    expect(result.due).toEqual([]);
    expect(result.waiting[0]).toMatchObject({ dueOn: addDays(localDay(ago(1), "UTC"), 4) });
  });

  test("a reply, a bounce or an opt-out ends the sequence", () => {
    const p = prospect("a", "a@x.example");
    for (const kind of ["REPLIED", "BOUNCED", "OPTED_OUT"] as const) {
      const result = plan([p], [sent(p, 1, ago(5)), { ...sent(p, 1, ago(4)), kind }]);
      expect(result.due).toEqual([]);
      expect(result.skipped[0]!.reason).toMatch(/replied|bounced|opted out/);
    }
  });

  test("a reply anywhere stops a sequence already under way", () => {
    const p = prospect("a", "a@x.example");
    const elsewhere: Touch = { kind: "REPLIED", channel: "EMAIL", sequence: "email/personal/video-first", prospectKey: p.key, occurredAt: ago(1) };
    const result = plan([p], [sent(p, 1, ago(5)), elsewhere]);
    expect(result.due).toEqual([]);
    expect(result.skipped[0]!.reason).toMatch(/^replied on .*video-first.*by hand$/);
    const byHand: Touch = { kind: "REPLIED", channel: "LINKEDIN", prospectKey: p.key, occurredAt: ago(1) };
    expect(plan([p], [sent(p, 1, ago(5)), byHand]).skipped[0]!.reason).toMatch(/^replied on .*\(linkedin\)/);
  });

  test("a reply in the last 90 days holds every new sequence; an older one does not", () => {
    const p = prospect("a", "a@x.example");
    const reply: Touch = { kind: "REPLIED", channel: "LINKEDIN", sequence: "dm/personal/linkedin", prospectKey: p.key, occurredAt: ago(20) };
    expect(plan([p], [reply]).skipped[0]!.reason).toMatch(/^replied on .*dm\/personal\/linkedin.*by hand$/);
    expect(plan([p], [{ ...reply, occurredAt: ago(120) }]).due.length).toBe(1);
  });

  test("the last step finishes it", () => {
    const p = prospect("a", "a@x.example");
    expect(plan([p], [sent(p, 1, ago(20)), sent(p, 2, ago(17)), sent(p, 3, ago(13)), sent(p, 4, ago(6))]).skipped[0]!.reason).toBe("finished the sequence");
  });

  test("one address gets one message per run", () => {
    const dana = prospect("a", "info@clearview.example", "Dana");
    const bob = prospect("b", "INFO@clearview.example", "Bob");
    const result = plan([dana, bob], []);
    expect(result.due.map((d) => d.prospect.variables.first_name)).toEqual(["Dana"]);
    expect(result.skipped[0]!.reason).toBe("same email address as Dana");
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
    expect(plan([p], [{ ...sent(p, 1, ago(5)), prospectKey: "person:123" }]).due[0]!.step.step).toBe(2);
  });

  test("no new sequence within 30 days of another on the same channel", () => {
    const p = prospect("a", "a@x.example");
    const other = sent(p, 1, ago(10), "email/company/problem-proof");
    expect(plan([p], [other]).skipped[0]!.reason).toBe("already in email/company/problem-proof");
    expect(plan([p], [sent(p, 1, ago(45), "email/company/problem-proof")]).due.length).toBe(1);
  });

  test("prospects without an address are skipped with a reason", () => {
    expect(plan([prospect("a", "")], []).skipped[0]!.reason).toBe("no email address");
  });
});
