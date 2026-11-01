import { callOutcomeLines } from "../../call";
import { HttpError, json, readBody, type Route } from "../api";
import type { WebContext } from "../context";
import type { ActionResponse } from "../types";

export { CALL_LOG_EVERY_MS, CallLog, logCallSync } from "./log";

/** Calls, Log calls: the dialer's calls into the touch log now. Behind the login. */
export function callRoutes(ctx: WebContext): Route[] {
  return [
    [
      "POST",
      /^\/api\/calls\/log$/,
      async (request) => {
        const { dryRun } = await readBody<{ dryRun?: boolean }>(request);
        if (!ctx.callLog) throw new HttpError(409, "Logging calls needs the app's database.");
        const { sync, refused } = await ctx.callLog.run(!!dryRun);
        if (!sync) throw new HttpError(409, refused ?? "Calls can't be logged now.");
        const n = sync.logged.length;
        const message = dryRun
          ? `${n} call${n === 1 ? "" : "s"} from the dialer would be logged.`
          : n
            ? `Logged ${n} call${n === 1 ? "" : "s"} from the dialer.`
            : `No new calls to log${sync.known ? `: ${sync.known} already in the touch log` : ""}.`;
        const response: ActionResponse = { ok: true, message, lines: callOutcomeLines(sync) };
        return json(response);
      },
    ],
  ];
}
