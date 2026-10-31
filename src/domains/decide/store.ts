import type { Angle, Tone } from "../ai";
import type { Db, Statement } from "../db";
import type { Assignment, Outcome, PickedBy } from "./learn";
import type { Decision, Tier } from "./model";

interface DecisionRow {
  prospect_key: string;
  decision: string;
}

interface AssignmentRow {
  campaign_id: string;
  prospect_key: string;
  step: number;
  sequence: string;
  segment: string;
  tone: Tone;
  angle: Angle;
  picked_by: PickedBy;
  score: number | null;
  tier: Tier | null;
  approved_at: string | null;
  sent_at: string | null;
  outcome: Outcome | null;
  resolved_at: string | null;
  created_at: string;
}

const toAssignment = (r: AssignmentRow): Assignment => ({
  campaignId: r.campaign_id,
  prospectKey: r.prospect_key,
  step: r.step,
  sequence: r.sequence,
  segment: r.segment,
  tone: r.tone,
  angle: r.angle,
  pickedBy: r.picked_by,
  score: r.score ?? undefined,
  tier: r.tier ?? undefined,
  approvedAt: r.approved_at ?? undefined,
  sentAt: r.sent_at ?? undefined,
  outcome: r.outcome ?? undefined,
  resolvedAt: r.resolved_at ?? undefined,
  createdAt: r.created_at,
});

/** A late reply can still turn "no reply" into a reply, so those stay open this long. */
const REOPEN_DAYS = 60;

/** The decision engine's records: each prospect's latest decision per offer, and the styles messages were written in. */
export class DecideStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async save(prospectKey: string, offer: string, runId: string | undefined, d: Decision): Promise<void> {
    await this.db.run(
      `INSERT INTO decisions (prospect_key, offer, run_id, score, tier, action, review, decision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (prospect_key, offer) DO UPDATE SET run_id = excluded.run_id, score = excluded.score, tier = excluded.tier, action = excluded.action, review = excluded.review, decision = excluded.decision, created_at = excluded.created_at`,
      prospectKey,
      offer,
      runId ?? null,
      d.score,
      d.tier,
      d.action,
      d.review ? 1 : 0,
      JSON.stringify(d),
      this.now().toISOString(),
    );
  }

  async get(prospectKey: string, offer: string): Promise<Decision | undefined> {
    const row = await this.db.get<DecisionRow>("SELECT prospect_key, decision FROM decisions WHERE prospect_key = ? AND offer = ?", prospectKey, offer);
    return row ? (JSON.parse(row.decision) as Decision) : undefined;
  }

  /** The latest decision for each of these prospects, for one offer. */
  async forProspects(keys: string[], offer: string): Promise<Map<string, Decision>> {
    const found = new Map<string, Decision>();
    for (let i = 0; i < keys.length; i += 400) {
      const chunk = keys.slice(i, i + 400);
      const rows = await this.db.all<DecisionRow>(`SELECT prospect_key, decision FROM decisions WHERE offer = ? AND prospect_key IN (${chunk.map(() => "?").join(",")})`, offer, ...chunk);
      for (const row of rows) found.set(row.prospect_key, JSON.parse(row.decision) as Decision);
    }
    return found;
  }

  async counts(): Promise<{ decisions: number; assignments: number }> {
    const d = await this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM decisions");
    const a = await this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM style_assignments");
    return { decisions: d?.n ?? 0, assignments: a?.n ?? 0 };
  }

  /** A message written in a style. Writing it again in another style starts it over: not approved, no result. */
  async assign(a: Omit<Assignment, "createdAt" | "approvedAt" | "sentAt" | "outcome" | "resolvedAt">): Promise<Assignment> {
    const at = this.now().toISOString();
    await this.db.run(
      `INSERT INTO style_assignments (campaign_id, prospect_key, step, sequence, segment, tone, angle, picked_by, score, tier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (campaign_id, prospect_key, step) DO UPDATE SET sequence = excluded.sequence, segment = excluded.segment, tone = excluded.tone, angle = excluded.angle, picked_by = excluded.picked_by,
         score = excluded.score, tier = excluded.tier, approved_at = NULL, sent_at = NULL, outcome = NULL, resolved_at = NULL, created_at = excluded.created_at`,
      a.campaignId,
      a.prospectKey,
      a.step,
      a.sequence,
      a.segment,
      a.tone,
      a.angle,
      a.pickedBy,
      a.score ?? null,
      a.tier ?? null,
      at,
    );
    return { ...a, createdAt: at };
  }

  async assignment(campaignId: string, prospectKey: string, step: number): Promise<Assignment | undefined> {
    const row = await this.db.get<AssignmentRow>("SELECT * FROM style_assignments WHERE campaign_id = ? AND prospect_key = ? AND step = ?", campaignId, prospectKey, step);
    return row ? toAssignment(row) : undefined;
  }

  /** The draft was approved (it goes out instead of the template) or taken back to a draft. */
  async approve(campaignId: string, prospectKey: string, step: number, approved: boolean): Promise<void> {
    await this.db.run(
      "UPDATE style_assignments SET approved_at = ? WHERE campaign_id = ? AND prospect_key = ? AND step = ? AND sent_at IS NULL",
      approved ? this.now().toISOString() : null,
      campaignId,
      prospectKey,
      step,
    );
  }

  /** The draft was thrown away for the template: its style was never used. */
  async unassign(campaignId: string, prospectKey: string, step: number): Promise<void> {
    await this.db.run("DELETE FROM style_assignments WHERE campaign_id = ? AND prospect_key = ? AND step = ? AND sent_at IS NULL", campaignId, prospectKey, step);
  }

  async all(limit = 20_000): Promise<Assignment[]> {
    return (await this.db.all<AssignmentRow>("SELECT * FROM style_assignments ORDER BY created_at DESC LIMIT ?", limit)).map(toAssignment);
  }

  /** Approved ones still waiting for a result, and recent ones counted as unanswered that a late reply could change. */
  async open(): Promise<Assignment[]> {
    const since = new Date(this.now().getTime() - REOPEN_DAYS * 86_400_000).toISOString();
    return (
      await this.db.all<AssignmentRow>("SELECT * FROM style_assignments WHERE approved_at IS NOT NULL AND (outcome IS NULL OR (outcome = 'no_reply' AND sent_at >= ?)) LIMIT 5000", since)
    ).map(toAssignment);
  }

  async record(updates: Array<Pick<Assignment, "campaignId" | "prospectKey" | "step" | "sentAt" | "outcome" | "resolvedAt">>): Promise<void> {
    const statements: Statement[] = updates.map((u) => [
      "UPDATE style_assignments SET sent_at = ?, outcome = ?, resolved_at = ? WHERE campaign_id = ? AND prospect_key = ? AND step = ?",
      u.sentAt ?? null,
      u.outcome ?? null,
      u.resolvedAt ?? null,
      u.campaignId,
      u.prospectKey,
      u.step,
    ]);
    for (let i = 0; i < statements.length; i += 200) await this.db.batch(statements.slice(i, i + 200));
  }
}
