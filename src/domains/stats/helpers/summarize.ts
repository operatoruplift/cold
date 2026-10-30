import type { Touch } from "../../touches";

export interface TemplateStats {
  templateId: string;
  sequence?: string;
  step?: number;
  sent: number;
  replied: number;
  optedOut: number;
  bounced: number;
}

export interface SequenceStats {
  sequence: string;
  /** Prospects who got step 1. */
  started: number;
  /** Prospects who replied at any step. */
  replied: number;
  optedOut: number;
}

/**
 * Per message and per sequence results from the touch log. A reply,
 * opt-out or bounce counts against the step it answered (sync and the DM
 * assistant log that step on it). Pure.
 */
export function summarize(touches: Touch[]): { templates: TemplateStats[]; sequences: SequenceStats[] } {
  const templates = new Map<string, TemplateStats>();
  const row = (t: Touch) => {
    const id = t.templateId ?? `${t.sequence ?? t.channel.toLowerCase()}${t.step ? `#${t.step}` : ""}`;
    let r = templates.get(id);
    if (!r) templates.set(id, (r = { templateId: id, sequence: t.sequence, step: t.step, sent: 0, replied: 0, optedOut: 0, bounced: 0 }));
    return r;
  };
  const sequences = new Map<string, { started: Set<string>; replied: Set<string>; optedOut: Set<string> }>();
  const seq = (id: string) => {
    let s = sequences.get(id);
    if (!s) sequences.set(id, (s = { started: new Set(), replied: new Set(), optedOut: new Set() }));
    return s;
  };

  for (const t of touches) {
    if (t.kind === "SENT") row(t).sent++;
    else if (t.kind === "REPLIED") row(t).replied++;
    else if (t.kind === "OPTED_OUT") row(t).optedOut++;
    else if (t.kind === "BOUNCED") row(t).bounced++;
    if (!t.sequence) continue;
    if (t.kind === "SENT" && t.step === 1) seq(t.sequence).started.add(t.prospectKey);
    if (t.kind === "REPLIED") seq(t.sequence).replied.add(t.prospectKey);
    if (t.kind === "OPTED_OUT") seq(t.sequence).optedOut.add(t.prospectKey);
  }

  return {
    templates: [...templates.values()].sort((a, b) => (a.sequence ?? a.templateId).localeCompare(b.sequence ?? b.templateId) || (a.step ?? 0) - (b.step ?? 0)),
    sequences: [...sequences.entries()]
      .map(([sequence, s]) => ({ sequence, started: s.started.size, replied: s.replied.size, optedOut: s.optedOut.size }))
      .sort((a, b) => a.sequence.localeCompare(b.sequence)),
  };
}

export const rate = (part: number, whole: number) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : "-");
