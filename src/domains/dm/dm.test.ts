import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import type { Io } from "../cli/io";
import { parseConfig, type ColdConfig } from "../config";
import { findSequence, loadLibrary } from "../messages";
import { fromCsvRow, parseCsv } from "../prospects";
import { FileStore } from "../touches";
import { dmTarget, runDm } from ".";

const ROOT = path.resolve(import.meta.dir, "../../..");
const config = parseConfig(parse(readFileSync(path.join(ROOT, "cold.example.yaml"), "utf8")), "x").config as ColdConfig;
const { library } = loadLibrary();
const [headers, ...rows] = parseCsv(readFileSync(path.join(ROOT, "examples/prospects.csv"), "utf8"));
const prospects = rows.map((row, i) => fromCsvRow(headers!, row, i));
const linkedin = findSequence(library, "dm/personal/linkedin")!;
const MONDAY = new Date("2026-11-02T15:00:00Z");

let dir: string;
let store: FileStore;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cold-dm-"));
  store = new FileStore(path.join(dir, "touches.jsonl"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function scriptedIo(answers: string[]) {
  const lines: string[] = [];
  const io: Io = { interactive: true, log: (l = "") => lines.push(l), confirm: async () => true, choose: async () => answers.shift() ?? "q" };
  return { io, lines };
}

const desktop = () => {
  const opened: string[] = [];
  const copied: string[] = [];
  return { opened, copied, desktop: { open: (u: string) => void opened.push(u), copy: (t: string) => (copied.push(t), true) } };
};

describe("dmTarget", () => {
  test("builds the page to open per platform", () => {
    const p = prospects[0]!;
    expect(dmTarget("linkedin", p)).toBe("https://www.linkedin.com/in/dana-reyes-example");
    expect(dmTarget("x", p)).toBe("https://x.com/clearviewtint");
    expect(dmTarget("instagram", p)).toBe("https://ig.me/m/clearviewtint");
    expect(dmTarget("facebook", p)).toBeUndefined();
  });
});

describe("runDm", () => {
  test("walks the queue: copies, opens, and logs what you say happened", async () => {
    const { io } = scriptedIo(["s", "r", "k", "o"]);
    const d = desktop();
    const result = await runDm({ sequence: linkedin, account: config.accounts.personal!, offer: config.offers["booking-pages"], prospects, store, io, options: { open: true }, now: () => MONDAY, desktop: d.desktop });
    // Four prospects have a LinkedIn URL; Tom (p04) has none.
    expect(result).toEqual({ sent: 1, replied: 1, optedOut: 1, skipped: 2 });
    expect(d.opened.length).toBe(4);
    expect(d.copied[0]).toBe("Hi Dana, I work with auto service shops and came across Clearview Tint. I'd like to connect and swap notes.");
    const touches = await store.since("2000-01-01T00:00:00Z");
    expect(touches.map((t) => [t.kind, t.channel, t.prospectKey])).toEqual([
      ["SENT", "LINKEDIN", "email:dana@clearviewtint.example"],
      ["REPLIED", "LINKEDIN", "email:marcus@hillcountrybody.example"],
      ["OPTED_OUT", "LINKEDIN", "email:elena@ortizautoglass.example"],
    ]);
  });

  test("the next day, only the sent prospect moves to step 2, and the skipped one is offered again", async () => {
    await runDm({ sequence: linkedin, account: config.accounts.personal!, offer: config.offers["booking-pages"], prospects, store, io: scriptedIo(["s", "r", "k", "o"]).io, options: { open: false }, now: () => MONDAY, desktop: desktop().desktop });
    const d = desktop();
    await runDm({ sequence: linkedin, account: config.accounts.personal!, offer: config.offers["booking-pages"], prospects, store, io: scriptedIo(["q"]).io, options: { open: false }, now: () => new Date(MONDAY.getTime() + 86_400_000), desktop: d.desktop });
    expect(d.copied[0]).toStartWith("Dana, thanks for connecting.");
  });

  test("--export writes a checklist and logs nothing", async () => {
    const file = path.join(dir, "queue.md");
    await runDm({ sequence: linkedin, account: config.accounts.personal!, offer: config.offers["booking-pages"], prospects, store, io: scriptedIo([]).io, options: { open: false, exportFile: file }, now: () => MONDAY, desktop: desktop().desktop });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("## Dana Reyes (Clearview Tint): step 1, Connection note");
    expect(text).toContain("Open: https://www.linkedin.com/in/dana-reyes-example");
    expect(await store.since("2000-01-01T00:00:00Z")).toEqual([]);
  });

  test("the daily cap holds", async () => {
    const account = { ...config.accounts.personal!, dm: { dailyCaps: { linkedin: 2 } } };
    const result = await runDm({ sequence: linkedin, account, offer: config.offers["booking-pages"], prospects, store, io: scriptedIo(["s", "s", "s"]).io, options: { open: false }, now: () => MONDAY, desktop: desktop().desktop });
    expect(result.sent).toBe(2);
  });
});
