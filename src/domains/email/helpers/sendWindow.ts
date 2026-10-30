import type { SendWindow, Weekday } from "../../config";

/** Is `now` inside the window, in the window's timezone? Pure. */
export function isInWindow(now: Date, window: SendWindow): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: window.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const day = String(parts.weekday).slice(0, 3).toLowerCase() as Weekday;
  const time = `${parts.hour}:${parts.minute}`;
  return window.days.includes(day) && time >= window.start && time < window.end;
}

/** "mon-thu 08:00-17:00 America/Chicago" */
export function describeWindow(window: SendWindow): string {
  const days = window.days.length > 2 ? `${window.days[0]}-${window.days[window.days.length - 1]}` : window.days.join(",");
  return `${days} ${window.start}-${window.end} ${window.timezone}`;
}
