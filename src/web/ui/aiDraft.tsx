import { Check, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { AiDraftRecord } from "../../domains/ai/store";
import type { PlanRow, StyleChoice } from "../../domains/web/types";
import { runAndWait } from "../lib/ai";
import { api, ApiError } from "../lib/api";
import { ANGLE_LABEL, ANGLES, TONE_LABEL, TONES } from "../lib/decide";
import { Button, ErrorNotice } from "./kit";
import { useToast } from "./toast";

interface DraftAnswer {
  draft: AiDraftRecord;
  changes: string;
  personalLine: string | null;
  researched: boolean;
  style?: StyleChoice;
}

/** Tone and opening for the next draft: Auto lets the decision engine pick for this person. */
function StylePicker({ tone, angle, onTone, onAngle }: { tone: string; angle: string; onTone: (t: string) => void; onAngle: (a: string) => void }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <select className="select sm" value={tone} onChange={(e) => onTone(e.target.value)} aria-label="Tone">
        <option value="">Tone: auto</option>
        {TONES.map((t) => (
          <option key={t} value={t}>
            {TONE_LABEL[t]}
          </option>
        ))}
      </select>
      <select className="select sm" value={angle} onChange={(e) => onAngle(e.target.value)} aria-label="Opening">
        <option value="">Opening: auto</option>
        {ANGLES.map((a) => (
          <option key={a} value={a}>
            {ANGLE_LABEL[a]}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * Personalize one due message with Claude, edit it, and approve it. Only an
 * approved draft is used when the message goes out; until then the template
 * is. Discarding goes back to the template.
 */
export function AiDraft({ campaignId, row, channel, existing, onChanged }: { campaignId: string; row: PlanRow; channel: "email" | "dm"; existing?: AiDraftRecord; onChanged: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<AiDraftRecord | undefined>(existing);
  const [subject, setSubject] = useState(existing?.subject ?? "");
  const [body, setBody] = useState(existing?.body ?? "");
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError>();
  const [tone, setTone] = useState("");
  const [angle, setAngle] = useState("");
  const step = row.step ?? 1;
  const showSubject = channel === "email" && step === 1;

  useEffect(() => {
    setDraft(existing);
    setSubject(existing?.subject ?? "");
    setBody(existing?.body ?? "");
  }, [existing]);

  async function personalize() {
    setBusy("ai");
    setError(undefined);
    try {
      const run = await runAndWait<DraftAnswer>(() => api<{ runId: string }>("/api/ai/draft", { method: "POST", body: { campaignId, prospect: row.key, tone: tone || undefined, angle: angle || undefined } }));
      const answer = run.output!;
      setDraft(answer.draft);
      setSubject(answer.draft.subject ?? "");
      setBody(answer.draft.body);
      const style = answer.style ? `${TONE_LABEL[answer.style.tone]}, opening with ${ANGLE_LABEL[answer.style.angle].toLowerCase()}: ${answer.style.why} ` : "";
      setNote(`${style}${answer.changes}${answer.researched ? "" : " No research yet for this prospect, so only what's on the list was used."}`);
      onChanged();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  }

  async function save(status: "draft" | "approved") {
    setBusy(status);
    setError(undefined);
    try {
      const saved = await api<AiDraftRecord>("/api/ai/drafts", { method: "PUT", body: { campaignId, prospect: row.key, step, subject: showSubject ? subject : undefined, body, status } });
      setDraft(saved);
      toast.success(status === "approved" ? `Approved. This is what ${row.label} will get.` : "Draft saved.");
      onChanged();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  }

  async function discard() {
    setBusy("discard");
    try {
      await api(`/api/ai/drafts?campaignId=${encodeURIComponent(campaignId)}&prospect=${encodeURIComponent(row.key)}&step=${step}`, { method: "DELETE" });
      setDraft(undefined);
      setBody("");
      setSubject("");
      setNote(undefined);
      toast.success("Back to the template.");
      onChanged();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  }

  if (!draft)
    return (
      <div className="row wrap" style={{ marginTop: 10 }}>
        <StylePicker tone={tone} angle={angle} onTone={setTone} onAngle={setAngle} />
        <Button size="sm" variant="ai" icon={Sparkles} loading={busy === "ai"} onClick={personalize}>
          Personalize with AI
        </Button>
        <span className="hint">Claude rewrites this one message for {row.label}, in the tone most likely to get a reply from them. You approve it before it's used.</span>
        <ErrorNotice error={error} title="No draft" />
      </div>
    );

  const approved = draft.status === "approved";
  const dirty = body !== draft.body || (showSubject && subject !== (draft.subject ?? ""));
  return (
    <div className="ai-card" style={{ marginTop: 12, padding: 12 }}>
      <div className="row between wrap" style={{ marginBottom: 8 }}>
        <span className="ai-badge">
          <Sparkles size={12} /> {approved && !dirty ? "Approved: this goes out instead of the template" : "AI draft: not used until you approve it"}
        </span>
        <span className="row wrap" style={{ gap: 6 }}>
          <StylePicker tone={tone} angle={angle} onTone={setTone} onAngle={setAngle} />
          <Button size="sm" variant="ghost" icon={RotateCcw} loading={busy === "ai"} onClick={personalize}>
            Rewrite
          </Button>
          <Button size="sm" variant="ghost" icon={Trash2} loading={busy === "discard"} onClick={discard}>
            Use the template
          </Button>
        </span>
      </div>
      {note && <p className="hint" style={{ marginBottom: 8 }}>{note}</p>}
      <div className="draft-box">
        {showSubject && <input className="input" style={{ border: 0, borderBottom: "1px solid var(--border)", borderRadius: 0, fontWeight: 700 }} value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />}
        <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Message" />
      </div>
      <div className="row between wrap" style={{ marginTop: 8 }}>
        <span className="hint">
          {body.length} characters{channel === "email" ? ". Your footer and opt-out line are added when it's sent." : "."}
        </span>
        <span className="row" style={{ gap: 6 }}>
          {dirty && (
            <Button size="sm" loading={busy === "draft"} onClick={() => save("draft")}>
              Save draft
            </Button>
          )}
          <Button size="sm" variant="primary" icon={Check} loading={busy === "approved"} disabled={approved && !dirty} onClick={() => save("approved")}>
            {approved && !dirty ? "Approved" : "Approve"}
          </Button>
        </span>
      </div>
      <ErrorNotice error={error} title="Not saved" />
    </div>
  );
}
