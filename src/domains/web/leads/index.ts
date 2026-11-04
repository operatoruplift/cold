import { readNtfy, recentLeads, sendNtfy, type LeadCheck } from "../../leads";
import type { TouchStore } from "../../touches";
import { HttpError, json, type Route } from "../api";
import type { WebContext } from "../context";
import type { LeadAlertsResponse, LeadsResponse } from "../types";

/** One line in the server's log when a look for new leads pushed something or failed. */
export function logLeadCheck(check: LeadCheck | undefined): void {
  if (!check?.looked) return;
  if (check.error) console.error(`leads: ${check.error}${check.alerted ? ` (after ${check.alerted} alert${check.alerted === 1 ? "" : "s"})` : ""}`);
  else if (check.alerted) console.log(`leads: ${check.found} new, ${check.alerted} alert${check.alerted === 1 ? "" : "s"} pushed`);
}

/** Whether lead alerts are set up, without reading any leads. */
async function alertState(ctx: WebContext): Promise<LeadAlertsResponse> {
  const ntfy = readNtfy();
  const state = (await ctx.leads?.state()) ?? {};
  return { twenty: !!ctx.twenty(), alerts: { configured: !!ntfy.target, problem: ntfy.problem, available: !!ctx.leads, ...state } };
}

/** The Calls page's quiz leads, and Settings' lead alerts. Behind the login. */
export function leadRoutes(ctx: WebContext): Route[] {
  return [
    ["GET", /^\/api\/leads\/alerts$/, async () => json(await alertState(ctx))],
    [
      "GET",
      /^\/api\/leads$/,
      async (_request, _match, url) => {
        const response: LeadsResponse = { ...(await alertState(ctx)), leads: [] };
        const client = ctx.twenty();
        if (!client) return json(response);
        const days = Math.max(1, Math.min(Number(url.searchParams.get("days")) || 14, 90));
        // Called or not, and opted out or not, from the touch log; a log that can't be opened only leaves that out.
        const fromLog = async <T>(read: (store: TouchStore) => Promise<T[]>): Promise<T[]> => {
          try {
            return await read(await ctx.store(await ctx.requireConfig()));
          } catch {
            return [];
          }
        };
        try {
          response.leads = await recentLeads(client, {
            now: ctx.now(),
            days,
            hours: (await ctx.config()).config?.calls,
            calls: (since) => fromLog((store) => store.since(since, { channel: "CALL" })),
            suppressions: () => fromLog((store) => store.suppressions()),
          });
        } catch (err) {
          response.error = (err as Error).message;
        }
        return json(response);
      },
    ],
    [
      "POST",
      /^\/api\/leads\/test$/,
      async () => {
        const { target, problem } = readNtfy();
        if (!target) throw new HttpError(409, problem ?? "Set COLD_NTFY_URL in Settings first: your ntfy topic's address, e.g. https://ntfy.sh/cold-leads-7f3k2q.");
        try {
          await sendNtfy(target, { title: "COLD lead alerts work", message: "A quiz lead will look like this: who, their company, the number to call and their first answers.", tags: ["white_check_mark"], priority: 3 }, ctx.options.ntfyFetch);
        } catch (err) {
          throw new HttpError(502, `The test alert didn't go out: ${(err as Error).message}`);
        }
        return json({ ok: true, message: `Sent to ${target.topic}. If it didn't arrive, check that your phone is subscribed to that topic.` });
      },
    ],
  ];
}
