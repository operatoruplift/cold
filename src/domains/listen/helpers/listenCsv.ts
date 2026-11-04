import { csvText, parseCsv } from "../../prospects";
import type { ListenItem } from "../types";
import { listenProspect } from "./listenProspect";

/** A saved list's columns: what you fill in (company, email) first, then what the match gave. */
export const LISTEN_COLUMNS = ["id", "first_name", "full_name", "company", "email", "website", "x_handle", "trigger", "post_url", "post_title", "post_text", "posted_at", "listen_source", "listen_watch"];

/**
 * Matches as a prospect list you can edit and research like any of your own.
 * Saving again keeps every row and column already there (your edits, your own
 * columns) and adds only the matches it doesn't have, by id (OpenMagpie's
 * key). Pure.
 */
export function listenCsv(items: readonly ListenItem[], existing?: string): { text: string; added: number; rows: number } {
  const [head = [], ...rest] = existing ? parseCsv(existing) : [];
  const headers = [...head, ...LISTEN_COLUMNS.filter((c) => !head.includes(c))];
  const rows = rest.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])) as Record<string, string | undefined>);
  const have = new Set(rows.map((r) => r.id).filter(Boolean));
  let added = 0;
  for (const item of items) {
    if (have.has(item.key)) continue;
    have.add(item.key);
    rows.push({ id: item.key, ...listenProspect(item).variables });
    added++;
  }
  return { text: csvText(headers, rows), added, rows: rows.length };
}
