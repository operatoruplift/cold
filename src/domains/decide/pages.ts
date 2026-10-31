import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Fetch } from "./types";

/** One page of a prospect's site, as text. */
export interface Page {
  url: string;
  title?: string;
  description?: string;
  text: string;
}

export interface CollectOptions {
  fetch?: Fetch;
  /** Every address a host name resolves to. Tests pass a fake. */
  resolve?: (host: string) => Promise<string[]>;
  /** The home page counts as one. */
  maxPages?: number;
  maxBytes?: number;
  /** Per page, after the HTML is turned into text. */
  maxChars?: number;
  timeoutMs?: number;
}

export interface Collected {
  pages: Page[];
  skipped: Array<{ url: string; reason: string }>;
}

/** A page that can't or shouldn't be read, with the reason in words. */
export class PageError extends Error {}

/** How COLD names itself to websites, and the name robots.txt rules can address. */
export const ROBOT = "COLD-research";
const USER_AGENT = `Mozilla/5.0 (compatible; ${ROBOT}/1.0; reads public pages for prospect research)`;

/* ---------------------------------------------------------------- addresses */

function v4Private(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** The eight 16-bit groups of an IPv6 address, or undefined when it doesn't parse. */
function v6Groups(ip: string): number[] | undefined {
  let s = ip;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : undefined;
}

function v6Private(ip: string): boolean {
  const groups = v6Groups(ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!);
  if (!groups) return true;
  const [g0, g1] = groups as [number, number];
  const embedded = (hi: number, lo: number) => v4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  if (groups.every((g) => g === 0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) return embedded(groups[6]!, groups[7]!); // mapped or compatible IPv4
  if (g0 === 0x64 && g1 === 0xff9b) return embedded(groups[6]!, groups[7]!); // NAT64
  if (g0 === 0x2002) return embedded(g1, groups[2]!); // 6to4
  if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xff00) === 0xff00) return true; // unique local, link-local, multicast
  return g0 === 0x2001 && g1 === 0x0db8; // documentation
}

/** True for an address that isn't on the public internet: loopback, private, link-local, reserved. */
export function privateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const kind = isIP(bare.split("%")[0]!);
  if (kind === 4) return v4Private(bare);
  if (kind === 6) return v6Private(bare);
  return true;
}

const LOCAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|home\.arpa)$/i;

