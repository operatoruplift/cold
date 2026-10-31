import { ChevronDown, ChevronRight, Gauge, PlugZap, Sparkles, Square, Telescope } from "lucide-react";
import { Fragment, useMemo, useRef, useState } from "react";
import type { Decision, Dossier } from "../../domains/decide";
import type { ActionResponse, DecideStatusResponse, ProspectDecisionResponse, ProspectSummary, ScoresResponse, SourceOption } from "../../domains/web/types";
import { navigate, setQuery, useLocation } from "../app/router";
import { useStatus } from "../app/status";
import { runAndWait } from "../lib/ai";
import { api, ApiError, useApi } from "../lib/api";
import { ANGLE_LABEL, PROVIDER_LABEL, TONE_LABEL } from "../lib/decide";
import { ActionPill, DecisionDetail, ScoreCell } from "../ui/decide";
import { Button, Empty, ErrorNotice, Field, Loading, Notice, Pill } from "../ui/kit";
import { useToast } from "../ui/toast";

type Filter = "all" | "now" | "check" | "unscored";

/** Run jobs a few at a time, until they are done or stopped. */
async function inBatches<T>(items: T[], size: number, stopped: () => boolean, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length && !stopped()) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane));
}

/**
 * Rank a prospect list by how likely each one is to buy: diligence reads
 * their site, the decision model scores them and suggests the next step and
 * the style. Nothing here contacts anyone.
 */
