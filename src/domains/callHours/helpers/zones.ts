import { MAX_ZONE_SPREAD_HOURS, type ProspectZones } from "../types";
import { PHONE_PREFIXES, PHONE_ZONE_NAMES } from "./phoneZones.data";

/** Is this an IANA time zone this runtime knows? */
export function isTimeZone(name: string | undefined): name is string {
  if (!name?.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name.trim() });
    return true;
  } catch {
    return false;
  }
}

let prefixes: { map: Map<string, string[]>; longest: number } | undefined;

/** The zones of an E.164 number (digits only, country code first), by its longest known prefix. */
export function zonesForNumber(digits: string): string[] | undefined {
  if (!prefixes) {
    const map = new Map<string, string[]>();
    let longest = 0;
    for (const entry of PHONE_PREFIXES.split(";")) {
      const [prefix, ids] = entry.split(":") as [string, string];
      map.set(prefix, ids.split(",").map((i) => PHONE_ZONE_NAMES[Number(i)]!));
      longest = Math.max(longest, prefix.length);
    }
    prefixes = { map, longest };
  }
  for (let n = Math.min(digits.length, prefixes.longest); n >= 1; n--) {
    const zones = prefixes.map.get(digits.slice(0, n));
    if (zones) return zones;
  }
  return undefined;
}

interface Country {
  /** Calling code. */
  code: string;
  /** National numbers start with a 0 that the international form drops. */
  trunk: boolean;
  names: string[];
}

/** Countries whose numbers COLD can read without a + in front, by ISO code or name. */
const COUNTRIES: Country[] = [
  { code: "1", trunk: false, names: ["us", "usa", "united states", "united states of america", "america", "ca", "can", "canada", "pr", "puerto rico"] },
  { code: "44", trunk: true, names: ["gb", "uk", "united kingdom", "great britain", "britain", "england", "scotland", "wales", "northern ireland"] },
  { code: "353", trunk: true, names: ["ie", "irl", "ireland"] },
  { code: "61", trunk: true, names: ["au", "aus", "australia"] },
  { code: "64", trunk: true, names: ["nz", "new zealand"] },
  { code: "27", trunk: true, names: ["za", "south africa"] },
  { code: "49", trunk: true, names: ["de", "deu", "germany"] },
  { code: "33", trunk: true, names: ["fr", "fra", "france"] },
  { code: "31", trunk: true, names: ["nl", "netherlands", "holland"] },
  { code: "32", trunk: true, names: ["be", "belgium"] },
  { code: "41", trunk: true, names: ["ch", "switzerland"] },
  { code: "43", trunk: true, names: ["at", "austria"] },
  { code: "46", trunk: true, names: ["se", "sweden"] },
  { code: "358", trunk: true, names: ["fi", "finland"] },
  { code: "34", trunk: false, names: ["es", "spain"] },
  { code: "39", trunk: false, names: ["it", "italy"] },
  { code: "351", trunk: false, names: ["pt", "portugal"] },
  { code: "45", trunk: false, names: ["dk", "denmark"] },
  { code: "47", trunk: false, names: ["no", "norway"] },
  { code: "48", trunk: false, names: ["pl", "poland"] },
  { code: "52", trunk: false, names: ["mx", "mexico"] },
  { code: "91", trunk: true, names: ["in", "india"] },
  { code: "65", trunk: false, names: ["sg", "singapore"] },
  { code: "63", trunk: true, names: ["ph", "philippines"] },
  { code: "971", trunk: true, names: ["ae", "uae", "united arab emirates"] },
];

function findCountry(name: string | undefined): Country | undefined {
  const key = name?.trim().toLowerCase().replace(/\./g, "");
  return key ? COUNTRIES.find((c) => c.names.includes(key)) : undefined;
}

/**
 * A phone number as E.164 digits: written with + or 00 in front, or in the
 * national form of the prospect's country (US and Canada when none is
 * given). Undefined when it can't be read. Pure.
 */
