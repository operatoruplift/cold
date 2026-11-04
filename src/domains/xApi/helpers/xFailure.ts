import { XApiError } from "../types";

/** What cold was doing when X said no, for the words of the error. */
export type XDoing = "connect" | "refresh" | "send" | "lookup" | "read";

/** What X said went wrong: v2 problem details, OAuth errors, or the older errors list. Pure. */
export function xErrorText(body: unknown): string {
  if (!body || typeof body !== "object") return typeof body === "string" ? body.slice(0, 200).trim() : "";
  const b = body as { detail?: unknown; title?: unknown; error_description?: unknown; error?: unknown; errors?: Array<{ message?: unknown; detail?: unknown }> };
  const first = b.errors?.[0];
  const text = b.detail ?? b.error_description ?? first?.detail ?? first?.message ?? (typeof b.error === "string" ? b.error : undefined) ?? b.title;
  return typeof text === "string" ? text.trim() : "";
}

/** The app's plan or setup, not the person: X's words for these. */
const APP_PROBLEM = /subset of|not enrolled|client-not-enrolled|attached to a project|app permissions|access level|not configured|upgrade|453/i;

/**
 * X's answer as an XApiError that says what to do next. `resetHeader` is
 * x-rate-limit-reset (epoch seconds) on a 429. Pure.
 */
export function xFailure(input: { status: number; body: unknown; doing: XDoing; resetHeader?: string | null }): XApiError {
  const { status, doing } = input;
  const said = xErrorText(input.body);
  const quoted = said ? ` X said: "${said}"` : "";

  if (status === 429) {
    const reset = Number(input.resetHeader);
    const retryAt = input.resetHeader && Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined;
    const when = retryAt ? `after ${retryAt.toISOString().slice(11, 16)} UTC` : "in 15 minutes";
    return new XApiError("rateLimited", `X's limit for this is used up for now: try again ${when}.`, status, retryAt);
  }
  if (doing === "connect" || doing === "refresh") {
    if (/invalid_client|unauthorized_client/i.test(said) || status === 401)
      return new XApiError("access", `X does not accept the app's keys: check X_CLIENT_ID and X_CLIENT_SECRET in Settings against your app at developer.x.com.${quoted}`, status);
    if (doing === "refresh") return new XApiError("auth", `X would not renew the sign-in: connect X again in Settings.${quoted}`, status);
    return new XApiError("auth", `X refused the sign-in (it may have taken too long): press Connect X again.${quoted}`, status);
  }
  if (status === 401) return new XApiError("auth", `X no longer accepts this sign-in: connect X again in Settings.${quoted}`, status);
  if (status === 403 && APP_PROBLEM.test(said))
    return new XApiError("access", `Your X developer app can't do this yet: its plan or permissions don't include it. Check the app at developer.x.com.${quoted}`, status);
  if (status === 403 && doing === "send")
    return new XApiError("cannotDm", `X won't deliver a DM from you to them: their messages are closed to you. Skip them, or reach them on another channel.${quoted}`, status);
  if (status === 403) return new XApiError("access", `X refused this for your account or app.${quoted}`, status);
  if (status === 404) return new XApiError("notFound", `X has no such account.${quoted}`, status);
  if (status >= 500) return new XApiError("other", `X had a problem on its side (HTTP ${status}): try again in a minute.`, status);
  return new XApiError("other", `X answered HTTP ${status}.${quoted}`, status);
}
