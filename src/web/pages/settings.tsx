import { AtSign, BellRing, CheckCircle2, Copy, Database, Ear, FileText, KeyRound, ListPlus, LogOut, Mailbox, MonitorSmartphone, PlugZap, Save, Send, ShieldCheck, Sparkles, Unplug, UserRound, Wand2, XCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ActionResponse, AiStatusResponse, LeadAlertsResponse, ListenStatusResponse, SessionsResponse, SettingsResponse, XStatusResponse } from "../../domains/web/types";
import { usePwa, install } from "../app/pwa";
import { useSession } from "../app/session";
import { useStatus } from "../app/status";
import { tokens } from "../lib/ai";
import { ago } from "../lib/format";
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
      <PageHeader title="Settings" sub="Your login, who sends, what you offer, and the connections." />
      <div className="grid two" style={{ marginBottom: 16 }}>
        <AccountCard />
        <AiCard />
      </div>
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

      <XCard />
      <ListenCard />
      <LeadAlertsCard />

      {settings.loading && !settings.data ? <Loading /> : settings.error ? <ErrorNotice error={settings.error} /> : settings.data && <Secrets settings={settings.data} onSaved={() => (status.reload(), settings.reload())} />}
      {settings.data && <ConfigEditor settings={settings.data} onSaved={() => (status.reload(), settings.reload())} />}
    </>
  );
}

/**
 * Listening: OpenMagpie (ListeningKit's self-hostable listener) delivers the
 * posts its watches match to cold's webhook, and each watch becomes a
 * prospect list whose trigger line is the post.
 */
