import { callTime, type CallTime } from "../callHours";
import type { Account, CallHours, Offer } from "../config";
import { bold, dim, green, indent, type Io } from "../cli/io";
import type { Library, Message } from "../messages";
import { buildVariables } from "../outreach";
import type { Prospect } from "../prospects";
import { renderTemplate } from "../render";
import type { Touch, TouchStore } from "../touches";
import { filterAnd, filterValue, type TwentyClient } from "../twenty";
import { callProspectKey, callSettled, callTouch, scriptToPlainText, toDialerScript } from "./helpers";

export * from "./helpers";

/** What logging the dialer's calls did. */
export interface CallOutcomeSync {
  /** Calls logged now (or that would be, on a dry run), oldest first. */
  logged: Touch[];
  /** Calls already in the touch log. */
  known: number;
  /** Calls still in progress, or whose outcome or AI reading may still change. */
  pending: number;
  /** Calls with an outcome but no prospect or lead to tie them to. */
  unlinked: number;
}

/**
 * Log the dialer's calls into the touch log: every call of the last days
 * with an outcome, once it has settled, as one touch each (see callTouch),
 * named after the business or lead it was with. A call already logged (by
 * its id) is left alone, so this runs as often as you like. Do not call
 * marks the dialer's prospect Do Not Contact too.
 */
export async function syncCallOutcomes(input: { client: TwentyClient; store: TouchStore; now: Date; days?: number; dryRun?: boolean }): Promise<CallOutcomeSync> {
  const { client, store, now } = input;
  const since = new Date(now.getTime() - (input.days ?? 14) * 86_400_000);
  const calls = (await client.list("agencyCalls", { filter: filterAnd(`createdAt[gte]:${filterValue(since.toISOString())}`, "disposition[is]:NOT_NULL") })).sort((a, b) =>
    String(a.startedAt ?? a.createdAt ?? "").localeCompare(String(b.startedAt ?? b.createdAt ?? "")),
  );
  const result: CallOutcomeSync = { logged: [], known: 0, pending: 0, unlinked: 0 };
  if (!calls.length) return result;
  const logged = new Set((await store.since(new Date(since.getTime() - 86_400_000).toISOString(), { channel: "CALL" })).map((t) => t.messageId));
  const names = new Map<string, string>();
  const prospectIds = calls.map((c) => c.agencyProspectId as string).filter(Boolean);
  const leadIds = calls.filter((c) => !c.agencyProspectId).map((c) => c.agencyLeadId as string).filter(Boolean);
  for (const r of prospectIds.length ? await client.getMany("agencyProspects", prospectIds) : []) if (typeof r.name === "string") names.set(`agencyProspect:${r.id}`, r.name);
  for (const r of leadIds.length ? await client.getMany("agencyLeads", leadIds) : []) {
    const name = typeof r.contactName === "string" && r.contactName.trim() ? r.contactName : r.name;
    if (typeof name === "string") names.set(`agencyLeads:${r.id}`, name);
  }
  for (const call of calls) {
    if (logged.has(`agencyCall:${call.id}`)) {
      result.known++;
      continue;
    }
    if (!callSettled(call, now)) {
      result.pending++;
      continue;
    }
    const key = callProspectKey(call);
    const touch = callTouch(call, key ? names.get(key) : undefined);
    if (!touch) {
      result.unlinked++;
      continue;
    }
    if (!input.dryRun) {
      await store.record(touch);
      if (touch.kind === "OPTED_OUT") await store.markDoNotContact(touch.links);
    }
    result.logged.push(touch);
  }
  return result;
}

/** One line per logged call, for the CLI and the app. */
export function callOutcomeLines(sync: CallOutcomeSync): string[] {
  return [
    ...sync.logged.map((t) => `${t.occurredAt.slice(0, 16).replace("T", " ")}  ${t.prospectLabel ?? t.prospectKey}: ${t.subject}`),
    ...(sync.pending ? [`${sync.pending} call${sync.pending === 1 ? "" : "s"} still settling: logged on a later run.`] : []),
    ...(sync.unlinked ? [`${sync.unlinked} call${sync.unlinked === 1 ? "" : "s"} with no prospect or lead in the dialer: not logged.`] : []),
  ];
}

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
