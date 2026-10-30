import { localHosts } from "../guard";

export interface ServerSettings {
  /** local: this computer only. hosted: a server people reach at COLD_PUBLIC_URL. */
  mode: "local" | "hosted";
  hostname: string;
  port: number;
  /** Where people open the app: http://localhost:4100, or https://cold.example.com. */
  publicUrl: URL;
  /** Host headers answered. */
  hosts: string[];
  /** Origin headers accepted on API calls. */
  origins: string[];
  /** Session cookies only travel over HTTPS. */
  secureCookies: boolean;
  /** Read the client address from X-Forwarded-For (set by the host's proxy). */
  trustProxy: boolean;
}

/**
 * Local by default: 127.0.0.1 only, answering to localhost. COLD_PUBLIC_URL
 * makes it a hosted server: it listens on every interface (or COLD_HOST),
 * answers to that URL's host name, and marks cookies Secure when it is HTTPS.
 * PORT (set by most hosts) or COLD_UI_PORT picks the port. On Railway,
 * Render and Fly the public URL is known without COLD_PUBLIC_URL.
 */
export function serverSettings(env: Record<string, string | undefined> = process.env): ServerSettings {
  const port = Number(env.PORT || env.COLD_UI_PORT) || 4100;
  const local = [...localHosts(port)];
  const publicUrl = publicUrlFrom(env);
  if (!publicUrl) {
    if (env.COLD_REQUIRE_PUBLIC_URL === "1") throw new Error("Set COLD_PUBLIC_URL to the address people will open, e.g. https://cold.example.com");
    return {
      mode: "local",
      hostname: env.COLD_HOST || "127.0.0.1",
      port,
      publicUrl: new URL(`http://localhost:${port}`),
      hosts: local,
      origins: local.map((h) => `http://${h}`),
      secureCookies: false,
      trustProxy: false,
    };
  }
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new Error(`COLD_PUBLIC_URL is not a URL: ${publicUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("COLD_PUBLIC_URL must start with https:// (or http://)");
  const extra = (env.COLD_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return {
    mode: "hosted",
    hostname: env.COLD_HOST || "0.0.0.0",
    port,
    publicUrl: new URL(url.origin),
    hosts: [url.host, ...extra, ...local],
    origins: [url.origin, ...extra.map((h) => `${url.protocol}//${h}`), ...local.map((h) => `http://${h}`)],
    secureCookies: url.protocol === "https:",
    trustProxy: env.COLD_TRUST_PROXY !== "0",
  };
}

/** COLD_PUBLIC_URL, or the address a known host gives the app. */
function publicUrlFrom(env: Record<string, string | undefined>): string | undefined {
  const explicit = env.COLD_PUBLIC_URL?.trim();
  if (explicit) return explicit;
  if (env.RENDER_EXTERNAL_URL) return env.RENDER_EXTERNAL_URL;
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  if (env.FLY_APP_NAME) return `https://${env.FLY_APP_NAME}.fly.dev`;
  return undefined;
}
