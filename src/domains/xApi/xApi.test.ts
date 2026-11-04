import { describe, expect, test } from "bun:test";
import { openDatabase } from "../db";
import { accessTokenFor, connectUrl, finishConnect, withXToken, XApiError, XClient, XStore, xUserIdOf, type XFetch } from ".";

const NOW = new Date("2026-11-02T15:00:00Z");
const now = () => NOW;
const KEY = Buffer.alloc(32, 7);

type Seen = { url: string; method: string; headers: Record<string, string>; body: string };

/** A fake X: answers by a handler and keeps every request. */
function fakeX(answer: (seen: Seen) => { status?: number; body?: unknown; headers?: Record<string, string> }): { fetch: XFetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: XFetch = async (url, init = {}) => {
    const request: Seen = { url, method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), body: String(init.body ?? "") };
    seen.push(request);
    const { status = 200, body = {}, headers = {} } = answer(request);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  return { fetch, seen };
}

const tokenAnswer = { body: { token_type: "bearer", access_token: "at1", refresh_token: "rt1", expires_in: 7200, scope: "dm.read dm.write tweet.read users.read offline.access" } };

async function store(options: { key?: Buffer; requireKey?: boolean } = { key: KEY }) {
  return new XStore(await openDatabase(":memory:"), { key: options.key, requireKey: options.requireKey ?? false, now });
}

