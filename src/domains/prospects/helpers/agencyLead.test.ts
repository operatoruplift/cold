import { describe, expect, test } from "bun:test";
import { TwentyClient } from "../../twenty";
import { findProspect, loadProspects } from "..";
import { fromAgencyLead, leadNote, leadTrigger } from "./agencyLead";

/** A note exactly as offer writes it (backend/src/routes/leads.ts). */
function offerNote(contact: { name?: string; email?: string; phone?: string }, answers: Record<string, unknown> | string = {}): string {
  const contactNote = [`Name: ${contact.name || "—"}`, `Email: ${contact.email || "—"}`, `Phone: ${contact.phone || "—"}`].join("\n");
  const parts = [
    typeof answers === "string" ? answers : `Quiz answers: ${JSON.stringify(answers, null, 2)}`,
    `Quiz detail: ${JSON.stringify({ score: 7, steps: [{ id: "q1", dq: false }] }, null, 2)}`,
    "OfferId: offer-9",
    "Source URL: https://offer.example/q/clearview?utm_source=facebook",
    "visitor_id: v-1",
    "UTM source: facebook",
    "UTM medium: paid",
    "UTM campaign: fall-tint",
  ];
  return [contactNote, parts.join("\n\n")].join("\n\n");
}

const ANSWERS = { "Cars a week": "10-20", "Biggest problem": "No-shows", Services: ["Tint", "PPF"] };

describe("leadNote", () => {
  test("reads offer's contact lines, the quiz answers and the tagged lines, not the quiz detail", () => {
    const note = leadNote(offerNote({ name: "Sam Lee", email: "Sam@Example.com", phone: "(512) 555-0147" }, ANSWERS));
    expect(note.name).toBe("Sam Lee");
    expect(note.email).toBe("sam@example.com");
    expect(note.phone).toBe("(512) 555-0147");
    expect(note.answers).toEqual({ "Cars a week": "10-20", "Biggest problem": "No-shows", Services: "Tint, PPF" });
    expect(note.fields).toMatchObject({ offerid: "offer-9", source_url: "https://offer.example/q/clearview?utm_source=facebook", utm_source: "facebook", utm_medium: "paid", utm_campaign: "fall-tint", visitor_id: "v-1" });
    expect(Object.keys(note.fields)).not.toContain("score");
  });

  test("an empty contact line is offer's dash, read as nothing", () => {
    const note = leadNote(offerNote({}, { q: "a" }));
    expect(note.name).toBeUndefined();
    expect(note.email).toBeUndefined();
    expect(note.phone).toBeUndefined();
  });

  test("answers cut off by offer's 9000-character limit are dropped, and the other lines still read", () => {
    const note = leadNote(offerNote({ name: "Sam Lee" }, 'Quiz answers: {\n  "Cars a week": "10-2'));
    expect(note.answers).toEqual({});
    expect(note.name).toBe("Sam Lee");
    expect(note.fields.utm_source).toBe("facebook");
  });

  test("answers written on one line read the same as answers over several, braces and quotes in an answer included", () => {
    const answers = { "Cars a week": "10-20", Services: ["Tint", "Wraps"], "Anything else?": 'Need a {rush} "quote"' };
    const note = leadNote(offerNote({ name: "Sam Lee" }, `Quiz answers: ${JSON.stringify(answers)}`));
    expect(note.answers).toEqual({ "Cars a week": "10-20", Services: "Tint, Wraps", "Anything else?": 'Need a {rush} "quote"' });
    expect(note.answers).toEqual(leadNote(offerNote({ name: "Sam Lee" }, answers)).answers);
    expect(note.fields.quiz_answers).toBeUndefined();
    expect(note.fields.utm_source).toBe("facebook");
  });

  test("no note at all", () => {
    expect(leadNote(undefined)).toEqual({ name: undefined, email: undefined, phone: undefined, answers: {}, fields: {} });
  });
});

