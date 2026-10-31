import { ANGLE_GUIDE, ANGLES, TONE_GUIDE, TONES, type Angle, type Tone } from "../ai";
import type { Touch, TouchStore } from "../touches";
import { argmax, chanceBest, normalize, sampleBeta, wilson } from "./math";
import type { Tier } from "./model";

/** Who chose a message's style: the decision model, exploration, past results, you, or nobody yet. */
export type PickedBy = "model" | "explore" | "learned" | "you" | "default";

/**
 * What became of a message written in a style. Replies are wins; a no, an
 * opt-out or silence for two weeks are losses; a bounce or a wrong person
 * says nothing about the style, so it isn't counted.
 */
export type Outcome = "positive" | "replied" | "declined" | "opted_out" | "no_reply" | "excluded";
export const WINS: readonly Outcome[] = ["positive", "replied"];
export const LOSSES: readonly Outcome[] = ["declined", "opted_out", "no_reply"];
/** How long COLD waits for a reply before a message counts as unanswered. */
export const REPLY_WINDOW_DAYS = 14;
const DAY = 86_400_000;

/** One message written in a style, and what became of it. */
export interface Assignment {
  campaignId: string;
  prospectKey: string;
  step: number;
  sequence: string;
  /** "offer · channel · role": whose results this one learns from. */
  segment: string;
  tone: Tone;
  angle: Angle;
  pickedBy: PickedBy;
  /** The prospect's score and tier when it was written, to see whether scores predict replies. */
  score?: number;
  tier?: Tier;
  /** Only an approved draft goes out instead of the template. */
  approvedAt?: string;
  sentAt?: string;
  outcome?: Outcome;
  resolvedAt?: string;
  createdAt: string;
}

/* ---------------------------------------------------------------- segments */

export type Role = "owner" | "manager" | "staff" | "unknown";
export function roleOf(title: string | undefined): Role {
  const t = (title ?? "").toLowerCase();
  if (!t.trim()) return "unknown";
  if (/owner|founder|ceo|chief executive|president|principal|proprietor|partner|managing director/.test(t)) return "owner";
  if (/director|\bvp\b|vice president|head of|chief|manager|\bgm\b|lead/.test(t)) return "manager";
  return "staff";
}

/** Whose results a message learns from: the same offer, channel and kind of role. */
export const segmentOf = (input: { offer?: string; channel: string; title?: string }) => `${input.offer || "any offer"} · ${input.channel} · ${roleOf(input.title)}`;

/* ---------------------------------------------------------------- outcomes */

/**
 * What became of one approved message, from the touch log: the send that
 * carried it, then a reply to it (read with its triage, when there is one),
 * an opt-out, a bounce, or two weeks of silence. A reply to a later step is
 * that step's; a reply within this step's window, or one logged against it,
 * is this one's. Undefined outcome: still waiting.
 */
export function resolveOutcome(a: Assignment, touches: Touch[], intentOf: (messageId?: string) => string | undefined, now: Date): { outcome?: Outcome; sentAt?: string } {
  if (!a.approvedAt) return {};
  const byTime = [...touches].sort((x, y) => x.occurredAt.localeCompare(y.occurredAt));
  const sameStep = (t: Touch) => t.sequence === a.sequence && (t.step ?? 1) === a.step;
  const sent = byTime.find((t) => t.kind === "SENT" && sameStep(t) && t.occurredAt >= a.approvedAt!);
  if (!sent) return byTime.some((t) => t.kind === "FAILED" && sameStep(t) && t.occurredAt >= a.approvedAt!) ? { outcome: "excluded" } : {};
  const sentAt = sent.occurredAt;
  const after = byTime.filter((t) => t.occurredAt >= sentAt && t !== sent);
  const nextSend = after.find((t) => t.kind === "SENT" && t.sequence === a.sequence && (t.step ?? 1) > a.step)?.occurredAt;
  const windowEnd = Math.min(Date.parse(sentAt) + REPLY_WINDOW_DAYS * DAY, nextSend ? Date.parse(nextSend) : Infinity);
  const answers = (t: Touch) => (!t.sequence || t.sequence === a.sequence) && (t.step === a.step || (t.step === undefined && Date.parse(t.occurredAt) <= windowEnd));
  if (after.some((t) => (t.kind === "BOUNCED" || t.kind === "UNDELIVERABLE") && answers(t))) return { outcome: "excluded", sentAt };
  const reply = after.find((t) => t.kind === "REPLIED" && answers(t) && intentOf(t.messageId) !== "out_of_office");
  if (reply) {
    const intent = intentOf(reply.messageId);
    const outcome: Outcome =
      intent === "wrong_person" ? "excluded" : intent === "unsubscribe" ? "opted_out" : intent === "not_interested" ? "declined" : intent === "interested" || intent === "question" ? "positive" : "replied";
    return { outcome, sentAt };
  }
  if (after.some((t) => t.kind === "OPTED_OUT" && answers(t))) return { outcome: "opted_out", sentAt };
  return now.getTime() >= windowEnd ? { outcome: "no_reply", sentAt } : { sentAt };
}

