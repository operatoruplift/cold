import { ANGLE_GUIDE, ANGLES, TONE_GUIDE, TONES, type AiOffer, type AiSender, type Angle, type Research, type Tone } from "../ai";
import type { Prospect } from "../prospects";
import { DEAD_NUMBERS, DISPOSITION_LABELS, latestCall, type Touch } from "../touches";
import { historyLines, type Dossier } from "./diligence";
import { argmax, clamp01 } from "./math";
import type { Answer, DecisionResult, Question } from "./types";

export const ACTIONS = ["contact_now", "nurture", "research_more", "skip"] as const;
export type Action = (typeof ACTIONS)[number];
export const ACTION_GUIDE: Record<Action, { label: string; when: string }> = {
  contact_now: { label: "Reach out now", when: "They fit, the need shows, and there is a reason to write today." },
  nurture: { label: "Later", when: "They fit, but the need or the timing isn't there yet: reach out when something changes." },
  research_more: { label: "Research first", when: "Too little is known to write a good first message, or no decision-maker can be reached yet." },
  skip: { label: "Skip", when: "They don't fit the offer, or a message would be unwelcome." },
};

export const OBJECTIONS = ["already_solved", "no_budget", "no_time", "not_a_priority", "trust", "none_clear"] as const;
export type Objection = (typeof OBJECTIONS)[number];
export const OBJECTION_GUIDE: Record<Objection, string> = {
  already_solved: "They already have something that does this: a tool, a vendor or staff.",
  no_budget: "Money is tight, or they are too small for the price.",
  no_time: "They are too busy to look at anything new right now.",
  not_a_priority: "The problem isn't painful enough for them to act on.",
  trust: "They won't trust a stranger's claims without proof or a referral.",
  none_clear: "No clear objection stands out.",
};

export const CHANNELS = ["email", "linkedin", "instagram", "x", "facebook", "phone"] as const;
export type Channel = (typeof CHANNELS)[number];

export type Factor = "fit" | "need" | "timing" | "authority" | "budget" | "reach";
/**
 * How much each factor counts once a prospect fits. Fit multiplies the rest,
 * so a business outside the audience scores low however busy it is.
 */
export const WEIGHTS: Record<Exclude<Factor, "fit">, number> = { need: 0.4, timing: 0.2, authority: 0.15, budget: 0.1, reach: 0.15 };
export type Tier = "A" | "B" | "C" | "D";
export const tierOf = (score: number): Tier => (score >= 70 ? "A" : score >= 50 ? "B" : score >= 30 ? "C" : "D");
/** Below this confidence the next step goes to you to check, as TypeSafe recommends for Jev. */
export const REVIEW_BELOW = 0.75;
/** A call outcome from the dialer holds for this long. */
const CALL_MEMORY_DAYS = 90;

export interface DecisionInput {
  offer: AiOffer;
  sender: AiSender;
  prospect: Prospect;
  dossier?: Dossier;
  research?: Research;
  /** Every touch with this prospect. */
  history: Touch[];
  now: Date;
}

