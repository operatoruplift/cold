import { Ban, Inbox, MailX, MessageSquareReply, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { TouchRow } from "../../domains/web/types";
import { useStatus } from "../app/status";
import { api, ApiError, useApi } from "../lib/api";
import { sequenceName, when } from "../lib/format";
import { Button, Card, Empty, ErrorNotice, Field, Loading, Notice, PageHeader, Stat } from "../ui/kit";
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
  return (
    <>
      <PageHeader title="Replies" sub="Replies stop the sequence; opt-outs stop everything; bounces stop that address." />
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
          <p className="hint">Sending a campaign checks the inbox first, too. Replies to DMs are logged from the DM queue.</p>
        </div>
      </Card>

      <Card title="Last 30 days" icon={MessageSquareReply} tight>
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
                  <th>When</th>
                  <th>What</th>
                  <th>Channel</th>
                  <th>Who</th>
                  <th>Sequence</th>
                  <th>What they wrote</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t, i) => (
                  <tr key={t.id ?? i}>
                    <td className="muted">{when(t.occurredAt)}</td>
                    <td>
                      <KindPill kind={t.kind} />
                    </td>
                    <td>
                      <ChannelLabel channel={t.channel} />
                    </td>
                    <td className="strong">{t.prospectLabel ?? t.toAddress ?? t.prospectKey}</td>
                    <td className="muted">{t.sequence ? `${sequenceName(t.sequence)}${t.step ? `, step ${t.step}` : ""}` : ""}</td>
                    <td className="text-2 truncate" style={{ maxWidth: 340 }} title={t.body}>
                      {t.body?.split("\n")[0]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
