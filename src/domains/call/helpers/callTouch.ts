import { dialerTemplateId, DISPOSITION_LABELS, DISPOSITIONS, type Disposition, type Touch } from "../../touches";

type Rec = Record<string, unknown>;
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A call's outcome is only read once it settles: this long after it ended, even without the dialer's AI reading. */
export const CALL_SETTLE_MS = 15 * 60_000;

/**
 * A call is settled once its outcome is set, it is no longer in progress,
 * and the dialer's AI has read it (or had a quarter of an hour to). Before
 * that the summary and score may still change. Pure.
 */
export function callSettled(call: Rec, now: Date): boolean {
  if (!DISPOSITIONS.includes(text(call.disposition) as Disposition) || text(call.status) === "IN_PROGRESS") return false;
  if (text(call.aiAnalyzedAt)) return true;
  const ended = Date.parse(text(call.endedAt) ?? text(call.updatedAt) ?? "");
  return !Number.isFinite(ended) || now.getTime() - ended >= CALL_SETTLE_MS;
}

/** The prospect a call was with, as COLD keys them: the dialer's prospect (the business), else offer's quiz lead. */
export function callProspectKey(call: Rec): string | undefined {
  const prospectId = text(call.agencyProspectId);
  const leadId = text(call.agencyLeadId);
  return prospectId ? `agencyProspect:${prospectId}` : leadId ? `agencyLeads:${leadId}` : undefined;
}

/**
 * One call from the dialer as a touch: CALLED with its outcome (an opt-out
 * when they asked not to be called), what the dialer's AI made of it, and
 * the call's id as its messageId, so it is logged once. Undefined when it has
 * no outcome yet or isn't tied to a prospect or lead. Pure.
 */
export function callTouch(call: Rec, prospectLabel?: string): Touch | undefined {
  const disposition = text(call.disposition) as Disposition;
  const prospectKey = callProspectKey(call);
  const id = text(call.id);
  if (!DISPOSITIONS.includes(disposition) || !prospectKey || !id) return undefined;
  const inbound = text(call.direction) === "INBOUND";
  const score = typeof call.aiScore === "number" && Number.isFinite(call.aiScore) ? Math.round(call.aiScore) : undefined;
  const sentiment = text(call.aiSentiment)?.toLowerCase();
  const subject = [DISPOSITION_LABELS[disposition], inbound ? "they called" : undefined, score !== undefined ? `AI score ${score}` : undefined, sentiment ? `${sentiment} tone` : undefined].filter(Boolean).join(", ");
  const prospectId = text(call.agencyProspectId);
  return {
    kind: disposition === "DNC" ? "OPTED_OUT" : "CALLED",
    channel: "CALL",
    prospectKey,
    prospectLabel,
    toAddress: text(inbound ? call.fromNumber : call.toNumber),
    subject,
    body: (text(call.aiSummary) ?? text(call.summary) ?? text(call.notes))?.slice(0, 2000),
    templateId: dialerTemplateId(disposition),
    messageId: `agencyCall:${id}`,
    occurredAt: text(call.startedAt) ?? text(call.createdAt) ?? text(call.updatedAt) ?? "",
    links: prospectId ? { agencyProspectId: prospectId } : undefined,
  };
}
