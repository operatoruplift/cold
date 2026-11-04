import type { CallTime } from "../callHours";

/** Where new-lead alerts go: a topic on ntfy.sh or on your own ntfy server. */
export interface NtfyTarget {
  /** The server's root, where messages are published as JSON: "https://ntfy.sh/". */
  server: string;
  topic: string;
  /** An access token, for a topic that needs one. */
  token?: string;
}

/** One push, in ntfy's JSON publish shape. */
export interface NtfyMessage {
  topic: string;
  title: string;
  message: string;
  tags: string[];
  /** 1 (min) to 5 (max); 3 is ntfy's default. */
  priority: number;
  /** Opened when the notification is tapped. */
  click?: string;
}

/** One of offer's quiz leads, as the Calls page lists it. */
export interface QuizLead {
  /** The agencyLead's id in Twenty. */
  id: string;
  /** The prospect key, to pick them in a call script (source twenty:agencyLeads). */
  prospectKey: string;
  label: string;
  name?: string;
  company?: string;
  phone?: string;
  email?: string;
  /** When they took the quiz. */
  createdAt?: string;
  /** offer marked them qualified (or didn't say otherwise). */
  qualified: boolean;
  /** "question: answer", one each. */
  answers: string[];
  /** Where they came from: offer's source, or a UTM source. */
  from?: string;
  /** When they were last called, from the touch log. */
  calledAt?: string;
  /** How that call went, when the dialer logged it: "Appointment set". */
  callOutcome?: string;
  doNotContact: boolean;
  /** Whether they can be called now, in their own time. */
  callTime?: CallTime;
}

/** What one look for new leads did. */
export interface LeadCheck {
  /** False when it was skipped: alerts aren't set up, or another look ran within the minute. */
  looked: boolean;
  /** Pushes sent. */
  alerted: number;
  /** Leads that came in, qualified or not. */
  found: number;
  error?: string;
}

/** The source the quiz leads load from. */
export const LEADS_SOURCE = "twenty:agencyLeads";
/** A look for new leads at most this often, across every server on the database. */
export const LEAD_CHECK_MS = 60_000;
/** The Calls page lists the leads of this many days. */
export const LEAD_WINDOW_DAYS = 14;
/** More new leads than this in one look come as one push that counts them. */
export const MAX_LEAD_PUSHES = 5;
/** A look reads at most this many new leads; more come over the next looks, oldest first. */
export const MAX_LEADS_PER_CHECK = 500;
