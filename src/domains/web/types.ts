/**
 * The JSON the local UI's API speaks. Types only: the browser imports this
 * file with `import type`, so nothing here may be a runtime value.
 */
import type { AiProvider, Angle, Tone } from "../ai";
import type { Owner, SessionInfo } from "../auth";
import type { CallSheet } from "../call";
import type { DecideSettings } from "../config";
import type { Action, Decision, Dossier, PickedBy, StyleInsights, Tier } from "../decide";
import type { EmailEvent, EmailRunResult } from "../email";
import type { QuizLead } from "../leads";
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
  /** Who goes first when the daily cap can't reach everyone: the list's order, or the highest score. */
  order?: "list" | "score";
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
  kind: "csv" | "twenty" | "listen";
}

/** Settings, Listening: OpenMagpie's webhook target and the watches that have delivered. */
export interface ListenStatusResponse {
  /** COLD_LISTEN_SECRET is set. */
  configured: boolean;
  /** The app's database is there to keep matches. */
  available: boolean;
  /** Point OpenMagpie's webhook action here, with Authorization: Bearer <COLD_LISTEN_SECRET>. */
  webhookUrl: string;
  watches: Array<{ id: string; name: string; count: number; latest: string }>;
}

/** Lead alerts: whether they are set up, and when they last looked. */
export interface LeadAlertState {
  /** COLD_NTFY_URL is set and usable. */
  configured: boolean;
  /** What is wrong with COLD_NTFY_URL, in words. */
  problem?: string;
  /** The app's database is there to remember which leads were pushed. */
  available: boolean;
  /** When the last look for new leads ran. */
  lookedAt?: string;
  /** The newest lead it has seen. */
  seenUntil?: string;
}

/** Settings, Lead alerts. */
export interface LeadAlertsResponse {
  /** Twenty is connected, so offer's agencyLeads can be read. */
  twenty: boolean;
  alerts: LeadAlertState;
}

/** The Calls page's quiz leads from offer. */
export interface LeadsResponse extends LeadAlertsResponse {
  /** The last two weeks' leads, best to call first. */
  leads: QuizLead[];
  /** Why the leads couldn't be read. */
  error?: string;
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
  /** The decision engine's latest call on them, for the campaign's offer. */
  score?: number;
  tier?: Tier;
  action?: Action;
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
  /** X DMs: whether the campaign's account can send through X's API, and as whom. */
  x?: XSendState;
}

/** After Send on X: it went out, or they had replied, so nothing did. */
export interface XSendResponse {
  ok: boolean;
  outcome: "SENT" | "REPLIED";
  message: string;
}

/** Can cold send an X DM itself for this account? When not, why, in words. */
export interface XSendState {
  ready: boolean;
  username?: string;
  why?: string;
}

/** Settings, X: the developer app, the callback URL to register, and each account's connection. */
export interface XStatusResponse {
  /** X_CLIENT_ID is set. */
  configured: boolean;
  /** The app's database is there to keep sign-ins. */
  available: boolean;
  /** Register this as the callback URL of the app at developer.x.com. */
  callbackUrl: string;
  accounts: Array<{ key: string; voice: Voice; username?: string; connectedAt?: string }>;
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

/* ---------------------------------------------------------------- the decision engine */

export interface DecideStatusResponse {
  settings: DecideSettings;
  /** Who decides and who does diligence right now, or why they can't. */
  decide: { provider: "jev" | "claude" | null; model?: string; error?: string };
  diligence: { provider: "subq" | "claude" | null; model?: string; error?: string };
  keys: { typesafe: boolean; subq: boolean; anthropic: boolean };
  counts: { decisions: number; assignments: number };
  usage: Array<{ provider: AiProvider; runs: number; inputTokens: number; outputTokens: number }>;
}

/** A prospect's decision, short, for a list. */
export interface ScoreSummary {
  score: number;
  tier: Tier;
  action: Action;
  review: boolean;
  tone: Tone;
  angle: Angle;
  need?: string;
  evidence: Decision["evidence"];
  provider: Decision["provider"];
  decidedAt: string;
}

export interface ScoresResponse {
  offer: string;
  scores: Record<string, ScoreSummary>;
  /** When each prospect's diligence was done. */
  diligence: Record<string, string>;
}

export interface ProspectDecisionResponse {
  decision?: Decision;
  dossier?: Dossier;
  dossierAt?: string;
}

export interface StyleChoice {
  tone: Tone;
  angle: Angle;
  pickedBy: PickedBy;
  why: string;
}

export type InsightsResponse = StyleInsights;

/** A list being scored on the server, and how far it has got. */
export interface ScoreJobView {
  id: string;
  status: "running" | "done" | "stopped";
  source: string;
  offer: string;
  deep: boolean;
  total: number;
  counts: { pending: number; working: number; done: number; skipped: number; failed: number };
  /** Why it ended early, when it did: no key, no config. */
  error?: string;
  createdAt: string;
  updatedAt: string;
  /** The last few prospects it finished. */
  recent: Array<{ label: string; status: "done" | "skipped" | "failed"; note?: string; score?: number; tier?: Tier }>;
}