/** A prospect's web address, checked: http(s), no login in it, a normal port, a public-looking name. */
export function checkUrl(raw: string): URL {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    throw new PageError(`"${text}" is not a web address.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new PageError(`Only http and https pages are read, not ${url.protocol}`);
  if (url.username || url.password) throw new PageError("Web addresses with a login in them are not read.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new PageError("Only the normal web ports are read.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (privateAddress(host)) throw new PageError("That address is not on the public internet.");
  } else if (!host.includes(".") || LOCAL_NAME.test(host) || /^\d+$/.test(host.split(".").pop()!)) {
    throw new PageError("That address is not on the public internet.");
  }
  url.hash = "";
  return url;
}

const resolveAll = async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Every address the name resolves to must be public, so a site can't point COLD at a private network. */
async function checkHost(url: URL, resolve: (host: string) => Promise<string[]>): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new PageError(`${host} could not be found.`);
  }
  if (!addresses.length || addresses.some(privateAddress)) throw new PageError("That address is not on the public internet.");
}

/* ---------------------------------------------------------------- fetching */

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // A huge page is cut short rather than refused: its start is what matters.
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  const charset = /charset=["']?([\w-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(all);
  } catch {
    return new TextDecoder().decode(all);
  }
}

/** GET one public page as text, following up to four redirects and checking every hop. */
export async function fetchText(start: URL, options: CollectOptions = {}): Promise<{ url: string; body: string; contentType: string }> {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const resolve = options.resolve ?? resolveAll;
  let url = start;
  for (let hop = 0; hop <= 4; hop++) {
    await checkHost(url, resolve);
    let response: Response;
    try {
      response = await doFetch(url.href, {
        redirect: "manual",
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.8" },
        signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
      });
    } catch (err) {
      const name = (err as Error).name;
      throw new PageError(name === "TimeoutError" || name === "AbortError" ? "The site took too long to answer." : "The site could not be reached.");
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel().catch(() => {});
      url = checkUrl(new URL(response.headers.get("location")!, url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new PageError(`The site answered ${response.status}.`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/html|text\/plain|xml/i.test(contentType)) {
      await response.body?.cancel().catch(() => {});
      throw new PageError("That is not a web page.");
    }
    return { url: url.href, body: await readLimited(response, options.maxBytes ?? 1_500_000), contentType };
  }
  throw new PageError("The site redirected too many times.");
}

/* ---------------------------------------------------------------- robots.txt */

function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

/** Whether robots.txt lets COLD read a path: its own group if it has one, else the * group; the longest rule wins. */
export function robotsAllows(robots: string, path: string, agent = ROBOT): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let current: (typeof groups)[number] | undefined;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      if ((key === "allow" || key === "disallow") && current) current.rules.push({ allow: key === "allow", path: value });
      lastWasAgent = false;
    }
  }
  const name = agent.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a !== "*" && name.includes(a)));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; length: number } | undefined;
  for (const rule of chosen.flatMap((g) => g.rules)) {
    if (!rule.path || !ruleMatches(rule.path, path)) continue;
    if (!best || rule.path.length > best.length || (rule.path.length === best.length && rule.allow)) best = { allow: rule.allow, length: rule.path.length };
  }
  return best?.allow ?? true;
}

/* ---------------------------------------------------------------- HTML to text */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);

/** A page's title, description, readable text, links and structured data (schema.org JSON-LD). */
export function readHtml(html: string, base: URL): { title?: string; description?: string; text: string; links: Array<{ url: string; label: string }>; data?: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim() || undefined;
  let description: string | undefined;
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = (attr(tag, "name") ?? attr(tag, "property") ?? "").toLowerCase();
    if (name === "description" || name === "og:description") {
      description = decodeEntities(attr(tag, "content") ?? "").trim() || description;
      if (name === "description" && description) break;
    }
  }
  const data = [...html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => {
      try {
        return JSON.stringify(JSON.parse(m[1]!.trim()));
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, 3000);
  const links: Array<{ url: string; label: string }> = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(m[1]!, "href");
    if (!href || /^(mailto|tel|javascript|data):/i.test(href) || href.startsWith("#")) continue;
    try {
      const url = new URL(decodeEntities(href), base);
      url.hash = "";
      links.push({ url: url.href, label: decodeEntities(m[2]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 80) });
    } catch {
      // A link that doesn't parse is skipped.
    }
  }
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?(p|div|section|article|header|footer|main|aside|nav|li|ul|ol|h[1-6]|tr|table|blockquote|dd|dt|figcaption)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line, i, all) => line && line !== all[i - 1])
    .join("\n");
  return { title, description, text, links, data: data || undefined };
}

/* ---------------------------------------------------------------- picking pages */

const WORTH_READING: Array<[RegExp, number]> = [
  [/about|our-story|who-we-are|\bstory\b/, 5],
  [/team|people|staff|leadership|founder|owner|meet/, 4],
  [/services?|what-we-do|solutions|products?|menu|treatments|offerings/, 4],
  [/careers?|jobs?|hiring|join-us|work-with-us|employment/, 4],
  [/news|blog|press|updates|announcements|events/, 3],
  [/reviews?|testimonials?|case-stud|results|clients|portfolio/, 3],
  [/pricing|prices|rates|packages|plans/, 3],
  [/locations?|contact|visit|find-us/, 1],
];
const NOT_WORTH = /privacy|terms|cookie|legal|login|log-in|sign-?in|sign-?up|register|cart|checkout|account|wp-(admin|login|json)|\/feed\b|\/tag\/|\/category\/|\/page\/\d|\.(pdf|jpe?g|png|gif|svg|webp|ico|zip|mp4|mp3|docx?|xlsx?|pptx?)$/i;

const sameSite = (a: URL, b: URL) => a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");
const pageKey = (u: URL) => `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "") || "/"}`.toLowerCase();

/** The pages of a site most worth reading for diligence, best first: about, team, services, jobs, news, reviews, pricing. */
export function rankLinks(links: Array<{ url: string; label: string }>, home: URL): string[] {
  const scored = new Map<string, { url: string; score: number }>();
  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link.url);
    } catch {
      continue;
    }
    if (!sameSite(url, home) || (url.protocol !== "https:" && url.protocol !== "http:")) continue;
    const key = pageKey(url);
    if (key === pageKey(home) || NOT_WORTH.test(url.pathname)) continue;
    const haystack = `${url.pathname} ${link.label}`.toLowerCase();
    const score = WORTH_READING.reduce((sum, [re, w]) => (re.test(haystack) ? sum + w : sum), 0) - url.pathname.split("/").filter(Boolean).length * 0.5;
    if (score <= 0) continue;
    const found = scored.get(key);
    if (!found || found.score < score) scored.set(key, { url: url.href.replace(/\?.*$/, ""), score });
  }
  return [...scored.values()].sort((a, b) => b.score - a.score).map((s) => s.url);
}

/* ---------------------------------------------------------------- a whole site */

/**
 * Read the public pages of a prospect's site worth knowing before reaching
 * out: the home page and up to five more (about, team, services, jobs, news,
 * reviews, pricing). Only public addresses, only what robots.txt allows, a
 * size and time limit on every page. A page that fails is listed, not fatal.
 */
export async function collectSite(website: string, options: CollectOptions = {}): Promise<Collected> {
  const maxPages = options.maxPages ?? 6;
  const maxChars = options.maxChars ?? 30_000;
  const skipped: Collected["skipped"] = [];
  let start: URL;
  try {
    start = checkUrl(website);
  } catch (err) {
    return { pages: [], skipped: [{ url: website, reason: (err as Error).message }] };
  }
  const robots = await fetchText(new URL("/robots.txt", start), { ...options, maxBytes: 200_000 })
    .then((r) => r.body)
    .catch(() => "");
  const allowed = (u: URL) => robotsAllows(robots, `${u.pathname}${u.search}`);
  if (!allowed(start)) return { pages: [], skipped: [{ url: start.href, reason: "The site's robots.txt asks tools like COLD not to read it." }] };

  const pages: Page[] = [];
  const read = async (url: URL): Promise<ReturnType<typeof readHtml> | undefined> => {
    try {
      const got = await fetchText(url, options);
      const final = new URL(got.url);
      const page = /html|xml/i.test(got.contentType) || /<html|<body/i.test(got.body.slice(0, 2000)) ? readHtml(got.body, final) : { text: got.body, links: [] };
      const head = "data" in page && page.data ? `Structured data: ${page.data}\n\n` : "";
      pages.push({ url: final.href, title: "title" in page ? page.title : undefined, description: "description" in page ? page.description : undefined, text: `${head}${page.text}`.slice(0, maxChars) });
      return page;
    } catch (err) {
      skipped.push({ url: url.href, reason: err instanceof PageError ? err.message : "Could not read it." });
      return undefined;
    }
  };

  const home = await read(start);
  if (!home) return { pages, skipped };
  const homeUrl = new URL(pages[0]!.url);
  for (const link of rankLinks(home.links, homeUrl)) {
    if (pages.length >= maxPages) break;
    const url = new URL(link);
    if (!allowed(url)) {
      skipped.push({ url: link, reason: "robots.txt asks not to read it." });
      continue;
    }
    await read(url);
  }
  return { pages, skipped };
}
