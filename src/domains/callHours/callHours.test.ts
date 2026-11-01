import { describe, expect, test } from "bun:test";
import { DEFAULT_CALL_HOURS, type CallHours } from "../config";
import { callTime, localTimes, nextCallTime, offsetMinutes, phoneDigits, prospectZones, zonesForNumber, zonesForRegion } from ".";

const CT = "America/Chicago";
const MT = "America/Denver";
// Monday 2 November 2026, the day after US clocks went back: 9:00 AM in Chicago.
const MONDAY_9AM_CT = new Date("2026-11-02T15:00:00Z");
const who = (variables: Record<string, string>, phone?: string) => ({ phone, variables });

describe("phone numbers", () => {
  test("E.164, 00 and the US and Canadian national forms", () => {
    expect(phoneDigits("(512) 555-0147")).toBe("15125550147");
    expect(phoneDigits("1-512-555-0147")).toBe("15125550147");
    expect(phoneDigits("+44 20 7946 0958")).toBe("442079460958");
    expect(phoneDigits("0044 20 7946 0958")).toBe("442079460958");
    expect(phoneDigits("011 44 20 7946 0958", "US")).toBe("442079460958");
    expect(phoneDigits("555-0147")).toBeUndefined();
    expect(phoneDigits(undefined)).toBeUndefined();
  });

  test("another country's national form, when the country is known", () => {
    expect(phoneDigits("020 7946 0958", "United Kingdom")).toBe("442079460958");
    expect(phoneDigits("087 123 4567", "Ireland")).toBe("353871234567");
    expect(phoneDigits("020 7946 0958")).toBeUndefined();
    expect(phoneDigits("020 7946 0958", "Narnia")).toBeUndefined();
  });

  test("an area code gives its zones, a split one its exchange's", () => {
    expect(zonesForNumber("15125550147")).toEqual([CT]);
    expect(zonesForNumber("12125550147")).toEqual(["America/New_York"]);
    expect(zonesForNumber("12082015555")).toEqual([MT]);
    expect(zonesForNumber("12089995555")).toEqual(["America/Boise", "America/Los_Angeles"]);
    expect(zonesForNumber("442079460958")).toContain("Europe/London");
  });

  test("a state or province gives every zone it spans", () => {
    expect(zonesForRegion("TX")).toEqual([CT, MT]);
    expect(zonesForRegion("Texas")).toEqual([CT, MT]);
    expect(zonesForRegion(" ontario ")).toEqual(["America/Toronto", "America/Winnipeg"]);
    expect(zonesForRegion("Atlantis")).toBeUndefined();
  });
});

describe("prospectZones", () => {
  test("a timezone column says it outright", () => {
    expect(prospectZones(who({ timezone: "Europe/Dublin" }, "(512) 555-0147"), MONDAY_9AM_CT)).toEqual({ zones: ["Europe/Dublin"], from: ["timezone"] });
    expect(prospectZones(who({ timezone: "Mars/Olympus" }, "(512) 555-0147"), MONDAY_9AM_CT)?.from).toEqual(["phone"]);
  });

  test("an area code inside the state narrows it; one outside it adds its zone", () => {
    expect(prospectZones(who({ region: "TX" }), MONDAY_9AM_CT)).toEqual({ zones: [CT, MT], from: ["region"] });
    expect(prospectZones(who({ region: "TX" }, "(512) 555-0147"), MONDAY_9AM_CT)).toEqual({ zones: [CT], from: ["phone", "region"] });
    expect(prospectZones(who({ state: "Texas" }, "(917) 555-0147"), MONDAY_9AM_CT)).toEqual({ zones: ["America/New_York", CT, MT], from: ["phone", "region"] });
  });

  test("a state only counts in the US and Canada", () => {
    expect(prospectZones(who({ region: "WA", country: "Australia" }), MONDAY_9AM_CT)).toBeUndefined();
    expect(prospectZones(who({ region: "WA", country: "US" }), MONDAY_9AM_CT)).toEqual({ zones: ["America/Los_Angeles"], from: ["region"] });
  });

  test("a country is the last resort, and only when it has one time zone", () => {
    expect(prospectZones(who({ country: "Ireland" }), MONDAY_9AM_CT)?.from).toEqual(["country"]);
    expect(prospectZones(who({ country: "Australia" }), MONDAY_9AM_CT)).toBeUndefined();
    expect(prospectZones(who({ country: "US" }), MONDAY_9AM_CT)).toBeUndefined();
  });

  test("an unknown area code says nothing, rather than every zone in the US", () => {
    expect(prospectZones(who({}, "+1 621 555 0100"), MONDAY_9AM_CT)).toBeUndefined();
    expect(prospectZones(who({}), MONDAY_9AM_CT)).toBeUndefined();
  });
});

