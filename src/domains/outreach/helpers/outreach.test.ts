import { describe, expect, test } from "bun:test";
import type { Account, Offer } from "../../config";
import type { Message } from "../../messages";
import { fromCsvRow } from "../../prospects";
import { buildVariables } from "./buildVariables";
import { renderForProspect } from "./renderForProspect";
import { startOfDay } from "./startOfDay";

const account: Account = { key: "personal", voice: "personal", variables: { sender_name: "Alex Morgan", sender_first_name: "Alex" }, dm: { dailyCaps: {} } };
const offer: Offer = { key: "o", variables: { audience: "tint shops", pain: "miss calls" } };

describe("buildVariables", () => {
  test("prospect fields override the offer; the account always wins", () => {
    const p = fromCsvRow(["first_name", "pain", "sender_name"], ["Dana", "lose leads at night", "Mallory"], 0);
    const v = buildVariables(account, offer, p);
    expect(v.pain).toBe("lose leads at night");
    expect(v.audience).toBe("tint shops");
    expect(v.sender_name).toBe("Alex Morgan");
  });
});

describe("renderForProspect", () => {
  const message: Message = { id: "email/personal/s/1-a", file: "", channel: "email", voice: "personal", title: "A", subject: "{hi|hey} {{company}}", allowLinks: false, customVariables: [], body: "{{trigger}} I'm {{sender_first_name}}." };

  test("reports missing variables from subject and body", () => {
    expect(renderForProspect(message, { sender_first_name: "Alex" }, "k").missing.sort()).toEqual(["company", "trigger"]);
  });

  test("is stable for a prospect", () => {
    const vars = { sender_first_name: "Alex", company: "Clearview", trigger: "Saw the new bay." };
    expect(renderForProspect(message, vars, "email:a@x.example").subject).toBe(renderForProspect(message, vars, "email:a@x.example").subject!);
  });
});

test("startOfDay is midnight in the given timezone", () => {
  // 2026-11-02 03:30 UTC is still Nov 1 in Chicago (UTC-6 after DST ends).
  expect(startOfDay(new Date("2026-11-02T03:30:00Z"), "America/Chicago")).toBe("2026-11-01T06:00:00.000Z");
  expect(startOfDay(new Date("2026-11-02T15:00:00Z"), "UTC")).toBe("2026-11-02T00:00:00.000Z");
});
