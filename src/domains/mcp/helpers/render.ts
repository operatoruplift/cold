import type { QuizLead } from "../../leads";
import type { CallSheet } from "../../call";
import type { Touch } from "../../touches";
import type { Campaign, JobResponse, LibraryResponse, PlanResponse, PlanRow, ProspectSummary, SourceOption, StatsResponse, StatusResponse } from "../../web/types";
import { CHARACTER_LIMIT } from "../types";

const when = (iso: string | undefined) => (iso ? iso.slice(0, 16).replace("T", " ") + " UTC" : "");
const short = (text: string | undefined, n: number) => (text ? (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text) : "");
const quote = (text: string | undefined, n = 240) => (text ? `> ${short(text.replace(/\s+/g, " ").trim(), n)}` : "");

/**
 * One page of a list as Markdown: as many items as fit under the character
 * limit (never cut mid-item), and how to get the rest. Pure.
 */
export function page<T>(items: T[], offset: number, limit: number, line: (item: T, n: number) => string, head = ""): string {
  const end = Math.min(items.length, offset + limit);
  let shown = items.slice(offset, end);
  const build = (rows: T[]) => {
    const next = offset + rows.length;
    const tail = next < items.length ? `\n\nShowing ${offset + 1}-${next} of ${items.length}. More: call again with offset=${next}.` : items.length > rows.length ? `\n\nShowing ${offset + 1}-${next} of ${items.length}.` : "";
    return `${head}${rows.map((item, i) => line(item, offset + i + 1)).join("\n")}${tail}`;
  };
  let text = build(shown);
  while (shown.length > 1 && text.length > CHARACTER_LIMIT) {
    shown = shown.slice(0, Math.ceil(shown.length / 2));
    text = build(shown);
  }
  return items.length ? text : `${head}None.`;
}

