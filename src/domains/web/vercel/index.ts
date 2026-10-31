import { DbRateLimiter, OwnerAuth } from "../../auth";
import { connectDatabase, databaseFromEnv, type Db } from "../../db";
import { seedMessagesInto } from "../../messages";
import { DbFiles, DbSecrets, secretKey } from "../../storage";
import { Waitlist } from "../../waitlist";
import { aiRoutes } from "../ai";
import { createApi } from "../api";
import { invocationDeadline } from "../background";
import { WebContext } from "../context";
import { clientAddress, createHandler, DbSetupCode } from "../server/handler";
import { serverSettings } from "../server/settings";

/** Things that only need doing now and then: expired rate-limit windows and sessions. */
async function tidy(db: Db): Promise<void> {
  const now = Date.now();
  await db.batch([
    ["DELETE FROM rate_limits WHERE window_start < ?", now - 2 * 86_400_000],
    ["DELETE FROM sessions WHERE expires_at <= ?", new Date(now).toISOString()],
  ]);
}

/**
 * COLD as one Vercel function. The site and the app are static files on
 * Vercel's CDN; this answers /api: the waitlist, the login, and the app's
 * data, all in the database. Tests hand it a SQLite database.
 */
export async function createVercelApp(db: Db, options: { now?: () => Date } = {}): Promise<(request: Request) => Promise<Response>> {
  const files = new DbFiles(db);
  await seedMessagesInto(files);
  const ctx = new WebContext({ files, secrets: new DbSecrets(db, secretKey()), db, now: options.now });
  const settings = serverSettings();
  const auth = new OwnerAuth(db, { envOwner: OwnerAuth.envOwner() });
  const appUrl = new URL("/app/", settings.publicUrl).href;
  const setup = new DbSetupCode(db, (code) => console.log(`First run: create your login at ${appUrl}?setup=${code} (setup code ${code}; it only works until the login exists)`));
  if (!(await auth.owner())) await setup.announceIfNeeded();
  return createHandler({
    settings,
    version: (process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.VERCEL_DEPLOYMENT_ID ?? "dev").slice(0, 12),
    auth,
    waitlist: new Waitlist(db),
    privateApi: createApi(ctx, aiRoutes(ctx)),
    setup,
    // Vercel sets X-Forwarded-For to the visitor's address itself.
    clientIp: clientAddress(settings.proxyHops, () => undefined),
    limiter: (limit, windowMs) => new DbRateLimiter(db, limit, windowMs),
    cron: async () => {
      await ctx.freshen();
      await ctx.sends?.tick({ deadline: invocationDeadline(), lookaheadMs: 60_000 });
      await tidy(db);
    },
  });
}

/** Starts once per instance, on the first request, and is reused while the instance stays warm. */
async function boot(): Promise<(request: Request) => Promise<Response>> {
  const where = databaseFromEnv();
  if (!where) throw new Error("COLD needs its database: add Turso to this project (Vercel, Storage), or set COLD_DATABASE_URL and COLD_DATABASE_TOKEN.");
  return createVercelApp(await connectDatabase(where));
}

let ready: Promise<(request: Request) => Promise<Response>> | undefined;

export async function vercelHandler(request: Request): Promise<Response> {
  ready ??= boot().catch((err) => {
    ready = undefined;
    throw err;
  });
  try {
    return await (await ready)(request);
  } catch (err) {
    console.error(err);
    return Response.json({ error: (err as Error).message }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
