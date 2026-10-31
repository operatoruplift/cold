import { randomUUID } from "node:crypto";
import type { Account, Offer } from "../../config";
import { bold, countReasons, dim, green, indent, red, yellow, type Io } from "../../cli/io";
import type { Message, Sequence } from "../../messages";
import { buildVariables, renderForProspect, startOfDay } from "../../outreach";
import type { Prospect, ProspectLinks } from "../../prospects";
import { renderTemplate } from "../../render";
import { planSequence, type Plan, type Touch, type TouchStore } from "../../touches";
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

/** A due email whose message has an empty variable: not sent until it is filled. */
export interface HeldEmail {
  prospect: Prospect;
  step: Message;
  missing: string[];
}

/** A due email, written and ready to go. */
export interface ReadyEmail {
  prospect: Prospect;
  step: Message;
  address: string;
  draft: EmailDraft;
  previous?: Touch;
  /** Written by you (an approved AI draft) rather than straight from the template. */
  custom?: boolean;
}

/** Your own words for one prospect's step, used instead of the template. */
export type EmailOverride = (prospect: Prospect, step: Message) => { subject?: string; body: string } | undefined;

/** Everything about one send before anything is sent. */
export interface PreparedEmailRun {
  sequence: Sequence;
  account: Account;
  plan: Plan;
  held: HeldEmail[];
  ready: ReadyEmail[];
  /** What goes out now: the ready emails within the daily cap and the limit. */
  batch: ReadyEmail[];
  dailyCap: number;
  sentToday: number;
  /** Whether the sending window is open now; undefined when the account has none. */
  windowOpen?: boolean;
  windowText?: string;
}

/** What happens during a send, as it happens: for the web UI's progress. */
export type EmailEvent =
  | { type: "sent"; label: string; address: string; step: number }
  | { type: "failed"; label: string; address: string; step: number; reason: string; bounced: boolean }
  | { type: "skipped"; label: string; address: string; reason: string }
  | { type: "pause"; seconds: number }
  | { type: "stopped"; reason: string };

export interface SendOptions {
  store: TouchStore;
  ignoreWindow: boolean;
  transport?: MailTransport;
  verifier?: Verifier;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  io?: Io;
  onEvent?: (event: EmailEvent) => void;
  /** Checked before each email after the first: true stops the batch. */
  shouldStop?: () => boolean;
}

/** A transport from the account's SMTP URL env var. nodemailer loads with the first email, so a server that isn't sending stays small. */
export function smtpTransport(account: Account): MailTransport {
  const name = account.email?.smtpUrlEnv;
  const url = name ? process.env[name]?.trim() : undefined;
  if (!url) throw new Error(`${name ?? "The SMTP URL env var"} is not set. Add it to .env.local, e.g. ${name}=smtps://you%40yourdomain.com:app-password@smtp.gmail.com:465`);
  let loaded: Promise<MailTransport> | undefined;
  const transport = () => (loaded ??= import("nodemailer").then(({ default: nodemailer }) => nodemailer.createTransport(url) as unknown as MailTransport));
  return {
    verify: async () => (await transport()).verify(),
    sendMail: async (draft) => (await transport()).sendMail(draft),
    close: () => void loaded?.then((t) => t.close?.(), () => {}),
  };
}

/**
 * Work out a send without sending anything: who is due, every email written
 * out, who is held back, and how much of the daily cap is left. The guards
 * that make a send impossible (wrong voice, no postal address, a footer with
 * no opt-out) throw here, before anyone sees a "Send" button.
 */
