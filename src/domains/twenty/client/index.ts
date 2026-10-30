/**
 * A small Twenty client: REST for records, GraphQL for metadata.
 *
 * Twenty allows an API key 100 requests a minute and caps a page at 200
 * records, so every request waits for a slot in a sliding one-minute window
 * (TWENTY_REQUESTS_PER_MINUTE, default 90) and is retried on 429, and every
 * list is a keyset walk over id (order_by=id[AscNullsFirst], filter=id[gt]:last):
 * it works on builds that ignore cursors. The REST sort parameter is
 * order_by; Twenty ignores orderBy.
 */

export interface TwentyConfig {
  baseUrl: string;
  apiKey: string;
}

export type TwentyRecord = Record<string, unknown> & { id: string };

export class TwentyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "TwentyError";
  }
}

/** TWENTY_BASE_URL and TWENTY_API_KEY, or undefined when either is missing. */
export function twentyConfigFromEnv(env: Record<string, string | undefined> = process.env): TwentyConfig | undefined {
  const baseUrl = env.TWENTY_BASE_URL?.trim().replace(/\/+$/, "");
  const apiKey = env.TWENTY_API_KEY?.trim();
  return baseUrl && apiKey ? { baseUrl, apiKey } : undefined;
}

const PAGE = 200;
const WINDOW_MS = 60_000;
const budget = () => Math.max(1, Number(process.env.TWENTY_REQUESTS_PER_MINUTE) || 90);
const sent: number[] = [];
let gate: Promise<void> = Promise.resolve();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for a slot under the per-minute budget. Slots are handed out in order. */
function slot(): Promise<void> {
  const next = gate.then(async () => {
    for (;;) {
      const now = Date.now();
      while (sent.length && now - sent[0]! >= WINDOW_MS) sent.shift();
      if (sent.length < budget()) {
        sent.push(now);
        return;
      }
      await sleep(WINDOW_MS - (now - sent[sent.length - budget()]!) + 5);
    }
  });
  gate = next.catch(() => {});
  return next;
}

/** Quote a value for a REST filter. Quotes inside the value are dropped. */
export const filterValue = (value: string) => `"${value.replace(/"/g, "")}"`;

/** `field[in]:["a","b"]` */
export const filterIn = (field: string, values: string[]) => `${field}[in]:[${values.map(filterValue).join(",")}]`;

/** Join filters with and(...), skipping empty ones. */
export function filterAnd(...parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((p): p is string => !!p);
  if (present.length <= 1) return present[0];
  return `and(${present.join(",")})`;
}

function firstArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (Array.isArray(v.edges)) return v.edges.map((e) => (e as { node?: unknown })?.node).filter(Boolean);
  for (const child of Object.values(v)) if (Array.isArray(child)) return child;
  return undefined;
}

/** Records from a list response: { data: { people: [...] } } or close variants. */
export function unwrapList(json: unknown, plural: string): TwentyRecord[] {
  const data = (json as { data?: unknown })?.data;
  const direct = (data as Record<string, unknown> | undefined)?.[plural];
  return ((Array.isArray(direct) ? direct : firstArray(data)) ?? []) as TwentyRecord[];
}

/** The record from a create/update/get response: { data: { createPerson: {...} } } or close variants. */
export function unwrapItem(json: unknown): TwentyRecord {
  const data = (json as { data?: unknown })?.data ?? json;
  if (data && typeof data === "object") {
    if ("id" in data) return data as TwentyRecord;
    for (const child of Object.values(data as Record<string, unknown>)) {
      if (child && typeof child === "object" && "id" in child) return child as TwentyRecord;
    }
  }
  throw new TwentyError(500, "Twenty answered without a record");
}

function describeFailure(status: number, body: string): string {
  try {
    const json = JSON.parse(body) as { messages?: string[]; message?: string; error?: string; errors?: Array<{ message?: string }> };
    const detail = json.messages?.join("; ") || json.message || json.errors?.map((e) => e.message).join("; ") || json.error;
    if (detail) return `${status} ${detail}`;
  } catch {
    // not JSON
  }
  return `${status} ${body.slice(0, 300)}`;
}

export class TwentyClient {
  constructor(
    readonly config: TwentyConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(method: string, pathAndQuery: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      await slot();
      const response = await this.fetchImpl(`${this.config.baseUrl}${pathAndQuery}`, {
        method,
        headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429 && attempt < 4) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        const hint = response.status === 401 ? " (check TWENTY_API_KEY)" : response.status === 404 ? " (is the object created? run bun run twenty:schema)" : "";
        throw new TwentyError(response.status, `Twenty ${method} ${pathAndQuery.split("?")[0]}: ${describeFailure(response.status, text)}${hint}`);
      }
      return text ? JSON.parse(text) : {};
    }
  }

  /** Every record matching the filter (up to `limit`), walked 200 at a time by id. */
  async list(plural: string, options: { filter?: string; limit?: number } = {}): Promise<TwentyRecord[]> {
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const out: TwentyRecord[] = [];
    let lastId: string | undefined;
    for (let page = 0; page < 1000 && out.length < limit; page++) {
      const size = Math.min(PAGE, limit - out.length);
      const params = new URLSearchParams({ limit: String(size), order_by: "id[AscNullsFirst]", depth: "0" });
      const filter = filterAnd(options.filter, lastId ? `id[gt]:${filterValue(lastId)}` : undefined);
      if (filter) params.set("filter", filter);
      const rows = unwrapList(await this.request("GET", `/rest/${plural}?${params}`), plural);
      out.push(...rows);
      if (rows.length < size) break;
      lastId = rows[rows.length - 1]!.id;
    }
    return out;
  }

  /** Records by id, in chunks. */
  async getMany(plural: string, ids: string[]): Promise<TwentyRecord[]> {
    const unique = [...new Set(ids.filter(Boolean))];
    const out: TwentyRecord[] = [];
    for (let i = 0; i < unique.length; i += 50) out.push(...(await this.list(plural, { filter: filterIn("id", unique.slice(i, i + 50)) })));
    return out;
  }

  async create(plural: string, data: Record<string, unknown>): Promise<TwentyRecord> {
    return unwrapItem(await this.request("POST", `/rest/${plural}`, data));
  }

  async update(plural: string, id: string, data: Record<string, unknown>): Promise<TwentyRecord> {
    return unwrapItem(await this.request("PATCH", `/rest/${plural}/${encodeURIComponent(id)}`, data));
  }

  /** One GraphQL document against /metadata. Resolves to `data`; throws on errors. */
  async metadata<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const json = (await this.request("POST", "/metadata", { query, variables })) as { data?: T; errors?: Array<{ message?: string }> };
    if (json.errors?.length) throw new TwentyError(400, json.errors.map((e) => e.message).join("; ").slice(0, 500));
    return json.data as T;
  }
}
