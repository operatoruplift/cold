import { describe, expect, test } from "bun:test";
import type { Prospect } from "../prospects";
import type { Touch } from "../touches";
import type { Dossier } from "./diligence";
import { allowedAngles, combine, decisionState, outboundQuestions, reachableOn, scoreOf, tierOf, type DecisionInput } from "./model";
import type { Answer, DecisionResult } from "./types";

const prospect = (extra: Partial<Prospect> = {}): Prospect => ({
  key: "csv:1",
  identities: ["csv:1", "email:dana@clearview.example"],
  label: "Dana Reyes (Clearview Tint)",
  source: "csv",
  variables: { first_name: "Dana", company: "Clearview Tint", title: "Owner", city: "Round Rock", email: "dana@clearview.example", phone: "+1 512 555 0101", id: "c-1", website: "https://clearview.example" },
  email: "dana@clearview.example",
  phone: "+1 512 555 0101",
  doNotContact: false,
  links: {},
  ...extra,
});

const dossier: Dossier = {
  summary: "A family-owned tint shop with two bays.",
  offerings: ["Car tint"],
  needs: [
    { need: "Calls missed while they work", evidence: "hiring a front desk coordinator", source: "https://clearview.example/careers", strength: "strong", confirmed: true },
    { need: "Slow quotes", evidence: "quotes in 48 hours", source: "https://clearview.example/", strength: "weak", confirmed: false },
  ],
  triggers: [{ sentence: "Saw you just opened a second bay in Round Rock.", when: "September 2026", source: "https://clearview.example/" }],
  tools: ["Square Appointments"],
  people: [{ name: "Dana Reyes", title: "Owner", source: "list" }],
  size: "Two bays",
  voice: "Warm and casual",
  risks: [],
  unknowns: ["Who answers the phone today?"],
  pages: [{ url: "https://clearview.example/" }],
  skipped: [],
  provider: "subq",
};

const input = (extra: Partial<DecisionInput> = {}): DecisionInput => ({
  offer: { audience: "owner-run auto shops", offer: "an AI receptionist", pain: "missed calls" },
  sender: { voice: "personal", name: "Alex" },
  prospect: prospect(),
  dossier,
  history: [],
  now: new Date("2026-10-31T12:00:00Z"),
  ...extra,
});

const choice = (c: string, confidence = 0.9, probabilities: Record<string, number> = { [c]: 1 }): Answer => ({ type: "choice", choice: c, confidence, probabilities });
const answers = (over: Record<string, Answer> = {}): DecisionResult & { provider: "jev" } => ({
  provider: "jev",
  model: "jev-latest",
  usage: { inputTokens: 0, outputTokens: 0, searches: 0, fetches: 0 },
  answers: {
    fit: { type: "noul", noul: 0.95 },
    need: { type: "noul", noul: 0.85 },
    timing: { type: "noul", noul: 0.8 },
    authority: { type: "noul", noul: 0.9 },
    budget: { type: "score", score: 2.4, confidence: 0.7, probabilities: { "0": 0, "1": 0.1, "2": 0.4, "3": 0.5 } },
    tone: choice("conversational", 0.6, { formal: 0.05, professional: 0.25, conversational: 0.6, casual: 0.1 }),
    angle: choice("trigger", 0.7),
    objection: choice("already_solved", 0.5),
    action: choice("contact_now", 0.88),
    ...over,
  },
});

describe("the questions", () => {
  test("ten at most, with only the openings and channels that fit this prospect", () => {
    const q = outboundQuestions(input());
    expect(Object.keys(q)).toEqual(["fit", "need", "timing", "authority", "budget", "tone", "angle", "objection", "action", "channel"]);
    expect(Object.keys(q.angle!.type === "choice" ? q.angle!.criteria : {})).toEqual(["pain", "outcome", "trigger", "question"]);
    expect(q.channel!.type === "choice" && Object.keys(q.channel!.criteria)).toEqual(["email", "phone"]);
    expect(q.timing!.instructions).toContain("2026-10-31");
    // No proof, no trigger, one channel: no proof or trigger opening, no channel question.
    const bare = input({ dossier: undefined, prospect: prospect({ phone: undefined }) });
    expect(allowedAngles({ ...bare, offer: { ...bare.offer, proof: "Doubled bookings for Ortiz Glass" } })).toEqual(["pain", "outcome", "proof", "question"]);
    expect(outboundQuestions(bare).channel).toBeUndefined();
  });

  test("the state carries what was found, but never contact details or record ids", () => {
    const state = decisionState(input({ history: [{ kind: "SENT", channel: "EMAIL", step: 1, prospectKey: "csv:1", occurredAt: "2026-10-01T10:00:00Z" } as Touch] }));
    const text = JSON.stringify(state);
    expect(text).not.toContain("dana@clearview.example");
    expect(text).not.toContain("555 0101");
    expect(text).not.toContain("c-1");
    expect(state.prospect).toMatchObject({ company: "Clearview Tint", title: "Owner", website: "https://clearview.example", email_is: "a person's own address" });
    expect(state.can_reach_them_by).toEqual(["email", "phone"]);
    expect((state.diligence as { needs: unknown[] }).needs[0]).toEqual({ need: "Calls missed while they work", evidence: "hiring a front desk coordinator", strength: "strong", quote_checked: true });
    expect(state.history).toEqual(["2026-10-01: sent email step 1"]);
    expect(decisionState(input({ prospect: prospect({ email: "info@clearview.example" }) })).prospect).toMatchObject({ email_is: "a shared inbox" });
  });

  test("an email that bounced is not a way to reach them", () => {
    expect(reachableOn(prospect(), [{ kind: "BOUNCED", channel: "EMAIL", prospectKey: "csv:1", occurredAt: "2026-10-01T10:00:00Z" } as Touch])).toEqual(["phone"]);
  });
});