/** Everything the engine decided about one prospect, with the reasons. */
export interface Decision {
  /** 0 to 100: how promising they are for this offer, from the factors below. */
  score: number;
  tier: Tier;
  /** What to do next: the model's suggestion, unless a rule overrides it. */
  action: Action;
  suggested: Action;
  /** How sure the model is of the next step, 0 to 1. */
  confidence: number;
  review: boolean;
  reviewReasons: string[];
  factors: Record<Factor, { value: number; reason?: string }>;
  style: { tone: Tone; angle: Angle; tones: Record<string, number>; angles: Record<string, number>; toneConfidence: number; angleConfidence: number };
  objection: { choice: Objection; confidence: number; reason?: string };
  channel: { choice: Channel | null; available: Channel[]; confidence: number };
  /** What the decision rests on: diligence, a research run, or only the list. */
  evidence: "diligence" | "research" | "list";
  /** The need that matters most, for the writer. */
  needs: string[];
  reasons: string[];
  provider: "jev" | "claude";
  model: string;
  decidedAt: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const SHARED_INBOX = /^(info|hello|hi|contact|office|admin|sales|support|team|bookings?|enquiries|inquiries|service|mail|frontdesk|reception)@/i;

/** The channels a prospect can be reached on: an email that hasn't bounced, their profiles, a phone the dialer didn't find wrong. */
export function reachableOn(prospect: Prospect, history: Touch[]): Channel[] {
  const bounced = history.some((t) => t.channel === "EMAIL" && (t.kind === "BOUNCED" || t.kind === "UNDELIVERABLE"));
  const lastCall = latestCall(history);
  const deadNumber = !!lastCall && DEAD_NUMBERS.has(lastCall.disposition);
  const found: Array<[Channel, unknown]> = [
    ["email", prospect.email && !bounced],
    ["linkedin", prospect.linkedinUrl],
    ["instagram", prospect.instagramHandle],
    ["x", prospect.xHandle],
    ["facebook", prospect.facebookUrl],
    ["phone", prospect.phone && !deadNumber],
  ];
  return found.filter(([, ok]) => !!ok).map(([c]) => c);
}

/** An email beats a DM, a DM beats a cold call, and no way in at all is zero. */
export function reachScore(channels: Channel[]): number {
  if (channels.includes("email")) return 1;
  if (channels.some((c) => c !== "phone")) return 0.7;
  return channels.includes("phone") ? 0.5 : 0;
}

/** The openings that have what they need: proof only when the seller has some, a trigger only when one is known. */
export function allowedAngles(input: Pick<DecisionInput, "offer" | "prospect" | "dossier" | "research">): Angle[] {
  const hasTrigger = !!(input.prospect.variables.trigger?.trim() || input.dossier?.triggers.length || input.research?.best_trigger);
  return ANGLES.filter((a) => (a === "proof" ? !!input.offer.proof?.trim() : a === "trigger" ? hasTrigger : true));
}

/** What the list says, without contact details or record ids: a decision doesn't need them. */
function listFacts(prospect: Prospect): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const [key, value] of Object.entries(prospect.variables)) {
    if (!value?.trim() || /email|phone|mobile|^id$|_id$|_url$|handle$|^sources$/i.test(key)) continue;
    facts[key] = value.trim().slice(0, 500);
  }
  if (prospect.email) facts.email_is = SHARED_INBOX.test(prospect.email) ? "a shared inbox" : "a person's own address";
  return facts;
}

/**
 * The state the questions are asked about: the seller, the prospect, what
 * diligence or research found, and the history. JSON, so a decision model
 * reads each part for what it is.
 */
export function decisionState(input: DecisionInput): Record<string, unknown> {
  const { offer, dossier, research } = input;
  const short = (items: string[], n: number) => items.slice(0, n).map((s) => s.slice(0, 400));
  return {
    today: day(input.now),
    seller: { sells_to: offer.audience, offers: offer.offer, outcome: offer.outcome, pain_it_removes: offer.pain, proof: offer.proof, writes_as: input.sender.voice === "company" ? "the company (we)" : "one person (I)" },
    prospect: listFacts(input.prospect),
    can_reach_them_by: reachableOn(input.prospect, input.history),
    diligence: dossier && {
      summary: dossier.summary,
      offerings: short(dossier.offerings, 8),
      needs: dossier.needs.slice(0, 8).map((n) => ({ need: n.need, evidence: n.evidence.slice(0, 300), strength: n.strength, quote_checked: n.confirmed })),
      recent_events: dossier.triggers.slice(0, 6).map((t) => (t.when ? `${t.sentence} (${t.when})` : t.sentence)),
      tools_they_use: short(dossier.tools, 8),
      people: dossier.people.slice(0, 6).map((p) => (p.title ? `${p.name}, ${p.title}` : p.name)),
      size: dossier.size,
      how_they_write: dossier.voice,
      risks: short(dossier.risks, 6),
      open_questions: short(dossier.unknowns, 6),
    },
    research: !dossier && research ? { summary: research.summary, recent_events: research.triggers.map((t) => t.sentence), talking_points: short(research.talking_points, 6), watch_outs: short(research.watch_outs, 6), fit: research.fit, fit_reason: research.fit_reason } : undefined,
    history: historyLines(input.history),
  };
}

const describeTone = (t: Tone) => `${TONE_GUIDE[t].label}: ${TONE_GUIDE[t].when}`;
const describeAngle = (a: Angle) => `${ANGLE_GUIDE[a].label}: ${ANGLE_GUIDE[a].when}`;

