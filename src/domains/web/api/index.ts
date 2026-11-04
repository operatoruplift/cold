import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { callSheetData, syncCallScripts } from "../../call";
import type { Io } from "../../cli/io";
import { APP_ROOT, getOffer, offerKeyOf, parseConfig, type Account, type ColdConfig, type Offer } from "../../config";
import type { Decision } from "../../decide";
import { dmChecklist, prepareDmRun, recordDmOutcome, type DmOutcome } from "../../dm";
import { describeWindow, prepareEmailRun, smtpTransport, syncReplies, testImap, toSendPlan, type EmailOverride } from "../../email";
import { findMessage, findSequence, lintMessage, lintSequences, toMessage, toSequences, type Library, type Message } from "../../messages";
import { buildVariables, renderForProspect } from "../../outreach";
import { findProspect, parseCsv, PROSPECT_SOURCE, type Prospect } from "../../prospects";
import { renderTemplate, VARIABLES } from "../../render";
import { summarize } from "../../stats";
import { TOUCH_KINDS, twentyClient, type Touch } from "../../touches";
import { applySchema, readLiveSchema, twentyConfigFromEnv } from "../../twenty";
import { handleOf, repliesIn, withXToken, XApiError, xUserIdOf, type XClient, type XDmEvent, type XStore } from "../../xApi";
import { draftKey } from "../../ai";
import { invocationDeadline, keepAlive } from "../background";
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
  XSendResponse,
  XSendState,
} from "../types";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const MESSAGE_ID = /^(email|dm)\/(personal|company)\/[a-z0-9]+(?:-[a-z0-9]+)*\/\d+-[a-z0-9]+(?:-[a-z0-9]+)*$|^call\/(personal|company)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE = PROSPECT_SOURCE;
const ANSI = /\x1b\[[0-9;]*m/g;

export async function readBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "The request body must be JSON.");
  }
}

/**
 * X's refusal as an HTTP answer that says what to do next. Never 401: to the
 * app a 401 means you were signed out of cold, not that X needs reconnecting.
 */
export function xHttpError(err: unknown): unknown {
  if (!(err instanceof XApiError)) return err;
  const status = err.kind === "rateLimited" ? 429 : err.kind === "notFound" ? 404 : err.kind === "other" ? 502 : 409;
  return new HttpError(status, err.message);
}

/** The X store, X's API and cold.yaml, or a refusal that says which is missing. */
export async function xTools(ctx: WebContext): Promise<{ store: XStore; client: XClient; config: ColdConfig }> {
  if (!ctx.x) throw new HttpError(409, "Sending X DMs needs the app's database, which this server doesn't have.");
  const client = ctx.xClient();
  if (!client) throw new HttpError(409, "Set up X first: add your X developer app's X_CLIENT_ID (and X_CLIENT_SECRET) in Settings.");
  const { config, error, isExample } = await ctx.config();
  if (!config) throw new HttpError(400, error ?? "cold.yaml has problems.");
  if (isExample) throw new HttpError(409, "cold.yaml does not exist yet: create it in Settings, so X is connected to your own account.");
  return { store: ctx.x, client, config };
}

/** They answered on X since cold's last DM, so the next one is not sent. */
class RepliedOnX extends Error {
  constructor(readonly reply: XDmEvent) {
    super("They replied on X.");
  }
}

/** One API route: method, path pattern (its groups become params), handler. */
export type Route = [string, RegExp, (request: Request, params: string[], url: URL) => Promise<Response> | Response];

