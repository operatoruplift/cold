import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { Account, Offer } from "../config";
import { bold, countReasons, dim, green, indent, red, yellow, type Io } from "../cli/io";
import type { Sequence } from "../messages";
import { buildVariables, renderForProspect, startOfDay } from "../outreach";
import type { Prospect } from "../prospects";
import { planSequence, platformChannel, type Touch, type TouchStore } from "../touches";
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
  copy(text: string): boolean {
    const tools: Array<[string, string[]]> =
      process.platform === "darwin" ? [["pbcopy", []]] : process.platform === "win32" ? [["clip", []]] : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
    for (const [command, args] of tools) if (Bun.which(command) && run(command, args, text)) return true;
    return false;
  },
};

/**
 * Work through the DMs that are due today, one at a time: the message is
 * written for you, copied to the clipboard and the profile opened, and you
 * send it yourself from your own account, then say what happened. Nothing is
 * sent by automation. LinkedIn, X and Instagram ban accounts that DM from
 * scripts, and a DM someone actually sent reads like it.
 */
export async function runDm(input: DmRunInput): Promise<DmRunResult> {
  const { sequence, account, offer, store, io, options } = input;
  const now = input.now ?? (() => new Date());
  const desktop = input.desktop ?? systemDesktop;
  const platform = sequence.platform;
  if (sequence.channel !== "dm" || !platform) throw new Error(`${sequence.id} is not a DM sequence`);
  if (sequence.voice !== account.voice) throw new Error(`${sequence.id} is written in the ${sequence.voice} voice, but account "${account.key}" is ${account.voice}.`);
  const channel = platformChannel(platform);

  const [history, suppressions] = await Promise.all([store.forProspects(input.prospects.flatMap((p) => p.identities)), store.suppressions()]);
  const plan = planSequence({ sequence, channel, prospects: input.prospects, history, suppressions, now: now(), reachable: (p) => dmTarget(platform, p) });

  const held: string[] = [];
  const queue = plan.due.flatMap((item) => {
    const rendered = renderForProspect(item.step, buildVariables(account, offer, item.prospect), item.prospect.key);
    if (rendered.missing.length) {
      held.push(`missing ${rendered.missing.map((m) => `{{${m}}}`).join(", ")}`);
      return [];
    }
    const limit = item.step.maxChars;
    if (limit && rendered.body.length > limit) {
      held.push(`over ${limit} characters`);
      return [];
    }
    return [{ ...item, text: rendered.body }];
  });

  const cap = account.dm.dailyCaps[platform] ?? 20;
  const sentToday = (await store.since(startOfDay(now()), { account: account.key, channel, kind: "SENT" })).length;
  const batch = queue.slice(0, Math.min(Math.max(0, cap - sentToday), options.limit ?? Number.POSITIVE_INFINITY));

  io.log(`${bold(sequence.id)} ${dim(`(${PLATFORM_NAMES[platform]}, account ${account.key})`)}`);
  io.log(`  ${input.prospects.length} prospects: ${plan.due.length} due now, ${plan.waiting.length} waiting, ${plan.skipped.length} skipped`);
  if (plan.skipped.length) io.log(dim(`  skipped: ${countReasons(plan.skipped.map((s) => s.reason))}`));
  if (held.length) io.log(yellow(`  held back: ${countReasons(held)}`));
  io.log(`  daily cap ${cap} on ${PLATFORM_NAMES[platform]}, ${sentToday} sent today: ${batch.length ? bold(`${batch.length} to send`) : "nothing to send"}`);

  const result: DmRunResult = { sent: 0, replied: 0, optedOut: 0, skipped: plan.skipped.length + held.length };
  if (!batch.length) return result;

  if (options.exportFile) {
    const lines = [`# ${sequence.id}: ${batch.length} DMs due ${now().toISOString().slice(0, 10)}`, "", `Send each one by hand from the ${PLATFORM_NAMES[platform]} account, then log it with \`cold log\` or a run of \`cold dm run\`.`, ""];
    for (const item of batch) {
      lines.push(`## ${item.prospect.label}: step ${item.step.step}, ${item.step.title}`, "", `Open: ${dmTarget(platform, item.prospect)}`, "", "```text", item.text, "```", "", `- [ ] sent`, "");
    }
    writeFileSync(options.exportFile, lines.join("\n"));
    io.log(`Wrote ${batch.length} messages to ${options.exportFile}. Nothing was logged as sent.`);
    return result;
  }

  if (!io.interactive) throw new Error("cold dm run is interactive: run it in a terminal, or pass --export <file> for a checklist.");

  for (const [index, item] of batch.entries()) {
    const url = dmTarget(platform, item.prospect)!;
    io.log("");
    io.log(`${bold(`${index + 1}/${batch.length}`)} ${item.prospect.label}  ${dim(`step ${item.step.step}: ${item.step.title}`)}`);
    if (item.step.when) io.log(dim(indent(item.step.when, "  ")));
    io.log(indent(item.text));
    const copied = desktop.copy(item.text);
    io.log(dim(`  ${copied ? "Copied. " : ""}${url}`));
    if (options.open) desktop.open(url);

    const answer = await io.choose(`  [s]ent  [k] skip  [r]eplied  [o]pted out  [q]uit`, ["s", "k", "r", "o", "q"]);
    if (answer === "q") break;
    if (answer === "k") {
      result.skipped++;
      continue;
    }
    const touch: Touch = {
      kind: answer === "s" ? "SENT" : answer === "r" ? "REPLIED" : "OPTED_OUT",
      channel,
      voice: account.voice === "personal" ? "PERSONAL" : "COMPANY",
      account: account.key,
      sequence: sequence.id,
      step: answer === "s" ? item.step.step : item.previous?.step,
      templateId: answer === "s" ? item.step.id : item.previous?.templateId,
      prospectKey: item.prospect.key,
      prospectLabel: item.prospect.label,
      toAddress: url,
      body: answer === "s" ? item.text : undefined,
      occurredAt: now().toISOString(),
      links: item.prospect.links,
    };
    await store.record(touch);
    if (answer === "s") {
      result.sent++;
      io.log(green("  logged as sent"));
    } else if (answer === "r") {
      result.replied++;
      io.log(green("  logged the reply: this sequence stops for them"));
    } else {
      await store.markDoNotContact(item.prospect.links);
      result.optedOut++;
      io.log(red("  logged the opt-out: they won't be contacted again"));
    }
  }

  io.log(`\n${result.sent} sent, ${result.replied} replied, ${result.optedOut} opted out.`);
  return result;
}