/** The questions asked about every prospect: ten at most, so Jev answers them in one request. */
export function outboundQuestions(input: DecisionInput): Record<string, Question> {
  const channels = reachableOn(input.prospect, input.history);
  const questions: Record<string, Question> = {
    fit: {
      type: "noul",
      instructions: "Is this business the kind the seller sells to (seller.sells_to), in its line of work, its size and its area?",
      criteria: { true: "Clearly the kind of business the seller sells to.", false: "A different kind of business, too big or too small, or outside the area." },
    },
    need: {
      type: "noul",
      instructions: "Does the evidence show they have the problem the offer removes, or want the result it brings?",
      criteria: { true: "Their pages, the list or the history show the problem or the goal.", false: "No sign of it, or they have already solved it." },
    },
    timing: {
      type: "noul",
      instructions: `Is there a reason to reach out now, as of ${day(input.now)}?`,
      criteria: { true: "Something recent and specific: an opening, a hire, a launch, a theme in reviews, a new role.", false: "Nothing recent, or the moment has passed." },
    },
    authority: {
      type: "noul",
      instructions: "Can the person on the list say yes to buying this?",
      criteria: { true: "The owner, a founder, a general manager, or the head of what the offer serves.", false: "Unknown, a shared inbox, or someone without a say." },
    },
    budget: {
      type: "score",
      instructions: "How able are they to pay for the offer?",
      criteria: ["Clearly can't: too small, or struggling.", "Unclear from the evidence.", "Likely can: established and busy.", "Clearly can: they already pay for similar things."],
    },
    tone: { type: "choice", instructions: "Which tone is this person most likely to answer? Weigh how they write about themselves, their line of work and their role.", criteria: Object.fromEntries(TONES.map((t) => [t, describeTone(t)])) },
    angle: { type: "choice", instructions: "Which opening is most likely to get a reply from them?", criteria: Object.fromEntries(allowedAngles(input).map((a) => [a, describeAngle(a)])) },
    objection: { type: "choice", instructions: "What would most likely stop them saying yes?", criteria: OBJECTION_GUIDE },
    action: { type: "choice", instructions: "What should the seller do next with this prospect?", criteria: Object.fromEntries(ACTIONS.map((a) => [a, `${ACTION_GUIDE[a].label}: ${ACTION_GUIDE[a].when}`])) },
  };
  if (channels.length > 1) {
    questions.channel = { type: "choice", instructions: "On which of these channels is a first message most likely to be read and answered by them?", criteria: Object.fromEntries(channels.map((c) => [c, `Reach them by ${c}.`])) };
  }
  return questions;
}

const noul = (a: Answer | undefined) => (a?.type === "noul" ? a.noul : 0.5);
function choiceOf<T extends string>(a: Answer | undefined, options: readonly T[], fallback: T): { choice: T; confidence: number; probabilities: Record<string, number>; reason?: string } {
  if (a?.type !== "choice") return { choice: fallback, confidence: 0, probabilities: {} };
  const known = (c: string): c is T => (options as readonly string[]).includes(c);
  const best = argmax(a.probabilities);
  return { choice: known(a.choice) ? a.choice : known(best) ? best : fallback, confidence: a.confidence, probabilities: a.probabilities, reason: a.reason };
}

/** The score from the factors: fit times the weighted rest, 0 to 100. */
export function scoreOf(f: Record<Factor, number>): number {
  const rest = (Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>).reduce((sum, k) => sum + WEIGHTS[k] * clamp01(f[k]), 0);
  return Math.round(100 * clamp01(f.fit) * rest);
}

/**
 * Turn the answers into a decision: the score, the tier, the next step and
 * the style. Rules a model can't overrule: someone who opted out is skipped;
 * no way to reach them means research first; no fit means skip; someone who
 * said "not interested" on a call in the last 90 days is not contacted now
 * but later. A low-confidence or contradictory call goes to you to check.
 */
