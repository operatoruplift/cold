import type { Touch } from "../../touches";
import type { EmailDraft } from "../types";
import { addressOf } from "./address";

export interface BuildEmailInput {
  from: string;
  to: string;
  /** This step's rendered subject. Without one, the email replies in the thread. */
  subject?: string;
  body: string;
  footer: string;
  /** Step 1 of the sequence as sent: its subject names the thread. */
  first?: Touch;
  /** The step before this one as sent: threaded and quoted below. */
  previous?: Touch;
  messageId: string;
  /** Rendered https URL for one-click unsubscribe (RFC 8058). */
  unsubscribeUrl?: string;
  timeZone?: string;
}

function quote(previous: Touch, timeZone?: string): string {
  const when = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: timeZone ?? "UTC" }).format(new Date(previous.occurredAt));
  const lines = (previous.body ?? "").split("\n").map((line) => (line ? `> ${line}` : ">"));
  return `On ${when}, ${previous.fromAddress ?? "I"} wrote:\n${lines.join("\n")}`;
}

/**
 * Assemble one plain-text cold email. Pure.
 *
 * - A step with its own subject starts a thread. A step without one is a
 *   reply: "Re: <step 1 subject>", In-Reply-To and References set, and the
 *   previous email quoted underneath, the way a person replying would.
 * - The footer (postal address and how to opt out) goes on every email.
 * - List-Unsubscribe always offers a mailto; with an https URL it also offers
 *   one-click unsubscribe (List-Unsubscribe-Post).
 */
export function buildEmail(input: BuildEmailInput): EmailDraft {
  const fromAddress = addressOf(input.from);
  const threaded = !input.subject && !!input.previous;
  const firstSubject = input.first?.subject ?? input.previous?.subject;
  const subject = input.subject ?? (firstSubject ? `Re: ${firstSubject.replace(/^re:\s*/i, "")}` : "Following up");

  const parts = [input.body.trim(), input.footer.trim()];
  if (threaded && input.previous?.body) parts.push(quote(input.previous, input.timeZone));
  const text = `${parts.filter(Boolean).join("\n\n")}\n`;

  const unsubscribe = [`<mailto:${fromAddress}?subject=unsubscribe>`];
  const headers: Record<string, string> = {};
  if (input.unsubscribeUrl) {
    unsubscribe.push(`<${input.unsubscribeUrl}>`);
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  headers["List-Unsubscribe"] = unsubscribe.join(", ");

  const references = threaded ? [...new Set([input.first?.messageId, input.previous?.messageId].filter((id): id is string => !!id))] : undefined;
  return {
    from: input.from,
    to: input.to,
    subject,
    text,
    messageId: input.messageId,
    inReplyTo: threaded ? input.previous?.messageId : undefined,
    references: references?.length ? references : undefined,
    headers,
  };
}
