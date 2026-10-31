#!/usr/bin/env bun
/**
 * cold: cold call scripts, cold DMs and cold emails for personal and company
 * accounts, with every touch kept in Twenty. `bun run cold help` for usage.
 */
import { parseArgs } from "node:util";
import { callSheet, syncCallScripts } from "./domains/call";
import { bold, cyan, dim, green, indent, red, table, terminalIo, yellow } from "./domains/cli/io";
import { getAccount, getOffer, loadConfig, loadEnvFiles, type Account, type ColdConfig } from "./domains/config";
import { runDm } from "./domains/dm";
import { reacherFromEnv, runEmail, syncReplies } from "./domains/email";
import { CHANNELS, findMessage, findSequence, loadLibrary, VOICES, type Library, type Message, type Voice } from "./domains/messages";
import { buildVariables, renderForProspect } from "./domains/outreach";
import { findProspect, loadProspects, normalizeEmail, SOURCES_HELP, toIdentity, type Prospect } from "./domains/prospects";
import { exampleVariables, VARIABLES } from "./domains/render";
import { rate, summarize } from "./domains/stats";
import { openStore, TOUCH_CHANNELS, TOUCH_KINDS, twentyClient, type Touch } from "./domains/touches";
import { applySchema, type ApplyItem } from "./domains/twenty";
import path from "node:path";
import { emailProblem, OwnerAuth, passwordProblem } from "./domains/auth";
import { ROOT } from "./domains/config";
import { connectDatabase, databaseFromEnv, openDatabase } from "./domains/db";

const HELP = `${bold("cold")}: cold calls, cold DMs and cold emails for personal and company accounts

${bold("Library")}
  cold list [--channel email|dm|call] [--voice personal|company]
  cold lint                         check every message (CI runs this)
  cold variables                    the variables messages can use
  cold preview <id> [--account <a>] [--offer <o>] [--source <src> --prospect <who>]

${bold("Twenty")}
  cold twenty:schema [--dry-run]    create the coldTouch object and fields (safe to re-run)

${bold("Email")}
  cold email run <sequence> --source <src> [--account <a>] [--offer <o>] [--where <filter>]
                 [--limit <n>] [--dry-run] [--show-all] [--yes] [--ignore-window] [--no-sync]
  cold email sync [--account <a>] [--days 14]       log replies, opt-outs and bounces
  cold email verify --source <src> [--record]       check addresses with Reacher

${bold("DMs")}
  cold dm run <sequence> --source <src> [--account <a>] [--offer <o>] [--where <filter>]
              [--limit <n>] [--no-open] [--export <file>]

${bold("Calls")}
  cold call sync [--account <a>] [--offer <o>] [--campaign <name>] [--dry-run]
  cold call sheet <script> [--account <a>] [--offer <o>] [--source <src> --prospect <who>]

${bold("Login")} (for the app at /app/)
  cold owner [--email <you@x.com>]  create or reset your login, then sign in with it
  cold owner hash                   print a password hash for COLD_OWNER_PASSWORD_HASH

${bold("Results")}
  cold stats [--days 30] [--account <a>]
  cold log <prospect> --kind <kind> --channel <channel> [--source <src>] [--account <a>]
           [--sequence <id>] [--step <n>] [--note <text>]

Sources: ${SOURCES_HELP}
Ids can be shortened to any unique ending: founder-direct, call/company/gatekeeper.
`;

class UsageError extends Error {}

const { values: flags, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        channel: { type: "string" },
        email: { type: "string" },
        voice: { type: "string" },
        source: { type: "string" },
        prospect: { type: "string" },
        account: { type: "string" },
        offer: { type: "string" },
        where: { type: "string" },
        limit: { type: "string" },
        days: { type: "string" },
        campaign: { type: "string" },
        export: { type: "string" },
        kind: { type: "string" },
        sequence: { type: "string" },
        step: { type: "string" },
        note: { type: "string" },
        "dry-run": { type: "boolean" },
        "show-all": { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        "ignore-window": { type: "boolean" },
        "no-sync": { type: "boolean" },
        "no-open": { type: "boolean" },
        record: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    console.error(red((err as Error).message));
    console.error(dim("Run `bun run cold help` for usage."));
    process.exit(2);
  }
})();