function ListenCard() {
  const listen = useApi<ListenStatusResponse>("/api/listen");
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function save(watch: string) {
    setBusy(watch);
    try {
      toast.success((await api<ActionResponse>("/api/listen/export", { method: "POST", body: { watch } })).message);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied the ${what}.`);
    } catch {
      toast.error("The browser blocked the clipboard: select it and copy it.");
    }
  }

  const d = listen.data;
  return (
    <Card title="Listening" icon={Ear}>
      {listen.loading && !d ? (
        <Loading />
      ) : listen.error ? (
        <ErrorNotice error={listen.error} />
      ) : (
        d && (
          <div className="stack">
            <p className="hint">
              Posts where someone asks for what you sell, found by OpenMagpie's watches, come in here as prospects. Each watch is a prospect list whose trigger line is the post itself. Save a watch as a list to fill in what's missing (company, email) and research it.
            </p>
            <Check ok={d.configured}>{d.configured ? "COLD_LISTEN_SECRET is set" : "Set COLD_LISTEN_SECRET below: any long random string"}</Check>
            {!d.available && <Notice tone="amber">This server has no database to keep matches.</Notice>}
            <div className="stack" style={{ gap: 4 }}>
              <span className="hint">In OpenMagpie, give the watch a webhook action that POSTs here, with the header Authorization: Bearer and your COLD_LISTEN_SECRET:</span>
              <div className="row wrap">
                <code className="truncate">{d.webhookUrl}</code>
                <Button size="sm" icon={Copy} onClick={() => copy(d.webhookUrl, "webhook URL")}>
                  Copy
                </Button>
              </div>
            </div>
            {d.watches.length === 0 ? (
              <span className="text-3">No matches have come in yet.</span>
            ) : (
              d.watches.map((w) => (
                <div key={w.id} className="row between wrap">
                  <span>
                    <b>{w.name}</b> <span className="text-3">{w.count} {w.count === 1 ? "match" : "matches"}, latest {ago(w.latest)}</span>
                  </span>
                  <Button size="sm" icon={ListPlus} loading={busy === w.id} onClick={() => save(w.id)}>
                    Save as a list
                  </Button>
                </div>
              ))
            )}
          </div>
        )
      )}
    </Card>
  );
}

/** A push to your phone when one of offer's quiz leads comes in, through ntfy. */
function LeadAlertsCard() {
  const leads = useApi<LeadAlertsResponse>("/api/leads/alerts");
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function test() {
    setBusy(true);
    try {
      toast.success((await api<ActionResponse>("/api/leads/test", { method: "POST" })).message);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const d = leads.data;
  return (
    <Card title="Lead alerts" icon={BellRing}>
      {leads.loading && !d ? (
        <Loading />
      ) : leads.error ? (
        <ErrorNotice error={leads.error} />
      ) : (
        d && (
          <div className="stack">
            <p className="hint">
              When someone takes your quiz in offer and qualifies, COLD pushes their name, company and number to your phone, so you call while it's fresh. It uses ntfy: install the ntfy app, subscribe to a topic with a long random name, and put its address in COLD_NTFY_URL below. The push carries the lead's name and number, so keep the topic to yourself, or use your own ntfy server with a token.
            </p>
            <Check ok={d.twenty}>{d.twenty ? "Twenty is connected, where offer saves its leads" : "Connect Twenty: offer saves its leads there"}</Check>
            <Check ok={d.alerts.configured}>{d.alerts.configured ? "COLD_NTFY_URL is set" : "Set COLD_NTFY_URL below"}</Check>
            {d.alerts.problem && <Notice tone="amber">{d.alerts.problem}</Notice>}
            {!d.alerts.available && <Notice tone="amber">This server has no database to remember which leads were pushed.</Notice>}
            {d.alerts.lookedAt && <span className="hint">Last looked for new leads {ago(d.alerts.lookedAt)}. Leads from before alerts were set up are never pushed.</span>}
            <div className="row">
              <Button size="sm" icon={Send} loading={busy} disabled={!d.alerts.configured} onClick={test}>
                Send a test alert
              </Button>
            </div>
          </div>
        )
      )}
    </Card>
  );
}

/**
 * X DMs through X's API: the owner's own developer app, and each account
 * connected to the X account it sends as. One DM goes out per click, from
 * the campaign's queue; nothing is sent on its own.
 */
function XCard() {
  const x = useApi<XStatusResponse>("/api/x");
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function connect(account: string) {
    setBusy(account);
    try {
      const { url } = await api<{ url: string }>("/api/x/connect", { method: "POST", body: { account } });
      window.location.href = url;
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(null);
    }
  }

  async function disconnect(account: string) {
    setBusy(account);
    try {
      toast.success((await api<ActionResponse>("/api/x/disconnect", { method: "POST", body: { account } })).message);
      x.reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function copyCallback() {
    if (!x.data) return;
    try {
      await navigator.clipboard.writeText(x.data.callbackUrl);
      toast.success("Copied the callback URL.");
    } catch {
      toast.error("The browser blocked the clipboard: select the URL and copy it.");
    }
  }

  const d = x.data;
  return (
    <Card title="X" icon={AtSign}>
      {x.loading && !d ? (
        <Loading />
      ) : x.error ? (
        <ErrorNotice error={x.error} />
      ) : (
        d && (
          <div className="stack">
            <p className="hint">
              Send X DMs from a campaign's queue with one click each, from your own account, through X's API. You approve every one; nothing goes out on its own. LinkedIn, Instagram and Facebook stay copy and open: they have no way for an app to start a conversation.
            </p>
            <Check ok={d.configured}>{d.configured ? "Your X developer app is set" : "Add X_CLIENT_ID (and X_CLIENT_SECRET) below, from your app at developer.x.com"}</Check>
            {!d.available && <Notice tone="amber">This server has no database to keep an X sign-in.</Notice>}
            <div className="stack" style={{ gap: 4 }}>
              <span className="hint">Register this as the app's callback URL (User authentication settings, type Web App):</span>
              <div className="row wrap">
                <code className="truncate">{d.callbackUrl}</code>
                <Button size="sm" icon={Copy} onClick={copyCallback}>
                  Copy
                </Button>
              </div>
            </div>
            {d.accounts.map((a) => (
              <div key={a.key} className="row between wrap">
                <b>
                  {a.key} <Pill tone={a.voice === "personal" ? "teal" : "purple"}>{a.voice}</Pill>
                </b>
                {a.username ? (
                  <span className="row" style={{ gap: 8 }}>
                    <Check ok>Sends as @{a.username}</Check>
                    <Button size="sm" icon={Unplug} loading={busy === a.key} onClick={() => disconnect(a.key)}>
                      Disconnect
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" variant="primary" icon={AtSign} loading={busy === a.key} disabled={!d.configured || !d.available} onClick={() => connect(a.key)}>
                    Connect X
                  </Button>
                )}
              </div>
            ))}
            <p className="hint">Your app's X API plan has to include Direct Messages. cold asks X for: read and send DMs, read profiles, stay connected.</p>
          </div>
        )
      )}
    </Card>
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

function AccountCard() {
  const { session, signOut } = useSession();
  const sessions = useApi<SessionsResponse>("/api/session/list");
  const pwa = usePwa();
  const toast = useToast();
  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError>();
  const owner = session?.owner;

  async function changePassword() {
    setBusy("pw");
    setError(undefined);
    try {
      const r = await api<ActionResponse>("/api/session/password", { method: "POST", body: { current, password: next } });
      toast.success(r.message);
      setChanging(false);
      setCurrent("");
      setNext("");
      sessions.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  }

  async function signOutOthers() {
    setBusy("others");
    try {
      const r = await api<ActionResponse>("/api/session/revoke-others", { method: "POST", body: {} });
      toast.success(r.message);
      sessions.reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const list = sessions.data?.sessions ?? [];
  return (
    <Card title="Your login" icon={UserRound}>
      <div className="stack">
        <Check ok>Signed in as {owner?.email}</Check>
        {owner?.managedByEnv && <p className="hint">Set by COLD_OWNER_EMAIL and COLD_OWNER_PASSWORD_HASH on the server: change it there.</p>}
        <div className="row wrap">
          {!owner?.managedByEnv && (
            <Button size="sm" icon={KeyRound} onClick={() => setChanging((c) => !c)}>
              Change password
            </Button>
          )}
          <Button size="sm" icon={LogOut} onClick={() => void signOut()}>
            Sign out
          </Button>
          {pwa.installable && (
            <Button size="sm" icon={MonitorSmartphone} onClick={() => void install()}>
              Install COLD
            </Button>
          )}
        </div>
        {changing && (
          <div className="stack" style={{ gap: 8 }}>
            <input className="input" type="password" autoComplete="current-password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            <input className="input" type="password" autoComplete="new-password" placeholder="New password (12+ characters)" value={next} onChange={(e) => setNext(e.target.value)} />
            <ErrorNotice error={error} title="Not changed" />
            <div>
              <Button size="sm" variant="primary" loading={busy === "pw"} disabled={!current || next.length < 12} onClick={changePassword}>
                Save new password
              </Button>
            </div>
          </div>
        )}
        <div>
          <div className="section-label">Signed in on</div>
          <div className="stack" style={{ gap: 6 }}>
            {list.map((x) => (
              <div key={x.id} className="row between" style={{ fontSize: 12.5 }}>
                <span className="truncate" title={x.userAgent}>
                  <MonitorSmartphone size={13} className="text-3" /> {device(x.userAgent)}
                  {x.current ? <span className="text-green"> (this one)</span> : null}
                </span>
                <span className="text-3">{ago(x.lastSeenAt)}</span>
              </div>
            ))}
          </div>
          {list.length > 1 && (
            <Button size="sm" variant="ghost" loading={busy === "others"} onClick={signOutOthers} style={{ marginTop: 6 }}>
              Sign out everywhere else
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/** "Chrome on macOS" from a user agent, roughly. */
function device(ua = ""): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /curl/.test(ua) ? "curl" : "A browser";
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function AiCard() {
  const ai = useApi<AiStatusResponse>("/api/ai/status");
  const usage = ai.data?.usage;
  return (
    <Card title="AI" icon={Sparkles}>
      <div className="stack">
        <Check ok={!!ai.data?.configured}>{ai.data?.configured ? `Claude is connected (${ai.data.model})` : "Not connected: add ANTHROPIC_API_KEY below"}</Check>
        <p className="text-2">
          Claude finds and researches prospects (with web search), personalizes messages, prepares calls and reads replies. It never sends anything: drafts wait for your approval, and DMs and calls stay yours.
        </p>
        {usage && (
          <div className="kv">
            <dt>Last 30 days</dt>
            <dd>
              {usage.runs} requests, {tokens(usage.inputTokens)} tokens in, {tokens(usage.outputTokens)} out, {usage.searches} web searches
            </dd>
          </div>
        )}
        <p className="hint">Billed to your Anthropic account. Set COLD_AI_MODEL in the environment to use another Claude model.</p>
      </div>
    </Card>
  );
}
