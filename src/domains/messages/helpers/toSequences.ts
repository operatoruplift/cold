import type { Message, Sequence } from "../types";

/** Group step messages into sequences, ordered by id, steps ordered by step. Pure. */
export function toSequences(messages: Message[]): Sequence[] {
  const groups = new Map<string, Message[]>();
  for (const m of messages) {
    if (!m.sequence) continue;
    groups.set(m.sequence, [...(groups.get(m.sequence) ?? []), m]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, steps]) => {
      const sorted = [...steps].sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
      const first = sorted[0]!;
      return { id, channel: first.channel as Sequence["channel"], voice: first.voice, platform: first.platform, steps: sorted };
    });
}
