import { describe, expect, test } from "bun:test";
import { openDatabase } from "../db";
import { newSetupCode, OwnerAuth, parseCookies, passwordProblem, RateLimiter, sameSetupCode, sessionCookie } from ".";

const fresh = (now = () => new Date("2026-11-02T15:00:00Z")) => new OwnerAuth(openDatabase(":memory:"), { now });

describe("OwnerAuth", () => {
  test("has no owner until one is set, then verifies only that email and password", async () => {
    const auth = fresh();
    expect(auth.owner()).toBeUndefined();
    await auth.setOwner(" Me@Cold.dev ", "correct horse battery");
    expect(auth.owner()).toEqual({ email: "me@cold.dev", managedByEnv: false });
    expect(await auth.verify("ME@cold.dev", "correct horse battery")).toBe(true);
    expect(await auth.verify("me@cold.dev", "correct horse batter")).toBe(false);
    expect(await auth.verify("someone@else.dev", "correct horse battery")).toBe(false);
  });

  test("refuses weak passwords and bad emails", async () => {
    const auth = fresh();
    await expect(auth.setOwner("me@cold.dev", "short")).rejects.toThrow("at least 12");
    await expect(auth.setOwner("not-an-email", "correct horse battery")).rejects.toThrow("valid email");
    expect(passwordProblem("aaaaaaaaaaaaaaaa")).toContain("different characters");
  });

  test("sessions are checked by token, expire, and end on sign-out or a password change", async () => {
    let now = new Date("2026-11-02T15:00:00Z");
    const auth = fresh(() => now);
    await auth.setOwner("me@cold.dev", "correct horse battery");
    const { token } = auth.createSession({ userAgent: "test", ip: "1.2.3.4" });
    expect(auth.check(token)?.refreshed).toBe(false);
    expect(auth.check("not-a-token")).toBeUndefined();

    // An active session is pushed forward, at most hourly.
    now = new Date("2026-11-03T15:00:00Z");
    const later = auth.check(token)!;
    expect(later.refreshed).toBe(true);
    expect(later.expiresAt.toISOString()).toBe("2026-12-03T15:00:00.000Z");

    // Thirty idle days end it.
    now = new Date("2027-01-10T15:00:00Z");
    expect(auth.check(token)).toBeUndefined();

    const second = auth.createSession().token;
    const third = auth.createSession().token;
    expect(auth.revokeOthers(second)).toBe(1);
    expect(auth.check(third)).toBeUndefined();
    expect(auth.sessions(second).find((s) => s.current)).toBeDefined();
    await auth.setOwner("me@cold.dev", "a brand new password");
    expect(auth.check(second)).toBeUndefined();
  });

  test("an owner from the environment cannot be changed in the app", async () => {
    const passwordHash = await Bun.password.hash("correct horse battery", { algorithm: "argon2id" });
    const auth = new OwnerAuth(openDatabase(":memory:"), { envOwner: OwnerAuth.envOwner({ COLD_OWNER_EMAIL: "Me@Cold.dev", COLD_OWNER_PASSWORD_HASH: passwordHash }) });
    expect(auth.owner()).toEqual({ email: "me@cold.dev", managedByEnv: true });
    expect(await auth.verify("me@cold.dev", "correct horse battery")).toBe(true);
    await expect(auth.setOwner("me@cold.dev", "another long password")).rejects.toThrow("COLD_OWNER_EMAIL");
    expect(() => OwnerAuth.envOwner({ COLD_OWNER_EMAIL: "me@cold.dev", COLD_OWNER_PASSWORD_HASH: "plaintext" })).toThrow("not the password itself");
    expect(() => OwnerAuth.envOwner({ COLD_OWNER_EMAIL: "me@cold.dev" })).toThrow("both");
  });
});

describe("helpers", () => {
  test("setup codes are long, readable, and compared loosely", () => {
    const code = newSetupCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(sameSetupCode(code.toLowerCase().replace(/-/g, " "), code)).toBe(true);
    expect(sameSetupCode("AAAA-BBBB-CCCC", code)).toBe(code === "AAAA-BBBB-CCCC");
  });

  test("rate limiter allows the limit per window, then says how long to wait", () => {
    let now = 0;
    const limit = new RateLimiter(2, 60_000, () => now);
    expect(limit.take("ip").ok).toBe(true);
    expect(limit.take("ip").ok).toBe(true);
    const third = limit.take("ip");
    expect(third.ok).toBe(false);
    expect(!third.ok && third.retryAfterSeconds).toBe(60);
    now = 60_001;
    expect(limit.take("ip").ok).toBe(true);
  });

  test("cookies", () => {
    expect(parseCookies("a=1; cold_session=abc%3D; b")).toEqual({ a: "1", cold_session: "abc=" });
    const cookie = sessionCookie("tok", new Date("2026-12-02T15:00:00Z"), true, new Date("2026-11-02T15:00:00Z"));
    expect(cookie).toBe("cold_session=tok; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure");
  });
});
