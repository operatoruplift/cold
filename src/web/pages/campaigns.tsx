import { Megaphone, Plus } from "lucide-react";
import { useState } from "react";
import type { Campaign } from "../../domains/web/types";
import { navigate, setQuery, useLocation } from "../app/router";
import { useApi } from "../lib/api";
import { sequenceName, sourceLabel, voiceLabel } from "../lib/format";
import { Button, Card, Empty, ErrorNotice, Loading, PageHeader, Pill } from "../ui/kit";
import { sequenceChannelIcon } from "../ui/touch";
import { CampaignForm } from "./campaignForm";

export function CampaignsPage() {
  const { query } = useLocation();
  const campaigns = useApi<Campaign[]>("/api/campaigns");
  const [creating, setCreating] = useState(query.get("new") === "1");
  const [source] = useState(query.get("source") ?? undefined);
  const close = () => {
    setCreating(false);
    setQuery({ new: undefined, source: undefined });
  };

  return (
    <>
      <PageHeader
        title="Campaigns"
        count={campaigns.data?.length}
        sub="A sequence, the account that sends it, and who it goes to."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            New campaign
          </Button>
        }
      />
      <Card tight>
        {campaigns.loading ? (
          <Loading />
        ) : campaigns.error ? (
          <div className="card-body">
            <ErrorNotice error={campaigns.error} />
          </div>
        ) : !campaigns.data?.length ? (
          <Empty
            icon={Megaphone}
            title="No campaigns yet"
            action={
              <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                New campaign
              </Button>
            }
          >
            Start with the example list to see how it works: pick founder-direct, send from your personal account, and use examples/prospects.csv.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Sequence</th>
                  <th>Voice</th>
                  <th>Sends from</th>
                  <th>Prospects</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.data.map((c) => {
                  const [channel, voice, , ] = c.sequence.split("/");
                  const Icon = sequenceChannelIcon(channel === "email" ? "email" : "dm", c.sequence.split("/")[2]);
                  return (
                    <tr key={c.id} className="clickable" onClick={() => navigate(`/campaigns/${c.id}`)}>
                      <td className="strong">{c.name}</td>
                      <td>
                        <span className="row text-2" style={{ gap: 6 }}>
                          <Icon size={14} className="text-3" />
                          {sequenceName(c.sequence)}
                        </span>
                      </td>
                      <td>
                        <Pill tone={voice === "personal" ? "teal" : "purple"}>{voiceLabel(voice as "personal" | "company")}</Pill>
                      </td>
                      <td className="text-2">{c.account}</td>
                      <td className="text-2">
                        {sourceLabel(c.source)}
                        {c.where ? <span className="muted"> ({c.where})</span> : null}
                      </td>
                      <td className="muted">{new Date(c.createdAt).toLocaleDateString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <CampaignForm source={source} onClose={close} onSaved={(c) => navigate(`/campaigns/${c.id}`)} />}
    </>
  );
}
