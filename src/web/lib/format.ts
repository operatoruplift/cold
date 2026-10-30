import type { Platform, Voice } from "../../domains/messages/types";

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const PLATFORM_LABEL: Record<Platform, string> = { linkedin: "LinkedIn", x: "X", instagram: "Instagram", facebook: "Facebook" };

/** "email/personal/founder-direct" -> "founder-direct" */
export const sequenceName = (id: string) => id.split("/").pop() ?? id;

export const voiceLabel = (voice: Voice) => (voice === "personal" ? "Personal" : "Company");

export function channelLabel(channel: string, platform?: Platform): string {
  if (channel === "email") return "Email";
  if (channel === "call") return "Call";
  return platform ? `${PLATFORM_LABEL[platform]} DM` : "DM";
}

/** "2026-11-02T15:00:00Z" -> "Nov 2, 9:00 AM" in the browser's time zone. */
export function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "2026-11-05" -> "Thu, Nov 5". */
export function day(isoDay: string): string {
  const [y, m, d] = isoDay.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export const percent = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : "-");

export function sourceLabel(source: string): string {
  if (source.startsWith("csv:")) return source.slice(4).split("/").pop() ?? source;
  return { "twenty:people": "Twenty: People", "twenty:agencyProspects": "Twenty: dialer prospects", "twenty:agencyPeople": "Twenty: people at dialer prospects" }[source] ?? source;
}
