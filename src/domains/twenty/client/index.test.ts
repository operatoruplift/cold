import { describe, expect, test } from "bun:test";
import { filterAnd, filterIn, TwentyClient, twentyConfigFromEnv, unwrapItem, unwrapList } from ".";

describe("twenty client helpers", () => {
  test("filters combine with and() and quote values", () => {
    expect(filterAnd(undefined, 'a[eq]:"1"')).toBe('a[eq]:"1"');
    expect(filterAnd('a[eq]:"1"', 'id[gt]:"x"')).toBe('and(a[eq]:"1",id[gt]:"x")');
    expect(filterIn("prospectKey", ["a@b.co", 'we"ird'])).toBe('prospectKey[in]:["a@b.co","weird"]');
  });

  test("unwrap list and item envelopes", () => {
    expect(unwrapList({ data: { people: [{ id: "1" }] } }, "people")).toEqual([{ id: "1" }]);
    expect(unwrapList({ data: { other: [{ id: "2" }] } }, "people")).toEqual([{ id: "2" }]);
    expect(unwrapItem({ data: { createColdTouch: { id: "3", kind: "SENT" } } })).toEqual({ id: "3", kind: "SENT" });
  });

  test("config comes from TWENTY_BASE_URL and TWENTY_API_KEY", () => {
    expect(twentyConfigFromEnv({ TWENTY_BASE_URL: "https://crm.example/", TWENTY_API_KEY: "k" })).toEqual({ baseUrl: "https://crm.example", apiKey: "k" });
    expect(twentyConfigFromEnv({ TWENTY_BASE_URL: "https://crm.example" })).toBeUndefined();
  });
});

describe("TwentyClient.list", () => {
  test("walks pages by id and keeps the caller's filter on every page", async () => {
    const urls: string[] = [];
    const rows = Array.from({ length: 450 }, (_, i) => ({ id: `id-${String(i).padStart(4, "0")}` }));
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(decodeURIComponent(url.search));
      const filter = url.searchParams.get("filter") ?? "";
      const after = /id\[gt\]:"([^"]+)"/.exec(filter)?.[1];
      const limit = Number(url.searchParams.get("limit"));
      const page = rows.filter((r) => !after || r.id > after).slice(0, limit);
      return new Response(JSON.stringify({ data: { coldTouches: page } }), { status: 200 });
    }) as typeof fetch;
    const client = new TwentyClient({ baseUrl: "https://crm.example", apiKey: "k" }, fakeFetch);
    const all = await client.list("coldTouches", { filter: 'kind[eq]:"SENT"' });
    expect(all.length).toBe(450);
    expect(urls.length).toBe(3);
    expect(urls[1]).toContain('and(kind[eq]:"SENT",id[gt]:"id-0199")');
    expect(urls.every((u) => u.includes("orderBy=id[AscNullsFirst]"))).toBe(true);
  });

  test("explains a failure in words", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ messages: ["Object coldTouch not found"] }), { status: 404 })) as unknown as typeof fetch;
    const client = new TwentyClient({ baseUrl: "https://crm.example", apiKey: "k" }, fakeFetch);
    await expect(client.list("coldTouches")).rejects.toThrow(/404 Object coldTouch not found.*twenty:schema/);
  });
});
