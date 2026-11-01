import { aiConfigured, aiModel, explainError } from "../../ai";
import { DEFAULT_DECIDE, offerKeyOf, type ColdConfig } from "../../config";
import { buildInsights, jevConfigured, jevProvider, subqConfigured, subqReader, type Decision } from "../../decide";
import type { Prospect } from "../../prospects";
import { HttpError, json, readBody, type Route } from "../api";
import { SOURCE, startRun, type PreparedRun } from "../ai/shared";
import { invocationDeadline, keepAlive } from "../background";
import type { WebContext } from "../context";
import type { DecideStatusResponse, ProspectDecisionResponse, ScoreJobView, ScoresResponse, ScoreSummary } from "../types";
import { evidenceFor, NotReady, prepareDiligence, prepareScore, resolveLearning, Skip } from "./engine";
import { AlreadyScoring, MAX_PROSPECTS } from "./jobs";

export { chooseStyle, draftStyle, evidenceFor, websiteOf } from "./engine";

/** A prospect left alone is a conflict; an engine with no key yet is a request it can't serve. */
const asHttp = (err: unknown) => (err instanceof Skip ? new HttpError(409, err.message) : err instanceof NotReady ? new HttpError(400, err.message) : err);

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

  /** Start a prepared run in the background, or say in words why it can't start. */
  async function start<T>(prepare: () => Promise<PreparedRun<T>>): Promise<Response> {
    const { ai } = stores();
    let run: PreparedRun<T>;
    try {
      run = await prepare();
    } catch (err) {
      throw asHttp(err);
    }
    return json({ runId: await startRun(ai, run.kind, run.subject, run.input, run.work, run.provider) }, 202);
  }

  const scoring = () => {
    if (!ctx.scoring) throw new HttpError(500, "Scoring a list needs the app database.");
    return ctx.scoring;
  };

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
        const body = await readBody<{ source?: string; prospect?: string; offer?: string }>(request);
        const prospect = await prospectFrom(body.source, body.prospect);
        const c = await config();
        return start(() => prepareDiligence(ctx, c, prospect, { source: body.source, offerKey: body.offer || undefined }));
      },
    ],
    [
      "POST",
      /^\/api\/decide\/score$/,
      async (request) => {
        stores();
        const body = await readBody<{ source?: string; prospect?: string; offer?: string; account?: string }>(request);
        const prospect = await prospectFrom(body.source, body.prospect);
        const c = await config();
        return start(() => prepareScore(ctx, c, prospect, { source: body.source, offerKey: offerKeyOf(c, body.offer || undefined), accountKey: body.account }));
      },
    ],
    [
      "POST",
      /^\/api\/decide\/jobs$/,
      async (request) => {
        const { decisions } = stores();
        const jobs = scoring();
        const body = await readBody<{ source?: string; offer?: string; account?: string; deep?: boolean; which?: "unscored" | "all" }>(request);
        const source = checkSource(body.source);
        const c = await config();
        const offer = offerKeyOf(c, body.offer || undefined);
        // Fail now, not once per prospect, when nothing could be scored.
        try {
          ctx.decider(c.decide);
          if (body.deep && !ctx.reader(c.decide) && !aiConfigured() && !ctx.options.aiCall) throw new NotReady("Add a SubQ API key (SUBQ_API_KEY) or an Anthropic API key (ANTHROPIC_API_KEY) in Settings to read their sites.");
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        // Nobody who asked not to be contacted: Do Not Contact on the list, or an opt-out in the touch log.
        const optedOut = new Set((await (await ctx.store(c)).suppressions()).filter((t) => t.kind === "OPTED_OUT").map((t) => t.prospectKey));
        let prospects = (await ctx.prospects(source)).filter((p) => !p.doNotContact && !p.identities.some((id) => optedOut.has(id)));
        if (body.which !== "all") {
          const scored = await decisions.forProspects(prospects.map((p) => p.key), offer);
          prospects = prospects.filter((p) => !scored.has(p.key));
        }
        if (!prospects.length) throw new HttpError(409, body.which === "all" ? "There is nobody on this list to score." : "Everyone on this list is scored already for this offer.");
        let job: { id: string; total: number };
        try {
          job = await jobs.start({ source, offer, account: body.account, deep: !!body.deep }, prospects.map((p) => ({ key: p.key, label: p.label })));
        } catch (err) {
          if (err instanceof AlreadyScoring) throw new HttpError(409, err.message, { jobId: err.jobId });
          throw err;
        }
        // The first prospects start now; on Vercel the cron job carries on every minute after this function stops.
        keepAlive(jobs.tick({ deadline: invocationDeadline() }).catch((err: unknown) => console.error("scoring:", err)));
        return json({ jobId: job.id, total: job.total, capped: prospects.length > MAX_PROSPECTS }, 202);
      },
    ],
    [
      "GET",
      /^\/api\/decide\/jobs$/,
      async (_request, _params, url) => {
        const source = checkSource(url.searchParams.get("source"));
        const c = await config();
        const jobs: ScoreJobView[] = await scoring().recent({ source, offer: offerKeyOf(c, url.searchParams.get("offer") || undefined) });
        return json({ jobs });
      },
    ],
    [
      "GET",
      /^\/api\/decide\/jobs\/([\w-]+)$/,
      async (_request, [id]) => {
        const job = await scoring().view(id!);
        return job ? json(job) : json({ error: "No such scoring job." }, 404);
      },
    ],
    [
      "POST",
      /^\/api\/decide\/jobs\/([\w-]+)\/stop$/,
      async (_request, [id]) => json({ ok: await scoring().stop(id!) }),
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
