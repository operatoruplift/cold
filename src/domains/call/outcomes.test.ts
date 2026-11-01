import { describe, expect, test } from "bun:test";
import type { ProspectLinks } from "../prospects";
import type { Touch, TouchStore } from "../touches";
import { TwentyClient } from "../twenty";
import { callOutcomeLines, callSettled, callTouch, syncCallOutcomes } from ".";

const NOW = new Date("2026-11-02T18:00:00Z");
const call = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  disposition: "INTERESTED",
  status: "COMPLETED",
  direction: "OUTBOUND",
  toNumber: "+15125550101",
  fromNumber: "+15125559999",
  startedAt: "2026-11-02T16:00:00.000Z",
  endedAt: "2026-11-02T16:04:00.000Z",
  createdAt: "2026-11-02T16:00:00.000Z",
  aiAnalyzedAt: "2026-11-02T16:05:00.000Z",
  aiScore: 81.6,
  aiSentiment: "Positive",
  aiSummary: "Owner wants a demo\\nnext Tuesday.",
  agencyProspectId: "ap-1",
  ...over,
});

/** A touch store in memory, with what it was asked to mark. */
function memoryStore(existing: Touch[] = []) {
  const touches = [...existing];
  const marked: Array<ProspectLinks | undefined> = [];
  const store: TouchStore = {
    kind: "file",
    where: "memory",
    record: async (t) => void touches.push(t),
    forProspects: async (ids) => touches.filter((t) => ids.includes(t.prospectKey)),
    suppressions: async () => touches.filter((t) => t.kind === "OPTED_OUT"),
    since: async (iso, f = {}) => touches.filter((t) => t.occurredAt >= iso && (!f.channel || t.channel === f.channel)),
    markDoNotContact: async (links) => void marked.push(links),
  };
  return { store, touches, marked };
}

function fakeTwenty(calls: Array<Record<string, unknown>>) {
  const filters: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    filters.push(`${url.pathname} ${url.searchParams.get("filter")}`);
    const rows =
      url.pathname === "/rest/agencyCalls"
        ? calls
        : url.pathname === "/rest/agencyProspects"
          ? [{ id: "ap-1", name: "Clearview Tint" }]
          : url.pathname === "/rest/agencyLeads"
            ? [{ id: "lead-9", name: "Lead 2026-11-02", contactName: "Sam Lee" }]
            : [];
    return Response.json({ data: { [url.pathname.slice(6)]: rows } });
  }) as typeof fetch;
  return { filters, client: new TwentyClient({ baseUrl: "https://crm.example", apiKey: "k" }, fetchImpl) };
}

describe("callTouch", () => {
  test("a call with its outcome, the AI's score and tone, and what it summed up", () => {
    expect(callTouch(call(), "Clearview Tint")).toEqual({
      kind: "CALLED",
      channel: "CALL",
      prospectKey: "agencyProspect:ap-1",
      prospectLabel: "Clearview Tint",
      toAddress: "+15125550101",
      subject: "Interested, AI score 82, positive tone",
      body: "Owner wants a demo\\nnext Tuesday.",
      templateId: "dialer:INTERESTED",
      messageId: "agencyCall:c1",
      occurredAt: "2026-11-02T16:00:00.000Z",
      links: { agencyProspectId: "ap-1" },
    });
  });

  test("do not call is an opt-out; a call they made comes from their number; a lead without a business is keyed to the lead", () => {
    expect(callTouch(call({ disposition: "DNC" }))?.kind).toBe("OPTED_OUT");
    const inbound = callTouch(call({ direction: "INBOUND", aiScore: undefined, aiSentiment: undefined }))!;
    expect(inbound.subject).toBe("Interested, they called");
    expect(inbound.toAddress).toBe("+15125559999");
    const lead = callTouch(call({ agencyProspectId: null, agencyLeadId: "lead-9", aiSummary: null, summary: "Booked." }))!;
    expect(lead.prospectKey).toBe("agencyLeads:lead-9");
    expect(lead.links).toBeUndefined();
    expect(lead.body).toBe("Booked.");
  });

  test("no outcome, or no prospect or lead, is no touch", () => {
    expect(callTouch(call({ disposition: null }))).toBeUndefined();
    expect(callTouch(call({ agencyProspectId: null }))).toBeUndefined();
  });
});

describe("callSettled", () => {
  test("once the outcome is set, the call is over, and the AI has read it or had fifteen minutes", () => {
    expect(callSettled(call(), NOW)).toBe(true);
    expect(callSettled(call({ status: "IN_PROGRESS" }), NOW)).toBe(false);
    expect(callSettled(call({ disposition: null }), NOW)).toBe(false);
    expect(callSettled(call({ aiAnalyzedAt: null, endedAt: "2026-11-02T17:50:00.000Z" }), NOW)).toBe(false);
    expect(callSettled(call({ aiAnalyzedAt: null, endedAt: "2026-11-02T17:40:00.000Z" }), NOW)).toBe(true);
  });
});

describe("syncCallOutcomes", () => {
  test("logs each settled call once, by the business or lead it was with", async () => {
    const twenty = fakeTwenty([
      call({ id: "c2", startedAt: "2026-11-02T17:00:00.000Z" }),
      call({ id: "c1" }),
      call({ id: "c3", status: "IN_PROGRESS" }),
      call({ id: "c4", agencyProspectId: null }),
      call({ id: "c5", agencyProspectId: null, agencyLeadId: "lead-9", disposition: "VOICEMAIL" }),
    ]);
    const { store, touches } = memoryStore();
    const first = await syncCallOutcomes({ client: twenty.client, store, now: NOW });
    expect(first.logged.map((t) => [t.messageId, t.prospectLabel])).toEqual([
      ["agencyCall:c1", "Clearview Tint"],
      ["agencyCall:c5", "Sam Lee"],
      ["agencyCall:c2", "Clearview Tint"],
    ]);
    expect(first.logged.map((t) => t.messageId)).toEqual(touches.map((t) => t.messageId));
    expect(first).toMatchObject({ pending: 1, unlinked: 1, known: 0 });
    expect(twenty.filters[0]).toBe('/rest/agencyCalls and(createdAt[gte]:"2026-10-19T18:00:00.000Z",disposition[is]:NOT_NULL)');
    expect(callOutcomeLines(first)).toEqual([
      "2026-11-02 16:00  Clearview Tint: Interested, AI score 82, positive tone",
      "2026-11-02 16:00  Sam Lee: Voicemail, AI score 82, positive tone",
      "2026-11-02 17:00  Clearview Tint: Interested, AI score 82, positive tone",
      "1 call still settling: logged on a later run.",
      "1 call with no prospect or lead in the dialer: not logged.",
    ]);
    const again = await syncCallOutcomes({ client: twenty.client, store, now: NOW });
    expect(again.logged).toHaveLength(0);
    expect(again.known).toBe(3);
    expect(touches).toHaveLength(3);
  });

  test("do not call marks the dialer's prospect too; a dry run writes nothing", async () => {
    const twenty = fakeTwenty([call({ disposition: "DNC" })]);
    const dry = memoryStore();
    expect((await syncCallOutcomes({ client: twenty.client, store: dry.store, now: NOW, dryRun: true })).logged).toHaveLength(1);
    expect(dry.touches).toHaveLength(0);
    const real = memoryStore();
    await syncCallOutcomes({ client: twenty.client, store: real.store, now: NOW });
    expect(real.touches[0]!.kind).toBe("OPTED_OUT");
    expect(real.marked).toEqual([{ agencyProspectId: "ap-1" }]);
  });
});