const io = terminalIo();
const int = (name: string, value: string | undefined, fallback?: number): number | undefined => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a whole number`);
  return n;
};

function library(): Library {
  const { library, issues } = loadLibrary();
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) io.log(yellow(`${errors.length} message${errors.length === 1 ? " has" : "s have"} errors and ${errors.length === 1 ? "is" : "are"} left out: run \`bun run cold lint\`.`));
  return library;
}

/** The account to send from: --account, or the only account in that voice. */
function accountFor(config: ColdConfig, voice: Voice): Account {
  if (flags.account) return getAccount(config, flags.account);
  const matches = Object.values(config.accounts).filter((a) => a.voice === voice);
  if (matches.length === 1) return matches[0]!;
  throw new UsageError(`Pick the account with --account (${voice} accounts: ${matches.map((a) => a.key).join(", ") || "none"}).`);
}

function requireSequence(lib: Library, id: string | undefined, channel: "email" | "dm") {
  if (!id) throw new UsageError(`Name the sequence: ${lib.sequences.filter((s) => s.channel === channel).map((s) => s.id).join(", ")}`);
  const sequence = findSequence(lib, id);
  if (!sequence || sequence.channel !== channel) throw new UsageError(`No ${channel} sequence "${id}". Have: ${lib.sequences.filter((s) => s.channel === channel).map((s) => s.id).join(", ")}`);
  return sequence;
}

function requireRealConfig(config: ColdConfig): void {
  if (config.isExample) throw new UsageError("cold.yaml does not exist yet, so this would send as the example sender. Copy cold.example.yaml to cold.yaml, fill in your details, then run it again.");
}

async function prospectsFrom(source: string | undefined): Promise<Prospect[]> {
  if (!source) throw new UsageError(`--source is required: ${SOURCES_HELP}`);
  return loadProspects(source, { where: flags.where, client: twentyClient() });
}

// ---------------------------------------------------------------- commands

function list(): void {
  const lib = library();
  const channel = flags.channel;
  const voice = flags.voice;
  if (channel && !CHANNELS.includes(channel as never)) throw new UsageError(`--channel is one of ${CHANNELS.join(", ")}`);
  if (voice && !VOICES.includes(voice as Voice)) throw new UsageError(`--voice is one of ${VOICES.join(", ")}`);
  for (const s of lib.sequences) {
    if ((channel && s.channel !== channel) || (voice && s.voice !== voice)) continue;
    io.log(`${bold(s.id)}  ${dim(`${s.platform ?? s.channel}, ${s.voice}`)}`);
    io.log(`  ${s.steps.map((m) => `${m.step}. ${m.title} ${dim(`(day ${m.day})`)}`).join("  ")}`);
    if (s.steps[0]?.when) io.log(dim(indent(s.steps[0].when, "  ")));
  }
  if (!channel || channel === "call") {
    for (const m of lib.callScripts) {
      if (voice && m.voice !== voice) continue;
      io.log(`${bold(m.id)}  ${dim(`call, ${m.voice}, ${m.category}`)}`);
      if (m.when) io.log(dim(indent(m.when, "  ")));
    }
    if (!voice) io.log(`${bold("call/objections.yaml")}  ${dim(`${lib.objections.length} objections, personal and company answers`)}`);
  }
}

function lint(): number {
  const { library: lib, issues } = loadLibrary();
  for (const i of issues) io.log(`${i.level === "error" ? red("error") : yellow("warn ")}  ${i.file}  ${dim(`[${i.rule}]`)} ${i.message}`);
  const errors = issues.filter((i) => i.level === "error").length;
  const warnings = issues.length - errors;
  io.log(`${lib.messages.length} messages, ${lib.sequences.length} sequences, ${lib.callScripts.length} call scripts, ${lib.objections.length} objections: ${errors || warnings ? `${errors} errors, ${warnings} warnings` : green("no problems")}`);
  return errors ? 1 : 0;
}

