import { CheckCircle2, Database, FileText, KeyRound, Mailbox, PlugZap, Save, ShieldCheck, Wand2, XCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ActionResponse, SettingsResponse } from "../../domains/web/types";
import { useStatus } from "../app/status";
import { api, ApiError, useApi } from "../lib/api";
import { Button, Card, ErrorNotice, Loading, Notice, PageHeader, Pill } from "../ui/kit";
import { useToast } from "../ui/toast";

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      {ok ? <CheckCircle2 size={15} className="text-green" /> : <XCircle size={15} className="text-3" />}
      <span className={ok ? undefined : "text-3"}>{children}</span>
    </span>
  );
}

export function SettingsPage() {
  const status = useStatus();
  const settings = useApi<SettingsResponse>("/api/settings");
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, ActionResponse>>({});

  async function action(key: string, path: string, body: unknown = {}) {
    setBusy(key);
    try {
      const response = await api<ActionResponse>(path, { method: "POST", body });
      setResult((r) => ({ ...r, [key]: response }));
      if (response.ok) toast.success(response.message);
      else toast.error(response.message);
      status.reload();
      settings.reload();
    } catch (err) {
      setResult((r) => ({ ...r, [key]: { ok: false, message: (err as Error).message } }));
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const s = status.data;
  const store = s?.store;
  return (
    <>
      <PageHeader title="Settings" sub="Who sends, what you offer, and the connections. Everything stays on this computer." />
      {s?.isExample && (
        <Notice
          tone="amber"
          title="cold.yaml does not exist yet"
          action={
            <Button variant="primary" loading={busy === "init"} onClick={() => action("init", "/api/settings/init")}>
              Create it from the example
            </Button>
          }
        >
          Until it does, the app runs on the example sender and offers, and nothing can be sent. Create it, then put your own details in the editor below.
        </Notice>
      )}
      {s?.configError && (
        <Notice tone="red" title="cold.yaml has problems">
          <span style={{ whiteSpace: "pre-wrap" }}>{s.configError}</span>
        </Notice>
      )}

      <div className="grid two" style={{ marginTop: s?.isExample || s?.configError ? 16 : 0 }}>
        <Card title="Twenty CRM" icon={Database}>
          <div className="stack">
            <Check ok={!!s?.twenty.configured}>{s?.twenty.configured ? `Connected to ${s.twenty.baseUrl}` : "Not connected: set TWENTY_BASE_URL and TWENTY_API_KEY below"}</Check>
            <Check ok={!!store && !("error" in store) && store.kind === "twenty"}>
              {!store ? "..." : "error" in store ? store.error : store.kind === "twenty" ? "Every touch is logged to Twenty" : `Touches are logged to ${store.where}`}
            </Check>
            <div className="row wrap">
              <Button size="sm" icon={PlugZap} loading={busy === "twenty"} disabled={!s?.twenty.configured} onClick={() => action("twenty", "/api/settings/test", { kind: "twenty" })}>
                Test connection
              </Button>
              <Button size="sm" icon={Wand2} loading={busy === "schema"} disabled={!s?.twenty.configured} onClick={() => action("schema", "/api/twenty/schema", { dryRun: false })}>
                Set up Twenty
              </Button>
            </div>
            {result.schema?.report && (
              <div className="lines">
                {result.schema.report.items
                  .filter((i) => i.status !== "present")
                  .map((i) => `${i.status.padEnd(8)} ${i.kind} ${i.object}.${i.name}${i.note ? `  (${i.note})` : ""}`)
                  .join("\n") || "Everything was already there."}
              </div>
            )}
            <p className="hint">"Set up Twenty" adds the coldTouch object and a coldTrigger field. It only adds; it never changes or deletes anything.</p>
          </div>
        </Card>

        <Card title="Mailboxes" icon={Mailbox}>
          <div className="stack">
            {(s?.accounts ?? []).map((a) => (
              <div key={a.key} className="stack" style={{ gap: 6 }}>
                <div className="row between">
                  <b>
                    {a.key} <Pill tone={a.voice === "personal" ? "teal" : "purple"}>{a.voice}</Pill>
                  </b>
                  <span className="text-3 truncate">{a.email?.from ?? "no email settings"}</span>
                </div>
                {a.email && (
                  <>
                    <Check ok={a.email.smtpSet}>Sending (SMTP): {a.email.smtpSet ? "set" : `set ${a.email.smtpEnv} below`}</Check>
                    <Check ok={a.email.imapSet}>Reading replies (IMAP): {a.email.imapSet ? "set" : a.email.imapEnv ? `set ${a.email.imapEnv} below` : "no imap_url_env in cold.yaml"}</Check>
                    <div className="hint">
                      Up to {a.email.dailyCap} a day{a.email.window ? `, ${a.email.window}` : ""}
                    </div>
                    <div className="row wrap">
                      <Button size="sm" icon={PlugZap} loading={busy === `smtp-${a.key}`} disabled={!a.email.smtpSet} onClick={() => action(`smtp-${a.key}`, "/api/settings/test", { kind: "smtp", account: a.key })}>
                        Test sending
                      </Button>
                      <Button size="sm" icon={PlugZap} loading={busy === `imap-${a.key}`} disabled={!a.email.imapSet} onClick={() => action(`imap-${a.key}`, "/api/settings/test", { kind: "imap", account: a.key })}>
                        Test inbox
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ))}
            <Check ok={!!s?.reacher}>{s?.reacher ? "Addresses are checked with Reacher before step 1" : "Optional: Reacher checks addresses before step 1"}</Check>
          </div>
        </Card>
      </div>

      {settings.loading && !settings.data ? <Loading /> : settings.error ? <ErrorNotice error={settings.error} /> : settings.data && <Secrets settings={settings.data} onSaved={() => (status.reload(), settings.reload())} />}
      {settings.data && <ConfigEditor settings={settings.data} onSaved={() => (status.reload(), settings.reload())} />}
    </>
  );
}

function Secrets({ settings, onSaved }: { settings: SettingsResponse; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError>();
  const toast = useToast();
  // Only fields with something typed in: an emptied field means "leave it", a single space means "clear it".
  const changed = Object.keys(values).filter((k) => values[k] !== "");

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      const result = await api<ActionResponse>("/api/settings/env", { method: "PUT", body: { values: Object.fromEntries(changed.map((k) => [k, values[k]!])) } });
      toast.success(result.message);
      setValues({});
      onSaved();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title="Connections and passwords"
      icon={KeyRound}
      actions={
        <Button variant="primary" icon={Save} loading={saving} disabled={!changed.length} onClick={save}>
          Save {changed.length ? `(${changed.length})` : ""}
        </Button>
      }
    >
      <p className="text-2" style={{ marginBottom: 14 }}>
        Saved to .env.local on this computer, never committed. Values already set are not shown: type a new one to replace it, or a single space to clear it. In mailbox URLs, write @ in the user name as %40. Gmail needs an app password.
      </p>
      <ErrorNotice error={error} title="Not saved" />
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {settings.env.map((f) => (
              <tr key={f.name}>
                <td style={{ width: 210 }}>
                  <div className="strong">{f.name}</div>
                  <Pill tone={f.set ? "green" : "gray"}>{f.set ? "set" : "not set"}</Pill>
                </td>
                <td>
                  <input
                    className="input"
                    type={/KEY|SECRET|SMTP|IMAP/.test(f.name) ? "password" : "text"}
                    autoComplete="off"
                    placeholder={f.set ? "unchanged" : "not set"}
                    value={values[f.name] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  />
                  <div className="hint" style={{ marginTop: 4 }}>
                    {f.hint}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ConfigEditor({ settings, onSaved }: { settings: SettingsResponse; onSaved: () => void }) {
  const [yaml, setYaml] = useState(settings.yaml);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError>();
  const toast = useToast();
  useEffect(() => setYaml(settings.yaml), [settings.yaml]);
  const dirty = yaml !== settings.yaml;

  async function save() {
    setSaving(true);
    setError(undefined);
    setErrors([]);
    try {
      const result = await api<ActionResponse>("/api/settings/config", { method: "PUT", body: { yaml } });
      toast.success(result.message);
      onSaved();
    } catch (err) {
      const e = err as ApiError;
      setError(e);
      if (Array.isArray(e.data.errors)) setErrors(e.data.errors as string[]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title={settings.exists ? "cold.yaml" : "cold.yaml (showing the example)"}
      icon={FileText}
      actions={
        <Button variant="primary" icon={Save} loading={saving} disabled={!dirty && settings.exists} onClick={save}>
          {settings.exists ? "Save" : "Save as cold.yaml"}
        </Button>
      }
    >
      <div className="stack">
        <p className="text-2">
          Your accounts (a personal one that sends as you, a company one that sends as the brand) and your offers. Each offer line has to read naturally inside the sentences shown in its comment.
        </p>
        <ErrorNotice error={error} title="Not saved" />
        {errors.length > 0 && (
          <div className="issues">
            {errors.map((e) => (
              <div key={e} className="issue">
                <XCircle size={14} className="text-red" />
                <span>{e}</span>
              </div>
            ))}
          </div>
        )}
        <textarea className="textarea code" spellCheck={false} value={yaml} onChange={(e) => setYaml(e.target.value)} />
        <div className="row text-3" style={{ gap: 6 }}>
          <ShieldCheck size={14} /> Saving checks every line first; a broken file is never written.
        </div>
      </div>
    </Card>
  );
}
