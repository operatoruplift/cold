import type { ProspectSummary, SourceOption } from "../../domains/web/types";
import { useApi } from "../lib/api";

/** Pick a prospect list and someone on it, to fill a message or script in for them. */
export function ProspectPicker({ source, prospect, onChange }: { source: string; prospect: string; onChange: (source: string, prospect: string) => void }) {
  const sources = useApi<SourceOption[]>("/api/sources");
  const list = useApi<{ total: number; prospects: ProspectSummary[] }>(source ? `/api/prospects?source=${encodeURIComponent(source)}` : null);
  return (
    <>
      <div className="field">
        <label>Fill in for</label>
        <select className="select" value={source} onChange={(e) => onChange(e.target.value, "")}>
          <option value="">Example values</option>
          {(sources.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      {source && (
        <div className="field">
          <label>Prospect</label>
          <select className="select" value={prospect} onChange={(e) => onChange(source, e.target.value)} disabled={list.loading}>
            <option value="">{list.loading ? "Loading..." : list.error ? list.error.message : "Pick someone"}</option>
            {(list.data?.prospects ?? []).map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
                {p.doNotContact ? " (Do Not Contact)" : ""}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}