/** An Io that keeps what a runner prints, without terminal colours. */
function collectingIo(): Io & { lines: string[] } {
  const lines: string[] = [];
  return { interactive: false, lines, log: (line = "") => void lines.push(line.replace(ANSI, "")), confirm: async () => false, choose: async () => "q" };
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
  fields.set("ANTHROPIC_API_KEY", "For the AI features: finding and researching prospects, drafts, call prep, reply triage (console.anthropic.com, API keys)");
  fields.set("TYPESAFE_API_KEY", "Optional: Jev, TypeSafe's decision model, scores prospects and picks their tone. Without it Claude does (typesafe.ai)");
  fields.set("SUBQ_API_KEY", "Optional: SubQ, Subquadratic's long-context model, reads a prospect's whole site for diligence. Without it Claude does (subq.ai)");
  fields.set("REACHER_URL", "Optional: a self-hosted Reacher, e.g. http://localhost:8080");
  fields.set("REACHER_SECRET", "Optional: Reacher's header secret");
  fields.set("X_CLIENT_ID", "Optional: your X developer app's OAuth 2.0 Client ID, so X DMs go out from cold through X's API (developer.x.com). Then Connect X below");
  fields.set("X_CLIENT_SECRET", "Optional: that app's OAuth 2.0 Client Secret (a Web App; leave it empty for a Native App)");
  fields.set("COLD_LISTEN_SECRET", "Optional: a long random string. OpenMagpie's webhook action sends it as Authorization: Bearer <it>, so its matches come in as prospects");
  fields.set("COLD_NTFY_URL", "Optional: an ntfy topic's address, e.g. https://ntfy.sh/cold-leads-7f3k2q, for a push to your phone when a quiz lead comes in. The push carries the lead's name and number: pick a long random topic, or your own ntfy server with a token");
  fields.set("COLD_NTFY_TOKEN", "Optional: an ntfy access token (tk_...), for a topic that needs one");
  return [...fields.entries()].map(([name, hint]) => ({ name, set: !!process.env[name]?.trim(), hint }));
}

