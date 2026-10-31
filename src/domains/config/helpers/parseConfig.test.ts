import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
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
