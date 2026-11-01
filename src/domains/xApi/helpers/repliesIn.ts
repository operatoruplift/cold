import type { XDmEvent } from "../types";

/** Someone cold has DMed on X and not heard back from since. */
export interface AwaitingOnX {
  /** Their X user id. */
  userId: string;
  /** When cold's last DM to them went out (ISO). */
  sentAt: string;
}

/**
 * The first answer from each person cold is waiting on: a message they sent
 * after cold's last one, that isn't logged yet. Oldest first. Pure.
 */
export function repliesIn(events: readonly XDmEvent[], input: { me: string; awaiting: ReadonlyMap<string, AwaitingOnX>; logged: ReadonlySet<string> }): XDmEvent[] {
  const first = new Map<string, XDmEvent>();
  for (const event of [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (event.senderId === input.me || input.logged.has(event.id) || first.has(event.senderId)) continue;
    const waiting = input.awaiting.get(event.senderId);
    if (waiting && Date.parse(event.createdAt) > Date.parse(waiting.sentAt)) first.set(event.senderId, event);
  }
  return [...first.values()];
}