export function ScoreLists() {
  const status = useStatus();
  const engine = useApi<DecideStatusResponse>("/api/decide/status");
  const sources = useApi<SourceOption[]>("/api/sources");
  const { query } = useLocation();
  const [source, setSource] = useState(query.get("source") ?? "");
  const [offer, setOffer] = useState("");
  const offers = status.data?.offers ?? [];
  // Decisions are kept per offer, so the one in use is always named.
  const offerKey = offer || status.data?.defaultOffer || offers[0]?.key || "";
  const chosen = source || sources.data?.[0]?.id || "";
  const list = useApi<{ total: number; prospects: ProspectSummary[] }>(chosen ? `/api/prospects?source=${encodeURIComponent(chosen)}` : null);
  const scores = useApi<ScoresResponse>(chosen && status.data ? `/api/decide/scores?source=${encodeURIComponent(chosen)}&offer=${encodeURIComponent(offerKey)}` : null);
  const [open, setOpen] = useState<string>();
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [batch, setBatch] = useState<{ done: number; total: number; label: string }>();
  const [deep, setDeep] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<ApiError>();
  const stop = useRef(false);
  const toast = useToast();

  const prospects = list.data?.prospects ?? [];
  const found = scores.data?.scores ?? {};
  const ranked = useMemo(
    () =>
      [...prospects]
        .map((p, i) => ({ p, i, s: found[p.key] }))
        .sort((a, b) => (b.s?.score ?? -1) - (a.s?.score ?? -1) || a.i - b.i)
        .filter(({ p, s }) => (filter === "now" ? s?.action === "contact_now" : filter === "check" ? s?.review : filter === "unscored" ? !s && !p.doNotContact : true)),
    [prospects, found, filter],
  );
  const unscored = prospects.filter((p) => !found[p.key] && !p.doNotContact);

  async function one(p: ProspectSummary, kind: "diligence" | "score") {
    setBusy((b) => ({ ...b, [p.key]: kind === "diligence" ? "Reading their site" : "Scoring" }));
    try {
      await runAndWait(() => api<{ runId: string }>(`/api/decide/${kind}`, { method: "POST", body: { source: chosen, prospect: p.key, offer: offerKey || undefined } }));
    } finally {
      setBusy((b) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== p.key)));
    }
  }

  async function single(p: ProspectSummary, kind: "diligence" | "score") {
    setError(undefined);
    try {
      await one(p, kind);
      if (kind === "diligence") await one(p, "score");
      scores.reload();
      setOpen(p.key);
      toast.success(kind === "diligence" ? `Read ${p.label}'s site and scored them.` : `Scored ${p.label}.`);
    } catch (err) {
      setError(err as ApiError);
    }
  }

  async function scoreAll() {
    const todo = unscored;
    if (!todo.length) return;
    stop.current = false;
    setError(undefined);
    setBatch({ done: 0, total: todo.length, label: deep ? "Reading sites and scoring" : "Scoring" });
    let failed = 0;
    let skipped = 0;
    await inBatches(todo, deep ? 2 : 3, () => stop.current, async (p) => {
      try {
        if (deep && !scores.data?.diligence[p.key]) await one(p, "diligence");
        await one(p, "score");
      } catch (err) {
        // Someone who opted out is left alone, not a failure.
        if ((err as ApiError).status === 409) skipped++;
        else {
          failed++;
          setError(err as ApiError);
        }
      }
      setBatch((b) => b && { ...b, done: b.done + 1 });
    });
    scores.reload();
    setBatch(undefined);
    const scored = todo.length - failed - skipped;
    toast.success(
      stop.current
        ? "Stopped. The ones already scored are saved."
        : `Scored ${scored} prospect${scored === 1 ? "" : "s"}${skipped ? `; left out ${skipped} who asked not to be contacted` : ""}${failed ? `; ${failed} failed` : ""}.`,
    );
  }

  const e = engine.data;
  return (
    <div className="stack">
      <EngineLine engine={e} onTested={engine.reload} />
      <div className="inline-fields">
        <Field label="List">
          <select className="select" value={chosen} onChange={(ev) => (setSource(ev.target.value), setQuery({ source: ev.target.value }))}>
            {(sources.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="For the offer">
          <select className="select" value={offerKey} onChange={(ev) => setOffer(ev.target.value)}>
            {offers.map((o) => (
              <option key={o.key} value={o.key}>
                {o.key}
                {o.audience ? `: ${o.audience}` : ""}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="row wrap">
        <Button variant="primary" icon={Gauge} onClick={scoreAll} loading={!!batch} disabled={!unscored.length || !e?.decide.provider}>
          Score {unscored.length ? `the ${unscored.length} not scored` : "everyone"}
        </Button>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={deep} onChange={(ev) => setDeep(ev.target.checked)} /> Read their sites first (slower, surer)
        </label>
        {batch && (
          <>
            <span className="text-2">
              {batch.label}: {batch.done} of {batch.total}
            </span>
            <Button size="sm" icon={Square} onClick={() => (stop.current = true)}>
              Stop
            </Button>
          </>
        )}
      </div>
      <p className="hint">
        Diligence reads each prospect's public site for what they need, with the words that show it. Scoring asks {e?.decide.provider ? PROVIDER_LABEL[e.decide.provider] : "the decision model"} about fit, need, timing, who decides and whether they can pay, then suggests a next step and the tone and opening most likely to get a reply. Nothing is sent from here.
      </p>
      <ErrorNotice error={error ?? list.error ?? scores.error} title="Not done" />
      <div className="row wrap" style={{ gap: 6 }}>
        {(
          [
            ["all", `All ${prospects.length}`],
            ["now", "Reach out now"],
            ["check", "Check"],
            ["unscored", `Not scored ${unscored.length}`],
          ] as Array<[Filter, string]>
        ).map(([id, label]) => (
          <button key={id} type="button" className={`chip${filter === id ? " active" : ""}`} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>
      {list.loading && !list.data ? (
        <Loading />
      ) : !prospects.length ? (
        <Empty icon={Gauge} title="This list is empty" />
      ) : (
        <div className="table-wrap" style={{ border: "1px solid var(--border)", borderRadius: 14 }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>Prospect</th>
                <th>Score</th>
                <th>Next step</th>
                <th>Write it</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ranked.map(({ p, s }) => (
                <Fragment key={p.key}>
                  <tr className="clickable" onClick={() => setOpen(open === p.key ? undefined : p.key)}>
                    <td>{open === p.key ? <ChevronDown size={15} className="text-3" /> : <ChevronRight size={15} className="text-3" />}</td>
                    <td style={{ minWidth: 220 }}>
                      <div className="strong">{p.label}</div>
                      <div className="muted">{[p.city, p.website?.replace(/^https?:\/\//, "")].filter(Boolean).join(" · ")}</div>
                      {s?.need ? <div className="need-line">Needs: {s.need}</div> : s && !scores.data?.diligence[p.key] ? <div className="muted">No diligence yet</div> : null}
                    </td>
                    <td>{s ? <ScoreCell score={s.score} tier={s.tier} /> : p.doNotContact ? <Pill tone="red">Do not contact</Pill> : <span className="muted">-</span>}</td>
                    <td>{s ? <ActionPill action={s.action} review={s.review} /> : null}</td>
                    <td className="text-2">
                      {s ? (
                        <>
                          <div>{TONE_LABEL[s.tone]}</div>
                          <div className="muted">{ANGLE_LABEL[s.angle]}</div>
                        </>
                      ) : null}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }} onClick={(ev) => ev.stopPropagation()}>
                      {busy[p.key] ? (
                        <span className="text-3">
                          <span className="spinner" style={{ width: 12, height: 12 }} /> {busy[p.key]}
                        </span>
                      ) : (
                        <span className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                          <Button size="sm" variant="ghost" icon={Telescope} disabled={p.doNotContact || !e?.diligence.provider || !!batch} onClick={() => single(p, "diligence")} title="Read their site for what they need, then score them">
                            {scores.data?.diligence[p.key] ? "Read again" : "Read site"}
                          </Button>
                          <Button size="sm" variant="ai" icon={Sparkles} disabled={p.doNotContact || !e?.decide.provider || !!batch} onClick={() => single(p, "score")}>
                            {s ? "Rescore" : "Score"}
                          </Button>
                        </span>
                      )}
                    </td>
                  </tr>
                  {open === p.key && (
                    <tr>
                      <td />
                      <td colSpan={5} style={{ background: "var(--bg-subtle)" }}>
                        <ProspectDetail prospectKey={p.key} offer={offerKey} version={`${s?.decidedAt ?? ""}|${scores.data?.diligence[p.key] ?? ""}`} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {!ranked.length && <Empty icon={Gauge} title="Nobody matches this filter" />}
        </div>
      )}
    </div>
  );
}

function ProspectDetail({ prospectKey, offer, version }: { prospectKey: string; offer: string; version: string }) {
  const detail = useApi<ProspectDecisionResponse>(`/api/decide/prospect?prospect=${encodeURIComponent(prospectKey)}${offer ? `&offer=${encodeURIComponent(offer)}` : ""}&v=${encodeURIComponent(version)}`);
  if (detail.loading && !detail.data) return <Loading />;
  if (detail.error) return <ErrorNotice error={detail.error} />;
  return <DecisionDetail decision={detail.data?.decision as Decision | undefined} dossier={detail.data?.dossier as Dossier | undefined} dossierAt={detail.data?.dossierAt} />;
}

/** Who decides and who reads, with a way to check each connection. */
function EngineLine({ engine, onTested }: { engine?: DecideStatusResponse; onTested: () => void }) {
  const toast = useToast();
  const [testing, setTesting] = useState<string>();
  if (!engine) return null;
  async function test(provider: "jev" | "subq") {
    setTesting(provider);
    try {
      const r = await api<ActionResponse>("/api/decide/test", { method: "POST", body: { provider } });
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      onTested();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setTesting(undefined);
    }
  }
  if (!engine.decide.provider)
    return (
      <Notice tone="blue" title="Connect a decision model to score prospects" action={<Button variant="primary" onClick={() => navigate("/settings")}>Open Settings</Button>}>
        {engine.decide.error}
      </Notice>
    );
  return (
    <div className="engine-line">
      <span>
        <b>Decides:</b> {PROVIDER_LABEL[engine.decide.provider]} <span className="text-3">({engine.decide.model})</span>
      </span>
      <span>
        <b>Diligence:</b> {engine.diligence.provider ? (
          <>
            {PROVIDER_LABEL[engine.diligence.provider]} <span className="text-3">({engine.diligence.model})</span>
          </>
        ) : (
          <span className="text-3">{engine.diligence.error}</span>
        )}
      </span>
      {engine.counts.decisions > 0 && <span className="text-3">{engine.counts.decisions} scored so far</span>}
      <span className="row" style={{ gap: 4, marginLeft: "auto" }}>
        {engine.keys.typesafe && (
          <Button size="sm" variant="ghost" icon={PlugZap} loading={testing === "jev"} onClick={() => test("jev")}>
            Test Jev
          </Button>
        )}
        {engine.keys.subq && (
          <Button size="sm" variant="ghost" icon={PlugZap} loading={testing === "subq"} onClick={() => test("subq")}>
            Test SubQ
          </Button>
        )}
        {(!engine.keys.typesafe || !engine.keys.subq) && (
          <Button size="sm" variant="ghost" onClick={() => navigate("/settings")} title="Add TYPESAFE_API_KEY for Jev and SUBQ_API_KEY for SubQ">
            Add Jev or SubQ
          </Button>
        )}
      </span>
      {engine.decide.provider === "claude" && <span className="hint" style={{ flexBasis: "100%" }}>Claude decides until a TypeSafe key is added. Jev is built for this kind of call; Claude's probabilities are its judgment.</span>}
    </div>
  );
}
