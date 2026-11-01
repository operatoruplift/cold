import { aiConfigured, type Angle, type DraftStyle, type Research, type Tone, type Triage } from "../../ai";
import { getOffer, offerKeyOf, type ColdConfig } from "../../config";
import {
  collectSite,
  combine,
  countStyles,
  decisionState,
  diligenceWithClaude,
  diligenceWithSubq,
  OBJECTION_GUIDE,
  outboundQuestions,
  pickStyle,
  resolveAssignments,
  segmentOf,
  type Decision,
  type DecisionInput,
  type Dossier,
  type StylePick,
} from "../../decide";
import type { Prospect } from "../../prospects";
import type { Touch } from "../../touches";
import { offerOf, prospectOf, runNow, senderOf, type PreparedRun } from "../ai/shared";
import type { WebContext } from "../context";
import type { Campaign } from "../types";
import { JobStop, type ItemOutcome, type ScoreItem, type ScoreJobSpec } from "./jobs";

/** A prospect the engine leaves alone, with the reason: Do Not Contact, opted out, gone from the list. */
export class Skip extends Error {}
/** The engine can't run yet (no key for any provider): every prospect would fail the same way. */
export class NotReady extends Error {}

/** Free mailbox providers: their domain is not the business's website. */
const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|zoho|yandex|fastmail|hey)\./i;

/** A prospect's website: the list's, else their email's domain when it's a business address. */
export function websiteOf(prospect: Prospect): string | undefined {
  const listed = prospect.variables.website?.trim();
  if (listed) return listed;
  const email = prospect.email?.trim();
  return email && !FREE_MAIL.test(email) && email.includes("@") ? `https://${email.split("@")[1]}` : undefined;
}

const historyOf = async (ctx: WebContext, config: ColdConfig, prospect: Prospect): Promise<Touch[]> => (await ctx.store(config)).forProspects(prospect.identities);

/**
 * Diligence on one prospect, ready to run: read their site safely, then have
 * SubQ read all of it, or Claude read it and search a little more.
 */
export async function prepareDiligence(ctx: WebContext, config: ColdConfig, prospect: Prospect, where: { source?: string; offerKey?: string } = {}): Promise<PreparedRun<Dossier>> {
  if (prospect.doNotContact) throw new Skip(`${prospect.label} is marked Do Not Contact, so COLD won't research them.`);
  let reader: ReturnType<WebContext["reader"]>;
  try {
    reader = ctx.reader(config.decide);
  } catch (err) {
    throw new NotReady((err as Error).message);
  }
  const claudeReady = aiConfigured() || !!ctx.options.aiCall;
  if (!reader && !claudeReady) throw new NotReady("Add a SubQ API key (SUBQ_API_KEY) or an Anthropic API key (ANTHROPIC_API_KEY) in Settings to run diligence.");
  // Claude reads when there is no SubQ, and searches instead when SubQ would have no pages to read.
  const call = claudeReady ? ctx.claude() : undefined;
  const offer = getOffer(config, where.offerKey || undefined);
  const touches = await historyOf(ctx, config, prospect);
  const website = websiteOf(prospect);
  return {
    kind: "diligence",
    subject: prospect.key,
    input: { source: where.source, prospect: prospect.key, label: prospect.label, website },
    provider: reader ? "subq" : "claude",
    work: async () => {
      const site = website ? await collectSite(website, ctx.options.pages) : { pages: [], skipped: [] };
      const input = { offer: offerOf(offer), prospect: prospectOf(prospect), history: touches, pages: site.pages, skipped: site.skipped };
      if (reader && (site.pages.length || !call)) return { ...(await diligenceWithSubq(reader, input)), provider: "subq" as const };
      return { ...(await diligenceWithClaude(call!, input)), provider: "claude" as const };
    },
  };
}

/** A decision on one prospect, ready to run, saved as their latest for this offer when it finishes. */
export async function prepareScore(ctx: WebContext, config: ColdConfig, prospect: Prospect, where: { source?: string; offerKey: string; accountKey?: string }): Promise<PreparedRun<Decision>> {
  const decisions = ctx.decisions;
  if (!decisions) throw new NotReady("The decision engine needs the app database.");
  const touches = await historyOf(ctx, config, prospect);
  if (prospect.doNotContact || touches.some((t) => t.kind === "OPTED_OUT")) throw new Skip(`${prospect.label} asked not to be contacted, so COLD won't score them.`);
  let provider: ReturnType<WebContext["decider"]>;
  try {
    provider = ctx.decider(config.decide);
  } catch (err) {
    throw new NotReady((err as Error).message);
  }
  const { dossier, research } = await evidenceFor(ctx, prospect.key);
  const account = (where.accountKey && config.accounts[where.accountKey]) || Object.values(config.accounts)[0]!;
  return {
    kind: "decide",
    subject: prospect.key,
    input: { source: where.source, prospect: prospect.key, label: prospect.label, offer: where.offerKey },
    provider: provider.name,
    work: async (runId) => {
      const input: DecisionInput = { offer: offerOf(getOffer(config, where.offerKey || undefined)), sender: senderOf(account), prospect, dossier, research, history: touches, now: ctx.now() };
      const result = await provider.decide({ state: decisionState(input), questions: outboundQuestions(input) });
      const decision = combine(input, { ...result, provider: provider.name }, config.decide.reviewBelow);
      await decisions.save(prospect.key, where.offerKey, runId, decision);
      return { output: decision, model: result.model, usage: result.usage, seen: [] };
    },
  };
}

