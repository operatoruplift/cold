import { ListChecks, Phone, RefreshCw, Search, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import type { CallPrep } from "../../domains/ai/tasks";
import type { CallSheet } from "../../domains/call";
import type { ActionResponse, LibraryResponse } from "../../domains/web/types";
import { setQuery, useLocation } from "../app/router";
import { useStatus } from "../app/status";
import { runAndWait } from "../lib/ai";
import { api, ApiError, useApi } from "../lib/api";
import { voiceLabel } from "../lib/format";
import { Button, Empty, ErrorNotice, Field, Loading, Modal, Notice, PageHeader, Pill, Tabs } from "../ui/kit";
import { ProspectPicker } from "../ui/prospectPicker";

export function CallsPage() {
  const library = useApi<LibraryResponse>("/api/library");
  const { query } = useLocation();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"script" | "objections" | "ai">("script");
  const [source, setSource] = useState("");
  const [prospect, setProspect] = useState("");
  const [syncing, setSyncing] = useState(false);
  const scripts = library.data?.callScripts ?? [];
  const shown = [...scripts.filter((s) => s.voice === "personal"), ...scripts.filter((s) => s.voice === "company")];
  const selected = query.get("id") ?? shown[0]?.id ?? "";
  const params = new URLSearchParams({ id: selected, ...(source && prospect ? { source, prospect } : {}) });
  const sheet = useApi<CallSheet>(selected ? `/api/calls/sheet?${params}` : null);
  const filtered = useMemo(() => scripts.filter((s) => `${s.title} ${s.category} ${s.voice}`.toLowerCase().includes(search.toLowerCase())), [scripts, search]);

  if (library.loading) return <Loading />;
  return (
    <div className="panes">
      <div className="pane-list">
        <div className="search">
          <div className="row" style={{ position: "relative" }}>
            <Search size={14} className="text-3" style={{ position: "absolute", left: 10 }} />
            <input className="input" style={{ paddingLeft: 30 }} placeholder="Search scripts" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        {(["personal", "company"] as const).map((voice) => {
          const list = filtered.filter((s) => s.voice === voice);
          if (!list.length) return null;
          return (
            <div key={voice} className="list-group">
              <div className="list-group-title">{voice === "personal" ? "Personal: you calling" : "Company: a rep calling"}</div>
              {list.map((s) => (
                <button key={s.id} type="button" className={s.id === selected ? "list-item active" : "list-item"} onClick={() => setQuery({ id: s.id })}>
                  <div className="t">{s.title}</div>
                  <div className="s">{s.category}</div>
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div className="pane-detail">
        {!selected ? (
          <Empty icon={Phone} title="No call scripts" />
        ) : (
          <>
            <PageHeader
              title={sheet.data?.title ?? "..."}
              icon={Phone}
              sub={
                sheet.data && (
                  <span className="row wrap" style={{ gap: 6 }}>
                    <Pill tone="blue">{sheet.data.category}</Pill>
                    <Pill tone={sheet.data.voice === "personal" ? "teal" : "purple"}>{voiceLabel(sheet.data.voice)}</Pill>
                    <span>{sheet.data.when}</span>
                  </span>
                )
              }
              actions={
                <Button icon={RefreshCw} onClick={() => setSyncing(true)}>
                  Sync to dialer
                </Button>
              }
            />
            <div className="inline-fields" style={{ marginBottom: 16, maxWidth: 640 }}>
              <ProspectPicker
                source={source}
                prospect={prospect}
                onChange={(s, p) => {
                  setSource(s);
                  setProspect(p);
                }}
              />
            </div>
            <ErrorNotice error={sheet.error} />
            {sheet.data && sheet.data.missing.length > 0 && <Notice tone="amber">This prospect has no {sheet.data.missing.map((m) => `{{${m}}}`).join(", ")}: those parts are left in braces.</Notice>}
            {sheet.data && (
              <div className="card" style={{ marginTop: 12 }}>
                <Tabs
                  value={tab}
                  onChange={setTab}
                  tabs={[
                    { id: "script", label: "Script", icon: Phone },
                    { id: "objections", label: "Objections", icon: ListChecks, count: sheet.data.objections.length },
                    { id: "ai", label: "AI prep", icon: Sparkles },
                  ]}
                />
                <div className="card-body stack">
                  {tab === "ai" ? (
                    <CallPrepPanel key={`${selected}|${source}|${prospect}`} script={selected} source={source} prospect={prospect} />
                  ) : tab === "script"
                    ? sheet.data.sections.map((s) => (
                        <div key={s.heading}>
                          <div className="section-label">{s.heading}</div>
                          <div className="message-box big">{s.text}</div>
                        </div>
                      ))
                    : sheet.data.objections.map((o) => (
                        <details key={o.objection} className="card" style={{ padding: "10px 14px" }}>
                          <summary style={{ cursor: "pointer", fontWeight: 700 }}>"{o.objection}"</summary>
                          <div style={{ marginTop: 8 }} className="text-2">
                            {o.response}
                          </div>
                        </details>
                      ))}
                  {tab !== "ai" && <p className="hint">Words in [brackets] are yours to fill in live. Never read them out.</p>}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {syncing && <SyncModal onClose={() => setSyncing(false)} />}
    </div>
  );
}

/** Claude's notes for this call: an opener, questions, objection answers and a voicemail, from what's known about the prospect. */
function CallPrepPanel({ script, source, prospect }: { script: string; source: string; prospect: string }) {
  const [prep, setPrep] = useState<CallPrep>();
  const [researched, setResearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError>();

  async function run() {
    setBusy(true);
    setError(undefined);
    try {
      const run = await runAndWait<{ prep: CallPrep; researched: boolean }>(() =>
        api<{ runId: string }>("/api/ai/call", { method: "POST", body: { script, source: source || undefined, prospect: prospect || undefined } }),
      );
      setPrep(run.output!.prep);
      setResearched(run.output!.researched);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="row wrap">
        <Button variant="ai" icon={Sparkles} loading={busy} onClick={run}>
          {prep ? "Prepare again" : "Prepare me for this call"}
        </Button>
        <span className="hint">
          {prospect ? "Uses this script, your offer and what's known about the prospect" : "Pick a prospect above to tailor it to them"}. You make the call yourself: COLD never dials or speaks with an AI voice.
        </span>
      </div>
      <ErrorNotice error={error} title="No prep" />
      {prep && (
        <>
          {prospect && !researched && <Notice tone="blue">This prospect hasn't been researched yet, so the prep only uses what's on the list. Research them on the Prospects page for a sharper opener.</Notice>}
          <div>
            <div className="section-label">Open with</div>
            <div className="message-box big">{prep.opener}</div>
          </div>
          <div>
            <div className="section-label">Why you're calling</div>
            <div className="message-box">{prep.reason}</div>
          </div>
          <div>
            <div className="section-label">Ask</div>
            <ol className="message-box" style={{ paddingLeft: 34, whiteSpace: "normal" }}>
              {prep.questions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ol>
          </div>
          <div>
            <div className="section-label">If they say</div>
            <div className="stack" style={{ gap: 8 }}>
              {prep.objections.map((o) => (
                <details key={o.objection} className="card" style={{ padding: "10px 14px" }} open>
                  <summary style={{ cursor: "pointer", fontWeight: 700 }}>"{o.objection}"</summary>
                  <div style={{ marginTop: 8 }} className="text-2">
                    {o.response}
                  </div>
                </details>
              ))}
            </div>
          </div>
          <div>
            <div className="section-label">Voicemail</div>
            <div className="message-box">{prep.voicemail}</div>
          </div>
          <div>
            <div className="section-label">Ask for</div>
            <div className="message-box">{prep.next_step}</div>
          </div>
        </>
      )}
    </div>
  );
}

function SyncModal({ onClose }: { onClose: () => void }) {
  const status = useStatus();
  const [account, setAccount] = useState("");
  const [campaign, setCampaign] = useState("");
  const [result, setResult] = useState<ActionResponse>();
  const [error, setError] = useState<Error>();
  const [running, setRunning] = useState<"dry" | "real" | null>(null);

  async function run(dryRun: boolean) {
    setRunning(dryRun ? "dry" : "real");
    setError(undefined);
    try {
      setResult(await api<ActionResponse>("/api/calls/sync", { method: "POST", body: { account: account || undefined, campaign: campaign || undefined, dryRun } }));
    } catch (err) {
      setError(err as Error);
    } finally {
      setRunning(null);
    }
  }

  return (
    <Modal
      title="Sync call scripts to the dialer"
      onClose={onClose}
      footer={
        <>
          <Button loading={running === "dry"} onClick={() => run(true)}>
            Preview
          </Button>
          <Button variant="primary" loading={running === "real"} onClick={() => run(false)}>
            Sync
          </Button>
        </>
      }
    >
      <p className="text-2" style={{ marginBottom: 14 }}>
        Writes each script and its objection answers into the dialer's agencyScripts in Twenty, named with its voice. Running it again updates them.
      </p>
      {!status.data?.twenty.configured && <Notice tone="amber">Connect Twenty in Settings first.</Notice>}
      <Field label="Accounts">
        <select className="select" value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">All accounts</option>
          {(status.data?.accounts ?? []).map((a) => (
            <option key={a.key} value={a.key}>
              {a.key} ({a.voice})
            </option>
          ))}
        </select>
      </Field>
      <Field label="Dialer campaign (optional)" hint="The name of an agencyCampaign: the scripts are attached to it.">
        <input className="input" value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="Austin tint" />
      </Field>
      <div style={{ marginTop: 14 }}>
        <ErrorNotice error={error} title="Not synced" />
        {result && (
          <div className="stack">
            <Notice tone="green">{result.message}</Notice>
            {result.lines && <div className="lines">{result.lines.join("\n")}</div>}
          </div>
        )}
      </div>
    </Modal>
  );
}
