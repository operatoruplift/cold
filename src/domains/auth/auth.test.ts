import { describe, expect, test } from "bun:test";
import { openDatabase } from "../db";
import { DbRateLimiter, newSetupCode, OwnerAuth, parseCookies, passwordProblem, RateLimiter, sameSetupCode, sessionCookie, type Limiter } from ".";

const fresh = async (now = () => new Date("2026-11-02T15:00:00Z")) => new OwnerAuth(await openDatabase(":memory:"), { now });

describe("OwnerAuth", () => {
  test("has no owner until one is set, then verifies only that email and password", async () => {
    const auth = await fresh();
    expect(await auth.owner()).toBeUndefined();
    await auth.setOwner(" Me@Cold.dev ", "correct horse battery");
    expect(await auth.owner()).toEqual({ email: "me@cold.dev", managedByEnv: false });
    expect(await auth.verify("ME@cold.dev", "correct horse battery")).toBe(true);
    expect(await auth.verify("me@cold.dev", "correct horse batter")).toBe(false);
    expect(await auth.verify("someone@else.dev", "correct horse battery")).toBe(false);
  });

  test("refuses weak passwords and bad emails", async () => {
    const auth = await fresh();
    await expect(auth.setOwner("me@cold.dev", "short")).rejects.toThrow("at least 12");
    await expect(auth.setOwner("not-an-email", "correct horse battery")).rejects.toThrow("valid email");
    expect(passwordProblem("aaaaaaaaaaaaaaaa")).toContain("different characters");
  });

  test("sessions are checked by token, expire, and end on sign-out or a password change", async () => {
    let now = new Date("2026-11-02T15:00:00Z");
    const auth = await fresh(() => now);
    await auth.setOwner("me@cold.dev", "correct horse battery");
    const { token } = await auth.createSession({ userAgent: "test", ip: "1.2.3.4" });
    expect((await auth.check(token))?.refreshed).toBe(false);
    expect(await auth.check("not-a-token")).toBeUndefined();

    // An active session is pushed forward, at most hourly.
    now = new Date("2026-11-03T15:00:00Z");
    const later = (await auth.check(token))!;
    expect(later.refreshed).toBe(true);
    expect(later.expiresAt.toISOString()).toBe("2026-12-03T15:00:00.000Z");

    // Thirty idle days end it.
    now = new Date("2027-01-10T15:00:00Z");
    expect(await auth.check(token)).toBeUndefined();

    const second = (await auth.createSession()).token;
    const third = (await auth.createSession()).token;
    expect(await auth.revokeOthers(second)).toBe(1);
    expect(await auth.check(third)).toBeUndefined();
    expect((await auth.sessions(second)).find((s) => s.current)).toBeDefined();
    await auth.setOwner("me@cold.dev", "a brand new password");
    expect(await auth.check(second)).toBeUndefined();
  });

  test("an owner from the environment cannot be changed in the app", async () => {
    const passwordHash = await Bun.password.hash("correct horse battery", { algorithm: "argon2id" });
    const auth = new OwnerAuth(await openDatabase(":memory:"), { envOwner: OwnerAuth.envOwner({ COLD_OWNER_EMAIL: "Me@Cold.dev", COLD_OWNER_PASSWORD_HASH: passwordHash }) });
    expect(await auth.owner()).toEqual({ email: "me@cold.dev", managedByEnv: true });
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

  test("rate limiters allow the limit per window, then say how long to wait, in memory and in the database", async () => {
    let now = 1_000_000;
    const db = await openDatabase(":memory:");
    const limiters: Limiter[] = [new RateLimiter(2, 60_000, () => now), new DbRateLimiter(db, 2, 60_000, () => now)];
    for (const limit of limiters) {
      now = 1_000_000;
      expect((await limit.take("ip")).ok).toBe(true);
      expect((await limit.take("ip")).ok).toBe(true);
      expect((await limit.take("other")).ok).toBe(true);
      const third = await limit.take("ip");
      expect(third.ok).toBe(false);
      expect(!third.ok && third.retryAfterSeconds).toBe(60);
      now += 60_001;
      expect((await limit.take("ip")).ok).toBe(true);
      await limit.take("ip");
      await limit.reset("ip");
      expect((await limit.take("ip")).ok).toBe(true);
    }
  });

  test("cookies", () => {
    expect(parseCookies("a=1; cold_session=abc%3D; b")).toEqual({ a: "1", cold_session: "abc=" });
    const cookie = sessionCookie("tok", new Date("2026-12-02T15:00:00Z"), true, new Date("2026-11-02T15:00:00Z"));
    expect(cookie).toBe("cold_session=tok; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure");
  });
});
