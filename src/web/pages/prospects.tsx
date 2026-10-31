import { CheckCircle2, ExternalLink, Gauge, Globe, History, Mail, MapPin, Phone, Plus, Save, Search, Sparkles, Square, SquareCheck, Telescope, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FindResult, FoundProspect, Research } from "../../domains/ai/tasks";
import type { AiStatusResponse, ProspectSummary, SourceOption } from "../../domains/web/types";
import { navigate, setQuery, useLocation } from "../app/router";
import { useStatus } from "../app/status";
import { runAndWait, useAiRun } from "../lib/ai";
import { api, ApiError, useApi } from "../lib/api";
import { ago, sourceLabel } from "../lib/format";
import { Button, Card, Empty, ErrorNotice, Field, Loading, Notice, PageHeader, Pill, Tabs } from "../ui/kit";
import { useToast } from "../ui/toast";
import { ScoreLists } from "./score";

type Tab = "find" | "research" | "score";

export function ProspectsPage() {
  const { query } = useLocation();
  const ai = useApi<AiStatusResponse>("/api/ai/status");
  const tab: Tab = query.get("tab") === "research" ? "research" : query.get("tab") === "score" ? "score" : "find";
  return (
    <>
      <PageHeader
        title="Prospects"
        sub="Find businesses that fit your offer, research the people already on your lists, score who is most likely to buy, and give every message one true reason to reach out."
        actions={<span className="ai-badge"><Sparkles size={12} /> {ai.data?.model ?? "Claude"}</span>}
      />
      {ai.data && !ai.data.configured && (
        <Notice tone="blue" title="Connect Claude to use AI prospecting" action={<Button variant="primary" onClick={() => navigate("/settings")}>Open Settings</Button>}>
          Add your Anthropic API key (ANTHROPIC_API_KEY) under Connections in Settings. Research uses Claude with web search; you see every source it used.
        </Notice>
      )}
      <Card tight className="ai-card">
        <Tabs<Tab>
          value={tab}
          onChange={(t) => setQuery({ tab: t === "find" ? undefined : t, run: undefined })}
          tabs={[
            { id: "find", label: "Find new prospects", icon: Telescope },
            { id: "research", label: "Research my lists", icon: Search },
            { id: "score", label: "Score and prioritize", icon: Gauge },
          ]}
        />
        <div className="card-body">{tab === "find" ? <Finder ai={ai.data} onRan={ai.reload} /> : tab === "research" ? <ResearchLists /> : <ScoreLists />}</div>
      </Card>
    </>
  );
}

/* ------------------------------------------------------------------ Find */

