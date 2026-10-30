import { CHANNELS, PLATFORMS, VOICES, type Channel, type LintIssue, type Message, type Platform, type Voice } from "../types";
import { splitFrontMatter } from "./splitFrontMatter";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const STEP_FILE = /^(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const SCRIPT_FILE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const KNOWN_KEYS = new Set(["title", "day", "subject", "when", "notes", "platform", "category", "max_chars", "links", "variables"]);

/**
 * Build a Message from its path under messages/ and its source. Path rules:
 *   email/<voice>/<sequence>/<step>-<slug>.md
 *   dm/<voice>/<sequence>/<step>-<slug>.md
 *   call/<voice>/<slug>.md
 * Pure. Returns every problem found; a message is returned only when it is usable.
 */
export function toMessage(relPath: string, source: string, fileForErrors = `messages/${relPath}`): { message?: Message; issues: LintIssue[] } {
  const issues: LintIssue[] = [];
  const error = (rule: string, message: string) => issues.push({ level: "error", file: fileForErrors, rule, message });
  const warn = (rule: string, message: string) => issues.push({ level: "warning", file: fileForErrors, rule, message });

  const parts = relPath.split("/");
  const channel = parts[0] as Channel;
  const voice = parts[1] as Voice;
  if (!CHANNELS.includes(channel)) {
    error("path", `the first folder must be one of ${CHANNELS.join(", ")}`);
    return { issues };
  }
  if (!VOICES.includes(voice)) {
    error("path", `the second folder must be one of ${VOICES.join(", ")}`);
    return { issues };
  }

  let sequence: string | undefined;
  let step: number | undefined;
  if (channel === "call") {
    if (parts.length !== 3 || !SCRIPT_FILE.test(parts[2]!)) {
      error("path", "call scripts live at messages/call/<voice>/<slug>.md (lowercase-with-dashes)");
      return { issues };
    }
  } else {
    const match = parts.length === 4 ? STEP_FILE.exec(parts[3]!) : null;
    if (!match || !SLUG.test(parts[2]!)) {
      error("path", `${channel} messages live at messages/${channel}/<voice>/<sequence>/<step>-<slug>.md, e.g. 1-first-touch.md`);
      return { issues };
    }
    sequence = parts.slice(0, 3).join("/");
    step = Number(match[1]);
  }

  const { data, body, error: fmError } = splitFrontMatter(source);
  if (fmError) {
    error("front-matter", fmError);
    return { issues };
  }
  for (const key of Object.keys(data)) if (!KNOWN_KEYS.has(key)) warn("front-matter", `unknown key "${key}"`);

  const str = (key: string): string | undefined => {
    const value = data[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" && typeof value !== "number") {
      error("front-matter", `"${key}" must be text`);
      return undefined;
    }
    return String(value).trim() || undefined;
  };

  const title = str("title");
  if (!title) error("title", "every message needs a title");

  let day: number | undefined;
  if (channel !== "call") {
    if (typeof data.day !== "number" || !Number.isInteger(data.day) || data.day < 0) error("day", "day must be a whole number of days after step 1 (step 1 is day 0)");
    else day = data.day;
  }

  let platform: Platform | undefined;
  const platformValue = str("platform");
  if (channel === "dm") {
    if (!platformValue || !PLATFORMS.includes(platformValue as Platform)) error("platform", `DM messages need platform: one of ${PLATFORMS.join(", ")}`);
    else platform = platformValue as Platform;
  } else if (platformValue) {
    error("platform", "platform only applies to DM messages");
  }

  const category = str("category");
  if (channel === "call" && !category) error("category", "call scripts need a category (Introduction, Follow-up, General, ...), shown in the dialer");

  let maxChars: number | undefined;
  if (data.max_chars !== undefined) {
    if (typeof data.max_chars !== "number" || !Number.isInteger(data.max_chars) || data.max_chars <= 0) error("max-chars", "max_chars must be a positive whole number");
    else maxChars = data.max_chars;
  }

  if (data.links !== undefined && typeof data.links !== "boolean") error("links", "links must be true or false");

  let customVariables: string[] = [];
  if (data.variables !== undefined) {
    if (!Array.isArray(data.variables) || !data.variables.every((v) => typeof v === "string")) error("variables", "variables must be a list of names");
    else customVariables = data.variables as string[];
  }

  const subject = str("subject");
  if (subject && channel !== "email") error("subject", "only email messages have a subject");
  if (!body.trim()) error("body", "the message body is empty");

  if (issues.some((i) => i.level === "error")) return { issues };

  const message: Message = {
    id: relPath.replace(/\.md$/, ""),
    file: fileForErrors,
    channel,
    voice,
    platform,
    sequence,
    step,
    day,
    title: title!,
    subject,
    when: str("when"),
    notes: str("notes"),
    category,
    maxChars,
    allowLinks: data.links === true,
    customVariables,
    body,
  };
  return { message, issues };
}