export function statusText(s: StatusResponse): string {
  const lines = [`# COLD`, `- cold.yaml: ${s.configFile}${s.isExample ? " (the example: create your own before sending)" : ""}${s.configError ? `, error: ${s.configError}` : ""}`];
  lines.push(`- Touch log: ${"error" in s.store ? `can't open (${s.store.error})` : `${s.store.kind}, ${s.store.where}`}`);
  lines.push(`- Twenty: ${s.twenty.configured ? `connected (${s.twenty.baseUrl})` : "not connected"}`);
  lines.push("", "## Accounts");
  for (const a of s.accounts) {
    const email = a.email ? `email from ${a.email.from} (${a.email.smtpSet ? "mailbox connected" : `set ${a.email.smtpEnv}`}, ${a.email.dailyCap} a day${a.email.window ? `, ${a.email.window}` : ""})` : "no email";
    const dms = Object.entries(a.dmCaps).map(([p, n]) => `${p} ${n}`).join(", ");
    lines.push(`- ${a.key} (${a.voice} voice, ${a.senderName}): ${email}${dms ? `; DMs a day: ${dms}` : ""}`);
  }
  lines.push("", "## Offers");
  for (const o of s.offers) lines.push(`- ${o.key}${o.key === s.defaultOffer ? " (default)" : ""}: ${o.offer ?? ""}${o.audience ? `, for ${o.audience}` : ""}`);
  return lines.join("\n");
}

export function campaignsText(campaigns: Campaign[]): string {
  if (!campaigns.length) return "No campaigns yet: make one on the Campaigns page.";
  return ["# Campaigns", ...campaigns.map((c) => `- ${c.name} (id ${c.id}): ${c.sequence}, from ${c.account}${c.offer ? `, offer ${c.offer}` : ""}, list ${c.source}${c.where ? ` where ${c.where}` : ""}`)].join("\n");
}

const SECTIONS = { due: "Due now", held: "Held: a message has an empty variable", waiting: "Waiting for their next step", skipped: "Skipped" } as const;
export type PlanSection = keyof typeof SECTIONS;

function planRow(row: PlanRow, n: number, section: PlanSection): string {
  const what = [row.step ? `step ${row.step}${row.stepTitle ? ` (${row.stepTitle})` : ""}` : "", row.subject ? `"${row.subject}"` : ""].filter(Boolean).join(" ");
  const extra = section === "skipped" || section === "held" ? row.reason : section === "waiting" ? (row.dueOn ? `due ${row.dueOn}` : row.reason) : row.custom ? "an approved AI draft" : "";
  const score = row.score !== undefined ? ` [score ${row.score}${row.tier ? `, tier ${row.tier}` : ""}]` : "";
  const head = `${n}. ${row.label}${row.address ? ` <${row.address}>` : ""}${what ? `: ${what}` : ""}${extra ? `, ${extra}` : ""}${score} (prospect key: ${row.key})`;
  return section === "due" && row.text ? `${head}\n   ${quote(row.text)}` : head;
}

export function planText(plan: PlanResponse, section: PlanSection, offset: number, limit: number): string {
  const c = plan.campaign;
  const head = [
    `# ${c.name}: ${plan.channel === "dm" ? `${plan.platform ?? ""} DMs`.trim() : "email"} from ${plan.account.key}${plan.account.from ? ` (${plan.account.from})` : ""}`,
    `${plan.prospects} prospects. Due now ${plan.due.length} (${plan.sendable} fit today: ${plan.sentToday} of ${plan.cap} sent). Held ${plan.held.length}, waiting ${plan.waiting.length}, skipped ${plan.skipped.length}.`,
    plan.window ? `Sending window: ${plan.window.open ? "open" : "closed"} (${plan.window.text}).` : "",
    plan.x ? (plan.x.ready ? `X: cold_send_x_dm sends as @${plan.x.username}.` : `X: can't send through X's API: ${plan.x.why ?? "not set up"}.`) : "",
    ...(plan.blockers.length ? ["Can't send now:", ...plan.blockers.map((b) => `- ${b}`)] : []),
    "",
    `## ${SECTIONS[section]}`,
    "",
  ]
    .filter((l, i, all) => l || all[i - 1])
    .join("\n");
  return page(plan[section], offset, limit, (row, n) => planRow(row, n, section), head);
}

export function sourcesText(sources: SourceOption[]): string {
  return sources.length ? ["# Prospect lists", ...sources.map((s) => `- ${s.label}: source "${s.id}"`)].join("\n") : "No prospect lists yet: upload a CSV on the Prospects page, or connect Twenty.";
}

export function prospectsText(source: string, prospects: ProspectSummary[], total: number, offset: number, limit: number): string {
  const line = (p: ProspectSummary, n: number) => {
    const where = [p.email && `email ${p.email}`, p.xHandle && `X @${p.xHandle}`, p.linkedinUrl && `LinkedIn ${p.linkedinUrl}`, p.instagramHandle && `Instagram @${p.instagramHandle}`].filter(Boolean).join(", ");
    return `${n}. ${p.label}${p.doNotContact ? " [Do Not Contact]" : ""} (key: ${p.key})${where ? `: ${where}` : ""}${p.trigger ? `\n   Trigger: ${short(p.trigger, 200)}` : "\n   No trigger line yet."}`;
  };
  return page(prospects, offset, limit, line, `# ${source}: ${total} prospect${total === 1 ? "" : "s"}\n\n`);
}

export function touchesText(touches: Touch[], days: number, offset: number, limit: number): string {
  const line = (t: Touch, n: number) => {
    const what = t.subject ? `"${short(t.subject, 120)}"` : t.sequence ? `${t.sequence}${t.step ? ` step ${t.step}` : ""}` : "";
    return `${n}. ${when(t.occurredAt)}: ${t.kind.toLowerCase().replace("_", " ")} ${t.channel.toLowerCase()}, ${t.prospectLabel ?? t.prospectKey}${what ? `: ${what}` : ""}${t.kind === "REPLIED" && t.body ? `\n   ${quote(t.body)}` : ""}`;
  };
  return page(touches, offset, limit, line, `# Activity, last ${days} days\n\n`);
}

const rate = (replied: number, sent: number) => (sent ? `${Math.round((100 * replied) / sent)}%` : "-");

export function statsText(stats: StatsResponse): string {
  const t = stats.totals;
  return [
    `# Results, last ${stats.days} days`,
    `Sent ${t.sent}, replies ${t.replied} (${rate(t.replied, t.sent)}), opt-outs ${t.optedOut}, bounces ${t.bounced}.`,
    "",
    "## Sequences",
    ...(stats.sequences.length ? stats.sequences.map((s) => `- ${s.sequence}: started ${s.started}, replied ${s.replied} (${rate(s.replied, s.started)}), opted out ${s.optedOut}`) : ["None yet."]),
    "",
    "## Messages",
    ...(stats.templates.length ? stats.templates.map((m) => `- ${m.templateId}: sent ${m.sent}, replies ${m.replied} (${rate(m.replied, m.sent)}), opt-outs ${m.optedOut}, bounces ${m.bounced}`) : ["None yet."]),
  ].join("\n");
}

export function callScriptsText(library: LibraryResponse): string {
  return ["# Call scripts", ...library.callScripts.map((s) => `- ${s.title} (${s.voice}, ${s.category}): id "${s.id}"${s.when ? `. ${s.when}` : ""}`)].join("\n");
}

export function sheetText(sheet: CallSheet, objections: boolean): string {
  const lines = [`# ${sheet.title} (${sheet.voice} voice, ${sheet.category})`];
  if (sheet.when) lines.push(sheet.when);
  if (sheet.callTime) lines.push("", `**${sheet.callTime.ok === false ? "Not a time to call them" : sheet.callTime.ok ? "A good time to call" : "Their time zone is unknown"}:** ${sheet.callTime.note}`);
  if (sheet.missing.length) lines.push("", `Left in braces (no value for this prospect): ${sheet.missing.map((m) => `{{${m}}}`).join(", ")}.`);
  for (const s of sheet.sections) lines.push("", `## ${s.heading}`, s.text);
  if (objections) for (const o of sheet.objections) lines.push("", `### "${o.objection}"`, o.response);
  else lines.push("", `${sheet.objections.length} objection answers: call again with include_objections=true.`);
  lines.push("", "Words in [brackets] are yours to fill in live; never read them out.");
  return lines.join("\n");
}

export function leadsText(leads: QuizLead[], offset: number, limit: number, days: number): string {
  const line = (l: QuizLead, n: number) => {
    const status = l.doNotContact ? "Do Not Contact" : !l.qualified ? "disqualified" : l.calledAt ? `called ${when(l.calledAt)}${l.callOutcome ? ` (${l.callOutcome.toLowerCase()})` : ""}` : "not called yet";
    const time = l.callTime ? `; ${l.callTime.note}` : "";
    return `${n}. ${l.label}: ${l.phone ?? "no phone"}, took the quiz ${when(l.createdAt)}, ${status}${time} (prospect key: ${l.prospectKey})${l.answers.length ? `\n   Answers: ${short(l.answers.join("; "), 300)}` : ""}`;
  };
  return page(leads, offset, limit, line, `# Quiz leads, last ${days} days, best to call first\n\n`);
}

export function jobText(job: JobResponse): string {
  const count = (type: string) => job.events.filter((e) => e.type === type).length;
  const lines = [`# Send ${job.id}: ${job.status === "running" ? "still sending" : "finished"}`, `Sent ${count("sent")}, failed ${count("failed")}, skipped ${count("skipped")}.`];
  if (job.result?.aborted) lines.push(`Stopped: ${job.result.aborted}`);
  const recent = job.events.filter((e) => e.type !== "pause").slice(-15);
  if (recent.length) lines.push("", "## Latest");
  for (const e of recent) {
    if (e.type === "sent") lines.push(`- ${when(e.at)} sent step ${e.step} to ${e.label} <${e.address}>`);
    else if (e.type === "failed") lines.push(`- ${when(e.at)} failed for ${e.label} <${e.address}>: ${e.reason}${e.bounced ? " (bounced)" : ""}`);
    else if (e.type === "skipped") lines.push(`- ${when(e.at)} skipped ${e.label}: ${e.reason}`);
    else if (e.type === "stopped") lines.push(`- ${when(e.at)} stopped: ${e.reason}`);
    else if (e.type === "error") lines.push(`- ${when(e.at)} error: ${e.reason}`);
  }
  return lines.join("\n");
}
