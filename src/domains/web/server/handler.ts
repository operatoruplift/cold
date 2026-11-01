import {
  clearedSessionCookie,
  newSetupCode,
  OwnerAuth,
  parseCookies,
  RateLimiter,
  sameSetupCode,
  SESSION_COOKIE,
  sessionCookie,
  type Limiter,
} from "../../auth";
import type { Db } from "../../db";
import { parseSignup, Waitlist } from "../../waitlist";
import { refuseRequest } from "../guard";
import type { SessionResponse, SessionsResponse, WaitlistResponse } from "../types";
import type { BuiltAssets } from "./assets";
import type { ServerSettings } from "./settings";

/**
 * The one-time code that lets the first visitor create the owner login. It is
 * printed where the server runs (the terminal, or Vercel's logs), so only
 * someone who can see that output can use it. Twenty wrong tries replace it
 * with a new one.
 */
export interface SetupCodes {
  issue(): Promise<string>;
  check(given: string): Promise<boolean>;
  clear(): Promise<void>;
}

/** The code in this server's memory: right for one server on your computer. */
/** Wrong setup codes before the code is replaced, so guessing it gets nowhere. */
const SETUP_TRIES = 20;
const REPLACED = `${SETUP_TRIES} wrong setup codes were tried, so the setup code was replaced with a new one (below). The old one no longer works.`;

export class SetupCode implements SetupCodes {
  private code?: string;
  private failures = 0;

  constructor(private readonly announce: (code: string) => void) {}

  get active(): boolean {
    return this.code !== undefined;
  }

  async issue(): Promise<string> {
    this.code = newSetupCode();
    this.failures = 0;
    this.announce(this.code);
    return this.code;
  }

  async check(given: string): Promise<boolean> {
    if (!this.code) return false;
    if (sameSetupCode(given, this.code)) return true;
    if (++this.failures >= SETUP_TRIES) {
      console.warn(REPLACED);
      await this.issue();
    }
    return false;
  }

  async clear(): Promise<void> {
    this.code = undefined;
  }
}

/** The code in the database, so every copy of the server (Vercel runs several) knows the same one. */
export class DbSetupCode implements SetupCodes {
  constructor(
    private readonly db: Db,
    private readonly announce: (code: string) => void,
  ) {}