/**
 * One prospect of a scoring job: their site read first when the job asks and
 * nobody has yet, then the decision. A site that can't be read doesn't stop
 * the score; it just rests on less.
 */
export async function processScoreItem(ctx: WebContext, spec: ScoreJobSpec, item: ScoreItem): Promise<ItemOutcome> {
  const ai = ctx.ai;
  if (!ai) throw new JobStop("The decision engine needs the app database.");
  const { config, error } = await ctx.config();
  if (!config) throw new JobStop(error ?? "cold.yaml has problems.");
  const prospect = (await ctx.prospects(spec.source)).find((p) => p.key === item.key);
  if (!prospect) return { status: "skipped", note: "No longer on the list." };
  try {
    let note: string | undefined;
    if (spec.deep && !(await ai.doneAt("diligence", [prospect.key])).size) {
      try {
        await runNow(ai, await prepareDiligence(ctx, config, prospect, { source: spec.source, offerKey: spec.offer }));
      } catch (err) {
        if (err instanceof Skip || err instanceof NotReady) throw err;
        note = `Scored without diligence: ${(err as Error).message}`;
      }
    }
    const decision = await runNow(ai, await prepareScore(ctx, config, prospect, { source: spec.source, offerKey: spec.offer, accountKey: spec.account }));
    return { status: "done", score: decision.score, tier: decision.tier, note };
  } catch (err) {
    if (err instanceof Skip) return { status: "skipped", note: err.message };
    if (err instanceof NotReady) throw new JobStop(err.message);
    throw err;
  }
}

/** What is known about a prospect beyond the list: the latest diligence, and the latest research. */
export async function evidenceFor(ctx: WebContext, prospectKey: string): Promise<{ dossier?: Dossier; dossierAt?: string; research?: Research }> {
  const [dossier, research] = await Promise.all([ctx.ai?.latest<Dossier>("diligence", prospectKey), ctx.ai?.latest<Research>("research", prospectKey)]);
  return { dossier: dossier?.output, dossierAt: dossier?.createdAt, research: research?.output };
}

/**
 * The style one message is written in: yours when you pick one, else the
 * decision model's pick for this person with some exploration, else what has
 * worked in their segment, else a professional default.
 */
export async function chooseStyle(
  ctx: WebContext,
  input: { config: ColdConfig; campaign: Campaign; channel: string; prospect: Prospect; allowedAngles: Angle[]; tone?: Tone; angle?: Angle },
): Promise<{ pick: StylePick; decision?: Decision; segment: string }> {
  const offer = offerKeyOf(input.config, input.campaign.offer);
  const segment = segmentOf({ offer, channel: input.channel, title: input.prospect.variables.title });
  const decision = await ctx.decisions?.get(input.prospect.key, offer);
  const past = (await ctx.decisions?.all()) ?? [];
  const pick = pickStyle({
    tones: decision?.style.tones,
    angles: decision?.style.angles,
    allowedAngles: input.allowedAngles,
    segment,
    seen: countStyles(past, segment),
    overall: countStyles(past),
    explore: input.config.decide.explore,
    provider: decision?.provider,
    random: ctx.options.random,
  });
  if (input.tone || input.angle) return { pick: { tone: input.tone ?? pick.tone, angle: input.angle ?? pick.angle, pickedBy: "you", why: "Your choice." }, decision, segment };
  return { pick, decision, segment };
}

/** What the writer is told: the style, the needs diligence confirmed first, and the objection worth answering. */
export function draftStyle(pick: Pick<StylePick, "tone" | "angle">, decision?: Decision, dossier?: Dossier): DraftStyle {
  const needs = decision?.needs.length ? decision.needs : (dossier?.needs ?? []).map((n) => n.need);
  const objection = decision && decision.objection.choice !== "none_clear" && decision.objection.confidence >= 0.3 ? OBJECTION_GUIDE[decision.objection.choice] : undefined;
  return { tone: pick.tone, angle: pick.angle, needs: needs.slice(0, 3), objection };
}

const resolvedAt = new WeakMap<WebContext, number>();
const RESOLVE_EVERY_MS = 10 * 60 * 1000;

/**
 * Work out what became of messages written in a chosen style, from the touch
 * log and reply triage. At most every ten minutes per server, unless forced.
 */
export async function resolveLearning(ctx: WebContext, config: ColdConfig, force = false): Promise<number> {
  const { decisions, ai } = ctx;
  if (!decisions || !ai) return 0;
  if (!force && Date.now() - (resolvedAt.get(ctx) ?? 0) < RESOLVE_EVERY_MS) return 0;
  resolvedAt.set(ctx, Date.now());
  return resolveAssignments({
    open: await decisions.open(),
    touches: await ctx.store(config),
    intents: async (ids) => new Map([...(await ai.latestFor<Triage>("triage", ids))].map(([id, run]) => [id, run.output?.intent ?? ""])),
    save: (updates) => decisions.record(updates),
    now: ctx.now(),
  });
}
