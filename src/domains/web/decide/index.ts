import { aiConfigured, aiModel, explainError } from "../../ai";
import { DEFAULT_DECIDE, getOffer, offerKeyOf, type ColdConfig } from "../../config";
import {
  buildInsights,
  collectSite,
  combine,
  decisionState,
  diligenceWithClaude,
  diligenceWithSubq,
  jevConfigured,
  jevProvider,
  outboundQuestions,
  subqConfigured,
  subqReader,
  type Decision,
  type DecisionInput,
} from "../../decide";
import type { Prospect } from "../../prospects";
import { HttpError, json, readBody, type Route } from "../api";
import { offerOf, prospectOf, senderOf, SOURCE, startRun } from "../ai";
import type { WebContext } from "../context";
import type { DecideStatusResponse, ProspectDecisionResponse, ScoresResponse, ScoreSummary } from "../types";
import { evidenceFor, resolveLearning } from "./engine";

export { chooseStyle, draftStyle, evidenceFor } from "./engine";

/** Free mailbox providers: their domain is not the business's website. */
const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|zoho|yandex|fastmail|hey)\./i;

/** A prospect's website: the list's, else their email's domain when it's a business address. */
export function websiteOf(prospect: Prospect): string | undefined {
  const listed = prospect.variables.website?.trim();
  if (listed) return listed;
  const email = prospect.email?.trim();
  return email && !FREE_MAIL.test(email) && email.includes("@") ? `https://${email.split("@")[1]}` : undefined;
}

const summary = (d: Decision): ScoreSummary => ({
  score: d.score,
  tier: d.tier,
  action: d.action,
  review: d.review,
  tone: d.style.tone,
  angle: d.style.angle,
  need: d.needs[0],
  evidence: d.evidence,
  provider: d.provider,
  decidedAt: d.decidedAt,
});

/**
 * The decision engine's routes, all behind the login. Diligence and scoring
 * run in the background like the other AI runs: the call returns a run id and
 * the app follows /api/ai/runs/:id. Nothing here contacts a prospect.
 */
