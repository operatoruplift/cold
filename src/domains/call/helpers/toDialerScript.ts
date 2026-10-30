import type { Message, Objection, Voice } from "../../messages";
import { renderTemplate, type Variables } from "../../render";

/** The dialer's agencyScripts.scriptData, as its script viewer reads it. */
export interface DialerScriptData {
  category: string;
  content: string;
  objection_responses: Record<string, { category: string; response: string }>;
}

/**
 * Markdown to the plain text the dialer shows (it renders scriptData.content
 * with whitespace preserved, not as Markdown): "## Opener" becomes "OPENER",
 * emphasis markers go, lists stay. Pure.
 */
export function scriptToPlainText(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading) return heading[1]!.trim().toUpperCase();
      return line.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/^>\s?/, "");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A call script as an agencyScripts row for the dialer, named with its voice
 * ("Voicemail (personal)", "Voicemail (company)") so the two never overwrite
 * each other. Account and offer variables are filled in; prospect variables
 * ({{first_name}}, {{company}}) stay in braces for the rep to read off the
 * contact on screen. Pure.
 */
export function toDialerScript(script: Message, objections: Objection[], voice: Voice, variables: Variables): { name: string; scriptData: DialerScriptData } {
  const partial = (text: string, seed: string) => renderTemplate(text, variables, { mode: "partial", seed }).text;
  return {
    name: `${script.title} (${voice})`,
    scriptData: {
      category: script.category ?? "General",
      content: scriptToPlainText(partial(script.body, script.id)),
      objection_responses: Object.fromEntries(objections.map((o) => [o.objection, { category: o.category, response: partial(o[voice], `${script.id}|${o.objection}`) }])),
    },
  };
}
