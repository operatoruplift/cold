import { askStructured, askWithResearch, hostOf, normalizeUrl, type AiResult, type MessagesCall } from "./claude";

/** Who you sell to and what you offer: the cold.yaml offer, plus who is writing. */
export interface AiOffer {
  audience?: string;
  offer?: string;
  outcome?: string;
  pain?: string;
  proof?: string;
}
export interface AiSender {
  name?: string;
  company?: string;
  voice: "personal" | "company";
}
/** What COLD knows about one prospect: its template variables, flattened. */
export type AiProspect = Record<string, string>;

const tag = (name: string, value: string | undefined) => (value?.trim() ? `<${name}>${value.trim()}</${name}>\n` : "");
const offerBlock = (o: AiOffer) => tag("who_i_sell_to", o.audience) + tag("what_i_offer", o.offer) + tag("the_outcome", o.outcome) + tag("the_pain_it_removes", o.pain) + tag("proof", o.proof);
const prospectBlock = (p: AiProspect) =>
  Object.entries(p)
    .filter(([, v]) => v?.trim())
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

/** Links from the web reach the page only as http(s), never javascript: or data:. */
const isHttp = (url: string) => /^https?:\/\/[^\s]+$/i.test(url.trim());

const nullable = (description?: string) => ({ type: ["string", "null"], ...(description ? { description } : {}) });

/* ---------------------------------------------------------------- Find prospects */

export interface FoundProspect {
  company: string;
  website: string | null;
  city: string | null;
  contact_name: string | null;
  contact_title: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  instagram_handle: string | null;
  facebook_url: string | null;
  trigger: string | null;
  trigger_date: string | null;
  fit: string;
  sources: string[];
  /** Set by COLD: sources that were actually searched up or read during the research. */
  verified_sources?: string[];
}
export interface FindResult {
  searched_for: string;
  prospects: FoundProspect[];
}

const FIND_SYSTEM = `You research prospects for COLD, a cold outreach tool. The person using it sells to small and medium businesses. Given who they sell to and what they offer, find real businesses that fit, using web search and web fetch.

A good prospect is:
- a real business, operating now, that matches the audience and the area asked for;
- one with a specific, recent and checkable reason to reach out now (the trigger): a new location, a hiring post, a theme in recent reviews, a launch, an award. Prefer things from the last six months;
- ideally one that names its decision-maker (owner, founder, manager) on its own site, in a press piece or on a public profile. Leave the name empty rather than guess.

Rules:
- Use only facts you saw in a source during this research, and list those sources' URLs. Never invent a business, a person, an email address, a phone number or an event.
- Contact details only when the business publishes them itself: on its website, its Google Business Profile or a directory listing. Never build an email address from a name pattern. No personal mobile numbers or personal email addresses.
- Write the trigger as one full sentence the sender could put in a message, starting from what was seen: "Saw you just opened a second bay in Round Rock." Plain, specific, no flattery.
- Skip corporate franchise offices, closed businesses, and anything on the exclude list.
- A short list of well-sourced prospects beats a long list.

When you're done, call submit_prospects once with everything you found.`;

const FIND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["searched_for", "prospects"],
  properties: {
    searched_for: { type: "string", description: "One sentence: what you searched for, and where." },
    prospects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["company", "website", "city", "contact_name", "contact_title", "email", "phone", "linkedin_url", "instagram_handle", "facebook_url", "trigger", "trigger_date", "fit", "sources"],
        properties: {
          company: { type: "string" },
          website: nullable("The business's own site."),
          city: nullable(),
          contact_name: nullable("A decision-maker the business itself names. Null if none."),
          contact_title: nullable(),
          email: nullable("Only an address the business publishes. Never a guessed one."),
          phone: nullable("The business line, as published."),
          linkedin_url: nullable(),
          instagram_handle: nullable("Without the @."),
          facebook_url: nullable(),
          trigger: nullable("One full sentence: why them, why now. Null if nothing recent was found."),
          trigger_date: nullable("When the trigger happened, as the source puts it, e.g. 'September 2026'."),
          fit: { type: "string", description: "One sentence: why this business fits the offer." },
          sources: { type: "array", items: { type: "string" }, description: "URLs of the pages these facts came from." },
        },
      },
    },
  },
};

