import { Download, ExternalLink, ListChecks, Mail, Search, Trash2, UserCheck, Users } from "lucide-react";
import { useState } from "react";
import type { WaitlistEntry, WaitlistResponse } from "../../domains/web/types";
import { api, apiText, ApiError, useApi } from "../lib/api";
import { ago, download } from "../lib/format";
import { Button, Card, Empty, ErrorNotice, Loading, PageHeader, Pill, Stat, Tabs } from "../ui/kit";
import { useToast } from "../ui/toast";

const CHANNEL: Record<string, string> = { email: "Email", dm: "DMs", calls: "Calls", prospecting: "Prospecting" };
type Filter = "all" | "waiting" | "invited" | "archived";

/** The people who joined the waitlist on the public site. */
export function WaitlistPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const query = new URLSearchParams({ ...(filter !== "all" ? { status: filter } : {}), ...(search.trim() ? { q: search.trim() } : {}) }).toString();
  const list = useApi<WaitlistResponse>(`/api/waitlist${query ? `?${query}` : ""}`);
  const toast = useToast();
  const [error, setError] = useState<ApiError>();
  const counts = list.data?.counts;

  async function update(entry: WaitlistEntry, patch: Partial<Pick<WaitlistEntry, "status" | "ownerNote">>) {
    try {
      await api(`/api/waitlist/${entry.id}`, { method: "PATCH", body: patch });
      list.reload();
    } catch (err) {
      setError(err as ApiError);
    }
  }

  async function remove(entry: WaitlistEntry) {
    if (!confirm(`Remove ${entry.email} from the waitlist? This cannot be undone.`)) return;
    try {
      await api(`/api/waitlist/${entry.id}`, { method: "DELETE" });
      toast.success(`Removed ${entry.email}.`);
      list.reload();
    } catch (err) {
      setError(err as ApiError);
    }
  }

  async function exportCsv() {
    try {
      download(`cold-waitlist-${new Date().toISOString().slice(0, 10)}.csv`, await apiText("/api/waitlist.csv"), "text/csv");
    } catch (err) {
      setError(err as ApiError);
    }
  }

  const entries = list.data?.entries ?? [];
  return (
    <>
      <PageHeader
        title="Waitlist"
        count={counts?.total}
        sub="People who asked for early access on your site."
        actions={
          <>
            <a className="btn" href="/" target="_blank" rel="noopener">
              <ExternalLink size={15} /> Open the site
            </a>
            <Button icon={Download} onClick={exportCsv} disabled={!counts?.total}>
              Export CSV
            </Button>
          </>
        }
      />
      <div className="grid stats">
        <Stat label="On the list" value={counts?.total ?? "-"} icon={Users} />
        <Stat label="Waiting" value={counts?.waiting ?? "-"} icon={ListChecks} tone="amber" />
        <Stat label="Invited" value={counts?.invited ?? "-"} icon={UserCheck} tone="green" />
        <Stat label="Joined this week" value={counts?.lastWeek ?? "-"} icon={Mail} tone="purple" />
      </div>
      <ErrorNotice error={error ?? list.error} />
      <Card tight>
        <Tabs<Filter>
          value={filter}
          onChange={setFilter}
          tabs={[
            { id: "all", label: "Everyone", count: counts?.total },
            { id: "waiting", label: "Waiting", count: counts?.waiting },
            { id: "invited", label: "Invited", count: counts?.invited },
            { id: "archived", label: "Archived", count: counts?.archived },
          ]}
        />
        <div style={{ padding: 12, borderBottom: "1px solid var(--border)", position: "relative" }}>
          <Search size={14} className="text-3" style={{ position: "absolute", left: 22, top: 23 }} />
          <input className="input" style={{ paddingLeft: 30 }} placeholder="Search by email, name, company or role" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {list.loading && !list.data ? (
          <Loading />
        ) : !entries.length ? (
          <Empty icon={ListChecks} title={search || filter !== "all" ? "Nobody matches" : "No one yet"}>
            {search || filter !== "all" ? "Try another search or tab." : "When someone joins on your site's waitlist form, they show up here."}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Reaches out by</th>
                  <th>Note</th>
                  <th>Joined</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <div className="strong">{e.name || e.email}</div>
                      <div className="muted">
                        {e.name ? e.email : ""}
                        {e.company ? `${e.name ? " · " : ""}${e.company}` : ""}
                      </div>
                    </td>
                    <td>{e.role ?? <span className="muted">-</span>}</td>
                    <td>
                      <span className="row wrap" style={{ gap: 4 }}>
                        {e.channels.length ? e.channels.map((c) => <Pill key={c} tone="blue">{CHANNEL[c] ?? c}</Pill>) : <span className="muted">-</span>}
                      </span>
                    </td>
                    <td style={{ maxWidth: 260 }}>
                      <span className="muted" title={e.note}>
                        {e.note ? (e.note.length > 90 ? `${e.note.slice(0, 90)}…` : e.note) : "-"}
                      </span>
                    </td>
                    <td className="muted" title={new Date(e.createdAt).toLocaleString()}>
                      {ago(e.createdAt)}
                    </td>
                    <td>
                      <select className="select" style={{ height: 30, width: 120 }} value={e.status} onChange={(ev) => update(e, { status: ev.target.value as WaitlistEntry["status"] })} aria-label={`Status for ${e.email}`}>
                        <option value="waiting">Waiting</option>
                        <option value="invited">Invited</option>
                        <option value="archived">Archived</option>
                      </select>
                    </td>
                    <td>
                      <span className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                        <a className="btn sm ghost" href={`mailto:${e.email}`} title={`Email ${e.email}`}>
                          <Mail size={13} />
                        </a>
                        <Button size="sm" variant="ghost" icon={Trash2} onClick={() => remove(e)} aria-label={`Remove ${e.email}`} />
                      </span>
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
