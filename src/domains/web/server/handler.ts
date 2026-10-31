import {
  clearedSessionCookie,
  newSetupCode,
  OwnerAuth,
  parseCookies,
  RateLimiter,
  sameSetupCode,
  SESSION_COOKIE,
  sessionCookie,
} from "../../auth";
import { parseSignup, Waitlist } from "../../waitlist";
import { refuseRequest } from "../guard";
import type { SessionResponse, SessionsResponse, WaitlistResponse } from "../types";
import type { BuiltAssets } from "./assets";
import type { ServerSettings } from "./settings";

/**
 * The one-time code that lets the first visitor create the owner login. It is
 * printed where the server runs, so only someone who can see that output can
 * use it. Twenty wrong tries replace it with a new one.
 */
export class SetupCode {
  private code?: string;
  private failures = 0;

  constructor(private readonly announce: (code: string) => void) {}

  get active(): boolean {
    return this.code !== undefined;
  }

  issue(): string {
    this.code = newSetupCode();
    this.failures = 0;
    this.announce(this.code);
    return this.code;
  }

  check(given: string): boolean {
    if (!this.code) return false;
    if (sameSetupCode(given, this.code)) return true;
    if (++this.failures >= 20) this.issue();
    return false;
  }

  clear(): void {
    this.code = undefined;
  }
}