export async function prepareEmailRun(input: {
  sequence: Sequence;
  account: Account;
  offer?: Offer;
  prospects: Prospect[];
  store: TouchStore;
  limit?: number;
  now?: () => Date;
  override?: EmailOverride;
}): Promise<PreparedEmailRun> {
  const { sequence, account, offer, store } = input;
  const now = input.now ?? (() => new Date());
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

  const ready: ReadyEmail[] = [];
  const held: HeldEmail[] = [];
  for (const item of plan.due) {
    const variables = buildVariables(account, offer, item.prospect);
    const rendered = renderForProspect(item.step, variables, item.prospect.key);
    const custom = input.override?.(item.prospect, item.step);
    // An approved draft replaces the template's words; the footer, opt-out and threading stay COLD's.
    const subjectMissing = rendered.missing.some((name) => (item.step.subject ?? "").includes(`{{${name}`));
    if (custom ? !custom.subject && subjectMissing : rendered.missing.length > 0) {
      held.push({ prospect: item.prospect, step: item.step, missing: rendered.missing });
      continue;
    }
    const unsubscribeUrl = email.unsubscribeUrl ? renderTemplate(email.unsubscribeUrl, { ...variables, email: encodeURIComponent(item.address) }, { mode: "strict", seed: "" }).text : undefined;
    const draft = buildEmail({
      from: email.from,
      to: item.address,
      subject: custom?.subject || rendered.subject,
      body: custom?.body ?? rendered.body,
      footer: footer.text,
      first: item.first,
      previous: item.previous,
      messageId: `<${randomUUID()}@${domainOf(email.from)}>`,
      unsubscribeUrl,
      timeZone: email.window?.timezone,
    });
    ready.push({ prospect: item.prospect, step: item.step, address: item.address, draft, previous: item.previous, custom: !!custom });
  }

  const sentToday = (await store.since(startOfDay(now(), email.window?.timezone), { account: account.key, channel: "EMAIL", kind: "SENT" })).length;
  const capLeft = Math.max(0, email.dailyCap - sentToday);
  return {
    sequence,
    account,
    plan,
    held,
    ready,
    batch: ready.slice(0, Math.min(capLeft, input.limit ?? Number.POSITIVE_INFINITY)),
    dailyCap: email.dailyCap,
    sentToday,
    windowOpen: email.window ? isInWindow(now(), email.window) : undefined,
    windowText: email.window ? describeWindow(email.window) : undefined,
  };
}

/** One email of a send, written down: enough to send and log it, after a restart too. */
export interface SendItem {
  step?: number;
  templateId: string;
  prospectKey: string;
  prospectLabel: string;
  links?: ProspectLinks;
  address: string;
  draft: EmailDraft;
}

/** A prepared send, without anything that cannot be written down. */
export interface SendPlan {
  sequenceId: string;
  account: Account;
  items: SendItem[];
}

/** How far a send has come. Saved after every email, so a send can stop and carry on. */
export interface SendState {
  /** The next email to send. */
  index: number;
  sent: number;
  failed: number;
  skipped: number;
  failuresInARow: number;
  /** The mailbox accepted the login. */
  verified: boolean;
  /** The email that was going out when the send last stopped mid-way: it may have been sent. */
  inflight?: number;
  aborted?: string;
  done: boolean;
}

export interface StepOptions {
  store: TouchStore;
  transport: MailTransport;
  verifier?: Verifier;
  ignoreWindow: boolean;
  now: () => Date;
  random: () => number;
  log: (line?: string) => void;
  emit: (event: EmailEvent) => void;
  shouldStop: () => boolean | Promise<boolean>;
  /** Called just before an email goes to the mailbox, with that email marked in flight, so a crash then cannot send it twice. */
  beforeSend?: (state: SendState) => Promise<void>;
}

export const newSendState = (): SendState => ({ index: 0, sent: 0, failed: 0, skipped: 0, failuresInARow: 0, verified: false, done: false });

export const sendResult = (state: SendState): EmailRunResult => ({ sent: state.sent, failed: state.failed, skipped: state.skipped, ...(state.aborted ? { aborted: state.aborted } : {}) });

export function toSendPlan(prepared: PreparedEmailRun): SendPlan {
  return {
    sequenceId: prepared.sequence.id,
    account: prepared.account,
    items: prepared.batch.map((r) => ({ step: r.step.step, templateId: r.step.id, prospectKey: r.prospect.key, prospectLabel: r.prospect.label, links: r.prospect.links, address: r.address, draft: r.draft })),
  };
}

/**
 * The next thing a send has to do: check the mailbox (first time), then send
 * or skip one email and log it. Returns the new state and how long to wait
 * before the next step. The sending window is checked before each email; a
 * refused mailbox, three failures in a row, a touch that cannot be logged,
 * or `shouldStop` ends the send early.
 */
