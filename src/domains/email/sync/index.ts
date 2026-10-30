import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Account } from "../../config";
import { dim, green, red, yellow, type Io } from "../../cli/io";
import type { Touch, TouchStore } from "../../touches";
import { addressOf, classifyInbound, headerText } from "../helpers";
import type { InboundEmail } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One message pulled from the mailbox. */
export interface MailboxMessage {
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  from?: string;
  date: Date;
  email: InboundEmail;
}

/** Reads recent mail. The IMAP one is below; tests pass a list. */
export interface MailboxReader {
  /** Messages since a date, only fully downloaded when `wanted` says so. */
  read(since: Date, wanted: (envelope: { from?: string; inReplyTo?: string; subject?: string }) => boolean): Promise<MailboxMessage[]>;
}

export interface SyncResult {
  replied: number;
  optedOut: number;
  bounced: number;
  /** Out-of-office replies and delivery delays: logged nowhere, the sequence carries on. */
  autoReplies: number;
}

/** A raw RFC 822 message as the sync reads it. */
export async function parseMailboxMessage(source: Buffer | string): Promise<MailboxMessage> {
  const parsed = await simpleParser(source);
  const headers: Record<string, string> = {};
  for (const [key, value] of parsed.headers) headers[key.toLowerCase()] = headerText(value);
  const refs = parsed.references;
  return {
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: Array.isArray(refs) ? refs : refs ? [refs] : [],
    from: parsed.from?.value?.[0]?.address?.toLowerCase(),
    date: parsed.date ?? new Date(),
    email: { from: parsed.from?.text, subject: parsed.subject, text: parsed.text, report: deliveryReport(parsed.attachments), headers },
  };
}

/** The text of a delivery-status report attached to a bounce (mailparser keeps it as an attachment). */
function deliveryReport(attachments: Array<{ contentType?: string; content?: Buffer }> | undefined): string | undefined {
  const parts = (attachments ?? []).filter((a) => /^(message\/delivery-status|message\/global-delivery-status|text\/rfc822-headers)$/i.test(a.contentType ?? ""));
  return parts.length ? parts.map((a) => a.content?.toString("utf8") ?? "").join("\n") : undefined;
}

/** imaps://user:pass@host:993 (or imap:// with STARTTLS on 143) from the account's env var. */
export function imapReader(account: Account): MailboxReader {
  const name = account.email?.imapUrlEnv;
  const raw = name ? process.env[name]?.trim() : undefined;
  if (!raw) throw new Error(`${name ?? "imap_url_env"} is not set. Add it to cold.yaml and .env.local, e.g. IMAP_URL_PERSONAL=imaps://you%40yourdomain.com:app-password@imap.gmail.com:993`);
  const url = new URL(raw);
  const secure = url.protocol === "imaps:";
  const options = {
    host: url.hostname,
    port: Number(url.port) || (secure ? 993 : 143),
    secure,
    auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) },
    logger: false as const,
  };

  return {
    async read(since, wanted) {
      const client = new ImapFlow(options);
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      const out: MailboxMessage[] = [];
      try {
        const uids = (await client.search({ since }, { uid: true })) || [];
        const picked: number[] = [];
        if (uids.length) {
          for await (const msg of client.fetch(uids, { envelope: true, uid: true }, { uid: true })) {
            if (wanted({ from: msg.envelope?.from?.[0]?.address, inReplyTo: msg.envelope?.inReplyTo, subject: msg.envelope?.subject })) picked.push(msg.uid);
          }
        }
        // Commands may not run inside a fetch loop, so the full messages come after it.
        for (const uid of picked) {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (msg && msg.source) out.push(await parseMailboxMessage(msg.source));
        }
      } finally {
        lock.release();
        await client.logout().catch(() => {});
      }
      return out;
    },
  };
}

/**
 * Read the account's inbox and log what came back from cold emails: replies
 * (the sequence stops), opt-outs (the prospect is suppressed everywhere and,
 * when they came from the dialer, set to Do Not Contact there too) and
 * bounces (the address is suppressed). Out-of-office replies are ignored.
 * Safe to run repeatedly: a message already logged is skipped.
 */
