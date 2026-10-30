import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Account, Offer } from "../config";
import { bold, countReasons, dim, green, indent, red, yellow, type Io } from "../cli/io";
import type { Message, Platform, Sequence } from "../messages";
import { buildVariables, renderForProspect, startOfDay } from "../outreach";
import type { Prospect } from "../prospects";
import { planSequence, platformChannel, type DueItem, type Plan, type TouchChannel, type TouchStore } from "../touches";
import { dmTarget, PLATFORM_NAMES } from "./helpers";

export * from "./helpers";

export interface DmRunInput {
  sequence: Sequence;
  account: Account;
  offer?: Offer;
  prospects: Prospect[];
  store: TouchStore;
  io: Io;
  options: { limit?: number; open: boolean; exportFile?: string };
  now?: () => Date;
  /** Opens a URL and copies text. Swapped out in tests. */
  desktop?: { open(url: string): void; copy(text: string): boolean };
}

export interface DmRunResult {
  sent: number;
  replied: number;
  optedOut: number;
  skipped: number;
}

function run(command: string, args: string[], input?: string): boolean {
  try {
    const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"], detached: input === undefined });
    child.on("error", () => {});
    if (input !== undefined) child.stdin?.end(input);
    else child.unref();
    return true;
  } catch {
    return false;
  }
}

/** The real desktop: the system browser, and the clipboard tool that exists. */
export const systemDesktop = {
  open(url: string) {
    if (process.platform === "darwin") run("open", [url]);
    else if (process.platform === "win32") run("cmd", ["/c", "start", "", url]);
    else run("xdg-open", [url]);
  },
  /**
   * Open a page as an app in its own window, without tabs or an address bar
   * (the --app mode of Chrome, Edge and Brave). Falls back to a normal tab.
   * Returns what opened it.
   */
  openWindow(url: string): string {
    const flag = `--app=${url}`;
    if (process.platform === "darwin") {
      for (const app of ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"]) {
        if ([`/Applications/${app}.app`, path.join(homedir(), "Applications", `${app}.app`)].some((p) => existsSync(p)) && run("open", ["-na", app, "--args", flag])) return app;
      }
    } else if (process.platform === "win32") {
      if (run("cmd", ["/c", "start", "", "msedge", flag])) return "Microsoft Edge";
    } else {
      for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) if (Bun.which(bin) && run(bin, [flag])) return bin;
    }
    this.open(url);
    return "your browser";
  },
  copy(text: string): boolean {
    const tools: Array<[string, string[]]> =
      process.platform === "darwin" ? [["pbcopy", []]] : process.platform === "win32" ? [["clip", []]] : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
    for (const [command, args] of tools) if (Bun.which(command) && run(command, args, text)) return true;
    return false;
  },
};

/** A due DM, written: what to send and where. */
export interface DmItem extends DueItem {
  text: string;
  url: string;
}

/** A due DM held back: an empty variable, or too long for its limit. */
export interface HeldDm {
  prospect: Prospect;
  step: Message;
  reason: string;
}

export interface PreparedDmRun {
  sequence: Sequence;
  account: Account;
  platform: Platform;
  channel: TouchChannel;
  plan: Plan;
  held: HeldDm[];
  /** Every DM due now, written. */
  queue: DmItem[];
  /** What fits today: the queue within the platform's daily cap and the limit. */
  batch: DmItem[];
  cap: number;
  sentToday: number;
}

export type DmOutcome = "SENT" | "REPLIED" | "OPTED_OUT";

/** Work out the DMs due now, written out, without logging anything. */
export async function prepareDmRun(input: { sequence: Sequence; account: Account; offer?: Offer; prospects: Prospect[]; store: TouchStore; limit?: number; now?: () => Date }): Promise<PreparedDmRun> {
  const { sequence, account, offer, store } = input;
  const now = input.now ?? (() => new Date());
  const platform = sequence.platform;
  if (sequence.channel !== "dm" || !platform) throw new Error(`${sequence.id} is not a DM sequence`);
  if (sequence.voice !== account.voice) throw new Error(`${sequence.id} is written in the ${sequence.voice} voice, but account "${account.key}" is ${account.voice}.`);
  const channel = platformChannel(platform);

  const [history, suppressions] = await Promise.all([store.forProspects(input.prospects.flatMap((p) => p.identities)), store.suppressions()]);
  const timeZone = account.email?.window?.timezone;
  const plan = planSequence({ sequence, channel, prospects: input.prospects, history, suppressions, now: now(), reachable: (p) => dmTarget(platform, p), timeZone });

  const held: HeldDm[] = [];
  const queue: DmItem[] = [];
  for (const item of plan.due) {
    const rendered = renderForProspect(item.step, buildVariables(account, offer, item.prospect), item.prospect.key);
    if (rendered.missing.length) {
      held.push({ prospect: item.prospect, step: item.step, reason: `missing ${rendered.missing.map((m) => `{{${m}}}`).join(", ")}` });
      continue;
    }
    const limit = item.step.maxChars;
    if (limit && rendered.body.length > limit) {
      held.push({ prospect: item.prospect, step: item.step, reason: `over ${limit} characters` });
      continue;
    }
    queue.push({ ...item, text: rendered.body, url: dmTarget(platform, item.prospect)! });
  }

  const cap = account.dm.dailyCaps[platform] ?? 20;
  const sentToday = (await store.since(startOfDay(now(), timeZone), { account: account.key, channel, kind: "SENT" })).length;
  const batch = queue.slice(0, Math.min(Math.max(0, cap - sentToday), input.limit ?? Number.POSITIVE_INFINITY));
  return { sequence, account, platform, channel, plan, held, queue, batch, cap, sentToday };
}

