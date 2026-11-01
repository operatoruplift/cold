import { callTime, type CallTime } from "../callHours";
import type { Account, CallHours, Offer } from "../config";
import { bold, dim, green, indent, type Io } from "../cli/io";
import type { Library, Message } from "../messages";
import { buildVariables } from "../outreach";
import type { Prospect } from "../prospects";
import { renderTemplate } from "../render";
import { filterAnd, filterValue, type TwentyClient } from "../twenty";
import { scriptToPlainText, toDialerScript } from "./helpers";

export * from "./helpers";

/**
 * Write the account's call scripts into the dialer's agencyScripts: created
 * when missing, updated when present. A script is matched by its name and its
 * campaign, so a campaign gets its own copy (--campaign) and the copy with no
 * campaign is never moved onto one. The dialer then shows the script and its
 * objection answers next to every live call.
 */
export async function syncCallScripts(input: { client: TwentyClient; library: Library; account: Account; offer?: Offer; campaign?: string; dryRun: boolean; io: Io }): Promise<{ created: number; updated: number }> {
  const { client, library, account, io } = input;
  const scripts = library.callScripts.filter((s) => s.voice === account.voice);
  const variables = buildVariables(account, input.offer);

  let campaignId: string | undefined;
  if (input.campaign) {
    const campaigns = await client.list("agencyCampaigns", { filter: `name[eq]:${filterValue(input.campaign)}`, limit: 2 }).catch((err: Error) => {
      throw new Error(`Could not read agencyCampaigns (${err.message}). Is the dialer's schema in this workspace?`);
    });
    if (campaigns.length !== 1) throw new Error(campaigns.length ? `More than one campaign is named "${input.campaign}"` : `No agencyCampaign named "${input.campaign}"`);
    campaignId = campaigns[0]!.id;
  }

  const result = { created: 0, updated: 0 };
  for (const script of scripts) {
    const row = toDialerScript(script, library.objections, account.voice, variables);
    const payload: Record<string, unknown> = { name: row.name, scriptData: JSON.stringify(row.scriptData) };
    if (campaignId) payload.campaignIdId = campaignId;

    let existing;
    try {
      const sameCampaign = campaignId ? `campaignIdId[eq]:${filterValue(campaignId)}` : "campaignIdId[is]:NULL";
      existing = (await client.list("agencyScripts", { filter: filterAnd(`name[eq]:${filterValue(row.name)}`, sameCampaign), limit: 1 }))[0];
    } catch (err) {
      throw new Error(`Could not read agencyScripts: ${(err as Error).message}. Call scripts sync into the dialer (github.com/matthewdonsemail-lab/dialer); run its twenty:schema first, or use \`cold call sheet\` to print a script instead.`);
    }
    io.log(`${existing ? "update" : green("create")} ${bold(row.name)} ${dim(`(${row.scriptData.category}, ${Object.keys(row.scriptData.objection_responses).length} objections)`)}`);
    if (input.dryRun) continue;
    if (existing) {
      await client.update("agencyScripts", existing.id, payload);
      result.updated++;
    } else {
      await client.create("agencyScripts", payload);
      result.created++;
    }
  }
  io.log(input.dryRun ? dim("Dry run: nothing was written.") : `${result.created} created, ${result.updated} updated in agencyScripts.`);
  return result;
}

/** A call script filled in for reading: its sections and every objection answer. */
export interface CallSheet {
  id: string;
  title: string;
  category: string;
  voice: Message["voice"];
  when?: string;
  sections: Array<{ heading: string; text: string }>;
  objections: Array<{ objection: string; category: string; response: string }>;
  /** Variables with no value, when filled for a prospect. */
  missing: string[];
  /** Whether the prospect can be called now, in their own time. */
  callTime?: CallTime;
}

/**
 * One call script as data: the script split at its "## " headings, then
 * every objection with its answer in the script's voice. Filled in for a
 * prospect when one is given; otherwise prospect details stay as {{name}}.
 */
export function callSheetData(script: Message, library: Library, account: Account, offer: Offer | undefined, prospect?: Prospect, clock?: { hours: CallHours; now: Date }): CallSheet {
  const variables = buildVariables(account, offer, prospect);
  const mode = prospect ? "strict" : "partial";
  const missing = new Set<string>();
  const fill = (text: string, seed: string) => {
    const rendered = renderTemplate(text, variables, { mode, seed: `${prospect?.key ?? ""}|${seed}` });
    rendered.missing.forEach((m) => missing.add(m));
    return rendered.text;
  };
  const sections: CallSheet["sections"] = [];
  for (const block of fill(script.body, script.id).split(/^## /m)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const [heading, ...rest] = trimmed.split("\n");
    sections.push({ heading: heading!.trim(), text: scriptToPlainText(rest.join("\n")) });
  }
  return {
    id: script.id,
    title: script.title,
    category: script.category ?? "General",
    voice: script.voice,
    when: script.when,
    sections,
    objections: library.objections.map((o) => ({ objection: o.objection, category: o.category, response: fill(o[script.voice], o.objection) })),
    missing: [...missing],
    callTime: prospect && clock ? callTime(prospect, clock.hours, clock.now) : undefined,
  };
}

/**
 * One call script as a sheet to read from: the script, then every objection
 * with its answer, filled in for a prospect when one is given.
 */
export function callSheet(script: Message, library: Library, account: Account, offer: Offer | undefined, prospect?: Prospect, clock?: { hours: CallHours; now: Date }): string {
  const sheet = callSheetData(script, library, account, offer, prospect, clock);
  const lines = [bold(`${sheet.title}${prospect ? ` - ${prospect.label}` : ""}`), dim(`${sheet.category} | ${sheet.voice} voice | ${sheet.when ?? ""}`), ""];
  if (sheet.callTime) lines.splice(2, 0, sheet.callTime.ok === false ? bold(`Not now: ${sheet.callTime.note}`) : sheet.callTime.ok ? `Good time to call: ${sheet.callTime.note}` : sheet.callTime.note);
  for (const section of sheet.sections) lines.push(section.heading.toUpperCase(), section.text, "");
  lines.push(bold("OBJECTIONS"));
  for (const o of sheet.objections) lines.push("", `"${o.objection}"`, indent(o.response, "  "));
  return lines.join("\n");
}
