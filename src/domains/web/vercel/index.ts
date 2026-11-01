import { createHash } from "node:crypto";
import { DbRateLimiter, OwnerAuth } from "../../auth";
import { connectDatabase, databaseFromEnv, metaValue, type Db } from "../../db";
import { seedMessagesInto } from "../../messages";
import { DbFiles, DbSecrets, secretKey } from "../../storage";
import { Waitlist } from "../../waitlist";
import { aiRoutes } from "../ai";
import { decideRoutes } from "../decide";
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
    // Finished scoring jobs are kept a month; the scores themselves stay.
    ["DELETE FROM score_job_items WHERE job_id IN (SELECT id FROM score_jobs WHERE status != 'running' AND updated_at < ?)", new Date(now - 30 * 86_400_000).toISOString()],
    ["DELETE FROM score_jobs WHERE status != 'running' AND updated_at < ?", new Date(now - 30 * 86_400_000).toISOString()],
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
    privateApi: createApi(ctx, [...aiRoutes(ctx), ...decideRoutes(ctx)]),
    setup,
    // Vercel sets X-Forwarded-For to the visitor's address itself.
    clientIp: clientAddress(settings.proxyHops, () => undefined),
    limiter: (limit, windowMs) => new DbRateLimiter(db, limit, windowMs),
    cron: async () => {
      await ctx.freshen();
      // Sends and scoring side by side: a send waiting out its pause doesn't hold up a list being scored.
      const deadline = invocationDeadline();
      await Promise.all([ctx.sends?.tick({ deadline, lookaheadMs: 60_000 }), ctx.scoring?.tick({ deadline })]);
      await tidy(db);
    },
  });
}

/**
 * One line at start, so the logs show which database each deployment is on:
 * a fingerprint of its address (never the address or the token), the
 * variable it came from, and when COLD first used it. Deployments that print
 * different fingerprints are on different databases, and a login made on one
 * is not on the other (docs/deploy.md says what to change).
 */
export async function databaseNote(db: Db, where: { url: string; from: string }, now: () => Date = () => new Date()): Promise<string> {
  const firstUsed = await metaValue(db, "first_used_at", () => now().toISOString());
  const fingerprint = createHash("sha256").update(where.url).digest("hex").slice(0, 8);
  return `Database ${fingerprint} (from ${where.from}), first used ${firstUsed}.`;
}

/** Starts once per instance, on the first request, and is reused while the instance stays warm. */
async function boot(): Promise<(request: Request) => Promise<Response>> {
  const where = databaseFromEnv();
  if (!where) throw new Error("COLD needs its database: add Turso to this project (Vercel, Storage), or set COLD_DATABASE_URL and COLD_DATABASE_TOKEN.");
  const db = await connectDatabase(where);
  console.log(await databaseNote(db, where));
  return createVercelApp(db);
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
