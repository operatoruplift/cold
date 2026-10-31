import { Ban, CalendarClock, Sparkles, CheckCircle2, ChevronDown, ChevronRight, Clock, Copy, Download, ExternalLink, Hourglass, Mail, MessageSquareReply, Pencil, RefreshCw, Send, SkipForward, Square, Trash2, UserX, XCircle } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { AiDraftRecord } from "../../domains/ai/store";
import type { Campaign, JobEvent, JobResponse, PlanResponse, PlanRow } from "../../domains/web/types";
import { navigate } from "../app/router";
import { useStatus } from "../app/status";
import { api, ApiError, useApi } from "../lib/api";
import { channelLabel, day, plural, sequenceName, sourceLabel, voiceLabel } from "../lib/format";
import { Button, Card, Empty, ErrorNotice, initials, Loading, Modal, Notice, PageHeader, Pill, Stat, Tabs } from "../ui/kit";
import { AiDraft } from "../ui/aiDraft";
import { ScoreCell } from "../ui/decide";
import { useToast } from "../ui/toast";
import { CampaignForm } from "./campaignForm";

type Tab = "due" | "waiting" | "skipped" | "held";

export function CampaignPage({ id }: { id: string }) {
  const campaigns = useApi<Campaign[]>("/api/campaigns");
  const [refresh, setRefresh] = useState(0);
  const plan = useApi<PlanResponse>(`/api/campaigns/${id}/plan${refresh ? `?refresh=1&n=${refresh}` : ""}`);
  const drafts = useApi<AiDraftRecord[]>(`/api/ai/drafts?campaignId=${encodeURIComponent(id)}`);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toast = useToast();
  const campaign = campaigns.data?.find((c) => c.id === id);

  if (campaigns.loading) return <Loading />;
  if (!campaign) {
    return (
      <Empty icon={XCircle} title="No such campaign" action={<Button onClick={() => navigate("/campaigns")}>All campaigns</Button>}>
        It may have been deleted.
      </Empty>
    );
  }

  const p = plan.data;
  const isEmail = campaign.sequence.startsWith("email/");
  const voice = campaign.sequence.split("/")[1] as "personal" | "company";

  async function remove() {
    try {
      await api(`/api/campaigns/${id}`, { method: "DELETE" });
      toast.success(`Deleted ${campaign!.name}. Its touch history stays in the log.`);
      navigate("/campaigns");
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title={campaign.name}
        sub={
          <span className="row wrap" style={{ gap: 6 }}>
            <Pill tone="blue">{channelLabel(isEmail ? "email" : "dm", p?.platform)}</Pill>
            <Pill tone={voice === "personal" ? "teal" : "purple"}>{voiceLabel(voice)}</Pill>
            <span>
              {sequenceName(campaign.sequence)} from <b>{campaign.account}</b> to {sourceLabel(campaign.source)}
              {campaign.where ? ` (${campaign.where})` : ""}
            </span>
          </span>
        }
        actions={
          <>
            <Button icon={RefreshCw} loading={plan.loading} onClick={() => setRefresh((n) => n + 1)} title="Reload the prospect list">
              Refresh
            </Button>
            <Button icon={Pencil} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button icon={Trash2} variant="danger" onClick={() => setConfirmDelete(true)} aria-label="Delete campaign" />
          </>
        }
      />

      {plan.error && <ErrorNotice error={plan.error} title="Could not work out this campaign" />}
      {!p && plan.loading && <Loading label="Working out who is due" />}

      {p && (
        <>
          {p.blockers.map((b) => (
            <Notice key={b} tone="amber">
              {b}
            </Notice>
          ))}
          <div className="grid stats" style={{ marginTop: p.blockers.length ? 16 : 0 }}>
            <Stat label="Due now" icon={Send} tone="blue" value={p.due.length} note={p.due.length > p.sendable ? `${p.sendable} fit today's cap` : `${p.sentToday} of ${p.cap} sent today`} />
            <Stat label="Waiting" icon={CalendarClock} tone="gray" value={p.waiting.length} note="Next step on a later day" />
            <Stat label="Skipped" icon={UserX} tone="amber" value={p.skipped.length} note="Replied, opted out, finished..." />
            <Stat label="Held back" icon={Hourglass} tone="red" value={p.held.length} note="A message with a blank" />
          </div>
          {isEmail ? (
            <EmailSender plan={p} campaign={campaign} onDone={() => plan.reload()} />
          ) : (
            <DmQueue plan={p} campaign={campaign} drafts={drafts.data ?? []} onChange={() => (plan.reload(), drafts.reload())} />
          )}
          <PlanTabs plan={p} campaign={campaign} drafts={drafts.data ?? []} onChanged={() => (plan.reload(), drafts.reload())} />
        </>
      )}

      {editing && (
        <CampaignForm
          campaign={campaign}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            campaigns.reload();
            setRefresh((n) => n + 1);
          }}
        />
      )}
      {confirmDelete && (
        <Modal
          title="Delete this campaign?"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
              <Button variant="danger" icon={Trash2} onClick={remove}>
                Delete
              </Button>
            </>
          }
        >
          The campaign is removed from this list. Everything already sent, replied and opted out stays in the touch log, so nobody gets step 1 again if you recreate it.
        </Modal>
      )}
    </>
  );
}

