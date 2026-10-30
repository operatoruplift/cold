import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { Io } from "../cli/io";
import { parseConfig, type ColdConfig } from "../config";
import { findMessage, loadLibrary } from "../messages";
import { TwentyClient } from "../twenty";
import { scriptToPlainText, syncCallScripts, toDialerScript } from ".";

const ROOT = path.resolve(import.meta.dir, "../../..");
const config = parseConfig(parse(readFileSync(path.join(ROOT, "cold.example.yaml"), "utf8")), "x").config as ColdConfig;
const { library } = loadLibrary();
const io: Io = { interactive: false, log: () => {}, confirm: async () => true, choose: async () => "q" };

describe("toDialerScript", () => {
  test("fills the account and offer, keeps prospect variables for the rep", () => {
    const script = findMessage(library, "call/personal/founder-direct")!;
    const row = toDialerScript(script, library.objections, "personal", { ...config.accounts.personal!.variables, ...config.offers["booking-pages"]!.variables });
    expect(row.name).toBe("Founder direct (personal)");
    expect(row.scriptData.category).toBe("Introduction");
    expect(row.scriptData.content).toStartWith("OPENER\nHi {{first_name}}, it's Alex, I run Brightside Studio.");
    expect(row.scriptData.content).toContain("WHY I CALLED\n{{trigger}} I build booking pages");
    expect(row.scriptData.content).not.toContain("##");
    expect(row.scriptData.objection_responses["Not interested"]).toEqual({ category: "brush_off", response: expect.stringContaining("most people aren't when I call out of the blue") });
    expect(row.scriptData.objection_responses["Just send me an email"]!.response).not.toContain("{{");
  });

  test("company scripts take the company answers", () => {
    const script = findMessage(library, "call/company/gatekeeper")!;
    const row = toDialerScript(script, library.objections, "company", config.accounts.company!.variables);
    expect(row.scriptData.objection_responses["How did you get my number?"]!.response).toContain("off our list");
  });

  test("scriptToPlainText", () => {
    expect(scriptToPlainText("## Opener\nHi **there**\n> note\n\n\n- a")).toBe("OPENER\nHi there\nnote\n\n- a");
  });
});

describe("syncCallScripts", () => {
  test("creates missing scripts and updates existing ones by name and campaign", async () => {
    const calls: string[] = [];
    const filters: string[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      if (method === "GET") {
        const filter = url.searchParams.get("filter") ?? "";
        filters.push(filter);
        const rows = filter.includes('"Gatekeeper (company)"') ? [{ id: "s1", name: "Gatekeeper (company)" }] : [];
        return new Response(JSON.stringify({ data: { agencyScripts: rows } }));
      }
      const body = JSON.parse(String(init?.body));
      expect(JSON.parse(body.scriptData).content).toStartWith(body.name === "Voicemail (company)" ? "VOICEMAIL" : "");
      return new Response(JSON.stringify({ data: { createAgencyScript: { id: "new", ...body } } }));
    }) as typeof fetch;
    const client = new TwentyClient({ baseUrl: "https://crm.example", apiKey: "k" }, fakeFetch);
    const result = await syncCallScripts({ client, library, account: config.accounts.company!, offer: config.offers["booking-pages"], dryRun: false, io });
    expect(result).toEqual({ created: 3, updated: 1 });
    expect(calls).toContain("PATCH /rest/agencyScripts/s1");
    expect(filters).toContain('and(name[eq]:"Reason for the call (company)",campaignIdId[is]:NULL)');
  });

  test("personal and company scripts with the same title stay separate", () => {
    const personal = toDialerScript(findMessage(library, "call/personal/voicemail")!, library.objections, "personal", {});
    const company = toDialerScript(findMessage(library, "call/company/voicemail")!, library.objections, "company", {});
    expect(personal.name).not.toBe(company.name);
  });
});
