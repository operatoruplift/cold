import { askWithResearch, hostOf, isHttp, normalizeUrl, nullable, offerBlock, prospectBlock, tag, type AiOffer, type AiProspect, type AiResult, type MessagesCall } from "../ai";
import type { Touch } from "../touches";
import type { Page } from "./pages";
import { extractJson, type LongReader } from "./subq";

export type Strength = "strong" | "moderate" | "weak";

/** What a prospect needs, and the words on their own pages that show it. */
export interface Need {
  need: string;
  /** A short quote, copied from the source. */
  evidence: string;
  /** A page's URL, or "list" or "history". */
  source: string;
  strength: Strength;
  /** Set by COLD: the source was read during diligence and, where COLD has its text, the quote is in it. */
  confirmed: boolean;
}

/** Everything diligence found about one business: what they need, what just happened, who decides, how they write. */
export interface Dossier {
  summary: string;
  offerings: string[];
  needs: Need[];
  triggers: Array<{ sentence: string; when: string | null; source: string }>;
  /** Products and vendors they visibly use. */
  tools: string[];
  people: Array<{ name: string; title: string | null; source: string }>;
  size: string | null;
  /** How the business writes about itself, in a few words: it informs the tone. */
  voice: string | null;
  risks: string[];
  /** What to ask on a first call. */
  unknowns: string[];
  /** Set by COLD: the pages read, and the ones that could not be. */
  pages: Array<{ url: string; title?: string }>;
  skipped: Array<{ url: string; reason: string }>;
  provider: "subq" | "claude";
}

const SYSTEM = `You do the diligence a good salesperson does before reaching out to one business for the first time. You get the seller's offer, what the prospect list says about the business, any history with them, and the text of pages from the business's own website. Work out what this business needs that the offer could help with, and what to watch out for.

Rules:
- Every need comes with evidence: a short quote copied exactly from a page (or from the list or the history), and where it came from: the page's URL, or "list" or "history". If you can't point to it, it isn't a need; put it under unknowns as a question instead.
- Strength is strong when the evidence states the problem or goal outright (a job post for a receptionist, reviews about slow replies), moderate when it strongly suggests it, weak when it is an inference.
- Triggers are recent, specific events, each one full sentence the sender could use ("Saw you just opened a second bay in Round Rock."), with its source.
- Tools are products and vendors they visibly use (a booking widget, a website builder, a point of sale), as named on the page.
- People are decision-makers the business itself names, with their titles.
- Voice is how the business writes about itself (formal, warm, playful, terse), in a few words, from its own pages.
- Size is what the pages show (locations, staff, years in business), never a guess.
- Risks are reasons the offer may not fit, or the timing may be wrong. Unknowns are what you would ask on a first call to confirm the need.
- Never invent a fact, a person, a number or an event. Short and well sourced beats long.`;

const JSON_SHAPE = `Reply with one JSON object and nothing else, in this shape:
{"summary": "two or three sentences", "offerings": ["..."], "needs": [{"need": "...", "evidence": "exact quote", "source": "https://... or list or history", "strength": "strong|moderate|weak"}], "triggers": [{"sentence": "...", "when": "as the source puts it, or null", "source": "https://..."}], "tools": ["..."], "people": [{"name": "...", "title": "... or null", "source": "https://..."}], "size": "... or null", "voice": "... or null", "risks": ["..."], "unknowns": ["..."]}`;

