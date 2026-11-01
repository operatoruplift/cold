import { syncCallOutcomes, type CallOutcomeSync } from "../../call";
import { claimRun, type Db } from "../../db";
import type { TwentyClient } from "../../twenty";
import type { WebContext } from "../context";

const KEY = "calls_logged_at";
/** The dialer's calls are logged this often in the background. */
export const CALL_LOG_EVERY_MS = 10 * 60_000;
/** A run by hand waits this long after any other. */
const BY_HAND_MS = 20_000;

/**
 * Logs the dialer's calls into the touch log: in the background every ten
 * minutes across every server on the database (the run is claimed in it), or
 * now, by hand. Each call is logged once, however often this runs.
 */
export class CallLog {
  private nextAt = 0;

  constructor(
    private readonly ctx: WebContext,
    private readonly db: Db,
  ) {}

  /** The background run: skipped without Twenty, or when any server ran it in the last ten minutes. */
  async tick(): Promise<CallOutcomeSync | undefined> {
    const client = this.ctx.twenty();
    if (!client) return undefined;
    const now = this.ctx.now();
    if (now.getTime() < this.nextAt) return undefined;
    this.nextAt = now.getTime() + CALL_LOG_EVERY_MS - 5000;
    if (!(await claimRun(this.db, KEY, now, CALL_LOG_EVERY_MS - 5000))) return undefined;
    return this.sync(client, now, false);
  }

  /** A run now, from the Calls page or the MCP. Says why when it can't run. */
  async run(dryRun: boolean): Promise<{ sync?: CallOutcomeSync; refused?: string }> {
    const client = this.ctx.twenty();
    if (!client) return { refused: "Connect Twenty in Settings first: the dialer keeps its calls there." };
    const now = this.ctx.now();
    if (!dryRun && !(await claimRun(this.db, KEY, now, BY_HAND_MS))) return { refused: "Calls were logged a moment ago: try again in a few seconds." };
    return { sync: await this.sync(client, now, dryRun) };
  }

  private async sync(client: TwentyClient, now: Date, dryRun: boolean): Promise<CallOutcomeSync> {
    const store = await this.ctx.store(await this.ctx.requireConfig());
    return syncCallOutcomes({ client, store, now, dryRun });
  }
}

/** One line in the server's log when a background run logged calls. */
export function logCallSync(sync: CallOutcomeSync | undefined): void {
  if (sync?.logged.length) console.log(`calls: logged ${sync.logged.length} from the dialer${sync.pending ? `, ${sync.pending} still settling` : ""}`);
}
