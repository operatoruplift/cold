import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CALL_HOURS } from "../config";
import { openDatabase, type Db } from "../db";
import { fromAgencyLead } from "../prospects";
import type { Touch } from "../touches";
import { TwentyClient } from "../twenty";
import { countPush, lastCall, LeadWatch, leadPush, quizLead, rankLeads, readNtfy, recentLeads, sendNtfy, type NtfyMessage, type QuizLead } from ".";

const note = (name: string, phone = "512 555 0147") => `Name: ${name}\nEmail: —\nPhone: ${phone}\n\nQuiz answers: ${JSON.stringify({ "Cars a week": "10-20" }, null, 2)}\n\nUTM source: facebook`;

/** A fake Twenty holding agencyLeads and agencyProspects, answering the filters cold sends. */
function fakeTwenty() {
  const state = { leads: [] as Array<Record<string, unknown>>, prospects: [] as Array<Record<string, unknown>>, down: false };
  const fetchImpl = (async (input: string | URL | Request) => {
    if (state.down) return new Response(JSON.stringify({ messages: ["Service unavailable"] }), { status: 503 });
    const url = new URL(String(input));
    const filter = url.searchParams.get("filter") ?? "";
    const after = /createdAt\[(gt|gte)\]:"([^"]+)"/.exec(filter);
    const ids = /id\[in\]:\[([^\]]*)\]/.exec(filter)?.[1]?.split(",").map((s) => s.replace(/"/g, ""));
    const rows = (url.pathname === "/rest/agencyLeads" ? state.leads : state.prospects).filter((r) => {
      if (ids && !ids.includes(r.id as string)) return false;
      if (after) return after[1] === "gt" ? (r.createdAt as string) > after[2]! : (r.createdAt as string) >= after[2]!;
      return true;
    });
    return Response.json({ data: { [url.pathname.slice(6)]: rows } });
  }) as typeof fetch;
  return { state, client: new TwentyClient({ baseUrl: "https://crm.example", apiKey: "k" }, fetchImpl) };
}

/** A fake ntfy server that keeps what it was sent, and can refuse. */
function fakeNtfy() {
  const state = { sent: [] as Array<{ url: string; auth: string | null; body: NtfyMessage }>, status: 200 };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (state.status !== 200) return new Response('{"code":50001,"http":500,"error":"internal"}', { status: state.status });
    state.sent.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    return Response.json({ id: "m1" });
  }) as typeof fetch;
  return { state, fetchImpl };
}

const TARGET = { server: "https://ntfy.sh/", topic: "cold-leads-7f3k2q" };

