import { AlertTriangle, BookOpen, Eye, Pencil, RotateCcw, Save, Search, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { VariableSpec } from "../../domains/render/types";
import type { LibraryResponse, MessageResponse, PreviewResponse } from "../../domains/web/types";
import type { LintIssue } from "../../domains/messages/types";
import { setQuery, useLocation } from "../app/router";
import { useStatus } from "../app/status";
import { api, ApiError, useApi } from "../lib/api";
import { channelLabel, sequenceName, voiceLabel } from "../lib/format";
import { Button, Empty, ErrorNotice, Field, Loading, Notice, PageHeader, Pill, Tabs } from "../ui/kit";
import { ProspectPicker } from "../ui/prospectPicker";
import { useToast } from "../ui/toast";

export function LibraryPage() {
  const library = useApi<LibraryResponse>("/api/library");
  const { query } = useLocation();
  const [search, setSearch] = useState("");
  const data = library.data;

  const groups = useMemo(() => {
    const out: Array<{ title: string; items: Array<{ id: string; title: string; sub: string; step?: boolean }> }> = [];
    if (!data) return out;
    const q = search.toLowerCase();
    for (const channel of ["email", "dm"] as const) {
      for (const voice of ["personal", "company"] as const) {
        const items: Array<{ id: string; title: string; sub: string; step?: boolean }> = [];
        for (const s of data.sequences.filter((x) => x.channel === channel && x.voice === voice)) {
          const steps = s.steps.filter((m) => `${s.id} ${m.title} ${m.subject ?? ""}`.toLowerCase().includes(q));
          if (!steps.length) continue;
          items.push({ id: `seq:${s.id}`, title: `${sequenceName(s.id)}${s.platform ? "" : ""}`, sub: `${channelLabel(s.channel, s.platform)}, ${s.steps.length} steps` });
          for (const m of steps) items.push({ id: m.id, title: `${m.step}. ${m.title}`, sub: `day ${m.day}${m.subject ? `: ${m.subject}` : ""}`, step: true });
        }
        if (items.length) out.push({ title: `${channel === "email" ? "Email" : "DMs"}, ${voice}`, items });
      }
    }
    const calls = data.callScripts.filter((c) => `${c.title} ${c.category}`.toLowerCase().includes(q));
    if (calls.length) out.push({ title: "Call scripts", items: calls.map((c) => ({ id: c.id, title: c.title, sub: `${voiceLabel(c.voice)}, ${c.category}` })) });
    return out;
  }, [data, search]);

  const firstShown = groups.flatMap((g) => g.items).find((i) => !i.id.startsWith("seq:"))?.id ?? "";
  const selected = query.get("id") ?? firstShown;

  if (library.loading) return <Loading />;
  return (
    <div className="panes">
      <div className="pane-list">
        <div className="search">
          <div className="row" style={{ position: "relative" }}>
            <Search size={14} className="text-3" style={{ position: "absolute", left: 10 }} />
            <input className="input" style={{ paddingLeft: 30 }} placeholder="Search messages" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {data && data.issues.filter((i) => i.level === "error").length > 0 && (
            <div style={{ marginTop: 10 }}>
              <Notice tone="red">{data.issues.filter((i) => i.level === "error").length} message files have errors and are left out until fixed.</Notice>
            </div>
          )}
        </div>
        {groups.map((g) => (
          <div key={g.title} className="list-group">
            <div className="list-group-title">{g.title}</div>
            {g.items.map((item) =>
              item.id.startsWith("seq:") ? (
                <div key={item.id} className="list-item" style={{ cursor: "default" }}>
                  <div className="t">{item.title}</div>
                  <div className="s">{item.sub}</div>
                </div>
              ) : (
                <button key={item.id} type="button" className={`list-item${item.step ? " step" : ""}${item.id === selected ? " active" : ""}`} onClick={() => setQuery({ id: item.id })}>
                  <div className="t" style={{ fontWeight: item.step ? 500 : 600 }}>
                    {item.title}
                  </div>
                  <div className="s truncate">{item.sub}</div>
                </button>
              ),
            )}
          </div>
        ))}
      </div>
      <div className="pane-detail">{selected ? <MessageDetail key={selected} id={selected} onSaved={library.reload} /> : <Empty icon={BookOpen} title="Pick a message" />}</div>
    </div>
  );
}

function MessageDetail({ id, onSaved }: { id: string; onSaved: () => void }) {
  const message = useApi<MessageResponse>(`/api/messages?id=${encodeURIComponent(id)}`);
  const [tab, setTab] = useState<"preview" | "edit">("preview");
  const [draft, setDraft] = useState<string | null>(null);
  const [issues, setIssues] = useState<LintIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError>();
  const toast = useToast();
  const [channel, voice] = id.split("/") as ["email" | "dm" | "call", "personal" | "company"];
  const dirty = draft !== null && draft !== message.data?.source;

  useEffect(() => setIssues(message.data?.issues ?? []), [message.data]);

  async function save() {
    if (draft === null) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await api<{ issues: LintIssue[] }>("/api/messages", { method: "PUT", body: { id, source: draft } });
      setIssues(result.issues);
      toast.success("Saved. It passed lint.");
      message.reload();
      setDraft(null);
      onSaved();
    } catch (err) {
      const e = err as ApiError;
      setError(e);
      if (Array.isArray(e.data.issues)) setIssues(e.data.issues as LintIssue[]);
    } finally {
      setSaving(false);
    }
  }

  if (message.loading && !message.data) return <Loading />;
  if (message.error) return <ErrorNotice error={message.error} />;
  const title = /^title:\s*(.+)$/m.exec(message.data?.source ?? "")?.[1] ?? id;

  return (
    <>
      <PageHeader
        title={title}
        sub={
          <span className="row wrap" style={{ gap: 6 }}>
            <Pill tone="blue">{channel === "email" ? "Email" : channel === "dm" ? "DM" : "Call script"}</Pill>
            <Pill tone={voice === "personal" ? "teal" : "purple"}>{voiceLabel(voice)}</Pill>
            <span>{message.data?.file}</span>
          </span>
        }
        actions={
          tab === "edit" && (
            <>
              <Button icon={RotateCcw} disabled={!dirty} onClick={() => setDraft(null)}>
                Undo changes
              </Button>
              <Button variant="primary" icon={Save} loading={saving} disabled={!dirty} onClick={save}>
                Save
              </Button>
            </>
          )
        }
      />
      <div className="card">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "preview", label: "Preview", icon: Eye },
            { id: "edit", label: dirty ? "Edit (unsaved)" : "Edit", icon: Pencil },
          ]}
        />
        <div className="card-body">
          {tab === "preview" ? (
            <Preview id={id} template={dirty ? draft! : undefined} channel={channel} voice={voice} />
          ) : (
            <Editor source={draft ?? message.data?.source ?? ""} onChange={setDraft} />
          )}
        </div>
      </div>
      {(error || issues.length > 0) && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-body stack">
            <ErrorNotice error={error} title="Not saved" />
            <div className="issues">
              {issues.map((i, n) => (
                <div key={n} className="issue">
                  {i.level === "error" ? <XCircle size={14} className="text-red" /> : <AlertTriangle size={14} className="text-amber" />}
                  <span className="text-3">[{i.rule}]</span>
                  <span>{i.message}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Preview({ id, template, channel, voice }: { id: string; template?: string; channel: string; voice: "personal" | "company" }) {
  const status = useStatus();
  const accounts = (status.data?.accounts ?? []).filter((a) => a.voice === voice);
  const [account, setAccount] = useState("");
  const [offer, setOffer] = useState("");
  const [source, setSource] = useState("");
  const [prospect, setProspect] = useState("");
  const [preview, setPreview] = useState<PreviewResponse>();
  const [error, setError] = useState<ApiError>();

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      api<PreviewResponse>("/api/preview", { method: "POST", body: { id, template, account: account || undefined, offer: offer || undefined, source: source && prospect ? source : undefined, prospect: prospect || undefined } })
        .then((p) => alive && (setPreview(p), setError(undefined)))
        .catch((e: ApiError) => alive && setError(e));
    }, template ? 250 : 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, template, account, offer, source, prospect]);

  return (
    <div className="stack">
      <div className="inline-fields">
        <Field label="Sent from">
          <select className="select" value={account} onChange={(e) => setAccount(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.key} value={a.key}>
                {a.key}: {a.senderName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Offer">
          <select className="select" value={offer} onChange={(e) => setOffer(e.target.value)}>
            {(status.data?.offers ?? []).map((o) => (
              <option key={o.key} value={o.key}>
                {o.key}
              </option>
            ))}
          </select>
        </Field>
        <ProspectPicker
          source={source}
          prospect={prospect}
          onChange={(s, p) => {
            setSource(s);
            setProspect(p);
          }}
        />
      </div>
      <ErrorNotice error={error} title="Cannot preview" />
      {preview?.missing && preview.missing.length > 0 && (
        <Notice tone="amber" title="This one would be held back">
          No value for {preview.missing.map((m) => `{{${m}}}`).join(", ")}. Add it to the prospect, or give the variable a fallback.
        </Notice>
      )}
      {preview?.sheet ? (
        preview.sheet.sections.map((s) => (
          <div key={s.heading}>
            <div className="section-label">{s.heading}</div>
            <div className="message-box">{s.text}</div>
          </div>
        ))
      ) : preview ? (
        <div className="message-box big">
          {preview.subject && <div className="subject">Subject: {preview.subject}</div>}
          {preview.body}
          {preview.footer && `\n\n${preview.footer}`}
        </div>
      ) : (
        !error && <Loading label="Filling it in" />
      )}
      {preview && channel !== "call" && <div className="hint">{preview.body?.length ?? 0} characters, filled in for {preview.prospectLabel}.</div>}
    </div>
  );
}

function Editor({ source, onChange }: { source: string; onChange: (s: string) => void }) {
  const variables = useApi<VariableSpec[]>("/api/variables");
  const area = useRef<HTMLTextAreaElement>(null);
  function insert(name: string) {
    const el = area.current;
    if (!el) return;
    const token = `{{${name}}}`;
    const next = el.value.slice(0, el.selectionStart) + token + el.value.slice(el.selectionEnd);
    onChange(next);
    const at = el.selectionStart + token.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  }
  return (
    <div className="stack">
      <textarea ref={area} className="textarea code" spellCheck={false} value={source} onChange={(e) => onChange(e.target.value)} />
      <div>
        <div className="section-label">Insert a variable</div>
        <div className="chips">
          {(variables.data ?? []).map((v) => (
            <button key={v.name} type="button" className="chip-btn" title={`${v.description} Example: ${v.example}`} onClick={() => insert(v.name)}>
              {v.name}
            </button>
          ))}
        </div>
      </div>
      <p className="hint">
        {"{{name|fallback}}"} uses the fallback when it is empty; {"{a|b}"} picks one option per prospect. Saving runs the same lint as the command line, and refuses errors.
      </p>
    </div>
  );
}
