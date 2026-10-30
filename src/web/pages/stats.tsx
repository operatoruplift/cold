import { Ban, BarChart3, MailX, MessageSquareReply, Send } from "lucide-react";
import { useState } from "react";
import type { StatsResponse } from "../../domains/web/types";
import { useApi } from "../lib/api";
import { percent, sequenceName } from "../lib/format";
import { Card, Empty, ErrorNotice, Loading, PageHeader, Stat } from "../ui/kit";

function Rate({ part, whole }: { part: number; whole: number }) {
  const value = whole ? (100 * part) / whole : 0;
  return (
    <div className="row" style={{ gap: 10 }}>
      <div className="bar" style={{ width: 120 }}>
        <span style={{ width: `${Math.min(100, value * 4)}%` }} />
      </div>
      <b style={{ minWidth: 36 }}>{percent(part, whole)}</b>
    </div>
  );
}

export function StatsPage() {
  const [days, setDays] = useState(30);
  const stats = useApi<StatsResponse>(`/api/stats?days=${days}`);
  const s = stats.data;
  return (
    <>
      <PageHeader
        title="Stats"
        sub="Which messages get replies. Keep the winners; rewrite the weakest step first."
        actions={
          <select className="select" style={{ width: 150 }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 30, 90, 365].map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        }
      />
      {stats.loading && !s ? (
        <Loading />
      ) : stats.error ? (
        <ErrorNotice error={stats.error} />
      ) : s ? (
        <>
          <div className="grid stats">
            <Stat label="Sent" icon={Send} tone="blue" value={s.totals.sent} />
            <Stat label="Replies" icon={MessageSquareReply} tone="green" value={s.totals.replied} note={`${percent(s.totals.replied, s.totals.sent)} of sends`} />
            <Stat label="Opt-outs" icon={Ban} tone="red" value={s.totals.optedOut} />
            <Stat label="Bounces" icon={MailX} tone="amber" value={s.totals.bounced} />
          </div>
          {s.templates.length === 0 ? (
            <Card>
              <Empty icon={BarChart3} title={`Nothing sent in the last ${days} days`}>
                Reply rates appear here once a campaign has gone out.
              </Empty>
            </Card>
          ) : (
            <>
              <Card title="By sequence" icon={BarChart3} tight>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Sequence</th>
                        <th className="num">Started</th>
                        <th className="num">Replied</th>
                        <th>Reply rate</th>
                        <th className="num">Opted out</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.sequences.map((q) => (
                        <tr key={q.sequence}>
                          <td>
                            <div className="strong">{sequenceName(q.sequence)}</div>
                            <div className="muted">{q.sequence}</div>
                          </td>
                          <td className="num">{q.started}</td>
                          <td className="num">{q.replied}</td>
                          <td>
                            <Rate part={q.replied} whole={q.started} />
                          </td>
                          <td className="num">{q.optedOut}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <Card title="By message" icon={BarChart3} tight>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Message</th>
                        <th className="num">Sent</th>
                        <th className="num">Replies</th>
                        <th>Reply rate</th>
                        <th className="num">Opt-outs</th>
                        <th className="num">Bounces</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.templates.map((t) => (
                        <tr key={t.templateId}>
                          <td className="strong">{t.templateId}</td>
                          <td className="num">{t.sent}</td>
                          <td className="num">{t.replied}</td>
                          <td>
                            <Rate part={t.replied} whole={t.sent} />
                          </td>
                          <td className="num">{t.optedOut}</td>
                          <td className="num">{t.bounced}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </>
      ) : null}
    </>
  );
}