describe("callTime", () => {
  test("inside calling hours: their time, and where it came from", () => {
    const t = callTime(who({}, "(512) 555-0147"), DEFAULT_CALL_HOURS, MONDAY_9AM_CT);
    expect(t).toMatchObject({ ok: true, local: "9:00 AM CST", zones: [CT], from: ["phone"] });
    expect(t.note).toBe("9:00 AM CST their time (from their phone number).");
  });

  test("too late: when it opens, tomorrow", () => {
    const t = callTime(who({}, "(512) 555-0147"), DEFAULT_CALL_HOURS, new Date("2026-11-03T03:30:00Z"));
    expect(t.ok).toBe(false);
    expect(t.local).toBe("9:30 PM CST");
    expect(t.nextAt).toBe("2026-11-03T14:00:00.000Z");
    expect(t.note).toBe("9:30 PM CST their time, outside calling hours: call from tomorrow 8:00 AM CST (from their phone number).");
  });

  test("before hours the same morning, and a weekday-only week", () => {
    expect(callTime(who({}, "(512) 555-0147"), DEFAULT_CALL_HOURS, new Date("2026-11-02T12:10:00Z")).note).toContain("call from 8:00 AM CST");
    const weekdays: CallHours = { ...DEFAULT_CALL_HOURS, days: ["mon", "tue", "wed", "thu", "fri"] };
    const saturday = callTime(who({}, "(512) 555-0147"), weekdays, new Date("2026-11-07T16:00:00Z"));
    expect(saturday.ok).toBe(false);
    expect(saturday.nextAt).toBe("2026-11-09T14:00:00.000Z");
    expect(saturday.note).toContain("call from Mon 8:00 AM CST");
  });

  test("a state that spans zones is called when it is late enough in all of them", () => {
    const t = callTime(who({ region: "TX" }), DEFAULT_CALL_HOURS, new Date("2026-11-02T14:30:00Z"));
    expect(t.ok).toBe(false);
    expect(t.local).toBe("8:30 AM CST / 7:30 AM MST");
    expect(t.nextAt).toBe("2026-11-02T15:00:00.000Z");
    expect(t.note).toContain("call from 9:00 AM CST / 8:00 AM MST (from their state or province)");
  });

  test("zones that never share calling hours say so", () => {
    const morning: CallHours = { ...DEFAULT_CALL_HOURS, start: "09:00", end: "12:00" };
    const t = callTime(who({ region: "NY" }, "(808) 555-0147"), morning, MONDAY_9AM_CT);
    expect(t.ok).toBe(false);
    expect(t.nextAt).toBeUndefined();
    expect(t.note).toContain("never share calling hours");
  });

  test("an unknown time zone is said, not guessed", () => {
    const t = callTime(who({}), DEFAULT_CALL_HOURS, MONDAY_9AM_CT);
    expect(t.ok).toBeUndefined();
    expect(t.note).toMatch(/time zone is unknown/);
  });

  test("the clock helpers", () => {
    expect(offsetMinutes(CT, MONDAY_9AM_CT)).toBe(-360);
    expect(offsetMinutes(CT, new Date("2026-07-01T12:00:00Z"))).toBe(-300);
    expect(offsetMinutes("Asia/Kolkata", MONDAY_9AM_CT)).toBe(330);
    expect(localTimes([CT, "America/Indiana/Indianapolis", "America/New_York"], MONDAY_9AM_CT)).toBe("9:00 AM CST / 10:00 AM EST");
    expect(nextCallTime([CT], new Date("2026-11-02T13:58:00Z"), DEFAULT_CALL_HOURS)?.toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });
});
