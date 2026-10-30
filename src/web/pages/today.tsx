import { Ban, CalendarClock, Inbox, Megaphone, MessageSquareReply, Plus, Send, MailX } from "lucide-react";
import type { Campaign, PlanResponse, TouchRow } from "../../domains/web/types";
import { Link, navigate } from "../app/router";
import { useStatus } from "../app/status";
import { useApi } from "../lib/api";
import { channelLabel, plural, sequenceName, when } from "../lib/format";
import { Button, Card, Empty, ErrorNotice, Loading, Notice, PageHeader, Pill, Stat } from "../ui/kit";
import { ChannelLabel, KindPill, sequenceChannelIcon } from "../ui/touch";

function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function CampaignDueRow({ campaign }: { campaign: Campaign }) {
  const { data, error, loading } = useApi<PlanResponse>(`/api/campaigns/${campaign.id}/plan`);
  const isEmail = campaign.sequence.startsWith("email/");
  const Icon = sequenceChannelIcon(isEmail ? "email" : "dm", data?.platform);
  return (
    <tr className="clickable" onClick={() => navigate(`/campaigns/${campaign.id}`)}>
      <td>
        <div className="strong">{campaign.name}</div>
        <div className="muted">{sequenceName(campaign.sequence)}</div>
      </td>
      <td>
        <span className="row text-2" style={{ gap: 6 }}>
          <Icon size={14} className="text-3" />
          {channelLabel(isEmail ? "email" : "dm", data?.platform)}
        </span>
      </td>
      <td className="text-2">{campaign.account}</td>
      {loading ? (
        <td colSpan={3}>
          <div className="skeleton" style={{ width: 120 }} />
        </td>
      ) : error ? (
        <td colSpan={3} className="text-red truncate" style={{ maxWidth: 360 }} title={error.message}>
          {error.message}
        </td>
      ) : (
        <>
          <td className="num">
            {data!.sendable > 0 ? (
              <Pill tone="blue">{data!.sendable} due</Pill>
            ) : (
              <span className="muted">none</span>
            )}
          </td>
          <td className="num text-2">{data!.waiting.length}</td>
          <td className="num">{data!.blockers.length > 0 ? <Pill tone="amber">needs setup</Pill> : <span className="muted">ready</span>}</td>
        </>
      )}
      <td className="num">
        <Button size="sm" variant={data && data.sendable > 0 ? "primary" : "default"} onClick={() => navigate(`/campaigns/${campaign.id}`)}>
          {isEmail ? "Open" : "Work queue"}
        </Button>
      </td>
    </tr>
  );
}

export function TodayPage() {
  const status = useStatus();
  const campaigns = useApi<Campaign[]>("/api/campaigns");
  const touches = useApi<TouchRow[]>("/api/touches?days=7&limit=1000");
  const all = touches.data ?? [];
  const today = startOfToday();
  const count = (kind: TouchRow["kind"]) => all.filter((t) => t.kind === kind).length;

  return (
    <>
      <PageHeader
        title="Today"
        sub={new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => navigate("/campaigns?new=1")}>
            New campaign
          </Button>
        }
      />

      {status.data?.isExample && (
        <Notice
          tone="amber"
          title="You are looking at the example setup"
          action={
            <Button size="sm" onClick={() => navigate("/settings")}>
              Open settings
            </Button>
          }
        >
          cold.yaml does not exist yet, so the sender is the example (Alex at Brightside Studio) and nothing can be sent. Create it in Settings with your own details.
        </Notice>
      )}

      <div className="grid stats" style={{ marginTop: status.data?.isExample ? 16 : 0 }}>
        <Stat label="Sent today" icon={Send} tone="blue" value={touches.loading ? "-" : all.filter((t) => t.kind === "SENT" && t.occurredAt >= today).length} note="Emails and DMs" />
        <Stat label="Replies" icon={MessageSquareReply} tone="green" value={touches.loading ? "-" : count("REPLIED")} note="Last 7 days" />
        <Stat label="Opt-outs" icon={Ban} tone="red" value={touches.loading ? "-" : count("OPTED_OUT")} note="Last 7 days" />
        <Stat label="Bounces" icon={MailX} tone="amber" value={touches.loading ? "-" : count("BOUNCED")} note="Last 7 days" />
      </div>

      <Card title="What's due" icon={CalendarClock} tight>
        {campaigns.loading ? (
          <Loading label="Loading campaigns" />
        ) : campaigns.error ? (
          <div className="card-body">
            <ErrorNotice error={campaigns.error} />
          </div>
        ) : !campaigns.data?.length ? (
          <Empty
            icon={Megaphone}
            title="No campaigns yet"
            action={
              <Button variant="primary" icon={Plus} onClick={() => navigate("/campaigns?new=1")}>
                Create a campaign
              </Button>
            }
          >
            A campaign is a sequence, the account that sends it, and a list of prospects. Then this page shows who is due each day.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Channel</th>
                  <th>Sends from</th>
                  <th className="num">Due now</th>
                  <th className="num">Waiting</th>
                  <th className="num">Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {campaigns.data.map((c) => (
                  <CampaignDueRow key={c.id} campaign={c} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Recent activity"
        icon={Inbox}
        tight
        actions={
          <Link to="/replies" className="hint">
            All replies
          </Link>
        }
      >
        {touches.loading ? (
          <Loading />
        ) : touches.error ? (
          <div className="card-body">
            <ErrorNotice error={touches.error} />
          </div>
        ) : all.length === 0 ? (
          <Empty icon={Inbox} title="Nothing yet this week">
            Every email sent, DM logged, reply and opt-out shows up here.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {all.slice(0, 10).map((t, i) => (
                  <tr key={t.id ?? i}>
                    <td className="muted" style={{ width: 130 }}>
                      {when(t.occurredAt)}
                    </td>
                    <td style={{ width: 120 }}>
                      <KindPill kind={t.kind} />
                    </td>
                    <td style={{ width: 120 }}>
                      <ChannelLabel channel={t.channel} />
                    </td>
                    <td className="strong">{t.prospectLabel ?? t.prospectKey}</td>
                    <td className="muted">{t.sequence ? `${sequenceName(t.sequence)}${t.step ? `, step ${t.step}` : ""}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {campaigns.data && campaigns.data.length > 0 && <p className="hint" style={{ marginTop: 12 }}>{plural(campaigns.data.length, "campaign")}. Counts include only prospects the rules allow today.</p>}
    </>
  );
}