export async function sendStep(plan: SendPlan, state: SendState, options: StepOptions): Promise<{ state: SendState; waitMs: number }> {
  const s: SendState = { ...state };
  const { account, items, sequenceId } = plan;
  const email = account.email!;
  const { log, emit, now } = options;
  const stop = (reason: string, tone: (text: string) => string = red) => {
    s.aborted = reason;
    s.done = true;
    log(tone(`Stopping: ${reason}.`));
    emit({ type: "stopped", reason });
  };
  const moveOn = () => {
    s.inflight = undefined;
    s.index++;
    if (s.index >= items.length) s.done = true;
  };

  if (s.done) return { state: s, waitMs: 0 };
  if (!s.verified) {
    try {
      await options.transport.verify();
    } catch (err) {
      s.aborted = `the mailbox refused the connection: ${(err as Error).message}`;
      s.done = true;
      log(red(`Not sending: ${s.aborted}`));
      emit({ type: "stopped", reason: s.aborted });
      return { state: s, waitMs: 0 };
    }
    s.verified = true;
  }
  if (s.index >= items.length) {
    s.done = true;
    return { state: s, waitMs: 0 };
  }

  const index = s.index;
  const r = items[index]!;
  if (s.inflight === index) {
    // The send stopped while this one was going out, so it may have been sent. Never send it twice.
    s.skipped++;
    log(`${yellow("skip")} ${r.prospectLabel} <${r.address}>: interrupted while sending`);
    emit({ type: "skipped", label: r.prospectLabel, address: r.address, reason: "interrupted while it was going out: check your Sent folder before writing to them again" });
    moveOn();
    return { state: s, waitMs: 0 };
  }
  if (index > 0 && (await options.shouldStop())) {
    stop(`stopped by you; ${items.length - index} left for next time`, yellow);
    return { state: s, waitMs: 0 };
  }
  if (index > 0 && email.window && !options.ignoreWindow && !isInWindow(now(), email.window)) {
    stop(`the sending window closed (${describeWindow(email.window)}); ${items.length - index} left for next time`, yellow);
    return { state: s, waitMs: 0 };
  }

  const base: Omit<Touch, "kind" | "occurredAt"> = {
    channel: "EMAIL",
    voice: account.voice === "personal" ? "PERSONAL" : "COMPANY",
    account: account.key,
    sequence: sequenceId,
    step: r.step,
    templateId: r.templateId,
    prospectKey: r.prospectKey,
    prospectLabel: r.prospectLabel,
    toAddress: r.address,
    fromAddress: addressOf(email.from),
    links: r.links,
  };
  /** Log a touch; when the store cannot, stop the send so nothing goes out unrecorded. */
  const save = async (touch: Touch): Promise<boolean> => {
    try {
      await options.store.record(touch);
      return true;
    } catch (err) {
      stop(`a touch could not be logged: ${(err as Error).message}`);
      return false;
    }
  };

  if (r.step === 1 && options.verifier) {
    const verdict = await options.verifier.check(r.address);
    if (verdict === "invalid") {
      if (!(await save({ ...base, kind: "UNDELIVERABLE", error: "Reacher: invalid", occurredAt: now().toISOString() }))) return { state: s, waitMs: 0 };
      log(`${yellow("skip")} ${r.prospectLabel} <${r.address}>: verified undeliverable`);
      emit({ type: "skipped", label: r.prospectLabel, address: r.address, reason: "verified undeliverable" });
      s.skipped++;
      moveOn();
      return { state: s, waitMs: 0 };
    }
  }

  await options.beforeSend?.({ ...s, inflight: index });
  s.inflight = index;
  let failure: (Error & { code?: string; responseCode?: number; command?: string }) | undefined;
  try {
    await options.transport.sendMail(r.draft);
  } catch (err) {
    failure = err as Error & { code?: string; responseCode?: number; command?: string };
  }

  if (!failure) {
    // Sent: from here on it must be logged before anything else goes out.
    s.sent++;
    const logged = await save({ ...base, kind: "SENT", subject: r.draft.subject, body: r.draft.text, messageId: r.draft.messageId, occurredAt: now().toISOString() });
    moveOn();
    if (!logged) return { state: { ...s, done: true }, waitMs: 0 };
    s.failuresInARow = 0;
    log(`${green("sent")} ${r.prospectLabel} <${r.address}>  ${dim(`step ${r.step}`)}`);
    emit({ type: "sent", label: r.prospectLabel, address: r.address, step: r.step ?? 0 });
  } else {
    const kind = classifySmtpFailure(failure);
    s.failed++;
    s.failuresInARow++;
    const detail = `${failure.code ?? ""} ${failure.message}`.trim().slice(0, 1000);
    const logged = await save({ ...base, kind: kind === "recipient" ? "BOUNCED" : "FAILED", error: detail, occurredAt: now().toISOString() });
    moveOn();
    if (!logged) return { state: { ...s, done: true }, waitMs: 0 };
    log(`${red(kind === "recipient" ? "rejected" : "failed")} ${r.prospectLabel} <${r.address}>: ${failure.message}`);
    emit({ type: "failed", label: r.prospectLabel, address: r.address, step: r.step ?? 0, reason: failure.message, bounced: kind === "recipient" });
    if (kind === "mailbox" || s.failuresInARow >= 3) {
      stop(kind === "mailbox" ? `the mailbox stopped accepting mail (${failure.code ?? failure.command ?? "error"}: ${failure.message.slice(0, 120)})` : "three failures in a row");
      return { state: s, waitMs: 0 };
    }
  }

  if (s.done) return { state: s, waitMs: 0 };
  const min = email.minDelaySeconds * 1000;
  const max = email.maxDelaySeconds * 1000;
  const pause = Math.round(min + options.random() * (max - min));
  emit({ type: "pause", seconds: Math.round(pause / 1000) });
  return { state: s, waitMs: pause };
}

