import { collectVariables, parseTemplate, VARIABLE_NAMES } from "../../render";
import type { LintIssue, Objection, Sequence } from "../types";

/** Rules across the steps of each sequence. Pure. */
export function lintSequences(sequences: Sequence[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const sequence of sequences) {
    const file = `messages/${sequence.id}/`;
    const steps = sequence.steps.map((s) => s.step ?? 0);
    steps.forEach((n, index) => {
      if (n !== index + 1) issues.push({ level: "error", file, rule: "steps", message: `steps must run 1, 2, 3 with no gaps or repeats; found ${steps.join(", ")}` });
    });
    const first = sequence.steps[0];
    if (first && first.day !== 0) issues.push({ level: "error", file: first.file, rule: "day", message: "step 1 is day 0" });
    for (let i = 1; i < sequence.steps.length; i++) {
      const previous = sequence.steps[i - 1]!;
      const current = sequence.steps[i]!;
      if ((current.day ?? 0) <= (previous.day ?? 0)) {
        issues.push({ level: "error", file: current.file, rule: "day", message: `day ${current.day} must come after step ${previous.step}'s day ${previous.day}` });
      }
    }
    const platforms = new Set(sequence.steps.map((s) => s.platform));
    if (platforms.size > 1) issues.push({ level: "error", file, rule: "platform", message: "every step of a DM sequence must use the same platform" });
  }
  return [...new Map(issues.map((i) => [`${i.file}|${i.rule}|${i.message}`, i])).values()];
}

/** Validate objections.yaml entries. Pure. */
export function lintObjections(raw: unknown, file: string): { objections: Objection[]; issues: LintIssue[] } {
  const issues: LintIssue[] = [];
  const objections: Objection[] = [];
  if (!Array.isArray(raw)) {
    issues.push({ level: "error", file, rule: "objections", message: "objections.yaml must be a list" });
    return { objections, issues };
  }
  raw.forEach((entry: Record<string, unknown>, index) => {
    const where = `entry ${index + 1}`;
    const fields = ["objection", "category", "personal", "company"] as const;
    const missing = fields.filter((f) => typeof entry?.[f] !== "string" || !(entry[f] as string).trim());
    if (missing.length) {
      issues.push({ level: "error", file, rule: "objections", message: `${where} needs ${missing.join(", ")}` });
      return;
    }
    for (const voice of ["personal", "company"] as const) {
      const parsed = parseTemplate(entry[voice] as string);
      for (const problem of parsed.errors) issues.push({ level: "error", file, rule: "syntax", message: `${where} (${voice}), ${problem}` });
      for (const name of collectVariables(parsed.nodes)) {
        if (!VARIABLE_NAMES.has(name)) issues.push({ level: "error", file, rule: "unknown-variable", message: `${where} (${voice}) uses {{${name}}}` });
      }
    }
    objections.push({
      objection: (entry.objection as string).trim(),
      category: (entry.category as string).trim(),
      personal: (entry.personal as string).trim(),
      company: (entry.company as string).trim(),
    });
  });
  const seen = new Set<string>();
  for (const o of objections) {
    if (seen.has(o.objection.toLowerCase())) issues.push({ level: "error", file, rule: "objections", message: `"${o.objection}" is listed twice` });
    seen.add(o.objection.toLowerCase());
  }
  return { objections, issues };
}