describe("the decision", () => {
  test("a strong, reachable prospect: score from the factors, tier A, reach out now in their tone", () => {
    const d = combine(input(), answers());
    // 0.95 x (0.4 x 0.85 + 0.2 x 0.8 + 0.15 x 0.9 + 0.1 x 0.8 + 0.15 x 1) = 0.95 x 0.865
    expect(d.score).toBe(82);
    expect(d.tier).toBe("A");
    expect(d).toMatchObject({ action: "contact_now", suggested: "contact_now", review: false, evidence: "diligence" });
    expect(d.style).toMatchObject({ tone: "conversational", angle: "trigger", toneConfidence: 0.6 });
    expect(d.channel).toMatchObject({ choice: "email", available: ["email", "phone"] });
    expect(d.needs).toEqual(["Calls missed while they work", "Slow quotes"]);
    expect(d.reasons[0]).toBe("Fit 95%.");
  });

  test("rules the model can't overrule: no fit is a skip, no way to reach them is research first", () => {
    const misfit = combine(input(), answers({ fit: { type: "noul", noul: 0.1 } }));
    expect(misfit).toMatchObject({ action: "skip", suggested: "contact_now", review: true });
    expect(misfit.score).toBeLessThan(10);
    const unreachable = combine(input({ prospect: prospect({ email: undefined, phone: undefined }) }), answers());
    expect(unreachable.action).toBe("research_more");
    expect(unreachable.reviewReasons[0]).toContain("no way to reach them");
  });

  test("the dialer's calls: an opt-out is a skip, \"not interested\" waits, a wrong number is no way in", () => {
    const call = (disposition: string, at: string, kind: Touch["kind"] = "CALLED"): Touch => ({ kind, channel: "CALL", templateId: `dialer:${disposition}`, subject: disposition, prospectKey: "csv:1", occurredAt: at });
    const optedOut = combine(input({ history: [call("DNC", "2026-10-30T15:00:00Z", "OPTED_OUT")] }), answers());
    expect(optedOut.action).toBe("skip");
    expect(optedOut.reviewReasons[0]).toBe('The engine suggested "Reach out now", overruled because they opted out.');
    const notInterested = combine(input({ history: [call("NOT_INTERESTED", "2026-10-20T15:00:00Z")] }), answers());
    expect(notInterested.action).toBe("nurture");
    expect(notInterested.reviewReasons[0]).toContain("they said they weren't interested on a call on 2026-10-20");
    expect(combine(input({ history: [call("NOT_INTERESTED", "2026-06-01T15:00:00Z")] }), answers()).action).toBe("contact_now");
    expect(reachableOn(prospect(), [call("WRONG_NUMBER", "2026-10-30T15:00:00Z")])).toEqual(["email"]);
    expect(reachableOn(prospect(), [call("WRONG_NUMBER", "2026-10-28T15:00:00Z"), call("GOOD_NUMBER", "2026-10-30T15:00:00Z")])).toEqual(["email", "phone"]);
    const interested = combine(input({ history: [call("INTERESTED", "2026-10-30T15:00:00Z")] }), answers({ action: choice("skip", 0.9) }));
    expect(interested.reviewReasons).toContain('It says skip, but the dialer logged "interested" on a call on 2026-10-30.');
  });

  test("an unsure call, a contradiction, or a decision on the list alone goes to you to check", () => {
    expect(combine(input(), answers({ action: choice("contact_now", 0.5) })).reviewReasons).toEqual(["It isn't sure about the next step (confidence 50%)."]);
    const contradiction = combine(input(), answers({ need: { type: "noul", noul: 0.05 }, timing: { type: "noul", noul: 0.05 }, authority: { type: "noul", noul: 0.1 }, fit: { type: "noul", noul: 0.4 } }));
    expect(contradiction.reviewReasons).toContain("It says reach out now, but the score is low.");
    expect(combine(input({ dossier: undefined }), answers()).reviewReasons).toContain("Only the list is known about them: run diligence for a surer call.");
  });

  test("tiers and the score formula", () => {
    expect(scoreOf({ fit: 1, need: 1, timing: 1, authority: 1, budget: 1, reach: 1 })).toBe(100);
    expect(scoreOf({ fit: 0, need: 1, timing: 1, authority: 1, budget: 1, reach: 1 })).toBe(0);
    expect([tierOf(70), tierOf(69), tierOf(50), tierOf(30), tierOf(29)]).toEqual(["A", "B", "B", "C", "D"]);
  });
});
