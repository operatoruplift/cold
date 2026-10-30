import { Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { Campaign, CampaignInput, LibraryResponse, SourceOption } from "../../domains/web/types";
import { useStatus } from "../app/status";
import { api, ApiError, useApi } from "../lib/api";
import { channelLabel, sequenceName, voiceLabel } from "../lib/format";
import { Button, ErrorNotice, Field, Modal } from "../ui/kit";
import { useToast } from "../ui/toast";

/** New or edit campaign: a sequence, the account that sends it, an offer, a prospect list. */
export function CampaignForm({ campaign, onClose, onSaved }: { campaign?: Campaign; onClose: () => void; onSaved: (c: Campaign) => void }) {
  const status = useStatus();
  const library = useApi<LibraryResponse>("/api/library");
  const sources = useApi<SourceOption[]>("/api/sources");
  const toast = useToast();
  const [form, setForm] = useState<CampaignInput>({
    name: campaign?.name ?? "",
    sequence: campaign?.sequence ?? "",
    account: campaign?.account ?? "",
    offer: campaign?.offer ?? status.data?.defaultOffer,
    source: campaign?.source ?? "csv:examples/prospects.csv",
    where: campaign?.where,
  });
  const [error, setError] = useState<ApiError>();
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<CampaignInput>) => setForm((f) => ({ ...f, ...patch }));

  const sequence = library.data?.sequences.find((s) => s.id === form.sequence);
  const accounts = (status.data?.accounts ?? []).filter((a) => !sequence || a.voice === sequence.voice);

  useEffect(() => {
    if (sequence && !accounts.some((a) => a.key === form.account)) set({ account: accounts[0]?.key ?? "" });
  }, [form.sequence, status.data]);

  const groups = useMemo(() => {
    const map = new Map<string, NonNullable<LibraryResponse["sequences"]>>();
    for (const s of library.data?.sequences ?? []) {
      const label = `${channelLabel(s.channel, s.platform)}, ${voiceLabel(s.voice).toLowerCase()}`;
      map.set(label, [...(map.get(label) ?? []), s]);
    }
    return [...map.entries()];
  }, [library.data]);

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const result = await api<{ source: string; rows: number }>("/api/sources/csv", { method: "POST", body: { name: file.name, content: await file.text() } });
      sources.reload();
      set({ source: result.source, where: undefined });
      toast.success(`Added ${result.rows} prospects from ${file.name}.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      const saved = campaign ? await api<Campaign>(`/api/campaigns/${campaign.id}`, { method: "PUT", body: form }) : await api<Campaign>("/api/campaigns", { method: "POST", body: form });
      onSaved(saved);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setSaving(false);
    }
  }

  const isTwenty = form.source.startsWith("twenty:");
  return (
    <Modal
      title={campaign ? "Edit campaign" : "New campaign"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!form.name || !form.sequence || !form.account} onClick={save}>
            {campaign ? "Save" : "Create campaign"}
          </Button>
        </>
      }
    >
      <ErrorNotice error={error} title="Not saved" />
      <div style={{ marginTop: error ? 14 : 0 }}>
        <Field label="Name">
          <input className="input" autoFocus value={form.name} placeholder="Austin tint shops, founder emails" onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Sequence" hint={sequence ? `${sequence.steps.length} steps over ${sequence.steps[sequence.steps.length - 1]?.day ?? 0} days. ${sequence.steps[0]?.when ?? ""}` : "The messages and their timing, from the library."}>
          <select className="select" value={form.sequence} onChange={(e) => set({ sequence: e.target.value })}>
            <option value="">Pick a sequence</option>
            {groups.map(([label, list]) => (
              <optgroup key={label} label={label}>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>
                    {sequenceName(s.id)} ({s.steps.length} steps)
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="Sends from" hint={sequence ? `Only ${sequence.voice} accounts can send a ${sequence.voice} sequence.` : undefined}>
          <select className="select" value={form.account} onChange={(e) => set({ account: e.target.value })} disabled={!sequence}>
            {accounts.map((a) => (
              <option key={a.key} value={a.key}>
                {a.key}: {a.senderName}
                {a.email ? ` <${a.email.from.replace(/^.*<|>.*$/g, "")}>` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Offer" hint="Who you help, what you do and the proof: filled into every message.">
          <select className="select" value={form.offer ?? ""} onChange={(e) => set({ offer: e.target.value || undefined })}>
            {(status.data?.offers ?? []).map((o) => (
              <option key={o.key} value={o.key}>
                {o.key}
                {o.audience ? `: ${o.audience}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Prospects" hint="A CSV with a header row (first_name, email, company, trigger, linkedin_url...) or a list from Twenty.">
          <div className="row">
            <select className="select" value={form.source} onChange={(e) => set({ source: e.target.value, where: undefined })}>
              {(sources.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
              {!sources.data?.some((s) => s.id === form.source) && <option value={form.source}>{form.source}</option>}
            </select>
            <input ref={fileInput} type="file" accept=".csv,text/csv" hidden onChange={upload} />
            <Button icon={Upload} loading={uploading} onClick={() => fileInput.current?.click()}>
              Upload CSV
            </Button>
          </div>
        </Field>
        {isTwenty && (
          <Field label="Twenty filter (optional)" hint={'For example coldCallStatus[eq]:NEW or jobTitle[ilike]:"%owner%"'}>
            <input className="input" value={form.where ?? ""} onChange={(e) => set({ where: e.target.value })} placeholder="field[eq]:value" />
          </Field>
        )}
      </div>
    </Modal>
  );
}
