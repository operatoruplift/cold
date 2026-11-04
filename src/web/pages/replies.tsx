import { Ban, ChevronDown, ChevronRight, Copy, Inbox, Mail, MailX, MessageSquareReply, RefreshCw, Sparkles } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import type { Triage } from "../../domains/ai/tasks";
import type { ActionResponse, TouchRow, XStatusResponse } from "../../domains/web/types";
import { useStatus } from "../app/status";
import { runAndWait } from "../lib/ai";
import { api, ApiError, useApi } from "../lib/api";
import { sequenceName, when } from "../lib/format";
import { Button, Card, Empty, ErrorNotice, Field, Loading, Notice, PageHeader, Pill, Stat, type Tone } from "../ui/kit";
import { ChannelLabel, KindPill } from "../ui/touch";
import { useToast } from "../ui/toast";

interface SyncResult {
  result: { replied: number; optedOut: number; bounced: number; autoReplies: number };
  lines: string[];
}

export function RepliesPage() {
  const status = useStatus();
  const toast = useToast();
  const inboxes = (status.data?.accounts ?? []).filter((a) => a.email?.imapEnv);
  const [account, setAccount] = useState("");
  const [days, setDays] = useState(14);
  const [syncing, setSyncing] = useState(false);
  const [sync, setSync] = useState<SyncResult>();
  const [error, setError] = useState<ApiError>();
  const touches = useApi<TouchRow[]>("/api/touches?days=30&kinds=REPLIED,OPTED_OUT,BOUNCED&limit=300");
  const chosen = account || inboxes[0]?.key || "";
  const ready = inboxes.find((a) => a.key === chosen)?.email?.imapSet;
  const x = useApi<XStatusResponse>("/api/x");
  const onX = (x.data?.accounts ?? []).filter((a) => a.username);
  const [xChecking, setXChecking] = useState(false);
  const [xResult, setXResult] = useState<ActionResponse>();

  async function checkX() {
    setXChecking(true);
    try {
      const result = await api<ActionResponse>("/api/x/replies", { method: "POST", body: {} });
      setXResult(result);
      touches.reload();
      toast.success(result.message);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setXChecking(false);
    }
  }

  async function check() {
    setSyncing(true);
    setError(undefined);
    try {
      const result = await api<SyncResult>("/api/replies/sync", { method: "POST", body: { account: chosen, days } });
      setSync(result);
      touches.reload();
      toast.success("Inbox checked.");
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setSyncing(false);
    }
  }

  const rows = touches.data ?? [];
  const ids = useMemo(() => rows.map(replyId).filter((x): x is string => !!x), [rows]);
  const triageList = useApi<Record<string, Triage>>(ids.length ? `/api/ai/triage?ids=${encodeURIComponent(ids.slice(0, 300).join(","))}` : null);
  const triage = triageList.data ?? {};
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Inbox" sub="Replies stop the sequence; opt-outs stop everything; bounces stop that address. Claude can read each reply and draft your answer." />
      <Card title="Check the inbox" icon={Inbox}>
        <div className="inline-fields">
          <Field label="Inbox">
            <select className="select" value={chosen} onChange={(e) => setAccount(e.target.value)}>
              {inboxes.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.key}: {a.email?.from}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Look back">
            <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[7, 14, 30, 60].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </Field>
          <div className="field" style={{ flex: "none", minWidth: 0 }}>
            <Button variant="primary" icon={RefreshCw} loading={syncing} disabled={!chosen || !ready} onClick={check}>
              Check inbox
            </Button>
          </div>
        </div>
        {chosen && !ready && (
          <div style={{ marginTop: 14 }}>
            <Notice tone="amber">The {chosen} inbox is not connected yet: set its IMAP URL in Settings.</Notice>
          </div>
        )}
        <div style={{ marginTop: 14 }} className="stack">
          <ErrorNotice error={error} title="Could not read the inbox" />
          {sync && (
            <>
              <div className="grid stats" style={{ marginBottom: 0 }}>
                <Stat label="Replies" icon={MessageSquareReply} tone="green" value={sync.result.replied} />
                <Stat label="Opt-outs" icon={Ban} tone="red" value={sync.result.optedOut} />
                <Stat label="Bounces" icon={MailX} tone="amber" value={sync.result.bounced} />
                <Stat label="Ignored" icon={Inbox} tone="gray" value={sync.result.autoReplies} note="Out of office, delays" />
              </div>
              {sync.lines.length > 0 && <div className="lines">{sync.lines.join("\n")}</div>}
            </>
          )}
          <p className="hint">Sending a campaign checks the inbox first, too. Replies to DMs are logged from the DM queue{onX.length ? ", and X can be read here" : ""}.</p>
          {onX.length > 0 && (
            <div className="row wrap">
              <Button icon={RefreshCw} loading={xChecking} onClick={checkX}>
                Check X DMs
              </Button>
              <span className="hint">Answers to DMs cold sent as {onX.map((a) => `@${a.username}`).join(", ")}: each one stops that sequence.</span>
            </div>
          )}
          {xResult?.lines?.length ? <div className="lines">{xResult.lines.join("\n")}</div> : null}
        </div>
      </Card>

      <Card title="Last 30 days" icon={MessageSquareReply} tight actions={<TriageAll rows={rows} triage={triage} onDone={triageList.reload} />}>
        {touches.loading ? (
          <Loading />
        ) : touches.error ? (
          <div className="card-body">
            <ErrorNotice error={touches.error} />
          </div>
        ) : rows.length === 0 ? (
          <Empty icon={Inbox} title="No replies yet">
            When someone answers, opts out or bounces, they show up here.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 28 }} />
                  <th>When</th>
                  <th>What</th>
                  <th>Who</th>
                  <th>Sequence</th>
                  <th>What they wrote</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t, i) => {
                  const id = replyId(t);
                  const read = id ? triage[id] : undefined;
                  const canRead = t.kind === "REPLIED" && !!t.body?.trim();
                  const isOpen = open === (t.id ?? String(i));
                  return (
                    <Fragment key={t.id ?? i}>
                      <tr className={canRead ? "clickable" : undefined} onClick={() => canRead && setOpen(isOpen ? null : (t.id ?? String(i)))}>
                        <td>{canRead ? isOpen ? <ChevronDown size={15} className="text-3" /> : <ChevronRight size={15} className="text-3" /> : null}</td>
                        <td className="muted">{when(t.occurredAt)}</td>
                        <td>
                          <span className="row" style={{ gap: 4 }}>
                            <KindPill kind={t.kind} />
                            {read && <Pill tone={INTENT[read.intent].tone}>{INTENT[read.intent].label}</Pill>}
                          </span>
                        </td>
                        <td className="strong">
                          {t.prospectLabel ?? t.toAddress ?? t.prospectKey}
                          <div className="muted" style={{ fontWeight: 400 }}>
                            <ChannelLabel channel={t.channel} />
                          </div>
                        </td>
                        <td className="muted">{t.sequence ? `${sequenceName(t.sequence)}${t.step ? `, step ${t.step}` : ""}` : ""}</td>
                        <td className="text-2 truncate" style={{ maxWidth: 340 }} title={t.body}>
                          {read ? read.summary : t.body?.split("\n")[0]}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td />
                          <td colSpan={5} className="expand">
                            <ReplyDetail touch={t} triage={read} onTriaged={triageList.reload} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

/** The id a reply's AI reading is filed under: its Message-ID, as the server does. */
const replyId = (t: TouchRow) => (t.kind === "REPLIED" && t.body?.trim() ? (t.messageId ?? undefined) : undefined);

const INTENT: Record<Triage["intent"], { label: string; tone: Tone }> = {
  interested: { label: "Interested", tone: "green" },
  question: { label: "Question", tone: "blue" },
  not_now: { label: "Not now", tone: "amber" },
  not_interested: { label: "Not interested", tone: "gray" },
  unsubscribe: { label: "Wants out", tone: "red" },
  wrong_person: { label: "Wrong person", tone: "purple" },
  out_of_office: { label: "Away", tone: "gray" },
  other: { label: "Other", tone: "gray" },
};

async function readReply(t: TouchRow): Promise<Triage> {
  const run = await runAndWait<Triage>(() =>
    api<{ runId: string }>("/api/ai/triage", {
      method: "POST",
      body: { messageId: t.messageId, prospectKey: t.prospectKey, prospectLabel: t.prospectLabel, subject: t.subject, body: t.body, account: t.account },
    }),
  );
  return run.output!;
}

/** Read every reply that hasn't been read yet, one at a time. */
function TriageAll({ rows, triage, onDone }: { rows: TouchRow[]; triage: Record<string, Triage>; onDone: () => void }) {
  const toast = useToast();
  const [progress, setProgress] = useState<string | null>(null);
  const unread = rows.filter((t) => {
    const id = replyId(t);
    return id && !triage[id];
  });
  if (!unread.length && !progress) return null;
  async function run() {
    let done = 0;
    for (const t of unread) {
      setProgress(`${done + 1} of ${unread.length}`);
      try {
        await readReply(t);
        done++;
      } catch (err) {
        toast.error((err as ApiError).message);
        break;
      }
    }
    setProgress(null);
    onDone();
    if (done) toast.success(`Read ${done} repl${done === 1 ? "y" : "ies"}.`);
  }
  return (
    <Button size="sm" variant="ai" icon={Sparkles} loading={!!progress} onClick={run}>
      {progress ? `Reading ${progress}` : `Read ${unread.length} new with AI`}
    </Button>
  );
}

function ReplyDetail({ touch, triage, onTriaged }: { touch: TouchRow; triage?: Triage; onTriaged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError>();
  const [draft, setDraft] = useState(triage?.draft_reply ?? "");
  const [current, setCurrent] = useState<Triage | undefined>(triage);

  async function read() {
    setBusy("read");
    setError(undefined);
    try {
      const out = await readReply(touch);
      setCurrent(out);
      setDraft(out.draft_reply ?? "");
      onTriaged();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  }

  async function optOut() {
    setBusy("opt");
    try {
      const r = await api<{ message: string }>("/api/ai/opt-out", { method: "POST", body: { prospectKey: touch.prospectKey, prospectLabel: touch.prospectLabel, account: touch.account, sequence: touch.sequence, address: touch.toAddress } });
      toast.success(r.message);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(draft);
      toast.success("Copied your reply.");
    } catch {
      toast.error("The browser blocked the clipboard: select the text and copy it.");
    }
  }

  const to = touch.toAddress ?? "";
  const subject = touch.subject ? (/^re:/i.test(touch.subject) ? touch.subject : `Re: ${touch.subject}`) : "";
  return (
    <div className="stack">
      <div>
        <div className="section-label">What they wrote</div>
        <div className="message-box">{touch.body}</div>
      </div>
      {!current ? (
        <div className="row wrap">
          <Button size="sm" variant="ai" icon={Sparkles} loading={busy === "read"} onClick={read}>
            Read with AI
          </Button>
          <span className="hint">Claude sorts the reply and drafts your answer. Nothing is sent.</span>
        </div>
      ) : (
        <div className="ai-card" style={{ padding: 14 }}>
          <div className="row between wrap" style={{ marginBottom: 8 }}>
            <span className="row" style={{ gap: 6 }}>
              <Pill tone={INTENT[current.intent].tone}>{INTENT[current.intent].label}</Pill>
              <span className="strong">{current.summary}</span>
            </span>
            <Button size="sm" variant="ghost" icon={RefreshCw} loading={busy === "read"} onClick={read}>
              Read again
            </Button>
          </div>
          <p className="text-2" style={{ marginBottom: 10 }}>
            Next: {current.next_step}
            {current.follow_up_when ? ` (they said: ${current.follow_up_when})` : ""}
          </p>
          {current.intent === "unsubscribe" && (
            <Notice tone="red" title="They asked to stop" action={<Button size="sm" variant="danger" icon={Ban} loading={busy === "opt"} onClick={optOut}>Record opt-out</Button>}>
              Their reply already stops this sequence. Recording an opt-out also keeps every other sequence and channel away from them.
            </Notice>
          )}
          {draft || current.draft_reply ? (
            <>
              <div className="section-label">Your reply (edit before sending)</div>
              <textarea className="textarea" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <div className="row wrap" style={{ marginTop: 8 }}>
                <Button size="sm" icon={Copy} onClick={copy}>
                  Copy
                </Button>
                {to && (
                  <a className="btn sm" href={`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(draft)}`}>
                    <Mail size={13} /> Open in your mail app
                  </a>
                )}
                <span className="hint">Answer from your own inbox so it stays in the same thread.</span>
              </div>
            </>
          ) : null}
        </div>
      )}
      <ErrorNotice error={error} title="Could not read it" />
    </div>
  );
}
