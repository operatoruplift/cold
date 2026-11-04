/** Which Host and Origin headers the server answers. */
export interface Access {
  hosts: readonly string[];
  origins: readonly string[];
}

/**
 * Why a request is refused, or undefined to let it through.
 *
 * - The Host must be one this server is reached at, so a page on another
 *   domain cannot rebind its DNS name to this server and read its answers.
 * - API calls must carry `x-cold: 1`. A browser only adds a custom header to a
 *   cross-site request after a CORS preflight, which this server never
 *   approves, so other sites cannot call the API with your session.
 * - An Origin, when the browser sends one, must be this server's.
 *
 * /api/health is open to anyone, for a host's uptime checks; /api/cron/
 * carries its own secret instead (Vercel's cron calls it). /api/x/callback is
 * where X sends the owner back after Connect X: a plain page load, so no
 * header, answered on this server's own hosts only and trusted only through
 * its one-time state.
 */
export function refuseRequest(request: Request, access: Access): string | undefined {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/health" || pathname.startsWith("/api/cron/")) return undefined;
  const host = request.headers.get("host") ?? "";
  if (!access.hosts.includes(host)) return `cold does not answer on ${host || "this address"}`;
  if (!pathname.startsWith("/api/")) return undefined;
  if (pathname === "/api/x/callback" && request.method === "GET") return undefined;
  if (request.headers.get("x-cold") !== "1") return "missing the x-cold header";
  const origin = request.headers.get("origin");
  if (origin && !access.origins.includes(origin)) return "cross-origin requests are not allowed";
  return undefined;
}

export const localHosts = (port: number) => [`127.0.0.1:${port}`, `localhost:${port}`] as const;