function variables(): void {
  const rows = [["variable", "from", "example"], ...VARIABLES.map((v) => [`{{${v.name}}}`, v.scope, v.example])];
  io.log(table(rows));
  io.log(dim("\nmessages/README.md explains how each one has to read."));
}

async function preview(id: string | undefined): Promise<void> {
  const lib = library();
  if (!id) throw new UsageError("Name a message, sequence or call script: `bun run cold list` shows them.");
  const config = loadConfig();
  const sequence = findSequence(lib, id);
  const single = sequence ? undefined : findMessage(lib, id);
  if (!sequence && !single) throw new UsageError(`Nothing called "${id}". Run \`bun run cold list\`.`);
  const voice = (sequence ?? single)!.voice;
  const account = accountFor(config, voice);
  const offer = getOffer(config, flags.offer);

  let prospect: Prospect | undefined;
  if (flags.source) {
    const all = await prospectsFrom(flags.source);
    prospect = flags.prospect ? findProspect(all, flags.prospect) : all[0];
    if (!prospect) throw new UsageError(`No prospect matching "${flags.prospect}" in ${flags.source}`);
  }

  if (single?.channel === "call") {
    io.log(callSheet(single, lib, account, offer, prospect));
    return;
  }

  const prospectVariables = prospect ? undefined : Object.fromEntries(VARIABLES.filter((v) => v.scope === "prospect").map((v) => [v.name, exampleVariables()[v.name]]));
  const variablesFor = () => (prospect ? buildVariables(account, offer, prospect) : { ...(offer?.variables ?? {}), ...prospectVariables, ...account.variables });
  const key = prospect?.key ?? "example";
  io.log(dim(`account ${account.key} (${account.voice}), offer ${offer?.key ?? "none"}, prospect ${prospect?.label ?? "example values"}${config.isExample ? ", cold.example.yaml" : ""}`));
  for (const message of sequence ? sequence.steps : [single as Message]) {
    const rendered = renderForProspect(message, variablesFor(), key);
    io.log("");
    io.log(`${cyan(message.id)}  ${dim(`day ${message.day}${message.platform ? `, ${message.platform}` : ""}, ${rendered.body.length} characters`)}`);
    if (message.when) io.log(dim(indent(message.when, "  ")));
    if (rendered.subject) io.log(indent(`Subject: ${rendered.subject}\n`));
    io.log(indent(rendered.body));
    if (rendered.missing.length) io.log(yellow(`    missing: ${rendered.missing.map((m) => `{{${m}}}`).join(", ")} (this one would be held back)`));
  }
}

async function twentySchema(): Promise<number> {
  const client = twentyClient();
  if (!client) throw new UsageError("Set TWENTY_BASE_URL and TWENTY_API_KEY in .env.local first.");
  const dryRun = !!flags["dry-run"];
  const line = (i: ApplyItem) => `  ${i.status.padEnd(8)} ${i.kind.padEnd(9)} ${i.object}.${i.name}${i.note ? dim(`  (${i.note})`) : ""}`;
  const report = await applySchema((query, vars) => client.metadata(query, vars), { dryRun, onItem: flags.json ? undefined : (i) => i.status !== "present" && io.log(line(i)) });
  if (flags.json) {
    io.log(JSON.stringify(report, null, 2));
  } else {
    for (const i of report.items.filter((i) => i.status === "present" && i.note)) io.log(line(i));
    const count = (s: ApplyItem["status"]) => report.items.filter((i) => i.status === s).length;
    io.log(`\n${dryRun ? "Dry run" : "Applied"} against ${client.config.baseUrl}: ${count("present")} present, ${dryRun ? `${count("missing")} missing` : `${count("created")} created`}, ${count("skipped")} skipped, ${count("failed")} failed.`);
  }
  const failed = report.items.some((i) => i.status === "failed");
  return failed || (dryRun && report.items.some((i) => i.status === "missing")) ? 1 : 0;
}