export async function findProspects(input: {
  call: MessagesCall;
  offer: AiOffer;
  area: string;
  count: number;
  notes?: string;
  exclude: string[];
  model?: string;
}): Promise<AiResult<FindResult>> {
  const count = Math.max(1, Math.min(15, Math.round(input.count)));
  const prompt =
    offerBlock(input.offer) +
    tag("area", input.area) +
    tag("how_many", String(count)) +
    tag("notes", input.notes) +
    tag("exclude", input.exclude.slice(0, 200).join(", ")) +
    `\nFind up to ${count} prospects.`;
  const result = await askWithResearch<FindResult>({
    call: input.call,
    model: input.model,
    system: FIND_SYSTEM,
    prompt,
    effort: "medium",
    maxSearches: Math.min(12, 3 + count),
    maxFetches: Math.min(12, 2 + count),
    submit: { name: "submit_prospects", description: "Hand over the prospects you found, with their sources.", schema: FIND_SCHEMA },
  });
  const seenUrls = new Set(result.seen.map((s) => normalizeUrl(s.url)));
  const seenHosts = new Set(result.seen.map((s) => hostOf(s.url)));
  const verified = (url: string) => isHttp(url) && (seenUrls.has(normalizeUrl(url)) || seenHosts.has(hostOf(url)));
  const prospects = (result.output.prospects ?? []).slice(0, count).map((p) => ({
    ...p,
    website: p.website && isHttp(p.website) ? p.website : null,
    linkedin_url: p.linkedin_url && isHttp(p.linkedin_url) ? p.linkedin_url : null,
    facebook_url: p.facebook_url && isHttp(p.facebook_url) ? p.facebook_url : null,
    verified_sources: (p.sources ?? []).filter(verified),
  }));
  return { ...result, output: { searched_for: result.output.searched_for ?? "", prospects } };
}

/* ---------------------------------------------------------------- Research one prospect */

export interface Research {
  summary: string;
  triggers: Array<{ sentence: string; when: string | null; source: string }>;
  /** The trigger sentence to use, ready for {{trigger}}. */
  best_trigger: string | null;
  talking_points: string[];
  watch_outs: string[];
  fit: "strong" | "possible" | "weak";
  fit_reason: string;
  verified_sources?: string[];
}

const RESEARCH_SYSTEM = `You prepare a salesperson before they reach out to one business for the first time. Using web search and web fetch, look at the business's own site and its public footprint (reviews, news, job posts, social profiles) and report what is true and useful.

Rules:
- Only state what a source shows, and give the source for each trigger. If you can't confirm something, leave it out.
- A trigger is one full sentence the sender could put in a message, starting from what was seen: "Saw you just opened a second bay in Round Rock." Recent and specific beats impressive.
- Talking points connect what you found to the offer, in plain words. No flattery, no fake familiarity.
- Watch-outs are reasons the offer may not fit or the timing is wrong (they already use a similar product, they just closed, they only sell wholesale).
- Judge fit honestly: strong, possible or weak.

When you're done, call submit_research once.`;

const RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "triggers", "best_trigger", "talking_points", "watch_outs", "fit", "fit_reason"],
  properties: {
    summary: { type: "string", description: "Two or three sentences: what the business is and does." },
    triggers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sentence", "when", "source"],
        properties: { sentence: { type: "string" }, when: nullable("As the source puts it."), source: { type: "string", description: "URL." } },
      },
    },
    best_trigger: nullable("The trigger sentence to open with, or null if none is strong enough."),
    talking_points: { type: "array", items: { type: "string" } },
    watch_outs: { type: "array", items: { type: "string" } },
    fit: { type: "string", enum: ["strong", "possible", "weak"] },
    fit_reason: { type: "string" },
  },
};

export async function researchProspect(input: { call: MessagesCall; offer: AiOffer; prospect: AiProspect; model?: string }): Promise<AiResult<Research>> {
  const prompt = `${offerBlock(input.offer)}<prospect>\n${prospectBlock(input.prospect)}\n</prospect>\n\nResearch this prospect.`;
  const result = await askWithResearch<Research>({
    call: input.call,
    model: input.model,
    system: RESEARCH_SYSTEM,
    prompt,
    effort: "medium",
    maxSearches: 5,
    maxFetches: 5,
    submit: { name: "submit_research", description: "Hand over what you found about this prospect.", schema: RESEARCH_SCHEMA },
  });
  const seenUrls = new Set(result.seen.map((s) => normalizeUrl(s.url)));
  const seenHosts = new Set(result.seen.map((s) => hostOf(s.url)));
  const verified = (url: string) => isHttp(url) && (seenUrls.has(normalizeUrl(url)) || seenHosts.has(hostOf(url)));
  const triggers = (result.output.triggers ?? []).filter((t) => verified(t.source));
  // A trigger whose source was never opened is dropped, and so is a best trigger that relied on one.
  const best = result.output.best_trigger && triggers.some((t) => t.sentence === result.output.best_trigger) ? result.output.best_trigger : (triggers[0]?.sentence ?? null);
  return { ...result, output: { ...result.output, triggers, best_trigger: best, verified_sources: [...new Set(triggers.map((t) => t.source))] } };
}

