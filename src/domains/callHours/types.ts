/** Where a prospect's time zone was read from. */
export type ZoneSource = "timezone" | "phone" | "region" | "country";

/** The time zones a prospect may be in. Several when their area spans zones: calls then fit all of them. */
export interface ProspectZones {
  zones: string[];
  /** Everything that placed them: their phone's area code and their state can both count. */
  from: ZoneSource[];
}

/** Whether a prospect can be called now, in their own time. */
export interface CallTime {
  /** Inside calling hours in every zone they may be in; undefined when their zone is unknown. */
  ok?: boolean;
  /** Their time now: "9:14 AM CST", or "9:14 AM CST / 8:14 AM MST" when their area spans zones. */
  local?: string;
  zones: string[];
  from: ZoneSource[];
  /** When calling hours open next for them, when they are closed now. */
  nextAt?: string;
  /** One line for people: "9:14 AM their time (from their phone number)". */
  note: string;
}

/** A phone prefix whose zones are this many hours apart or more says nothing useful (a whole country such as the US). */
export const MAX_ZONE_SPREAD_HOURS = 3;