  private async current(): Promise<string | undefined> {
    return (await this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'setup_code'"))?.value;
  }

  /** At start, while there is no login: say the code (a new one the first time), so it is in the logs. */
  async announceIfNeeded(): Promise<void> {
    const code = await this.current();
    if (code) this.announce(code);
    else await this.issue();
  }

  async issue(): Promise<string> {
    const code = newSetupCode();
    await this.db.batch([
      ["INSERT INTO meta (key, value) VALUES ('setup_code', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", code],
      ["INSERT INTO meta (key, value) VALUES ('setup_failures', '0') ON CONFLICT (key) DO UPDATE SET value = '0'"],
    ]);
    this.announce(code);
    return code;
  }

  async check(given: string): Promise<boolean> {
    const code = await this.current();
    if (!code) return false;
    if (sameSetupCode(given, code)) return true;
    const row = await this.db.get<{ value: string }>(
      "INSERT INTO meta (key, value) VALUES ('setup_failures', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) RETURNING value",
    );
    if (Number(row?.value) >= SETUP_TRIES) {
      console.warn(REPLACED);
      await this.issue();
    }
    return false;
  }

  async clear(): Promise<void> {
    await this.db.run("DELETE FROM meta WHERE key IN ('setup_code', 'setup_failures')");
  }
}

/** What a page may load: only this site's own files. vercel.json repeats it for the pages Vercel serves; a test keeps the two the same. */
export function contentSecurityPolicy(secure: boolean): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    "worker-src 'self'",
    ...(secure ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** Headers on every response. */
export function securityHeaders(secure: boolean): Record<string, string> {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "cross-origin-opener-policy": "same-origin",
    ...(secure ? { "strict-transport-security": "max-age=31536000" } : {}),
  };
}

export interface HandlerDeps {
  settings: ServerSettings;
  /** The site and app pages and their files. Without them (on Vercel, where the CDN serves them) only /api is answered. */
  assets?: BuiltAssets;
  /** This build, for /api/health. */
  version: string;
  auth: OwnerAuth;
  waitlist: Waitlist;
  /** Everything behind the login: campaigns, sending, AI, settings. */
  privateApi: (request: Request) => Promise<Response>;
  setup: SetupCodes;
  /** The client's address (the socket's, unless a trusted proxy says otherwise). */
  clientIp: (request: Request) => string | undefined;
  /** Rate limit counters: in memory by default, in the database when several servers share the work. */
  limiter?: (limit: number, windowMs: number) => Limiter;
  /** What Vercel's cron job runs every minute (the next emails of a send), behind CRON_SECRET. */
  cron?: () => Promise<void>;
  now?: () => Date;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "The request body must be a JSON object.");
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

async function limited(limiter: Limiter, key: string): Promise<void> {
  const result = await limiter.take(key);
  if (!result.ok) {
    const minutes = Math.max(1, Math.ceil(result.retryAfterSeconds / 60));
    throw new HttpError(429, `Too many tries. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, { "retry-after": String(result.retryAfterSeconds) });
  }
}

/**
 * Every request the server answers. The public site, the waitlist signup and
 * the sign-in calls are open; the app's data is not: any other /api call needs
 * the owner's session cookie, or gets a 401.
 */
export function createHandler(deps: HandlerDeps): (request: Request) => Promise<Response> {
  const { settings, assets, auth, waitlist, setup, version } = deps;
  const now = () => deps.now?.() ?? new Date();
  const limiter = deps.limiter ?? ((limit: number, windowMs: number) => new RateLimiter(limit, windowMs));
  const loginLimit = limiter(10, 15 * 60_000);
  const setupLimit = limiter(10, 15 * 60_000);
  const waitlistLimit = limiter(8, 60 * 60_000);
  // A ceiling across everyone, so a botnet cannot fill the database.
  const waitlistDaily = limiter(5000, 24 * 60 * 60_000);
  const secure = settings.secureCookies;
  const headers = securityHeaders(secure);
  const csp = contentSecurityPolicy(secure);

  function harden(response: Response, page = false): Response {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    if (page) response.headers.set("content-security-policy", csp);
    return response;
  }

  async function sessionState(signedIn: boolean): Promise<SessionResponse> {
    const owner = await auth.owner();
    return { signedIn, owner: signedIn ? owner : undefined, setupRequired: !owner, mode: settings.mode, version };
  }

  async function startSession(request: Request, ip: string | undefined): Promise<Record<string, string>> {
    const { token, expiresAt } = await auth.createSession({ userAgent: request.headers.get("user-agent"), ip });
    return { "set-cookie": sessionCookie(token, expiresAt, secure, now()) };
  }

  async function api(request: Request, url: URL): Promise<Response> {
    const route = `${request.method} ${url.pathname}`;
    const ip = deps.clientIp(request);
    const token = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];

    switch (route) {
      case "GET /api/health":
        return json({ ok: true, version });
      case "GET /api/cron/tick": {
        const secret = process.env.CRON_SECRET;
        if (!deps.cron || !secret || request.headers.get("authorization") !== `Bearer ${secret}`) throw new HttpError(401, "Not for you.");
        await deps.cron();
        return json({ ok: true });
      }
      case "GET /api/session": {
        const session = await auth.check(token);
        return json(await sessionState(!!session), 200, session?.refreshed && token ? { "set-cookie": sessionCookie(token, session.expiresAt, secure, now()) } : {});
      }
      case "POST /api/session/login": {
        await limited(loginLimit, `login:${ip ?? "?"}`);
        const body = await readJson(request);
        if (!(await auth.owner())) throw new HttpError(409, "There is no login yet. Create one with the setup code first.");
        if (!(await auth.verify(str(body.email), str(body.password)))) throw new HttpError(401, "That email and password do not match.");
        await loginLimit.reset(`login:${ip ?? "?"}`);
        return json(await sessionState(true), 200, await startSession(request, ip));
      }
      case "POST /api/session/setup": {
        await limited(setupLimit, `setup:${ip ?? "?"}`);
        const body = await readJson(request);
        if (await auth.owner()) throw new HttpError(409, "The owner login already exists. Sign in instead.");
        if (!(await setup.check(str(body.code)))) throw new HttpError(403, "That setup code is not right. Use the one printed where cold is running.");
        try {
          await auth.setOwner(str(body.email), str(body.password));
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        await setup.clear();
        return json(await sessionState(true), 201, await startSession(request, ip));
      }
      case "POST /api/session/logout":
        await auth.revoke(token);
        return json(await sessionState(false), 200, { "set-cookie": clearedSessionCookie(secure) });
      case "POST /api/waitlist": {
        const parsed = parseSignup(await readJson(request));
        if (parsed.error) throw new HttpError(400, parsed.error);
        await limited(waitlistLimit, `waitlist:${ip ?? "?"}`);
        await limited(waitlistDaily, "waitlist:all");
        if (parsed.signup) await waitlist.join(parsed.signup, { ip, userAgent: request.headers.get("user-agent") });
        return json({ ok: true, message: "You're on the list. We'll be in touch." }, 201);
      }
    }

    const session = await auth.check(token);
    if (!session || !token) return json({ error: "Sign in first.", signedIn: false }, 401);
    const response = await privateRoute(request, url, route, token, ip);
    if (session.refreshed && !response.headers.has("set-cookie")) response.headers.append("set-cookie", sessionCookie(token, session.expiresAt, secure, now()));
    return response;
  }

  async function privateRoute(request: Request, url: URL, route: string, token: string, ip: string | undefined): Promise<Response> {
    switch (route) {
      case "GET /api/session/list":
        return json({ sessions: await auth.sessions(token) } satisfies SessionsResponse);
      case "POST /api/session/revoke-others": {
        const ended = await auth.revokeOthers(token);
        return json({ ok: true, message: ended ? `Signed out ${ended} other session${ended === 1 ? "" : "s"}.` : "There were no other sessions." });
      }
      case "POST /api/session/password": {
        await limited(loginLimit, `login:${ip ?? "?"}`);
        const body = await readJson(request);
        const owner = await auth.owner();
        if (!owner) throw new HttpError(409, "There is no owner login.");
        if (owner.managedByEnv) throw new HttpError(409, "The login is set by COLD_OWNER_EMAIL and COLD_OWNER_PASSWORD_HASH on the server; change it there.");
        const current = str(body.current);
        if (!(await auth.verify(owner.email, current))) throw new HttpError(401, "Your current password is not right.");
        try {
          await auth.setOwner(str(body.email) || owner.email, str(body.password) || current);
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        return json({ ok: true, message: "Saved. Every other session was signed out." }, 200, await startSession(request, ip));
      }
      case "GET /api/waitlist":
        return json({ entries: await waitlist.list({ q: url.searchParams.get("q") ?? undefined, status: url.searchParams.get("status") ?? undefined }), counts: await waitlist.counts() } satisfies WaitlistResponse);
      case "GET /api/waitlist.csv":
        return new Response(await waitlist.csv(), {
          headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="cold-waitlist-${now().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" },
        });
    }
    const entry = /^\/api\/waitlist\/(\d+)$/.exec(url.pathname);
    if (entry) {
      const id = Number(entry[1]);
      if (request.method === "PATCH") {
        const body = await readJson(request);
        try {
          return json(await waitlist.update(id, { status: typeof body.status === "string" ? body.status : undefined, ownerNote: typeof body.ownerNote === "string" ? body.ownerNote : undefined }));
        } catch (err) {
          throw new HttpError(404, (err as Error).message);
        }
      }
      if (request.method === "DELETE") return (await waitlist.remove(id)) ? json({ ok: true, message: "Removed from the waitlist." }) : json({ error: "No such person on the waitlist." }, 404);
    }
    return deps.privateApi(request);
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const refusal = refuseRequest(request, settings);
    if (refusal) return harden(new Response(refusal, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } }));

    if (url.pathname.startsWith("/api/")) {
      try {
        return harden(await api(request, url));
      } catch (err) {
        if (err instanceof HttpError) return harden(json({ error: err.message }, err.status, err.headers));
        console.error(err);
        return harden(json({ error: "Something went wrong on the server." }, 500));
      }
    }

    if (!assets) return harden(new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } }));
    if (request.method !== "GET" && request.method !== "HEAD") return harden(new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } }));
    const page = (html: string) => harden(new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } }), true);
    if (url.pathname === "/" || url.pathname === "/index.html") return page(assets.pages.site);
    if (url.pathname === "/app") return harden(new Response(null, { status: 308, headers: { location: `/app/${url.search}` } }));
    if (url.pathname.startsWith("/app/")) return page(assets.pages.app);
    const file = assets.files.get(url.pathname);
    if (file) return harden(new Response(file.body(), { headers: { "content-type": file.type, "cache-control": file.cacheControl } }));
    return harden(new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } }));
  };
}

/**
 * The client address: the socket's, or behind proxies the X-Forwarded-For
 * entry `hops` from the end. Each trusted proxy appends the address it saw,
 * so anything a client wrote into the header itself sits further left and is
 * never read.
 */
export function clientAddress(hops: number, socketIp: (request: Request) => string | undefined): (request: Request) => string | undefined {
  return (request) => {
    if (hops > 0) {
      const forwarded = request.headers.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
      if (forwarded?.length) return forwarded[Math.max(0, forwarded.length - hops)];
    }
    return socketIp(request);
  };
}
