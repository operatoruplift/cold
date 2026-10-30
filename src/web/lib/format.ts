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

/** "3 days ago", "just now": for things that happened recently. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const units: Array<[number, string]> = [[60, "minute"], [3600, "hour"], [86400, "day"], [604800, "week"]];
  let chosen: [number, string] = units[0]!;
  for (const unit of units) if (seconds >= unit[0]) chosen = unit;
  if (seconds >= 30 * 86400) return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const n = Math.floor(seconds / chosen[0]);
  return `${n} ${chosen[1]}${n === 1 ? "" : "s"} ago`;
}

/** Save text as a file, from the browser. */
export function download(filename: string, text: string, type = "text/plain"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
