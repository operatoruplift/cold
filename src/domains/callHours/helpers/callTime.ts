import type { CallHours, Weekday } from "../../config";
import type { CallTime, ZoneSource } from "../types";
import { prospectZones } from "./zones";

const clocks = new Map<string, Intl.DateTimeFormat>();

/** The weekday and "HH:MM" in a zone at a moment. */
function clock(zone: string, at: Date): { day: Weekday; time: string; date: string } {
  let format = clocks.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    clocks.set(zone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
  return { day: String(parts.weekday).slice(0, 3).toLowerCase() as Weekday, time: `${parts.hour}:${parts.minute}`, date: `${parts.year}-${parts.month}-${parts.day}` };
}

/** Inside calling hours in this zone at this moment. Pure. */
export function inCallHours(zone: string, at: Date, hours: CallHours): boolean {
  const { day, time } = clock(zone, at);
  return hours.days.includes(day) && time >= hours.start && time < hours.end;
}

const STEP_MS = 5 * 60_000;
const HORIZON_MS = 8 * 86_400_000;

/** The first moment from `from` that is inside calling hours in every zone; undefined when there is none within a week. Pure. */
export function nextCallTime(zones: string[], from: Date, hours: CallHours): Date | undefined {
  const end = from.getTime() + HORIZON_MS;
  for (let t = Math.ceil(from.getTime() / STEP_MS) * STEP_MS; t <= end; t += STEP_MS) {
    const at = new Date(t);
    if (zones.every((z) => inCallHours(z, at, hours))) return at;
  }
  return undefined;
}

/** "9:14 AM CST", and one per different local time when the zones differ: "10:14 AM EST / 9:14 AM CST". Pure. */
export function localTimes(zones: string[], at: Date): string {
  return [...new Set(zones.map((zone) => new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(at)))].join(" / ");
}

/** When calling opens, in their words: "8:00 AM CST", "tomorrow 8:00 AM CST" or "Mon 8:00 AM CST". */
function opensAt(zones: string[], next: Date, now: Date): string {
  const zone = zones[0]!;
  const today = clock(zone, now).date;
  const then = clock(zone, next);
  const tomorrow = clock(zone, new Date(now.getTime() + 86_400_000)).date;
  const day = then.date === today ? "" : then.date === tomorrow ? "tomorrow " : `${then.day[0]!.toUpperCase()}${then.day.slice(1)} `;
  return `${day}${localTimes(zones, next)}`;
}

const SOURCES: Record<ZoneSource, string> = { timezone: "their timezone column", phone: "their phone number", region: "their state or province", country: "their country" };

/**
 * Whether a prospect can be called now, in their own time: their local time,
 * whether it is inside calling hours in every zone they may be in, and when
 * hours open next when it isn't. Pure.
 */
export function callTime(prospect: { phone?: string; variables: Record<string, string> }, hours: CallHours, now: Date): CallTime {
  const found = prospectZones(prospect, now);
  if (!found) return { zones: [], from: [], note: "Their time zone is unknown: add their phone number with its area code, their state, or a timezone column." };
  const { zones, from } = found;
  const local = localTimes(zones, now);
  const source = from.map((f) => SOURCES[f]).join(" and ");
  if (zones.every((z) => inCallHours(z, now, hours))) return { ok: true, local, zones, from, note: `${local} their time (from ${source}).` };
  const next = nextCallTime(zones, now, hours);
  if (!next) return { ok: false, local, zones, from, note: `${local} their time, and the time zones they may be in never share calling hours: check where they are (from ${source}).` };
  return { ok: false, local, zones, from, nextAt: next.toISOString(), note: `${local} their time, outside calling hours: call from ${opensAt(zones, next, now)} (from ${source}).` };
}