/* Email: plan, confirm, send with live progress. */

function EmailSender({ plan, campaign, onDone }: { plan: PlanResponse; campaign: Campaign; onDone: () => void }) {
  const storageKey = `cold-job-${campaign.id}`;
  const [job, setJob] = useState<{ id: string; total: number } | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    } catch {
      return null;
    }
  });
  const [confirming, setConfirming] = useState(false);
  const [ignoreWindow, setIgnoreWindow] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<ApiError>();
  const toast = useToast();

  const windowClosed = plan.window && !plan.window.open;
  const canSend = plan.sendable > 0 && plan.blockers.length === 0 && (!windowClosed || ignoreWindow);

  async function start() {
    setStarting(true);
    setError(undefined);
    try {
      const started = await api<{ job: string; total: number }>(`/api/campaigns/${campaign.id}/send`, { method: "POST", body: { ignoreWindow } });
      const running = { id: started.job, total: started.total };
      sessionStorage.setItem(storageKey, JSON.stringify(running));
      setJob(running);
      setConfirming(false);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setStarting(false);
    }
  }

  if (job) {
    return (
      <SendProgress
        jobId={job.id}
        total={job.total}
        onFinished={onDone}
        onClose={() => {
          sessionStorage.removeItem(storageKey);
          setJob(null);
          onDone();
        }}
        onLost={() => {
          sessionStorage.removeItem(storageKey);
          setJob(null);
          toast.error("That send is no longer running (the app was restarted). Its results are in the log.");
          onDone();
        }}
      />
    );
  }

  return (
    <Card
      title="Send"
      icon={Mail}
      actions={
        plan.window && (
          <Pill tone={plan.window.open ? "green" : "amber"} icon={Clock}>
            {plan.window.open ? "Sending window open" : "Outside the sending window"}: {plan.window.text}
          </Pill>
        )
      }
    >
      <div className="row wrap between">
        <div className="text-2">
          {plan.sendable > 0 ? (
            <>
              <b className="strong">{plural(plan.sendable, "email")}</b> ready from <b>{plan.account.from}</b>. They go out one at a time
              {plan.pace ? `, ${plan.pace.min} to ${plan.pace.max} seconds apart` : ""}, and each is logged before the next.
            </>
          ) : plan.due.length > 0 ? (
            "Today's cap is used up. The rest go out tomorrow."
          ) : (
            "Nobody is due right now. Check back tomorrow, or add prospects."
          )}
        </div>
        <div className="row">
          {windowClosed && plan.sendable > 0 && (
            <label className="check">
              <input type="checkbox" checked={ignoreWindow} onChange={(e) => setIgnoreWindow(e.target.checked)} /> Send anyway
            </label>
          )}
          <Button variant="primary" size="lg" icon={Send} disabled={!canSend} onClick={() => setConfirming(true)}>
            Send {plan.sendable > 0 ? plural(plan.sendable, "email") : ""}
          </Button>
        </div>
      </div>
      {confirming && (
        <Modal
          title={`Send ${plural(plan.sendable, "email")}?`}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button variant="primary" icon={Send} loading={starting} onClick={start}>
                Send now
              </Button>
            </>
          }
        >
          <ErrorNotice error={error} title="Not started" />
          <dl className="kv" style={{ marginTop: error ? 14 : 0 }}>
            <dt>From</dt>
            <dd>{plan.account.from}</dd>
            <dt>To</dt>
            <dd>{plural(plan.sendable, "prospect")}, step by step in the sequence</dd>
            <dt>Pace</dt>
            <dd>{plan.pace ? `One every ${plan.pace.min} to ${plan.pace.max} seconds` : "One at a time"}</dd>
            <dt>Stops by itself</dt>
            <dd>If the mailbox refuses, three fail in a row, or the window closes</dd>
          </dl>
          <p className="hint" style={{ marginTop: 14 }}>
            You can leave this page; the app keeps sending. Keep the app running until it finishes.
          </p>
        </Modal>
      )}
    </Card>
  );
}

