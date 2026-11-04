/**
 * X's official API (v2), the only way cold sends a DM: from the owner's own
 * account, one approved message per click, through an X developer app the
 * owner registers. Every endpoint cold calls is here, so a change on X's side
 * is one edit.
 */
export const X_API = "https://api.x.com";
export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_TOKEN_URL = `${X_API}/2/oauth2/token`;
export const X_REVOKE_URL = `${X_API}/2/oauth2/revoke`;

/** What cold asks X for: read and write DMs, read profiles, and stay connected (a refresh token). */
export const X_SCOPES = ["dm.read", "dm.write", "tweet.read", "users.read", "offline.access"] as const;

/** How long a Connect X link stays usable. */
export const X_STATE_TTL_MS = 10 * 60_000;

/** Refresh an access token this long before it runs out. */
export const X_REFRESH_EARLY_MS = 60_000;

/** The owner's X developer app (developer.x.com): OAuth 2.0, type "Web App" (confidential) or "Native App" (public). */
export interface XApp {
  clientId: string;
  /** Only for a confidential client. */
  clientSecret?: string;
}

export interface XTokens {
  accessToken: string;
  refreshToken?: string;
  /** ISO time the access token stops working. */
  expiresAt: string;
  scope: string;
}

/** A cold.yaml account connected to an X account. */
export interface XConnection {
  account: string;
  userId: string;
  username: string;
  tokens: XTokens;
  connectedAt: string;
}

export interface XUser {
  id: string;
  username: string;
  name?: string;
}

export interface XDmEvent {
  id: string;
  text: string;
  senderId: string;
  createdAt: string;
  conversationId?: string;
}

/**
 * Why a call to X failed, in the terms cold acts on:
 *   auth         the token is no good: refresh it, or reconnect X
 *   cannotDm     X will not deliver a DM from you to this person
 *   rateLimited  wait until retryAt
 *   notFound     no such user
 *   access       the developer app's plan or settings don't allow this
 *   other        anything else; the message says what X said
 */
export type XFailureKind = "auth" | "cannotDm" | "rateLimited" | "notFound" | "access" | "other";

export class XApiError extends Error {
  constructor(
    readonly kind: XFailureKind,
    message: string,
    readonly status: number,
    readonly retryAt?: Date,
  ) {
    super(message);
    this.name = "XApiError";
  }
}

/** fetch, or a fake one in tests. */
export type XFetch = (input: string, init?: RequestInit) => Promise<Response>;
