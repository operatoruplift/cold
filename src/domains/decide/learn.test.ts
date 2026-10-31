import { describe, expect, test } from "bun:test";
import { openDatabase } from "../db";
import { DbStore, type Touch } from "../touches";
import { buildInsights, countStyles, pickStyle, resolveAssignments, resolveOutcome, roleOf, segmentOf, type Assignment } from "./learn";
import { seeded } from "./math";
import { DecideStore } from "./store";

const SEQ = "email/personal/founder-direct";
const base: Assignment = {
  campaignId: "c1",
  prospectKey: "csv:1",
  step: 1,
  sequence: SEQ,
  segment: "receptionist · email · owner",
  tone: "conversational",
  angle: "trigger",
  pickedBy: "model",
  approvedAt: "2026-10-01T09:00:00Z",
  createdAt: "2026-10-01T08:00:00Z",
};
const touch = (kind: Touch["kind"], at: string, extra: Partial<Touch> = {}): Touch => ({ kind, channel: "EMAIL", prospectKey: "csv:1", sequence: SEQ, step: 1, occurredAt: at, ...extra });
const NOW = new Date("2026-10-31T12:00:00Z");
const none = () => undefined;

describe("what became of a message", () => {
  test("a reply to it is a win; its triage says whether it was a yes, a no or an opt-out", () => {
    const touches = [touch("SENT", "2026-10-01T10:00:00Z"), touch("REPLIED", "2026-10-03T10:00:00Z", { messageId: "<r1>" })];
    expect(resolveOutcome(base, touches, none, NOW)).toEqual({ outcome: "replied", sentAt: "2026-10-01T10:00:00Z" });
    expect(resolveOutcome(base, touches, () => "interested", NOW).outcome).toBe("positive");
    expect(resolveOutcome(base, touches, () => "not_interested", NOW).outcome).toBe("declined");
    expect(resolveOutcome(base, touches, () => "unsubscribe", NOW).outcome).toBe("opted_out");
    expect(resolveOutcome(base, touches, () => "wrong_person", NOW).outcome).toBe("excluded");
    // An away message is not an answer: still waiting, then unanswered.
    expect(resolveOutcome(base, touches, () => "out_of_office", new Date("2026-10-05T00:00:00Z"))).toEqual({ sentAt: "2026-10-01T10:00:00Z" });
    expect(resolveOutcome(base, touches, () => "out_of_office", NOW).outcome).toBe("no_reply");
  });

  test("two weeks of silence is unanswered; before that it is still waiting", () => {
    const sent = [touch("SENT", "2026-10-20T10:00:00Z")];
    expect(resolveOutcome(base, sent, none, NOW)).toEqual({ sentAt: "2026-10-20T10:00:00Z" });
    expect(resolveOutcome(base, sent, none, new Date("2026-11-04T10:00:01Z")).outcome).toBe("no_reply");
  });

  test("a reply to the follow-up is the follow-up's: this step's window closed when it went out", () => {
    const touches = [touch("SENT", "2026-10-01T10:00:00Z"), touch("SENT", "2026-10-04T10:00:00Z", { step: 2 }), touch("REPLIED", "2026-10-05T10:00:00Z", { step: 2 })];
    expect(resolveOutcome(base, touches, none, NOW).outcome).toBe("no_reply");
    expect(resolveOutcome({ ...base, step: 2 }, touches, none, NOW).outcome).toBe("replied");
    // A reply logged against step 1 still counts for it, even after the follow-up.
    expect(resolveOutcome(base, [...touches, touch("REPLIED", "2026-10-06T10:00:00Z", { step: 1 })], none, NOW).outcome).toBe("replied");
  });

  test("a bounce or a failed send says nothing about the style; a draft never approved never went out", () => {
    expect(resolveOutcome(base, [touch("SENT", "2026-10-01T10:00:00Z"), touch("BOUNCED", "2026-10-01T10:05:00Z")], none, NOW).outcome).toBe("excluded");
    expect(resolveOutcome(base, [touch("FAILED", "2026-10-01T10:00:00Z")], none, NOW).outcome).toBe("excluded");
    expect(resolveOutcome({ ...base, approvedAt: undefined }, [touch("SENT", "2026-10-01T10:00:00Z")], none, NOW)).toEqual({});
    // A send before the approval was the template, not this draft.
    expect(resolveOutcome(base, [touch("SENT", "2026-09-30T10:00:00Z")], none, NOW)).toEqual({});
    expect(resolveOutcome(base, [touch("SENT", "2026-10-01T10:00:00Z"), touch("OPTED_OUT", "2026-10-02T10:00:00Z")], none, NOW).outcome).toBe("opted_out");
  });
});

