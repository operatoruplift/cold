/**
 * The JSON the local UI's API speaks. Types only: the browser imports this
 * file with `import type`, so nothing here may be a runtime value.
 */
import type { Owner, SessionInfo } from "../auth";
import type { CallSheet } from "../call";
import type { EmailEvent, EmailRunResult } from "../email";
import type { LintIssue, Platform, Voice } from "../messages";
import type { ApplyReport } from "../twenty";
import type { Touch } from "../touches";
import type { WaitlistCounts, WaitlistEntry } from "../waitlist";

/** A saved pairing of a sequence, the account that sends it, an offer and a prospect list. */
export interface Campaign {
  id: string;
  name: string;
  /** "email/personal/founder-direct" */
  sequence: string;
  account: string;
  offer?: string;
  /** "csv:examples/prospects.csv", "twenty:people", ... */
  source: string;
  /** A Twenty REST filter, for Twenty sources. */
  where?: string;
  createdAt: string;
}

export type CampaignInput = Omit<Campaign, "id" | "createdAt">;

export interface AccountStatus {
  key: string;
  voice: Voice;
  senderName: string;
  email?: {
    from: string;
    smtpEnv: string;
    smtpSet: boolean;
    imapEnv?: string;
    imapSet: boolean;
    dailyCap: number;
    window?: string;
  };
  dmCaps: Partial<Record<Platform, number>>;
}

export interface StatusResponse {
  configFile: string;
  /** Where your files are: a folder on this computer, or the database (on a server without a disk). */
  storage: "disk" | "database";
  isExample: boolean;
  configError?: string;
  store: { kind: "twenty" | "file" | "database"; where: string } | { error: string };
  twenty: { configured: boolean; baseUrl?: string };
  reacher: boolean;
  accounts: AccountStatus[];
  offers: Array<{ key: string; audience?: string; offer?: string }>;
  defaultOffer?: string;
}

export interface LibraryStep {
  id: string;
  step: number;
  day: number;
  title: string;
  subject?: string;
  when?: string;
}

export interface LibraryResponse {
  sequences: Array<{ id: string; channel: "email" | "dm"; voice: Voice; platform?: Platform; steps: LibraryStep[] }>;
  callScripts: Array<{ id: string; title: string; voice: Voice; category: string; when?: string }>;
  objections: number;
  issues: LintIssue[];
}

export interface MessageResponse {
  id: string;
  file: string;
  source: string;
  issues: LintIssue[];
}

export interface PreviewResponse {
  subject?: string;
  body?: string;
  footer?: string;
  missing: string[];
  prospectLabel?: string;
  sheet?: CallSheet;
}

export interface SourceOption {
  id: string;
  label: string;
  kind: "csv" | "twenty";
}

export interface ProspectSummary {
  key: string;
  label: string;
  email?: string;
  linkedinUrl?: string;
  xHandle?: string;
  instagramHandle?: string;
  doNotContact: boolean;
  hasTrigger: boolean;
  trigger?: string;
  company?: string;
  city?: string;
  website?: string;
}

/** One person in a campaign plan, with whatever applies to their list. */
export interface PlanRow {
  key: string;
  label: string;
  address?: string;
  step?: number;
  stepTitle?: string;
  when?: string;
  subject?: string;
  text?: string;
  url?: string;
  reason?: string;
  dueOn?: string;
  /** An approved AI draft goes out instead of the template. */
  custom?: boolean;
}

export interface PlanResponse {
  campaign: Campaign;
  channel: "email" | "dm";
  platform?: Platform;
  sequence: { id: string; steps: number };
  account: { key: string; voice: Voice; from?: string };
  prospects: number;
  /** Ready to go now: emails to send, or DMs to work through. */
  due: PlanRow[];
  held: PlanRow[];
  waiting: PlanRow[];
  skipped: PlanRow[];
  cap: number;
  sentToday: number;
  /** How many of `due` fit today. */
  sendable: number;
  window?: { open: boolean; text: string };
  /** Email: the gap between two sends, in seconds. */
  pace?: { min: number; max: number };
  /** Why sending is not possible right now, in words. Empty when it is. */
  blockers: string[];
}

/** What a send job reports, before it is timestamped. */
export type JobEventInput = EmailEvent | { type: "error"; reason: string };

export type JobEvent = JobEventInput & { at: string };

export interface JobResponse {
  id: string;
  status: "running" | "done";
  events: JobEvent[];
  /** Pass back as ?after= to get only newer events. */
  next: number;
  result?: EmailRunResult;
}

export interface TouchRow extends Touch {
  id?: string;
}

export interface StatsResponse {
  days: number;
  templates: Array<{ templateId: string; sequence?: string; step?: number; sent: number; replied: number; optedOut: number; bounced: number }>;
  sequences: Array<{ sequence: string; started: number; replied: number; optedOut: number }>;
  totals: { sent: number; replied: number; optedOut: number; bounced: number };
}

export interface SettingsResponse {
  configFile: string;
  exists: boolean;
  yaml: string;
  errors: string[];
  env: Array<{ name: string; set: boolean; hint: string }>;
  /** Where saved keys go: ".env.local", or "the database (encrypted)". Absent when they cannot be saved here. */
  secretsWhere?: string;
  storage: "disk" | "database";
}

export interface ActionResponse {
  ok: boolean;
  message: string;
  lines?: string[];
  report?: ApplyReport;
}

/** Who is signed in, and whether the owner login still has to be created. */
export interface SessionResponse {
  signedIn: boolean;
  /** Only when signed in. */
  owner?: Owner;
  setupRequired: boolean;
  mode: "local" | "hosted";
  version: string;
}

export interface SessionsResponse {
  sessions: SessionInfo[];
}

export interface WaitlistResponse {
  entries: WaitlistEntry[];
  counts: WaitlistCounts;
}

export type { Owner, SessionInfo, WaitlistCounts, WaitlistEntry };

export interface AiStatusResponse {
  configured: boolean;
  model: string;
  usage?: { runs: number; inputTokens: number; outputTokens: number; searches: number };
  finds: Array<{ id: string; status: "running" | "done" | "failed"; input: { area?: string; count?: number; offer?: string }; createdAt: string; found: number; error?: string }>;
}
