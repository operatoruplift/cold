import type { Prospect, ProspectLinks, ProspectSourceKind } from "../types";
import { isTruthy, linkedinSlug, normalizeEmail, socialHandle, splitName, toSnakeCase, websiteHost } from "./normalize";
import { phoneFromComposite, recordVariables } from "./recordVariables";

type Rec = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);
const link = (v: unknown) => str((v as Rec | undefined)?.primaryLinkUrl);
const firstEmail = (v: unknown) => normalizeEmail(str((v as Rec | undefined)?.primaryEmail));

interface Draft {
  source: ProspectSourceKind;
  variables: Record<string, string>;
  doNotContact: boolean;
  links: ProspectLinks;
  /** The source's own id, for a last-resort identity. */
  sourceId?: string;
}

/**
 * Fill derived variables, collect identities and pick the key. Order of the
 * key: Twenty record id, then email, then social profiles, then the source id.
 */
export function finishProspect(draft: Draft): Prospect {
  const v = draft.variables;
  const email = normalizeEmail(v.email);
  if (email) v.email = email;
  else delete v.email;
  if (v.website) v.website = websiteHost(v.website) ?? v.website;
  const [first, last] = splitName(v.full_name);
  if (!v.first_name && first) v.first_name = first;
  if (!v.last_name && last) v.last_name = last;
  if (!v.full_name && (v.first_name || v.last_name)) v.full_name = [v.first_name, v.last_name].filter(Boolean).join(" ");

  const linkedinUrl = v.linkedin_url;
  const xHandle = socialHandle(v.x_handle);
  const instagramHandle = socialHandle(v.instagram_handle);
  if (xHandle) v.x_handle = xHandle;
  if (instagramHandle) v.instagram_handle = instagramHandle;

  const identities = [
    draft.links.agencyPersonId && `agencyPerson:${draft.links.agencyPersonId}`,
    draft.links.personId && `person:${draft.links.personId}`,
    draft.links.agencyProspectId && !draft.links.agencyPersonId && `agencyProspect:${draft.links.agencyProspectId}`,
    email && `email:${email}`,
    linkedinSlug(linkedinUrl) && `linkedin:${linkedinSlug(linkedinUrl)}`,
    xHandle && `x:${xHandle}`,
    instagramHandle && `instagram:${instagramHandle}`,
    draft.sourceId && `${draft.source}:${draft.sourceId}`,
  ].filter((id): id is string => !!id);
  const key = identities[0] ?? `${draft.source}:${v.company ?? "unknown"}:${v.full_name ?? ""}`.toLowerCase();
  if (!identities.length) identities.push(key);

  const person = v.full_name || undefined;
  const label = person && v.company ? `${person} (${v.company})` : person ?? v.company ?? key;
  return {
    key,
    identities,
    label,
    source: draft.source,
    variables: v,
    email,
    phone: v.phone,
    linkedinUrl,
    xHandle,
    instagramHandle,
    facebookUrl: v.facebook_url,
    doNotContact: draft.doNotContact,
    links: draft.links,
  };
}

/** A CSV row: every column becomes a snake_case variable. */
export function fromCsvRow(headers: string[], row: string[], index: number): Prospect {
  const variables: Record<string, string> = {};
  headers.forEach((h, i) => {
    const value = row[i]?.trim();
    if (value) variables[toSnakeCase(h)] = value;
  });
  const doNotContact = isTruthy(variables.do_not_contact) || isTruthy(variables.dnc) || isTruthy(variables.opted_out);
  return finishProspect({ source: "csv", variables, doNotContact, links: {}, sourceId: variables.id ?? String(index + 1) });
}

/** A standard Twenty person, with its company when it has one. */
export function fromPerson(person: Rec, company?: Rec): Prospect {
  const name = (person.name ?? {}) as Rec;
  const address = (company?.address ?? {}) as Rec;
  const variables: Record<string, string> = {
    ...recordVariables(person),
    ...Object.fromEntries(
      Object.entries({
        first_name: str(name.firstName),
        last_name: str(name.lastName),
        title: str(person.jobTitle),
        email: firstEmail(person.emails),
        phone: phoneFromComposite(person.phones) ?? str(person.phone),
        linkedin_url: link(person.linkedinLink),
        x_handle: link(person.xLink),
        city: str(person.city) ?? str(address.addressCity),
        company: str(company?.name),
        website: link(company?.domainName),
        trigger: str(person.coldTrigger),
      }).filter((e): e is [string, string] => !!e[1]),
    ),
  };
  delete variables.name;
  const id = str(person.id);
  return finishProspect({ source: "people", variables, doNotContact: false, links: { personId: id, companyId: str(person.companyId) } });
}

const DNC_STATES = new Set(["DO_NOT_CONTACT", "OPTED_OUT"]);

/** Is the dialer's prospect marked Do Not Contact (call status or SMS state)? */
export function agencyProspectIsDnc(p: Rec): boolean {
  return [p.coldCallStatus, p.outboundState, p.outboundLabel].some((s) => typeof s === "string" && DNC_STATES.has(s));
}

/** The dialer's prospect: a business, with its decision maker when known. */
export function fromAgencyProspect(p: Rec): Prospect {
  const [first, last] = splitName(str(p.decisionMaker));
  const variables: Record<string, string> = {
    ...recordVariables(p),
    ...Object.fromEntries(
      Object.entries({
        company: str(p.name),
        first_name: first,
        last_name: last,
        title: str(p.decisionMakerTitle),
        email: firstEmail(p.primaryEmail) ?? normalizeEmail(str(p.email)),
        phone: phoneFromComposite(p.primaryPhone) ?? phoneFromComposite(p.phoneNumber) ?? str(p.phone),
        website: str(p.website),
        city: str(p.city),
        rating: str(p.rating),
        review_count: str(p.reviewCount),
        video_url: link(p.videoUrl),
        trigger: str(p.coldTrigger),
      }).filter((e): e is [string, string] => !!e[1]),
    ),
  };
  delete variables.name;
  return finishProspect({ source: "agencyProspects", variables, doNotContact: agencyProspectIsDnc(p), links: { agencyProspectId: str(p.id) } });
}

/** A person at one of the dialer's prospects: their profiles, the business's details. */
export function fromAgencyPerson(person: Rec, prospect?: Rec): Prospect {
  const business = prospect ? fromAgencyProspect(prospect) : undefined;
  const [first, last] = splitName(str(person.name));
  const variables: Record<string, string> = {
    ...(business?.variables ?? {}),
    ...recordVariables(person),
    ...Object.fromEntries(
      Object.entries({
        first_name: first,
        last_name: last,
        full_name: str(person.name),
        title: str(person.jobTitle),
        email: firstEmail(person.emails) ?? business?.variables.email,
        phone: phoneFromComposite(person.phones) ?? business?.variables.phone,
        linkedin_url: link(person.linkedinLink),
        x_handle: link(person.xLink),
        city: str(person.city) ?? business?.variables.city,
      }).filter((e): e is [string, string] => !!e[1]),
    ),
  };
  delete variables.name;
  delete variables.person_role;
  return finishProspect({
    source: "agencyPeople",
    variables,
    doNotContact: business?.doNotContact ?? false,
    links: { agencyPersonId: str(person.id), agencyProspectId: str(person.prospectId) },
  });
}