describe("readNtfy", () => {
  test("the topic's address, on ntfy.sh or a server under a path, with its token", () => {
    expect(readNtfy({})).toEqual({});
    expect(readNtfy({ COLD_NTFY_URL: " https://ntfy.sh/cold-leads-7f3k2q " })).toEqual({ target: { server: "https://ntfy.sh/", topic: "cold-leads-7f3k2q", token: undefined } });
    expect(readNtfy({ COLD_NTFY_URL: "https://push.example.com/ntfy/cold_leads/", COLD_NTFY_TOKEN: "tk_abc" })).toEqual({ target: { server: "https://push.example.com/ntfy/", topic: "cold_leads", token: "tk_abc" } });
  });

  test("an unusable address says what is wrong", () => {
    expect(readNtfy({ COLD_NTFY_URL: "ntfy.sh/topic" }).problem).toMatch(/not a URL/);
    expect(readNtfy({ COLD_NTFY_URL: "ftp://ntfy.sh/topic" }).problem).toMatch(/https/);
    expect(readNtfy({ COLD_NTFY_URL: "https://me:pw@ntfy.sh/topic" }).problem).toMatch(/COLD_NTFY_TOKEN/);
    expect(readNtfy({ COLD_NTFY_URL: "https://ntfy.sh/" }).problem).toMatch(/topic's name/);
    expect(readNtfy({ COLD_NTFY_URL: "https://ntfy.sh/a%20b" }).problem).toMatch(/topic's name/);
    expect(readNtfy({ COLD_NTFY_URL: "https://ntfy.sh/a%20b" }).target).toBeUndefined();
  });
});

describe("sendNtfy", () => {
  test("publishes JSON to the server's root, with the topic and the token", async () => {
    const ntfy = fakeNtfy();
    await sendNtfy({ ...TARGET, token: "tk_abc" }, { title: "t", message: "m", tags: [], priority: 4 }, ntfy.fetchImpl);
    expect(ntfy.state.sent).toEqual([{ url: "https://ntfy.sh/", auth: "Bearer tk_abc", body: { title: "t", message: "m", tags: [], priority: 4, topic: "cold-leads-7f3k2q" } }]);
  });

  test("a refusal throws with ntfy's answer, and a token hint for 401 and 403", async () => {
    const ntfy = fakeNtfy();
    ntfy.state.status = 403;
    await expect(sendNtfy(TARGET, { title: "t", message: "m", tags: [], priority: 4 }, ntfy.fetchImpl)).rejects.toThrow(/ntfy answered 403.*check COLD_NTFY_TOKEN/);
  });
});

function lead(over: Partial<QuizLead> = {}): QuizLead {
  return { id: "lead-1", prospectKey: "agencyLeads:lead-1", label: "Sam Lee", name: "Sam Lee", phone: "512 555 0147", createdAt: "2026-11-01T16:20:00.000Z", qualified: true, answers: ["Cars a week: 10-20"], doNotContact: false, ...over };
}

describe("quiz leads", () => {
  test("a lead from its record: qualified unless offer said otherwise, answers as lines", () => {
    const record = { id: "lead-1", contactName: "Sam Lee", note: note("Sam Lee"), qualificationStatus: "QUALIFIED", createdAt: "2026-11-01T16:20:00.000Z" };
    const q = quizLead(record, fromAgencyLead(record));
    expect(q).toMatchObject({ id: "lead-1", label: "Sam Lee", phone: "512 555 0147", qualified: true, answers: ["Cars a week: 10-20"], from: "facebook" });
    expect(quizLead({ ...record, qualificationStatus: "DISQUALIFIED" }, fromAgencyLead(record)).qualified).toBe(false);
    expect(quizLead({ ...record, qualificationStatus: undefined, status: "LOST" }, fromAgencyLead(record)).qualified).toBe(false);
    expect(quizLead({ ...record, qualificationStatus: undefined }, fromAgencyLead(record)).qualified).toBe(true);
  });

  test("called, by any of the prospect's identities, the latest call", () => {
    const record = { id: "lead-1", contactName: "Sam Lee", note: note("Sam Lee"), createdAt: "2026-11-01T16:20:00.000Z" };
    const prospect = fromAgencyLead(record);
    const call = (prospectKey: string, occurredAt: string): Touch => ({ kind: "CALLED", channel: "CALL", prospectKey, occurredAt });
    expect(lastCall(prospect, [call("agencyLeads:lead-1", "2026-11-01T17:00:00Z"), call("agencyLeads:lead-1", "2026-11-01T18:00:00Z"), call("email:other@x.com", "2026-11-01T19:00:00Z")])).toBe("2026-11-01T18:00:00Z");
    expect(lastCall(prospect, [{ ...call("agencyLeads:lead-1", "2026-11-01T17:00:00Z"), channel: "EMAIL", kind: "SENT" }])).toBeUndefined();
  });

  test("who to call first: uncalled qualified leads, newest first, then the ones it's too late to call, called, disqualified, Do Not Contact", () => {
    const order = rankLeads([
      lead({ id: "asleep", createdAt: "2026-11-01T21:00:00Z", callTime: { ok: false, zones: ["Pacific/Honolulu"], from: ["phone"], note: "" } }),
      lead({ id: "dnc", doNotContact: true, createdAt: "2026-11-01T20:00:00Z" }),
      lead({ id: "dq", qualified: false, createdAt: "2026-11-01T19:00:00Z" }),
      lead({ id: "called", calledAt: "2026-11-01T18:30:00Z", createdAt: "2026-11-01T18:00:00Z" }),
      lead({ id: "older", createdAt: "2026-11-01T10:00:00Z" }),
      lead({ id: "newer", createdAt: "2026-11-01T12:00:00Z" }),
    ]).map((l) => l.id);
    expect(order).toEqual(["newer", "older", "asleep", "called", "dq", "dnc"]);
  });

  test("a push names the lead, the company, the number, their first answers, and opens the lead", () => {
    const push = leadPush(lead({ company: "Clearview Tint", label: "Sam Lee (Clearview Tint)" }), "https://cold.example.com/app/");
    expect(push.title).toBe("New quiz lead: Sam Lee");
    expect(push.message).toBe("Clearview Tint\nCall 512 555 0147\nCars a week: 10-20");
    expect(push.click).toBe("https://cold.example.com/app/calls?lead=lead-1");
    expect(push.priority).toBe(4);
    expect(leadPush(lead({ phone: undefined, email: "sam@example.com", answers: [] })).message).toBe("No phone given: sam@example.com");
    expect(leadPush(lead({ phone: undefined, answers: [] })).message).toBe("They took your quiz.");
  });

  test("a push says whether they can be called now, in their own time", () => {
    const record = { id: "lead-1", contactName: "Sam Lee", note: note("Sam Lee"), createdAt: "2026-11-03T03:58:00.000Z" };
    const at = (iso: string) => leadPush(quizLead(record, fromAgencyLead(record), undefined, { hours: DEFAULT_CALL_HOURS, now: new Date(iso) })).message;
    expect(at("2026-11-02T15:00:00Z")).toBe("Call 512 555 0147: 9:00 AM CST their time\nCars a week: 10-20");
    expect(at("2026-11-03T04:00:00Z")).toBe(
      "Not yet: 10:00 PM CST their time, outside calling hours: call from tomorrow 8:00 AM CST (from their phone number).\nTheir number: 512 555 0147\nCars a week: 10-20",
    );
  });

  test("many leads at once come as one push", () => {
    const leads = Array.from({ length: 7 }, (_, i) => lead({ id: `l${i}`, name: `Lead ${i}` }));
    const push = countPush(leads, "https://cold.example.com/app/");
    expect(push.title).toBe("7 new quiz leads");
    expect(push.message).toBe("Lead 0, Lead 1, Lead 2, Lead 3, Lead 4 and 2 more. Call them first: they're at the top of Calls.");
    expect(push.click).toBe("https://cold.example.com/app/calls");
    expect(countPush(leads, undefined, true).title).toBe("7+ new quiz leads");
  });
});

describe("LeadWatch", () => {
  let db: Db;
  let clock: Date;
  let twenty: ReturnType<typeof fakeTwenty>;
  let ntfy: ReturnType<typeof fakeNtfy>;
  const watch = (target: typeof TARGET | null = TARGET) => new LeadWatch({ db, client: () => twenty.client, target: () => target ?? undefined, appUrl: "https://cold.example.com/app/", fetch: ntfy.fetchImpl, now: () => clock });
  const later = (seconds: number) => (clock = new Date(clock.getTime() + seconds * 1000));
  const add = (id: string, over: Record<string, unknown> = {}) =>
    twenty.state.leads.push({ id, contactName: `Lead ${id}`, note: note(`Lead ${id}`), qualificationStatus: "QUALIFIED", createdAt: new Date(clock.getTime() - 1000).toISOString(), ...over });

  beforeEach(async () => {
    db = await openDatabase(":memory:");
    clock = new Date("2026-11-01T16:00:00.000Z");
    twenty = fakeTwenty();
    ntfy = fakeNtfy();
  });

  test("does nothing until alerts are set up", async () => {
    add("old");
    expect(await watch(null).tick()).toEqual({ looked: false, alerted: 0, found: 0 });
    expect(await watch(null).state()).toEqual({ lookedAt: undefined, seenUntil: undefined });
  });

  test("the first look only marks the time: leads from before are never pushed", async () => {
    add("old");
    const w = watch();
    expect(await w.tick()).toEqual({ looked: true, alerted: 0, found: 0 });
    expect(ntfy.state.sent).toHaveLength(0);
    expect((await w.state()).seenUntil).toBe("2026-11-01T16:00:00.000Z");
  });

  test("pushes each new qualified lead once, never a disqualified or Do Not Contact one", async () => {
    const w = watch();
    await w.tick();
    later(90);
    add("sam");
    add("dq", { qualificationStatus: "DISQUALIFIED" });
    twenty.state.prospects.push({ id: "ap-9", name: "Shine Detail", coldCallStatus: "DO_NOT_CONTACT" });
    add("dnc", { agencyProspectId: "ap-9" });
    expect(await w.tick()).toEqual({ looked: true, alerted: 1, found: 3 });
    expect(ntfy.state.sent.map((s) => s.body.title)).toEqual(["New quiz lead: Lead sam"]);
    expect(ntfy.state.sent[0]!.body.topic).toBe("cold-leads-7f3k2q");
    later(90);
    expect(await w.tick()).toEqual({ looked: true, alerted: 0, found: 0 });
    expect(ntfy.state.sent).toHaveLength(1);
  });

  test("looks at most once a minute, across every server on the database", async () => {
    const one = watch();
    const two = watch();
    await one.tick();
    later(90);
    add("sam");
    later(1);
    expect((await one.tick()).alerted).toBe(1);
    expect(await two.tick()).toEqual({ looked: false, alerted: 0, found: 0 });
    later(30);
    expect((await one.tick()).looked).toBe(false);
    expect((await two.tick()).looked).toBe(false);
    later(31);
    expect((await two.tick()).looked).toBe(true);
    expect(ntfy.state.sent).toHaveLength(1);
  });

  test("a push that fails is tried again on the next look, never skipped", async () => {
    const w = watch();
    await w.tick();
    later(90);
    add("sam");
    ntfy.state.status = 500;
    const failed = await w.tick();
    expect(failed.alerted).toBe(0);
    expect(failed.error).toMatch(/ntfy answered 500/);
    ntfy.state.status = 200;
    later(60);
    expect((await w.tick()).alerted).toBe(1);
    expect(ntfy.state.sent.map((s) => s.body.title)).toEqual(["New quiz lead: Lead sam"]);
  });

  test("Twenty being down is said, and the leads are pushed once it is back", async () => {
    const w = watch();
    await w.tick();
    later(90);
    add("sam");
    twenty.state.down = true;
    expect((await w.tick()).error).toMatch(/503/);
    twenty.state.down = false;
    later(60);
    expect((await w.tick()).alerted).toBe(1);
  });

  test("more than five new leads at once come as one push", async () => {
    const w = watch();
    await w.tick();
    later(90);
    for (const id of ["a", "b", "c", "d", "e", "f"]) add(id);
    expect(await w.tick()).toEqual({ looked: true, alerted: 1, found: 6 });
    expect(ntfy.state.sent[0]!.body.title).toBe("6 new quiz leads");
    later(60);
    expect((await w.tick()).alerted).toBe(0);
  });
});

describe("recentLeads", () => {
  test("the last days' leads, best to call first, with when each was called", async () => {
    const twenty = fakeTwenty();
    const now = new Date("2026-11-01T18:00:00.000Z");
    twenty.state.leads.push(
      { id: "old", contactName: "Old Lead", note: note("Old Lead"), createdAt: "2026-10-01T10:00:00.000Z" },
      { id: "sam", contactName: "Sam Lee", note: note("Sam Lee"), createdAt: "2026-11-01T16:00:00.000Z" },
      { id: "ana", contactName: "Ana Ruiz", note: note("Ana Ruiz"), createdAt: "2026-11-01T17:00:00.000Z" },
    );
    let since = "";
    const leads = await recentLeads(twenty.client, {
      now,
      calls: async (from) => {
        since = from;
        return [{ kind: "CALLED", channel: "CALL", prospectKey: "agencyLeads:ana", occurredAt: "2026-11-01T17:30:00Z" }];
      },
    });
    expect(since).toBe("2026-10-18T18:00:00.000Z");
    expect(leads.map((l) => [l.id, l.calledAt])).toEqual([
      ["sam", undefined],
      ["ana", "2026-11-01T17:30:00Z"],
    ]);
  });
});
