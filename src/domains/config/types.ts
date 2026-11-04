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

/** When to call, in each prospect's own time zone. The US rule is 8am to 9pm; other countries set their own. */
export interface CallHours {
  days: Weekday[];
  /** "08:00" */
  start: string;
  /** "21:00": the first minute calls stop. */
  end: string;
}

export const DEFAULT_CALL_HOURS: CallHours = { days: [...WEEKDAYS], start: "08:00", end: "21:00" };

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

/** How the decision engine runs: who decides, who does diligence, when you check, whether it explores. */
export interface DecideSettings {
  /** auto: Jev when TYPESAFE_API_KEY is set, else Claude. */
  provider: "auto" | "jev" | "claude";
  /** auto: SubQ when SUBQ_API_KEY is set, else Claude. */
  diligence: "auto" | "subq" | "claude";
  /** A next step less sure than this goes to you to check. */
  reviewBelow: number;
  /** Now and then try another tone or opening than the model's pick, to learn what gets replies. */
  explore: boolean;
}

export const DEFAULT_DECIDE: DecideSettings = { provider: "auto", diligence: "auto", reviewBelow: 0.75, explore: true };

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
  decide: DecideSettings;
  /** When prospects may be called, in their own time. */
  calls: CallHours;
}