describe("fromAgencyLead", () => {
  const lead = {
    id: "lead-1",
    name: "Sam Lee",
    contactName: "Sam Lee",
    note: offerNote({ name: "Sam Lee", email: "sam@example.com", phone: "(512) 555-0147" }, ANSWERS),
    source: "quiz",
    qualificationStatus: "QUALIFIED",
    status: "QUALIFIED",
    createdAt: "2026-11-01T16:20:00.000Z",
  };

  test("a lead on its own: who took the quiz, their answers, where they came from", () => {
    const p = fromAgencyLead(lead);
    expect(p.key).toBe("email:sam@example.com");
    expect(p.identities).toContain("agencyLeads:lead-1");
    expect(p.label).toBe("Sam Lee");
    expect(p.phone).toBe("(512) 555-0147");
    expect(p.variables).toMatchObject({
      first_name: "Sam",
      full_name: "Sam Lee",
      lead_id: "lead-1",
      qualification: "QUALIFIED",
      utm_source: "facebook",
      offer_id: "offer-9",
      quiz_answers: "Cars a week: 10-20; Biggest problem: No-shows; Services: Tint, PPF",
      trigger: "Saw you took our quiz on Nov 1.",
    });
    expect(p.links).toEqual({ agencyLeadId: "lead-1" });
    expect(p.source).toBe("agencyLeads");
  });

  test("through a business's own funnel link: the business's details, the quiz taker's name, one history with the business", () => {
    const business = { id: "ap-1", name: "Clearview Tint", decisionMaker: "Dana Reyes", decisionMakerTitle: "Owner", city: "Austin", coldTrigger: "Saw your 212 reviews.", coldCallStatus: "DO_NOT_CONTACT" };
    const p = fromAgencyLead({ ...lead, agencyProspectId: "ap-1" }, business);
    expect(p.key).toBe("agencyProspect:ap-1");
    expect(p.label).toBe("Sam Lee (Clearview Tint)");
    expect(p.variables).toMatchObject({ company: "Clearview Tint", city: "Austin", first_name: "Sam", trigger: "Saw your 212 reviews." });
    expect(p.variables.title).toBeUndefined();
    expect(p.links).toEqual({ agencyProspectId: "ap-1", agencyLeadId: "lead-1" });
    expect(p.doNotContact).toBe(true);
  });

  test("a lead who gave no name is never called by the business's decision maker's", () => {
    const p = fromAgencyLead({ ...lead, contactName: "", note: offerNote({ phone: "512 555 0100" }) }, { id: "ap-1", name: "Clearview Tint", decisionMaker: "Dana Reyes" });
    expect(p.variables.first_name).toBeUndefined();
    expect(p.label).toBe("Clearview Tint");
  });

  test("the trigger is the day they took the quiz, and nothing without a date", () => {
    expect(leadTrigger("2026-11-02T23:30:00Z")).toBe("Saw you took our quiz on Nov 2.");
    expect(leadTrigger("not a date")).toBeUndefined();
    expect(leadTrigger(undefined)).toBeUndefined();
  });
});

describe("loadProspects twenty:agencyLeads", () => {
  test("reads the leads and only the businesses they link to", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      asked.push(`${url.pathname} ${url.searchParams.get("filter") ?? ""}`);
      if (url.pathname === "/rest/agencyLeads")
        return Response.json({
          data: {
            agencyLeads: [
              { id: "lead-1", contactName: "Sam Lee", note: offerNote({ name: "Sam Lee", phone: "512 555 0147" }), agencyProspectId: "ap-1", createdAt: "2026-11-01T16:20:00.000Z" },
              { id: "lead-2", contactName: "Ana Ruiz", note: offerNote({ name: "Ana Ruiz", email: "ana@example.com" }), agencyProspectId: null, createdAt: "2026-11-01T17:00:00.000Z" },
            ],
          },
        });
      if (url.pathname === "/rest/agencyProspects") return Response.json({ data: { agencyProspects: [{ id: "ap-1", name: "Clearview Tint" }] } });
      return Response.json({ data: {} });
    }) as typeof fetch;
    const client = new TwentyClient({ baseUrl: "https://crm.example", apiKey: "k" }, fetchImpl);
    const prospects = await loadProspects("twenty:agencyLeads", { client, where: 'createdAt[gte]:"2026-11-01T00:00:00.000Z"' });
    expect(prospects.map((p) => p.label)).toEqual(["Sam Lee (Clearview Tint)", "Ana Ruiz"]);
    expect(asked[0]).toBe('/rest/agencyLeads createdAt[gte]:"2026-11-01T00:00:00.000Z"');
    expect(asked[1]).toBe('/rest/agencyProspects id[in]:["ap-1"]');
    expect(asked).toHaveLength(2);
  });
});

describe("findProspect", () => {
  test("finds a Twenty prospect by its key as the pickers send it, whatever the case", () => {
    const sam = fromAgencyLead({ id: "lead-1", contactName: "Sam Lee", agencyProspectId: "ap-1" }, { id: "ap-1", name: "Clearview Tint" });
    const ana = fromAgencyLead({ id: "lead-2", contactName: "Ana Ruiz", note: "Email: Ana@Example.com" });
    const all = [ana, sam];
    expect(findProspect(all, "agencyProspect:ap-1")).toBe(sam);
    expect(findProspect(all, "agencyprospect:AP-1")).toBe(sam);
    expect(findProspect(all, "agencyLeads:lead-2")).toBe(ana);
    expect(findProspect(all, "ana@example.com")).toBe(ana);
    expect(findProspect(all, "clearview")).toBe(sam);
    expect(findProspect(all, "nobody")).toBeUndefined();
  });
});
