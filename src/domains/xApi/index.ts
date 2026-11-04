import type { Db } from "../db";
import { seal, unseal } from "../storage";
import { authorizeUrl, codeChallenge, randomToken, repliesIn, xFailure, type AwaitingOnX, type XDoing } from "./helpers";
import { X_API, X_REFRESH_EARLY_MS, X_REVOKE_URL, X_STATE_TTL_MS, X_TOKEN_URL, XApiError, type XApp, type XConnection, type XDmEvent, type XFetch, type XTokens, type XUser } from "./types";

export * from "./types";
export * from "./helpers";

/** The owner's X developer app, from X_CLIENT_ID (and X_CLIENT_SECRET for a confidential client). Undefined until it is set. */
export function xAppFromEnv(env: Record<string, string | undefined> = process.env): XApp | undefined {
  const clientId = env.X_CLIENT_ID?.trim();
  if (!clientId) return undefined;
  return { clientId, clientSecret: env.X_CLIENT_SECRET?.trim() || undefined };
}

async function bodyOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type RawEvent = { id: string; text?: string; sender_id?: string; created_at?: string; dm_conversation_id?: string };

/** X's API as cold uses it. Each call takes the access token it acts with. */
export class XClient {
  constructor(
    readonly app: XApp,
    private readonly fetchImpl: XFetch = (input, init) => fetch(input, init),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async token(params: Record<string, string>, doing: XDoing): Promise<XTokens> {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (this.app.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.app.clientId)}:${encodeURIComponent(this.app.clientSecret)}`).toString("base64")}`;
    const response = await this.fetchImpl(X_TOKEN_URL, { method: "POST", headers, body: new URLSearchParams({ ...params, client_id: this.app.clientId }).toString() });
    const body = await bodyOf(response);
    if (!response.ok) throw xFailure({ status: response.status, body, doing, resetHeader: response.headers.get("x-rate-limit-reset") });
    const t = body as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!t.access_token) throw new XApiError("other", "X answered without an access token: press Connect X again.", response.status);
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: new Date(this.now().getTime() + (t.expires_in ?? 7200) * 1000).toISOString(), scope: t.scope ?? "" };
  }

  /** The code X sent back, traded for tokens (PKCE: with the verifier its challenge came from). */
  exchangeCode(code: string, verifier: string, redirectUri: string): Promise<XTokens> {
    return this.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }, "connect");
  }

  refresh(refreshToken: string): Promise<XTokens> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken }, "refresh");
  }

  /** Tell X to forget a token. Best effort: disconnecting goes ahead either way. */
  async revoke(token: string): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (this.app.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.app.clientId)}:${encodeURIComponent(this.app.clientSecret)}`).toString("base64")}`;
    await this.fetchImpl(X_REVOKE_URL, { method: "POST", headers, body: new URLSearchParams({ token, token_type_hint: "access_token", client_id: this.app.clientId }).toString() }).catch(() => undefined);
  }

  private async call<T>(accessToken: string, path: string, doing: XDoing, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
    if (init.body) headers["content-type"] = "application/json";
    const response = await this.fetchImpl(`${X_API}${path}`, { ...init, headers });
    const body = await bodyOf(response);
    if (!response.ok) throw xFailure({ status: response.status, body, doing, resetHeader: response.headers.get("x-rate-limit-reset") });
    return body as T;
  }

  /** The account a token belongs to. */
  async me(accessToken: string): Promise<XUser> {
    const { data } = await this.call<{ data?: XUser }>(accessToken, "/2/users/me", "lookup");
    if (!data?.id) throw new XApiError("other", "X did not say which account signed in: press Connect X again.", 200);
    return { id: data.id, username: data.username, name: data.name };
  }

  /** A person's X user id, from their handle. */
  async userByHandle(accessToken: string, handle: string): Promise<XUser> {
    const body = await this.call<{ data?: XUser }>(accessToken, `/2/users/by/username/${encodeURIComponent(handle)}`, "lookup");
    if (!body.data?.id) throw new XApiError("notFound", `X has no account @${handle} (renamed, suspended or deleted): fix the handle in the list, or skip them.`, 404);
    return { id: body.data.id, username: body.data.username, name: body.data.name };
  }

  /** Send one DM. X answers 201 with the message's event id. */
  async sendDm(accessToken: string, participantId: string, text: string): Promise<{ eventId: string; conversationId?: string }> {
    const body = await this.call<{ data?: { dm_event_id?: string; dm_conversation_id?: string } }>(accessToken, `/2/dm_conversations/with/${encodeURIComponent(participantId)}/messages`, "send", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    return { eventId: body.data?.dm_event_id ?? "", conversationId: body.data?.dm_conversation_id };
  }

  /** DM messages, newest first, up to `limit` (X keeps 30 days). With a participant, only that conversation. */
  async dmEvents(accessToken: string, options: { participantId?: string; limit?: number } = {}): Promise<XDmEvent[]> {
    const path = options.participantId ? `/2/dm_conversations/with/${encodeURIComponent(options.participantId)}/dm_events` : "/2/dm_events";
    const limit = options.limit ?? 300;
    const out: XDmEvent[] = [];
    let next: string | undefined;
    do {
      const params = new URLSearchParams({ event_types: "MessageCreate", "dm_event.fields": "id,text,sender_id,created_at,dm_conversation_id", max_results: "100" });
      if (next) params.set("pagination_token", next);
      const body = await this.call<{ data?: RawEvent[]; meta?: { next_token?: string } }>(accessToken, `${path}?${params}`, "read");
      for (const e of body.data ?? []) if (e.sender_id && e.created_at) out.push({ id: e.id, text: e.text ?? "", senderId: e.sender_id, createdAt: e.created_at, conversationId: e.dm_conversation_id });
      next = body.meta?.next_token;
    } while (next && out.length < limit);
    return out;
  }
}

