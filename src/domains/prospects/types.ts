/** Where prospects come from. */
export type ProspectSourceKind = "csv" | "people" | "agencyProspects" | "agencyPeople";

/** Twenty record ids a touch is linked to, so it shows on the right timelines. */
export interface ProspectLinks {
  personId?: string;
  companyId?: string;
  agencyProspectId?: string;
  agencyPersonId?: string;
}

export interface Prospect {
  /** The primary identity, stored on every touch as prospectKey. */
  key: string;
  /**
   * Every identity this prospect is known by ("email:dana@x.com",
   * "person:<id>", "linkedin:dana-reyes", ...). History and opt-outs match on
   * any of them, so an opt-out by email also stops a LinkedIn DM to the same
   * Twenty person.
   */
  identities: string[];
  /** For lists and logs: "Dana Reyes (Clearview Tint)". */
  label: string;
  source: ProspectSourceKind;
  /** Template variables, snake_case. */
  variables: Record<string, string>;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  xHandle?: string;
  instagramHandle?: string;
  facebookUrl?: string;
  /** Do Not Contact in the source (the dialer's status, or a CSV column). */
  doNotContact: boolean;
  links: ProspectLinks;
}