describe("the X client", () => {
  test("the code is traded for tokens with the verifier, the app's Basic auth and the same redirect", async () => {
    const x = fakeX(() => tokenAnswer);
    const tokens = await new XClient({ clientId: "app1", clientSecret: "secret1" }, x.fetch, now).exchangeCode("code1", "verifier1", "http://127.0.0.1:4100/api/x/callback");
    expect(tokens).toEqual({ accessToken: "at1", refreshToken: "rt1", expiresAt: "2026-11-02T17:00:00.000Z", scope: "dm.read dm.write tweet.read users.read offline.access" });
    const [request] = x.seen;
    expect(request!.url).toBe("https://api.x.com/2/oauth2/token");
    expect(request!.headers.authorization).toBe(`Basic ${Buffer.from("app1:secret1").toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(request!.body))).toEqual({ grant_type: "authorization_code", code: "code1", redirect_uri: "http://127.0.0.1:4100/api/x/callback", code_verifier: "verifier1", client_id: "app1" });
  });

  test("a public client sends no secret", async () => {
    const x = fakeX(() => tokenAnswer);
    await new XClient({ clientId: "app1" }, x.fetch, now).refresh("rt0");
    expect(x.seen[0]!.headers.authorization).toBeUndefined();
    expect(Object.fromEntries(new URLSearchParams(x.seen[0]!.body))).toEqual({ grant_type: "refresh_token", refresh_token: "rt0", client_id: "app1" });
  });

  test("a DM is one POST to the person's conversation, with the bearer token", async () => {
    const x = fakeX(() => ({ status: 201, body: { data: { dm_conversation_id: "123-456", dm_event_id: "ev1" } } }));
    const sent = await new XClient({ clientId: "app1" }, x.fetch, now).sendDm("at1", "456", "Hi Dana");
    expect(sent).toEqual({ eventId: "ev1", conversationId: "123-456" });
    expect(x.seen[0]).toMatchObject({ url: "https://api.x.com/2/dm_conversations/with/456/messages", method: "POST", body: JSON.stringify({ text: "Hi Dana" }) });
    expect(x.seen[0]!.headers.authorization).toBe("Bearer at1");
    expect(x.seen[0]!.headers["content-type"]).toBe("application/json");
  });

  test("a closed inbox is a cannotDm error that says what to do", async () => {
    const x = fakeX(() => ({ status: 403, body: { detail: "You are not permitted to send Direct Messages to this user.", status: 403 } }));
    const err = await new XClient({ clientId: "app1" }, x.fetch, now).sendDm("at1", "456", "Hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XApiError);
    expect((err as XApiError).kind).toBe("cannotDm");
    expect((err as XApiError).message).toContain("Skip them, or reach them on another channel.");
  });

  test("a handle X doesn't know is notFound, even when X answers 200 with errors", async () => {
    const x = fakeX(() => ({ body: { errors: [{ title: "Not Found Error", detail: "Could not find user with username: [gone]." }] } }));
    const err = await new XClient({ clientId: "app1" }, x.fetch, now).userByHandle("at1", "gone").catch((e: unknown) => e);
    expect((err as XApiError).kind).toBe("notFound");
    expect((err as XApiError).message).toContain("@gone");
  });

  test("DM events follow X's pages and stop at the limit", async () => {
    const page = (n: number, next?: string) => ({ body: { data: [{ id: `e${n}`, text: `t${n}`, sender_id: "u1", created_at: `2026-11-0${n}T00:00:00Z`, dm_conversation_id: "c" }], meta: next ? { next_token: next } : {} } });
    const x = fakeX((s) => (s.url.includes("pagination_token=p2") ? page(2, "p3") : s.url.includes("pagination_token=p3") ? page(3) : page(1, "p2")));
    const events = await new XClient({ clientId: "app1" }, x.fetch, now).dmEvents("at1");
    expect(events.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(new URL(x.seen[0]!.url).searchParams.get("event_types")).toBe("MessageCreate");
    const one = await new XClient({ clientId: "app1" }, x.fetch, now).dmEvents("at1", { participantId: "456", limit: 1 });
    expect(one.map((e) => e.id)).toEqual(["e1"]);
    expect(x.seen.at(-1)!.url).toStartWith("https://api.x.com/2/dm_conversations/with/456/dm_events?");
  });
});

describe("the X store", () => {
  const connection = { account: "personal", userId: "123", username: "matt", connectedAt: NOW.toISOString(), tokens: { accessToken: "at1", refreshToken: "rt1", expiresAt: "2026-11-02T17:00:00.000Z", scope: "dm.write" } };

  test("tokens are sealed with COLD_SECRET_KEY and read back", async () => {
    const db = await openDatabase(":memory:");
    const sealed = new XStore(db, { key: KEY, requireKey: true, now });
    await sealed.save(connection);
    const raw = await db.get<{ tokens: string }>("SELECT tokens FROM x_connections");
    expect(raw!.tokens).not.toContain("at1");
    expect(raw!.tokens).toStartWith("v1:");
    expect(await sealed.get("personal")).toEqual(connection);
    expect(await sealed.accounts()).toEqual([{ account: "personal", username: "matt", connectedAt: NOW.toISOString() }]);
  });

  test("without a key they are kept as they are on your own computer, and refused on a hosted server", async () => {
    const local = await store({ requireKey: false });
    await local.save(connection);
    expect((await local.get("personal"))?.tokens.accessToken).toBe("at1");
    const hosted = await store({ requireKey: true });
    const err = await hosted.save(connection).catch((e: unknown) => e);
    expect((err as Error).message).toContain("COLD_SECRET_KEY");
  });

  test("a Connect X attempt works once, and not after ten minutes", async () => {
    const db = await openDatabase(":memory:");
    let at = NOW;
    const s = new XStore(db, { key: KEY, requireKey: false, now: () => at });
    const { state, verifier } = await s.begin("personal", "http://127.0.0.1:4100/api/x/callback");
    expect(await s.take(state)).toEqual({ account: "personal", verifier, redirectUri: "http://127.0.0.1:4100/api/x/callback" });
    expect(await s.take(state)).toBeUndefined();
    const late = await s.begin("personal", "http://127.0.0.1:4100/api/x/callback");
    at = new Date(NOW.getTime() + 11 * 60_000);
    expect(await s.take(late.state)).toBeUndefined();
  });

  test("a step is claimed once: a second click finds it taken, a refusal frees it, a send keeps it", async () => {
    const s = await store();
    const key = { account: "personal", prospectKey: "csv:p01", sequence: "dm/personal/x-opener", step: 1 };
    expect(await s.claim(key)).toBeUndefined();
    expect(await s.claim(key)).toMatchObject({ status: "SENDING" });
    await s.release(key);
    expect(await s.claim(key)).toBeUndefined();
    await s.markSent(key, "ev1");
    await s.release(key);
    expect(await s.claim(key)).toEqual({ status: "SENT", eventId: "ev1", at: NOW.toISOString() });
  });

  test("handles are remembered without their case", async () => {
    const s = await store();
    const x = fakeX(() => ({ body: { data: { id: "456", username: "ClearviewTint" } } }));
    const client = new XClient({ clientId: "app1" }, x.fetch, now);
    expect(await xUserIdOf(s, client, "at1", "ClearviewTint")).toBe("456");
    expect(await xUserIdOf(s, client, "at1", "clearviewtint")).toBe("456");
    expect(x.seen).toHaveLength(1);
  });
});

describe("staying signed in", () => {
  test("a token about to run out is renewed, and X's new refresh token is kept", async () => {
    const s = await store();
    await s.save({ account: "personal", userId: "123", username: "matt", connectedAt: NOW.toISOString(), tokens: { accessToken: "old", refreshToken: "rt-old", expiresAt: "2026-11-02T15:00:30.000Z", scope: "" } });
    const x = fakeX(() => ({ body: { access_token: "new", refresh_token: "rt-new", expires_in: 7200 } }));
    const { token } = await accessTokenFor(s, new XClient({ clientId: "app1" }, x.fetch, now), "personal", now);
    expect(token).toBe("new");
    expect((await s.get("personal"))?.tokens).toMatchObject({ accessToken: "new", refreshToken: "rt-new" });
  });

  test("a call X refuses as unauthorized is tried once more with a renewed token", async () => {
    const s = await store();
    await s.save({ account: "personal", userId: "123", username: "matt", connectedAt: NOW.toISOString(), tokens: { accessToken: "revoked", refreshToken: "rt1", expiresAt: "2026-11-02T17:00:00.000Z", scope: "" } });
    const x = fakeX(() => ({ body: { access_token: "renewed", expires_in: 7200 } }));
    const client = new XClient({ clientId: "app1" }, x.fetch, now);
    const used: string[] = [];
    const result = await withXToken(s, client, "personal", now, async (token) => {
      used.push(token);
      if (token === "revoked") throw new XApiError("auth", "no", 401);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(used).toEqual(["revoked", "renewed"]);
    expect((await s.get("personal"))?.tokens.refreshToken).toBe("rt1");
  });

  test("an account that isn't connected says to connect it", async () => {
    const err = await accessTokenFor(await store(), new XClient({ clientId: "app1" }), "company", now).catch((e: unknown) => e);
    expect((err as Error).message).toBe("Account company is not connected to X: connect it in Settings.");
  });
});

describe("connecting X", () => {
  test("the sign-in page carries a state, and the callback trades it once for a connection", async () => {
    const s = await store();
    const x = fakeX((seen) => (seen.url.endsWith("/2/oauth2/token") ? tokenAnswer : { body: { data: { id: "123", username: "matt", name: "Matt" } } }));
    const client = new XClient({ clientId: "app1", clientSecret: "secret1" }, x.fetch, now);
    const url = new URL(await connectUrl(s, client.app, "personal", "http://127.0.0.1:4100/api/x/callback"));
    const state = url.searchParams.get("state")!;
    const connection = await finishConnect(s, client, { state, code: "code1" }, now);
    expect(connection).toMatchObject({ account: "personal", userId: "123", username: "matt" });
    expect((await s.get("personal"))?.tokens.accessToken).toBe("at1");
    const again = await finishConnect(s, client, { state, code: "code1" }, now).catch((e: unknown) => e);
    expect((again as Error).message).toContain("press Connect X again");
  });
});
