import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { CallSheet } from "../call";
import type { Touch } from "../touches";
import type { ActionResponse, Campaign, JobResponse, LeadsResponse, LibraryResponse, PlanResponse, ProspectSummary, SourceOption, StatsResponse, StatusResponse, XSendResponse } from "../web/types";
import { callScriptsText, campaignsText, jobText, leadsText, planText, prospectsText, sheetText, sourcesText, statsText, statusText, touchesText, type PlanSection } from "./helpers";
import { PAGE_SIZE, SERVER_NAME, type ApiHandler, type ResponseFormat } from "./types";

export * from "./types";
export * from "./helpers";

const ORIGIN = "http://cold.local";

const INSTRUCTIONS = `COLD is the owner's outreach app: cold email from their own mailbox, DMs, call scripts, and the touch log of everything that happened.
Start with cold_status (accounts, offers) and cold_list_campaigns (campaign ids).
Nothing goes out without the owner: cold_send_emails and cold_send_x_dm only preview unless called with confirm=true, and you call them with confirm=true only after the owner has seen that preview and said yes in this conversation.
Never send to anyone marked Do Not Contact, and treat a reply as a conversation for the owner to carry on by hand.`;

/** One call to COLD's own API, in this process; a refusal becomes the tool's error, in COLD's words. */
async function request<T>(api: ApiHandler, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await api(new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await response.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!response.ok) throw new Error((data as { error?: string }).error ?? `COLD answered ${response.status}.`);
  return data as T;
}

