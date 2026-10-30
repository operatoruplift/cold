/** Midnight today in a timezone, as an ISO timestamp: the start of "today" for daily caps. */
export function startOfDay(now: Date, timeZone?: string): string {
  if (!timeZone) {
    const local = new Date(now);
    local.setHours(0, 0, 0, 0);
    return local.toISOString();
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const elapsed = (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - elapsed).toISOString();
}