async function email(sub: string | undefined, id: string | undefined): Promise<number> {
  const config = loadConfig();
  if (sub === "sync") {
    const account = flags.account ? getAccount(config, flags.account) : accountWithImap(config);
    const store = await openStore(config);
    await syncReplies({ account, store, days: int("days", flags.days, 14)!, io });
    return 0;
  }

  if (sub === "verify") {
    const verifier = reacherFromEnv();
    if (!verifier) throw new UsageError("Set REACHER_URL (a self-hosted Reacher: docker run -p 8080:8080 reacherhq/backend:latest).");
    const prospects = (await prospectsFrom(flags.source)).filter((p) => p.email);
    const store = flags.record ? await openStore(config) : undefined;
    const rows = [["email", "verdict", "prospect"]];
    for (const p of prospects.slice(0, int("limit", flags.limit) ?? prospects.length)) {
      const verdict = await verifier.check(p.email!);
      rows.push([p.email!, verdict === "invalid" ? red(verdict) : verdict === "safe" ? green(verdict) : yellow(verdict), p.label]);
      if (store && verdict === "invalid") await store.record({ kind: "UNDELIVERABLE", channel: "EMAIL", prospectKey: p.key, prospectLabel: p.label, toAddress: p.email, error: "Reacher: invalid", occurredAt: new Date().toISOString(), links: p.links });
    }
    io.log(table(rows));
    return 0;
  }

  if (sub !== "run") throw new UsageError("cold email run | sync | verify");
  const lib = library();
  const sequence = requireSequence(lib, id, "email");
  const dryRun = !!flags["dry-run"];
  if (!dryRun) requireRealConfig(config);
  const account = accountFor(config, sequence.voice);
  const offer = getOffer(config, flags.offer);
  const store = await openStore(config);
  const prospects = await prospectsFrom(flags.source);

  if (!dryRun && !flags["no-sync"] && account.email?.imapUrlEnv && process.env[account.email.imapUrlEnv]) {
    io.log(dim("Checking the inbox for replies first..."));
    await syncReplies({ account, store, days: 14, io });
    io.log("");
  }

  const result = await runEmail({
    sequence,
    account,
    offer,
    prospects,
    store,
    io,
    verifier: reacherFromEnv(),
    options: { dryRun, limit: int("limit", flags.limit), ignoreWindow: !!flags["ignore-window"], yes: !!flags.yes, showAll: !!flags["show-all"] },
  });
  return result.aborted ? 1 : 0;
}

function accountWithImap(config: ColdConfig): Account {
  const withImap = Object.values(config.accounts).filter((a) => a.email?.imapUrlEnv);
  if (withImap.length === 1) return withImap[0]!;
  throw new UsageError(`Pick the account with --account (${withImap.map((a) => a.key).join(", ") || "none has imap_url_env"}).`);
}

async function dm(sub: string | undefined, id: string | undefined): Promise<number> {
  if (sub !== "run") throw new UsageError("cold dm run <sequence> --source <src>");
  const config = loadConfig();
  const lib = library();
  const sequence = requireSequence(lib, id, "dm");
  if (!flags.export) requireRealConfig(config);
  const account = accountFor(config, sequence.voice);
  const store = await openStore(config);
  await runDm({
    sequence,
    account,
    offer: getOffer(config, flags.offer),
    prospects: await prospectsFrom(flags.source),
    store,
    io,
    options: { limit: int("limit", flags.limit), open: !flags["no-open"], exportFile: flags.export },
  });
  return 0;
}

