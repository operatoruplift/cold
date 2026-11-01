import type { Touch } from "../types";

/** The dialer's call outcomes (agencyCall.disposition). */
export const DISPOSITIONS = ["INTERESTED", "APPOINTMENT_SET", "CALLBACK", "GOOD_NUMBER", "LEFT_CALLBACK", "VOICEMAIL", "NOT_INTERESTED", "BAD_NUMBER", "NO_ANSWER", "WRONG_NUMBER", "DNC"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const DISPOSITION_LABELS: Record<Disposition, string> = {
  INTERESTED: "Interested",
  APPOINTMENT_SET: "Appointment set",
  CALLBACK: "Call back",
  GOOD_NUMBER: "Good number",
  LEFT_CALLBACK: "Left a callback",
  VOICEMAIL: "Voicemail",
  NOT_INTERESTED: "Not interested",
  BAD_NUMBER: "Bad number",
  NO_ANSWER: "No answer",
  WRONG_NUMBER: "Wrong number",
  DNC: "Do not call",
};

/** Outcomes where you talked with them: a conversation, which stops automatic outreach the way a reply does. */
export const CONVERSATIONS: ReadonlySet<Disposition> = new Set(["INTERESTED", "APPOINTMENT_SET", "CALLBACK", "NOT_INTERESTED"]);

/** Outcomes that say the number doesn't reach them. */
export const DEAD_NUMBERS: ReadonlySet<Disposition> = new Set(["BAD_NUMBER", "WRONG_NUMBER"]);

const PREFIX = "dialer:";

/** The templateId of a call logged from the dialer: dialer:<disposition>, e.g. dialer:INTERESTED. */
export const dialerTemplateId = (disposition: Disposition) => `${PREFIX}${disposition}`;

/** The dialer's outcome of a call touch; undefined for any other touch. Pure. */
export function callOutcome(touch: Pick<Touch, "channel" | "templateId">): Disposition | undefined {
  if (touch.channel !== "CALL" || !touch.templateId?.startsWith(PREFIX)) return undefined;
  const disposition = touch.templateId.slice(PREFIX.length) as Disposition;
  return DISPOSITIONS.includes(disposition) ? disposition : undefined;
}

/** A call where you talked with them. Pure. */
export const isConversation = (touch: Touch): boolean => CONVERSATIONS.has(callOutcome(touch)!);

/** The latest call the dialer logged among these touches, with its outcome. Pure. */
export function latestCall(touches: Touch[]): { touch: Touch; disposition: Disposition } | undefined {
  let latest: { touch: Touch; disposition: Disposition } | undefined;
  for (const touch of touches) {
    const disposition = callOutcome(touch);
    if (disposition && (!latest || touch.occurredAt > latest.touch.occurredAt)) latest = { touch, disposition };
  }
  return latest;
}
