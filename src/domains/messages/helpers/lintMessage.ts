import { collectVariables, exampleVariables, parseTemplate, renderNodes, VARIABLE_NAMES } from "../../render";
import type { LintIssue, Message } from "../types";

/** Characters in a LinkedIn connection note on a free account. */
export const LINKEDIN_NOTE_LIMIT = 200;
const DM_SOFT_LIMIT = 600;
const EMAIL_SOFT_WORDS = 150;
const SUBJECT_SOFT_CHARS = 60;

const EMOJI = /\p{Extended_Pictographic}/u;
const LINK = /\bhttps?:\/\/|\{\{\s*(booking_url|video_url|page_url|website|linkedin_url)\s*(\|[^}]*)?\}\}/i;
const BRACKET_PLACEHOLDER = /\[[^\]\n]{1,60}\]/;
const DECEPTIVE_SUBJECT = /^\s*(re|fw|fwd)\s*:/i;
const SPAMMY = /\b(free|guarantee[d]?|act now|limited time|risk[- ]free|100%|winner|urgent|cash|\$\$)\b|!{2,}/i;

/** Every rule that applies to one message. Pure: lengths are estimated with the contract's example values. */
export function lintMessage(message: Message): LintIssue[] {
  const issues: LintIssue[] = [];
  const error = (rule: string, text: string) => issues.push({ level: "error", file: message.file, rule, message: text });
  const warn = (rule: string, text: string) => issues.push({ level: "warning", file: message.file, rule, message: text });

  const known = new Set([...VARIABLE_NAMES, ...message.customVariables]);
  const examples = exampleVariables();
  const parts: Array<{ label: string; source: string }> = [{ label: "body", source: message.body }];
  if (message.subject) parts.push({ label: "subject", source: message.subject });

  const rendered: Record<string, string> = {};
  for (const { label, source } of parts) {
    const parsed = parseTemplate(source);
    for (const problem of parsed.errors) error("syntax", `${label}, ${problem}`);
    for (const name of collectVariables(parsed.nodes)) {
      if (!known.has(name)) error("unknown-variable", `${label} uses {{${name}}}, which is not in the contract. Fix the name, or declare it under variables: in the front matter`);
    }
    if (parsed.errors.length === 0) rendered[label] = renderNodes(parsed.nodes, examples, { mode: "strict", seed: message.id }).text;
  }

  if (EMOJI.test(message.body) || (message.subject && EMOJI.test(message.subject))) error("no-emoji", "no emojis: they read as automated and break the brand rule");

  const body = rendered.body ?? "";
  if (message.channel === "email") {
    if (message.step === 1 && !message.subject) error("subject", "the first email in a sequence needs a subject");
    if (message.subject && DECEPTIVE_SUBJECT.test(message.subject)) error("subject", 'a subject may not start with "Re:" or "Fwd:" (deceptive under CAN-SPAM). Follow-ups without a subject are threaded for you');
    if (message.subject && SPAMMY.test(message.subject)) warn("subject", "the subject has words spam filters look for");
    if (rendered.subject && rendered.subject.length > SUBJECT_SOFT_CHARS) warn("subject", `the subject runs to about ${rendered.subject.length} characters; keep it under ${SUBJECT_SOFT_CHARS}`);
    if (message.step === 1 && !message.allowLinks && LINK.test(message.body)) warn("links", "links in a first email cost deliverability; remove them, or set links: true if you mean it");
    const words = body.split(/\s+/).filter(Boolean).length;
    if (words > EMAIL_SOFT_WORDS) warn("length", `about ${words} words; cold emails that get replies are usually under ${EMAIL_SOFT_WORDS}`);
  }

  if (message.channel === "dm") {
    const limit = message.maxChars ?? (message.platform === "linkedin" && message.step === 1 ? LINKEDIN_NOTE_LIMIT : undefined);
    if (limit !== undefined && body.length > limit) error("length", `about ${body.length} characters with example values; the limit is ${limit}`);
    else if (limit === undefined && body.length > DM_SOFT_LIMIT) warn("length", `about ${body.length} characters; cold DMs work best under ${DM_SOFT_LIMIT}`);
  }

  if (message.channel !== "call" && BRACKET_PLACEHOLDER.test(message.body)) {
    error("placeholder", "square-bracket placeholders like [day] would be sent as written; they belong in call scripts only");
  }

  if (message.channel === "call" && !/^## \S/m.test(message.body)) error("sections", 'call scripts are split into "## Section" headings, starting with the opener');

  return issues;
}
