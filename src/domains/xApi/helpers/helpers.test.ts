import { describe, expect, test } from "bun:test";
import { XApiError } from "../types";
import { authorizeUrl, base64Url, codeChallenge, handleOf, randomToken, repliesIn, xErrorText, xFailure } from ".";

describe("PKCE and the X sign-in page", () => {
  test("the S256 challenge matches RFC 7636's example", async () => {
    expect(await codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("random tokens are URL-safe and 43 characters for 32 bytes", () => {
    const token = randomToken((n) => new Uint8Array(n).fill(251));
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(base64Url(new Uint8Array([251, 255]))).toBe("-_8");
  });

  test("the authorize URL asks for DMs, profiles and a refresh token, with the challenge", () => {
    const url = new URL(authorizeUrl({ clientId: "app1", redirectUri: "http://127.0.0.1:4100/api/x/callback", state: "s1", challenge: "c1" }));
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "app1",
      redirect_uri: "http://127.0.0.1:4100/api/x/callback",
      scope: "dm.read dm.write tweet.read users.read offline.access",
      state: "s1",
      code_challenge: "c1",
      code_challenge_method: "S256",
    });
  });
});

describe("what X's errors mean", () => {
  const kind = (status: number, body: unknown, doing: Parameters<typeof xFailure>[0]["doing"], reset?: string) => xFailure({ status, body, doing, resetHeader: reset });

  test("a closed inbox, a plan without DMs, and a dead token are told apart", () => {
    expect(kind(403, { detail: "You are not permitted to send Direct Messages to this user." }, "send").kind).toBe("cannotDm");
    expect(kind(403, { detail: "You currently have access to a subset of X API V2 endpoints and limited v1.1 endpoints only." }, "send").kind).toBe("access");
    expect(kind(403, { errors: [{ message: "Your client app is not configured with the appropriate oauth1 app permissions for this endpoint." }] }, "send").kind).toBe("access");
    expect(kind(401, { title: "Unauthorized" }, "send").kind).toBe("auth");
    expect(kind(404, {}, "lookup").kind).toBe("notFound");
    expect(kind(503, "Service Unavailable", "read").kind).toBe("other");
  });

  test("the token endpoint: a bad app key, an expired code, a refused renewal", () => {
    expect(kind(401, { error: "invalid_client" }, "connect").kind).toBe("access");
    expect(kind(400, { error: "invalid_request", error_description: "Value passed for the authorization code was invalid." }, "connect").kind).toBe("auth");
    expect(kind(400, { error: "invalid_grant" }, "refresh").message).toContain("connect X again");
  });

  test("a rate limit says when to try again", () => {
    const err = kind(429, { title: "Too Many Requests" }, "send", "1793632800");
    expect(err).toBeInstanceOf(XApiError);
    expect(err.kind).toBe("rateLimited");
    expect(err.retryAt?.toISOString()).toBe("2026-11-02T15:20:00.000Z");
    expect(err.message).toContain("after 15:20 UTC");
    expect(kind(429, {}, "send").message).toContain("in 15 minutes");
  });

  test("X's own words are quoted, whatever shape they come in", () => {
    expect(xErrorText({ detail: "d" })).toBe("d");
    expect(xErrorText({ errors: [{ message: "m" }] })).toBe("m");
    expect(xErrorText({ error: "invalid_grant", error_description: "gone" })).toBe("gone");
    expect(xErrorText(null)).toBe("");
    expect(kind(403, { detail: "You cannot send messages to this user." }, "send").message).toContain('X said: "You cannot send messages to this user."');
  });
});

describe("X handles", () => {
  test("a handle from @name, name or a profile link", () => {
    expect(handleOf("@ClearviewTint")).toBe("ClearviewTint");
    expect(handleOf("clearviewtint")).toBe("clearviewtint");
    expect(handleOf("https://x.com/clearviewtint")).toBe("clearviewtint");
    expect(handleOf("https://twitter.com/clearviewtint/status/123")).toBe("clearviewtint");
    expect(handleOf("x.com/@clearviewtint?ref=1")).toBe("clearviewtint");
  });

  test("anything else is not a handle", () => {
    expect(handleOf(undefined)).toBeUndefined();
    expect(handleOf("not a handle")).toBeUndefined();
    expect(handleOf("waytoolongforahandle1")).toBeUndefined();
    expect(handleOf("https://linkedin.com/in/dana")).toBeUndefined();
  });
});

describe("replies on X", () => {
  const event = (id: string, senderId: string, createdAt: string) => ({ id, senderId, createdAt, text: `message ${id}` });
  const awaiting = new Map([
    ["dana", { userId: "dana", sentAt: "2026-11-02T10:00:00Z" }],
    ["marcus", { userId: "marcus", sentAt: "2026-11-02T12:00:00Z" }],
  ]);

  test("the first answer from each person after cold's last DM, oldest first", () => {
    const events = [
      event("e5", "dana", "2026-11-02T11:30:00Z"),
      event("e4", "dana", "2026-11-02T11:00:00Z"),
      event("e3", "me", "2026-11-02T10:30:00Z"),
      event("e2", "marcus", "2026-11-02T11:59:00Z"),
      event("e1", "stranger", "2026-11-02T11:00:00Z"),
    ];
    expect(repliesIn(events, { me: "me", awaiting, logged: new Set() }).map((e) => e.id)).toEqual(["e4"]);
  });

  test("a message already logged is not a new reply", () => {
    const events = [event("e4", "dana", "2026-11-02T11:00:00Z"), event("e6", "marcus", "2026-11-02T13:00:00Z")];
    expect(repliesIn(events, { me: "me", awaiting, logged: new Set(["e4"]) }).map((e) => e.id)).toEqual(["e6"]);
  });
});