export function combine(input: DecisionInput, result: DecisionResult & { provider: "jev" | "claude" }, reviewBelow = REVIEW_BELOW): Decision {
  const a = result.answers;
  const channels = reachableOn(input.prospect, input.history);
  const budget = a.budget?.type === "score" ? a.budget.score / 3 : 0.5;
  const factors: Decision["factors"] = {
    fit: { value: noul(a.fit), reason: a.fit?.reason },
    need: { value: noul(a.need), reason: a.need?.reason },
    timing: { value: noul(a.timing), reason: a.timing?.reason },
    authority: { value: noul(a.authority), reason: a.authority?.reason },
    budget: { value: clamp01(budget), reason: a.budget?.reason },
    reach: { value: reachScore(channels), reason: channels.length ? `Can be reached by ${channels.join(", ")}.` : "No email, profile or phone on the list yet." },
  };
  const score = scoreOf(Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, v.value])) as Record<Factor, number>);
  const action = choiceOf(a.action, ACTIONS, "research_more");
  const tone = choiceOf(a.tone, TONES, "professional");
  const angles = allowedAngles(input);
  const angle = choiceOf(a.angle, angles, angles.includes("trigger") ? "trigger" : "outcome");
  const objection = choiceOf(a.objection, OBJECTIONS, "none_clear");
  const channel = channels.length > 1 ? choiceOf(a.channel, channels, channels[0]!) : { choice: channels[0] ?? null, confidence: channels.length ? 1 : 0 };
  const evidence: Decision["evidence"] = input.dossier ? "diligence" : input.research ? "research" : "list";

  const call = latestCall(input.history);
  const recentCall = call && input.now.getTime() - Date.parse(call.touch.occurredAt) < CALL_MEMORY_DAYS * 86_400_000 ? call : undefined;
  const optedOut = input.history.some((t) => t.kind === "OPTED_OUT");
  let next: Action = action.choice;
  let because: string | undefined;
  const reviewReasons: string[] = [];
  if (optedOut) [next, because] = ["skip", "they opted out"];
  else if (!channels.length) [next, because] = ["research_more", "there is no way to reach them yet"];
  else if (factors.fit.value < 0.25) [next, because] = ["skip", "they don't fit the offer"];
  else if (recentCall?.disposition === "NOT_INTERESTED" && next === "contact_now") [next, because] = ["nurture", `they said they weren't interested on a call on ${day(new Date(recentCall.touch.occurredAt))}`];
  if (next !== action.choice) reviewReasons.push(`The engine suggested "${ACTION_GUIDE[action.choice].label}", overruled because ${because}.`);
  if (!optedOut && next === "skip" && (recentCall?.disposition === "INTERESTED" || recentCall?.disposition === "APPOINTMENT_SET")) {
    reviewReasons.push(`It says skip, but the dialer logged "${DISPOSITION_LABELS[recentCall.disposition].toLowerCase()}" on a call on ${day(new Date(recentCall.touch.occurredAt))}.`);
  }
  if (action.confidence < reviewBelow) reviewReasons.push(`It isn't sure about the next step (confidence ${pct(action.confidence)}).`);
  if (next === "contact_now" && score < 30) reviewReasons.push("It says reach out now, but the score is low.");
  if (next === "skip" && score >= 70) reviewReasons.push("It says skip, but the score is high.");
  if (evidence === "list") reviewReasons.push("Only the list is known about them: run diligence for a surer call.");

  const needs = (input.dossier?.needs ?? []).filter((n) => n.confirmed).concat((input.dossier?.needs ?? []).filter((n) => !n.confirmed)).map((n) => n.need);
  const reasons = [
    `Fit ${pct(factors.fit.value)}${factors.fit.reason ? `: ${factors.fit.reason}` : "."}`,
    `Need ${pct(factors.need.value)}${factors.need.reason ? `: ${factors.need.reason}` : needs[0] ? `: ${needs[0]}.` : "."}`,
    `Timing ${pct(factors.timing.value)}${factors.timing.reason ? `: ${factors.timing.reason}` : "."}`,
    `Decision-maker ${pct(factors.authority.value)}${factors.authority.reason ? `: ${factors.authority.reason}` : "."}`,
  ];
  return {
    score,
    tier: tierOf(score),
    action: next,
    suggested: action.choice,
    confidence: action.confidence,
    review: reviewReasons.length > 0,
    reviewReasons,
    factors,
    style: { tone: tone.choice, angle: angle.choice, tones: tone.probabilities, angles: angle.probabilities, toneConfidence: tone.confidence, angleConfidence: angle.confidence },
    objection: { choice: objection.choice, confidence: objection.confidence, reason: objection.reason },
    channel: { choice: channel.choice, available: channels, confidence: channel.confidence },
    evidence,
    needs: needs.slice(0, 3),
    reasons,
    provider: result.provider,
    model: result.model,
    decidedAt: input.now.toISOString(),
  };
}
