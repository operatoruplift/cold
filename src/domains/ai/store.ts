import { randomUUID } from "node:crypto";
import type { Db } from "../db";
import type { AiUsage } from "./claude";

export type AiRunKind = "find" | "research" | "draft" | "call" | "triage";

export interface AiRun<T = unknown> {
  id: string;
  kind: AiRunKind;
  /** What it was about: a prospect key, a reply's message id, a search. */
  subject?: string;
  status: "running" | "done" | "failed";
  input: unknown;
  output?: T;
  error?: string;
  model?: string;
  usage: AiUsage;
  createdAt: string;
  finishedAt?: string;
}

export interface AiDraftRecord {
  campaignId: string;
  prospectKey: string;
  step: number;
  subject?: string;
  body: string;
  status: "draft" | "approved";
  runId?: string;
  updatedAt: string;
}

interface RunRow {
  id: string;
  kind: AiRunKind;
  subject: string | null;
  status: AiRun["status"];
  input: string;
  output: string | null;
  error: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  searches: number;
  created_at: string;
  finished_at: string | null;
}

interface DraftRow {
  campaign_id: string;
  prospect_key: string;
  step: number;
  subject: string | null;
  body: string;
  status: AiDraftRecord["status"];
  run_id: string | null;
  updated_at: string;
}

/** Longer than any server keeps working on a run (Vercel stops a function after 800 seconds). */
const STALE_AFTER_MS = 20 * 60 * 1000;

const parse = (text: string | null) => {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

function toRun(row: RunRow): AiRun {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject ?? undefined,
    status: row.status,
    input: parse(row.input),
    output: parse(row.output),
    error: row.error ?? undefined,
    model: row.model ?? undefined,
    usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens, searches: row.searches, fetches: 0 },
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

const toDraft = (row: DraftRow): AiDraftRecord => ({
  campaignId: row.campaign_id,
  prospectKey: row.prospect_key,
  step: row.step,
  subject: row.subject ?? undefined,
  body: row.body,
  status: row.status,
  runId: row.run_id ?? undefined,
  updatedAt: row.updated_at,
});

/** Every AI request and its answer (so research is not paid for twice), and the drafts waiting for approval. */
export class AiStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(kind: AiRunKind, subject: string | undefined, input: unknown): Promise<string> {
    const id = randomUUID();
    await this.db.run("INSERT INTO ai_runs (id, kind, subject, status, input, created_at) VALUES (?, ?, ?, 'running', ?, ?)", id, kind, subject ?? null, JSON.stringify(input), this.now().toISOString());
    return id;
  }

  async finish(id: string, result: { output: unknown; model: string; usage: AiUsage }): Promise<void> {
    await this.db.run(
      "UPDATE ai_runs SET status = 'done', output = ?, model = ?, input_tokens = ?, output_tokens = ?, searches = ?, finished_at = ? WHERE id = ?",
      JSON.stringify(result.output),
      result.model,
      result.usage.inputTokens,
      result.usage.outputTokens,
      result.usage.searches,
      this.now().toISOString(),
      id,
    );
  }

  async fail(id: string, error: string): Promise<void> {
    await this.db.run("UPDATE ai_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", error.slice(0, 2000), this.now().toISOString(), id);
  }

  /**
   * A run, or undefined. One still "running" long after any server could still
   * be working on it (the process stopped mid-run) reads as failed.
   */
  async get(id: string): Promise<AiRun | undefined> {
    const row = await this.db.get<RunRow>("SELECT * FROM ai_runs WHERE id = ?", id);
    if (!row) return undefined;
    if (row.status === "running" && this.now().getTime() - new Date(row.created_at).getTime() > STALE_AFTER_MS) {
      await this.fail(row.id, "The run was interrupted before it finished. Try again.");
      return this.get(id);
    }
    return toRun(row);
  }

  /** The newest finished run of a kind about a subject: a prospect's research, a reply's triage. */
  async latest<T>(kind: AiRunKind, subject: string): Promise<AiRun<T> | undefined> {
    const row = await this.db.get<RunRow>("SELECT * FROM ai_runs WHERE kind = ? AND subject = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1", kind, subject);
    return row ? (toRun(row) as AiRun<T>) : undefined;
  }

  /** The newest finished run of a kind for each of these subjects. */
  async latestFor<T>(kind: AiRunKind, subjects: string[]): Promise<Map<string, AiRun<T>>> {
    const found = new Map<string, AiRun<T>>();
    for (let i = 0; i < subjects.length; i += 400) {
      const chunk = subjects.slice(i, i + 400);
      const rows = await this.db.all<RunRow>(`SELECT * FROM ai_runs WHERE kind = ? AND status = 'done' AND subject IN (${chunk.map(() => "?").join(",")}) ORDER BY created_at ASC`, kind, ...chunk);
      for (const row of rows) found.set(row.subject!, toRun(row) as AiRun<T>);
    }
    return found;
  }

  async recent(kind: AiRunKind, limit = 20): Promise<AiRun[]> {
    return (await this.db.all<RunRow>("SELECT * FROM ai_runs WHERE kind = ? ORDER BY created_at DESC LIMIT ?", kind, limit)).map(toRun);
  }

  /** Tokens and searches used since a date, for the Settings page. */
  async usageSince(since: Date): Promise<{ runs: number; inputTokens: number; outputTokens: number; searches: number }> {
    return (await this.db.get<{ runs: number; inputTokens: number; outputTokens: number; searches: number }>(
      "SELECT COUNT(*) AS runs, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens, COALESCE(SUM(searches), 0) AS searches FROM ai_runs WHERE created_at >= ?",
      since.toISOString(),
    ))!;
  }

  async saveDraft(draft: Omit<AiDraftRecord, "updatedAt">): Promise<AiDraftRecord> {
    const at = this.now().toISOString();
    await this.db.run(
      `INSERT INTO ai_drafts (campaign_id, prospect_key, step, subject, body, status, run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (campaign_id, prospect_key, step) DO UPDATE SET subject = excluded.subject, body = excluded.body, status = excluded.status, run_id = COALESCE(excluded.run_id, run_id), updated_at = excluded.updated_at`,
      draft.campaignId,
      draft.prospectKey,
      draft.step,
      draft.subject ?? null,
      draft.body,
      draft.status,
      draft.runId ?? null,
      at,
      at,
    );
    return { ...draft, updatedAt: at };
  }

  async drafts(campaignId: string): Promise<AiDraftRecord[]> {
    return (await this.db.all<DraftRow>("SELECT * FROM ai_drafts WHERE campaign_id = ? ORDER BY updated_at DESC", campaignId)).map(toDraft);
  }

  /** Every approved draft of a campaign, by prospect and step: used instead of the template when that message goes out. */
  async approved(campaignId: string): Promise<Map<string, AiDraftRecord>> {
    const rows = await this.db.all<DraftRow>("SELECT * FROM ai_drafts WHERE campaign_id = ? AND status = 'approved'", campaignId);
    return new Map(rows.map((row) => [draftKey(row.prospect_key, row.step), toDraft(row)]));
  }

  async deleteDraft(campaignId: string, prospectKey: string, step: number): Promise<boolean> {
    return (await this.db.run("DELETE FROM ai_drafts WHERE campaign_id = ? AND prospect_key = ? AND step = ?", campaignId, prospectKey, step)).changes > 0;
  }
}

/** How approved drafts are looked up: by prospect and step. */
export const draftKey = (prospectKey: string, step: number) => `${prospectKey}|${step}`;