describe("choosing a style", () => {
  const empty = { tone: {}, angle: {} };
  const model = { tones: { formal: 0.05, professional: 0.15, conversational: 0.7, casual: 0.1 }, angles: { pain: 0.1, outcome: 0.1, trigger: 0.7, question: 0.1 } };
  const allowedAngles = ["pain", "outcome", "trigger", "question"] as const;

  test("with no results yet, the model's pick wins most of the time and the rest get tried", () => {
    const random = seeded(1);
    const picks = Array.from({ length: 400 }, () => pickStyle({ ...model, allowedAngles: [...allowedAngles], segment: "x · email · owner", seen: empty, overall: empty, explore: true, random }));
    const followed = picks.filter((p) => p.pickedBy === "model").length / picks.length;
    expect(followed).toBeGreaterThan(0.4);
    expect(followed).toBeLessThan(0.95);
    expect(new Set(picks.map((p) => p.tone)).size).toBeGreaterThan(1);
    expect(picks.find((p) => p.pickedBy === "explore")!.why).toContain("to learn what works for email, owner");
  });

  test("replies outweigh the model once there are enough of them", () => {
    const seen = { tone: { casual: { n: 80, wins: 16 }, conversational: { n: 80, wins: 1 } }, angle: {} };
    const random = seeded(2);
    const picks = Array.from({ length: 200 }, () => pickStyle({ ...model, allowedAngles: [...allowedAngles], segment: "s", seen, overall: seen, explore: true, random }));
    expect(picks.filter((p) => p.tone === "casual").length / picks.length).toBeGreaterThan(0.9);
  });

  test("exploring off means the model's pick; no decision means a professional default until results exist", () => {
    expect(pickStyle({ ...model, allowedAngles: [...allowedAngles], segment: "s", seen: empty, overall: empty, explore: false, provider: "jev" })).toMatchObject({ tone: "conversational", angle: "trigger", pickedBy: "model", why: "Jev's pick for them: conversational, opening with what just happened." });
    expect(pickStyle({ allowedAngles: ["pain", "outcome", "question"], segment: "s", seen: empty, overall: empty, explore: true })).toMatchObject({ tone: "professional", angle: "outcome", pickedBy: "default" });
    const seen = { tone: { formal: { n: 40, wins: 8 } }, angle: { pain: { n: 40, wins: 8 } } };
    expect(pickStyle({ allowedAngles: ["pain", "outcome"], segment: "s", seen, overall: seen, explore: true, random: seeded(3) }).pickedBy).toBe("learned");
  });

  test("segments by offer, channel and the kind of role", () => {
    expect([roleOf("Owner"), roleOf("Co-Founder & CEO"), roleOf("Service Manager"), roleOf("Front desk"), roleOf(undefined)]).toEqual(["owner", "owner", "manager", "staff", "unknown"]);
    expect(segmentOf({ offer: "receptionist", channel: "email", title: "Owner" })).toBe("receptionist · email · owner");
  });
});

