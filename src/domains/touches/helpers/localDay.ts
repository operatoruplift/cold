/** The calendar date of an instant in a timezone (the machine's when none is given), as YYYY-MM-DD. Pure. */
export function localDay(at: Date | string, timeZone?: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(typeof at === "string" ? new Date(at) : at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** A YYYY-MM-DD date plus whole days. Pure. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}
