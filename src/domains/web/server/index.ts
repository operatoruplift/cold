#!/usr/bin/env bun
/**
 * The local web UI: `bun run ui`, then http://localhost:4100.
 *
 * Listens on 127.0.0.1 only. The page and its API run in this one process,
 * with your mailbox passwords and Twenty key read from .env.local as the CLI
 * does. Flags: --no-open (do not open a browser), --dev (rebuild on change).
 * COLD_UI_PORT picks another port.
 */
import index from "../../../web/index.html";
import { loadEnvFiles, ROOT } from "../../config";
import { systemDesktop } from "../../dm";
import { MESSAGES_DIR } from "../../messages";
import { createApi } from "../api";
import { WebContext } from "../context";
import { localHosts, refuseRequest } from "../guard";

loadEnvFiles();
const args = new Set(process.argv.slice(2));
const port = Number(process.env.COLD_UI_PORT) || 4100;
const hosts = localHosts(port);
const api = createApi(new WebContext({ root: ROOT, messagesDir: MESSAGES_DIR }));

try {
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    development: args.has("--dev") ? { hmr: true } : false,
    routes: {
      "/api/*": (request) => {
        const reason = refuseRequest(request, hosts);
        return reason ? new Response(reason, { status: 403 }) : api(request);
      },
      "/*": index,
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
} catch (err) {
  console.error(`cold could not start on port ${port}: ${(err as Error).message}`);
  console.error("Another program may be using it. Set COLD_UI_PORT to another port, e.g. COLD_UI_PORT=4200 bun run ui");
  process.exit(1);
}

const url = `http://localhost:${port}`;
console.log(`cold is running at ${url}   (Ctrl+C to stop)`);
if (!args.has("--no-open")) systemDesktop.open(url);
