import type { InboundEmail, InboundVerdict } from "../types";

const BOUNCE_FROM = /mailer-daemon|postmaster|mail delivery (sub)?system/i;
const BOUNCE_SUBJECT = /undeliver|delivery status notification \(failure\)|returned mail|delivery fail|failure notice|could not be delivered|address not found|mail delivery failed/i;
const AUTO_SUBJECT = /^(automatic reply|auto(-| )?reply|autoreply|out of (the )?office|away from|on vacation|on leave)/i;
const OPT_OUT = /\b(unsubscribe|remove me|opt(-| )?out|take me off|stop (emailing|contacting|messaging|sending)|do not (email|contact)|don'?t (email|contact)|no more emails?)\b/i;
const OPT_OUT_START = /^\s*(please\s+)?stop\b/i;
const QUOTE_START = /^(>|On .+wrote:\s*$|-{2,}\s*Original Message|From:\s|_{5,}|Sent from my )/i;
const RECIPIENT = /(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s>;]+@[^\s>;]+)>?/gi;
const ANY_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** The text someone wrote, above the quoted message. */
export function newTextOf(text: string | undefined): string {
  const lines: string[] = [];
  for (const line of (text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    if (QUOTE_START.test(line.trim())) break;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

/**
 * Decide what an inbound email means. Pure. In order: a bounce (delivery
 * report, mailer-daemon), an automatic reply (out of office: ignored, the
 * sequence carries on), an opt-out ("unsubscribe", "remove me", "stop"), or
 * a reply. Opt-out only looks at the new text, never the quoted email, whose
 * footer itself says "reply stop".
 */
export function classifyInbound(email: InboundEmail): InboundVerdict {
  const h = email.headers;
  const newText = newTextOf(email.text);
  const isReport = /multipart\/report/i.test(h["content-type"] ?? "") && /delivery-status/i.test(h["content-type"] ?? "");
  if (isReport || BOUNCE_FROM.test(email.from ?? "") || BOUNCE_SUBJECT.test(email.subject ?? "")) {
    const failed = new Set<string>();
    for (const m of `${email.report ?? ""}\n${email.text ?? ""}`.matchAll(RECIPIENT)) failed.add(m[1]!.toLowerCase());
    for (const a of (h["x-failed-recipients"] ?? "").split(",")) if (a.includes("@")) failed.add(a.trim().toLowerCase());
    // No report: every address the notice mentions. The sync only acts on ones it sent to.
    if (failed.size === 0) for (const m of (email.text ?? "").matchAll(ANY_ADDRESS)) failed.add(m[0].toLowerCase().replace(/\.$/, ""));
    return { kind: "BOUNCED", failedAddresses: [...failed], newText };
  }

  const auto = (h["auto-submitted"] ?? "no").toLowerCase() !== "no" || !!h["x-autoreply"] || !!h["x-autorespond"] || /^(auto_reply|bulk|junk)$/i.test(h.precedence ?? "");
  if (auto || AUTO_SUBJECT.test(email.subject ?? "")) return { kind: "AUTO_REPLY", failedAddresses: [], newText };

  const head = newText.slice(0, 600);
  if (OPT_OUT.test(head) || OPT_OUT_START.test(head) || OPT_OUT.test(email.subject ?? "")) return { kind: "OPTED_OUT", failedAddresses: [], newText };
  return { kind: "REPLIED", failedAddresses: [], newText };
}
