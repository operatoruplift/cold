import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import type { Io } from "../../cli/io";
import { parseConfig, type ColdConfig } from "../../config";
import { findSequence, loadLibrary } from "../../messages";
import { fromCsvRow, parseCsv } from "../../prospects";
import { FileStore } from "../../touches";
import { syncReplies, type MailboxMessage } from "../sync";
import type { EmailDraft } from "../types";
import { runEmail, type MailTransport } from ".";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const config = parseConfig(parse(readFileSync(path.join(ROOT, "cold.example.yaml"), "utf8")), "cold.example.yaml").config as ColdConfig;
const { library } = loadLibrary();
const [headers, ...rows] = parseCsv(readFileSync(path.join(ROOT, "examples/prospects.csv"), "utf8"));
const prospects = rows.map((row, i) => fromCsvRow(headers!, row, i));
const founderDirect = findSequence(library, "email/personal/founder-direct")!;

// Monday 2 November 2026, 09:00 in Chicago: inside the personal account's window.
const MONDAY = new Date("2026-11-02T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function fakeIo(answer = true) {
  const lines: string[] = [];
  const io: Io = { interactive: false, log: (l = "") => lines.push(l), confirm: async () => answer, choose: async () => "q" };
  return { io, lines, text: () => lines.join("\n") };
}

function fakeTransport(fail?: (draft: EmailDraft) => Error | undefined) {
  const sent: EmailDraft[] = [];
  const transport: MailTransport = {
    verify: async () => true,
    sendMail: async (draft) => {
      const error = fail?.(draft);
      if (error) throw error;
      sent.push(draft);
      return {};
    },
  };
  return { transport, sent };
}