/**
 * Log what happened to one DM: sent (this step), or a reply or opt-out
 * (against the step they answered). An opt-out also marks the source record
 * Do Not Contact. Throws when the store cannot save it.
 */
export async function recordDmOutcome(store: TouchStore, prepared: Pick<PreparedDmRun, "sequence" | "account" | "channel">, item: DmItem, outcome: DmOutcome, now: Date = new Date()): Promise<void> {
  const sent = outcome === "SENT";
  await store.record({
    kind: outcome,
    channel: prepared.channel,
    voice: prepared.account.voice === "personal" ? "PERSONAL" : "COMPANY",
    account: prepared.account.key,
    sequence: prepared.sequence.id,
    step: sent ? item.step.step : item.previous?.step,
    templateId: sent ? item.step.id : item.previous?.templateId,
    prospectKey: item.prospect.key,
    prospectLabel: item.prospect.label,
    toAddress: item.url,
    body: sent ? item.text : undefined,
    occurredAt: now.toISOString(),
    links: item.prospect.links,
  });
  if (outcome === "OPTED_OUT") await store.markDoNotContact(item.prospect.links);
}

/**
 * Work through the DMs that are due today, one at a time: the message is
 * written for you, copied to the clipboard and the profile opened, and you
 * send it yourself from your own account, then say what happened. Nothing is
 * sent by automation. LinkedIn, X and Instagram ban accounts that DM from
 * scripts, and a DM someone actually sent reads like it.
 */
export async function runDm(input: DmRunInput): Promise<DmRunResult> {
  const { store, io, options } = input;
  const now = input.now ?? (() => new Date());
  const desktop = input.desktop ?? systemDesktop;
  const prepared = await prepareDmRun({ ...input, limit: options.limit, now });
  const { sequence, account, platform, plan, held, batch, cap, sentToday } = prepared;

  io.log(`${bold(sequence.id)} ${dim(`(${PLATFORM_NAMES[platform]}, account ${account.key})`)}`);
  io.log(`  ${input.prospects.length} prospects: ${plan.due.length} due now, ${plan.waiting.length} waiting, ${plan.skipped.length} skipped`);
  if (plan.skipped.length) io.log(dim(`  skipped: ${countReasons(plan.skipped.map((s) => s.reason))}`));
  if (held.length) io.log(yellow(`  held back: ${countReasons(held.map((h) => h.reason))}`));
  io.log(`  daily cap ${cap} on ${PLATFORM_NAMES[platform]}, ${sentToday} sent today: ${batch.length ? bold(`${batch.length} to send`) : "nothing to send"}`);

  const result: DmRunResult = { sent: 0, replied: 0, optedOut: 0, skipped: plan.skipped.length + held.length };
  if (!batch.length) return result;

  if (options.exportFile) {
    writeFileSync(options.exportFile, dmChecklist(prepared, now()));
    io.log(`Wrote ${batch.length} messages to ${options.exportFile}. Nothing was logged as sent.`);
    return result;
  }

  if (!io.interactive) throw new Error("cold dm run is interactive: run it in a terminal, or pass --export <file> for a checklist.");

  for (const [index, item] of batch.entries()) {
    io.log("");
    io.log(`${bold(`${index + 1}/${batch.length}`)} ${item.prospect.label}  ${dim(`step ${item.step.step}: ${item.step.title}`)}`);
    if (item.step.when) io.log(dim(indent(item.step.when, "  ")));
    io.log(indent(item.text));
    const copied = desktop.copy(item.text);
    io.log(dim(`  ${copied ? "Copied. " : ""}${item.url}`));
    if (options.open) desktop.open(item.url);

    const answer = await io.choose(`  [s]ent  [k] skip  [r]eplied  [o]pted out  [q]uit`, ["s", "k", "r", "o", "q"]);
    if (answer === "q") break;
    if (answer === "k") {
      result.skipped++;
      continue;
    }
    const outcome: DmOutcome = answer === "s" ? "SENT" : answer === "r" ? "REPLIED" : "OPTED_OUT";
    try {
      await recordDmOutcome(store, prepared, item, outcome, now());
    } catch (err) {
      io.log(red(`  Could not log it: ${(err as Error).message}`));
      io.log(red("  Stopping here so nothing is sent twice."));
      break;
    }
    if (outcome === "SENT") {
      result.sent++;
      io.log(green("  logged as sent"));
    } else if (outcome === "REPLIED") {
      result.replied++;
      io.log(green("  logged the reply: this sequence stops for them"));
    } else {
      result.optedOut++;
      io.log(red("  logged the opt-out: they won't be contacted again"));
    }
  }

  io.log(`\n${result.sent} sent, ${result.replied} replied, ${result.optedOut} opted out.`);
  return result;
}

/** Today's DMs as a Markdown checklist, for sending by hand or by a VA. Logs nothing. */
export function dmChecklist(prepared: PreparedDmRun, now: Date = new Date()): string {
  const { sequence, platform, batch } = prepared;
  const lines = [`# ${sequence.id}: ${batch.length} DMs due ${now.toISOString().slice(0, 10)}`, "", `Send each one by hand from the ${PLATFORM_NAMES[platform]} account, then log it with \`cold log\` or a run of \`cold dm run\`.`, ""];
  for (const item of batch) {
    lines.push(`## ${item.prospect.label}: step ${item.step.step}, ${item.step.title}`, "", `Open: ${item.url}`, "", "```text", item.text, "```", "", `- [ ] sent`, "");
  }
  return lines.join("\n");
}