/** The open assignments' outcomes, worked out from the touch log and saved. Returns how many changed. */
export async function resolveAssignments(deps: {
  open: Assignment[];
  touches: TouchStore;
  /** Reply intents from triage, by the reply's Message-ID. */
  intents: (messageIds: string[]) => Promise<Map<string, string>>;
  save: (updates: Array<Pick<Assignment, "campaignId" | "prospectKey" | "step" | "sentAt" | "outcome" | "resolvedAt">>) => Promise<void>;
  now: Date;
}): Promise<number> {
  if (!deps.open.length) return 0;
  const touches = await deps.touches.forProspects([...new Set(deps.open.map((a) => a.prospectKey))]);
  const byProspect = new Map<string, Touch[]>();
  for (const t of touches) byProspect.set(t.prospectKey, [...(byProspect.get(t.prospectKey) ?? []), t]);
  const intents = await deps.intents(touches.filter((t) => t.kind === "REPLIED" && t.messageId).map((t) => t.messageId!));
  const updates = deps.open.flatMap((a) => {
    const found = resolveOutcome(a, byProspect.get(a.prospectKey) ?? [], (id) => (id ? intents.get(id) : undefined), deps.now);
    if (found.outcome === a.outcome && found.sentAt === a.sentAt) return [];
    return [{ campaignId: a.campaignId, prospectKey: a.prospectKey, step: a.step, sentAt: found.sentAt, outcome: found.outcome, resolvedAt: found.outcome ? deps.now.toISOString() : undefined }];
  });
  if (updates.length) await deps.save(updates);
  return updates.length;
}

/* ---------------------------------------------------------------- choosing a style */

export interface Arm {
  n: number;
  wins: number;
}
export interface StyleCounts {
  tone: Record<string, Arm>;
  angle: Record<string, Arm>;
}

const counted = (o?: Outcome) => !!o && (WINS.includes(o) || LOSSES.includes(o));

/** Wins out of messages with a result, by tone and by angle; for one segment, or all. */
export function countStyles(assignments: Assignment[], segment?: string): StyleCounts {
  const counts: StyleCounts = { tone: {}, angle: {} };
  for (const a of assignments) {
    if ((segment && a.segment !== segment) || !counted(a.outcome)) continue;
    const win = WINS.includes(a.outcome!) ? 1 : 0;
    for (const [dimension, arm] of [["tone", a.tone], ["angle", a.angle]] as const) {
      const c = (counts[dimension][arm] ??= { n: 0, wins: 0 });
      c.n++;
      c.wins += win;
    }
  }
  return counts;
}

/** How many pretend messages the model's opinion is worth before real replies take over. */
export const PRIOR_STRENGTH = 20;
/** A segment needs this many results before they choose the style on their own, without a decision. */
export const LEARNED_AFTER = 30;

const total = (arms: Record<string, Arm>) => Object.values(arms).reduce((s, a) => ({ n: s.n + a.n, wins: s.wins + a.wins }), { n: 0, wins: 0 });

/**
 * Thompson sampling, with the decision model's opinion as the prior: each
 * option starts from the overall reply rate, tilted by how strongly the model
 * prefers it for this person, worth twenty messages. Real results in the
 * segment add to it. One draw per option; the highest draw is used. So the
 * model's pick wins most of the time, the others get tried now and then,
 * and as replies come in they decide.
 */