export function createApi(ctx: WebContext, extraRoutes: Route[] = []): (request: Request) => Promise<Response> {
  async function campaignOr404(id: string): Promise<Campaign> {
    const campaign = await ctx.campaigns.get(id);
    if (!campaign) throw new HttpError(404, "No such campaign.");
    return campaign;
  }

  async function loadedConfig(): Promise<{ config: ColdConfig; isExample: boolean }> {
    const { config, error, isExample } = await ctx.config();
    if (!config) throw new HttpError(400, error ?? "cold.yaml has problems.");
    return { config, isExample };
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

  async function validateCampaign(input: Partial<CampaignInput>): Promise<CampaignInput> {
    const campaign: CampaignInput = {
      name: (input.name ?? "").trim(),
      sequence: (input.sequence ?? "").trim(),
      account: (input.account ?? "").trim(),
      offer: input.offer?.trim() || undefined,
      source: (input.source ?? "").trim(),
      where: input.where?.trim() || undefined,
      order: input.order === "score" ? "score" : undefined,
    };
    if (!campaign.name) throw new HttpError(400, "Give the campaign a name.");
    if (!SOURCE.test(campaign.source)) throw new HttpError(400, "Pick a prospect list: a CSV file or a Twenty source.");
    if (campaign.where && !campaign.source.startsWith("twenty:")) throw new HttpError(400, "A Twenty filter only applies to a Twenty source.");
    resolveCampaign(campaign, (await ctx.library()).library, await ctx.requireConfig());
    return campaign;
  }

  /**
   * A campaign's prospects with the decision engine's latest call on each, for
   * the campaign's offer. When it goes by score, the highest come first, so a
   * daily cap that can't reach everyone reaches the most promising; anyone not
   * scored yet follows in list order.
   */
  async function scored(campaign: Campaign, config: ColdConfig, prospects: Prospect[]): Promise<{ prospects: Prospect[]; scores: Map<string, Decision> }> {
    const scores = (await ctx.decisions?.forProspects(prospects.map((p) => p.key), offerKeyOf(config, campaign.offer))) ?? new Map<string, Decision>();
    if (campaign.order !== "score" || !scores.size) return { prospects, scores };
    const ranked = prospects.map((p, i) => ({ p, i, score: scores.get(p.key)?.score ?? -1 })).sort((a, b) => b.score - a.score || a.i - b.i);
    return { prospects: ranked.map((r) => r.p), scores };
  }

  async function plan(campaign: Campaign, refresh: boolean): Promise<PlanResponse> {
    const { config, isExample } = await loadedConfig();
    const { sequence, account, offer } = resolveCampaign(campaign, (await ctx.library()).library, config);
    const store = await ctx.store(config);
    const { prospects, scores } = await scored(campaign, config, await ctx.prospects(campaign.source, campaign.where, refresh));
    const row = (prospect: Prospect, extra: Omit<PlanRow, "key" | "label"> = {}): PlanRow => {
      const d = scores.get(prospect.key);
      return { key: prospect.key, label: prospect.label, ...extra, ...(d ? { score: d.score, tier: d.tier, action: d.action } : {}) };
    };
    const now = () => ctx.now();
    const blockers: string[] = [];
    if (isExample) blockers.push("cold.yaml does not exist yet, so these would go out as the example sender. Create it in Settings.");

    if (sequence.channel === "email") {
      const prepared = await prepareEmailRun({ sequence, account, offer, prospects, store, now, override: await emailOverride(campaign) });
      const email = account.email!;
      if (!process.env[email.smtpUrlEnv]?.trim()) blockers.push(`The mailbox is not connected: set ${email.smtpUrlEnv} in Settings.`);
      if (prepared.batch.length === 0 && prepared.ready.length > 0) blockers.push(`The daily cap of ${prepared.dailyCap} is used up for today.`);
      return {
        campaign,
        channel: "email",
        sequence: { id: sequence.id, steps: sequence.steps.length },
        account: { key: account.key, voice: account.voice, from: email.from },
        prospects: prospects.length,
        due: prepared.ready.map((r) => row(r.prospect, { address: r.address, step: r.step.step, stepTitle: r.step.title, when: r.step.when, subject: r.draft.subject, text: r.draft.text, custom: r.custom })),
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

    const prepared = await withDmDrafts(await prepareDmRun({ sequence, account, offer, prospects, store, now }), campaign);
    if (prepared.batch.length === 0 && prepared.queue.length > 0) blockers.push(`The daily cap of ${prepared.cap} on this platform is used up for today.`);
    return {
      campaign,
      channel: "dm",
      platform: prepared.platform,
      sequence: { id: sequence.id, steps: sequence.steps.length },
      account: { key: account.key, voice: account.voice },
      prospects: prospects.length,
      due: prepared.queue.map((q) => row(q.prospect, { address: q.url, url: q.url, step: q.step.step, stepTitle: q.step.title, when: q.step.when, text: q.text, custom: (q as { custom?: boolean }).custom })),
      held: prepared.held.map((h) => row(h.prospect, { step: h.step.step, stepTitle: h.step.title, reason: h.reason })),
      waiting: prepared.plan.waiting.map((w) => row(w.prospect, { step: w.step.step, stepTitle: w.step.title, dueOn: w.dueOn })),
      skipped: prepared.plan.skipped.map((s) => row(s.prospect, { reason: s.reason })),
      cap: prepared.cap,
      sentToday: prepared.sentToday,
      sendable: prepared.batch.length,
      blockers,
      x: prepared.platform === "x" ? await xSendState(account.key) : undefined,
    };
  }

  /** Whether an account can send X DMs through X's API, and if not, why. */
  async function xSendState(account: string): Promise<XSendState> {
    if (!ctx.x) return { ready: false, why: "This server has no database to keep an X sign-in." };
    if (!ctx.xClient()) return { ready: false, why: "Add your X developer app in Settings to send from here." };
    const connected = (await ctx.x.accounts()).find((a) => a.account === account);
    return connected ? { ready: true, username: connected.username } : { ready: false, why: `Connect X for ${account} in Settings to send from here.` };
  }

  /** Approved AI drafts replace the template's words for that prospect's step. */
  const emailOverride = async (campaign: Campaign): Promise<EmailOverride | undefined> => {
    if (!ctx.ai) return undefined;
    const approved = await ctx.ai.approved(campaign.id);
    return (prospect, step) => {
      const draft = approved.get(draftKey(prospect.key, step.step ?? 1));
      return draft ? { subject: draft.subject, body: draft.body } : undefined;
    };
  };
  const withDmDrafts = async <T extends { queue: Array<{ prospect: { key: string }; step: { step?: number }; text: string; custom?: boolean }> }>(prepared: T, campaign: Campaign): Promise<T> => {
    const approved = (await ctx.ai?.approved(campaign.id)) ?? new Map();
    for (const item of prepared.queue) {
      const draft = approved.get(draftKey(item.prospect.key, item.step.step ?? 1));
      if (draft) Object.assign(item, { text: draft.body, custom: true });
    }
    return prepared;
  };

  const routes: Route[] = [
    [
      "GET",
      /^\/api\/status$/,
      async () => {
        const { config, error, file, isExample } = await ctx.config();
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
          configFile: file,
          storage: ctx.storage,
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
      async () => {
        const { library, issues } = await ctx.library();
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
      async (_request, _params, url) => {
        const id = url.searchParams.get("id") ?? "";
        if (!MESSAGE_ID.test(id)) throw new HttpError(400, "Not a message id.");
        const source = await ctx.files.read(`messages/${id}.md`);
        if (source === undefined) throw new HttpError(404, `No message ${id}.`);
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
        const file = `messages/${id}.md`;
        if ((await ctx.files.read(file)) === undefined) throw new HttpError(404, `No message ${id}: new messages are added as files.`);
        const { message, issues } = toMessage(`${id}.md`, source ?? "", `messages/${id}.md`);
        const all = message ? [...issues, ...lintMessage(message)] : issues;
        if (message?.sequence) {
          const { library } = await ctx.library();
          const siblings = library.messages.filter((m) => m.sequence === message.sequence && m.id !== message.id);
          all.push(...lintSequences(toSequences([...siblings, message])).filter((i) => i.level === "error"));
        }
        if (all.some((i) => i.level === "error")) throw new HttpError(422, "Not saved: fix the errors first.", { issues: all });
        await ctx.files.write(file, source.endsWith("\n") ? source : `${source}\n`);
        ctx.invalidate();
        return json({ ok: true, issues: all });
      },
    ],
    [
      "POST",
      /^\/api\/preview$/,
      async (request) => {
        const input = await readBody<{ id: string; template?: string; account?: string; offer?: string; source?: string; where?: string; prospect?: string }>(request);
        const config = await ctx.requireConfig();
        const { library } = await ctx.library();
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
      async () => {
        const sources: SourceOption[] = [];
        for (const f of await ctx.ownLists()) sources.push({ id: `csv:${f}`, label: f, kind: "csv" });
        if (existsSync(path.join(APP_ROOT, "examples/prospects.csv"))) sources.push({ id: "csv:examples/prospects.csv", label: "examples/prospects.csv (5 fictional prospects)", kind: "csv" });
        if (twentyConfigFromEnv()) {
          sources.push({ id: "twenty:people", label: "Twenty: People", kind: "twenty" });
          sources.push({ id: "twenty:agencyProspects", label: "Twenty: dialer prospects (businesses)", kind: "twenty" });
          sources.push({ id: "twenty:agencyPeople", label: "Twenty: people at dialer prospects", kind: "twenty" });
          sources.push({ id: "twenty:agencyLeads", label: "Twenty: quiz leads from offer", kind: "twenty" });
        }
        const watches = (await ctx.listening?.watches()) ?? [];
        if (watches.length > 1) sources.push({ id: "listen:all", label: `Listening: every watch (${watches.reduce((n, w) => n + w.count, 0)} matches)`, kind: "listen" });
        for (const w of watches) sources.push({ id: `listen:${w.id}`, label: `Listening: ${w.name} (${w.count} ${w.count === 1 ? "match" : "matches"})`, kind: "listen" });
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
        await ctx.files.write(file, content);
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
          trigger: p.variables.trigger,
          company: p.variables.company,
          city: p.variables.city,
          website: p.variables.website,
        }));
        return json({ total: prospects.length, prospects: summaries });
      },
    ],
    ["GET", /^\/api\/campaigns$/, async () => json(await ctx.campaigns.list())],
    [
      "POST",
      /^\/api\/campaigns$/,
      async (request) => json(await ctx.campaigns.create(await validateCampaign(await readBody<CampaignInput>(request)), ctx.now()), 201),
    ],
    [
      "PUT",
      /^\/api\/campaigns\/([\w-]+)$/,
      async (request, [id]) => {
        await campaignOr404(id!);
        return json(await ctx.campaigns.update(id!, await validateCampaign(await readBody<CampaignInput>(request))));
      },
    ],
    [
      "DELETE",
      /^\/api\/campaigns\/([\w-]+)$/,
      async (_request, [id]) => {
        if (!(await ctx.campaigns.remove(id!))) throw new HttpError(404, "No such campaign.");
        return json({ ok: true });
      },
    ],
    ["GET", /^\/api\/campaigns\/([\w-]+)\/plan$/, async (_request, [id], url) => json(await plan(await campaignOr404(id!), url.searchParams.get("refresh") === "1"))],
    [
      "POST",
      /^\/api\/campaigns\/([\w-]+)\/send$/,
      async (request, [id]) => {
        const campaign = await campaignOr404(id!);
        const { ignoreWindow = false, limit } = await readBody<{ ignoreWindow?: boolean; limit?: number }>(request);
        const { config, isExample } = await loadedConfig();
        if (isExample) throw new HttpError(409, "cold.yaml does not exist yet, so this would send as the example sender. Create it in Settings first.");
        const { sequence, account, offer } = resolveCampaign(campaign, (await ctx.library()).library, config);
        if (sequence.channel !== "email") throw new HttpError(400, "DMs are sent by you: work through them on the campaign page.");
        if (!ctx.options.transport && !process.env[account.email!.smtpUrlEnv]?.trim()) throw new HttpError(409, `The mailbox is not connected: set ${account.email!.smtpUrlEnv} in Settings.`);
        const sends = ctx.sends;
        if (!sends) throw new HttpError(500, "Sending needs the app's database.");
        if (await sends.running(account.key)) throw new HttpError(409, `Already sending from ${account.key}. Wait for it to finish, or stop it.`);
        const store = await ctx.store(config);
        const { prospects } = await scored(campaign, config, await ctx.prospects(campaign.source, campaign.where));
        const prepared = await prepareEmailRun({ sequence, account, offer, prospects, store, limit: typeof limit === "number" && limit > 0 ? limit : undefined, now: () => ctx.now(), override: await emailOverride(campaign) });
        if (prepared.batch.length === 0) throw new HttpError(409, "Nothing to send right now.");
        if (prepared.windowOpen === false && !ignoreWindow) throw new HttpError(409, `Outside the sending window (${prepared.windowText}). Tick "Send anyway" to override.`);
        let job: string;
        try {
          job = await sends.start(account.key, toSendPlan(prepared), ignoreWindow);
        } catch (err) {
          throw new HttpError(409, (err as Error).message);
        }
        // The first email goes now; the rest follow as their pauses come up.
        keepAlive(sends.tick({ deadline: invocationDeadline() }).catch((err) => console.error("send:", err)));
        return json({ job, total: prepared.batch.length }, 202);
      },
    ],
    [
      "GET",
      /^\/api\/jobs\/([\w-]+)$/,
      async (_request, [id], url) => {
        const view = await ctx.sends?.view(id!, Number(url.searchParams.get("after") ?? 0) || 0);
        if (!view) throw new HttpError(404, "No such send.");
        return json(view);
      },
    ],
    [
      "POST",
      /^\/api\/jobs\/([\w-]+)\/stop$/,
      async (_request, [id]) => {
        const sends = ctx.sends;
        const ok = !!sends && (await sends.stop(id!));
        // A send waiting for its next email ends now, rather than when that email was due.
        if (ok) keepAlive(sends!.tick({ deadline: invocationDeadline() }).catch((err) => console.error("send:", err)));
        return json({ ok });
      },
    ],
    [
      "POST",
      /^\/api\/campaigns\/([\w-]+)\/dm$/,
      async (request, [id]) => {
        const campaign = await campaignOr404(id!);
        const { prospect, outcome } = await readBody<{ prospect: string; outcome: DmOutcome }>(request);
        if (!["SENT", "REPLIED", "OPTED_OUT"].includes(outcome)) throw new HttpError(400, "The outcome is SENT, REPLIED or OPTED_OUT.");
        const { config, isExample } = await loadedConfig();
        if (isExample) throw new HttpError(409, "cold.yaml does not exist yet: create it in Settings so DMs are signed and logged as you.");
        const { sequence, account, offer } = resolveCampaign(campaign, (await ctx.library()).library, config);
        const store = await ctx.store(config);
        const prepared = await withDmDrafts(await prepareDmRun({ sequence, account, offer, prospects: await ctx.prospects(campaign.source, campaign.where), store, now: () => ctx.now() }), campaign);
        const item = prepared.queue.find((q) => q.prospect.key === prospect);
        if (!item) throw new HttpError(409, "That DM is no longer due. Refresh the page.");
        if (outcome === "SENT" && !prepared.batch.includes(item)) throw new HttpError(409, `The daily cap of ${prepared.cap} is used up for today.`);
        await recordDmOutcome(store, prepared, item, outcome, ctx.now());
        return json({ ok: true });
      },
    ],
    [
      "POST",
      /^\/api\/campaigns\/([\w-]+)\/dm\/x$/,
      async (request, [id]) => {
        // One approved X DM, sent by the owner's click through X's API from their own account.
        const campaign = await campaignOr404(id!);
        const { prospect } = await readBody<{ prospect: string }>(request);
        const { store: x, client, config } = await xTools(ctx);
        const { sequence, account, offer } = resolveCampaign(campaign, (await ctx.library()).library, config);
        if (sequence.channel !== "dm" || sequence.platform !== "x") throw new HttpError(400, "Only X DMs go out through X's API. On other platforms, copy the message and send it yourself.");
        const store = await ctx.store(config);
        const prepared = await withDmDrafts(await prepareDmRun({ sequence, account, offer, prospects: await ctx.prospects(campaign.source, campaign.where), store, now: () => ctx.now() }), campaign);
        const item = prepared.queue.find((q) => q.prospect.key === prospect);
        if (!item) throw new HttpError(409, "That DM is no longer due. Refresh the page.");
        if (!prepared.batch.includes(item)) throw new HttpError(409, `The daily cap of ${prepared.cap} is used up for today.`);
        const handle = handleOf(item.prospect.xHandle ?? item.url);
        if (!handle) throw new HttpError(400, `${item.prospect.label} has no X handle cold can read: fix it in the list.`);

        const key = { account: account.key, prospectKey: item.prospect.key, sequence: sequence.id, step: item.step.step ?? 1 };
        const held = await x.claim(key);
        if (held) throw new HttpError(409, held.status === "SENT" ? `This step already went out on X at ${held.at.slice(0, 16).replace("T", " ")} UTC. If it isn't logged yet, press "I sent it".` : "This DM is being sent right now: wait a moment, then refresh.");

        let eventId: string;
        try {
          eventId = await withXToken(x, client, account.key, () => ctx.now(), async (token, connection) => {
            const userId = await xUserIdOf(x, client, token, handle);
            if (item.previous) {
              // A follow-up: never send it to someone who has answered since.
              const events = await client.dmEvents(token, { participantId: userId, limit: 100 });
              const reply = repliesIn(events, { me: connection.userId, awaiting: new Map([[userId, { userId, sentAt: item.previous.occurredAt }]]), logged: new Set() })[0];
              if (reply) throw new RepliedOnX(reply);
            }
            return (await client.sendDm(token, userId, item.text)).eventId;
          });
        } catch (err) {
          await x.release(key);
          if (err instanceof RepliedOnX) {
            await recordDmOutcome(store, prepared, item, "REPLIED", new Date(err.reply.createdAt), { messageId: err.reply.id, body: err.reply.text });
            return json({ ok: true, outcome: "REPLIED", message: `${item.prospect.label} replied on X, so nothing was sent: the reply is logged and their sequence stops.` } satisfies XSendResponse);
          }
          throw xHttpError(err);
        }
        await x.markSent(key, eventId);
        try {
          await recordDmOutcome(store, prepared, item, "SENT", ctx.now(), { messageId: eventId });
        } catch (err) {
          throw new HttpError(502, `Sent on X to @${handle}, but logging it failed (${(err as Error).message}). Press "I sent it" to log it.`);
        }
        return json({ ok: true, outcome: "SENT", message: `Sent on X to @${handle}.` } satisfies XSendResponse);
      },
    ],
    [
      "GET",
      /^\/api\/campaigns\/([\w-]+)\/checklist$/,
      async (_request, [id]) => {
        const campaign = await campaignOr404(id!);
        const config = await ctx.requireConfig();
        const { sequence, account, offer } = resolveCampaign(campaign, (await ctx.library()).library, config);
        if (sequence.channel !== "dm") throw new HttpError(400, "Checklists are for DM campaigns.");
        const prepared = await withDmDrafts(await prepareDmRun({ sequence, account, offer, prospects: await ctx.prospects(campaign.source, campaign.where), store: await ctx.store(config), now: () => ctx.now() }), campaign);
        return new Response(dmChecklist(prepared, ctx.now()), {
          headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${campaign.name.replace(/[^\w-]+/g, "-")}-dms.md"`, "cache-control": "no-store" },
        });
      },
    ],
    [
      "GET",
      /^\/api\/calls\/sheet$/,
      async (_request, _params, url) => {
        const config = await ctx.requireConfig();
        const { library } = await ctx.library();
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
        return json(callSheetData(script, library, account, offer, prospect, { hours: config.calls, now: ctx.now() }));
      },
    ],
    [
      "POST",
      /^\/api\/calls\/sync$/,
      async (request) => {
        const input = await readBody<{ account?: string; offer?: string; campaign?: string; dryRun?: boolean }>(request);
        const { config, isExample } = await loadedConfig();
        if (isExample && !input.dryRun) throw new HttpError(409, "cold.yaml does not exist yet, so the scripts would carry the example sender. Create it in Settings first.");
        const client = twentyClient();
        if (!client) throw new HttpError(409, "Connect Twenty in Settings first: call scripts sync into the dialer's agencyScripts.");
        const io = collectingIo();
        const accounts = input.account ? [config.accounts[input.account]].filter((a): a is Account => !!a) : Object.values(config.accounts);
        let created = 0;
        let updated = 0;
        const { library } = await ctx.library();
        for (const account of accounts) {
          io.log(`${account.key} (${account.voice})`);
          const result = await syncCallScripts({ client, library, account, offer: input.offer ? config.offers[input.offer] : getOffer(config, undefined), campaign: input.campaign || undefined, dryRun: !!input.dryRun, io });
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
        const config = await ctx.requireConfig();
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
        const config = await ctx.requireConfig();
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
        const config = await ctx.requireConfig();
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
      async () => {
        const { text: yaml, exists, file } = await ctx.configText();
        const { config, error } = await ctx.config();
        const response: SettingsResponse = {
          configFile: exists ? file : "cold.yaml",
          exists,
          yaml,
          errors: error ? error.split("\n").map((l) => l.replace(/^\s*-\s*/, "")).filter(Boolean) : [],
          env: envFields(config),
          secretsWhere: ctx.secrets?.where,
          storage: ctx.storage,
        };
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
        const where = await ctx.saveConfig(yaml);
        return json({ ok: true, message: `Saved ${where}.` } satisfies ActionResponse);
      },
    ],
    [
      "PUT",
      /^\/api\/settings\/env$/,
      async (request) => {
        const { values } = await readBody<{ values: Record<string, string> }>(request);
        if (!ctx.secrets) throw new HttpError(409, "This server cannot save keys. Set them in its environment instead.");
        const allowed = new Set(envFields((await ctx.config()).config).map((f) => f.name));
        const clean: Record<string, string> = {};
        for (const [name, value] of Object.entries(values ?? {})) {
          if (!allowed.has(name)) throw new HttpError(400, `${name} is not a setting cold uses.`);
          if (typeof value !== "string" || /[\r\n]/.test(value)) throw new HttpError(400, `${name} must be a single line.`);
          clean[name] = value.trim();
        }
        await ctx.secrets.save(clean);
        ctx.invalidate();
        return json({ ok: true, message: `Saved ${Object.keys(clean).length} setting${Object.keys(clean).length === 1 ? "" : "s"} to ${ctx.secrets.where}.` } satisfies ActionResponse);
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
          const account = (await ctx.requireConfig()).accounts[key ?? ""];
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
      async () => {
        const current = await ctx.configText();
        if (current.exists) throw new HttpError(409, `${current.file} already exists.`);
        const where = await ctx.saveConfig(readFileSync(path.join(APP_ROOT, "cold.example.yaml"), "utf8"));
        return json({ ok: true, message: `Created ${where} from the example. Now put your own details in it.` } satisfies ActionResponse);
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

  routes.push(...extraRoutes);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    await ctx.freshen();
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
