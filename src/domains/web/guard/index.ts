/**
 * The local UI's only security boundary. The server listens on 127.0.0.1, but
 * any website open in the same browser can still send requests to it, so:
 *
 *  - the Host header must be this server's own (stops DNS rebinding, where a
 *    hostile domain is pointed at 127.0.0.1);
 *  - API calls must carry the `x-cold: 1` header, which a page on another
 *    origin can only send after a CORS preflight this server never grants;
 *  - an Origin header, when present, must be this server's.
 *
 * Returns why a request is refused, or undefined when it may proceed. Pure.
 */
export function refuseRequest(request: Request, allowedHosts: readonly string[]): string | undefined {
  const host = request.headers.get("host") ?? "";
  if (!allowedHosts.includes(host)) return "cold only answers on localhost";
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/api/")) return undefined;
  if (request.headers.get("x-cold") !== "1") return "missing the x-cold header";
  const origin = request.headers.get("origin");
  if (origin && origin !== `http://${host}`) return "cross-origin requests are not allowed";
  return undefined;
}

/** The hosts this server answers to. */
export const localHosts = (port: number) => [`127.0.0.1:${port}`, `localhost:${port}`] as const;