const EVENT_ICON = { sent: CheckCircle2, failed: XCircle, skipped: SkipForward, pause: Clock, stopped: Square, error: XCircle };

function SendProgress({ jobId, total, onFinished, onClose, onLost }: { jobId: string; total: number; onFinished: () => void; onClose: () => void; onLost: () => void }) {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [job, setJob] = useState<JobResponse>();
  const [stopping, setStopping] = useState(false);
  const next = useRef(0);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const view = await api<JobResponse>(`/api/jobs/${jobId}?after=${next.current}`);
        if (!alive) return;
        next.current = view.next;
        if (view.events.length) setEvents((all) => [...all, ...view.events]);
        setJob(view);
        if (view.status === "running") setTimeout(poll, 1000);
        else onFinished();
      } catch (err) {
        if (alive && (err as ApiError).status === 404) onLost();
        else if (alive) setTimeout(poll, 2000);
      }
    }
    poll();
    return () => {
      alive = false;
    };
  }, [jobId]);

  const sent = events.filter((e) => e.type === "sent").length;
  const failed = events.filter((e) => e.type === "failed").length;
  const done = job?.status === "done";
  const lastPause = [...events].reverse().find((e) => e.type === "pause");
  const result = job?.result;

  async function stop() {
    setStopping(true);
    await api(`/api/jobs/${jobId}/stop`, { method: "POST" }).catch(() => {});
  }

  return (
    <Card
      title={done ? "Send finished" : "Sending"}
      icon={Send}
      actions={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <Button icon={Square} variant="danger" loading={stopping} onClick={stop}>
            {stopping ? "Stopping after this email" : "Stop"}
          </Button>
        )
      }
    >
      <div className="stack">
        <div className="row between">
          <b>
            {sent} of {total} sent{failed ? `, ${failed} failed` : ""}
          </b>
          {!done && lastPause?.type === "pause" && <span className="text-3">Next one in about {lastPause.seconds} seconds</span>}
        </div>
        <div className="progress">
          <span style={{ width: `${total ? Math.min(100, ((sent + failed) / total) * 100) : 0}%` }} />
        </div>
        {done && result?.aborted && <Notice tone="amber" title="Stopped early">{result.aborted}</Notice>}
        {done && !result?.aborted && <Notice tone="green" title="All done">{plural(result?.sent ?? sent, "email")} sent and logged.</Notice>}
        <div className="events">
          {events
            .filter((e) => e.type !== "pause")
            .map((e, i) => {
              const Icon = EVENT_ICON[e.type];
              const tone = e.type === "sent" ? "text-green" : e.type === "skipped" ? "text-amber" : "text-red";
              return (
                <div key={i} className="event">
                  <Icon size={15} className={tone} />
                  {"label" in e ? (
                    <>
                      <b>{e.label}</b>
                      <span className="text-3">{e.address}</span>
                      {"step" in e && <span className="text-3">step {e.step}</span>}
                      {"reason" in e && <span className={tone}>{e.reason}</span>}
                    </>
                  ) : (
                    <span className={tone}>{"reason" in e ? e.reason : ""}</span>
                  )}
                </div>
              );
            })}
          {!events.length && !done && <Loading label="Connecting to the mailbox" />}
        </div>
      </div>
    </Card>
  );
}

/* DMs: one at a time, you send it, then say what happened. */

