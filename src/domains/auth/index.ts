import { createHash, randomBytes } from "node:crypto";
import type { Database } from "../db";

/** The cookie that carries a signed-in session. */
export const SESSION_COOKIE = "cold_session";
export const MIN_PASSWORD_LENGTH = 12;
const SESSION_DAYS = 30;
/** A session is pushed forward at most this often, so every request is not a write. */
const REFRESH_EVERY_MS = 60 * 60 * 1000;

export interface Owner {
  email: string;
  /** Set from COLD_OWNER_EMAIL and COLD_OWNER_PASSWORD_HASH: the app cannot change it. */
  managedByEnv: boolean;
}

export interface SessionInfo {
  /** The first characters of the token's hash: enough to tell sessions apart, useless to sign in with. */
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent?: string;
  ip?: string;
  current: boolean;
}

export interface CheckedSession {
  id: string;
  expiresAt: Date;
  /** The expiry moved: send the cookie again so the browser keeps it as long. */
  refreshed: boolean;
}

interface SessionRow {
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_agent: string | null;
  ip: string | null;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Why a password will not do, or undefined when it is fine. */
export function passwordProblem(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 256) return "Use at most 256 characters.";
  if (new Set(password).size < 5) return "Use more than a few different characters.";
  return undefined;
}

export function emailProblem(email: string): string | undefined {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) return "Enter a valid email address.";
  return undefined;
}

/** A one-time code for creating the owner login, e.g. K7QM-2XDP-9TAH (about 60 bits). */
export function newSetupCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((g) => g.join("")).join("-");
}

export const sameSetupCode = (given: string, expected: string) => given.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") === expected.replace(/-/g, "");

/**
 * The one person who may use the app: an email, an argon2id password hash and
 * their sessions, all in the app's SQLite file. COLD_OWNER_EMAIL with
 * COLD_OWNER_PASSWORD_HASH sets the owner from the environment instead, for
 * hosts where you cannot run a command.
 */
export class OwnerAuth {
  private dummyHash?: Promise<string>;

  constructor(
    private readonly db: Database,
    private readonly options: { envOwner?: { email: string; passwordHash: string }; now?: () => Date } = {},
  ) {}