function draw<T extends string>(arms: readonly T[], prior: Record<string, number> | undefined, seen: Record<string, Arm>, base: number, random: () => number): T {
  const q = normalize(prior, [...arms]);
  let best = arms[0]!;
  let top = -1;
  for (const arm of arms) {
    const mean = Math.min(0.6, Math.max(0.002, base * arms.length * q[arm]!));
    const s = seen[arm] ?? { n: 0, wins: 0 };
    const value = sampleBeta(mean * PRIOR_STRENGTH + s.wins, (1 - mean) * PRIOR_STRENGTH + s.n - s.wins, random);
    if (value > top) {
      top = value;
      best = arm;
    }
  }
  return best;
}

export interface StylePick {
  tone: Tone;
  angle: Angle;
  pickedBy: PickedBy;
  /** One sentence for the screen: why this style. */
  why: string;
}

export function pickStyle(input: {
  /** The decision model's probabilities for this prospect, when there is a decision. */
  tones?: Record<string, number>;
  angles?: Record<string, number>;
  allowedAngles: Angle[];
  segment: string;
  /** Results in this prospect's segment, and in all of them. */
  seen: StyleCounts;
  overall: StyleCounts;
  /** False: always the model's pick. */
  explore: boolean;
  provider?: string;
  random?: () => number;
}): StylePick {
  const random = input.random ?? Math.random;
  const angles = input.allowedAngles.length ? input.allowedAngles : (["outcome"] as Angle[]);
  const all = total(input.overall.tone);
  // The overall reply rate, itself estimated: with no results yet it starts at 5%.
  const base = (all.wins + 1) / (all.n + 20);
  const who = input.provider === "jev" ? "Jev" : "Claude";
  const where = input.segment.split(" · ").slice(1).join(", ");

  if (input.tones && input.angles) {
    const modelTone = argmax(normalize(input.tones, [...TONES])) as Tone;
    const modelAngle = argmax(normalize(input.angles, angles)) as Angle;
    if (!input.explore) return { tone: modelTone, angle: modelAngle, pickedBy: "model", why: `${who}'s pick for them: ${TONE_GUIDE[modelTone].label.toLowerCase()}, opening with ${ANGLE_GUIDE[modelAngle].label.toLowerCase()}.` };
    const tone = draw(TONES, input.tones, input.seen.tone, base, random);
    const angle = draw(angles, input.angles, input.seen.angle, base, random);
    if (tone === modelTone && angle === modelAngle) return { tone, angle, pickedBy: "model", why: `${who}'s pick for them: ${TONE_GUIDE[tone].label.toLowerCase()}, opening with ${ANGLE_GUIDE[angle].label.toLowerCase()}.` };
    const tried = [tone !== modelTone ? `a ${TONE_GUIDE[tone].label.toLowerCase()} tone` : "", angle !== modelAngle ? `opening with ${ANGLE_GUIDE[angle].label.toLowerCase()}` : ""].filter(Boolean).join(" and ");
    return { tone, angle, pickedBy: "explore", why: `Trying ${tried} (${who} picked ${TONE_GUIDE[modelTone].label.toLowerCase()}, ${ANGLE_GUIDE[modelAngle].label.toLowerCase()}) to learn what works for ${where}.` };
  }

  if (total(input.seen.tone).n >= LEARNED_AFTER) {
    const tone = draw(TONES, undefined, input.seen.tone, base, random);
    const angle = draw(angles, undefined, input.seen.angle, base, random);
    return { tone, angle, pickedBy: "learned", why: `What has worked best for ${where} so far: ${TONE_GUIDE[tone].label.toLowerCase()}, opening with ${ANGLE_GUIDE[angle].label.toLowerCase()}.` };
  }
  const angle: Angle = angles.includes("trigger") ? "trigger" : "outcome";
  return { tone: "professional", angle, pickedBy: "default", why: "No decision for them yet: a professional tone. Score them to have the style chosen for them." };
}

/* ---------------------------------------------------------------- what's working */