function DmQueue({ plan, campaign, drafts, onChange }: { plan: PlanResponse; campaign: Campaign; drafts: AiDraftRecord[]; onChange: () => void }) {
  const status = useStatus();
  const toast = useToast();
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const queue = plan.due.slice(0, plan.sendable).filter((r) => !skipped.has(r.key) && !done.has(r.key));
  const current = queue[0];
  const blocked = !!status.data?.isExample;
  const platform = channelLabel("dm", plan.platform);

  const copy = useCallback(async () => {
    if (!current?.text) return;
    try {
      await navigator.clipboard.writeText(current.text);
      toast.success("Copied. Paste it into the conversation.");
    } catch {
      toast.error("The browser blocked the clipboard: select the text and copy it.");
    }
  }, [current, toast]);

  const open = useCallback(() => current?.url && window.open(current.url, "_blank", "noopener"), [current]);

  const record = useCallback(
    async (outcome: "SENT" | "REPLIED" | "OPTED_OUT") => {
      if (!current || busy) return;
      setBusy(outcome);
      try {
        await api(`/api/campaigns/${campaign.id}/dm`, { method: "POST", body: { prospect: current.key, outcome } });
        setDone((s) => new Set(s).add(current.key));
        toast.success(outcome === "SENT" ? `Logged: sent to ${current.label}.` : outcome === "REPLIED" ? `Logged the reply. ${current.label} gets nothing more automatically.` : `Logged the opt-out. ${current.label} will not be contacted again.`);
        onChange();
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [current, busy, campaign.id, onChange, toast],
  );

  const skip = useCallback(() => current && setSkipped((s) => new Set(s).add(current.key)), [current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select")) return;
      const key = e.key.toLowerCase();
      if (key === "c") copy();
      else if (key === "p") open();
      else if (key === "k") skip();
      else if (!blocked && key === "s") record("SENT");
      else if (!blocked && key === "r") record("REPLIED");
      else if (!blocked && key === "o") record("OPTED_OUT");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [copy, open, skip, record, blocked]);

  async function downloadChecklist() {
    const response = await fetch(`/api/campaigns/${campaign.id}/checklist`, { headers: { "x-cold": "1" } });
    if (!response.ok) return toast.error("Could not build the checklist.");
    const url = URL.createObjectURL(await response.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: `${campaign.name.replace(/[^\w-]+/g, "-")}-dms.md` });
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card
      title={`${platform} queue`}
      icon={Send}
      actions={
        <>
          <span className="hint">
            {plan.sentToday} of {plan.cap} sent today
          </span>
          <Button size="sm" icon={Download} onClick={downloadChecklist} disabled={!plan.due.length}>
            Checklist
          </Button>
        </>
      }
    >
      {!current ? (
        <Empty icon={CheckCircle2} title={plan.due.length ? "That's everyone for now" : "Nobody is due right now"}>
          {plan.due.length > plan.sendable ? "Today's cap is used up; the rest are due tomorrow." : "New steps fall due on their day. Check back tomorrow."}
          {skipped.size > 0 && " Skipped ones come back next time you open this page."}
        </Empty>
      ) : (
        <div className="grid two" style={{ alignItems: "start" }}>
          <div className="dm-card">
            <div className="dm-card-head">
              <span className="avatar">{initials(current.label)}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="strong truncate">{current.label}</div>
                <div className="text-3 truncate">{current.url}</div>
              </div>
              <Pill tone="blue">
                Step {current.step}: {current.stepTitle}
              </Pill>
            </div>
            <div className="dm-card-body">
              {current.when && <div className="hint">{current.when}</div>}
              <div className="message-box big">{current.text}</div>
              <div className="hint">
                {current.text?.length} characters{current.custom ? ", your approved AI draft" : ""}
              </div>
              <AiDraft campaignId={campaign.id} row={current} channel="dm" existing={drafts.find((d) => d.prospectKey === current.key && d.step === (current.step ?? 1))} onChanged={onChange} />
              <div className="dm-actions">
                <Button icon={Copy} onClick={copy}>
                  Copy message <kbd>C</kbd>
                </Button>
                <Button icon={ExternalLink} onClick={open}>
                  Open profile <kbd>P</kbd>
                </Button>
              </div>
              {blocked && <Notice tone="amber">Create cold.yaml in Settings to log DMs: right now they would be signed and logged as the example sender.</Notice>}
              <div className="dm-outcomes">
                <Button variant="success" icon={CheckCircle2} loading={busy === "SENT"} disabled={blocked} onClick={() => record("SENT")}>
                  I sent it <kbd>S</kbd>
                </Button>
                <Button icon={SkipForward} onClick={skip}>
                  Skip <kbd>K</kbd>
                </Button>
                <Button icon={MessageSquareReply} loading={busy === "REPLIED"} disabled={blocked} onClick={() => record("REPLIED")}>
                  Replied <kbd>R</kbd>
                </Button>
                <Button variant="danger" icon={Ban} loading={busy === "OPTED_OUT"} disabled={blocked} onClick={() => record("OPTED_OUT")}>
                  Opted out <kbd>O</kbd>
                </Button>
              </div>
            </div>
          </div>
          <div>
            <div className="section-label">Up next ({queue.length - 1})</div>
            {queue.length <= 1 ? (
              <p className="text-3">This is the last one for today.</p>
            ) : (
              <table className="table card" style={{ display: "table" }}>
                <tbody>
                  {queue.slice(1, 12).map((r) => (
                    <tr key={r.key}>
                      <td className="strong">{r.label}</td>
                      <td className="muted">
                        Step {r.step}: {r.stepTitle}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="hint" style={{ marginTop: 12 }}>
              You send each DM yourself, from your own account: {platform.replace(" DM", "")} restricts accounts that send them automatically. cold writes it, counts the daily cap and logs what happened.
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}

/* Everyone in the plan, by state. */

function PlanTabs({ plan, campaign, drafts, onChanged }: { plan: PlanResponse; campaign: Campaign; drafts: AiDraftRecord[]; onChanged: () => void }) {
  const [tab, setTab] = useState<Tab>(plan.due.length ? "due" : plan.waiting.length ? "waiting" : "skipped");
  const [open, setOpen] = useState<string | null>(null);
  const rows: Record<Tab, PlanRow[]> = { due: plan.due, waiting: plan.waiting, skipped: plan.skipped, held: plan.held };
  const list = rows[tab];
  return (
    <Card tight>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "due", label: "Due now", count: plan.due.length },
          { id: "waiting", label: "Waiting", count: plan.waiting.length },
          { id: "skipped", label: "Skipped", count: plan.skipped.length },
          { id: "held", label: "Held back", count: plan.held.length },
        ]}
      />
      {list.length === 0 ? (
        <Empty icon={CheckCircle2} title="Nobody here" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {list.map((r) => {
                const expandable = tab === "due" && !!r.text;
                const isOpen = open === r.key;
                return (
                  <Fragment key={r.key}>
                    <tr className={expandable ? "clickable" : undefined} onClick={() => expandable && setOpen(isOpen ? null : r.key)}>
                      <td style={{ width: 28 }}>{expandable ? isOpen ? <ChevronDown size={15} className="text-3" /> : <ChevronRight size={15} className="text-3" /> : null}</td>
                      <td>
                        <div className="strong row wrap" style={{ gap: 6 }}>
                          {r.label} {r.score !== undefined && r.tier && <ScoreCell score={r.score} tier={r.tier} compact />} {r.custom && <span className="ai-badge">AI draft approved</span>}
                        </div>
                        {r.address && <div className="muted truncate" style={{ maxWidth: 360 }}>{r.address}</div>}
                      </td>
                      <td>
                        {r.step ? (
                          <Pill tone="gray">
                            Step {r.step}: {r.stepTitle}
                          </Pill>
                        ) : null}
                      </td>
                      <td className="text-2">
                        {tab === "due" && (r.subject ?? "")}
                        {tab === "waiting" && r.dueOn && <>Due {day(r.dueOn)}</>}
                        {(tab === "skipped" || tab === "held") && <Pill tone={/opted out|Do Not Contact|bounced/i.test(r.reason ?? "") ? "red" : tab === "held" ? "amber" : "gray"}>{r.reason}</Pill>}
                      </td>
                    </tr>
                    {expandable && isOpen && (
                      <tr>
                        <td />
                        <td colSpan={3} className="expand">
                          {r.subject && <div className="subject">{r.subject}</div>}
                          <div className="message-box">{r.text}</div>
                          <AiDraft campaignId={campaign.id} row={r} channel={plan.channel === "email" ? "email" : "dm"} existing={drafts.find((d) => d.prospectKey === r.key && d.step === (r.step ?? 1))} onChanged={onChanged} />
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
      {tab === "held" && plan.held.length > 0 && (
        <div className="card-body row between wrap">
          <span className="hint">Each of these messages uses a variable this prospect has no value for (often the trigger line). Research them to find a true one, or add it to the list (a CSV column, or the coldTrigger field in Twenty), then press Refresh.</span>
          <Button size="sm" variant="ai" icon={Sparkles} onClick={() => navigate(`/prospects?tab=research&source=${encodeURIComponent(campaign.source)}`)}>
            Research them
          </Button>
        </div>
      )}
    </Card>
  );
}