let dir: string;
let store: FileStore;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cold-"));
  store = new FileStore(path.join(dir, "touches.jsonl"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (at: Date, transport: MailTransport, overrides: Partial<Parameters<typeof runEmail>[0]> = {}) =>
  runEmail({
    sequence: founderDirect,
    account: config.accounts.personal!,
    offer: config.offers["booking-pages"],
    prospects,
    store,
    options: { dryRun: false, ignoreWindow: false, yes: true },
    io: fakeIo().io,
    transport,
    now: () => at,
    sleep: async () => {},
    ...overrides,
  });

describe("runEmail", () => {
  test("sends step 1 to everyone due, holds back a message with an empty variable, and logs each send", async () => {
    const { transport, sent } = fakeTransport();
    const out = fakeIo();
    const result = await run(MONDAY, transport, { io: out.io });
    expect(result).toMatchObject({ sent: 4, failed: 0 });
    expect(sent.map((d) => d.to).sort()).toEqual(["dana@clearviewtint.example", "elena@ortizautoglass.example", "marcus@hillcountrybody.example", "priya@shinedetail.example"]);
    expect(out.text()).toContain("held back: 1 missing {{trigger}}");
    const dana = sent.find((d) => d.to.startsWith("dana"))!;
    expect(dana.subject).toMatch(/^(question|quick question) about Clearview Tint$/);
    expect(dana.text).toContain("Saw you just opened a second bay in Round Rock.");
    expect(dana.text).toContain("123 Example St, Austin, TX 78701");
    expect(dana.text).toContain('Reply "stop"');
    expect(dana.headers["List-Unsubscribe"]).toBe("<mailto:alex@brightside.example?subject=unsubscribe>");
    const logged = await store.since("2000-01-01T00:00:00Z", { kind: "SENT" });
    expect(logged.map((t) => [t.step, t.templateId, t.voice])).toContainEqual([1, "email/personal/founder-direct/1-first-touch", "PERSONAL"]);
  });

  test("threads step 2 under step 1 three days later, quoting it", async () => {
    const first = fakeTransport();
    await run(MONDAY, first.transport);
    const again = fakeTransport();
    expect((await run(new Date(MONDAY.getTime() + 1 * DAY), again.transport)).sent).toBe(0);
    const thursday = new Date(MONDAY.getTime() + 3 * DAY);
    const followUp = fakeTransport();
    expect((await run(thursday, followUp.transport)).sent).toBe(4);
    const step1 = first.sent.find((d) => d.to.startsWith("dana"))!;
    const step2 = followUp.sent.find((d) => d.to.startsWith("dana"))!;
    expect(step2.subject).toBe(`Re: ${step1.subject}`);
    expect(step2.inReplyTo).toBe(step1.messageId);
    expect(step2.text).toContain("floating this back up");
    expect(step2.text).toContain("> Saw you just opened a second bay in Round Rock.");
  });

  test("a reply picked up by sync stops the sequence; an opt-out suppresses the prospect", async () => {
    const first = fakeTransport();
    await run(MONDAY, first.transport);
    const dana = first.sent.find((d) => d.to.startsWith("dana"))!;
    const inbox: MailboxMessage[] = [
      { messageId: "<r1@x>", inReplyTo: dana.messageId, references: [dana.messageId], from: "dana@clearviewtint.example", date: new Date(MONDAY.getTime() + DAY), email: { from: "Dana <dana@clearviewtint.example>", subject: `Re: ${dana.subject}`, text: "Yes, send the video.\n\nOn Mon, Alex wrote:\n> stop", headers: {} } },
      { messageId: "<r2@x>", references: [], from: "marcus@hillcountrybody.example", date: new Date(MONDAY.getTime() + DAY), email: { from: "marcus@hillcountrybody.example", subject: "Re: x", text: "Please remove me from your list", headers: {} } },
      { messageId: "<r3@x>", references: [], from: "priya@shinedetail.example", date: new Date(MONDAY.getTime() + DAY), email: { from: "priya@shinedetail.example", subject: "Automatic reply: out of office", text: "Back Monday", headers: {} } },
    ];
    const reader = { read: async () => inbox };
    const result = await syncReplies({ account: config.accounts.personal!, store, days: 14, io: fakeIo().io, reader, now: () => new Date(MONDAY.getTime() + 2 * DAY) });
    expect(result).toEqual({ replied: 1, optedOut: 1, bounced: 0, autoReplies: 1 });
    // Running the sync again logs nothing new.
    expect(await syncReplies({ account: config.accounts.personal!, store, days: 14, io: fakeIo().io, reader, now: () => new Date(MONDAY.getTime() + 2 * DAY) })).toEqual({ replied: 0, optedOut: 0, bounced: 0, autoReplies: 1 });

    const out = fakeIo();
    const followUp = fakeTransport();
    await run(new Date(MONDAY.getTime() + 3 * DAY), followUp.transport, { io: out.io });
    expect(followUp.sent.map((d) => d.to).sort()).toEqual(["elena@ortizautoglass.example", "priya@shinedetail.example"]);
    expect(out.text()).toMatch(/skipped: .*replied/);
    expect(out.text()).toMatch(/opted out/);
  });

  test("respects the daily cap and --limit", async () => {
    const account = { ...config.accounts.personal!, email: { ...config.accounts.personal!.email!, dailyCap: 2 } };
    const { transport, sent } = fakeTransport();
    await run(MONDAY, transport, { account });
    expect(sent.length).toBe(2);
    const more = fakeTransport();
    await run(new Date(MONDAY.getTime() + 60_000), more.transport, { account });
    expect(more.sent.length).toBe(0);
    const limited = fakeTransport();
    await run(new Date(MONDAY.getTime() + DAY), limited.transport, { options: { dryRun: false, ignoreWindow: false, yes: true, limit: 1 } });
    expect(limited.sent.length).toBe(1);
  });

  test("a dry run sends nothing and logs nothing", async () => {
    const { transport, sent } = fakeTransport();
    const out = fakeIo();
    await run(MONDAY, transport, { options: { dryRun: true, ignoreWindow: false, yes: true }, io: out.io });
    expect(sent).toEqual([]);
    expect(await store.since("2000-01-01T00:00:00Z")).toEqual([]);
    expect(out.text()).toContain("Dry run: nothing was sent.");
    expect(out.text()).toContain("Subject:");
  });

  test("refuses outside the sending window unless told to ignore it", async () => {
    const friday = new Date("2026-11-06T15:00:00Z");
    const blocked = fakeTransport();
    expect((await run(friday, blocked.transport)).aborted).toMatch(/outside the sending window/);
    expect(blocked.sent).toEqual([]);
    const forced = fakeTransport();
    expect((await run(friday, forced.transport, { options: { dryRun: false, ignoreWindow: true, yes: true } })).sent).toBe(4);
  });

  test("refuses a sequence in the other voice", async () => {
    await expect(run(MONDAY, fakeTransport().transport, { sequence: findSequence(library, "email/company/problem-proof")! })).rejects.toThrow(/company voice/);
  });

  test("stops at the first fatal SMTP error, and logs it", async () => {
    const auth = Object.assign(new Error("Invalid login"), { code: "EAUTH" });
    const { transport } = fakeTransport(() => auth);
    const result = await run(MONDAY, transport);
    expect(result).toMatchObject({ sent: 0, failed: 1, aborted: "the mailbox stopped accepting mail (EAUTH)" });
    expect((await store.since("2000-01-01T00:00:00Z", { kind: "FAILED" })).length).toBe(1);
  });

  test("a 5xx recipient rejection is logged as a bounce and suppresses the address", async () => {
    const rejected = Object.assign(new Error("550 No such user"), { code: "EENVELOPE", responseCode: 550 });
    const { transport, sent } = fakeTransport((d) => (d.to.startsWith("marcus") ? rejected : undefined));
    await run(MONDAY, transport);
    expect(sent.length).toBe(3);
    expect((await store.suppressions()).map((t) => [t.kind, t.toAddress])).toEqual([["BOUNCED", "marcus@hillcountrybody.example"]]);
  });

  test("Reacher's invalid verdict skips the first email and suppresses the address", async () => {
    const { transport, sent } = fakeTransport();
    const verifier = { check: async (email: string) => (email.startsWith("elena") ? ("invalid" as const) : ("safe" as const)) };
    await run(MONDAY, transport, { verifier });
    expect(sent.map((d) => d.to)).not.toContain("elena@ortizautoglass.example");
    expect((await store.suppressions()).map((t) => t.kind)).toEqual(["UNDELIVERABLE"]);
  });
});
