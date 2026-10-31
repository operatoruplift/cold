import { createHash } from "node:crypto";
import {
  aiConfigured,
  aiModel,
  ANGLES,
  draftMessage,
  explainError,
  findProspects,
  prepCall,
  researchProspect,
  TONES,
  triageReply,
  type AiOffer,
  type AiProspect,
  type AiProvider,
  type AiResult,
  type AiRun,
  type AiRunKind,
  type AiSender,
  type AiStore,
  type Angle,
  type FindResult,
  type Research,
  type Tone,
  type Triage,
} from "../../ai";
import { callSheetData } from "../../call";
import { getOffer, type Account, type ColdConfig, type Offer } from "../../config";
import { allowedAngles } from "../../decide";
import { prepareDmRun } from "../../dm";
import { prepareEmailRun } from "../../email";
import { findSequence } from "../../messages";
import { buildVariables, renderForProspect } from "../../outreach";
import { parseCsv, type Prospect } from "../../prospects";
import { twentyClient } from "../../touches";
import { HttpError, json, readBody, type Route } from "../api";
import { keepAlive } from "../background";
import { OWN_LIST, type WebContext } from "../context";
import { chooseStyle, draftStyle, evidenceFor } from "../decide/engine";

export const offerOf = (offer?: Offer): AiOffer => ({
  audience: offer?.variables.audience,
  offer: offer?.variables.offer,
  outcome: offer?.variables.outcome,
  pain: offer?.variables.pain,
  proof: offer?.variables.proof,
});
export const senderOf = (account: Account): AiSender & { phone?: string } => ({
  name: account.variables.sender_name ?? account.variables.sender_first_name,
  company: account.variables.sender_company,
  voice: account.voice,
  phone: account.variables.sender_phone,
});
export const prospectOf = (p: Prospect): AiProspect => ({ name: p.label, ...p.variables });

