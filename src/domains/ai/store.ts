import { randomUUID } from "node:crypto";
import type { Database } from "../db";
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
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(kind: AiRunKind, subject: string | undefined, input: unknown): string {
    const id = randomUUID();
    this.db
      .query("INSERT INTO ai_runs (id, kind, subject, status, input, created_at) VALUES (?, ?, ?, 'running', ?, ?)")
      .run(id, kind, subject ?? null, JSON.stringify(input), this.now().toISOString());
    return id;
  }

  finish(id: string, result: { output: unknown; model: string; usage: AiUsage }): void {
    this.db
      .query("UPDATE ai_runs SET status = 'done', output = ?, model = ?, input_tokens = ?, output_tokens = ?, searches = ?, finished_at = ? WHERE id = ?")
      .run(JSON.stringify(result.output), result.model, result.usage.inputTokens, result.usage.outputTokens, result.usage.searches, this.now().toISOString(), id);
  }

  fail(id: string, error: string): void {
    this.db.query("UPDATE ai_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(error.slice(0, 2000), this.now().toISOString(), id);
  }

  get(id: string): AiRun | undefined {
    const row = this.db.query<RunRow, [string]>("SELECT * FROM ai_runs WHERE id = ?").get(id);
    return row ? toRun(row) : undefined;
  }

  /** The newest finished run of a kind about a subject: a prospect's research, a reply's triage. */
  latest<T>(kind: AiRunKind, subject: string): AiRun<T> | undefined {
    const row = this.db.query<RunRow, [string, string]>("SELECT * FROM ai_runs WHERE kind = ? AND subject = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1").get(kind, subject);
    return row ? (toRun(row) as AiRun<T>) : undefined;
  }

  /** The newest finished run of a kind for each of these subjects. */
  latestFor<T>(kind: AiRunKind, subjects: string[]): Map<string, AiRun<T>> {
    const found = new Map<string, AiRun<T>>();
    for (let i = 0; i < subjects.length; i += 400) {
      const chunk = subjects.slice(i, i + 400);
      const rows = this.db
        .query<RunRow, string[]>(`SELECT * FROM ai_runs WHERE kind = ? AND status = 'done' AND subject IN (${chunk.map(() => "?").join(",")}) ORDER BY created_at ASC`)
        .all(kind, ...chunk);
      for (const row of rows) found.set(row.subject!, toRun(row) as AiRun<T>);
    }
    return found;
  }

  recent(kind: AiRunKind, limit = 20): AiRun[] {
    return this.db.query<RunRow, [string, number]>("SELECT * FROM ai_runs WHERE kind = ? ORDER BY created_at DESC LIMIT ?").all(kind, limit).map(toRun);
  }

  /** Tokens and searches used since a date, for the Settings page. */
  usageSince(since: Date): { runs: number; inputTokens: number; outputTokens: number; searches: number } {
    return this.db
      .query<{ runs: number; inputTokens: number; outputTokens: number; searches: number }, [string]>(
        "SELECT COUNT(*) AS runs, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens, COALESCE(SUM(searches), 0) AS searches FROM ai_runs WHERE created_at >= ?",
      )
      .get(since.toISOString())!;
  }

  saveDraft(draft: Omit<AiDraftRecord, "updatedAt">): AiDraftRecord {
    const at = this.now().toISOString();
    this.db
      .query(
        `INSERT INTO ai_drafts (campaign_id, prospect_key, step, subject, body, status, run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (campaign_id, prospect_key, step) DO UPDATE SET subject = excluded.subject, body = excluded.body, status = excluded.status, run_id = COALESCE(excluded.run_id, run_id), updated_at = excluded.updated_at`,
      )
      .run(draft.campaignId, draft.prospectKey, draft.step, draft.subject ?? null, draft.body, draft.status, draft.runId ?? null, at, at);
    return { ...draft, updatedAt: at };
  }

  drafts(campaignId: string): AiDraftRecord[] {
    return this.db.query<DraftRow, [string]>("SELECT * FROM ai_drafts WHERE campaign_id = ? ORDER BY updated_at DESC").all(campaignId).map(toDraft);
  }

  /** The approved draft for a prospect's step, used instead of the template when that email goes out. */
  approved(campaignId: string, prospectKey: string, step: number): AiDraftRecord | undefined {
    const row = this.db.query<DraftRow, [string, string, number]>("SELECT * FROM ai_drafts WHERE campaign_id = ? AND prospect_key = ? AND step = ? AND status = 'approved'").get(campaignId, prospectKey, step);
    return row ? toDraft(row) : undefined;
  }

  deleteDraft(campaignId: string, prospectKey: string, step: number): boolean {
    return this.db.query("DELETE FROM ai_drafts WHERE campaign_id = ? AND prospect_key = ? AND step = ?").run(campaignId, prospectKey, step).changes > 0;
  }
}
