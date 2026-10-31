import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TwentyClient, TwentyRecord } from "../twenty";
import { fromAgencyPerson, fromAgencyProspect, fromCsvRow, fromPerson, parseCsv } from "./helpers";
import type { Prospect } from "./types";

export * from "./types";
export * from "./helpers";

export const SOURCES_HELP = "csv:<file>, twenty:people, twenty:agencyProspects or twenty:agencyPeople";

export interface LoadOptions {
  /** A Twenty REST filter, e.g. coldCallStatus[eq]:NEW */
  where?: string;
  limit?: number;
  client?: TwentyClient;
}

/** Load prospects from a CSV file or a Twenty object. */
export async function loadProspects(source: string, options: LoadOptions = {}): Promise<Prospect[]> {
  const [kind, ...rest] = source.split(":");
  const target = rest.join(":");

  if (kind === "csv" || (rest.length === 0 && source.endsWith(".csv"))) {
    const file = path.resolve(kind === "csv" ? target : source);
    if (!existsSync(file)) throw new Error(`No CSV at ${file}`);
    if (options.where) throw new Error("--where filters Twenty sources; filter the CSV itself instead");
    return prospectsFromCsv(readFileSync(file, "utf8"), options.limit);
  }

  if (kind !== "twenty") throw new Error(`Unknown source "${source}". Use ${SOURCES_HELP}.`);
  const client = options.client;
  if (!client) throw new Error("Twenty sources need TWENTY_BASE_URL and TWENTY_API_KEY in .env.local");
  const list = (plural: string) => client.list(plural, { filter: options.where, limit: options.limit });
  const byId = (records: TwentyRecord[]) => new Map(records.map((r) => [r.id, r]));

  switch (target) {
    case "people": {
      const people = await list("people");
      const companies = byId(await client.getMany("companies", people.map((p) => p.companyId as string)));
      return people.map((p) => fromPerson(p, companies.get(p.companyId as string)));
    }
    case "agencyProspects":
      return (await list("agencyProspects")).map(fromAgencyProspect);
    case "agencyPeople": {
      const people = await list("agencyPeople");
      const prospects = byId(await client.getMany("agencyProspects", people.map((p) => p.prospectId as string)));
      return people.map((p) => fromAgencyPerson(p, prospects.get(p.prospectId as string)));
    }
    default:
      throw new Error(`Unknown Twenty source "${target}". Use ${SOURCES_HELP}.`);
  }
}

/** The prospects in CSV text: a header row, then one prospect per row. */
export function prospectsFromCsv(text: string, limit?: number): Prospect[] {
  const [headers, ...rows] = parseCsv(text);
  if (!headers) return [];
  return rows.slice(0, limit ?? rows.length).map((row, i) => fromCsvRow(headers, row, i));
}

/** Pick one prospect by key, any identity, email, or a case-insensitive name/company match. */
export function findProspect(prospects: Prospect[], query: string): Prospect | undefined {
  const q = query.trim().toLowerCase();
  return (
    prospects.find((p) => p.key === q || p.identities.includes(q) || p.email === q || p.variables.id?.toLowerCase() === q) ??
    prospects.find((p) => p.label.toLowerCase().includes(q))
  );
}
