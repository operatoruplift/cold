import { PLATFORMS, VOICES, type Platform, type Voice } from "../../messages";
import { VARIABLES } from "../../render";
import { DEFAULT_CALL_HOURS, DEFAULT_DECIDE, WEEKDAYS, type Account, type CallHours, type ColdConfig, type DecideSettings, type DmSettings, type EmailSettings, type Offer, type SendWindow, type StoreKind, type Weekday } from "../types";

const ACCOUNT_VARIABLES = new Set(VARIABLES.filter((v) => v.scope === "account").map((v) => v.name));
const OFFER_VARIABLES = new Set(VARIABLES.filter((v) => v.scope === "offer").map((v) => v.name));
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The footer used when an account does not set one, by voice. */
export const DEFAULT_FOOTERS: Record<Voice, string> = {
  personal: '{{sender_name}}, {{sender_company}}\n{{postal_address}}\nNot for you? Reply "stop" and I won\'t email you again.',
  company: '{{sender_company}}, {{postal_address}}\nNot interested? Reply "unsubscribe" and we\'ll take you off our list.',
};

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");

/**
 * Validate a parsed cold.yaml. Pure: returns every problem in words, so a
 * typo is reported once with its path instead of failing a send later.
 */
export function parseConfig(raw: unknown, file: string, isExample = false): { config?: ColdConfig; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(raw)) return { errors: [`${file} must be a YAML mapping (key: value)`] };

  const accounts: Record<string, Account> = {};
  if (!isObject(raw.accounts) || Object.keys(raw.accounts).length === 0) {
    errors.push("accounts: add at least one account (see cold.example.yaml)");
  } else {
    for (const [key, value] of Object.entries(raw.accounts)) {
      const account = parseAccount(key, value, errors);
      if (account) accounts[key] = account;
    }
  }

  const offers: Record<string, Offer> = {};
  if (raw.offers !== undefined && !isObject(raw.offers)) errors.push("offers: must be a mapping of offer names");
  for (const [key, value] of Object.entries(isObject(raw.offers) ? raw.offers : {})) {
    if (!isObject(value)) {
      errors.push(`offers.${key}: must be a mapping`);
      continue;
    }
    const variables: Record<string, string> = {};
    for (const [name, v] of Object.entries(value)) {
      if (!OFFER_VARIABLES.has(name)) errors.push(`offers.${key}.${name}: not an offer variable (${[...OFFER_VARIABLES].join(", ")})`);
      else if (text(v)) variables[name] = text(v);
    }
    offers[key] = { key, variables };
  }

  const defaultOffer = text(raw.default_offer) || undefined;
  if (defaultOffer && !offers[defaultOffer]) errors.push(`default_offer: "${defaultOffer}" is not one of the offers`);

  const store = (text(raw.store) || "auto") as StoreKind;
  if (!["auto", "twenty", "file"].includes(store)) errors.push("store: must be auto, twenty or file");

  const decide = parseDecide(raw.decide, errors);
  const calls = parseCalls(raw.calls, errors);

  if (errors.length) return { errors };
  return {
    config: { file, isExample, accounts, offers, defaultOffer, store, logFile: text(raw.log_file) || ".cold/touches.jsonl", decide, calls },
    errors,
  };
}

function parseAccount(key: string, value: unknown, errors: string[]): Account | undefined {
  const at = `accounts.${key}`;
  if (!isObject(value)) {
    errors.push(`${at}: must be a mapping`);
    return undefined;
  }
  const voice = text(value.voice) as Voice;
  if (!VOICES.includes(voice)) errors.push(`${at}.voice: must be personal or company`);

  const variables: Record<string, string> = {};
  for (const [name, v] of Object.entries(value)) {
    if (["voice", "email", "dm"].includes(name)) continue;
    if (!ACCOUNT_VARIABLES.has(name)) errors.push(`${at}.${name}: not an account setting or variable (${[...ACCOUNT_VARIABLES].join(", ")})`);
    else if (text(v)) variables[name] = text(v);
  }
  if (!variables.sender_name) errors.push(`${at}.sender_name: required`);
  if (variables.sender_name && !variables.sender_first_name) variables.sender_first_name = variables.sender_name.split(/\s+/)[0]!;

  const email = value.email === undefined ? undefined : parseEmail(`${at}.email`, value.email, voice, errors);
  const dm = parseDm(`${at}.dm`, value.dm, errors);
  return { key, voice, variables, email, dm };
}

