export type Channel = "email" | "dm" | "call";
export type Voice = "personal" | "company";
export type Platform = "linkedin" | "x" | "instagram" | "facebook";

export const CHANNELS: readonly Channel[] = ["email", "dm", "call"];
export const VOICES: readonly Voice[] = ["personal", "company"];
export const PLATFORMS: readonly Platform[] = ["linkedin", "x", "instagram", "facebook"];

/**
 * One message file. Email and DM messages are steps of a sequence
 * (messages/<channel>/<voice>/<sequence>/<step>-<slug>.md); call scripts stand
 * alone (messages/call/<voice>/<slug>.md).
 */
export interface Message {
  /** Path under messages/ without .md, e.g. "email/personal/founder-direct/1-first-touch". */
  id: string;
  /** Path from the repository root, for error messages. */
  file: string;
  channel: Channel;
  voice: Voice;
  /** DM messages only. */
  platform?: Platform;
  /** "email/personal/founder-direct"; call scripts have none. */
  sequence?: string;
  step?: number;
  /** Days after step 1 that this step becomes due. Step 1 is day 0. */
  day?: number;
  title: string;
  /** Email only. A follow-up without one is sent as a reply in the same thread. */
  subject?: string;
  /** When to use it, shown by `cold list` and `cold preview`. */
  when?: string;
  notes?: string;
  /** Call scripts: the category shown in the dialer. */
  category?: string;
  /** Hard limit on the rendered length (LinkedIn notes: 200). */
  maxChars?: number;
  /** Email: allow links in a first email (they cost deliverability). */
  allowLinks: boolean;
  /** Extra variables this message may use beyond the contract. */
  customVariables: string[];
  body: string;
}

export interface Sequence {
  /** "email/personal/founder-direct" */
  id: string;
  channel: Exclude<Channel, "call">;
  voice: Voice;
  platform?: Platform;
  /** Ordered by step. */
  steps: Message[];
}

/** One objection with a response in each voice (messages/call/objections.yaml). */
export interface Objection {
  objection: string;
  category: string;
  personal: string;
  company: string;
}

export interface Library {
  messages: Message[];
  sequences: Sequence[];
  callScripts: Message[];
  objections: Objection[];
}

export type IssueLevel = "error" | "warning";

export interface LintIssue {
  level: IssueLevel;
  file: string;
  rule: string;
  message: string;
}