function Finder({ ai, onRan }: { ai?: AiStatusResponse; onRan: () => void }) {
  const status = useStatus();
  const sources = useApi<SourceOption[]>("/api/sources");
  const { query } = useLocation();
  const runId = query.get("run") ?? undefined;
  const [offer, setOffer] = useState("");
  const [area, setArea] = useState("");
  const [count, setCount] = useState(8);
  const [notes, setNotes] = useState("");
  const [exclude, setExclude] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<ApiError>();
  const { run, error: runError, elapsed } = useAiRun<FindResult>(runId);
  const offers = status.data?.offers ?? [];

  useEffect(() => {
    if (run && run.status !== "running") onRan();
  }, [run?.status, onRan]);

  async function start() {
    setStarting(true);
    setError(undefined);
    try {
      const { runId: id } = await api<{ runId: string }>("/api/ai/find", { method: "POST", body: { offer: offer || undefined, area, count, notes: notes || undefined, exclude: exclude || undefined } });
      setQuery({ run: id });
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setStarting(false);
    }
  }

  const running = run?.status === "running";
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="inline-fields">
        <Field label="Offer">
          <select className="select" value={offer} onChange={(e) => setOffer(e.target.value)}>
            {offers.map((o) => (
              <option key={o.key} value={o.key}>
                {o.key}
                {o.audience ? `: ${o.audience}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Where">
          <input className="input" value={area} onChange={(e) => setArea(e.target.value)} placeholder="Austin, TX  ·  North London  ·  online" />
        </Field>
        <Field label="How many">
          <select className="select" value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[3, 5, 8, 10, 15].map((n) => (
              <option key={n} value={n}>
                Up to {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Skip anyone already on">
          <select className="select" value={exclude} onChange={(e) => setExclude(e.target.value)}>
            <option value="">No list</option>
            {(sources.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Anything else? (optional)" hint="e.g. owner-run shops only, no chains; at least 4 stars; opened in the last two years.">
        <textarea className="textarea" style={{ minHeight: 64 }} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="row wrap">
        <Button variant="primary" icon={Sparkles} onClick={start} loading={starting} disabled={!area.trim() || running || !ai?.configured}>
          Find prospects
        </Button>
        <span className="hint">Claude searches the web and reads the pages it finds. A search takes one to three minutes and stays running if you leave this page.</span>
      </div>
      <ErrorNotice error={error ?? runError} title="Could not search" />
      {running && (
        <div className="ai-thinking">
          <span className="dots">
            <i />
            <i />
            <i />
          </span>
          Searching for “{(run.input as { area?: string }).area}”… {elapsed}s
        </div>
      )}
      {run?.status === "failed" && <Notice tone="red" title="The search failed">{run.error}</Notice>}
      {run?.status === "done" && run.output && <FindResults runId={run.id} result={run.output} />}
      {!runId && <RecentFinds finds={ai?.finds ?? []} />}
    </div>
  );
}

function RecentFinds({ finds }: { finds: AiStatusResponse["finds"] }) {
  if (!finds.length) return null;
  return (
    <div>
      <div className="section-label">Recent searches</div>
      <div className="stack" style={{ gap: 6 }}>
        {finds.map((f) => (
          <button key={f.id} type="button" className="list-item" style={{ borderRadius: 10, border: "1px solid var(--border)" }} onClick={() => setQuery({ run: f.id })}>
            <div className="row between">
              <span className="t">
                <History size={13} className="text-3" /> {f.input.area} {f.input.offer ? <span className="text-3">· {f.input.offer}</span> : null}
              </span>
              <span className="s">{ago(f.createdAt)}</span>
            </div>
            <div className="s">{f.status === "running" ? "Still searching…" : f.status === "failed" ? `Failed: ${f.error ?? ""}` : `${f.found} found`}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function FindResults({ runId, result }: { runId: string; result: FindResult }) {
  const toast = useToast();
  const [picked, setPicked] = useState<Set<number>>(() => new Set(result.prospects.map((_, i) => i)));
  const [list, setList] = useState("ai");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ source: string; file: string; added: number; skipped: number }>();
  const [error, setError] = useState<ApiError>();
  const toggle = (i: number) => setPicked((p) => (p.has(i) ? new Set([...p].filter((x) => x !== i)) : new Set([...p, i])));

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      const r = await api<{ source: string; file: string; added: number; skipped: number }>("/api/ai/prospects/save", { method: "POST", body: { runId, picks: [...picked], list } });
      setSaved(r);
      toast.success(`Saved ${r.added} to ${r.file}${r.skipped ? ` (${r.skipped} already there)` : ""}.`);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setSaving(false);
    }
  }

  if (!result.prospects.length)
    return (
      <Empty icon={Telescope} title="No prospects matched">
        {result.searched_for} Try a wider area, or fewer conditions.
      </Empty>
    );
  return (
    <div className="stack">
      <div className="row between wrap">
        <span className="text-2">{result.searched_for}</span>
        <Button size="sm" variant="ghost" onClick={() => setPicked(picked.size === result.prospects.length ? new Set() : new Set(result.prospects.map((_, i) => i)))}>
          {picked.size === result.prospects.length ? "Select none" : "Select all"}
        </Button>
      </div>
      <div>
        {result.prospects.map((p, i) => (
          <FoundCard key={`${p.company}-${i}`} p={p} picked={picked.has(i)} onToggle={() => toggle(i)} />
        ))}
      </div>
      <ErrorNotice error={error} title="Not saved" />
      <div className="row wrap" style={{ gap: 10, padding: 14, borderRadius: 14, background: "var(--bg-subtle)", border: "1px solid var(--border)" }}>
        <span className="strong">Save {picked.size} to</span>
        <span className="row" style={{ gap: 4 }}>
          <span className="text-3">prospects-</span>
          <input className="input" style={{ width: 140 }} value={list} onChange={(e) => setList(e.target.value)} aria-label="List name" />
          <span className="text-3">.csv</span>
        </span>
        <Button variant="primary" icon={Save} loading={saving} disabled={!picked.size} onClick={save}>
          Save to list
        </Button>
        {saved && (
          <Button icon={Plus} onClick={() => navigate(`/campaigns?new=1&source=${encodeURIComponent(saved.source)}`)}>
            Start a campaign with them
          </Button>
        )}
      </div>
      <p className="hint">Sources are the pages Claude opened during this search. Contact details are only what the business publishes; check them before you reach out.</p>
    </div>
  );
}

function FoundCard({ p, picked, onToggle }: { p: FoundProspect; picked: boolean; onToggle: () => void }) {
  const sources = p.verified_sources ?? [];
  const dropped = (p.sources?.length ?? 0) - sources.length;
  return (
    <div className={`prospect-card${picked ? " picked" : ""}`}>
      <button type="button" className="btn ghost sm" onClick={onToggle} aria-label={picked ? `Leave out ${p.company}` : `Pick ${p.company}`} style={{ padding: 4 }}>
        {picked ? <SquareCheck size={18} className="text-blue" /> : <Square size={18} className="text-3" />}
      </button>
      <div style={{ minWidth: 0 }}>
        <h3>{p.company}</h3>
        <div className="meta">
          {[p.city, p.contact_name ? `${p.contact_name}${p.contact_title ? `, ${p.contact_title}` : ""}` : undefined].filter(Boolean).join(" · ")}
        </div>
        {p.trigger ? (
          <div className="why">
            {p.trigger}
            {p.trigger_date ? <span className="text-3"> ({p.trigger_date})</span> : null}
          </div>
        ) : (
          <div className="meta">No recent trigger found: research them again before reaching out.</div>
        )}
        <div className="facts">
          <span>{p.fit}</span>
          <span className="row wrap" style={{ gap: 12 }}>
            {p.website && (
              <a href={p.website} target="_blank" rel="noopener noreferrer">
                <Globe size={12} /> {p.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
              </a>
            )}
            {p.email && (
              <span>
                <Mail size={12} /> {p.email}
              </span>
            )}
            {p.phone && (
              <span>
                <Phone size={12} /> {p.phone}
              </span>
            )}
            {p.city && (
              <span>
                <MapPin size={12} /> {p.city}
              </span>
            )}
          </span>
        </div>
        {sources.length > 0 && (
          <div className="sources" style={{ marginTop: 8 }}>
            {sources.slice(0, 4).map((s) => (
              <a key={s} href={s} target="_blank" rel="noopener noreferrer" title={s}>
                <ExternalLink size={11} /> {s.replace(/^https?:\/\/(www\.)?/, "")}
              </a>
            ))}
          </div>
        )}
        {dropped > 0 && <div className="hint" style={{ marginTop: 4 }}>{dropped} source{dropped === 1 ? "" : "s"} left out: Claude didn't open {dropped === 1 ? "it" : "them"} during this search.</div>}
      </div>
      <div className="row" style={{ gap: 4 }}>
        {p.email ? <Pill tone="green">Email</Pill> : null}
        {p.phone ? <Pill tone="blue">Phone</Pill> : null}
        {p.linkedin_url || p.instagram_handle || p.facebook_url ? <Pill tone="purple">Social</Pill> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Research */

function ResearchLists() {
  const sources = useApi<SourceOption[]>("/api/sources");
  const { query } = useLocation();
  const [source, setSource] = useState(query.get("source") ?? "");
  const chosen = source || sources.data?.[0]?.id || "";
  const list = useApi<{ total: number; prospects: ProspectSummary[] }>(chosen ? `/api/prospects?source=${encodeURIComponent(chosen)}` : null);
  const keys = useMemo(() => (list.data?.prospects ?? []).map((p) => p.key), [list.data]);
  const researched = useApi<Record<string, { runId: string; createdAt: string; output: Research }>>(keys.length ? `/api/ai/research?keys=${encodeURIComponent(keys.slice(0, 400).join(","))}` : null);
  const [open, setOpen] = useState<string>();
  const [busy, setBusy] = useState<Record<string, number>>({});
  const [error, setError] = useState<ApiError>();
  const toast = useToast();

  async function research(p: ProspectSummary) {
    setBusy((b) => ({ ...b, [p.key]: 0 }));
    setError(undefined);
    try {
      await runAndWait<Research>(
        () => api<{ runId: string }>("/api/ai/research", { method: "POST", body: { source: chosen, prospect: p.key } }),
        (s) => setBusy((b) => ({ ...b, [p.key]: s })),
      );
      researched.reload();
      setOpen(p.key);
      toast.success(`Researched ${p.label}.`);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy((b) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== p.key)));
    }
  }

  async function apply(p: ProspectSummary, trigger: string) {
    try {
      const r = await api<{ message: string }>("/api/ai/research/apply", { method: "POST", body: { source: chosen, prospect: p.key, trigger } });
      toast.success(r.message);
      list.reload();
    } catch (err) {
      setError(err as ApiError);
    }
  }

  const prospects = list.data?.prospects ?? [];
  return (
    <div className="stack">
      <div className="inline-fields">
        <Field label="List">
          <select className="select" value={chosen} onChange={(e) => setSource(e.target.value)}>
            {(sources.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="hint">
        Research reads each prospect's site and public footprint, and suggests one true sentence for <code>{"{{trigger}}"}</code>, the line every template opens with. Saving it writes it into {chosen ? sourceLabel(chosen) : "the list"}.
      </p>
      <ErrorNotice error={error ?? list.error} title="Research failed" />
      {list.loading && !list.data ? (
        <Loading />
      ) : !prospects.length ? (
        <Empty icon={Search} title="This list is empty" />
      ) : (
        <div className="table-wrap" style={{ border: "1px solid var(--border)", borderRadius: 14 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Prospect</th>
                <th>Trigger now</th>
                <th>Research</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {prospects.map((p) => {
                const r = researched.data?.[p.key];
                const seconds = busy[p.key];
                return (
                  <ResearchRow
                    key={p.key}
                    p={p}
                    research={r?.output}
                    when={r?.createdAt}
                    open={open === p.key}
                    onToggle={() => setOpen(open === p.key ? undefined : p.key)}
                    seconds={seconds}
                    onResearch={() => research(p)}
                    onApply={(t) => apply(p, t)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ResearchRow({
  p,
  research,
  when,
  open,
  onToggle,
  seconds,
  onResearch,
  onApply,
}: {
  p: ProspectSummary;
  research?: Research;
  when?: string;
  open: boolean;
  onToggle: () => void;
  seconds?: number;
  onResearch: () => void;
  onApply: (trigger: string) => void;
}) {
  const busy = seconds !== undefined;
  return (
    <>
      <tr>
        <td>
          <div className="strong">{p.label}</div>
          <div className="muted">{[p.city, p.email].filter(Boolean).join(" · ")}</div>
        </td>
        <td style={{ maxWidth: 320 }}>{p.trigger ? <span className="text-2">{p.trigger}</span> : <Pill tone="amber">No trigger</Pill>}</td>
        <td>
          {research ? (
            <button type="button" className="btn ghost sm" onClick={onToggle}>
              <Pill tone={research.fit === "strong" ? "green" : research.fit === "possible" ? "blue" : "gray"}>{research.fit} fit</Pill>
              <span className="text-3">{when ? ago(when) : ""}</span>
            </button>
          ) : (
            <span className="muted">-</span>
          )}
        </td>
        <td style={{ textAlign: "right" }}>
          <Button size="sm" variant="ai" icon={busy ? undefined : research ? Wand2 : Sparkles} loading={busy} onClick={onResearch} disabled={p.doNotContact}>
            {busy ? `${seconds}s` : research ? "Again" : "Research"}
          </Button>
        </td>
      </tr>
      {open && research && (
        <tr>
          <td colSpan={4} style={{ background: "var(--bg-subtle)" }}>
            <div className="stack" style={{ gap: 10, padding: "6px 4px" }}>
              <p>{research.summary}</p>
              {research.triggers.length > 0 && (
                <div>
                  <div className="section-label">Reasons to reach out</div>
                  <div className="stack" style={{ gap: 6 }}>
                    {research.triggers.map((t) => (
                      <div key={t.sentence} className="row between wrap" style={{ gap: 10 }}>
                        <span>
                          {t.sentence} {t.when ? <span className="text-3">({t.when})</span> : null}{" "}
                          <a href={t.source} target="_blank" rel="noopener noreferrer" className="hint">
                            source
                          </a>
                        </span>
                        <Button size="sm" icon={t.sentence === p.trigger ? CheckCircle2 : Save} disabled={t.sentence === p.trigger} onClick={() => onApply(t.sentence)}>
                          {t.sentence === p.trigger ? "In use" : "Use as trigger"}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {research.talking_points.length > 0 && (
                <div>
                  <div className="section-label">Talking points</div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {research.talking_points.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </div>
              )}
              {research.watch_outs.length > 0 && (
                <div>
                  <div className="section-label">Watch out</div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {research.watch_outs.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="hint">Fit: {research.fit_reason}</div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