/* ---------------------------------------------------------------- Personalize a message */

export interface Draft {
  subject: string | null;
  body: string;
  personal_line: string | null;
  changes: string;
}

const DRAFT_SYSTEM = `You personalize one cold message for COLD. You get the message as the template wrote it for this prospect, what is known about the prospect, and the sender's offer. Return the message, improved for this one person.

Rules:
- Keep it the same message: same purpose, same offer, same ask, same voice, about the same length. Don't add links, attachments, prices, or promises the original doesn't make.
- Use only facts from <prospect> and <research>. If nothing specific is known, keep the template's wording rather than invent a detail.
- At most one personal line, and it must be true. No flattery, no "I hope this finds you well", no fake familiarity ("as we discussed").
- Plain text. Keep the greeting and sign-off style of the original. Never add the opt-out footer; COLD adds it.
- Stay under the character limit when one is given.
- In the company voice write as the brand ("we"); in the personal voice write as one person ("I").`;

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body", "personal_line", "changes"],
  properties: {
    subject: nullable("The subject line, or null for a DM or a follow-up in the same thread."),
    body: { type: "string" },
    personal_line: nullable("The sentence you added or changed for this person, if any."),
    changes: { type: "string", description: "One sentence for the sender: what you changed and why." },
  },
};

export async function draftMessage(input: {
  call: MessagesCall;
  channel: "email" | "dm";
  sender: AiSender;
  offer: AiOffer;
  prospect: AiProspect;
  research?: Research;
  template: { subject?: string; body: string };
  maxChars?: number;
  threaded?: boolean;
  model?: string;
}): Promise<AiResult<Draft>> {
  const research = input.research
    ? `<research>\n${input.research.summary}\nTriggers:\n${input.research.triggers.map((t) => `- ${t.sentence}${t.when ? ` (${t.when})` : ""}`).join("\n")}\nTalking points:\n${input.research.talking_points.map((t) => `- ${t}`).join("\n")}\n</research>\n`
    : "";
  const prompt =
    tag("channel", input.channel === "email" ? (input.threaded ? "email, a follow-up in the same thread (keep the subject as is)" : "email, first in its thread") : "direct message") +
    tag("voice", input.sender.voice) +
    tag("sender", [input.sender.name, input.sender.company].filter(Boolean).join(", ")) +
    offerBlock(input.offer) +
    `<prospect>\n${prospectBlock(input.prospect)}\n</prospect>\n` +
    research +
    tag("character_limit", input.maxChars ? String(input.maxChars) : undefined) +
    `<template_message>\n${input.template.subject ? `Subject: ${input.template.subject}\n\n` : ""}${input.template.body}\n</template_message>\n\nPersonalize this message.`;
  const result = await askStructured<Draft>({ call: input.call, model: input.model, system: DRAFT_SYSTEM, prompt, effort: "medium", maxTokens: 16000, schema: DRAFT_SCHEMA });
  const out = result.output;
  if (input.channel === "dm" || input.threaded) out.subject = input.template.subject ?? null;
  if (/\{\{|\}\}/.test(out.body)) throw new Error("The draft still has an unfilled {{variable}}. Fill in the prospect's details and try again.");
  if (input.maxChars && out.body.length > input.maxChars) throw new Error(`The draft came back at ${out.body.length} characters, over the ${input.maxChars} limit. Try again.`);
  return result;
}

/* ---------------------------------------------------------------- Call prep */

export interface CallPrep {
  opener: string;
  reason: string;
  questions: string[];
  objections: Array<{ objection: string; response: string }>;
  voicemail: string;
  next_step: string;
}

const CALL_SYSTEM = `You prepare a person to make one cold call themselves. They will read your notes on screen while they talk, so write the way people speak: short sentences, no jargon.

Rules:
- Use only facts from <prospect> and <research>. If nothing specific is known, open with the plain reason for the call.
- The opener is two sentences at most: who is calling and why this business, today.
- Questions are open, about the prospect's situation, and lead naturally to the offer.
- Objection answers acknowledge first, then ask a question; they don't argue. Build on the script's own answers when they're given.
- The voicemail is under 60 words and says the number twice if one is given.
- This is a person-to-person call. Don't write anything for a recording or an automated voice.`;

