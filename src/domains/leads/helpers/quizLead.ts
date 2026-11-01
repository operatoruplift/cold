import { leadNote, type Prospect } from "../../prospects";
import type { Touch } from "../../touches";
import type { NtfyMessage, QuizLead } from "../types";

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** One quiz lead for the Calls page: its record in Twenty, as a prospect, and when it was last called. Pure. */
export function quizLead(record: Record<string, unknown>, prospect: Prospect, calledAt?: string): QuizLead {
  const v = prospect.variables;
  const qualification = (text(record.qualificationStatus) ?? "").toUpperCase();
  const status = (text(record.status) ?? "").toUpperCase();
  return {
    id: text(record.id) ?? prospect.key,
    prospectKey: prospect.key,
    label: prospect.label,
    name: v.full_name,
    company: v.company,
    phone: prospect.phone,
    email: prospect.email,
    createdAt: text(record.createdAt),
    qualified: qualification !== "DISQUALIFIED" && status !== "LOST",
    answers: Object.entries(leadNote(text(record.note)).answers).map(([q, a]) => `${q}: ${a}`),
    from: v.utm_source ?? v.lead_source,
    calledAt,
    doNotContact: prospect.doNotContact,
  };
}

/** The latest call to this prospect in the touch log, by any of their identities. Pure. */
export function lastCall(prospect: Prospect, calls: Touch[]): string | undefined {
  const ids = new Set(prospect.identities);
  let latest: string | undefined;
  for (const t of calls) if (t.channel === "CALL" && ids.has(t.prospectKey) && (!latest || t.occurredAt > latest)) latest = t.occurredAt;
  return latest;
}

/**
 * Who to call first: qualified leads nobody has called yet, newest first;
 * then the ones already called; then the disqualified; Do Not Contact last.
 * Pure.
 */
export function rankLeads(leads: QuizLead[]): QuizLead[] {
  const group = (l: QuizLead) => (l.doNotContact ? 3 : !l.qualified ? 2 : l.calledAt ? 1 : 0);
  return [...leads].sort((a, b) => group(a) - group(b) || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/** The push for one new lead: who, their company, the number to call, the first answers. Tapping it opens the lead on the Calls page. Pure. */
export function leadPush(lead: QuizLead, appUrl?: string): Omit<NtfyMessage, "topic"> {
  const who = lead.name ?? lead.label;
  const lines = [
    lead.company && lead.company !== who ? lead.company : undefined,
    lead.phone ? `Call ${lead.phone}` : lead.email ? `No phone given: ${lead.email}` : undefined,
    ...lead.answers.slice(0, 4),
  ].filter((l): l is string => !!l);
  return {
    title: `New quiz lead: ${who}`.slice(0, 120),
    message: (lines.join("\n") || "They took your quiz.").slice(0, 1000),
    tags: ["telephone_receiver"],
    priority: 4,
    click: appUrl ? `${appUrl}calls?lead=${encodeURIComponent(lead.id)}` : undefined,
  };
}

/** One push for many new leads at once: how many, the first names. Pure. */
export function countPush(leads: QuizLead[], appUrl?: string, atLeast = false): Omit<NtfyMessage, "topic"> {
  const names = leads.slice(0, 5).map((l) => l.name ?? l.label);
  const more = leads.length - names.length;
  return {
    title: `${leads.length}${atLeast ? "+" : ""} new quiz leads`,
    message: `${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}. Call them first: they're at the top of Calls.`.slice(0, 1000),
    tags: ["telephone_receiver"],
    priority: 4,
    click: appUrl ? `${appUrl}calls` : undefined,
  };
}
