import type { SchemaField, SchemaManifest } from "./types";

const coldTrigger: SchemaField = {
  name: "coldTrigger",
  type: "TEXT",
  label: "Cold Trigger",
  description: "One true sentence on why to reach out now. Fills {{trigger}} in cold messages.",
  icon: "IconBolt",
};

/**
 * Everything cold reads or writes in Twenty. `bun run twenty:schema` creates
 * whatever is missing and never edits or deletes, so it is safe to run on a
 * workspace in use, and next to the dialer's own schema.
 *
 * Field names avoid Twenty's reserved words (event, type, link, ...), which is
 * why the event column is `kind`.
 */
export const SCHEMA_MANIFEST: SchemaManifest = {
  objects: [
    {
      nameSingular: "coldTouch",
      namePlural: "coldTouches",
      labelSingular: "Cold Touch",
      labelPlural: "Cold Touches",
      description: "One cold outreach event: an email or DM sent, a reply, a bounce, an opt-out or a logged call. Written by cold.",
      icon: "IconSend",
      fields: [
        {
          name: "kind",
          type: "SELECT",
          label: "Event",
          description: "What happened",
          icon: "IconActivity",
          options: [
            { value: "SENT", label: "Sent", color: "blue" },
            { value: "REPLIED", label: "Replied", color: "green" },
            { value: "BOUNCED", label: "Bounced", color: "orange" },
            { value: "OPTED_OUT", label: "Opted Out", color: "red" },
            { value: "UNDELIVERABLE", label: "Undeliverable", color: "gray" },
            { value: "FAILED", label: "Failed", color: "red" },
            { value: "CALLED", label: "Called", color: "purple" },
          ],
        },
        {
          name: "channel",
          type: "SELECT",
          label: "Channel",
          icon: "IconMessages",
          options: [
            { value: "EMAIL", label: "Email", color: "blue" },
            { value: "LINKEDIN", label: "LinkedIn", color: "sky" },
            { value: "X", label: "X", color: "gray" },
            { value: "INSTAGRAM", label: "Instagram", color: "pink" },
            { value: "FACEBOOK", label: "Facebook", color: "blue" },
            { value: "CALL", label: "Call", color: "green" },
          ],
        },
        {
          name: "voice",
          type: "SELECT",
          label: "Voice",
          description: "Sent from a personal account (I) or the company (we)",
          icon: "IconUserCircle",
          options: [
            { value: "PERSONAL", label: "Personal", color: "turquoise" },
            { value: "COMPANY", label: "Company", color: "purple" },
          ],
        },
        { name: "account", type: "TEXT", label: "Account", description: "The cold.yaml account it went out from", icon: "IconAt" },
        { name: "sequence", type: "TEXT", label: "Sequence", description: "e.g. email/personal/founder-direct", icon: "IconListNumbers" },
        { name: "step", type: "NUMBER", label: "Step", icon: "IconNumber" },
        { name: "templateId", type: "TEXT", label: "Template", description: "The message file, e.g. email/personal/founder-direct/1-first-touch", icon: "IconTemplate" },
        { name: "prospectKey", type: "TEXT", label: "Prospect Key", description: "Stable identity: email, profile handle or record id", icon: "IconKey" },
        { name: "toAddress", type: "TEXT", label: "To", description: "Email address, profile or phone it went to", icon: "IconArrowRight" },
        { name: "fromAddress", type: "TEXT", label: "From", description: "Mailbox or account it came from", icon: "IconArrowLeft" },
        { name: "subject", type: "TEXT", label: "Subject", icon: "IconMail" },
        { name: "body", type: "TEXT", label: "Body", description: "The message exactly as sent", icon: "IconAlignLeft" },
        { name: "messageId", type: "TEXT", label: "Message ID", description: "Email Message-ID, for threading and reply matching", icon: "IconHash" },
        { name: "error", type: "TEXT", label: "Error", icon: "IconAlertTriangle" },
        { name: "occurredAt", type: "DATE_TIME", label: "Occurred At", icon: "IconClock" },
      ],
    },
  ],
  extensions: [
    { object: "person", optional: false, fields: [coldTrigger] },
    { object: "agencyProspect", optional: true, fields: [coldTrigger] },
  ],
  relations: [
    { object: "coldTouch", name: "person", label: "Person", icon: "IconUser", target: "person", targetFieldName: "coldTouches", targetFieldLabel: "Cold Touches", targetFieldIcon: "IconSend", optional: false },
    { object: "coldTouch", name: "company", label: "Company", icon: "IconBuildingSkyscraper", target: "company", targetFieldName: "coldTouches", targetFieldLabel: "Cold Touches", targetFieldIcon: "IconSend", optional: false },
    { object: "coldTouch", name: "agencyProspect", label: "Agency Prospect", icon: "IconBuildingStore", target: "agencyProspect", targetFieldName: "coldTouches", targetFieldLabel: "Cold Touches", targetFieldIcon: "IconSend", optional: true },
    { object: "coldTouch", name: "agencyPerson", label: "Agency Person", icon: "IconUser", target: "agencyPerson", targetFieldName: "coldTouches", targetFieldLabel: "Cold Touches", targetFieldIcon: "IconSend", optional: true },
  ],
};
