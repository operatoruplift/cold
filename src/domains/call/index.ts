import type { Account, Offer } from "../config";
import { bold, dim, green, indent, type Io } from "../cli/io";
import type { Library, Message } from "../messages";
import { buildVariables } from "../outreach";
import type { Prospect } from "../prospects";
import { renderTemplate } from "../render";
import { filterValue, type TwentyClient } from "../twenty";
import { scriptToPlainText, toDialerScript } from "./helpers";

export * from "./helpers";

/**
 * Write the account's call scripts into the dialer's agencyScripts, matched
 * by name: created when missing, updated when present. With a campaign name
 * they are attached to that dial campaign. The dialer then shows the script
 * and its objection answers next to every live call.
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
      existing = (await client.list("agencyScripts", { filter: `name[eq]:${filterValue(row.name)}`, limit: 1 }))[0];
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

/**
 * One call script as a sheet to read from: the script, then every objection
 * with its answer, filled in for a prospect when one is given.
 */
export function callSheet(script: Message, library: Library, account: Account, offer: Offer | undefined, prospect?: Prospect): string {
  const variables = buildVariables(account, offer, prospect);
  const mode = prospect ? "strict" : "partial";
  const fill = (text: string, seed: string) => renderTemplate(text, variables, { mode, seed: `${prospect?.key ?? ""}|${seed}` }).text;
  const lines = [bold(`${script.title}${prospect ? ` - ${prospect.label}` : ""}`), dim(`${script.category} | ${script.voice} voice | ${script.when ?? ""}`), ""];
  lines.push(scriptToPlainText(fill(script.body, script.id)));
  lines.push("", bold("OBJECTIONS"));
  for (const o of library.objections) lines.push("", `"${o.objection}"`, indent(fill(o[script.voice], o.objection), "  "));
  return lines.join("\n");
}
