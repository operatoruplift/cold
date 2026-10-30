import type { VariableSpec, Variables } from "../types";

/**
 * The variable contract. Every message may use these; anything else must be
 * declared in the message's front matter (`variables: [...]`). Each one must
 * read naturally in the sentence shapes described, because the messages are
 * written around them. messages/README.md documents the same list (a test
 * keeps the two in step).
 */
export const VARIABLES: VariableSpec[] = [
  // The prospect: from Twenty or a CSV row.
  { name: "first_name", scope: "prospect", description: "First name.", example: "Dana" },
  { name: "last_name", scope: "prospect", description: "Last name.", example: "Reyes" },
  { name: "full_name", scope: "prospect", description: "First and last name, derived when not given.", example: "Dana Reyes" },
  { name: "title", scope: "prospect", description: "Job title.", example: "Owner" },
  { name: "company", scope: "prospect", description: "The prospect's business name.", example: "Clearview Tint" },
  { name: "city", scope: "prospect", description: "City.", example: "Austin" },
  { name: "website", scope: "prospect", description: "Website host, without https:// or www.", example: "clearviewtint.example" },
  { name: "email", scope: "prospect", description: "Email address (used for sending, rarely in copy).", example: "dana@clearviewtint.example" },
  { name: "phone", scope: "prospect", description: "Phone number.", example: "+15125550101" },
  { name: "rating", scope: "prospect", description: "Average review rating.", example: "4.8" },
  { name: "review_count", scope: "prospect", description: "Number of reviews.", example: "212" },
  { name: "linkedin_url", scope: "prospect", description: "LinkedIn profile URL (where LinkedIn DMs go).", example: "https://www.linkedin.com/in/dana-reyes" },
  { name: "x_handle", scope: "prospect", description: "X handle without the @ (where X DMs go).", example: "clearviewtint" },
  { name: "instagram_handle", scope: "prospect", description: "Instagram handle without the @ (where Instagram DMs go).", example: "clearviewtint" },
  { name: "video_url", scope: "prospect", description: "A video recorded for this prospect (Cap, Loom).", example: "https://cap.so/s/clearview-tint" },
  { name: "page_url", scope: "prospect", description: "A page built for this prospect.", example: "https://offer.example/clearview-tint" },
  {
    name: "trigger",
    scope: "prospect",
    description: "One full sentence on why you are reaching out to them, now. Specific and true. It carries the message.",
    example: "Saw you just opened a second bay in Round Rock.",
  },

  // The sender: from the account in cold.yaml.
  { name: "sender_first_name", scope: "account", description: "Sender's first name, used to sign off.", example: "Alex" },
  { name: "sender_name", scope: "account", description: "Sender's full name.", example: "Alex Morgan" },
  { name: "sender_title", scope: "account", description: "Sender's job title.", example: "Founder" },
  { name: "sender_company", scope: "account", description: "Sender's company.", example: "Brightside Studio" },
  { name: "sender_phone", scope: "account", description: "A number the prospect can call back.", example: "+1 512 555 0142" },
  { name: "booking_url", scope: "account", description: "A booking link (Cal.com).", example: "https://cal.com/alex/15min" },
  { name: "postal_address", scope: "account", description: "A valid postal address, required in every cold email footer.", example: "123 Example St, Austin, TX 78701" },

  // The offer: from offers in cold.yaml.
  { name: "audience", scope: "offer", description: 'Who you help, plural: "I work with {{audience}}".', example: "window tint shops" },
  { name: "offer", scope: "offer", description: 'What you do, a verb phrase: "I {{offer}}." / "We {{offer}}."', example: "build booking pages that turn Google reviews into appointments" },
  { name: "outcome", scope: "offer", description: 'What they get, a noun phrase with no pronouns: "so you get {{outcome}}".', example: "more booked jobs from existing Google reviews" },
  { name: "pain", scope: "offer", description: 'The problem, finishing "Most {{audience}} I talk to ...".', example: "miss calls after hours and lose the job to whoever answers" },
  { name: "proof", scope: "offer", description: "One true sentence of proof. Never invent a result.", example: "A tint shop in Dallas booked 14 extra jobs from its page in the first month." },
];

export const VARIABLE_NAMES: ReadonlySet<string> = new Set(VARIABLES.map((v) => v.name));

/** The example value of every variable: used by lint to estimate lengths, and by previews. */
export function exampleVariables(): Variables {
  return Object.fromEntries(VARIABLES.map((v) => [v.name, v.example]));
}
