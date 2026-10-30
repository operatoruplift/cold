import type { Platform, Voice } from "../messages";

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** When an account may send email, in its own timezone. */
export interface SendWindow {
  days: Weekday[];
  /** "08:00" */
  start: string;
  /** "17:00" */
  end: string;
  /** IANA name, e.g. "America/Chicago" */
  timezone: string;
}

export interface EmailSettings {
  /** "Alex Morgan <alex@brightside.example>" */
  from: string;
  /** The env var holding the SMTP URL, e.g. SMTP_URL_PERSONAL. */
  smtpUrlEnv: string;
  /** The env var holding the IMAP URL, for reply and opt-out sync. */
  imapUrlEnv?: string;
  dailyCap: number;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  window?: SendWindow;
  /** Appended to every email. Must give a postal address and a way to opt out. */
  footer: string;
  /** An https endpoint that unsubscribes on POST (RFC 8058 one-click). */
  unsubscribeUrl?: string;
}

export interface DmSettings {
  /** Most DMs per platform per day, across sequences. */
  dailyCaps: Partial<Record<Platform, number>>;
}

/** Who sends: a person (personal voice) or the company (company voice). */
export interface Account {
  key: string;
  voice: Voice;
  /** sender_name, booking_url, postal_address, ... */
  variables: Record<string, string>;
  email?: EmailSettings;
  dm: DmSettings;
}

/** What is being offered: audience, offer, outcome, pain, proof. */
export interface Offer {
  key: string;
  variables: Record<string, string>;
}

export type StoreKind = "auto" | "twenty" | "file";

export interface ColdConfig {
  /** The file it was read from. */
  file: string;
  /** True when no cold.yaml exists and the example file was used. Sending is refused. */
  isExample: boolean;
  accounts: Record<string, Account>;
  offers: Record<string, Offer>;
  defaultOffer?: string;
  store: StoreKind;
  /** The touch log when the store is a file. */
  logFile: string;
}
