import { X_AUTHORIZE_URL, X_SCOPES } from "../types";

/** Bytes as base64url without padding (RFC 4648, section 5). */
export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A random URL-safe value for the PKCE code verifier or the state. 32 bytes give 43 characters. */
export function randomToken(random: (bytes: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)), bytes = 32): string {
  return base64Url(random(bytes));
}

/** The S256 code challenge of a verifier (RFC 7636). */
export async function codeChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** The page on X where the owner approves cold for their account. Pure. */
export function authorizeUrl(input: { clientId: string; redirectUri: string; state: string; challenge: string; scopes?: readonly string[] }): string {
  const url = new URL(X_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: (input.scopes ?? X_SCOPES).join(" "),
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.href;
}
