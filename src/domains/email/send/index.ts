import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import type { Account, Offer } from "../../config";
import { bold, countReasons, dim, green, indent, red, yellow, type Io } from "../../cli/io";
import type { Sequence } from "../../messages";
import { buildVariables, renderForProspect, startOfDay } from "../../outreach";
import type { Prospect } from "../../prospects";
import { renderTemplate } from "../../render";
import { planSequence, type Touch, type TouchStore } from "../../touches";
import { addressOf, buildEmail, classifySmtpFailure, describeWindow, domainOf, isInWindow } from "../helpers";
import type { EmailDraft } from "../types";
import type { Verifier } from "../verify";

/** The part of a nodemailer transport the runner uses. */
export interface MailTransport {
  verify(): Promise<unknown>;
  sendMail(draft: EmailDraft): Promise<unknown>;
  close?(): void;
}

export interface EmailRunOptions {
  dryRun: boolean;
  limit?: number;
  ignoreWindow: boolean;
  yes: boolean;
  /** Dry run: print every email instead of the first three. */
  showAll?: boolean;
}

export interface EmailRunInput {
  sequence: Sequence;
  account: Account;
  offer?: Offer;
  prospects: Prospect[];
  store: TouchStore;
  options: EmailRunOptions;
  io: Io;
  transport?: MailTransport;
  verifier?: Verifier;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface EmailRunResult {
  sent: number;
  failed: number;
  skipped: number;
  aborted?: string;
}

/** A transport from the account's SMTP URL env var. */
export function smtpTransport(account: Account): MailTransport {
  const name = account.email?.smtpUrlEnv;
  const url = name ? process.env[name]?.trim() : undefined;
  if (!url) throw new Error(`${name ?? "The SMTP URL env var"} is not set. Add it to .env.local, e.g. ${name}=smtps://you%40yourdomain.com:app-password@smtp.gmail.com:465`);
  return nodemailer.createTransport(url) as unknown as MailTransport;
}

interface Ready {
  prospect: Prospect;
  step: Sequence["steps"][number];
  address: string;
  draft: EmailDraft;
  previous?: Touch;
}

/**
 * Send the emails of one sequence that are due now, from one account.
 * Every guard runs before anything is sent: the voice must match, the footer
 * must carry a postal address and an opt-out, prospects who replied, opted
 * out, bounced or are marked Do Not Contact are skipped, a message with an
 * empty variable is held back, the daily cap and the sending window hold,
 * and you confirm the batch. Each email is logged as it goes out.
 */
export async function runEmail(input: EmailRunInput): Promise<EmailRunResult> {
  const { sequence, account, offer, store, options, io } = input;
  const now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = input.random ?? Math.random;
  const email = account.email;

  if (sequence.channel !== "email") throw new Error(`${sequence.id} is not an email sequence`);
  if (sequence.voice !== account.voice) throw new Error(`${sequence.id} is written in the ${sequence.voice} voice, but account "${account.key}" is ${account.voice}. Use a ${account.voice} sequence or another account.`);
  if (!email) throw new Error(`Account "${account.key}" has no email settings in cold.yaml`);
  if (!account.variables.postal_address) throw new Error(`Account "${account.key}" needs postal_address: every cold email must carry a valid postal address (CAN-SPAM).`);

  const baseVariables = buildVariables(account, offer);
  const footer = renderTemplate(email.footer, baseVariables, { mode: "strict", seed: account.key });
  if (footer.missing.length) throw new Error(`The email footer for "${account.key}" uses ${footer.missing.map((m) => `{{${m}}}`).join(", ")}, which has no value`);
  if (!footer.text.includes(account.variables.postal_address)) throw new Error(`The email footer for "${account.key}" must include {{postal_address}}`);
  if (!/unsubscribe|opt[ -]?out|reply\s+["']?stop/i.test(footer.text)) throw new Error(`The email footer for "${account.key}" must tell people how to opt out (e.g. 'Reply "stop"').`);

  const identities = input.prospects.flatMap((p) => p.identities);
  const [history, suppressions] = await Promise.all([store.forProspects(identities), store.suppressions()]);
  const plan = planSequence({ sequence, channel: "EMAIL", prospects: input.prospects, history, suppressions, now: now(), reachable: (p) => p.email, timeZone: email.window?.timezone });

  const ready: Ready[] = [];
  const held: string[] = [];
  for (const item of plan.due) {
    const variables = buildVariables(account, offer, item.prospect);
    const rendered = renderForProspect(item.step, variables, item.prospect.key);
    if (rendered.missing.length) {
      held.push(`missing ${rendered.missing.map((m) => `{{${m}}}`).join(", ")}`);
      continue;
    }
    const unsubscribeUrl = email.unsubscribeUrl ? renderTemplate(email.unsubscribeUrl, { ...variables, email: encodeURIComponent(item.address) }, { mode: "strict", seed: "" }).text : undefined;
    const draft = buildEmail({
      from: email.from,
      to: item.address,
      subject: rendered.subject,
      body: rendered.body,
      footer: footer.text,
      first: item.first,
      previous: item.previous,
      messageId: `<${randomUUID()}@${domainOf(email.from)}>`,
      unsubscribeUrl,
      timeZone: email.window?.timezone,
    });
    ready.push({ prospect: item.prospect, step: item.step, address: item.address, draft, previous: item.previous });
  }

  const sentToday = (await store.since(startOfDay(now(), email.window?.timezone), { account: account.key, channel: "EMAIL", kind: "SENT" })).length;
  const capLeft = Math.max(0, email.dailyCap - sentToday);
  const batch = ready.slice(0, Math.min(capLeft, options.limit ?? Number.POSITIVE_INFINITY));

  io.log(`${bold(sequence.id)} from ${email.from} ${dim(`(account ${account.key}, ${store.kind === "twenty" ? "logging to Twenty" : `logging to ${store.where}`})`)}`);
  io.log(`  ${input.prospects.length} prospects: ${plan.due.length} due now, ${plan.waiting.length} waiting, ${plan.skipped.length} skipped`);
  if (plan.skipped.length) io.log(dim(`  skipped: ${countReasons(plan.skipped.map((s) => s.reason))}`));
  if (held.length) io.log(yellow(`  held back: ${countReasons(held)} (fill these in, then run again)`));
  if (plan.waiting.length) {
    const next = [...plan.waiting].sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0]!;
    io.log(dim(`  next one due on ${next.dueOn} (${next.prospect.label}, step ${next.step.step})`));
  }
  io.log(`  daily cap ${email.dailyCap}, ${sentToday} sent today: ${batch.length ? bold(`${batch.length} to send`) : "nothing to send"}`);
  if (ready.length > batch.length) io.log(dim(`  ${ready.length - batch.length} more wait for the cap or --limit`));

  const result: EmailRunResult = { sent: 0, failed: 0, skipped: plan.skipped.length + held.length };
  if (batch.length === 0) return result;

  if (options.dryRun) {
    const shown = options.showAll ? batch : batch.slice(0, 3);
    for (const r of shown) {
      io.log("");
      io.log(`${cyanArrow()} ${r.prospect.label} <${r.address}>  ${dim(`step ${r.step.step}: ${r.step.title}`)}`);
      io.log(indent(`Subject: ${r.draft.subject}\n\n${r.draft.text.trim()}`));
    }
    if (shown.length < batch.length) io.log(dim(`\n  ... and ${batch.length - shown.length} more (--show-all to print them)`));
    io.log(dim("\nDry run: nothing was sent."));
    return result;
  }

  if (email.window && !options.ignoreWindow && !isInWindow(now(), email.window)) {
    result.aborted = `outside the sending window (${describeWindow(email.window)})`;
    io.log(yellow(`Not sending: ${result.aborted}. Run it again then, or pass --ignore-window.`));
    return result;
  }

  if (!options.yes && !(await io.confirm(`Send ${batch.length} email${batch.length === 1 ? "" : "s"} from ${addressOf(email.from)} now?`))) {
    io.log("Cancelled. Nothing was sent.");
    return result;
  }

  const transport = input.transport ?? smtpTransport(account);
  try {
    await transport.verify();
  } catch (err) {
    result.aborted = `the mailbox refused the connection: ${(err as Error).message}`;
    io.log(red(`Not sending: ${result.aborted}`));
    return result;
  }

  let failuresInARow = 0;
  /** Log a touch; when the store cannot, stop the run so nothing is sent unrecorded. */
  const save = async (touch: Touch): Promise<boolean> => {
    try {
      await store.record(touch);
      return true;
    } catch (err) {
      result.aborted = `a touch could not be logged: ${(err as Error).message}`;
      io.log(red(`Stopping: ${result.aborted}`));
      return false;
    }
  };

  try {
    for (const [index, r] of batch.entries()) {
      if (index > 0 && email.window && !options.ignoreWindow && !isInWindow(now(), email.window)) {
        result.aborted = `the sending window closed (${describeWindow(email.window)}); ${batch.length - index} left for next time`;
        io.log(yellow(`Stopping: ${result.aborted}.`));
        break;
      }

      const base: Omit<Touch, "kind" | "occurredAt"> = {
        channel: "EMAIL",
        voice: account.voice === "personal" ? "PERSONAL" : "COMPANY",
        account: account.key,
        sequence: sequence.id,
        step: r.step.step,
        templateId: r.step.id,
        prospectKey: r.prospect.key,
        prospectLabel: r.prospect.label,
        toAddress: r.address,
        fromAddress: addressOf(email.from),
        links: r.prospect.links,
      };

      if (r.step.step === 1 && input.verifier) {
        const verdict = await input.verifier.check(r.address);
        if (verdict === "invalid") {
          if (!(await save({ ...base, kind: "UNDELIVERABLE", error: "Reacher: invalid", occurredAt: now().toISOString() }))) break;
          io.log(`${yellow("skip")} ${r.prospect.label} <${r.address}>: verified undeliverable`);
          result.skipped++;
          continue;
        }
      }

      let failure: (Error & { code?: string; responseCode?: number; command?: string }) | undefined;
      try {
        await transport.sendMail(r.draft);
      } catch (err) {
        failure = err as Error & { code?: string; responseCode?: number; command?: string };
      }

      if (!failure) {
        // Sent: from here on it must be logged before anything else goes out.
        result.sent++;
        if (!(await save({ ...base, kind: "SENT", subject: r.draft.subject, body: r.draft.text, messageId: r.draft.messageId, occurredAt: now().toISOString() }))) break;
        failuresInARow = 0;
        io.log(`${green("sent")} ${r.prospect.label} <${r.address}>  ${dim(`step ${r.step.step}`)}`);
      } else {
        const kind = classifySmtpFailure(failure);
        result.failed++;
        failuresInARow++;
        const detail = `${failure.code ?? ""} ${failure.message}`.trim().slice(0, 1000);
        if (!(await save({ ...base, kind: kind === "recipient" ? "BOUNCED" : "FAILED", error: detail, occurredAt: now().toISOString() }))) break;
        io.log(`${red(kind === "recipient" ? "rejected" : "failed")} ${r.prospect.label} <${r.address}>: ${failure.message}`);
        if (kind === "mailbox" || failuresInARow >= 3) {
          result.aborted = kind === "mailbox" ? `the mailbox stopped accepting mail (${failure.code ?? failure.command ?? "error"}: ${failure.message.slice(0, 120)})` : "three failures in a row";
          io.log(red(`Stopping: ${result.aborted}.`));
          break;
        }
      }

      if (index < batch.length - 1) {
        const min = email.minDelaySeconds * 1000;
        const max = email.maxDelaySeconds * 1000;
        await sleep(Math.round(min + random() * (max - min)));
      }
    }
  } finally {
    transport.close?.();
  }

  io.log(`\n${result.sent} sent, ${result.failed} failed${result.aborted ? `, stopped: ${result.aborted}` : ""}.`);
  return result;
}

const cyanArrow = () => bold("->");