const CALL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["opener", "reason", "questions", "objections", "voicemail", "next_step"],
  properties: {
    opener: { type: "string" },
    reason: { type: "string", description: "One sentence: why you're calling them." },
    questions: { type: "array", items: { type: "string" } },
    objections: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["objection", "response"], properties: { objection: { type: "string" }, response: { type: "string" } } },
    },
    voicemail: { type: "string" },
    next_step: { type: "string", description: "The one thing to ask for at the end." },
  },
};

export async function prepCall(input: {
  call: MessagesCall;
  sender: AiSender & { phone?: string };
  offer: AiOffer;
  prospect: AiProspect;
  research?: Research;
  script?: { title: string; sections: Array<{ heading: string; text: string }>; objections: Array<{ objection: string; response: string }> };
  model?: string;
}): Promise<AiResult<CallPrep>> {
  const script = input.script
    ? `<call_script title="${input.script.title}">\n${input.script.sections.map((s) => `${s.heading}:\n${s.text}`).join("\n\n")}\n\nObjections:\n${input.script.objections.map((o) => `- ${o.objection}: ${o.response}`).join("\n")}\n</call_script>\n`
    : "";
  const research = input.research ? `<research>\n${input.research.summary}\n${input.research.triggers.map((t) => `- ${t.sentence}`).join("\n")}\n${input.research.talking_points.map((t) => `- ${t}`).join("\n")}\n</research>\n` : "";
  const prompt =
    tag("voice", input.sender.voice) +
    tag("caller", [input.sender.name, input.sender.company].filter(Boolean).join(", ")) +
    tag("callback_number", input.sender.phone) +
    offerBlock(input.offer) +
    `<prospect>\n${prospectBlock(input.prospect)}\n</prospect>\n` +
    research +
    script +
    "Prepare me for this call.";
  return askStructured<CallPrep>({ call: input.call, model: input.model, system: CALL_SYSTEM, prompt, effort: "medium", maxTokens: 16000, schema: CALL_SCHEMA });
}

/* ---------------------------------------------------------------- Reply triage */

export const REPLY_INTENTS = ["interested", "question", "not_now", "not_interested", "unsubscribe", "wrong_person", "out_of_office", "other"] as const;
export interface Triage {
  intent: (typeof REPLY_INTENTS)[number];
  summary: string;
  next_step: string;
  /** When they said to come back later, e.g. "after the new year". */
  follow_up_when: string | null;
  draft_reply: string | null;
}

const TRIAGE_SYSTEM = `You read one reply to a cold email and help the sender answer it well.

Intents:
- interested: wants to talk, see more, or book a time.
- question: asks something before deciding.
- not_now: open to it later; say when if they said when.
- not_interested: a clear no, but no request to stop contact.
- unsubscribe: asks to stop, be removed, or never be contacted. Any wording counts.
- wrong_person: points to someone else, or isn't the right contact.
- out_of_office: an automatic away reply.
- other: anything else.

Rules:
- For interested, question, not_now and wrong_person, draft a short reply in the sender's voice: answer what they asked, propose one concrete next step, no pressure. Use only facts given here; if a question needs information you don't have, write a placeholder like [your price for one location].
- For unsubscribe and not_interested, the draft is null: COLD stops contacting them. For out_of_office, null.
- The summary is one sentence a busy person can read at a glance.`;

const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "summary", "next_step", "follow_up_when", "draft_reply"],
  properties: {
    intent: { type: "string", enum: [...REPLY_INTENTS] },
    summary: { type: "string" },
    next_step: { type: "string", description: "What the sender should do now, in a few words." },
    follow_up_when: nullable(),
    draft_reply: nullable(),
  },
};

export async function triageReply(input: {
  call: MessagesCall;
  sender: AiSender;
  offer: AiOffer;
  prospect: AiProspect;
  reply: { subject?: string; body: string };
  model?: string;
}): Promise<AiResult<Triage>> {
  const prompt =
    tag("voice", input.sender.voice) +
    tag("sender", [input.sender.name, input.sender.company].filter(Boolean).join(", ")) +
    offerBlock(input.offer) +
    `<prospect>\n${prospectBlock(input.prospect)}\n</prospect>\n` +
    `<reply>\n${input.reply.subject ? `Subject: ${input.reply.subject}\n\n` : ""}${input.reply.body.slice(0, 6000)}\n</reply>\n\nRead this reply.`;
  return askStructured<Triage>({ call: input.call, model: input.model, system: TRIAGE_SYSTEM, prompt, effort: "low", maxTokens: 8000, schema: TRIAGE_SCHEMA });
}