export async function syncReplies(input: { account: Account; store: TouchStore; days: number; io: Io; reader?: MailboxReader; now?: () => Date }): Promise<SyncResult> {
  const { account, store, io } = input;
  const now = input.now ?? (() => new Date());
  const since = new Date(now().getTime() - input.days * DAY_MS);
  const lookback = new Date(since.getTime() - 60 * DAY_MS).toISOString();

  const emailTouches = await store.since(lookback, { account: account.key, channel: "EMAIL" });
  const sent = emailTouches.filter((t) => t.kind === "SENT");
  const seen = new Set(emailTouches.filter((t) => t.kind !== "SENT" && t.messageId).map((t) => t.messageId!));
  const byMessageId = new Map(sent.filter((t) => t.messageId).map((t) => [t.messageId!, t]));
  const byAddress = new Map<string, Touch>();
  for (const t of [...sent].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) if (t.toAddress) byAddress.set(t.toAddress.toLowerCase(), t);

  const result: SyncResult = { replied: 0, optedOut: 0, bounced: 0, autoReplies: 0 };
  if (sent.length === 0) {
    io.log(dim(`No cold emails sent from "${account.key}" in the last ${input.days + 60} days: nothing to match replies to.`));
    return result;
  }

  const reader = input.reader ?? imapReader(account);
  const messages = await reader.read(since, ({ from, inReplyTo, subject }) => {
    const address = from?.toLowerCase() ?? "";
    // Also every "unsubscribe" email (the List-Unsubscribe mailto), even from an address never emailed.
    return byAddress.has(address) || (!!inReplyTo && byMessageId.has(inReplyTo)) || /mailer-daemon|postmaster/i.test(address) || /^\s*unsubscribe\b/i.test(subject ?? "");
  });

  for (const message of messages) {
    if (message.messageId && seen.has(message.messageId)) continue;
    const verdict = classifyInbound(message.email);
    if (verdict.kind === "AUTO_REPLY" || verdict.kind === "DELAYED") {
      result.autoReplies++;
      continue;
    }

    const matches: Touch[] = [];
    if (verdict.kind === "BOUNCED") {
      for (const address of verdict.failedAddresses) {
        const t = byAddress.get(address);
        if (t) matches.push(t);
      }
    } else {
      const byThread = [message.inReplyTo, ...message.references].map((id) => (id ? byMessageId.get(id) : undefined)).find(Boolean);
      const t = byThread ?? (message.from ? byAddress.get(message.from) : undefined);
      if (t) matches.push(t);
    }

    if (verdict.kind === "OPTED_OUT" && matches.length === 0 && message.from) {
      // An unsubscribe from an address that was never emailed (a forward, an alias): suppress that address too, and say so.
      await store.record({
        kind: "OPTED_OUT",
        channel: "EMAIL",
        account: account.key,
        prospectKey: `email:${message.from}`,
        toAddress: message.from,
        fromAddress: message.from,
        subject: message.email.subject,
        body: (verdict.newText || "").slice(0, 4000),
        messageId: message.messageId,
        occurredAt: message.date.toISOString(),
      });
      if (message.messageId) seen.add(message.messageId);
      result.optedOut++;
      io.log(`${red("opted out")} ${message.from} ${yellow("(not an address you emailed: check who it forwards for, and log them by hand with cold log)")}`);
      continue;
    }

    for (const original of matches) {
      await store.record({
        kind: verdict.kind,
        channel: "EMAIL",
        voice: original.voice,
        account: account.key,
        sequence: original.sequence,
        step: original.step,
        templateId: original.templateId,
        prospectKey: original.prospectKey,
        prospectLabel: original.prospectLabel,
        toAddress: original.toAddress,
        fromAddress: verdict.kind === "BOUNCED" ? addressOf(message.email.from ?? "mailer-daemon") : message.from,
        subject: message.email.subject,
        body: (verdict.newText || message.email.text || "").slice(0, 4000),
        messageId: message.messageId,
        occurredAt: message.date.toISOString(),
        links: original.links,
      });
      if (message.messageId) seen.add(message.messageId);
      if (verdict.kind === "OPTED_OUT") {
        await store.markDoNotContact(original.links);
        result.optedOut++;
        io.log(`${red("opted out")} ${original.prospectLabel ?? original.toAddress}`);
      } else if (verdict.kind === "BOUNCED") {
        result.bounced++;
        io.log(`${yellow("bounced")} ${original.toAddress}`);
      } else {
        result.replied++;
        io.log(`${green("replied")} ${original.prospectLabel ?? original.toAddress}  ${dim(`(${original.sequence} step ${original.step})`)}`);
      }
    }
  }

  io.log(`${result.replied} replied, ${result.optedOut} opted out, ${result.bounced} bounced${result.autoReplies ? `, ${result.autoReplies} out-of-office ignored` : ""}.`);
  return result;
}
