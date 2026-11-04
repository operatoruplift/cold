import type { Prospect } from "../types";
import { normalizeEmail } from "./normalize";
import { finishProspect, fromAgencyProspect } from "./toProspect";

type Rec = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() && v.trim() !== "—" ? v.trim() : undefined);

/** One quiz answer as words: a pick, several picks ("a, b"), or a number. */
function answerText(value: unknown): string | undefined {
  if (Array.isArray(value)) return str(value.map((v) => answerText(v)).filter(Boolean).join(", "));
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") return str(JSON.stringify(value));
  return str(value);
}

/** What offer wrote into a lead's note: the contact lines, the quiz answers and the other tagged lines (UTM, source URL, offer). */
export interface LeadNote {
  name?: string;
  email?: string;
  phone?: string;
  answers: Record<string, string>;
  fields: Record<string, string>;
}

/**
 * The JSON object after "Quiz answers:", whether it is written on one line or
 * over several: from its "{" to the brace that closes it, skipping braces
 * inside strings. Undefined when it never closes (a note cut short). Pure.
 */
function answersJson(text: string): string | undefined {
  const found = /Quiz answers:\s*\{/.exec(text);
  if (!found) return undefined;
  const start = found.index + found[0].length - 1;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/**
 * offer's agencyLead note, read back (backend/src/routes/leads.ts writes it):
 * "Name: …", "Email: …", "Phone: …" ("—" when empty), "Quiz answers: {json}",
 * then one "Label: value" line each for the offer, source URL and UTM tags.
 * The answers' JSON can be on one line or several. Pure.
 */
export function leadNote(note: string | undefined): LeadNote {
  const text = note ?? "";
  const answers: Record<string, string> = {};
  const json = answersJson(text);
  if (json) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(json) as Rec)) {
        const answer = answerText(v);
        if (answer) answers[k] = answer;
      }
    } catch {
      // A note edited by hand: keep the other lines.
    }
  }
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z_ ]{2,30}):\s*(.+)$/.exec(line.trim());
    if (m && !m[2]!.startsWith("{") && str(m[2])) fields[m[1]!.trim().toLowerCase().replace(/\s+/g, "_")] = m[2]!.trim();
  }
  return { name: fields.name, email: normalizeEmail(fields.email), phone: fields.phone, answers, fields };
}

/** "Saw you took our quiz on Nov 2." from when the lead came in. Pure. */
export function leadTrigger(createdAt: string | undefined): string | undefined {
  const at = createdAt ? new Date(createdAt) : undefined;
  if (!at || Number.isNaN(at.getTime())) return undefined;
  return `Saw you took our quiz on ${at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}.`;
}

/**
 * One of offer's quiz leads (an agencyLead in Twenty) as a prospect: who they
 * are from the note, their quiz answers and UTM tags as variables, and the
 * business's details when the lead came through a prospect's own funnel link
 * (its agencyProspect). The person is whoever took the quiz: the business's
 * decision maker is never assumed. Keyed to that prospect when there is one,
 * so its calls and emails share one history.
 */
export function fromAgencyLead(lead: Rec, prospect?: Rec): Prospect {
  const note = leadNote(str(lead.note));
  const business = prospect ? fromAgencyProspect(prospect) : undefined;
  const { first_name: _first, last_name: _last, full_name: _full, title: _title, ...businessVariables } = business?.variables ?? {};
  const answers = Object.entries(note.answers);
  const variables: Record<string, string> = {
    ...businessVariables,
    ...Object.fromEntries(
      Object.entries({
        full_name: str(lead.contactName) ?? note.name,
        email: note.email ?? business?.variables.email,
        phone: note.phone ?? business?.variables.phone,
        lead_id: str(lead.id),
        lead_source: str(lead.source),
        qualification: str(lead.qualificationStatus),
        lead_status: str(lead.status),
        lead_created_at: str(lead.createdAt),
        offer_id: note.fields.offerid,
        source_url: note.fields.source_url,
        utm_source: note.fields.utm_source,
        utm_medium: note.fields.utm_medium,
        utm_campaign: note.fields.utm_campaign,
        quiz_answers: answers.length ? answers.map(([q, a]) => `${q}: ${a}`).join("; ") : undefined,
        trigger: business?.variables.trigger ?? leadTrigger(str(lead.createdAt)),
      }).filter((e): e is [string, string] => !!e[1]),
    ),
  };
  const links = { ...(business?.links ?? {}), agencyLeadId: str(lead.id) };
  return finishProspect({ source: "agencyLeads", variables, doNotContact: business?.doNotContact ?? false, links, sourceId: str(lead.id) });
}