/**
 * Send a prepared batch from start to finish, waiting between emails: the
 * terminal's send. Every email is logged before the next goes out. Each step
 * is reported to `io` (the terminal) and `onEvent`.
 */
export async function sendEmails(prepared: PreparedEmailRun, options: SendOptions): Promise<EmailRunResult> {
  const plan = toSendPlan(prepared);
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = (line = "") => options.io?.log(line);
  const transport = options.transport ?? smtpTransport(plan.account);
  const step: StepOptions = {
    store: options.store,
    transport,
    verifier: options.verifier,
    ignoreWindow: options.ignoreWindow,
    now: options.now ?? (() => new Date()),
    random: options.random ?? Math.random,
    log,
    emit: (event) => options.onEvent?.(event),
    shouldStop: () => options.shouldStop?.() ?? false,
  };
  let state = newSendState();
  try {
    while (!state.done) {
      const next = await sendStep(plan, state, step);
      state = next.state;
      if (!state.done && next.waitMs > 0) await sleep(next.waitMs);
    }
  } finally {
    transport.close?.();
  }
  if (state.verified) log(`\n${state.sent} sent, ${state.failed} failed${state.aborted ? `, stopped: ${state.aborted}` : ""}.`);
  return sendResult(state);
}

/**
 * Send the emails of one sequence that are due now, from one account: the
 * terminal flow. Prepare, print the plan, then (unless it is a dry run, the
 * window is shut, or you say no) send.
 */
export async function runEmail(input: EmailRunInput): Promise<EmailRunResult> {
  const { store, options, io } = input;
  const now = input.now ?? (() => new Date());
  const prepared = await prepareEmailRun({ ...input, limit: options.limit, now });
  const { plan, held, ready, batch, sequence, account } = prepared;
  const email = account.email!;

  io.log(`${bold(sequence.id)} from ${email.from} ${dim(`(account ${account.key}, ${store.kind === "twenty" ? "logging to Twenty" : `logging to ${store.where}`})`)}`);
  io.log(`  ${input.prospects.length} prospects: ${plan.due.length} due now, ${plan.waiting.length} waiting, ${plan.skipped.length} skipped`);
  if (plan.skipped.length) io.log(dim(`  skipped: ${countReasons(plan.skipped.map((s) => s.reason))}`));
  if (held.length) io.log(yellow(`  held back: ${countReasons(held.map((h) => `missing ${h.missing.map((m) => `{{${m}}}`).join(", ")}`))} (fill these in, then run again)`));
  if (plan.waiting.length) {
    const next = [...plan.waiting].sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0]!;
    io.log(dim(`  next one due on ${next.dueOn} (${next.prospect.label}, step ${next.step.step})`));
  }
  io.log(`  daily cap ${prepared.dailyCap}, ${prepared.sentToday} sent today: ${batch.length ? bold(`${batch.length} to send`) : "nothing to send"}`);
  if (ready.length > batch.length) io.log(dim(`  ${ready.length - batch.length} more wait for the cap or --limit`));

  const skippedBefore = plan.skipped.length + held.length;
  const result: EmailRunResult = { sent: 0, failed: 0, skipped: skippedBefore };
  if (batch.length === 0) return result;

  if (options.dryRun) {
    const shown = options.showAll ? batch : batch.slice(0, 3);
    for (const r of shown) {
      io.log("");
      io.log(`${bold("->")} ${r.prospect.label} <${r.address}>  ${dim(`step ${r.step.step}: ${r.step.title}`)}`);
      io.log(indent(`Subject: ${r.draft.subject}\n\n${r.draft.text.trim()}`));
    }
    if (shown.length < batch.length) io.log(dim(`\n  ... and ${batch.length - shown.length} more (--show-all to print them)`));
    io.log(dim("\nDry run: nothing was sent."));
    return result;
  }

  if (prepared.windowOpen === false && !options.ignoreWindow) {
    result.aborted = `outside the sending window (${prepared.windowText})`;
    io.log(yellow(`Not sending: ${result.aborted}. Run it again then, or pass --ignore-window.`));
    return result;
  }

  if (!options.yes && !(await io.confirm(`Send ${batch.length} email${batch.length === 1 ? "" : "s"} from ${addressOf(email.from)} now?`))) {
    io.log("Cancelled. Nothing was sent.");
    return result;
  }

  const sent = await sendEmails(prepared, { store, ignoreWindow: options.ignoreWindow, transport: input.transport, verifier: input.verifier, now, sleep: input.sleep, random: input.random, io });
  return { ...sent, skipped: skippedBefore + sent.skipped };
}
