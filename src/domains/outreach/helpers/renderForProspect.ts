import type { Message } from "../../messages";
import { renderTemplate, type Variables } from "../../render";

export interface RenderedMessage {
  subject?: string;
  body: string;
  /** Variables with no value: the message must not be sent. */
  missing: string[];
}

/**
 * Render a message for one prospect, strictly. The seed is the prospect's
 * key plus the message id, so variants are stable per prospect and differ
 * between steps.
 */
export function renderForProspect(message: Message, variables: Variables, prospectKey: string): RenderedMessage {
  const seed = `${prospectKey}|${message.id}`;
  const body = renderTemplate(message.body, variables, { mode: "strict", seed });
  const subject = message.subject ? renderTemplate(message.subject, variables, { mode: "strict", seed }) : undefined;
  const missing = [...new Set([...body.missing, ...(subject?.missing ?? [])])];
  return { subject: subject?.text, body: body.text, missing };
}