const strings = { type: "array", items: { type: "string" } };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "offerings", "needs", "triggers", "tools", "people", "size", "voice", "risks", "unknowns"],
  properties: {
    summary: { type: "string", description: "Two or three sentences: what the business is and does." },
    offerings: strings,
    needs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["need", "evidence", "source", "strength"],
        properties: {
          need: { type: "string" },
          evidence: { type: "string", description: "A short quote, copied exactly from the source." },
          source: { type: "string", description: "The page's URL, or list or history." },
          strength: { type: "string", enum: ["strong", "moderate", "weak"] },
        },
      },
    },
    triggers: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["sentence", "when", "source"], properties: { sentence: { type: "string" }, when: nullable("As the source puts it."), source: { type: "string" } } },
    },
    tools: strings,
    people: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["name", "title", "source"], properties: { name: { type: "string" }, title: nullable(), source: { type: "string" } } },
    },
    size: nullable("What the pages show, never a guess."),
    voice: nullable("How the business writes about itself, in a few words."),
    risks: strings,
    unknowns: strings,
  },
};

/* ---------------------------------------------------------------- what goes in */

const day = (iso: string) => iso.slice(0, 10);

/** The history with a prospect, one line per touch, oldest first. */
export function historyLines(touches: Touch[]): string[] {
  return [...touches]
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .slice(-20)
    .map((t) => {
      const what = `${t.kind.toLowerCase().replace("_", " ")} ${t.channel.toLowerCase()}${t.step ? ` step ${t.step}` : ""}${t.sequence ? ` (${t.sequence.split("/").pop()})` : ""}`;
      const said = t.kind === "REPLIED" && t.body ? `: "${t.body.replace(/\s+/g, " ").trim().slice(0, 300)}"` : "";
      return `${day(t.occurredAt)}: ${what}${said}`;
    });
}

const pageBlock = (pages: Page[], perPage: number) =>
  pages.map((p) => `<page url="${p.url}"${p.title ? ` title="${p.title.replace(/"/g, "'")}"` : ""}>\n${p.text.slice(0, perPage)}\n</page>`).join("\n");

function prompt(input: DiligenceInput, perPage: number): string {
  const history = historyLines(input.history);
  return (
    offerBlock(input.offer) +
    `<prospect>\n${prospectBlock(input.prospect)}\n</prospect>\n` +
    tag("history", history.join("\n")) +
    (input.pages.length ? `<website>\n${pageBlock(input.pages, perPage)}\n</website>\n` : "<website>Nothing could be read from their website.</website>\n") +
    "\nDo the diligence on this business."
  );
}

