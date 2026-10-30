import type { Message, Sequence } from "../../messages";
import type { Prospect } from "../../prospects";
import type { Touch, TouchChannel } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A sequence that has not sent for this long no longer counts as active. */
const ACTIVE_WINDOW_DAYS = 30;
/** After a reply on any channel, nothing new starts automatically for this long. */
const REPLY_HOLD_DAYS = 90;

/** Touches that end a sequence for a prospect. */
const STOPPERS = new Set(["REPLIED", "OPTED_OUT", "BOUNCED", "UNDELIVERABLE"]);

export interface PlanInput {
  sequence: Sequence;
  /** The channel the sequence sends on (EMAIL, LINKEDIN, ...). */
  channel: TouchChannel;
  prospects: Prospect[];
  /** Touches for these prospects, any sequence. */
  history: Touch[];
  /** Opt-outs, bounces and undeliverable verdicts, any prospect. */
  suppressions: Touch[];
  now: Date;
  /** Can this prospect be reached on the channel at all (has an email, a LinkedIn URL...)? */
  reachable: (prospect: Prospect) => string | undefined;
}

export interface DueItem {
  prospect: Prospect;
  step: Message;
  /** Where it goes: the email address, profile URL or handle. */
  address: string;
  /** The last touch sent in this sequence, for threading follow-ups. */
  previous?: Touch;
  /** The first touch sent in this sequence (its subject threads the follow-ups). */
  first?: Touch;
}

export interface SkippedItem {
  prospect: Prospect;
  reason: string;
}

export interface Plan {
  due: DueItem[];
  skipped: SkippedItem[];
  /** Prospects with a step coming up later, and when. */
  waiting: Array<{ prospect: Prospect; step: Message; dueAt: Date }>;
}

const touchesOf = (prospect: Prospect, touches: Touch[]) => {
  const ids = new Set(prospect.identities);
  return touches.filter((t) => ids.has(t.prospectKey) || (t.toAddress && ids.has(`email:${t.toAddress.toLowerCase()}`)));
};

/**
 * Suppressed when the source says Do Not Contact, when the prospect ever
 * opted out (any channel), or, for email, when their address bounced or was
 * verified undeliverable.
 */
export function suppressionReason(prospect: Prospect, suppressions: Touch[], channel: TouchChannel): string | undefined {
  if (prospect.doNotContact) return "marked Do Not Contact";
  const mine = touchesOf(prospect, suppressions);
  if (mine.some((t) => t.kind === "OPTED_OUT")) return "opted out";
  if (channel === "EMAIL") {
    if (mine.some((t) => t.kind === "BOUNCED")) return "email bounced";
    if (mine.some((t) => t.kind === "UNDELIVERABLE")) return "email verified undeliverable";
  }
  return undefined;
}

/**
 * Work out, for every prospect, whether a step of this sequence is due now.
 * Pure. The rules:
 *
 *  - suppressed prospects are skipped (see suppressionReason);
 *  - a reply, opt-out or bounce in this sequence ends it;
 *  - step N is due `day` days after step 1 went out, and never sooner after
 *    step N-1 than the gap between their days;
 *  - nobody starts a sequence within 30 days of another sequence on the same
 *    channel reaching them, so two sequences never overlap in someone's inbox;
 *  - nobody who replied anywhere in the last 90 days is started on anything:
 *    a reply is a conversation, and that is yours to carry on by hand.
 */
export function planSequence(input: PlanInput): Plan {
  const { sequence, channel, now } = input;
  const plan: Plan = { due: [], skipped: [], waiting: [] };
  const lastStep = sequence.steps[sequence.steps.length - 1]?.step ?? 0;

  for (const prospect of input.prospects) {
    const skip = (reason: string) => plan.skipped.push({ prospect, reason });
    const address = input.reachable(prospect);
    if (!address) {
      skip(`no ${channel === "EMAIL" ? "email address" : `${channel.toLowerCase()} profile`}`);
      continue;
    }
    const suppressed = suppressionReason(prospect, input.suppressions, channel);
    if (suppressed) {
      skip(suppressed);
      continue;
    }

    const mine = touchesOf(prospect, input.history);
    const inSequence = mine.filter((t) => t.sequence === sequence.id).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const stopper = inSequence.find((t) => STOPPERS.has(t.kind));
    if (stopper) {
      skip(stopper.kind === "REPLIED" ? "replied" : stopper.kind === "OPTED_OUT" ? "opted out" : "email bounced");
      continue;
    }

    const sent = inSequence.filter((t) => t.kind === "SENT");
    const lastSent = sent[sent.length - 1];
    const sentStep = lastSent?.step ?? 0;
    if (sentStep >= lastStep) {
      skip("finished the sequence");
      continue;
    }
    const next = sequence.steps.find((s) => s.step === sentStep + 1);
    if (!next) {
      skip(`step ${sentStep + 1} is missing from the sequence`);
      continue;
    }

    if (!lastSent) {
      const reply = mine.find((t) => t.kind === "REPLIED" && now.getTime() - new Date(t.occurredAt).getTime() < REPLY_HOLD_DAYS * DAY_MS);
      if (reply) {
        skip(`replied on ${reply.occurredAt.slice(0, 10)}${reply.sequence ? ` (${reply.sequence})` : ""}; carry on by hand`);
        continue;
      }
      const busy = activeElsewhere(mine, sequence.id, channel, now);
      if (busy) {
        skip(`already in ${busy}`);
        continue;
      }
      plan.due.push({ prospect, step: next, address });
      continue;
    }

    const first = sent.find((t) => t.step === 1) ?? sent[0]!;
    const previousStep = sequence.steps.find((s) => s.step === sentStep);
    const fromFirst = new Date(first.occurredAt).getTime() + (next.day ?? 0) * DAY_MS;
    const gap = Math.max(0, (next.day ?? 0) - (previousStep?.day ?? 0));
    const fromPrevious = new Date(lastSent.occurredAt).getTime() + gap * DAY_MS;
    const dueAt = new Date(Math.max(fromFirst, fromPrevious));
    if (dueAt.getTime() > now.getTime()) plan.waiting.push({ prospect, step: next, dueAt });
    else plan.due.push({ prospect, step: next, address, previous: lastSent, first });
  }
  return plan;
}

/** Another sequence on this channel that reached the prospect in the last 30 days, if any. */
function activeElsewhere(mine: Touch[], sequenceId: string, channel: TouchChannel, now: Date): string | undefined {
  const others = new Map<string, Touch[]>();
  for (const t of mine) {
    if (!t.sequence || t.sequence === sequenceId || t.channel !== channel) continue;
    others.set(t.sequence, [...(others.get(t.sequence) ?? []), t]);
  }
  for (const [id, touches] of others) {
    if (touches.some((t) => STOPPERS.has(t.kind))) continue;
    const sent = touches.filter((t) => t.kind === "SENT").sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const last = sent[sent.length - 1];
    if (!last) continue;
    const recent = now.getTime() - new Date(last.occurredAt).getTime() < ACTIVE_WINDOW_DAYS * DAY_MS;
    if (recent) return id;
  }
  return undefined;
}