/** A CSV cell: quoted when it needs to be, and never read as a formula. */
function cell(value: string | undefined): string {
  let s = value ?? "";
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvText = (headers: string[], rows: Array<Record<string, string | undefined>>) =>
  [headers.map(cell).join(","), ...rows.map((r) => headers.map((h) => cell(r[h])).join(","))].join("\n") + "\n";

/** The prospect sources the API accepts, as in the main API. */
export const SOURCE = /^(csv:.+\.csv|twenty:(people|agencyProspects|agencyPeople))$/;
/** Only http(s) links from research reach the page. */
const httpOnly = (urls: string[] | undefined) => (urls ?? []).filter((u) => /^https?:\/\//i.test(u));

const AI_COLUMNS = ["id", "first_name", "last_name", "title", "company", "email", "phone", "website", "city", "trigger", "linkedin_url", "instagram_handle", "facebook_url", "notes", "sources"];
const host = (url?: string | null) => (url ? url.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]!.toLowerCase() : "");

/**
 * Start a run and return at once; the work carries on and lands in the
 * database, where the app picks it up from /api/ai/runs/:id. No request waits
 * on a model, so no proxy in front (Railway's, Vercel's) can time one out.
 */
export async function startRun<T>(
  ai: AiStore,
  kind: AiRunKind,
  subject: string | undefined,
  input: unknown,
  work: (runId: string) => Promise<AiResult<T> & { provider?: AiProvider }>,
  provider: AiProvider = "claude",
): Promise<string> {
  const runId = await ai.start(kind, subject, input, provider);
  keepAlive(
    Promise.resolve()
      .then(() => work(runId))
      .then((result) => ai.finish(runId, result))
      .catch((err) => ai.fail(runId, explainError(err).message))
      .catch((err) => console.error(`AI run ${runId} could not be saved:`, err)),
  );
  return runId;
}

/**
 * The AI routes, all behind the login. Every request to Claude runs in the
 * background: the call returns a run id and the app asks /api/ai/runs/:id
 * until it is done (a web search takes minutes, a draft seconds). Nothing here
 * sends anything: drafts wait for your approval, and the existing caps,
 * windows and opt-outs still decide what goes out.
 */
export function aiRoutes(ctx: WebContext): Route[] {
  const store = () => {
    if (!ctx.ai) throw new HttpError(500, "The AI features need the app database.");
    return ctx.ai;
  };

  const background = <T>(kind: AiRunKind, subject: string | undefined, input: unknown, work: (runId: string) => Promise<AiResult<T>>) => startRun(store(), kind, subject, input, work);

  async function config(): Promise<ColdConfig> {
    const { config: c, error } = await ctx.config();
    if (!c) throw new HttpError(400, error ?? "cold.yaml has problems.");
    return c;
  }

  function checkSource(source: string | undefined): string {
    if (!source || !SOURCE.test(source)) throw new HttpError(400, "Pick a prospect list: a CSV file or a Twenty source.");
    return source;
  }

  async function prospectFrom(source: string, key: string): Promise<Prospect> {
    if (!key) throw new HttpError(400, "Pick a prospect.");
    checkSource(source);
    const prospect = (await ctx.prospects(source)).find((p) => p.key === key);
    if (!prospect) throw new HttpError(404, "That prospect is not on the list any more. Refresh and pick again.");
    return prospect;
  }

  const research = async (key: string) => (await store().latest<Research>("research", key))?.output;

  /** The due step of a campaign for one prospect, as the template writes it. */
  async function dueMessage(campaignId: string, prospectKey: string) {
    const campaign = await ctx.campaigns.get(campaignId);
    if (!campaign) throw new HttpError(404, "No such campaign.");
    const c = await config();
    const sequence = findSequence((await ctx.library()).library, campaign.sequence);
    if (!sequence) throw new HttpError(400, `There is no sequence "${campaign.sequence}" in the library.`);
    const account = c.accounts[campaign.account];
    if (!account) throw new HttpError(400, `There is no account "${campaign.account}".`);
    const offer = campaign.offer ? c.offers[campaign.offer] : getOffer(c, undefined);
    const prospects = await ctx.prospects(campaign.source, campaign.where);
    const touchStore = await ctx.store(c);
    const plan =
      sequence.channel === "email"
        ? (await prepareEmailRun({ sequence, account, offer, prospects, store: touchStore, now: () => ctx.now() })).plan
        : (await prepareDmRun({ sequence, account, offer, prospects, store: touchStore, now: () => ctx.now() })).plan;
    const item = plan.due.find((d) => d.prospect.key === prospectKey);
    if (!item) throw new HttpError(409, "This prospect has nothing due right now.");
    const { dossier, research: found } = await evidenceFor(ctx, item.prospect.key);
    const variables = buildVariables(account, offer, item.prospect);
    // A researched (or diligence) trigger fills an empty {{trigger}}, so the template has its one true personal line.
    const trigger = found?.best_trigger ?? dossier?.triggers[0]?.sentence;
    if (!variables.trigger && trigger) variables.trigger = trigger;
    const rendered = renderForProspect(item.step, variables, item.prospect.key);
    return { config: c, campaign, sequence, account, offer, item, rendered, research: found, dossier };
  }

  return [
    [
      "GET",
      /^\/api\/ai\/status$/,
      async () => {
        const since = new Date(ctx.now().getTime() - 30 * 86_400_000);
        return json({
          configured: aiConfigured(),
          model: aiModel(),
          usage: await ctx.ai?.usageSince(since),
          finds: ((await ctx.ai?.recent("find", 12)) ?? []).map((r) => ({ id: r.id, status: r.status, input: r.input, createdAt: r.createdAt, found: (r.output as FindResult | undefined)?.prospects?.length ?? 0, error: r.error })),
        });
      },
    ],
    [
      "GET",
      /^\/api\/ai\/runs\/([\w-]+)$/,
      async (_request, [id]) => {
        const found = await store().get(id!);
        return found ? json(found) : json({ error: "No such AI run." }, 404);
      },
    ],
    [
      "POST",
      /^\/api\/ai\/find$/,
      async (request) => {
        const body = await readBody<{ offer?: string; area?: string; count?: number; notes?: string; exclude?: string }>(request);
        const area = body.area?.trim();
        if (!area) throw new HttpError(400, "Say where to look: a city, a region, or online.");
        const c = await config();
        const offer = body.offer ? c.offers[body.offer] : getOffer(c, undefined);
        if (body.offer && !offer) throw new HttpError(400, `There is no offer "${body.offer}".`);
        const exclude: string[] = [];
        if (body.exclude) {
          for (const p of await ctx.prospects(checkSource(body.exclude)).catch(() => [])) {
            if (p.variables.company) exclude.push(p.variables.company);
            if (p.variables.website) exclude.push(host(p.variables.website));
          }
        }
        const call = ctx.claude();
        const count = Math.max(1, Math.min(15, Number(body.count) || 8));
        const input = { offer: offer?.key, area, count, notes: body.notes, exclude: body.exclude };
        const runId = await background("find", area, input, () => findProspects({ call, offer: offerOf(offer), area, count, notes: body.notes, exclude }));
        return json({ runId }, 202);
      },
    ],
    [
      "POST",
      /^\/api\/ai\/prospects\/save$/,
      async (request) => {
        const body = await readBody<{ runId: string; picks: number[]; list?: string }>(request);
        const found = await store().get(body.runId);
        const output = found?.output as FindResult | undefined;
        if (!found || found.kind !== "find" || !output) throw new HttpError(404, "That search is not finished, or does not exist.");
        const picked = (body.picks ?? []).map((i) => output.prospects[i]).filter((p): p is NonNullable<typeof p> => !!p);
        if (!picked.length) throw new HttpError(400, "Pick at least one prospect to save.");
        const slug = (body.list ?? "ai").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "ai";
        const file = `prospects-${slug}.csv`;
        let headers = [...AI_COLUMNS];
        let rows: Array<Record<string, string | undefined>> = [];
        const existing = await ctx.files.read(file);
        if (existing !== undefined) {
          const [head = [], ...rest] = parseCsv(existing);
          headers = [...head, ...AI_COLUMNS.filter((c) => !head.includes(c))];
          rows = rest.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
        }
        const known = new Set(rows.flatMap((r) => [r.company?.toLowerCase(), host(r.website), r.email?.toLowerCase()]).filter(Boolean));
        let added = 0;
        let skipped = 0;
        for (const p of picked) {
          if ([p.company.toLowerCase(), host(p.website), p.email?.toLowerCase()].some((k) => k && known.has(k))) {
            skipped++;
            continue;
          }
          const [first, ...last] = (p.contact_name ?? "").trim().split(/\s+/).filter(Boolean);
          rows.push({
            id: `ai-${createHash("sha1").update(`${p.company}|${host(p.website)}`).digest("hex").slice(0, 10)}`,
            first_name: first,
            last_name: last.join(" ") || undefined,
            title: p.contact_title ?? undefined,
            company: p.company,
            email: p.email ?? undefined,
            phone: p.phone ?? undefined,
            website: p.website ?? undefined,
            city: p.city ?? undefined,
            trigger: p.trigger ?? undefined,
            linkedin_url: p.linkedin_url ?? undefined,
            instagram_handle: p.instagram_handle ?? undefined,
            facebook_url: p.facebook_url ?? undefined,
            notes: p.fit,
            sources: httpOnly(p.verified_sources?.length ? p.verified_sources : p.sources).join(" "),
          });
          [p.company.toLowerCase(), host(p.website), p.email?.toLowerCase()].forEach((k) => k && known.add(k));
          added++;
        }
        await ctx.files.write(file, csvText(headers, rows));
        ctx.invalidate();
        return json({ source: `csv:${file}`, file, added, skipped, total: rows.length });
      },
    ],
    [
      "POST",
      /^\/api\/ai\/research$/,
      async (request) => {
        const body = await readBody<{ source: string; prospect: string; offer?: string }>(request);
        const prospect = await prospectFrom(body.source, body.prospect);
        const c = await config();
        const offer = body.offer ? c.offers[body.offer] : getOffer(c, undefined);
        const call = ctx.claude();
        const runId = await background("research", prospect.key, { source: body.source, prospect: prospect.key, label: prospect.label }, () =>
          researchProspect({ call, offer: offerOf(offer), prospect: prospectOf(prospect) }),
        );
        return json({ runId }, 202);
      },
    ],
    [
      "GET",
      /^\/api\/ai\/research$/,
      async (_request, _params, url) => {
        const keys = (url.searchParams.get("keys") ?? "").split(",").map((k) => k.trim()).filter(Boolean).slice(0, 2000);
        const latest = await store().latestFor<Research>("research", keys);
        return json(Object.fromEntries([...latest].map(([key, r]) => [key, { runId: r.id, createdAt: r.createdAt, output: r.output }])));
      },
    ],
    [
      "POST",
      /^\/api\/ai\/research\/apply$/,
      async (request) => {
        const body = await readBody<{ source: string; prospect: string; trigger: string }>(request);
        const trigger = body.trigger?.replace(/\s+/g, " ").trim();
        if (!trigger) throw new HttpError(400, "There is no trigger to save.");
        const prospect = await prospectFrom(body.source, body.prospect);
        if (body.source.startsWith("csv:")) {
          const { text, path: file } = await ctx.csv(body.source);
          // Only your own lists are written to: never the bundled example, never a file outside your folder.
          if (!file || !OWN_LIST.test(file)) throw new HttpError(400, "Triggers are saved to your own lists (prospects-*.csv). Upload this list or save an AI search as a list, then research it there.");
          const [head = [], ...rest] = parseCsv(text);
          const headers = head.includes("trigger") ? head : [...head, "trigger"];
          const rows = rest.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])) as Record<string, string | undefined>);
          const idColumn = head.find((h) => h.trim().toLowerCase() === "id");
          const index = idColumn && prospect.variables.id ? rows.findIndex((r) => r[idColumn]?.trim() === prospect.variables.id) : Number(prospect.key.split(":").pop()) - 1;
          const target = rows[index] ?? rows.find((r) => r.email?.trim().toLowerCase() === prospect.email);
          if (!target) throw new HttpError(409, "Could not find that row in the CSV. Add the trigger by hand.");
          target.trigger = trigger;
          await ctx.files.write(file, csvText(headers, rows));
        } else if (body.source === "twenty:people" && prospect.links.personId) {
          const client = twentyClient();
          if (!client) throw new HttpError(400, "Twenty is not connected.");
          await client.update("people", prospect.links.personId, { coldTrigger: trigger });
        } else {
          throw new HttpError(400, "Triggers can be saved to CSV lists and Twenty People. Copy it into your list by hand.");
        }
        ctx.invalidate();
        return json({ ok: true, message: `Saved the trigger for ${prospect.label}.` });
      },
    ],
    [
      "POST",
      /^\/api\/ai\/draft$/,
      async (request) => {
        const body = await readBody<{ campaignId: string; prospect: string; tone?: string; angle?: string }>(request);
        if (body.tone && !(TONES as readonly string[]).includes(body.tone)) throw new HttpError(400, `Tone is one of ${TONES.join(", ")}.`);
        if (body.angle && !(ANGLES as readonly string[]).includes(body.angle)) throw new HttpError(400, `Opening is one of ${ANGLES.join(", ")}.`);
        const due = await dueMessage(body.campaignId, body.prospect);
        const { campaign, sequence, account, offer, item, rendered } = due;
        const call = ctx.claude();
        const step = item.step.step ?? 1;
        // The style: yours if you picked one, else the decision engine's pick for this person, now and then something else to learn from.
        const channel = sequence.channel === "email" ? "email" : (sequence.platform ?? "dm");
        const angles = allowedAngles({ offer: offerOf(offer), prospect: item.prospect, dossier: due.dossier, research: due.research });
        const { pick, decision, segment } = await chooseStyle(ctx, { config: due.config, campaign, channel, prospect: item.prospect, allowedAngles: angles, tone: body.tone as Tone | undefined, angle: body.angle as Angle | undefined });
        const runId = await background("draft", `${campaign.id}|${item.prospect.key}|${step}`, { campaign: campaign.id, prospect: item.prospect.key, step, tone: pick.tone, angle: pick.angle }, async (id) => {
          const result = await draftMessage({
            call,
            channel: sequence.channel === "email" ? "email" : "dm",
            sender: senderOf(account),
            offer: offerOf(offer),
            prospect: prospectOf(item.prospect),
            research: due.research,
            template: { subject: rendered.subject, body: rendered.body },
            maxChars: item.step.maxChars,
            threaded: sequence.channel === "email" && !item.first,
            style: draftStyle(pick, decision, due.dossier),
          });
          const out = result.output;
          const draft = await store().saveDraft({ campaignId: campaign.id, prospectKey: item.prospect.key, step, subject: out.subject ?? rendered.subject, body: out.body, status: "draft", runId: id });
          // What it learns from: the draft is still good if this can't be saved.
          await ctx.decisions
            ?.assign({ campaignId: campaign.id, prospectKey: item.prospect.key, step, sequence: sequence.id, segment, tone: pick.tone, angle: pick.angle, pickedBy: pick.pickedBy, score: decision?.score, tier: decision?.tier })
            .catch((err) => console.error("Could not record the draft's style:", err));
          return {
            ...result,
            output: {
              draft,
              changes: out.changes,
              personalLine: out.personal_line,
              template: { subject: rendered.subject, body: rendered.body, missing: rendered.missing },
              researched: !!(due.research || due.dossier),
              style: { tone: pick.tone, angle: pick.angle, pickedBy: pick.pickedBy, why: pick.why },
              score: decision ? { score: decision.score, tier: decision.tier } : undefined,
            },
          };
        });
        return json({ runId }, 202);
      },
    ],
    [
      "GET",
      /^\/api\/ai\/drafts$/,
      async (_request, _params, url) => json(await store().drafts(url.searchParams.get("campaignId") ?? "")),
    ],
    [
      "PUT",
      /^\/api\/ai\/drafts$/,
      async (request) => {
        const body = await readBody<{ campaignId: string; prospect: string; step: number; subject?: string; body: string; status: "draft" | "approved" }>(request);
        if (!(await ctx.campaigns.get(body.campaignId))) throw new HttpError(404, "No such campaign.");
        const text = (body.body ?? "").trim();
        if (!text) throw new HttpError(400, "The message is empty.");
        if (/\{\{|\}\}/.test(`${body.subject ?? ""} ${text}`)) throw new HttpError(400, "The message still has a {{variable}} in it. Replace it with real words.");
        if (body.status !== "draft" && body.status !== "approved") throw new HttpError(400, "Status is draft or approved.");
        const step = Number(body.step) || 1;
        const saved = await store().saveDraft({ campaignId: body.campaignId, prospectKey: body.prospect, step, subject: body.subject?.trim() || undefined, body: text, status: body.status });
        // Only an approved draft goes out, so only then does its style count for learning.
        await ctx.decisions?.approve(body.campaignId, body.prospect, step, body.status === "approved");
        return json(saved);
      },
    ],
    [
      "DELETE",
      /^\/api\/ai\/drafts$/,
      async (_request, _params, url) => {
        const p = url.searchParams;
        const [campaignId, prospect, step] = [p.get("campaignId") ?? "", p.get("prospect") ?? "", Number(p.get("step")) || 1];
        await ctx.decisions?.unassign(campaignId, prospect, step);
        return json({ ok: await store().deleteDraft(campaignId, prospect, step) });
      },
    ],
    [
      "POST",
      /^\/api\/ai\/call$/,
      async (request) => {
        const body = await readBody<{ script: string; source?: string; prospect?: string; account?: string; offer?: string }>(request);
        const c = await config();
        const library = (await ctx.library()).library;
        const script = library.callScripts.find((s) => s.id === body.script);
        if (!script) throw new HttpError(404, "No such call script.");
        const account = Object.values(c.accounts).find((a) => (body.account ? a.key === body.account : a.voice === script.voice));
        if (!account) throw new HttpError(400, `There is no ${script.voice} account in cold.yaml for this script.`);
        const offer = body.offer ? c.offers[body.offer] : getOffer(c, undefined);
        const prospect = body.source && body.prospect ? await prospectFrom(body.source, body.prospect) : undefined;
        const sheet = callSheetData(script, library, account, offer, prospect);
        const call = ctx.claude();
        const known = prospect ? await research(prospect.key) : undefined;
        const runId = await background("call", prospect?.key ?? script.id, { script: script.id, prospect: prospect?.key }, async () => {
          const result = await prepCall({
            call,
            sender: senderOf(account),
            offer: offerOf(offer),
            prospect: prospect ? prospectOf(prospect) : {},
            research: known,
            script: { title: sheet.title, sections: sheet.sections, objections: sheet.objections },
          });
          return { ...result, output: { prep: result.output, researched: !!known } };
        });
        return json({ runId }, 202);
      },
    ],
    [
      "POST",
      /^\/api\/ai\/triage$/,
      async (request) => {
        const body = await readBody<{ messageId?: string; prospectKey: string; prospectLabel?: string; subject?: string; body: string; account?: string }>(request);
        const text = (body.body ?? "").trim();
        if (!text) throw new HttpError(400, "There is no reply text to read.");
        const c = await config();
        const account = (body.account && c.accounts[body.account]) || Object.values(c.accounts)[0];
        if (!account) throw new HttpError(400, "cold.yaml has no accounts.");
        const subject = body.messageId || createHash("sha1").update(text).digest("hex");
        const call = ctx.claude();
        const runId = await background<Triage>("triage", subject, { prospect: body.prospectKey, messageId: body.messageId }, () =>
          triageReply({ call, sender: senderOf(account), offer: offerOf(getOffer(c, undefined)), prospect: { name: body.prospectLabel ?? body.prospectKey }, reply: { subject: body.subject, body: text } }),
        );
        return json({ runId, id: subject }, 202);
      },
    ],
    [
      "GET",
      /^\/api\/ai\/triage$/,
      async (_request, _params, url) => {
        const ids = (url.searchParams.get("ids") ?? "").split(",").map((k) => k.trim()).filter(Boolean).slice(0, 1000);
        const latest = await store().latestFor<Triage>("triage", ids);
        return json(Object.fromEntries([...latest].map(([id, r]) => [id, r.output])));
      },
    ],
    [
      "POST",
      /^\/api\/ai\/opt-out$/,
      async (request) => {
        const body = await readBody<{ prospectKey: string; prospectLabel?: string; account?: string; sequence?: string; address?: string }>(request);
        if (!body.prospectKey) throw new HttpError(400, "Which prospect?");
        const touchStore = await ctx.store(await config());
        await touchStore.record({
          kind: "OPTED_OUT",
          channel: "EMAIL",
          account: body.account,
          sequence: body.sequence,
          prospectKey: body.prospectKey,
          prospectLabel: body.prospectLabel,
          toAddress: body.address,
          body: "Recorded from the inbox: they asked not to be contacted.",
          occurredAt: ctx.now().toISOString(),
        });
        return json({ ok: true, message: `${body.prospectLabel ?? body.prospectKey} won't be contacted again on any channel.` });
      },
    ],
  ];
}

export type { AiRun };