describe("what's working", () => {
  test("reply rates by tone, angle, who picked and score tier, with intervals and the chance each is best", () => {
    const make = (n: number, over: Partial<Assignment>, outcome: Assignment["outcome"]) => Array.from({ length: n }, (_, i) => ({ ...base, prospectKey: `p${Math.random()}${i}`, outcome, sentAt: base.approvedAt, ...over }));
    const all = [
      ...make(6, { tone: "casual", tier: "A", pickedBy: "model" }, "replied"),
      ...make(14, { tone: "casual", tier: "A", pickedBy: "model" }, "no_reply"),
      ...make(1, { tone: "formal", tier: "C", pickedBy: "explore" }, "positive"),
      ...make(19, { tone: "formal", tier: "C", pickedBy: "explore" }, "no_reply"),
      ...make(3, { tone: "formal" }, "excluded"),
      ...make(2, { tone: "formal", outcome: undefined }, undefined),
    ];
    const r = buildInsights(all);
    expect(r.totals).toMatchObject({ written: 45, withResult: 40, wins: 7, waiting: 2 });
    expect(r.outcomes).toMatchObject({ replied: 6, positive: 1, no_reply: 33, excluded: 3 });
    const casual = r.tone.find((t) => t.arm === "casual")!;
    expect(casual).toMatchObject({ label: "Casual", n: 20, wins: 6, rate: 0.3 });
    expect(casual.low).toBeLessThan(0.3);
    expect(casual.high).toBeGreaterThan(0.3);
    expect(casual.chanceBest).toBeGreaterThan(0.9);
    expect(r.tone.find((t) => t.arm === "professional")).toMatchObject({ n: 0, rate: null });
    expect(r.tiers.find((t) => t.tier === "A")).toMatchObject({ n: 20, wins: 6 });
    expect(r.pickedBy.find((p) => p.by === "explore")).toMatchObject({ n: 20, wins: 1 });
    expect(countStyles(all, "nope").tone).toEqual({});
  });
});

describe("the decision store", () => {
  test("assign, approve, resolve from the touch log, and a rewrite starts over", async () => {
    const db = await openDatabase(":memory:");
    let now = new Date("2026-10-01T08:00:00Z");
    const store = new DecideStore(db, () => now);
    await store.assign({ campaignId: "c1", prospectKey: "csv:1", step: 1, sequence: SEQ, segment: "s", tone: "casual", angle: "pain", pickedBy: "explore", score: 72, tier: "A" });
    expect(await store.open()).toEqual([]);
    now = new Date("2026-10-01T09:00:00Z");
    await store.approve("c1", "csv:1", 1, true);
    const touches = new DbStore(db);
    await touches.record(touch("SENT", "2026-10-01T10:00:00Z"));
    await touches.record(touch("REPLIED", "2026-10-02T10:00:00Z", { messageId: "<r1>" }));
    now = NOW;
    const changed = await resolveAssignments({ open: await store.open(), touches, intents: async () => new Map([["<r1>", "interested"]]), save: (u) => store.record(u), now });
    expect(changed).toBe(1);
    expect(await store.assignment("c1", "csv:1", 1)).toMatchObject({ outcome: "positive", sentAt: "2026-10-01T10:00:00Z", approvedAt: "2026-10-01T09:00:00.000Z", score: 72, tier: "A" });
    expect(await store.open()).toEqual([]);
    // Once sent, a rewrite or a discard can't erase what happened.
    await store.unassign("c1", "csv:1", 1);
    expect(await store.assignment("c1", "csv:1", 1)).toBeDefined();
    await store.assign({ campaignId: "c1", prospectKey: "csv:2", step: 1, sequence: SEQ, segment: "s", tone: "formal", angle: "pain", pickedBy: "model" });
    await store.approve("c1", "csv:2", 1, true);
    await store.assign({ campaignId: "c1", prospectKey: "csv:2", step: 1, sequence: SEQ, segment: "s", tone: "casual", angle: "pain", pickedBy: "you" });
    expect(await store.assignment("c1", "csv:2", 1)).toMatchObject({ tone: "casual", pickedBy: "you", approvedAt: undefined });
    await store.unassign("c1", "csv:2", 1);
    expect(await store.assignment("c1", "csv:2", 1)).toBeUndefined();
    expect(await store.counts()).toEqual({ decisions: 0, assignments: 1 });
  });
});