/** One step of one sequence to one person, sent through X once. */
export interface XSendKey {
  account: string;
  prospectKey: string;
  sequence: string;
  step: number;
}

/**
 * X connections, Connect X attempts, handle lookups and sends, in the app's
 * database. Tokens are sealed with COLD_SECRET_KEY when it is set. Without
 * it they are kept as they are, which is only allowed on your own computer
 * (where .env.local holds your other keys the same way); a hosted server
 * refuses.
 */
export class XStore {
  constructor(
    private readonly db: Db,
    private readonly options: { key?: Buffer; requireKey: boolean; now: () => Date; random?: (bytes: number) => Uint8Array },
  ) {}

  private pack(account: string, tokens: XTokens): string {
    const text = JSON.stringify(tokens);
    if (this.options.key) return seal(this.options.key, `x:${account}`, text);
    if (this.options.requireKey) throw new XApiError("access", "Keeping an X sign-in on this server needs COLD_SECRET_KEY in its environment, so it is stored encrypted. Add it, redeploy, and connect X again.", 409);
    return `plain:${text}`;
  }

  private unpack(account: string, stored: string): XTokens {
    if (stored.startsWith("plain:")) return JSON.parse(stored.slice("plain:".length)) as XTokens;
    if (!this.options.key) throw new XApiError("auth", "The X sign-in is stored encrypted and COLD_SECRET_KEY is not set: set it as it was, or connect X again.", 401);
    return JSON.parse(unseal(this.options.key, `x:${account}`, stored)) as XTokens;
  }

  /** Start Connect X for an account: a state and a code verifier, kept for ten minutes. */
  async begin(account: string, redirectUri: string): Promise<{ state: string; verifier: string }> {
    const state = randomToken(this.options.random);
    const verifier = randomToken(this.options.random);
    const now = this.options.now();
    await this.db.batch([
      ["DELETE FROM x_oauth_states WHERE created_at < ?", new Date(now.getTime() - X_STATE_TTL_MS).toISOString()],
      ["INSERT INTO x_oauth_states (state, account, verifier, redirect_uri, created_at) VALUES (?, ?, ?, ?, ?)", state, account, verifier, redirectUri, now.toISOString()],
    ]);
    return { state, verifier };
  }

