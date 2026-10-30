import type { InboundEmail, InboundVerdict } from "../types";

const BOUNCE_FROM = /mailer-daemon|postmaster|mail delivery (sub)?system/i;
const BOUNCE_SUBJECT = /undeliver|delivery status notification|returned mail|delivery fail|failure notice|could not be delivered|address not found|mail delivery failed|delivery delayed|delayed mail/i;
const DELAY_HINT = /\(delay\)|delivery delayed|delayed mail|will (be )?retr(y|ied)|still trying|not yet been delivered|temporar(y|ily)/i;
const AUTO_SUBJECT = /^(automatic reply|auto(-| )?reply|autoreply|out of (the )?office|away from|on vacation|on leave)/i;
/** Asking to stop, anywhere in what they wrote. */
const OPT_OUT = /\b(unsubscribe|remove me|opt(-| )?out|take me off|stop (emailing|contacting|messaging|sending)|do not (email|contact)|don'?t (email|contact)|no more emails?)\b/i;
/** A reply that is only "stop" (or "please stop", "STOP."): "Stop by the shop Tuesday" is not. */
const BARE_STOP = /^(please\s+)?stop(\s+(please|now|it|this))?[\s.!]*$/i;
const QUOTE_START = /^(>|On .+wrote:\s*$|-{2,}\s*Original Message|From:\s|_{5,}|Sent from my )/i;
const RECIPIENT = /(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s>;]+@[^\s>;]+)>?/i;
const ANY_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** The text someone wrote above the quoted message. */
export function newTextOf(text: string | undefined): string {
  const lines: string[] = [];
  for (const line of (text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    if (QUOTE_START.test(line.trim())) break;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

/** The text someone wrote below the quoted message (bottom-posting): everything after the last "> " line. */
export function textAfterQuote(text: string | undefined): string {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  let lastQuoted = -1;
  lines.forEach((line, i) => {
    if (/^\s*>/.test(line)) lastQuoted = i;
  });
  return lastQuoted === -1 ? "" : lines.slice(lastQuoted + 1).join("\n").trim();
}

/**
 * Read a delivery report: per recipient, did it fail for good or is the
 * server still trying? Each recipient has its own block with Final-Recipient
 * and Action (failed, delayed, ...) or a Status (5.x.x permanent, 4.x.x not).
 */
export function readDeliveryReport(report: string): { failed: string[]; delayed: string[]; unknown: string[] } {
  const out = { failed: new Set<string>(), delayed: new Set<string>(), unknown: new Set<string>() };
  for (const block of report.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    const recipient = RECIPIENT.exec(block)?.[1]?.toLowerCase();
    if (!recipient) continue;
    const action = /^Action:\s*(\w+)/im.exec(block)?.[1]?.toLowerCase();
    const status = /^Status:\s*(\d)\./im.exec(block)?.[1];
    if (action === "failed" || (!action && status === "5")) out.failed.add(recipient);
    else if (action === "delayed" || (!action && status === "4")) out.delayed.add(recipient);
    else if (!action && !status) out.unknown.add(recipient);
  }
  return { failed: [...out.failed], delayed: [...out.delayed], unknown: [...out.unknown] };
}

/**
 * Decide what an inbound email means. Pure. In order:
 *
 *  - a delivery notice: a permanent failure is a bounce, for the recipients
 *    that failed; a delay ("still trying") is not, and is ignored;
 *  - an automatic reply (out of office): ignored, the sequence carries on;
 *  - an opt-out: "unsubscribe", "remove me", "stop emailing me", or a reply
 *    that is only "stop";
 *  - otherwise a reply.
 *
 * Opt-outs are read from what the person wrote, above the quote or, when
 * they wrote below it, after it. Never from the quoted email, whose footer
 * itself says "reply stop".
 */
export function classifyInbound(email: InboundEmail): InboundVerdict {
  const h = email.headers;
  const newText = newTextOf(email.text) || textAfterQuote(email.text);
  const contentType = h["content-type"] ?? "";
  const isReport = /multipart\/report/i.test(contentType) && /delivery-status/i.test(contentType);

  if (isReport || BOUNCE_FROM.test(email.from ?? "") || BOUNCE_SUBJECT.test(email.subject ?? "")) {
    const report = readDeliveryReport(`${email.report ?? ""}\n\n${email.text ?? ""}`);
    if (report.failed.length) return { kind: "BOUNCED", failedAddresses: report.failed, newText };
    if (report.delayed.length) return { kind: "DELAYED", failedAddresses: [], newText };
    if (DELAY_HINT.test(`${email.subject ?? ""}\n${email.text ?? ""}`)) return { kind: "DELAYED", failedAddresses: [], newText };
    const failed = new Set(report.unknown);
    for (const a of (h["x-failed-recipients"] ?? "").split(",")) if (a.includes("@")) failed.add(a.trim().toLowerCase());
    // No report at all: every address the notice mentions. The sync only acts on ones it sent to.
    if (failed.size === 0) for (const m of (email.text ?? "").matchAll(ANY_ADDRESS)) failed.add(m[0].toLowerCase().replace(/\.$/, ""));
    return { kind: "BOUNCED", failedAddresses: [...failed], newText };
  }

  const auto = (h["auto-submitted"] ?? "no").toLowerCase() !== "no" || !!h["x-autoreply"] || !!h["x-autorespond"] || /^(auto_reply|bulk|junk)$/i.test(h.precedence ?? "");
  if (auto || AUTO_SUBJECT.test(email.subject ?? "")) return { kind: "AUTO_REPLY", failedAddresses: [], newText };

  const firstLine = newText.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (OPT_OUT.test(newText.slice(0, 600)) || BARE_STOP.test(firstLine) || OPT_OUT.test(email.subject ?? "")) return { kind: "OPTED_OUT", failedAddresses: [], newText };
  return { kind: "REPLIED", failedAddresses: [], newText };
}