/* ---------------------------------------------------------------- what comes out */

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown) => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);
const objects = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);
const flat = (s: string) => s.toLowerCase().replace(/[“”"'’‘`*_]/g, "").replace(/\s+/g, " ").trim();

/** Diligence as the model wrote it, in COLD's shape, before its sources are checked. */
function coerce(raw: unknown): Omit<Dossier, "pages" | "skipped" | "provider"> {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    summary: text(d.summary),
    offerings: list(d.offerings).slice(0, 12),
    needs: objects(d.needs)
      .map((n) => ({ need: text(n.need), evidence: text(n.evidence), source: text(n.source), strength: (["strong", "moderate", "weak"].includes(text(n.strength)) ? text(n.strength) : "weak") as Strength, confirmed: false }))
      .filter((n) => n.need && n.source)
      .slice(0, 10),
    triggers: objects(d.triggers)
      .map((t) => ({ sentence: text(t.sentence), when: text(t.when) || null, source: text(t.source) }))
      .filter((t) => t.sentence && t.source)
      .slice(0, 8),
    tools: list(d.tools).slice(0, 12),
    people: objects(d.people)
      .map((p) => ({ name: text(p.name), title: text(p.title) || null, source: text(p.source) }))
      .filter((p) => p.name && p.source)
      .slice(0, 8),
    size: text(d.size) || null,
    voice: text(d.voice) || null,
    risks: list(d.risks).slice(0, 8),
    unknowns: list(d.unknowns).slice(0, 8),
  };
}

/**
 * Keep only what can be traced: a need, trigger or person whose source was
 * never read is dropped, and a need's quote is looked for in the page it
 * names. A quote that isn't there keeps the need, marked unconfirmed.
 */
export function checkSources(dossier: Omit<Dossier, "pages" | "skipped" | "provider">, sources: { pages: Page[]; seen?: string[]; list: string; history: string }): Omit<Dossier, "pages" | "skipped" | "provider"> {
  const byUrl = new Map(sources.pages.map((p) => [normalizeUrl(p.url), flat(`${p.title ?? ""}\n${p.description ?? ""}\n${p.text}`)]));
  const seen = new Set((sources.seen ?? []).map(normalizeUrl));
  const seenHosts = new Set((sources.seen ?? []).map(hostOf));
  const where = (source: string): { known: boolean; body?: string } => {
    const s = source.toLowerCase();
    if (s === "list") return { known: true, body: flat(sources.list) };
    if (s === "history") return { known: true, body: flat(sources.history) };
    if (!isHttp(source)) return { known: false };
    const key = normalizeUrl(source);
    if (byUrl.has(key)) return { known: true, body: byUrl.get(key) };
    return { known: seen.has(key) || seenHosts.has(hostOf(source)) };
  };
  const quoted = (body: string, evidence: string) => {
    const q = flat(evidence.replace(/^\.{3}|\.{3}$|…/g, ""));
    return !!q && body.includes(q.length > 160 ? q.slice(0, 120) : q);
  };
  return {
    ...dossier,
    needs: dossier.needs.flatMap((n) => {
      const found = where(n.source);
      if (!found.known) return [];
      return [{ ...n, confirmed: found.body === undefined ? true : quoted(found.body, n.evidence) }];
    }),
    triggers: dossier.triggers.filter((t) => where(t.source).known),
    people: dossier.people.filter((p) => where(p.source).known),
  };
}

export interface DiligenceInput {
  offer: AiOffer;
  prospect: AiProspect;
  history: Touch[];
  /** The prospect's own pages, read by COLD. */
  pages: Page[];
  skipped: Array<{ url: string; reason: string }>;
}

const sourcesOf = (input: DiligenceInput, seen?: string[]) => ({ pages: input.pages, seen, list: prospectBlock(input.prospect), history: historyLines(input.history).join("\n") });

/** Diligence with SubQ: every page COLD read, whole, in one long-context pass. */
export async function diligenceWithSubq(reader: LongReader, input: DiligenceInput): Promise<AiResult<Dossier>> {
  const answer = await reader.chat({ system: `${SYSTEM}\n\n${JSON_SHAPE}`, prompt: prompt(input, 30_000), maxTokens: 8000 });
  const checked = checkSources(coerce(extractJson(answer.text)), sourcesOf(input));
  return { output: { ...checked, pages: input.pages.map((p) => ({ url: p.url, title: p.title })), skipped: input.skipped, provider: "subq" }, model: answer.model, usage: answer.usage, seen: [] };
}

/**
 * Diligence with Claude: the pages COLD read, shortened, plus a few web
 * searches of its own for news, reviews and job posts elsewhere.
 */
export async function diligenceWithClaude(call: MessagesCall, input: DiligenceInput, model?: string): Promise<AiResult<Dossier>> {
  const result = await askWithResearch<unknown>({
    call,
    model,
    system: `${SYSTEM}\n- You can also search the web for recent news, reviews and job posts about them; cite those pages too.\n\nWhen you're done, call submit_diligence once.`,
    prompt: prompt(input, 12_000),
    effort: "medium",
    maxSearches: 3,
    maxFetches: 3,
    submit: { name: "submit_diligence", description: "Hand over the diligence on this business.", schema: SCHEMA },
  });
  const seen = result.seen.map((s) => s.url);
  const checked = checkSources(coerce(result.output), sourcesOf(input, seen));
  const pages = [...input.pages.map((p) => ({ url: p.url, title: p.title })), ...result.seen.filter((s) => !input.pages.some((p) => normalizeUrl(p.url) === normalizeUrl(s.url)))];
  return { ...result, output: { ...checked, pages, skipped: input.skipped, provider: "claude" } };
}