  /** The Connect X attempt a state belongs to, once: reading it deletes it. Undefined when unknown or over ten minutes old. */
  async take(state: string): Promise<{ account: string; verifier: string; redirectUri: string } | undefined> {
    const row = await this.db.get<{ account: string; verifier: string; redirect_uri: string; created_at: string }>("SELECT account, verifier, redirect_uri, created_at FROM x_oauth_states WHERE state = ?", state);
    if (!row) return undefined;
    const { changes } = await this.db.run("DELETE FROM x_oauth_states WHERE state = ?", state);
    if (!changes || this.options.now().getTime() - Date.parse(row.created_at) > X_STATE_TTL_MS) return undefined;
    return { account: row.account, verifier: row.verifier, redirectUri: row.redirect_uri };
  }

  async save(connection: XConnection): Promise<void> {
    await this.db.run(
      "INSERT INTO x_connections (account, user_id, username, tokens, connected_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (account) DO UPDATE SET user_id = excluded.user_id, username = excluded.username, tokens = excluded.tokens, connected_at = excluded.connected_at, updated_at = excluded.updated_at",
      connection.account,
      connection.userId,
      connection.username,
      this.pack(connection.account, connection.tokens),
      connection.connectedAt,
      this.options.now().toISOString(),
    );
  }

  async saveTokens(account: string, tokens: XTokens): Promise<void> {
    await this.db.run("UPDATE x_connections SET tokens = ?, updated_at = ? WHERE account = ?", this.pack(account, tokens), this.options.now().toISOString(), account);
  }

  async get(account: string): Promise<XConnection | undefined> {
    const row = await this.db.get<{ account: string; user_id: string; username: string; tokens: string; connected_at: string }>("SELECT account, user_id, username, tokens, connected_at FROM x_connections WHERE account = ?", account);
    if (!row) return undefined;
    return { account: row.account, userId: row.user_id, username: row.username, tokens: this.unpack(row.account, row.tokens), connectedAt: row.connected_at };
  }

  /** Who each account is connected as, without the tokens. */
  async accounts(): Promise<Array<{ account: string; username: string; connectedAt: string }>> {
    return (await this.db.all<{ account: string; username: string; connected_at: string }>("SELECT account, username, connected_at FROM x_connections ORDER BY account")).map((r) => ({ account: r.account, username: r.username, connectedAt: r.connected_at }));
  }

  async remove(account: string): Promise<XConnection | undefined> {
    const connection = await this.get(account).catch(() => undefined);
    await this.db.run("DELETE FROM x_connections WHERE account = ?", account);
    return connection;
  }

  async cachedUserId(handle: string): Promise<string | undefined> {
    return (await this.db.get<{ user_id: string }>("SELECT user_id FROM x_users WHERE handle = ?", handle.toLowerCase()))?.user_id;
  }

  async rememberUser(handle: string, userId: string): Promise<void> {
    await this.db.run(
      "INSERT INTO x_users (handle, user_id, updated_at) VALUES (?, ?, ?) ON CONFLICT (handle) DO UPDATE SET user_id = excluded.user_id, updated_at = excluded.updated_at",
      handle.toLowerCase(),
      userId,
      this.options.now().toISOString(),
    );
  }

  /**
   * Claim one send so it goes out once, even after two clicks or on two
   * servers. Undefined when it is claimed; otherwise what already holds it.
   */
  async claim(key: XSendKey): Promise<{ status: string; eventId?: string; at: string } | undefined> {
    const args = [key.account, key.prospectKey, key.sequence, key.step] as const;
    const { changes } = await this.db.run(
      "INSERT INTO x_sends (account, prospect_key, sequence, step, status, created_at) VALUES (?, ?, ?, ?, 'SENDING', ?) ON CONFLICT DO NOTHING",
      ...args,
      this.options.now().toISOString(),
    );
    if (changes) return undefined;
    const row = await this.db.get<{ status: string; event_id: string | null; created_at: string }>("SELECT status, event_id, created_at FROM x_sends WHERE account = ? AND prospect_key = ? AND sequence = ? AND step = ?", ...args);
    return { status: row?.status ?? "SENDING", eventId: row?.event_id ?? undefined, at: row?.created_at ?? "" };
  }