export interface HandlerDeps {
  settings: ServerSettings;
  assets: BuiltAssets;
  auth: OwnerAuth;
  waitlist: Waitlist;
  /** Everything behind the login: campaigns, sending, AI, settings. */
  privateApi: (request: Request) => Promise<Response>;
  setup: SetupCode;
  /** The client's address (the socket's, unless a trusted proxy says otherwise). */
  clientIp: (request: Request) => string | undefined;
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

function limited(limiter: RateLimiter, key: string): void {
  const result = limiter.take(key);
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
  const { settings, assets, auth, waitlist, setup } = deps;
  const now = () => deps.now?.() ?? new Date();
  const loginLimit = new RateLimiter(10, 15 * 60_000);
  const setupLimit = new RateLimiter(10, 15 * 60_000);
  const waitlistLimit = new RateLimiter(8, 60 * 60_000);
  // A ceiling across everyone, so a botnet cannot fill the database.
  const waitlistDaily = new RateLimiter(5000, 24 * 60 * 60_000);
  const secure = settings.secureCookies;
  const csp = [
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

  function harden(response: Response, page = false): Response {
    const h = response.headers;
    h.set("x-content-type-options", "nosniff");
    h.set("referrer-policy", "strict-origin-when-cross-origin");
    h.set("x-frame-options", "DENY");
    h.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
    h.set("cross-origin-opener-policy", "same-origin");
    if (page) h.set("content-security-policy", csp);
    if (secure) h.set("strict-transport-security", "max-age=31536000");
    return response;
  }

  function sessionState(signedIn: boolean): SessionResponse {
    const owner = auth.owner();
    return { signedIn, owner: signedIn ? owner : undefined, setupRequired: !owner, mode: settings.mode, version: assets.version };
  }

  function startSession(request: Request, ip: string | undefined): Record<string, string> {
    const { token, expiresAt } = auth.createSession({ userAgent: request.headers.get("user-agent"), ip });
    return { "set-cookie": sessionCookie(token, expiresAt, secure, now()) };
  }

  async function api(request: Request, url: URL): Promise<Response> {
    const route = `${request.method} ${url.pathname}`;
    const ip = deps.clientIp(request);
    const token = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];

    switch (route) {
      case "GET /api/health":
        return json({ ok: true, version: assets.version });
      case "GET /api/session": {
        const session = auth.check(token);
        return json(sessionState(!!session), 200, session?.refreshed && token ? { "set-cookie": sessionCookie(token, session.expiresAt, secure, now()) } : {});
      }
      case "POST /api/session/login": {
        limited(loginLimit, `login:${ip ?? "?"}`);
        const body = await readJson(request);
        if (!auth.owner()) throw new HttpError(409, "There is no login yet. Create one with the setup code first.");
        if (!(await auth.verify(str(body.email), str(body.password)))) throw new HttpError(401, "That email and password do not match.");
        loginLimit.reset(`login:${ip ?? "?"}`);
        return json(sessionState(true), 200, startSession(request, ip));
      }
      case "POST /api/session/setup": {
        limited(setupLimit, `setup:${ip ?? "?"}`);
        const body = await readJson(request);
        if (auth.owner()) throw new HttpError(409, "The owner login already exists. Sign in instead.");
        if (!setup.check(str(body.code))) throw new HttpError(403, "That setup code is not right. Use the one printed where cold is running.");
        try {
          await auth.setOwner(str(body.email), str(body.password));
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        setup.clear();
        return json(sessionState(true), 201, startSession(request, ip));
      }
      case "POST /api/session/logout":
        auth.revoke(token);
        return json(sessionState(false), 200, { "set-cookie": clearedSessionCookie(secure) });
      case "POST /api/waitlist": {
        const parsed = parseSignup(await readJson(request));
        if (parsed.error) throw new HttpError(400, parsed.error);
        limited(waitlistLimit, `waitlist:${ip ?? "?"}`);
        limited(waitlistDaily, "waitlist:all");
        if (parsed.signup) waitlist.join(parsed.signup, { ip, userAgent: request.headers.get("user-agent") });
        return json({ ok: true, message: "You're on the list. We'll be in touch." }, 201);
      }
    }

    const session = auth.check(token);
    if (!session || !token) return json({ error: "Sign in first.", signedIn: false }, 401);
    const response = await privateRoute(request, url, route, token, ip);
    if (session.refreshed && !response.headers.has("set-cookie")) response.headers.append("set-cookie", sessionCookie(token, session.expiresAt, secure, now()));
    return response;
  }

  async function privateRoute(request: Request, url: URL, route: string, token: string, ip: string | undefined): Promise<Response> {
    switch (route) {
      case "GET /api/session/list":
        return json({ sessions: auth.sessions(token) } satisfies SessionsResponse);
      case "POST /api/session/revoke-others": {
        const ended = auth.revokeOthers(token);
        return json({ ok: true, message: ended ? `Signed out ${ended} other session${ended === 1 ? "" : "s"}.` : "There were no other sessions." });
      }
      case "POST /api/session/password": {
        limited(loginLimit, `login:${ip ?? "?"}`);
        const body = await readJson(request);
        const owner = auth.owner();
        if (!owner) throw new HttpError(409, "There is no owner login.");
        if (owner.managedByEnv) throw new HttpError(409, "The login is set by COLD_OWNER_EMAIL and COLD_OWNER_PASSWORD_HASH on the server; change it there.");
        const current = str(body.current);
        if (!(await auth.verify(owner.email, current))) throw new HttpError(401, "Your current password is not right.");
        try {
          await auth.setOwner(str(body.email) || owner.email, str(body.password) || current);
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        return json({ ok: true, message: "Saved. Every other session was signed out." }, 200, startSession(request, ip));
      }
      case "GET /api/waitlist":
        return json({ entries: waitlist.list({ q: url.searchParams.get("q") ?? undefined, status: url.searchParams.get("status") ?? undefined }), counts: waitlist.counts() } satisfies WaitlistResponse);
      case "GET /api/waitlist.csv":
        return new Response(waitlist.csv(), {
          headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="cold-waitlist-${now().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" },
        });
    }
    const entry = /^\/api\/waitlist\/(\d+)$/.exec(url.pathname);
    if (entry) {
      const id = Number(entry[1]);
      if (request.method === "PATCH") {
        const body = await readJson(request);
        try {
          return json(waitlist.update(id, { status: typeof body.status === "string" ? body.status : undefined, ownerNote: typeof body.ownerNote === "string" ? body.ownerNote : undefined }));
        } catch (err) {
          throw new HttpError(404, (err as Error).message);
        }
      }
      if (request.method === "DELETE") return waitlist.remove(id) ? json({ ok: true, message: "Removed from the waitlist." }) : json({ error: "No such person on the waitlist." }, 404);
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
