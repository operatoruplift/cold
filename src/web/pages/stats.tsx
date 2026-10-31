import { Ban, BarChart3, FlaskConical, MailX, MessageSquareReply, RefreshCw, Send } from "lucide-react";
import { useState } from "react";
import type { InsightsResponse, StatsResponse } from "../../domains/web/types";
import { useApi } from "../lib/api";
import { pct } from "../lib/decide";
import { percent, sequenceName } from "../lib/format";
import { Button, Card, Empty, ErrorNotice, Loading, PageHeader, Pill, Stat } from "../ui/kit";

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
      <WhatsWorking />
    </>
  );
}

const PICKED: Record<string, string> = { model: "The decision model's pick", explore: "Tried something else", learned: "Past results", you: "You chose", default: "Default (not scored)" };
const range = (low: number, high: number) => `${pct(low)} to ${pct(high)}`;

/** Which tones and openings get replies, from messages written in them; and whether higher scores reply more. */
function WhatsWorking() {
  const [refresh, setRefresh] = useState(0);
  const insights = useApi<InsightsResponse>(`/api/decide/insights${refresh ? `?refresh=1&n=${refresh}` : ""}`);
  const r = insights.data;
  return (
    <Card
      title="What's working: tone and opening"
      icon={FlaskConical}
      tight
      actions={
        <Button size="sm" icon={RefreshCw} loading={insights.loading} onClick={() => setRefresh((n) => n + 1)}>
          Update
        </Button>
      }
    >
      {insights.error ? (
        <div className="card-body">
          <ErrorNotice error={insights.error} />
        </div>
      ) : !r ? (
        <Loading />
      ) : r.totals.withResult === 0 ? (
        <Empty icon={FlaskConical} title="No results yet">
          Each AI draft is written in a tone and opening picked for that person. Once approved and sent, it counts here when it gets a reply, or after two weeks without one. So far: {r.totals.written} written, {r.totals.approved} approved, {r.totals.sent} sent, {r.totals.waiting} waiting.
        </Empty>
      ) : (
        <>
          <div className="card-body">
            <span className="text-2">
              {r.totals.wins} replies from {r.totals.withResult} messages with a result ({r.totals.waiting} still waiting). Ranges are where the true reply rate likely is (90%); a small sample gives a wide range, so let it fill before deciding.
            </span>
          </div>
          {(
            [
              ["Tone", r.tone],
              ["Opening", r.angle],
            ] as const
          ).map(([title, arms]) => (
            <div className="table-wrap" key={title}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{title}</th>
                    <th className="num">Messages</th>
                    <th className="num">Replies</th>
                    <th>Reply rate</th>
                    <th>Likely range</th>
                    <th className="num">Chance it's best</th>
                  </tr>
                </thead>
                <tbody>
                  {arms.map((a) => (
                    <tr key={a.arm}>
                      <td className="strong">{a.label}</td>
                      <td className="num">{a.n}</td>
                      <td className="num">{a.wins}</td>
                      <td>{a.rate === null ? <span className="muted">-</span> : <b>{pct(a.rate)}</b>}</td>
                      <td className="text-2">{a.n ? range(a.low, a.high) : ""}</td>
                      <td className="num">{a.n ? a.chanceBest >= 0.9 ? <Pill tone="green">{pct(a.chanceBest)}</Pill> : pct(a.chanceBest) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <div className="detail-grid card-body">
            <div>
              <div className="section-label">Who picked the style</div>
              <table className="table">
                <tbody>
                  {r.pickedBy.map((p) => (
                    <tr key={p.by}>
                      <td>{PICKED[p.by] ?? p.by}</td>
                      <td className="num">
                        {p.wins} of {p.n}
                      </td>
                      <td className="num">{p.rate === null ? "-" : pct(p.rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <div className="section-label">Do higher scores reply more?</div>
              <table className="table">
                <tbody>
                  {r.tiers.map((t) => (
                    <tr key={t.tier}>
                      <td>Tier {t.tier}</td>
                      <td className="num">
                        {t.wins} of {t.n}
                      </td>
                      <td className="num">{t.rate === null ? "-" : pct(t.rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