function parseEmail(at: string, value: unknown, voice: Voice, errors: string[]): EmailSettings | undefined {
  if (!isObject(value)) {
    errors.push(`${at}: must be a mapping`);
    return undefined;
  }
  const from = text(value.from);
  if (!/<[^>@\s]+@[^>\s]+>$|^[^\s@]+@[^\s@]+$/.test(from)) errors.push(`${at}.from: needs an address, like "Alex Morgan <alex@yourdomain.com>"`);
  const smtpUrlEnv = text(value.smtp_url_env);
  if (!/^[A-Z][A-Z0-9_]*$/.test(smtpUrlEnv)) errors.push(`${at}.smtp_url_env: the NAME of the env var holding the SMTP URL, e.g. SMTP_URL_PERSONAL`);
  const imapUrlEnv = text(value.imap_url_env) || undefined;
  if (imapUrlEnv && !/^[A-Z][A-Z0-9_]*$/.test(imapUrlEnv)) errors.push(`${at}.imap_url_env: the NAME of an env var, e.g. IMAP_URL_PERSONAL`);

  const int = (name: string, fallback: number, min: number, max: number) => {
    const v = value[name];
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      errors.push(`${at}.${name}: a whole number from ${min} to ${max}`);
      return fallback;
    }
    return v;
  };
  const dailyCap = int("daily_cap", 30, 1, 500);
  const minDelaySeconds = int("min_delay_seconds", 60, 0, 3600);
  const maxDelaySeconds = int("max_delay_seconds", 180, 0, 3600);
  if (maxDelaySeconds < minDelaySeconds) errors.push(`${at}.max_delay_seconds: must be at least min_delay_seconds`);

  let window: SendWindow | undefined;
  if (value.window !== undefined) {
    const w = value.window;
    if (!isObject(w)) errors.push(`${at}.window: must be a mapping`);
    else {
      const days = Array.isArray(w.days) ? w.days.map((d) => text(d).toLowerCase()) : [];
      if (!days.length || !days.every((d) => WEEKDAYS.includes(d as Weekday))) errors.push(`${at}.window.days: a list like [mon, tue, wed, thu, fri]`);
      const start = text(w.start);
      const end = text(w.end);
      if (!TIME.test(start) || !TIME.test(end) || start >= end) errors.push(`${at}.window: start and end as "HH:MM", start before end`);
      const timezone = text(w.timezone);
      if (!isTimezone(timezone)) errors.push(`${at}.window.timezone: an IANA timezone, e.g. America/Chicago`);
      window = { days: days as Weekday[], start, end, timezone };
    }
  }

  const footer = text(value.footer) || DEFAULT_FOOTERS[voice] || DEFAULT_FOOTERS.personal;
  const unsubscribeUrl = text(value.unsubscribe_url) || undefined;
  if (unsubscribeUrl && !/^https:\/\//.test(unsubscribeUrl)) errors.push(`${at}.unsubscribe_url: must be an https URL (RFC 8058)`);

  return { from, smtpUrlEnv, imapUrlEnv, dailyCap, minDelaySeconds, maxDelaySeconds, window, footer, unsubscribeUrl };
}

