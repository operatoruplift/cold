import type { Platform } from "../messages";
import type { ProspectLinks } from "../prospects";

/** What happened. Stored in Twenty as coldTouch.kind ("event" is reserved there). */
export type TouchKind = "SENT" | "REPLIED" | "BOUNCED" | "OPTED_OUT" | "UNDELIVERABLE" | "FAILED" | "CALLED";
export type TouchChannel = "EMAIL" | "LINKEDIN" | "X" | "INSTAGRAM" | "FACEBOOK" | "CALL";
export type TouchVoice = "PERSONAL" | "COMPANY";

export const TOUCH_KINDS: readonly TouchKind[] = ["SENT", "REPLIED", "BOUNCED", "OPTED_OUT", "UNDELIVERABLE", "FAILED", "CALLED"];
export const TOUCH_CHANNELS: readonly TouchChannel[] = ["EMAIL", "LINKEDIN", "X", "INSTAGRAM", "FACEBOOK", "CALL"];

/** A DM platform's channel. */
export const platformChannel = (platform: Platform): TouchChannel => platform.toUpperCase() as TouchChannel;

/** One event in the outreach log: the unit both stores read and write. */
export interface Touch {
  id?: string;
  kind: TouchKind;
  channel: TouchChannel;
  voice?: TouchVoice;
  /** The cold.yaml account. */
  account?: string;
  /** "email/personal/founder-direct" */
  sequence?: string;
  step?: number;
  /** "email/personal/founder-direct/1-first-touch" */
  templateId?: string;
  prospectKey: string;
  /** "Dana Reyes (Clearview Tint)", for the record name in Twenty. */
  prospectLabel?: string;
  toAddress?: string;
  fromAddress?: string;
  subject?: string;
  body?: string;
  /** Email Message-ID: of the email sent, or of the reply received. */
  messageId?: string;
  error?: string;
  /** ISO timestamp. */
  occurredAt: string;
  links?: ProspectLinks;
}

/** Where touches are kept: Twenty (coldTouches) or a local JSON-lines file. */
export interface TouchStore {
  readonly kind: "twenty" | "file";
  /** Where it writes, for messages to the user. */
  readonly where: string;
  record(touch: Touch): Promise<void>;
  /** Touches whose prospectKey is one of these identities. */
  forProspects(identities: string[]): Promise<Touch[]>;
  /** Every opt-out, bounce and undeliverable verdict: the suppression list. */
  suppressions(): Promise<Touch[]>;
  /** Touches since a time, optionally narrowed. For daily caps, stats and reply sync. */
  since(isoTime: string, filter?: { account?: string; channel?: TouchChannel; kind?: TouchKind }): Promise<Touch[]>;
  /** Mark the source record Do Not Contact (the dialer's prospect), when there is one. */
  markDoNotContact(links: ProspectLinks | undefined): Promise<void>;
}