const params = (values: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

/** Markdown to read, or the data as JSON (text and structuredContent alike). */
function answer(format: ResponseFormat, markdown: () => string, data: unknown) {
  if (format === "json") {
    const structured = (Array.isArray(data) ? { items: data } : data) as Record<string, unknown>;
    return { content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
  }
  return { content: [{ type: "text" as const, text: markdown() }] };
}
const say = (text: string) => ({ content: [{ type: "text" as const, text }] });

const responseFormat = z.enum(["markdown", "json"]).default("markdown").describe("'markdown' to read (the default), 'json' for COLD's data as it is");
const limit = z.number().int().min(1).max(100).default(PAGE_SIZE).describe("How many to return");
const offset = z.number().int().min(0).default(0).describe("How many to skip, for the next page");
const campaign = z.string().min(1).describe("The campaign's id, from cold_list_campaigns");

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const READ_OUTSIDE = { ...READ, openWorldHint: true } as const;

/**
 * COLD as an MCP server: its campaigns, prospects, call scripts, quiz leads
 * and results to read, the touch log to add to, and sends that only go out
 * with confirm=true. Every tool calls COLD's own API, so it follows the same
 * rules as the app (caps, windows, Do Not Contact, one send per step).
 */
export function createColdMcpServer(api: ApiHandler, version = "0.0.0"): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "cold_status",
    {
      title: "COLD status",
      description: "What COLD is set up with: cold.yaml, where the touch log is, whether Twenty is connected, each account (voice, mailbox, daily caps, sending window) and each offer. Call it first to learn the account and offer keys.",
      inputSchema: z.strictObject({ response_format: responseFormat }),
      annotations: READ,
    },
    async ({ response_format }) => {
      const status = await request<StatusResponse>(api, "GET", "/api/status");
      return answer(response_format, () => statusText(status), status);
    },
  );

  server.registerTool(
    "cold_list_campaigns",
    {
      title: "List campaigns",
      description: "The owner's campaigns: id, name, sequence (email or DM), sending account, offer and prospect list. Use an id with cold_campaign_plan, cold_send_emails, cold_send_x_dm and cold_log_dm.",
      inputSchema: z.strictObject({ response_format: responseFormat }),
      annotations: READ,
    },
    async ({ response_format }) => {
      const campaigns = await request<Campaign[]>(api, "GET", "/api/campaigns");
      return answer(response_format, () => campaignsText(campaigns), campaigns);
    },
  );

  server.registerTool(
    "cold_campaign_plan",
    {
      title: "Campaign plan for today",
      description: `What a campaign would do today: who is due now (with the exact message), who is held because a message has an empty variable, who is waiting for a later step, and who is skipped and why (replied, opted out, Do Not Contact, no address...). Also today's cap, how many went out, the sending window, and anything blocking a send.

Examples:
  - "What's going out today on the tint campaign?" -> campaign=<id>
  - "Why is Dana skipped?" -> campaign=<id>, section="skipped"`,
      inputSchema: z.strictObject({
        campaign,
        section: z.enum(["due", "held", "waiting", "skipped"]).default("due").describe("Which list to show"),
        limit,
        offset,
        refresh: z.boolean().default(false).describe("Reload the prospect list from its source first (Twenty lists are kept for five minutes)"),
        response_format: responseFormat,
      }),
      annotations: READ_OUTSIDE,
    },
    async ({ campaign, section, limit, offset, refresh, response_format }) => {
      const plan = await request<PlanResponse>(api, "GET", `/api/campaigns/${encodeURIComponent(campaign)}/plan${params({ refresh: refresh ? 1 : undefined })}`);
      return answer(response_format, () => planText(plan, section as PlanSection, offset, limit), plan);
    },
  );

  server.registerTool(
    "cold_list_sources",
    {
      title: "List prospect lists",
      description: "Every prospect list COLD can read: the owner's CSV files, Twenty objects (people, the dialer's prospects, offer's quiz leads) and listening watches. Use a source id with cold_list_prospects and cold_call_sheet.",
      inputSchema: z.strictObject({ response_format: responseFormat }),
      annotations: READ,
    },
    async ({ response_format }) => {
      const sources = await request<SourceOption[]>(api, "GET", "/api/sources");
      return answer(response_format, () => sourcesText(sources), sources);
    },
  );

  server.registerTool(
    "cold_list_prospects",
    {
      title: "List prospects",
      description: `The prospects on one list: key, name and company, where they can be reached, their trigger line, and Do Not Contact. Filter with query (name, company or email contains). Use a prospect's key with cold_call_sheet, cold_send_x_dm and cold_log_dm.

Examples:
  - "Who's on my tint list?" -> source="csv:prospects.csv"
  - "Find Dana" -> source=<id>, query="dana"`,
      inputSchema: z.strictObject({
        source: z.string().min(1).describe('A source id from cold_list_sources, e.g. "csv:prospects.csv" or "twenty:agencyProspects"'),
        query: z.string().max(200).optional().describe("Only prospects whose name, company or email contains this"),
        where: z.string().max(500).optional().describe("For Twenty sources: a Twenty REST filter, e.g. city[eq]:Austin"),
        limit,
        offset,
        response_format: responseFormat,
      }),
      annotations: READ_OUTSIDE,
    },
    async ({ source, query, where, limit, offset, response_format }) => {
      const { total, prospects } = await request<{ total: number; prospects: ProspectSummary[] }>(api, "GET", `/api/prospects${params({ source, where })}`);
      const q = query?.trim().toLowerCase();
      const matching = q ? prospects.filter((p) => `${p.label} ${p.company ?? ""} ${p.email ?? ""}`.toLowerCase().includes(q)) : prospects;
      return answer(response_format, () => prospectsText(source, matching, q ? matching.length : total, offset, limit), { total: q ? matching.length : total, offset, prospects: matching.slice(offset, offset + limit) });
    },
  );

  server.registerTool(
    "cold_recent_activity",
    {
      title: "Recent activity",
      description: "The touch log, newest first: every email and DM sent, reply, opt-out, bounce and call (with the dialer's outcome) of the last days. Filter by kind or account. Use cold_stats for reply rates instead.",
      inputSchema: z.strictObject({
        days: z.number().int().min(1).max(365).default(7).describe("How many days back"),
        kinds: z.array(z.enum(["SENT", "REPLIED", "BOUNCED", "OPTED_OUT", "UNDELIVERABLE", "FAILED", "CALLED"])).optional().describe("Only these kinds"),
        account: z.string().optional().describe("Only this account's touches"),
        limit,
        offset,
        response_format: responseFormat,
      }),
      annotations: READ_OUTSIDE,
    },
    async ({ days, kinds, account, limit, offset, response_format }) => {
      const touches = await request<Touch[]>(api, "GET", `/api/touches${params({ days, kinds: kinds?.join(","), account, limit: Math.min(1000, offset + limit) })}`);
      return answer(response_format, () => touchesText(touches, days, offset, limit), touches.slice(offset, offset + limit));
    },
  );

  server.registerTool(
    "cold_stats",
    {
      title: "Results",
      description: "Reply rates of the last days: totals (sent, replies, opt-outs, bounces), each sequence (started, replied), and each message, so the owner keeps the winners.",
      inputSchema: z.strictObject({
        days: z.number().int().min(1).max(365).default(30).describe("How many days back"),
        account: z.string().optional().describe("Only this account"),
        response_format: responseFormat,
      }),
      annotations: READ_OUTSIDE,
    },
    async ({ days, account, response_format }) => {
      const stats = await request<StatsResponse>(api, "GET", `/api/stats${params({ days, account })}`);
      return answer(response_format, () => statsText(stats), stats);
    },
  );

  server.registerTool(
    "cold_list_call_scripts",
    {
      title: "List call scripts",
      description: "The call scripts in the message library: id, title, voice (personal: the owner calling; company: a rep) and when to use each. Use an id with cold_call_sheet.",
      inputSchema: z.strictObject({ response_format: responseFormat }),
      annotations: READ,
    },
    async ({ response_format }) => {
      const library = await request<LibraryResponse>(api, "GET", "/api/library");
      return answer(response_format, () => callScriptsText(library), library.callScripts);
    },
  );

  server.registerTool(
    "cold_call_sheet",
    {
      title: "Call sheet",
      description: `A call script to read from, filled in for one prospect: the opener, why you're calling, the questions, and (with include_objections) every objection with its answer. With a prospect it also says what time it is for them and whether it's inside calling hours. COLD never dials: the owner makes the call.

Examples:
  - "Prep me to call Sam" -> script="call/personal/founder-direct", source="twenty:agencyLeads", prospect=<key>`,
      inputSchema: z.strictObject({
        script: z.string().min(1).describe('A call script id from cold_list_call_scripts, e.g. "call/personal/founder-direct"'),
        source: z.string().optional().describe("The prospect's list, from cold_list_sources"),
        prospect: z.string().optional().describe("The prospect's key (or email, or a name to match), from cold_list_prospects or cold_quiz_leads"),
        include_objections: z.boolean().default(false).describe("Add every objection and its answer"),
        response_format: responseFormat,
      }),
      annotations: READ_OUTSIDE,
    },
    async ({ script, source, prospect, include_objections, response_format }) => {
      if (!!source !== !!prospect) throw new Error("Give both source and prospect, or neither for the script with example values.");
      const sheet = await request<CallSheet>(api, "GET", `/api/calls/sheet${params({ id: script, source, prospect })}`);
      return answer(response_format, () => sheetText(sheet, include_objections), sheet);
    },
  );

  server.registerTool(
    "cold_quiz_leads",
    {
      title: "Quiz leads",
      description: "The quiz leads from offer of the last days, best to call first: qualified leads nobody has called yet and who can be called now at the top. Each with their number, when they took the quiz, their answers, their local time, and how their last call went.",
      inputSchema: z.strictObject({
        days: z.number().int().min(1).max(90).default(14).describe("How many days back"),
        limit,
        offset,
        response_format: responseFormat,
      }),
      annotations: READ_OUTSIDE,
    },
    async ({ days, limit, offset, response_format }) => {
      const leads = await request<LeadsResponse>(api, "GET", `/api/leads${params({ days })}`);
      if (!leads.twenty) return say("Twenty isn't connected, and offer keeps its quiz leads there: set TWENTY_BASE_URL and TWENTY_API_KEY in Settings.");
      if (leads.error) throw new Error(`The quiz leads couldn't be read: ${leads.error}`);
      return answer(response_format, () => leadsText(leads.leads, offset, limit, days), { ...leads, leads: leads.leads.slice(offset, offset + limit) });
    },
  );

  server.registerTool(
    "cold_log_calls",
    {
      title: "Log the dialer's calls",
      description: "Bring the dialer's calls of the last two weeks into the touch log now, each with its outcome and the dialer's AI summary (it also happens every ten minutes while COLD runs). A call is logged once, however often this runs. A conversation pauses that prospect's sequences; \"do not call\" is an opt-out on every channel.",
      inputSchema: z.strictObject({ dry_run: z.boolean().default(false).describe("Only say what would be logged") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ dry_run }) => {
      const result = await request<ActionResponse>(api, "POST", "/api/calls/log", { dryRun: dry_run });
      return say([result.message, ...(result.lines ?? [])].join("\n"));
    },
  );

  server.registerTool(
    "cold_log_dm",
    {
      title: "Log a DM",
      description: `Log what happened with a DM the owner handled by hand (LinkedIn, Instagram, Facebook, or X copied by hand): SENT when they sent the campaign's due step, REPLIED when the person answered (their sequence stops), OPTED_OUT when they asked not to be contacted (nothing goes to them on any channel). Only for a prospect who is due on that campaign today (cold_campaign_plan, section "due").`,
      inputSchema: z.strictObject({
        campaign,
        prospect: z.string().min(1).describe("The prospect's key, from cold_campaign_plan"),
        outcome: z.enum(["SENT", "REPLIED", "OPTED_OUT"]).describe("What happened"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ campaign, prospect, outcome }) => {
      await request(api, "POST", `/api/campaigns/${encodeURIComponent(campaign)}/dm`, { prospect, outcome });
      return say(`Logged ${outcome.toLowerCase().replace("_", " ")} for ${prospect}.`);
    },
  );

  server.registerTool(
    "cold_send_emails",
    {
      title: "Send a campaign's emails",
      description: `Send today's due emails of an email campaign from the owner's own mailbox, at the account's pace, within its daily cap and sending window. Without confirm it only previews who would get what. Show the owner that preview and call again with confirm=true only after they say yes in this conversation: these are real emails and can't be taken back. Follow a send with cold_send_status; stop it with cold_stop_send.`,
      inputSchema: z.strictObject({
        campaign,
        confirm: z.boolean().default(false).describe("true sends for real; only after the owner approved the preview"),
        limit: z.number().int().min(1).max(500).optional().describe("Send at most this many"),
        ignore_window: z.boolean().default(false).describe("Send outside the account's sending window; only when the owner asks"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ campaign, confirm, limit: most, ignore_window }) => {
      const id = encodeURIComponent(campaign);
      if (!confirm) {
        const plan = await request<PlanResponse>(api, "GET", `/api/campaigns/${id}/plan`);
        if (plan.channel !== "email") throw new Error("This is a DM campaign: use cold_send_x_dm for X, or work through it by hand and log it with cold_log_dm.");
        const count = Math.min(plan.sendable, most ?? plan.sendable);
        const preview = planText({ ...plan, due: plan.due.slice(0, count) }, "due", 0, Math.min(count, 10));
        return say(`Preview only: nothing was sent. ${count} email${count === 1 ? "" : "s"} would go out from ${plan.account.from ?? plan.account.key}${plan.pace ? `, ${plan.pace.min}-${plan.pace.max} seconds apart` : ""}.\n\n${preview}\n\nTo send, the owner has to say yes; then call cold_send_emails again with confirm=true.`);
      }
      const { job, total } = await request<{ job: string; total: number }>(api, "POST", `/api/campaigns/${id}/send`, { ignoreWindow: ignore_window, limit: most });
      return say(`Sending ${total} email${total === 1 ? "" : "s"} (send ${job}): the first goes now, the rest at the account's pace. Follow it with cold_send_status (job="${job}"); stop it with cold_stop_send.`);
    },
  );

  server.registerTool(
    "cold_send_x_dm",
    {
      title: "Send one X DM",
      description: `Send one due X DM of an X campaign through X's API, from the X account the campaign's account is connected to. Without confirm it only shows the message that would go out. Call again with confirm=true only after the owner approved that exact message in this conversation. A follow-up is never sent to someone who has answered since: their reply is logged instead.`,
      inputSchema: z.strictObject({
        campaign,
        prospect: z.string().min(1).describe("The prospect's key, from cold_campaign_plan (section due)"),
        confirm: z.boolean().default(false).describe("true sends for real; only after the owner approved the message"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ campaign, prospect, confirm }) => {
      const id = encodeURIComponent(campaign);
      if (!confirm) {
        const plan = await request<PlanResponse>(api, "GET", `/api/campaigns/${id}/plan`);
        if (plan.channel !== "dm" || plan.platform !== "x") throw new Error("Only X DM campaigns send through X's API.");
        const row = plan.due.find((r) => r.key === prospect);
        if (!row) throw new Error("That prospect has no DM due on this campaign today: see cold_campaign_plan.");
        const ready = plan.x?.ready ? `It would go from @${plan.x.username}.` : `It can't go out yet: ${plan.x?.why ?? "X isn't set up"}.`;
        return say(`Preview only: nothing was sent. To ${row.label}${row.address ? ` (${row.address})` : ""}, step ${row.step ?? 1}:\n\n${row.text ?? ""}\n\n${ready} To send it, the owner has to approve this message; then call cold_send_x_dm again with confirm=true.`);
      }
      const sent = await request<XSendResponse>(api, "POST", `/api/campaigns/${id}/dm/x`, { prospect });
      return say(sent.message);
    },
  );

  server.registerTool(
    "cold_send_status",
    {
      title: "Send status",
      description: "How an email send is going: running or finished, how many sent, failed and skipped, and the latest events. The job id comes from cold_send_emails.",
      inputSchema: z.strictObject({ job: z.string().min(1).describe("The send's job id"), response_format: responseFormat }),
      annotations: READ,
    },
    async ({ job, response_format }) => {
      const view = await request<JobResponse>(api, "GET", `/api/jobs/${encodeURIComponent(job)}`);
      return answer(response_format, () => jobText(view), view);
    },
  );

  server.registerTool(
    "cold_stop_send",
    {
      title: "Stop a send",
      description: "Stop an email send: no further email of it goes out. Emails already sent stay sent.",
      inputSchema: z.strictObject({ job: z.string().min(1).describe("The send's job id, from cold_send_emails") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ job }) => {
      const { ok } = await request<{ ok: boolean }>(api, "POST", `/api/jobs/${encodeURIComponent(job)}/stop`, {});
      return say(ok ? `Stopped send ${job}: nothing more of it goes out.` : `Send ${job} wasn't running (it may have finished already).`);
    },
  );

  return server;
}
