import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { DEFAULT_CALL_HOURS } from "../types";
import { DEFAULT_FOOTERS, parseConfig } from "./parseConfig";

const example = parse(readFileSync(path.resolve(import.meta.dir, "../../../../cold.example.yaml"), "utf8"));

describe("parseConfig", () => {
  test("the bundled example is valid", () => {
    const { config, errors } = parseConfig(example, "cold.example.yaml", true);
    expect(errors).toEqual([]);
    expect(Object.keys(config!.accounts)).toEqual(["personal", "company"]);
    expect(config!.accounts.personal!.voice).toBe("personal");
    expect(config!.accounts.company!.email!.window!.timezone).toBe("America/Chicago");
    expect(config!.offers["booking-pages"]!.variables.audience).toBe("auto service shops");
  });

  test("the decide section is optional, and checked when given", () => {
    expect(parseConfig(example, "x").config!.decide).toEqual({ provider: "auto", diligence: "auto", reviewBelow: 0.75, explore: true });
    const tuned = parseConfig({ ...example, decide: { provider: "jev", diligence: "subq", review_below: 0.6, explore: false } }, "x");
    expect(tuned.config!.decide).toEqual({ provider: "jev", diligence: "subq", reviewBelow: 0.6, explore: false });
    const { errors } = parseConfig({ ...example, decide: { provider: "gpt", review_below: 2, explore: "yes", speed: 1 } }, "x");
    expect(errors).toEqual([
      "decide.speed: not a decide setting (provider, diligence, review_below, explore)",
      "decide.provider: must be auto, jev or claude",
      "decide.review_below: must be a number from 0 to 1, e.g. 0.75",
      "decide.explore: must be true or false",
    ]);
  });

  test("the calls section is optional: 8am to 9pm every day, in the prospect's time", () => {
    expect(parseConfig(example, "x").config!.calls).toEqual({ start: "08:00", end: "21:00", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] });
    // Each config has its own copy of the default days: editing one never edits the defaults.
    expect(parseConfig(example, "x").config!.calls.days).not.toBe(DEFAULT_CALL_HOURS.days);
    const tuned = parseConfig({ ...example, calls: { start: "09:00", end: "18:30", days: ["Mon", "tue", "wed", "thu", "fri"] } }, "x");
    expect(tuned.config!.calls).toEqual({ start: "09:00", end: "18:30", days: ["mon", "tue", "wed", "thu", "fri"] });
    expect(parseConfig({ ...example, calls: { end: "20:00" } }, "x").config!.calls.start).toBe("08:00");
    const { errors } = parseConfig({ ...example, calls: { start: "21:00", end: "08:00", days: ["funday"], window: 1 } }, "x");
    expect(errors).toEqual([
      "calls.window: not a calls setting (start, end, days)",
      'calls: start and end as "HH:MM" in the prospect\'s time, start before end, e.g. start: "08:00", end: "21:00"',
      "calls.days: a list like [mon, tue, wed, thu, fri, sat]",
    ]);
  });

  test("an account without a footer gets the default for its voice", () => {
    const { config } = parseConfig(example, "x");
    expect(config!.accounts.personal!.email!.footer).toBe(DEFAULT_FOOTERS.personal);
  });

  test("reports every problem with its path", () => {
    const { config, errors } = parseConfig(
      {
        accounts: {
          me: { voice: "solo", sender_nme: "Typo", email: { from: "nobody", smtp_url_env: "lowercase", daily_cap: 0, window: { days: ["funday"], start: "9", end: "8", timezone: "Mars/Base" } } },
        },
        offers: { a: { audience: "x", price: "1" } },
        default_offer: "b",
        store: "cloud",
      },
      "cold.yaml",
    );
    expect(config).toBeUndefined();
    for (const expected of ["accounts.me.voice", "accounts.me.sender_nme", "accounts.me.sender_name", "accounts.me.email.from", "accounts.me.email.smtp_url_env", "accounts.me.email.daily_cap", "accounts.me.email.window.days", "accounts.me.email.window:", "accounts.me.email.window.timezone", "offers.a.price", "default_offer", "store"]) {
      expect(errors.some((e) => e.startsWith(expected))).toBe(true);
    }
  });

  test("derives sender_first_name from sender_name", () => {
    const { config } = parseConfig({ accounts: { me: { voice: "personal", sender_name: "Sam Lee" } } }, "x");
    expect(config!.accounts.me!.variables.sender_first_name).toBe("Sam");
  });
});