async function call(sub: string | undefined, id: string | undefined): Promise<number> {
  const config = loadConfig();
  const lib = library();
  if (sub === "sync") {
    if (!flags["dry-run"]) requireRealConfig(config);
    const client = twentyClient();
    if (!client) throw new UsageError("Set TWENTY_BASE_URL and TWENTY_API_KEY in .env.local: call scripts sync into the dialer's agencyScripts.");
    const voice = flags.account ? getAccount(config, flags.account).voice : undefined;
    const accounts = voice ? [getAccount(config, flags.account)] : Object.values(config.accounts);
    for (const account of accounts) {
      io.log(bold(`${account.key} (${account.voice})`));
      await syncCallScripts({ client, library: lib, account, offer: getOffer(config, flags.offer), campaign: flags.campaign, dryRun: !!flags["dry-run"], io });
    }
    return 0;
  }
  if (sub === "sheet") {
    if (!id) throw new UsageError(`Name the script: ${lib.callScripts.map((s) => s.id).join(", ")}`);
    const script = findMessage(lib, id);
    if (!script || script.channel !== "call") throw new UsageError(`No call script "${id}". Have: ${lib.callScripts.map((s) => s.id).join(", ")}`);
    const account = accountFor(config, script.voice);
    let prospect: Prospect | undefined;
    if (flags.source) {
      const all = await prospectsFrom(flags.source);
      prospect = flags.prospect ? findProspect(all, flags.prospect) : undefined;
      if (flags.prospect && !prospect) throw new UsageError(`No prospect matching "${flags.prospect}"`);
    }
    io.log(callSheet(script, lib, account, getOffer(config, flags.offer), prospect));
    return 0;
  }
  throw new UsageError("cold call sync | sheet <script>");
}

async function stats(): Promise<number> {
  const config = loadConfig();
  const store = await openStore(config);
  const days = int("days", flags.days, 30)!;
  const touches = (await store.since(new Date(Date.now() - days * 86_400_000).toISOString())).filter((t) => !flags.account || t.account === flags.account);
  const { templates, sequences } = summarize(touches);
  if (!templates.length) {
    io.log(`Nothing logged in the last ${days} days (${store.where}).`);
    return 0;
  }
  io.log(bold(`Last ${days} days${flags.account ? `, account ${flags.account}` : ""} (${store.where})\n`));
  io.log(table([["message", "sent", "replies", "rate", "opt-outs", "bounces"], ...templates.map((t) => [t.templateId, String(t.sent), String(t.replied), rate(t.replied, t.sent), String(t.optedOut), String(t.bounced)])]));
  io.log("");
  io.log(table([["sequence", "started", "replied", "rate", "opted out"], ...sequences.map((s) => [s.sequence, String(s.started), String(s.replied), rate(s.replied, s.started), String(s.optedOut)])]));
  return 0;
}

async function log(who: string | undefined): Promise<number> {
  if (!who) throw new UsageError("Name the prospect: an email, a key like linkedin:dana-reyes, or a name with --source.");
  const kind = flags.kind?.toUpperCase() as Touch["kind"];
  const channel = flags.channel?.toUpperCase() as Touch["channel"];
  if (!TOUCH_KINDS.includes(kind)) throw new UsageError(`--kind is one of ${TOUCH_KINDS.join(", ")}`);
  if (!TOUCH_CHANNELS.includes(channel)) throw new UsageError(`--channel is one of ${TOUCH_CHANNELS.join(", ")}`);
  const config = loadConfig();
  let prospect: Prospect | undefined;
  if (flags.source) {
    prospect = findProspect(await prospectsFrom(flags.source), who);
    if (!prospect) throw new UsageError(`No prospect matching "${who}" in ${flags.source}`);
  }
  const identity = prospect?.key ?? toIdentity(who);
  if (!identity) throw new UsageError(`Can't tell who "${who}" is. Give an email address, a profile (linkedin:dana-reyes, x:handle, instagram:handle, or the profile URL), or add --source to look the name up.`);
  const store = await openStore(config);
  const email = normalizeEmail(who);
  const account = flags.account ? getAccount(config, flags.account) : undefined;
  const sequence = flags.sequence ? findSequence(loadLibrary().library, flags.sequence) : undefined;
  const step = int("step", flags.step);
  await store.record({
    kind,
    channel,
    voice: account ? (account.voice === "personal" ? "PERSONAL" : "COMPANY") : undefined,
    account: account?.key,
    sequence: sequence?.id ?? flags.sequence,
    step,
    templateId: sequence?.steps.find((m) => m.step === step)?.id,
    prospectKey: identity,
    prospectLabel: prospect?.label,
    toAddress: email ?? prospect?.email,
    body: flags.note,
    occurredAt: new Date().toISOString(),
    links: prospect?.links,
  });
  if (kind === "OPTED_OUT") await store.markDoNotContact(prospect?.links);
  io.log(`${green("logged")} ${kind} ${channel} for ${prospect?.label ?? identity} ${dim(`(${store.where})`)}`);
  return 0;
}