  async markSent(key: XSendKey, eventId: string): Promise<void> {
    await this.db.run("UPDATE x_sends SET status = 'SENT', event_id = ? WHERE account = ? AND prospect_key = ? AND sequence = ? AND step = ?", eventId, key.account, key.prospectKey, key.sequence, key.step);
  }

  /** X refused, so nothing went out: the step can be tried again. */
  async release(key: XSendKey): Promise<void> {
    await this.db.run("DELETE FROM x_sends WHERE account = ? AND prospect_key = ? AND sequence = ? AND step = ? AND status = 'SENDING'", key.account, key.prospectKey, key.sequence, key.step);
  }
}

/** A good access token for an account, renewed when it is about to run out (or when `force`). */
export async function accessTokenFor(store: XStore, client: XClient, account: string, now: () => Date, force = false): Promise<{ token: string; connection: XConnection }> {
  const connection = await store.get(account);
  if (!connection) throw new XApiError("auth", `Account ${account} is not connected to X: connect it in Settings.`, 401);
  const expiring = Date.parse(connection.tokens.expiresAt) - now().getTime() < X_REFRESH_EARLY_MS;
  if (!force && !expiring) return { token: connection.tokens.accessToken, connection };
  if (!connection.tokens.refreshToken) throw new XApiError("auth", "The X sign-in has run out and cannot be renewed: connect X again in Settings.", 401);
  const fresh = await client.refresh(connection.tokens.refreshToken);
  const tokens = { ...fresh, refreshToken: fresh.refreshToken ?? connection.tokens.refreshToken };
  await store.saveTokens(account, tokens);
  return { token: tokens.accessToken, connection: { ...connection, tokens } };
}

/** Run a call with the account's token. When X says the token is no good, renew it once and try again (a refused call sent nothing). */
export async function withXToken<T>(store: XStore, client: XClient, account: string, now: () => Date, call: (token: string, connection: XConnection) => Promise<T>): Promise<T> {
  const first = await accessTokenFor(store, client, account, now);
  try {
    return await call(first.token, first.connection);
  } catch (err) {
    if (!(err instanceof XApiError) || err.kind !== "auth" || !first.connection.tokens.refreshToken) throw err;
    const again = await accessTokenFor(store, client, account, now, true);
    return call(again.token, again.connection);
  }
}

/** A person's X user id: remembered from before, or looked up once. */
export async function xUserIdOf(store: XStore, client: XClient, token: string, handle: string): Promise<string> {
  const known = await store.cachedUserId(handle);
  if (known) return known;
  const user = await client.userByHandle(token, handle);
  await store.rememberUser(handle, user.id);
  return user.id;
}

/** Start Connect X: the page on X to send the owner to. */
export async function connectUrl(store: XStore, app: XApp, account: string, redirectUri: string): Promise<string> {
  const { state, verifier } = await store.begin(account, redirectUri);
  return authorizeUrl({ clientId: app.clientId, redirectUri, state, challenge: await codeChallenge(verifier) });
}

/** Finish Connect X: trade the code for tokens and keep them with the account they belong to. */
export async function finishConnect(store: XStore, client: XClient, input: { state: string; code: string }, now: () => Date): Promise<XConnection> {
  const attempt = await store.take(input.state);
  if (!attempt) throw new XApiError("auth", "That Connect X link is used or more than ten minutes old: press Connect X again.", 400);
  const tokens = await client.exchangeCode(input.code, attempt.verifier, attempt.redirectUri);
  const me = await client.me(tokens.accessToken);
  const connection: XConnection = { account: attempt.account, userId: me.id, username: me.username, tokens, connectedAt: now().toISOString() };
  await store.save(connection);
  return connection;
}

/** The first answer on X from each person an account is waiting on. */
export async function xReplies(input: { store: XStore; client: XClient; account: string; now: () => Date; awaiting: ReadonlyMap<string, AwaitingOnX>; logged: ReadonlySet<string>; participantId?: string }): Promise<XDmEvent[]> {
  return withXToken(input.store, input.client, input.account, input.now, async (token, connection) => {
    const events = await input.client.dmEvents(token, { participantId: input.participantId, limit: input.participantId ? 100 : 300 });
    return repliesIn(events, { me: connection.userId, awaiting: input.awaiting, logged: input.logged });
  });
}