  /** Reads COLD_OWNER_EMAIL and COLD_OWNER_PASSWORD_HASH; both or neither. */
  static envOwner(env: Record<string, string | undefined> = process.env): { email: string; passwordHash: string } | undefined {
    const email = env.COLD_OWNER_EMAIL?.trim();
    const passwordHash = env.COLD_OWNER_PASSWORD_HASH?.trim();
    if (!email && !passwordHash) return undefined;
    if (!email || !passwordHash) throw new Error("Set both COLD_OWNER_EMAIL and COLD_OWNER_PASSWORD_HASH, or neither.");
    if (!passwordHash.startsWith("$argon2") && !passwordHash.startsWith("$2")) throw new Error("COLD_OWNER_PASSWORD_HASH must be a hash from `bun run cold owner hash`, not the password itself.");
    return { email: normalizeEmail(email), passwordHash };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  owner(): Owner | undefined {
    if (this.options.envOwner) return { email: this.options.envOwner.email, managedByEnv: true };
    const row = this.db.query<{ email: string }, []>("SELECT email FROM owner WHERE id = 1").get();
    return row ? { email: row.email, managedByEnv: false } : undefined;
  }

  private passwordHash(): string | undefined {
    if (this.options.envOwner) return this.options.envOwner.passwordHash;
    return this.db.query<{ password_hash: string }, []>("SELECT password_hash FROM owner WHERE id = 1").get()?.password_hash;
  }

  /** Create or replace the owner. Signs every session out. */
  async setOwner(email: string, password: string): Promise<void> {
    if (this.options.envOwner) throw new Error("The owner is set by COLD_OWNER_EMAIL and COLD_OWNER_PASSWORD_HASH; change them there.");
    const address = normalizeEmail(email);
    const problem = emailProblem(address) ?? passwordProblem(password);
    if (problem) throw new Error(problem);
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    const at = this.now().toISOString();
    this.db.transaction(() => {
      this.db.query("INSERT INTO owner (id, email, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET email = excluded.email, password_hash = excluded.password_hash, updated_at = excluded.updated_at").run(address, hash, at, at);
      this.db.query("DELETE FROM sessions").run();
    })();
  }

  /** True when the email and password are the owner's. Takes as long either way. */
  async verify(email: string, password: string): Promise<boolean> {
    const owner = this.owner();
    const hash = this.passwordHash();
    const matches = !!owner && normalizeEmail(email) === owner.email && !!hash;
    if (!matches || !hash) {
      this.dummyHash ??= Bun.password.hash("not the password, only for timing", { algorithm: "argon2id" });
      await Bun.password.verify(password, await this.dummyHash).catch(() => false);
      return false;
    }
    return Bun.password.verify(password, hash).catch(() => false);
  }

  createSession(meta: { userAgent?: string | null; ip?: string | null } = {}): { token: string; expiresAt: Date } {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
    this.db.query("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString());
    this.db
      .query("INSERT INTO sessions (token_hash, created_at, last_seen_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)")
      .run(hashToken(token), now.toISOString(), now.toISOString(), expiresAt.toISOString(), meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null);
    return { token, expiresAt };
  }

  /** The session behind a token, if it is real and current. Keeps an active session alive. */
  check(token: string | undefined): CheckedSession | undefined {
    if (!token || token.length > 100 || !this.owner()) return undefined;
    const tokenHash = hashToken(token);
    const row = this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash);
    if (!row) return undefined;
    const now = this.now();
    if (new Date(row.expires_at) <= now) {
      this.db.query("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
      return undefined;
    }
    if (now.getTime() - new Date(row.last_seen_at).getTime() < REFRESH_EVERY_MS) return { id: tokenHash.slice(0, 12), expiresAt: new Date(row.expires_at), refreshed: false };
    const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
    this.db.query("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?").run(now.toISOString(), expiresAt.toISOString(), tokenHash);
    return { id: tokenHash.slice(0, 12), expiresAt, refreshed: true };
  }

  revoke(token: string | undefined): void {
    if (token) this.db.query("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }

  /** Sign out everywhere, except the session given (the one asking). Returns how many ended. */
  revokeOthers(keepToken?: string): number {
    const keep = keepToken ? hashToken(keepToken) : "";
    return this.db.query("DELETE FROM sessions WHERE token_hash != ?").run(keep).changes;
  }

  sessions(currentToken?: string): SessionInfo[] {
    const current = currentToken ? hashToken(currentToken) : "";
    return this.db
      .query<SessionRow, [string]>("SELECT * FROM sessions WHERE expires_at > ? ORDER BY last_seen_at DESC")
      .all(this.now().toISOString())
      .map((row) => ({
        id: row.token_hash.slice(0, 12),
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        userAgent: row.user_agent ?? undefined,
        ip: row.ip ?? undefined,
        current: row.token_hash === current,
      }));
  }
}

/** A fixed-window counter per key: at most `limit` hits in `windowMs`. In memory, so per process. */
export class RateLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one hit. When over the limit, says how long until the window resets. */
  take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = this.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
    const entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      return { ok: true };
    }
    entry.count++;
    if (entry.count <= this.limit) return { ok: true };
    return { ok: false, retryAfterSeconds: Math.ceil((entry.start + this.windowMs - now) / 1000) };
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      cookies[name] = part.slice(at + 1).trim();
    }
  }
  return cookies;
}

/** HttpOnly and SameSite=Strict: page scripts cannot read it, and other sites cannot send it. */
export function sessionCookie(token: string, expiresAt: Date, secure: boolean, now = new Date()): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}
