import { explainError, type AiOffer, type AiProspect, type AiProvider, type AiResult, type AiRunKind, type AiSender, type AiStore } from "../../ai";
import type { Account, Offer } from "../../config";
import { PROSPECT_SOURCE, type Prospect } from "../../prospects";
import { keepAlive } from "../background";

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

/** The prospect sources the API accepts, the same as the main API's. */
export const SOURCE = PROSPECT_SOURCE;

/** One AI run, ready to go: what it is about, whose API it uses, and the work. */
export interface PreparedRun<T> {
  kind: AiRunKind;
  subject: string | undefined;
  input: unknown;
  provider: AiProvider;
  work: (runId: string) => Promise<AiResult<T> & { provider?: AiProvider }>;
}

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

/** Run one now and wait for it, recorded like any other: for work that is already in the background, like a scoring job. */
export async function runNow<T>(ai: AiStore, run: PreparedRun<T>): Promise<T> {
  const runId = await ai.start(run.kind, run.subject, run.input, run.provider);
  let result: AiResult<T> & { provider?: AiProvider };
  try {
    result = await run.work(runId);
  } catch (err) {
    const reason = explainError(err);
    await ai.fail(runId, reason.message).catch(() => {});
    throw reason;
  }
  await ai.finish(runId, result);
  return result.output;
}