export interface ArmReport {
  arm: string;
  label: string;
  /** Messages with a result. */
  n: number;
  wins: number;
  rate: number | null;
  /** About 90% sure the true reply rate is in here. */
  low: number;
  high: number;
  /** The chance this is the best option, given the results so far. */
  chanceBest: number;
}

export interface StyleInsights {
  totals: { written: number; approved: number; sent: number; withResult: number; waiting: number; wins: number };
  outcomes: Record<Outcome, number>;
  tone: ArmReport[];
  angle: ArmReport[];
  /** Did following the model beat trying something else? */
  pickedBy: Array<{ by: PickedBy; n: number; wins: number; rate: number | null }>;
  /** Do higher scores get more replies? */
  tiers: Array<{ tier: Tier; n: number; wins: number; rate: number | null }>;
  segments: Array<{ segment: string; n: number; wins: number; rate: number | null; bestTone?: string; bestAngle?: string }>;
}

const rateOf = (wins: number, n: number) => (n ? wins / n : null);

function arms(counts: Record<string, Arm>, names: readonly string[], label: (name: string) => string): ArmReport[] {
  const present = names.filter((n) => counts[n]?.n);
  const best = chanceBest(Object.fromEntries(present.map((n) => [n, counts[n]!])));
  return names.map((name) => {
    const c = counts[name] ?? { n: 0, wins: 0 };
    return { arm: name, label: label(name), n: c.n, wins: c.wins, rate: rateOf(c.wins, c.n), ...wilson(c.wins, c.n), chanceBest: best[name] ?? 0 };
  });
}

/** Reply rates by tone, angle, who picked, score tier and segment, with how sure each one is. */
export function buildInsights(assignments: Assignment[]): StyleInsights {
  const outcomes = Object.fromEntries([...WINS, ...LOSSES, "excluded"].map((o) => [o, 0])) as Record<Outcome, number>;
  for (const a of assignments) if (a.outcome) outcomes[a.outcome]++;
  const results = assignments.filter((a) => counted(a.outcome));
  const wins = results.filter((a) => WINS.includes(a.outcome!)).length;
  const all = countStyles(assignments);
  const group = <K extends string>(key: (a: Assignment) => K | undefined) => {
    const map = new Map<K, Arm>();
    for (const a of results) {
      const k = key(a);
      if (!k) continue;
      const c = map.get(k) ?? { n: 0, wins: 0 };
      c.n++;
      if (WINS.includes(a.outcome!)) c.wins++;
      map.set(k, c);
    }
    return map;
  };
  const byTier = group((a) => a.tier);
  const segments = [...group((a) => a.segment)].map(([segment, c]) => {
    const seen = countStyles(results, segment);
    const leader = (arms: Record<string, Arm>) => {
      const ranked = Object.entries(arms).filter(([, x]) => x.n >= 5).sort((x, y) => y[1].wins / y[1].n - x[1].wins / x[1].n);
      return ranked[0]?.[0];
    };
    return { segment, n: c.n, wins: c.wins, rate: rateOf(c.wins, c.n), bestTone: leader(seen.tone), bestAngle: leader(seen.angle) };
  });
  return {
    totals: {
      written: assignments.length,
      approved: assignments.filter((a) => a.approvedAt).length,
      sent: assignments.filter((a) => a.sentAt).length,
      withResult: results.length,
      waiting: assignments.filter((a) => a.sentAt && !a.outcome).length,
      wins,
    },
    outcomes,
    tone: arms(all.tone, TONES, (t) => TONE_GUIDE[t as Tone].label),
    angle: arms(all.angle, ANGLES, (a) => ANGLE_GUIDE[a as Angle].label),
    pickedBy: [...group((a) => a.pickedBy)].map(([by, c]) => ({ by, n: c.n, wins: c.wins, rate: rateOf(c.wins, c.n) })),
    tiers: (["A", "B", "C", "D"] as Tier[]).map((tier) => {
      const c = byTier.get(tier) ?? { n: 0, wins: 0 };
      return { tier, n: c.n, wins: c.wins, rate: rateOf(c.wins, c.n) };
    }),
    segments: segments.sort((x, y) => y.n - x.n).slice(0, 12),
  };
}
