import { getDeadline, waitUntil } from "@vercel/functions";

/**
 * Work that carries on after the response: an AI run, the next email of a
 * send. A server on your computer simply keeps running it; on Vercel a
 * function is frozen once it answers unless it is told to wait, so the work
 * is handed to waitUntil and runs to the function's time limit.
 */
export function keepAlive(work: Promise<unknown>): void {
  waitUntil(work);
}

/** When this function has to be finished: Vercel's deadline for the request, or never on your computer. */
export function invocationDeadline(): number {
  return getDeadline()?.getTime() ?? Number.POSITIVE_INFINITY;
}