export function phoneDigits(phone: string | undefined, countryName?: string): string | undefined {
  const raw = phone?.trim() ?? "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return undefined;
  if (raw.startsWith("+")) return digits;
  if (raw.startsWith("00")) return digits.slice(2);
  const country = findCountry(countryName);
  if (countryName?.trim() && !country) return undefined;
  if (!country || country.code === "1") {
    if (digits.length === 10 && /^[2-9]/.test(digits)) return `1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return digits;
    if (raw.startsWith("011")) return digits.slice(3);
    return undefined;
  }
  if (country.trunk && digits.startsWith("0")) return country.code + digits.slice(1);
  if (digits.startsWith(country.code) && digits.length >= country.code.length + 8) return digits;
  return country.trunk ? undefined : country.code + digits;
}

const ET = "America/New_York";
const CT = "America/Chicago";
const MT = "America/Denver";
const PT = "America/Los_Angeles";

/** US states and territories, Canadian provinces and territories: every zone each spans. */
const REGIONS: Array<{ names: string[]; zones: string[] }> = [
  { names: ["al", "alabama"], zones: [CT] },
  { names: ["ak", "alaska"], zones: ["America/Anchorage", "America/Adak"] },
  { names: ["az", "arizona"], zones: ["America/Phoenix", MT] },
  { names: ["ar", "arkansas"], zones: [CT] },
  { names: ["ca", "california"], zones: [PT] },
  { names: ["co", "colorado"], zones: [MT] },
  { names: ["ct", "connecticut"], zones: [ET] },
  { names: ["de", "delaware"], zones: [ET] },
  { names: ["dc", "district of columbia", "washington dc"], zones: [ET] },
  { names: ["fl", "florida"], zones: [ET, CT] },
  { names: ["ga", "georgia"], zones: [ET] },
  { names: ["hi", "hawaii"], zones: ["Pacific/Honolulu"] },
  { names: ["id", "idaho"], zones: ["America/Boise", PT] },
  { names: ["il", "illinois"], zones: [CT] },
  { names: ["in", "indiana"], zones: ["America/Indiana/Indianapolis", CT] },
  { names: ["ia", "iowa"], zones: [CT] },
  { names: ["ks", "kansas"], zones: [CT, MT] },
  { names: ["ky", "kentucky"], zones: [ET, CT] },
  { names: ["la", "louisiana"], zones: [CT] },
  { names: ["me", "maine"], zones: [ET] },
  { names: ["md", "maryland"], zones: [ET] },
  { names: ["ma", "massachusetts"], zones: [ET] },
  { names: ["mi", "michigan"], zones: ["America/Detroit", "America/Menominee"] },
  { names: ["mn", "minnesota"], zones: [CT] },
  { names: ["ms", "mississippi"], zones: [CT] },
  { names: ["mo", "missouri"], zones: [CT] },
  { names: ["mt", "montana"], zones: [MT] },
  { names: ["ne", "nebraska"], zones: [CT, MT] },
  { names: ["nv", "nevada"], zones: [PT, MT] },
  { names: ["nh", "new hampshire"], zones: [ET] },
  { names: ["nj", "new jersey"], zones: [ET] },
  { names: ["nm", "new mexico"], zones: [MT] },
  { names: ["ny", "new york"], zones: [ET] },
  { names: ["nc", "north carolina"], zones: [ET] },
  { names: ["nd", "north dakota"], zones: [CT, MT] },
  { names: ["oh", "ohio"], zones: [ET] },
  { names: ["ok", "oklahoma"], zones: [CT] },
  { names: ["or", "oregon"], zones: [PT, "America/Boise"] },
  { names: ["pa", "pennsylvania"], zones: [ET] },
  { names: ["ri", "rhode island"], zones: [ET] },
  { names: ["sc", "south carolina"], zones: [ET] },
  { names: ["sd", "south dakota"], zones: [CT, MT] },
  { names: ["tn", "tennessee"], zones: [CT, ET] },
  { names: ["tx", "texas"], zones: [CT, MT] },
  { names: ["ut", "utah"], zones: [MT] },
  { names: ["vt", "vermont"], zones: [ET] },
  { names: ["va", "virginia"], zones: [ET] },
  { names: ["wa", "washington"], zones: [PT] },
  { names: ["wv", "west virginia"], zones: [ET] },
  { names: ["wi", "wisconsin"], zones: [CT] },
  { names: ["wy", "wyoming"], zones: [MT] },
  { names: ["pr", "puerto rico"], zones: ["America/Puerto_Rico"] },
  { names: ["gu", "guam"], zones: ["Pacific/Guam"] },
  { names: ["vi", "us virgin islands", "virgin islands"], zones: ["America/St_Thomas"] },
  { names: ["as", "american samoa"], zones: ["Pacific/Pago_Pago"] },
  { names: ["mp", "northern mariana islands"], zones: ["Pacific/Saipan"] },
  { names: ["ab", "alberta"], zones: ["America/Edmonton"] },
  { names: ["bc", "british columbia"], zones: ["America/Vancouver", "America/Edmonton"] },
  { names: ["mb", "manitoba"], zones: ["America/Winnipeg"] },
  { names: ["nb", "new brunswick"], zones: ["America/Moncton"] },
  { names: ["nl", "newfoundland and labrador", "newfoundland", "labrador"], zones: ["America/St_Johns", "America/Goose_Bay"] },
  { names: ["ns", "nova scotia"], zones: ["America/Halifax"] },
  { names: ["nt", "northwest territories"], zones: ["America/Edmonton"] },
  { names: ["nu", "nunavut"], zones: ["America/Iqaluit", "America/Rankin_Inlet", "America/Cambridge_Bay"] },
  { names: ["on", "ontario"], zones: ["America/Toronto", "America/Winnipeg"] },
  { names: ["pe", "pei", "prince edward island"], zones: ["America/Halifax"] },
  { names: ["qc", "quebec", "québec"], zones: ["America/Toronto", "America/Halifax"] },
  { names: ["sk", "saskatchewan"], zones: ["America/Regina", "America/Edmonton"] },
  { names: ["yt", "yukon"], zones: ["America/Whitehorse"] },
];

/** The zones of a US state or Canadian province, by code or name. Pure. */
export function zonesForRegion(region: string | undefined): string[] | undefined {
  const key = region?.trim().toLowerCase().replace(/\./g, "");
  return key ? REGIONS.find((r) => r.names.includes(key))?.zones : undefined;
}

/** Minutes east of UTC in a zone at a moment. */
export function offsetMinutes(zone: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  const local = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
  return Math.round((local - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** Zones close enough together to say something: within a few hours of each other. */
function narrow(zones: string[] | undefined, at: Date): string[] | undefined {
  if (!zones?.length) return undefined;
  const offsets = zones.map((z) => offsetMinutes(z, at));
  return Math.max(...offsets) - Math.min(...offsets) < MAX_ZONE_SPREAD_HOURS * 60 ? zones : undefined;
}

/**
 * Every time zone a prospect may be in. A timezone column says it outright.
 * Otherwise their phone's area code and their state or province both count:
 * an area code inside the state narrows it (a 512 number in Texas is
 * Central), and one outside it adds its zone, so a Texas business on a New
 * York cell is called when both are awake. The country is the last resort,
 * when it has one time zone. Undefined when none of it says.
 */
export function prospectZones(prospect: { phone?: string; variables: Record<string, string> }, at: Date): ProspectZones | undefined {
  const v = prospect.variables;
  const explicit = [v.timezone, v.time_zone, v.tz].find((z) => isTimeZone(z));
  if (explicit) return { zones: [explicit.trim()], from: ["timezone"] };
  const countryName = v.country ?? v.country_code;
  const country = findCountry(countryName);
  const digits = phoneDigits(prospect.phone ?? v.phone, countryName);
  const byPhone = narrow(digits ? zonesForNumber(digits) : undefined, at);
  const northAmerican = !countryName?.trim() || country?.code === "1";
  const byRegion = northAmerican ? zonesForRegion(v.region ?? v.state ?? v.province ?? v.state_code) : undefined;
  if (byPhone && byRegion) {
    const offsets = new Set(byRegion.map((z) => offsetMinutes(z, at)));
    const inside = byPhone.every((z) => offsets.has(offsetMinutes(z, at)));
    return { zones: inside ? byPhone : [...new Set([...byPhone, ...byRegion])], from: ["phone", "region"] };
  }
  if (byPhone) return { zones: byPhone, from: ["phone"] };
  if (byRegion) return { zones: byRegion, from: ["region"] };
  const byCountry = country ? narrow(zonesForNumber(country.code), at) : undefined;
  return byCountry ? { zones: byCountry, from: ["country"] } : undefined;
}
