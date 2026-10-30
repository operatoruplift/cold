import { filterAnd, filterIn, filterValue, readLiveSchema, type TwentyClient, type TwentyRecord } from "../../twenty";
import type { ProspectLinks } from "../../prospects";
import type { Touch, TouchStore } from "../types";

const SCALARS = ["kind", "channel", "voice", "account", "sequence", "step", "templateId", "prospectKey", "toAddress", "fromAddress", "subject", "body", "messageId", "error", "occurredAt"] as const;
/** Relation field -> its REST foreign key and the Touch link it carries. */
const RELATIONS = [
  { field: "person", key: "personId" },
  { field: "company", key: "companyId" },
  { field: "agencyProspect", key: "agencyProspectId" },
  { field: "agencyPerson", key: "agencyPersonId" },
] as const;

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** The record name shown in Twenty: "Sent email: founder-direct #1 to Dana Reyes (Clearview Tint)". */
export function touchName(t: Touch): string {
  const what = t.kind.charAt(0) + t.kind.slice(1).toLowerCase().replace("_", " ");
  const where = t.channel === "EMAIL" ? "email" : t.channel === "CALL" ? "call" : `${t.channel.charAt(0)}${t.channel.slice(1).toLowerCase()}`;
  const seq = t.sequence ? `: ${t.sequence.split("/").pop()}${t.step ? ` #${t.step}` : ""}` : "";
  return `${what} ${where}${seq}${t.prospectLabel ? ` - ${t.prospectLabel}` : ""}`.slice(0, 250);
}

/**
 * The touch log in Twenty, as coldTouch records linked to the person,
 * company or dialer prospect they are about, so every email, DM, reply and
 * opt-out shows on that record's timeline.
 */
export class TwentyStore implements TouchStore {
  readonly kind = "twenty" as const;

  private constructor(
    private readonly client: TwentyClient,
    private readonly fields: Set<string>,
  ) {}

  /** Checks coldTouch exists and learns which relations this workspace has. */
  static async open(client: TwentyClient): Promise<TwentyStore> {
    const live = await readLiveSchema((query, variables) => client.metadata(query, variables));
    const touch = live.get("coldTouch");
    if (!touch) throw new Error("This Twenty workspace has no coldTouch object yet. Run: bun run twenty:schema");
    return new TwentyStore(client, new Set(touch.fields.keys()));
  }

  get where(): string {
    return `${this.client.config.baseUrl} (coldTouches)`;
  }

  toRecord(t: Touch): Record<string, unknown> {
    const record: Record<string, unknown> = { name: touchName(t) };
    for (const field of SCALARS) {
      const value = t[field];
      if (value !== undefined && value !== "" && this.fields.has(field)) record[field] = field === "body" ? String(value).slice(0, 20_000) : value;
    }
    for (const { field, key } of RELATIONS) {
      const id = t.links?.[key];
      if (id && this.fields.has(field)) record[key] = id;
    }
    return record;
  }

  static fromRecord(r: TwentyRecord): Touch {
    const links: ProspectLinks = {};
    for (const { key } of RELATIONS) if (str(r[key])) links[key] = r[key] as string;
    return {
      id: r.id,
      kind: r.kind as Touch["kind"],
      channel: r.channel as Touch["channel"],
      voice: str(r.voice) as Touch["voice"],
      account: str(r.account),
      sequence: str(r.sequence),
      step: typeof r.step === "number" ? r.step : undefined,
      templateId: str(r.templateId),
      prospectKey: str(r.prospectKey) ?? "",
      toAddress: str(r.toAddress),
      fromAddress: str(r.fromAddress),
      subject: str(r.subject),
      body: str(r.body),
      messageId: str(r.messageId),
      error: str(r.error),
      occurredAt: str(r.occurredAt) ?? str(r.createdAt) ?? new Date(0).toISOString(),
      links,
    };
  }

  async record(touch: Touch): Promise<void> {
    await this.client.create("coldTouches", this.toRecord(touch));
  }

  /** Touches keyed to any of these identities, or sent to one of their email addresses. */
  async forProspects(identities: string[]): Promise<Touch[]> {
    const unique = [...new Set(identities)];
    const out = new Map<string, Touch>();
    for (let i = 0; i < unique.length; i += 40) {
      const chunk = unique.slice(i, i + 40);
      const emails = chunk.filter((id) => id.startsWith("email:")).map((id) => id.slice(6));
      const byKey = filterIn("prospectKey", chunk);
      const filter = emails.length ? `or(${byKey},${filterIn("toAddress", emails)})` : byKey;
      for (const row of await this.client.list("coldTouches", { filter })) out.set(row.id, TwentyStore.fromRecord(row));
    }
    return [...out.values()];
  }

  async suppressions(): Promise<Touch[]> {
    const rows = await this.client.list("coldTouches", { filter: filterIn("kind", ["OPTED_OUT", "BOUNCED", "UNDELIVERABLE"]) });
    return rows.map(TwentyStore.fromRecord);
  }

  async since(isoTime: string, filter: { account?: string; channel?: Touch["channel"]; kind?: Touch["kind"] } = {}): Promise<Touch[]> {
    const rows = await this.client.list("coldTouches", {
      filter: filterAnd(
        `occurredAt[gte]:${filterValue(isoTime)}`,
        filter.account ? `account[eq]:${filterValue(filter.account)}` : undefined,
        filter.channel ? `channel[eq]:${filterValue(filter.channel)}` : undefined,
        filter.kind ? `kind[eq]:${filterValue(filter.kind)}` : undefined,
      ),
    });
    return rows.map(TwentyStore.fromRecord);
  }

  /** Sets the dialer prospect's call status to Do Not Contact, so the dialer will not call them either. */
  async markDoNotContact(links: ProspectLinks | undefined): Promise<void> {
    if (links?.agencyProspectId) await this.client.update("agencyProspects", links.agencyProspectId, { coldCallStatus: "DO_NOT_CONTACT" });
  }
}
