import type { Angle, DraftStyle, Research, Tone, Triage } from "../../ai";
import { offerKeyOf, type ColdConfig } from "../../config";
import { countStyles, OBJECTION_GUIDE, pickStyle, resolveAssignments, segmentOf, type Decision, type Dossier, type StylePick } from "../../decide";
import type { Prospect } from "../../prospects";
import type { WebContext } from "../context";
import type { Campaign } from "../types";

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