// ---------------------------------------------------------------- owner

/** Read a line without echoing it (a password). Piped input is read as is, for scripts. */
async function secret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    for await (const line of console) return line.trim();
    return "";
  }
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") process.exit(130);
        value = ch === "\u007f" ? value.slice(0, -1) : value + ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function owner(sub: string | undefined): Promise<number> {
  if (sub === "hash") {
    const password = await secret("Password to hash: ");
    const problem = passwordProblem(password);
    if (problem) throw new UsageError(problem);
    io.log(await Bun.password.hash(password, { algorithm: "argon2id" }));
    io.log(dim("Set it as COLD_OWNER_PASSWORD_HASH, with your address as COLD_OWNER_EMAIL, where the server runs."));
    return 0;
  }
  if (sub) throw new UsageError(`Unknown: cold owner ${sub}. Use \`cold owner\` or \`cold owner hash\`.`);
  // With the database's address in the environment (vercel env pull), this resets the hosted login.
  const remote = databaseFromEnv();
  const db = remote ? await connectDatabase(remote) : await openDatabase(path.join(ROOT, ".cold", "cold.db"));
  const auth = new OwnerAuth(db, { envOwner: OwnerAuth.envOwner() });
  const current = await auth.owner();
  if (current?.managedByEnv) throw new UsageError("The login is set by COLD_OWNER_EMAIL and COLD_OWNER_PASSWORD_HASH; change those instead.");
  let email = flags.email?.trim() ?? "";
  if (!email) {
    if (!io.interactive) throw new UsageError("Pass --email, and the password on standard input.");
    const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
    email = (await rl.question(`Email${current ? ` [${current.email}]` : ""}: `)).trim() || current?.email || "";
    rl.close();
  }
  const emailIssue = emailProblem(email.toLowerCase());
  if (emailIssue) throw new UsageError(emailIssue);
  const password = await secret("New password (12+ characters): ");
  const problem = passwordProblem(password);
  if (problem) throw new UsageError(problem);
  if (process.stdin.isTTY && (await secret("Again: ")) !== password) throw new UsageError("The two passwords are not the same.");
  await auth.setOwner(email, password);
  io.log(`${green(current ? "Login reset" : "Login created")} for ${email.toLowerCase()}. Every old session is signed out.`);
  io.log(dim(`Sign in at /app/ on your COLD server (local: http://localhost:${process.env.COLD_UI_PORT || 4100}/app/).`));
  return 0;
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  loadEnvFiles();
  const [command, sub, arg] = positionals;
  if (flags.help || !command || command === "help") {
    io.log(HELP);
    return 0;
  }
  switch (command) {
    case "list":
      list();
      return 0;
    case "lint":
      return lint();
    case "variables":
      variables();
      return 0;
    case "preview":
      await preview(sub);
      return 0;
    case "twenty:schema":
      return twentySchema();
    case "email":
      return email(sub, arg);
    case "dm":
      return dm(sub, arg);
    case "call":
      return call(sub, arg);
    case "stats":
      return stats();
    case "log":
      return log(sub);
    case "owner":
      return owner(sub);
    default:
      throw new UsageError(`Unknown command "${command}". Run \`bun run cold help\`.`);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: Error) => {
    console.error(red(err.message));
    if (process.env.DEBUG && !(err instanceof UsageError)) console.error(err.stack);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