function parseDm(at: string, value: unknown, errors: string[]): DmSettings {
  const dailyCaps: Partial<Record<Platform, number>> = { linkedin: 20, x: 30, instagram: 20, facebook: 20 };
  if (value === undefined) return { dailyCaps };
  if (!isObject(value)) {
    errors.push(`${at}: must be a mapping`);
    return { dailyCaps };
  }
  const caps = value.daily_caps;
  if (caps !== undefined) {
    if (!isObject(caps)) errors.push(`${at}.daily_caps: must be a mapping like { linkedin: 20 }`);
    else {
      for (const [platform, cap] of Object.entries(caps)) {
        if (!PLATFORMS.includes(platform as Platform)) errors.push(`${at}.daily_caps.${platform}: not a platform (${PLATFORMS.join(", ")})`);
        else if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 0 || cap > 500) errors.push(`${at}.daily_caps.${platform}: a whole number from 0 to 500`);
        else dailyCaps[platform as Platform] = cap;
      }
    }
  }
  return { dailyCaps };
}

function isTimezone(name: string): boolean {
  if (!name) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The default calling hours as a config's own copy, so nothing that edits one config's days edits the defaults. */
const defaultCallHours = (): CallHours => ({ ...DEFAULT_CALL_HOURS, days: [...DEFAULT_CALL_HOURS.days] });

/** The optional calls: section: when to call, in each prospect's own time. Every key has a default. */
function parseCalls(raw: unknown, errors: string[]): CallHours {
  if (raw === undefined || raw === null) return defaultCallHours();
  if (!isObject(raw)) {
    errors.push("calls: must be a mapping (start, end, days)");
    return defaultCallHours();
  }
  for (const key of Object.keys(raw)) if (!["start", "end", "days"].includes(key)) errors.push(`calls.${key}: not a calls setting (start, end, days)`);
  const start = text(raw.start) || DEFAULT_CALL_HOURS.start;
  const end = text(raw.end) || DEFAULT_CALL_HOURS.end;
  if (!TIME.test(start) || !TIME.test(end) || start >= end) errors.push('calls: start and end as "HH:MM" in the prospect\'s time, start before end, e.g. start: "08:00", end: "21:00"');
  let days = [...DEFAULT_CALL_HOURS.days];
  if (raw.days !== undefined) {
    const given = Array.isArray(raw.days) ? raw.days.map((d) => text(d).toLowerCase()) : [];
    if (!given.length || !given.every((d) => WEEKDAYS.includes(d as Weekday))) errors.push("calls.days: a list like [mon, tue, wed, thu, fri, sat]");
    else days = given as Weekday[];
  }
  return { start, end, days };
}

/** The optional decide: section. Every key has a default, so it can be left out entirely. */
function parseDecide(raw: unknown, errors: string[]): DecideSettings {
  if (raw === undefined || raw === null) return { ...DEFAULT_DECIDE };
  if (!isObject(raw)) {
    errors.push("decide: must be a mapping (provider, diligence, review_below, explore)");
    return { ...DEFAULT_DECIDE };
  }
  const known = new Set(["provider", "diligence", "review_below", "explore"]);
  for (const key of Object.keys(raw)) if (!known.has(key)) errors.push(`decide.${key}: not a decide setting (${[...known].join(", ")})`);
  const provider = (text(raw.provider) || DEFAULT_DECIDE.provider) as DecideSettings["provider"];
  if (!["auto", "jev", "claude"].includes(provider)) errors.push("decide.provider: must be auto, jev or claude");
  const diligence = (text(raw.diligence) || DEFAULT_DECIDE.diligence) as DecideSettings["diligence"];
  if (!["auto", "subq", "claude"].includes(diligence)) errors.push("decide.diligence: must be auto, subq or claude");
  const reviewBelow = raw.review_below === undefined ? DEFAULT_DECIDE.reviewBelow : Number(raw.review_below);
  if (!Number.isFinite(reviewBelow) || reviewBelow < 0 || reviewBelow > 1) errors.push("decide.review_below: must be a number from 0 to 1, e.g. 0.75");
  if (raw.explore !== undefined && typeof raw.explore !== "boolean") errors.push("decide.explore: must be true or false");
  return { provider, diligence, reviewBelow: Number.isFinite(reviewBelow) ? reviewBelow : DEFAULT_DECIDE.reviewBelow, explore: raw.explore === undefined ? DEFAULT_DECIDE.explore : raw.explore === true };
}
