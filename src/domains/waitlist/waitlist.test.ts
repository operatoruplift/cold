import { describe, expect, test } from "bun:test";
import { openDatabase } from "../db";
import { parseSignup, Waitlist } from ".";

describe("parseSignup", () => {
  test("cleans a signup and keeps only known channels", () => {
    const { signup } = parseSignup({ email: " Dana@Example.COM ", name: "  Dana   Reyes ", channels: ["email", "fax", "calls"], elapsedMs: 4000 });
    expect(signup).toMatchObject({ email: "dana@example.com", name: "Dana Reyes", channels: ["email", "calls"] });
  });

  test("bots are answered as if it worked, and nothing is kept", () => {
    expect(parseSignup({ email: "a@b.co", website: "http://spam" }).spam).toBe(true);
    expect(parseSignup({ email: "a@b.co", elapsedMs: 300 }).spam).toBe(true);
  });

  test("a bad email is refused", () => {
    expect(parseSignup({ email: "nope" }).error).toBe("Enter a valid work email.");
    expect(parseSignup("nope").error).toBeDefined();
  });
});

describe("Waitlist", () => {
  test("joins once per email, fills gaps on a second signup, counts and filters", async () => {
    const list = new Waitlist(await openDatabase(":memory:"), () => new Date("2026-11-02T15:00:00Z"));
    expect((await list.join({ email: "dana@example.com", channels: ["email"] }, { ip: "1.2.3.4" })).created).toBe(true);
    expect((await list.join({ email: "dana@example.com", company: "Clearview Tint", channels: ["calls"] })).created).toBe(false);
    await list.join({ email: "marcus@example.com", role: "Founder", channels: [] });
    const [marcus, dana] = await list.list();
    expect(dana).toMatchObject({ email: "dana@example.com", company: "Clearview Tint", channels: ["email"], status: "waiting" });
    expect(marcus!.role).toBe("Founder");
    await list.update(dana!.id, { status: "invited", ownerNote: "Call Tuesday" });
    expect(await list.counts()).toEqual({ total: 2, waiting: 1, invited: 1, archived: 0, lastWeek: 2 });
    expect((await list.list({ status: "invited" })).map((e) => e.email)).toEqual(["dana@example.com"]);
    expect(await list.list({ q: "clearview" })).toHaveLength(1);
    await expect(list.update(dana!.id, { status: "vip" })).rejects.toThrow("Status must be");
    expect(await list.remove(marcus!.id)).toBe(true);
    expect((await list.counts()).total).toBe(1);
  });

  test("the CSV export never lets a cell run as a spreadsheet formula", async () => {
    const list = new Waitlist(await openDatabase(":memory:"));
    await list.join({ email: "x@example.com", name: '=HYPERLINK("http://evil")', note: "line one\nline, two", channels: ["dm"] });
    const csv = await list.csv();
    expect(csv.split("\n")[0]).toBe("email,name,company,role,channels,note,status,owner_note,source,referrer,joined");
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain('"line one\nline, two"');
  });

  test("never stores the raw IP", async () => {
    const db = await openDatabase(":memory:");
    await new Waitlist(db).join({ email: "x@example.com", channels: [] }, { ip: "203.0.113.9" });
    const row = (await db.get<{ ip_hash: string }>("SELECT ip_hash FROM waitlist"))!;
    expect(row.ip_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(row)).not.toContain("203.0.113.9");
  });
});
