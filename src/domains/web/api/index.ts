import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { callSheetData, syncCallScripts } from "../../call";
import type { Io } from "../../cli/io";
import { getOffer, parseConfig, type Account, type ColdConfig, type Offer } from "../../config";
import { dmChecklist, prepareDmRun, recordDmOutcome, type DmOutcome } from "../../dm";
import { describeWindow, prepareEmailRun, reacherFromEnv, sendEmails, smtpTransport, syncReplies, testImap } from "../../email";
import { findMessage, findSequence, lintMessage, lintSequences, toMessage, toSequences, type Library, type Message } from "../../messages";
import { buildVariables, renderForProspect } from "../../outreach";
import { findProspect, parseCsv, type Prospect } from "../../prospects";
import { renderTemplate, VARIABLES } from "../../render";
import { summarize } from "../../stats";
import { TOUCH_KINDS, twentyClient, type Touch } from "../../touches";
import { applySchema, readLiveSchema, twentyConfigFromEnv } from "../../twenty";
import type { WebContext } from "../context";
import type {
  ActionResponse,
  Campaign,
  CampaignInput,
  LibraryResponse,
  MessageResponse,
  PlanResponse,
  PlanRow,
  PreviewResponse,
  ProspectSummary,
  SettingsResponse,
  SourceOption,
  StatsResponse,
  StatusResponse,
} from "../types";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const MESSAGE_ID = /^(email|dm)\/(personal|company)\/[a-z0-9]+(?:-[a-z0-9]+)*\/\d+-[a-z0-9]+(?:-[a-z0-9]+)*$|^call\/(personal|company)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE = /^(csv:.+\.csv|twenty:(people|agencyProspects|agencyPeople))$/;
const ANSI = /\x1b\[[0-9;]*m/g;

async function readBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "The request body must be JSON.");
  }
}

/** An Io that keeps what a runner prints, without terminal colours. */
function collectingIo(): Io & { lines: string[] } {
  const lines: string[] = [];
  return { interactive: false, lines, log: (line = "") => void lines.push(line.replace(ANSI, "")), confirm: async () => false, choose: async () => "q" };
}

function row(prospect: Prospect, extra: Omit<PlanRow, "key" | "label"> = {}): PlanRow {
  return { key: prospect.key, label: prospect.label, ...extra };
}

/** The env vars the Settings page may set, with what each one is for. */
function envFields(config: ColdConfig | undefined): SettingsResponse["env"] {
  const fields = new Map<string, string>([
    ["TWENTY_BASE_URL", "Twenty URL: https://api.twenty.com or your own"],
    ["TWENTY_API_KEY", "Twenty API key (Settings, Developers, API)"],
  ]);
  for (const a of Object.values(config?.accounts ?? {})) {
    if (a.email) fields.set(a.email.smtpUrlEnv, `SMTP for ${a.key}: smtps://you%40domain.com:app-password@smtp.gmail.com:465`);
    if (a.email?.imapUrlEnv) fields.set(a.email.imapUrlEnv, `IMAP for ${a.key}: imaps://you%40domain.com:app-password@imap.gmail.com:993`);
  }
  fields.set("REACHER_URL", "Optional: a self-hosted Reacher, e.g. http://localhost:8080");
  fields.set("REACHER_SECRET", "Optional: Reacher's header secret");
  return [...fields.entries()].map(([name, hint]) => ({ name, set: !!process.env[name]?.trim(), hint }));
}

