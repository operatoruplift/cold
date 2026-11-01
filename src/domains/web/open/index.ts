import type { WebContext } from "../context";
import { OPEN_ROUTES } from "../guard";
import { listenWebhook } from "../listen";
import { xCallback } from "../x";

/**
 * The routes other services call, outside the login, each with its own proof:
 * X's Connect X callback (a one-time state) and OpenMagpie's webhook (a shared
 * secret). The guard lets exactly these through without the app's header.
 */
export function publicRoutes(ctx: WebContext): Record<string, (request: Request, url: URL) => Promise<Response>> {
  const callback = xCallback(ctx);
  const webhook = listenWebhook(ctx);
  const routes: Record<string, (request: Request, url: URL) => Promise<Response>> = {
    "GET /api/x/callback": (_request, url) => callback(url),
    "POST /api/listen/magpie": (request) => webhook(request),
  };
  for (const route of Object.keys(routes)) if (!OPEN_ROUTES.has(route)) throw new Error(`${route} is public but the guard doesn't let it through`);
  return routes;
}
