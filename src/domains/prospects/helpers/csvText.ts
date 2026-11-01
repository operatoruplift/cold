/** One CSV cell: quoted when it must be, and never read as a formula by a spreadsheet. Pure. */
export function csvCell(value: string | undefined): string {
  let s = value ?? "";
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows as CSV text with these headers, in this order. Pure. */
export const csvText = (headers: string[], rows: Array<Record<string, string | undefined>>): string =>
  [headers.map(csvCell).join(","), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(","))].join("\n") + "\n";