/** Write KEY=value lines into .env.local, replacing or removing existing ones. */
function writeEnvFile(file: string, values: Record<string, string>): void {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  for (const [name, value] of Object.entries(values)) {
    const index = lines.findIndex((l) => new RegExp(`^\\s*${name}\\s*=`).test(l));
    const quoted = /[\s#"']/.test(value) ? JSON.stringify(value) : value;
    if (!value) {
      if (index !== -1) lines.splice(index, 1);
    } else if (index !== -1) lines[index] = `${name}=${quoted}`;
    else lines.push(`${name}=${quoted}`);
  }
  writeFileSync(file, `${lines.filter((l, i) => l.trim() || i < lines.length - 1).join("\n").trim()}\n`);
}

export function createApi(ctx: WebContext): (request: Request) => Promise<Response> {
  const relative = (file: string) => {
    const rel = path.relative(ctx.root, file);
    return rel && !rel.startsWith("..") ? rel : file;
  };

  function campaignOr404(id: string): Campaign {
    const campaign = ctx.campaigns.get(id);
    if (!campaign) throw new HttpError(404, "No such campaign.");
    return campaign;
  }

  /** Everything a campaign needs, checked: the sequence exists, the account exists and speaks its voice. */
  function resolveCampaign(campaign: CampaignInput, library: Library, config: ColdConfig): { sequence: NonNullable<ReturnType<typeof findSequence>>; account: Account; offer?: Offer } {
    const sequence = findSequence(library, campaign.sequence);
    if (!sequence) throw new HttpError(400, `There is no sequence "${campaign.sequence}" in the library.`);
    const account = config.accounts[campaign.account];
    if (!account) throw new HttpError(400, `There is no account "${campaign.account}" in ${config.file}.`);
    if (account.voice !== sequence.voice) throw new HttpError(400, `${sequence.id} is written in the ${sequence.voice} voice, but account "${account.key}" is ${account.voice}.`);
    if (campaign.offer && !config.offers[campaign.offer]) throw new HttpError(400, `There is no offer "${campaign.offer}" in ${config.file}.`);
    return { sequence, account, offer: campaign.offer ? config.offers[campaign.offer] : getOffer(config, undefined) };
  }

  function validateCampaign(input: Partial<CampaignInput>): CampaignInput {
    const campaign: CampaignInput = {
      name: (input.name ?? "").trim(),
      sequence: (input.sequence ?? "").trim(),
      account: (input.account ?? "").trim(),
      offer: input.offer?.trim() || undefined,
      source: (input.source ?? "").trim(),
      where: input.where?.trim() || undefined,
    };
    if (!campaign.name) throw new HttpError(400, "Give the campaign a name.");
    if (!SOURCE.test(campaign.source)) throw new HttpError(400, "Pick a prospect list: a CSV file or a Twenty source.");
    if (campaign.where && !campaign.source.startsWith("twenty:")) throw new HttpError(400, "A Twenty filter only applies to a Twenty source.");
    resolveCampaign(campaign, ctx.library().library, ctx.requireConfig());
    return campaign;
  }

  async function plan(campaign: Campaign, refresh: boolean): Promise<PlanResponse> {
    const { config, isExample } = ctx.config();
    if (!config) throw new HttpError(400, ctx.config().error ?? "cold.yaml has problems.");
    const { sequence, account, offer } = resolveCampaign(campaign, ctx.library().library, config);
    const store = await ctx.store(config);
    const prospects = await ctx.prospects(campaign.source, campaign.where, refresh);
    const now = () => ctx.now();
    const blockers: string[] = [];
    if (isExample) blockers.push("cold.yaml does not exist yet, so these would go out as the example sender. Create it in Settings.");

    if (sequence.channel === "email") {
      const prepared = await prepareEmailRun({ sequence, account, offer, prospects, store, now });
      const email = account.email!;
      if (!process.env[email.smtpUrlEnv]?.trim()) blockers.push(`The mailbox is not connected: set ${email.smtpUrlEnv} in Settings.`);
      if (prepared.batch.length === 0 && prepared.ready.length > 0) blockers.push(`The daily cap of ${prepared.dailyCap} is used up for today.`);
      return {
        campaign,
        channel: "email",
        sequence: { id: sequence.id, steps: sequence.steps.length },
        account: { key: account.key, voice: account.voice, from: email.from },
        prospects: prospects.length,
        due: prepared.ready.map((r) => row(r.prospect, { address: r.address, step: r.step.step, stepTitle: r.step.title, when: r.step.when, subject: r.draft.subject, text: r.draft.text })),
        held: prepared.held.map((h) => row(h.prospect, { step: h.step.step, stepTitle: h.step.title, reason: `missing ${h.missing.map((m) => `{{${m}}}`).join(", ")}` })),
        waiting: prepared.plan.waiting.map((w) => row(w.prospect, { step: w.step.step, stepTitle: w.step.title, dueOn: w.dueOn })),
        skipped: prepared.plan.skipped.map((s) => row(s.prospect, { reason: s.reason })),
        cap: prepared.dailyCap,
        sentToday: prepared.sentToday,
        sendable: prepared.batch.length,
        window: prepared.windowOpen === undefined ? undefined : { open: prepared.windowOpen, text: prepared.windowText! },
        pace: { min: email.minDelaySeconds, max: email.maxDelaySeconds },
        blockers,
      };
    }

    const prepared = await prepareDmRun({ sequence, account, offer, prospects, store, now });
    if (prepared.batch.length === 0 && prepared.queue.length > 0) blockers.push(`The daily cap of ${prepared.cap} on this platform is used up for today.`);
    return {
      campaign,
      channel: "dm",
      platform: prepared.platform,
      sequence: { id: sequence.id, steps: sequence.steps.length },
      account: { key: account.key, voice: account.voice },
      prospects: prospects.length,
      due: prepared.queue.map((q) => row(q.prospect, { address: q.url, url: q.url, step: q.step.step, stepTitle: q.step.title, when: q.step.when, text: q.text })),
      held: prepared.held.map((h) => row(h.prospect, { step: h.step.step, stepTitle: h.step.title, reason: h.reason })),
      waiting: prepared.plan.waiting.map((w) => row(w.prospect, { step: w.step.step, stepTitle: w.step.title, dueOn: w.dueOn })),
      skipped: prepared.plan.skipped.map((s) => row(s.prospect, { reason: s.reason })),
      cap: prepared.cap,
      sentToday: prepared.sentToday,
      sendable: prepared.batch.length,
      blockers,
    };
  }

  const routes: Array<[string, RegExp, (request: Request, params: string[], url: URL) => Promise<Response> | Response]> = [
    [
      "GET",
      /^\/api\/status$/,
      async () => {
        const { config, error, file, isExample } = ctx.config();
        let store: StatusResponse["store"] = { error: error ?? "no config" };
        if (config) {
          try {
            const s = await ctx.store(config);
            store = { kind: s.kind, where: s.where };
          } catch (err) {
            store = { error: (err as Error).message };
          }
        }
        const twenty = twentyConfigFromEnv();
        const status: StatusResponse = {
          configFile: relative(file),
          isExample,
          configError: error,
          store,
          twenty: { configured: !!twenty, baseUrl: twenty?.baseUrl },
          reacher: !!process.env.REACHER_URL?.trim(),
          accounts: Object.values(config?.accounts ?? {}).map((a) => ({
            key: a.key,
            voice: a.voice,
            senderName: a.variables.sender_name ?? a.key,
            email: a.email && {
              from: a.email.from,
              smtpEnv: a.email.smtpUrlEnv,
              smtpSet: !!process.env[a.email.smtpUrlEnv]?.trim(),
              imapEnv: a.email.imapUrlEnv,
              imapSet: !!(a.email.imapUrlEnv && process.env[a.email.imapUrlEnv]?.trim()),
              dailyCap: a.email.dailyCap,
              window: a.email.window && describeWindow(a.email.window),
            },
            dmCaps: a.dm.dailyCaps,
          })),
          offers: Object.values(config?.offers ?? {}).map((o) => ({ key: o.key, audience: o.variables.audience, offer: o.variables.offer })),
          defaultOffer: config?.defaultOffer,
        };
        return json(status);
      },
    ],
    [
      "GET",
      /^\/api\/library$/,
      () => {
        const { library, issues } = ctx.library();
        const response: LibraryResponse = {
          sequences: library.sequences.map((s) => ({
            id: s.id,
            channel: s.channel,
            voice: s.voice,
            platform: s.platform,
            steps: s.steps.map((m) => ({ id: m.id, step: m.step ?? 0, day: m.day ?? 0, title: m.title, subject: m.subject, when: m.when })),
          })),
          callScripts: library.callScripts.map((m) => ({ id: m.id, title: m.title, voice: m.voice, category: m.category ?? "General", when: m.when })),
          objections: library.objections.length,
          issues,
        };
        return json(response);
      },
    ],
    [
      "GET",
      /^\/api\/variables$/,
      () => json(VARIABLES),
    ],
    [
      "GET",
      /^\/api\/messages$/,
      (_request, _params, url) => {
        const id = url.searchParams.get("id") ?? "";
        if (!MESSAGE_ID.test(id)) throw new HttpError(400, "Not a message id.");
        const file = path.join(ctx.options.messagesDir, `${id}.md`);
        if (!existsSync(file)) throw new HttpError(404, `No message ${id}.`);
        const source = readFileSync(file, "utf8");
        const { message, issues } = toMessage(`${id}.md`, source);
        const response: MessageResponse = { id, file: `messages/${id}.md`, source, issues: message ? [...issues, ...lintMessage(message)] : issues };
        return json(response);
      },
    ],
    [
      "PUT",
      /^\/api\/messages$/,
      async (request) => {
        const { id, source } = await readBody<{ id: string; source: string }>(request);
        if (!MESSAGE_ID.test(id ?? "")) throw new HttpError(400, "Not a message id.");
        const file = path.join(ctx.options.messagesDir, `${id}.md`);
        if (!existsSync(file)) throw new HttpError(404, `No message ${id}: new messages are added as files.`);
        const { message, issues } = toMessage(`${id}.md`, source ?? "", `messages/${id}.md`);
        const all = message ? [...issues, ...lintMessage(message)] : issues;
        if (message?.sequence) {
          const { library } = ctx.library();
          const siblings = library.messages.filter((m) => m.sequence === message.sequence && m.id !== message.id);
          all.push(...lintSequences(toSequences([...siblings, message])).filter((i) => i.level === "error"));
        }
        if (all.some((i) => i.level === "error")) throw new HttpError(422, "Not saved: fix the errors first.", { issues: all });
        writeFileSync(file, source.endsWith("\n") ? source : `${source}\n`);
        return json({ ok: true, issues: all });
      },
    ],
    [
      "POST",
      /^\/api\/preview$/,
      async (request) => {
        const input = await readBody<{ id: string; template?: string; account?: string; offer?: string; source?: string; where?: string; prospect?: string }>(request);
        const config = ctx.requireConfig();
        const { library } = ctx.library();
        let message: Message | undefined = findMessage(library, input.id ?? "");
        if (!message) throw new HttpError(404, `No message ${input.id}.`);
        if (input.template !== undefined) {
          const parsed = toMessage(`${message.id}.md`, input.template, message.file);
          if (!parsed.message) throw new HttpError(422, "The edit does not parse yet.", { issues: parsed.issues });
          message = parsed.message;
        }
        const account = input.account ? config.accounts[input.account] : Object.values(config.accounts).find((a) => a.voice === message!.voice);
        if (!account) throw new HttpError(400, `No ${message.voice} account in ${config.file} to preview with.`);
        const offer = input.offer ? config.offers[input.offer] : getOffer(config, undefined);
        let prospect: Prospect | undefined;
        if (input.source && input.prospect) {
          prospect = findProspect(await ctx.prospects(input.source, input.where), input.prospect);
          if (!prospect) throw new HttpError(404, "That prospect is not in the list any more.");
        }
        if (message.channel === "call") return json({ missing: [], sheet: callSheetData(message, library, account, offer, prospect), prospectLabel: prospect?.label } satisfies PreviewResponse);
        const examples = Object.fromEntries(VARIABLES.filter((v) => v.scope === "prospect").map((v) => [v.name, v.example]));
        const variables = prospect ? buildVariables(account, offer, prospect) : { ...(offer?.variables ?? {}), ...examples, ...account.variables };
        const rendered = renderForProspect(message, variables, prospect?.key ?? "example");
        const footer = message.channel === "email" && account.email ? renderTemplate(account.email.footer, variables, { mode: "strict", seed: account.key }).text : undefined;
        const response: PreviewResponse = { subject: rendered.subject, body: rendered.body, footer, missing: rendered.missing, prospectLabel: prospect?.label ?? "example values" };
        return json(response);
      },
    ],
    [
      "GET",
      /^\/api\/sources$/,
      () => {
        const sources: SourceOption[] = [];
        const csvs = readdirSync(ctx.root).filter((f) => /^prospects.*\.csv$/i.test(f));
        for (const f of csvs) sources.push({ id: `csv:${f}`, label: f, kind: "csv" });
        if (existsSync(path.join(ctx.root, "examples/prospects.csv"))) sources.push({ id: "csv:examples/prospects.csv", label: "examples/prospects.csv (5 fictional prospects)", kind: "csv" });
        if (twentyConfigFromEnv()) {
          sources.push({ id: "twenty:people", label: "Twenty: People", kind: "twenty" });
          sources.push({ id: "twenty:agencyProspects", label: "Twenty: dialer prospects (businesses)", kind: "twenty" });
          sources.push({ id: "twenty:agencyPeople", label: "Twenty: people at dialer prospects", kind: "twenty" });
        }
        return json(sources);
      },
    ],
    [
      "POST",
      /^\/api\/sources\/csv$/,
      async (request) => {
        const { name, content } = await readBody<{ name: string; content: string }>(request);
        if (!content || content.length > 10_000_000) throw new HttpError(400, "Upload a CSV under 10 MB.");
        const rows = parseCsv(content);
        if (rows.length < 2) throw new HttpError(400, "The CSV needs a header row and at least one prospect.");
        const slug = (name ?? "list").toLowerCase().replace(/\.csv$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "list";
        const file = `prospects-${slug}.csv`;
        writeFileSync(path.join(ctx.root, file), content);
        ctx.invalidate();
        return json({ source: `csv:${file}`, rows: rows.length - 1, columns: rows[0] });
      },
    ],
    [
      "GET",
      /^\/api\/prospects$/,
      async (_request, _params, url) => {
        const source = url.searchParams.get("source") ?? "";
        if (!SOURCE.test(source)) throw new HttpError(400, "Pick a prospect list.");
        const prospects = await ctx.prospects(source, url.searchParams.get("where") ?? undefined, url.searchParams.get("refresh") === "1");
        const summaries: ProspectSummary[] = prospects.slice(0, 5000).map((p) => ({
          key: p.key,
          label: p.label,
          email: p.email,
          linkedinUrl: p.linkedinUrl,
          xHandle: p.xHandle,
          instagramHandle: p.instagramHandle,
          doNotContact: p.doNotContact,
          hasTrigger: !!p.variables.trigger,
        }));
        return json({ total: prospects.length, prospects: summaries });
      },
    ],
    ["GET", /^\/api\/campaigns$/, () => json(ctx.campaigns.list())],
    [
      "POST",
      /^\/api\/campaigns$/,
      async (request) => json(ctx.campaigns.create(validateCampaign(await readBody<CampaignInput>(request)), ctx.now()), 201),
    ],
    [
      "PUT",
      /^\/api\/campaigns\/([\w-]+)$/,
      async (request, [id]) => {
        campaignOr404(id!);
        return json(ctx.campaigns.update(id!, validateCampaign(await readBody<CampaignInput>(request))));
      },
    ],
    [
      "DELETE",
      /^\/api\/campaigns\/([\w-]+)$/,
      (_request, [id]) => {
        if (!ctx.campaigns.remove(id!)) throw new HttpError(404, "No such campaign.");
        return json({ ok: true });
      },
    ],
    ["GET", /^\/api\/campaigns\/([\w-]+)\/plan$/, async (_request, [id], url) => json(await plan(campaignOr404(id!), url.searchParams.get("refresh") === "1"))],
    [
      "POST",
      /^\/api\/campaigns\/([\w-]+)\/send$/,
      async (request, [id]) => {
        const campaign = campaignOr404(id!);
        const { ignoreWindow = false, limit } = await readBody<{ ignoreWindow?: boolean; limit?: number }>(request);
        const { config, isExample } = ctx.config();
        if (!config) throw new HttpError(400, ctx.config().error ?? "cold.yaml has problems.");
        if (isExample) throw new HttpError(409, "cold.yaml does not exist yet, so this would send as the example sender. Create it in Settings first.");
        const { sequence, account, offer } = resolveCampaign(campaign, ctx.library().library, config);
        if (sequence.channel !== "email") throw new HttpError(400, "DMs are sent by you: work through them on the campaign page.");
        if (!ctx.options.transport && !process.env[account.email!.smtpUrlEnv]?.trim()) throw new HttpError(409, `The mailbox is not connected: set ${account.email!.smtpUrlEnv} in Settings.`);
        if (ctx.jobs.running(account.key)) throw new HttpError(409, `Already sending from ${account.key}. Wait for it to finish, or stop it.`);
        const store = await ctx.store(config);
        const prospects = await ctx.prospects(campaign.source, campaign.where);
        const prepared = await prepareEmailRun({ sequence, account, offer, prospects, store, limit: typeof limit === "number" && limit > 0 ? limit : undefined, now: () => ctx.now() });
        if (prepared.batch.length === 0) throw new HttpError(409, "Nothing to send right now.");
        if (prepared.windowOpen === false && !ignoreWindow) throw new HttpError(409, `Outside the sending window (${prepared.windowText}). Tick "Send anyway" to override.`);
        const transport = ctx.options.transport?.(account) ?? smtpTransport(account);
        const job = ctx.jobs.start(account.key, (handle) =>
          sendEmails(prepared, { store, ignoreWindow, transport, verifier: reacherFromEnv(), now: () => ctx.now(), random: ctx.options.random, sleep: handle.sleep, onEvent: handle.emit, shouldStop: handle.shouldStop }),
        );
        return json({ job, total: prepared.batch.length }, 202);
      },
    ],
    [
      "GET",
      /^\/api\/jobs\/([\w-]+)$/,
      (_request, [id], url) => {
        const view = ctx.jobs.view(id!, Number(url.searchParams.get("after") ?? 0) || 0);
        if (!view) throw new HttpError(404, "No such job: the server may have restarted.");
        return json(view);
      },
    ],
    [
      "POST",
      /^\/api\/jobs\/([\w-]+)\/stop$/,
      (_request, [id]) => json({ ok: ctx.jobs.stop(id!) }),
    ],
    [
      "POST",
      /^\/api\/campaigns\/([\w-]+)\/dm$/,
      async (request, [id]) => {
        const campaign = campaignOr404(id!);
        const { prospect, outcome } = await readBody<{ prospect: string; outcome: DmOutcome }>(request);
        if (!["SENT", "REPLIED", "OPTED_OUT"].includes(outcome)) throw new HttpError(400, "The outcome is SENT, REPLIED or OPTED_OUT.");
        const { config, isExample } = ctx.config();
        if (!config) throw new HttpError(400, ctx.config().error ?? "cold.yaml has problems.");
        if (isExample) throw new HttpError(409, "cold.yaml does not exist yet: create it in Settings so DMs are signed and logged as you.");
        const { sequence, account, offer } = resolveCampaign(campaign, ctx.library().library, config);
        const store = await ctx.store(config);
        const prepared = await prepareDmRun({ sequence, account, offer, prospects: await ctx.prospects(campaign.source, campaign.where), store, now: () => ctx.now() });
        const item = prepared.queue.find((q) => q.prospect.key === prospect);
        if (!item) throw new HttpError(409, "That DM is no longer due. Refresh the page.");
        if (outcome === "SENT" && !prepared.batch.includes(item)) throw new HttpError(409, `The daily cap of ${prepared.cap} is used up for today.`);
        await recordDmOutcome(store, prepared, item, outcome, ctx.now());
        return json({ ok: true });
      },
    ],
    [
      "GET",
      /^\/api\/campaigns\/([\w-]+)\/checklist$/,
      async (_request, [id]) => {
        const campaign = campaignOr404(id!);
        const config = ctx.requireConfig();
        const { sequence, account, offer } = resolveCampaign(campaign, ctx.library().library, config);
        if (sequence.channel !== "dm") throw new HttpError(400, "Checklists are for DM campaigns.");
        const prepared = await prepareDmRun({ sequence, account, offer, prospects: await ctx.prospects(campaign.source, campaign.where), store: await ctx.store(config), now: () => ctx.now() });
        return new Response(dmChecklist(prepared, ctx.now()), {
          headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${campaign.name.replace(/[^\w-]+/g, "-")}-dms.md"`, "cache-control": "no-store" },
        });
      },
    ],
    [
      "GET",
      /^\/api\/calls\/sheet$/,
      async (_request, _params, url) => {
        const config = ctx.requireConfig();
        const { library } = ctx.library();
        const script = findMessage(library, url.searchParams.get("id") ?? "");
        if (!script || script.channel !== "call") throw new HttpError(404, "No such call script.");
        const accountKey = url.searchParams.get("account");
        const account = accountKey ? config.accounts[accountKey] : Object.values(config.accounts).find((a) => a.voice === script.voice);
        if (!account) throw new HttpError(400, `No ${script.voice} account in ${config.file}.`);
        const offerKey = url.searchParams.get("offer");
        const offer = offerKey ? config.offers[offerKey] : getOffer(config, undefined);
        const source = url.searchParams.get("source");
        const prospectKey = url.searchParams.get("prospect");
        const prospect = source && prospectKey ? findProspect(await ctx.prospects(source), prospectKey) : undefined;
        return json(callSheetData(script, library, account, offer, prospect));
      },
    ],
    [
      "POST",
      /^\/api\/calls\/sync$/,
      async (request) => {
        const input = await readBody<{ account?: string; offer?: string; campaign?: string; dryRun?: boolean }>(request);
        const { config, isExample } = ctx.config();
        if (!config) throw new HttpError(400, ctx.config().error ?? "cold.yaml has problems.");
        if (isExample && !input.dryRun) throw new HttpError(409, "cold.yaml does not exist yet, so the scripts would carry the example sender. Create it in Settings first.");
        const client = twentyClient();
        if (!client) throw new HttpError(409, "Connect Twenty in Settings first: call scripts sync into the dialer's agencyScripts.");
        const io = collectingIo();
        const accounts = input.account ? [config.accounts[input.account]].filter((a): a is Account => !!a) : Object.values(config.accounts);
        let created = 0;
        let updated = 0;
        for (const account of accounts) {
          io.log(`${account.key} (${account.voice})`);
          const result = await syncCallScripts({ client, library: ctx.library().library, account, offer: input.offer ? config.offers[input.offer] : getOffer(config, undefined), campaign: input.campaign || undefined, dryRun: !!input.dryRun, io });
          created += result.created;
          updated += result.updated;
        }
        const response: ActionResponse = { ok: true, message: input.dryRun ? "Dry run: nothing was written." : `${created} created, ${updated} updated in the dialer.`, lines: io.lines };
        return json(response);
      },
    ],
    [
      "POST",
      /^\/api\/replies\/sync$/,
      async (request) => {
        const { account: key, days = 14 } = await readBody<{ account: string; days?: number }>(request);
        const config = ctx.requireConfig();
        const account = config.accounts[key];
        if (!account?.email?.imapUrlEnv) throw new HttpError(400, `Account "${key}" has no inbox to read: set imap_url_env in cold.yaml.`);
        const io = collectingIo();
        const result = await syncReplies({ account, store: await ctx.store(config), days: Math.min(Math.max(1, Number(days) || 14), 120), io, now: () => ctx.now() });
        return json({ ok: true, result, lines: io.lines });
      },
    ],
    [
      "GET",
      /^\/api\/touches$/,
      async (_request, _params, url) => {
        const config = ctx.requireConfig();
        const days = Math.min(Math.max(1, Number(url.searchParams.get("days")) || 30), 365);
        const kinds = (url.searchParams.get("kinds") ?? "").split(",").filter((k) => TOUCH_KINDS.includes(k as Touch["kind"]));
        const account = url.searchParams.get("account");
        const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 1000);
        const touches = (await (await ctx.store(config)).since(new Date(ctx.now().getTime() - days * 86_400_000).toISOString()))
          .filter((t) => (!kinds.length || kinds.includes(t.kind)) && (!account || t.account === account))
          .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
          .slice(0, limit);
        return json(touches);
      },
    ],
    [
      "GET",
      /^\/api\/stats$/,
      async (_request, _params, url) => {
        const config = ctx.requireConfig();
        const days = Math.min(Math.max(1, Number(url.searchParams.get("days")) || 30), 365);
        const account = url.searchParams.get("account");
        const touches = (await (await ctx.store(config)).since(new Date(ctx.now().getTime() - days * 86_400_000).toISOString())).filter((t) => !account || t.account === account);
        const { templates, sequences } = summarize(touches);
        const count = (kind: Touch["kind"]) => touches.filter((t) => t.kind === kind).length;
        const response: StatsResponse = { days, templates, sequences, totals: { sent: count("SENT"), replied: count("REPLIED"), optedOut: count("OPTED_OUT"), bounced: count("BOUNCED") } };
        return json(response);
      },
    ],
    [
      "GET",
      /^\/api\/settings$/,
      () => {
        const { file, example } = { ...ctx.config(), example: path.join(ctx.root, "cold.example.yaml") };
        const target = process.env.COLD_CONFIG ? path.resolve(process.env.COLD_CONFIG) : path.join(ctx.root, "cold.yaml");
        const exists = existsSync(target);
        const yaml = readFileSync(exists ? target : example, "utf8");
        const { config, error } = ctx.config();
        const response: SettingsResponse = { configFile: relative(exists ? target : file), exists, yaml, errors: error ? error.split("\n").map((l) => l.replace(/^\s*-\s*/, "")).filter(Boolean) : [], env: envFields(config) };
        return json(response);
      },
    ],
    [
      "PUT",
      /^\/api\/settings\/config$/,
      async (request) => {
        const { yaml } = await readBody<{ yaml: string }>(request);
        let raw: unknown;
        try {
          raw = parse(yaml ?? "");
        } catch (err) {
          throw new HttpError(422, `Not saved: this is not valid YAML (${(err as Error).message.split("\n")[0]}).`, { errors: [] });
        }
        const { errors } = parseConfig(raw, "cold.yaml");
        if (errors.length) throw new HttpError(422, "Not saved: fix these first.", { errors });
        const target = process.env.COLD_CONFIG ? path.resolve(process.env.COLD_CONFIG) : path.join(ctx.root, "cold.yaml");
        writeFileSync(target, yaml.endsWith("\n") ? yaml : `${yaml}\n`);
        ctx.invalidate();
        return json({ ok: true, message: `Saved ${relative(target)}.` } satisfies ActionResponse);
      },
    ],
    [
      "PUT",
      /^\/api\/settings\/env$/,
      async (request) => {
        const { values } = await readBody<{ values: Record<string, string> }>(request);
        const allowed = new Set(envFields(ctx.config().config).map((f) => f.name));
        const clean: Record<string, string> = {};
        for (const [name, value] of Object.entries(values ?? {})) {
          if (!allowed.has(name)) throw new HttpError(400, `${name} is not a setting cold uses.`);
          if (typeof value !== "string" || /[\r\n]/.test(value)) throw new HttpError(400, `${name} must be a single line.`);
          clean[name] = value.trim();
        }
        writeEnvFile(path.join(ctx.root, ".env.local"), clean);
        for (const [name, value] of Object.entries(clean)) {
          if (value) process.env[name] = value;
          else delete process.env[name];
        }
        ctx.invalidate();
        return json({ ok: true, message: `Saved ${Object.keys(clean).length} setting${Object.keys(clean).length === 1 ? "" : "s"} to .env.local.` } satisfies ActionResponse);
      },
    ],
    [
      "POST",
      /^\/api\/settings\/test$/,
      async (request) => {
        const { kind, account: key } = await readBody<{ kind: "twenty" | "smtp" | "imap"; account?: string }>(request);
        try {
          if (kind === "twenty") {
            const client = twentyClient();
            if (!client) throw new Error("Set TWENTY_BASE_URL and TWENTY_API_KEY first.");
            const live = await readLiveSchema((query, variables) => client.metadata(query, variables));
            const ready = live.has("coldTouch");
            return json({ ok: true, message: ready ? `Connected to ${client.config.baseUrl}, and the coldTouch object is there.` : `Connected to ${client.config.baseUrl}. Run "Set up Twenty" to create the coldTouch object.` } satisfies ActionResponse);
          }
          const account = ctx.requireConfig().accounts[key ?? ""];
          if (!account?.email) throw new Error(`Account "${key}" has no email settings.`);
          if (kind === "smtp") {
            await smtpTransport(account).verify();
            return json({ ok: true, message: `The ${account.key} mailbox accepted the login (SMTP).` } satisfies ActionResponse);
          }
          await testImap(account);
          return json({ ok: true, message: `The ${account.key} inbox accepted the login (IMAP).` } satisfies ActionResponse);
        } catch (err) {
          return json({ ok: false, message: (err as Error).message } satisfies ActionResponse);
        }
      },
    ],
    [
      "POST",
      /^\/api\/settings\/init$/,
      () => {
        const target = process.env.COLD_CONFIG ? path.resolve(process.env.COLD_CONFIG) : path.join(ctx.root, "cold.yaml");
        if (existsSync(target)) throw new HttpError(409, `${relative(target)} already exists.`);
        writeFileSync(target, readFileSync(path.join(ctx.root, "cold.example.yaml"), "utf8"));
        ctx.invalidate();
        return json({ ok: true, message: `Created ${relative(target)} from the example. Now put your own details in it.` } satisfies ActionResponse);
      },
    ],
    [
      "POST",
      /^\/api\/twenty\/schema$/,
      async (request) => {
        const { dryRun = false } = await readBody<{ dryRun?: boolean }>(request);
        const client = twentyClient();
        if (!client) throw new HttpError(409, "Set TWENTY_BASE_URL and TWENTY_API_KEY first.");
        const report = await applySchema((query, variables) => client.metadata(query, variables), { dryRun });
        ctx.invalidate();
        const count = (s: string) => report.items.filter((i) => i.status === s).length;
        const message = `${dryRun ? "Dry run" : "Done"}: ${count("present")} present, ${dryRun ? `${count("missing")} missing` : `${count("created")} created`}, ${count("skipped")} skipped, ${count("failed")} failed.`;
        return json({ ok: count("failed") === 0, message, report } satisfies ActionResponse);
      },
    ],
  ];

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    for (const [method, pattern, handler] of routes) {
      if (request.method !== method) continue;
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      try {
        return await handler(request, match.slice(1), url);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message, ...err.extra }, err.status);
        return json({ error: (err as Error).message }, 400);
      }
    }
    return json({ error: "Not found." }, 404);
  };
}
