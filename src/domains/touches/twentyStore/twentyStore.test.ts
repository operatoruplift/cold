import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TwentyClient } from "../../twenty";
import type { Touch } from "../types";
import { TouchNotSavedError, TwentyStore } from ".";

/** A fake Twenty whose coldTouches endpoint can be switched off. */
function fakeTwenty() {
  const state = { down: false, saved: [] as Record<string, unknown>[] };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/metadata") {
      const fields = ["id", "name", "kind", "channel", "prospectKey", "occurredAt", "person"].map((f) => ({ node: { name: f, type: "TEXT", isActive: true, options: null } }));
      return Response.json({ data: { objects: { edges: [{ node: { id: "o1", nameSingular: "coldTouch", namePlural: "coldTouches", fields: { edges: fields } } }] } } });
    }
    if (init?.method === "POST") {
      if (state.down) return new Response(JSON.stringify({ messages: ["Service unavailable"] }), { status: 503 });
      const body = JSON.parse(String(init.body));
      state.saved.push(body);
      return Response.json({ data: { createColdTouch: { id: `t${state.saved.length}`, ...body } } });
    }
    return Response.json({ data: { coldTouches: [] } });
  }) as typeof fetch;
  return { state, client: new TwentyClient({ baseUrl: "https://crm.example", apiKey: "k" }, fetchImpl) };
}

const touch: Touch = { kind: "SENT", channel: "EMAIL", prospectKey: "email:dana@x.example", prospectLabel: "Dana Reyes", occurredAt: "2026-11-02T15:00:00Z", links: { personId: "p1", companyId: "c1" } };

let dir: string;
let journal: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cold-journal-"));
  journal = path.join(dir, "unsaved.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("TwentyStore", () => {
  test("writes only fields the workspace has, and relation ids as <name>Id", async () => {
    const { state, client } = fakeTwenty();
    const store = await TwentyStore.open(client, journal, { retryDelayMs: 0 });
    await store.record(touch);
    expect(state.saved[0]).toEqual({ name: "Sent email - Dana Reyes", kind: "SENT", channel: "EMAIL", prospectKey: "email:dana@x.example", occurredAt: "2026-11-02T15:00:00Z", personId: "p1" });
  });

  test("a touch Twenty refuses is journaled, and replayed before the next run plans anything", async () => {
    const { state, client } = fakeTwenty();
    const store = await TwentyStore.open(client, journal, { retryDelayMs: 0 });
    state.down = true;
    await expect(store.record(touch)).rejects.toBeInstanceOf(TouchNotSavedError);
    expect(readFileSync(journal, "utf8").trim()).toBe(JSON.stringify(touch));

    // Still down: the next run refuses to start, and keeps the journal.
    await expect(TwentyStore.open(client, journal, { retryDelayMs: 0 })).rejects.toThrow(/still could not be saved/);
    expect(existsSync(journal)).toBe(true);

    // Back up: the next run writes the journal first, then carries on.
    state.down = false;
    await TwentyStore.open(client, journal, { retryDelayMs: 0 });
    expect(existsSync(journal)).toBe(false);
    expect(state.saved.map((r) => r.prospectKey)).toEqual(["email:dana@x.example"]);
  });
});
