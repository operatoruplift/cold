/** An email ready for the SMTP transport. */
export interface EmailDraft {
  from: string;
  to: string;
  subject: string;
  /** Plain text only: no HTML, no tracking pixel. */
  text: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  headers: Record<string, string>;
}

/** What an inbound email means for the sequence. AUTO_REPLY and DELAYED change nothing. */
export type InboundKind = "REPLIED" | "OPTED_OUT" | "BOUNCED" | "AUTO_REPLY" | "DELAYED";

export interface InboundEmail {
  from?: string;
  subject?: string;
  text?: string;
  /** A bounce's machine-readable delivery report (message/delivery-status), when attached. */
  report?: string;
  /** Lowercased header names. */
  headers: Record<string, string>;
}

export interface InboundVerdict {
  kind: InboundKind;
  /** For bounces: the addresses that failed. */
  failedAddresses: string[];
  /** The reply's own text, above any quoted message. */
  newText: string;
}