export function decideRoutes(ctx: WebContext): Route[] {
  const stores = () => {
    if (!ctx.ai || !ctx.decisions) throw new HttpError(500, "The decision engine needs the app database.");
    return { ai: ctx.ai, decisions: ctx.decisions };
  };

  async function config(): Promise<ColdConfig> {
    const { config: c, error } = await ctx.config();
    if (!c) throw new HttpError(400, error ?? "cold.yaml has problems.");
    return c;
  }

  function checkSource(source: string | null | undefined): string {
    if (!source || !SOURCE.test(source)) throw new HttpError(400, "Pick a prospect list: a CSV file or a Twenty source.");
    return source;
  }

  async function prospectFrom(source: string | undefined, key: string | undefined): Promise<Prospect> {
    if (!key) throw new HttpError(400, "Pick a prospect.");
    const prospect = (await ctx.prospects(checkSource(source))).find((p) => p.key === key);
    if (!prospect) throw new HttpError(404, "That prospect is not on the list any more. Refresh and pick again.");
    return prospect;
  }

  const history = async (c: ColdConfig, p: Prospect) => (await ctx.store(c)).forProspects(p.identities);

  function decider(c: ColdConfig) {
    try {
      return ctx.decider(c.decide);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }

  return [
    [
      "GET",
      /^\/api\/decide\/status$/,
      async () => {
        const settings = (await ctx.config()).config?.decide ?? DEFAULT_DECIDE;
        const describe = <T>(make: () => T) => {
          try {
            return { value: make() };
          } catch (err) {
            return { error: (err as Error).message };
          }
        };
        const decide = describe(() => ctx.decider(settings));
        const reader = describe(() => ctx.reader(settings));
        const claudeReady = aiConfigured() || !!ctx.options.aiCall;
        const since = new Date(ctx.now().getTime() - 30 * 86_400_000);
        const body: DecideStatusResponse = {
          settings,
          decide: decide.value ? { provider: decide.value.name, model: decide.value.model } : { provider: null, error: decide.error },
          diligence: reader.value
            ? { provider: "subq", model: reader.value.model }
            : reader.error
              ? { provider: null, error: reader.error }
              : claudeReady
                ? { provider: "claude", model: aiModel() }
                : { provider: null, error: "Add a SubQ API key (SUBQ_API_KEY) or an Anthropic API key (ANTHROPIC_API_KEY) in Settings to run diligence." },
          keys: { typesafe: jevConfigured(), subq: subqConfigured(), anthropic: aiConfigured() },
          counts: (await ctx.decisions?.counts()) ?? { decisions: 0, assignments: 0 },
          usage: (await ctx.ai?.usageByProvider(since)) ?? [],
        };
        return json(body);
      },
    ],
    [
      "POST",
      /^\/api\/decide\/test$/,
      async (request) => {
        const { provider } = await readBody<{ provider?: string }>(request);
        try {
          if (provider === "jev") {
            const jev = jevProvider();
            await jev.decide({ state: "COLD is checking that it can reach Jev.", questions: { ok: { type: "noul", instructions: "Is this a connection test?", criteria: { true: "Yes", false: "No" } } } });
            return json({ ok: true, message: `Jev answered (${jev.model}). Scoring will use it.` });
          }
          if (provider === "subq") {
            const reader = subqReader();
            await reader.chat({ system: "Reply with the single word: ready.", prompt: "Connection test.", maxTokens: 16 });
            return json({ ok: true, message: `SubQ answered (${reader.model}). Diligence will use it.` });
          }
        } catch (err) {
          return json({ ok: false, message: explainError(err).message });
        }
        throw new HttpError(400, "Test jev or subq.");
      },
    ],
    [
      "POST",
      /^\/api\/decide\/diligence$/,
      async (request) => {
        const { ai } = stores();
        const body = await readBody<{ source?: string; prospect?: string; offer?: string }>(request);
        const prospect = await prospectFrom(body.source, body.prospect);
        if (prospect.doNotContact) throw new HttpError(409, `${prospect.label} is marked Do Not Contact, so COLD won't research them.`);
        const c = await config();
        const offer = getOffer(c, body.offer || undefined);
        const reader = ctx.reader(c.decide);
        const claudeReady = aiConfigured() || !!ctx.options.aiCall;
        if (!reader && !claudeReady) throw new HttpError(400, "Add a SubQ API key (SUBQ_API_KEY) or an Anthropic API key (ANTHROPIC_API_KEY) in Settings to run diligence.");
        // Claude reads when there is no SubQ, and searches instead when SubQ would have no pages to read.
        const call = claudeReady ? ctx.claude() : undefined;
        const touches = await history(c, prospect);
        const website = websiteOf(prospect);
        const runId = await startRun(
          ai,
          "diligence",
          prospect.key,
          { source: body.source, prospect: prospect.key, label: prospect.label, website },
          async () => {
            const site = website ? await collectSite(website, ctx.options.pages) : { pages: [], skipped: [] };
            const input = { offer: offerOf(offer), prospect: prospectOf(prospect), history: touches, pages: site.pages, skipped: site.skipped };
            if (reader && (site.pages.length || !call)) return { ...(await diligenceWithSubq(reader, input)), provider: "subq" as const };
            return { ...(await diligenceWithClaude(call!, input)), provider: "claude" as const };
          },
          reader ? "subq" : "claude",
        );
        return json({ runId }, 202);
      },
    ],
    [
      "POST",
      /^\/api\/decide\/score$/,
      async (request) => {
        const { ai, decisions } = stores();
        const body = await readBody<{ source?: string; prospect?: string; offer?: string; account?: string }>(request);
        const prospect = await prospectFrom(body.source, body.prospect);
        const c = await config();
        const offerKey = offerKeyOf(c, body.offer || undefined);
        const touches = await history(c, prospect);
        if (prospect.doNotContact || touches.some((t) => t.kind === "OPTED_OUT")) throw new HttpError(409, `${prospect.label} asked not to be contacted, so COLD won't score them.`);
        const provider = decider(c);
        const { dossier, research } = await evidenceFor(ctx, prospect.key);
        const account = (body.account && c.accounts[body.account]) || Object.values(c.accounts)[0]!;
        const runId = await startRun(
          ai,
          "decide",
          prospect.key,
          { source: body.source, prospect: prospect.key, label: prospect.label, offer: offerKey },
          async (id) => {
            const input: DecisionInput = { offer: offerOf(getOffer(c, offerKey || undefined)), sender: senderOf(account), prospect, dossier, research, history: touches, now: ctx.now() };
            const result = await provider.decide({ state: decisionState(input), questions: outboundQuestions(input) });
            const decision = combine(input, { ...result, provider: provider.name }, c.decide.reviewBelow);
            await decisions.save(prospect.key, offerKey, id, decision);
            return { output: decision, model: result.model, usage: result.usage, seen: [] };
          },
          provider.name,
        );
        return json({ runId }, 202);
      },
    ],
    [
      "GET",
      /^\/api\/decide\/scores$/,
      async (_request, _params, url) => {
        const { ai, decisions } = stores();
        const source = checkSource(url.searchParams.get("source"));
        const c = await config();
        const offerKey = offerKeyOf(c, url.searchParams.get("offer") || undefined);
        const keys = (await ctx.prospects(source)).map((p) => p.key);
        const [found, diligence] = await Promise.all([decisions.forProspects(keys, offerKey), ai.doneAt("diligence", keys)]);
        const body: ScoresResponse = { offer: offerKey, scores: Object.fromEntries([...found].map(([k, d]) => [k, summary(d)])), diligence: Object.fromEntries(diligence) };
        return json(body);
      },
    ],
    [
      "GET",
      /^\/api\/decide\/prospect$/,
      async (_request, _params, url) => {
        const { decisions } = stores();
        const key = url.searchParams.get("prospect")?.trim();
        if (!key || key.length > 400) throw new HttpError(400, "Pick a prospect.");
        const c = await config();
        const [decision, evidence] = await Promise.all([decisions.get(key, offerKeyOf(c, url.searchParams.get("offer") || undefined)), evidenceFor(ctx, key)]);
        const body: ProspectDecisionResponse = { decision, dossier: evidence.dossier, dossierAt: evidence.dossierAt };
        return json(body);
      },
    ],
    [
      "GET",
      /^\/api\/decide\/insights$/,
      async (_request, _params, url) => {
        const { decisions } = stores();
        const c = await config();
        // A touch log that can't be read right now still leaves what was already worked out.
        await resolveLearning(ctx, c, url.searchParams.get("refresh") === "1").catch((err) => console.error("Could not update what the engine learned:", err));
        return json(buildInsights(await decisions.all()));
      },
    ],
  ];
}
