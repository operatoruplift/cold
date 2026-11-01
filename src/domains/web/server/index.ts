#!/usr/bin/env bun
/**
 * The COLD server: `bun run ui` on your computer, `bun run start` on a host.
 *
 *   /        the public site, with the waitlist
 *   /app/    the app (installable as a desktop or phone app), behind your login
 *   /api/    its JSON API; everything but signing in and the waitlist needs the login
 *
 * On your computer it listens on 127.0.0.1 only. Set COLD_PUBLIC_URL to run
 * it as a hosted server (see docs/deploy.md). The first start prints a
 * one-time setup code for creating your login. Flags: --no-open, and
 * --window to open the app in its own window (`bun run desktop`).
 */
import path from "node:path";
import { OwnerAuth } from "../../auth";
import { APP_ROOT, loadEnvFiles, ROOT } from "../../config";
import { openDatabase } from "../../db";
import { systemDesktop } from "../../dm";
import { seedMessages } from "../../messages";
import { Waitlist } from "../../waitlist";
import { aiRoutes } from "../ai";
import { decideRoutes } from "../decide";
import { createApi } from "../api";
import { WebContext } from "../context";
import { listenRoutes } from "../listen";
import { publicRoutes } from "../open";
import { xRoutes } from "../x";
import { buildAssets, bundle, DIST, readBundle } from "./assets";
import { clientAddress, createHandler, SetupCode } from "./handler";
import { serverSettings } from "./settings";

loadEnvFiles();
seedMessages();
const args = new Set(process.argv.slice(2));
let settings: ReturnType<typeof serverSettings>;
try {
  settings = serverSettings();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const db = await openDatabase(path.join(ROOT, ".cold", "cold.db"));
const auth = new OwnerAuth(db, { envOwner: OwnerAuth.envOwner() });
const waitlist = new Waitlist(db);
const ctx = new WebContext({ root: ROOT, db });
// Sends and scoring jobs are kept in the database: carry on with any that were under way when the server last stopped.
setInterval(() => void ctx.sends?.tick().catch((err) => console.error("send:", err)), 5000).unref();
setInterval(() => void ctx.scoring?.tick().catch((err) => console.error("scoring:", err)), 5000).unref();
// In production the site and the app come ready from `bun run build` (the Dockerfile runs it), so the
// server starts faster and smaller. Otherwise they're bundled now, so `bun run ui` shows your latest changes.
const bundled = (process.env.NODE_ENV === "production" && readBundle(path.join(APP_ROOT, DIST))) || (await bundle(APP_ROOT));
const assets = buildAssets(bundled, { appRoot: APP_ROOT, publicUrl: settings.publicUrl });
const appUrl = new URL("/app/", settings.publicUrl).href;
const setup = new SetupCode((code) => {
  console.log(`\nFirst run: create your login at ${appUrl}?setup=${code}`);
  console.log(`(setup code ${code}; it only works until the login exists)\n`);
});

let server: ReturnType<typeof Bun.serve>;
const handler = createHandler({
  settings,
  assets,
  version: assets.version,
  auth,
  waitlist,
  privateApi: createApi(ctx, [...aiRoutes(ctx), ...decideRoutes(ctx), ...xRoutes(ctx), ...listenRoutes(ctx)]),
  setup,
  clientIp: clientAddress(settings.proxyHops, (request) => server.requestIP(request)?.address),
  publicRoutes: publicRoutes(ctx),
});

try {
  // AI research can take a couple of minutes, so keep quiet connections open longer than Bun's 10 seconds.
  server = Bun.serve({ hostname: settings.hostname, port: settings.port, idleTimeout: 240, fetch: handler });
} catch (err) {
  console.error(`cold could not start on port ${settings.port}: ${(err as Error).message}`);
  console.error("Another program may be using it. Set COLD_UI_PORT to another port, e.g. COLD_UI_PORT=4200 bun run ui");
  process.exit(1);
}

console.log(`cold is running at ${settings.publicUrl.href}   (Ctrl+C to stop)`);
console.log(`  site  ${settings.publicUrl.href}`);
console.log(`  app   ${appUrl}`);
if (settings.mode === "hosted") console.log(`  data  ${ROOT}`);
const firstRun = !(await auth.owner());
const code = firstRun ? await setup.issue() : undefined;
if (settings.mode === "local" && !args.has("--no-open")) {
  const target = code ? `${appUrl}?setup=${code}` : appUrl;
  if (args.has("--window")) console.log(`  opened in ${systemDesktop.openWindow(target)}`);
  else systemDesktop.open(target);
}
