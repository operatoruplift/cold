import { createHash, randomBytes } from "node:crypto";
import { metaValue, type Db } from "../db";

export const WAITLIST_CHANNELS = ["email", "dm", "calls", "prospecting"] as const;
export type WaitlistChannel = (typeof WAITLIST_CHANNELS)[number];
export const WAITLIST_STATUSES = ["waiting", "invited", "archived"] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

export interface WaitlistSignup {
  email: string;
  name?: string;
  company?: string;
  role?: string;
  channels: WaitlistChannel[];
  note?: string;
  /** Where they came from: utm_source and friends, as one short string. */
  source?: string;
  referrer?: string;
}

export interface WaitlistEntry extends WaitlistSignup {
  id: number;
  status: WaitlistStatus;
  ownerNote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WaitlistCounts {
  total: number;
  waiting: number;
  invited: number;
  archived: number;
  lastWeek: number;
}

interface Row {
  id: number;
  email: string;
  name: string | null;
  company: string | null;
  role: string | null;
  channels: string | null;
  note: string | null;
  source: string | null;
  referrer: string | null;
  status: WaitlistStatus;
  owner_note: string | null;
  created_at: string;
  updated_at: string;
}

/** Fill-in time below which a form was almost certainly not typed by a person. */
const MIN_FILL_MS = 1500;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/**
 * Check a signup from the landing page. `spam` means a bot filled the hidden
 * field or submitted faster than a person can: answer as if it worked, store nothing.
 */
export function parseSignup(body: unknown): { signup?: WaitlistSignup; error?: string; spam?: boolean } {
  if (!body || typeof body !== "object") return { error: "Send the form as JSON." };
  const b = body as Record<string, unknown>;
  if (typeof b.website === "string" && b.website.trim()) return { spam: true };
  if (typeof b.elapsedMs === "number" && b.elapsedMs < MIN_FILL_MS) return { spam: true };
  const email = text(b.email, 254)?.toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { error: "Enter a valid work email." };
  const channels = Array.isArray(b.channels) ? WAITLIST_CHANNELS.filter((c) => (b.channels as unknown[]).includes(c)) : [];
  return {
    signup: {
      email,
      name: text(b.name, 120),
      company: text(b.company, 120),
      role: text(b.role, 80),
      channels,
      note: typeof b.note === "string" ? b.note.trim().slice(0, 1000) || undefined : undefined,
      source: text(b.source, 200),
      referrer: text(b.referrer, 500),
    },
  };
}

function toEntry(row: Row): WaitlistEntry {
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? undefined,
    company: row.company ?? undefined,
    role: row.role ?? undefined,
    channels: (row.channels ? row.channels.split(",") : []).filter((c): c is WaitlistChannel => (WAITLIST_CHANNELS as readonly string[]).includes(c)),
    note: row.note ?? undefined,
    source: row.source ?? undefined,
    referrer: row.referrer ?? undefined,
    status: row.status,
    ownerNote: row.owner_note ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A spreadsheet cell: quoted, and never read as a formula. */
function cell(value: string | number | undefined): string {
  let s = value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** People who asked to hear when COLD opens up, in the app's database. */
export class Waitlist {
  private salt?: Promise<string>;

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Enough to notice many signups from one address, without keeping the address. */
  async ipHash(ip: string | undefined): Promise<string | undefined> {
    if (!ip) return undefined;
    this.salt ??= metaValue(this.db, "waitlist_ip_salt", () => randomBytes(16).toString("hex"));
    return createHash("sha256").update(`${await this.salt}:${ip}`).digest("hex").slice(0, 16);
  }

  /** Add someone. Signing up twice keeps the first entry and fills in anything it lacked. */
  async join(signup: WaitlistSignup, meta: { ip?: string; userAgent?: string | null } = {}): Promise<{ created: boolean }> {
    const at = this.now().toISOString();
    const existing = await this.db.get<{ id: number }>("SELECT id FROM waitlist WHERE email = ?", signup.email);
    if (existing) {
      await this.db.run(
        `UPDATE waitlist SET name = COALESCE(name, ?), company = COALESCE(company, ?), role = COALESCE(role, ?),
           channels = COALESCE(NULLIF(channels, ''), ?), note = COALESCE(note, ?), updated_at = ? WHERE id = ?`,
        signup.name ?? null,
        signup.company ?? null,
        signup.role ?? null,
        signup.channels.join(","),
        signup.note ?? null,
        at,
        existing.id,
      );
      return { created: false };
    }
    // Two signups for one address at the same moment: the second fills in the first.
    const inserted = await this.db.run(
      `INSERT INTO waitlist (email, name, company, role, channels, note, source, referrer, ip_hash, user_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (email) DO NOTHING`,
      signup.email,
        signup.name ?? null,
        signup.company ?? null,
        signup.role ?? null,
        signup.channels.join(","),
        signup.note ?? null,
        signup.source ?? null,
      signup.referrer ?? null,
      (await this.ipHash(meta.ip)) ?? null,
      meta.userAgent?.slice(0, 300) ?? null,
      at,
      at,
    );
    return { created: inserted.changes > 0 };
  }

  async list(filter: { q?: string; status?: string } = {}): Promise<WaitlistEntry[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.status && (WAITLIST_STATUSES as readonly string[]).includes(filter.status)) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.q?.trim()) {
      where.push("(email LIKE ? OR name LIKE ? OR company LIKE ? OR role LIKE ?)");
      const like = `%${filter.q.trim().replace(/[%_]/g, "")}%`;
      params.push(like, like, like, like);
    }
    const sql = `SELECT * FROM waitlist ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC`;
    return (await this.db.all<Row>(sql, ...params)).map(toEntry);
  }

  async counts(): Promise<WaitlistCounts> {
    const weekAgo = new Date(this.now().getTime() - 7 * 86_400_000).toISOString();
    const row = await this.db.get<WaitlistCounts>(
      `SELECT COUNT(*) AS total,
         COALESCE(SUM(status = 'waiting'), 0) AS waiting,
         COALESCE(SUM(status = 'invited'), 0) AS invited,
         COALESCE(SUM(status = 'archived'), 0) AS archived,
         COALESCE(SUM(created_at >= ?), 0) AS lastWeek
       FROM waitlist`,
      weekAgo,
    );
    return row!;
  }

  async update(id: number, patch: { status?: string; ownerNote?: string }): Promise<WaitlistEntry> {
    const current = await this.db.get<Row>("SELECT * FROM waitlist WHERE id = ?", id);
    if (!current) throw new Error("No such person on the waitlist.");
    const status = patch.status ?? current.status;
    if (!(WAITLIST_STATUSES as readonly string[]).includes(status)) throw new Error(`Status must be one of ${WAITLIST_STATUSES.join(", ")}.`);
    const ownerNote = patch.ownerNote === undefined ? current.owner_note : patch.ownerNote.trim().slice(0, 1000) || null;
    await this.db.run("UPDATE waitlist SET status = ?, owner_note = ?, updated_at = ? WHERE id = ?", status, ownerNote, this.now().toISOString(), id);
    return toEntry((await this.db.get<Row>("SELECT * FROM waitlist WHERE id = ?", id))!);
  }

  async remove(id: number): Promise<boolean> {
    return (await this.db.run("DELETE FROM waitlist WHERE id = ?", id)).changes > 0;
  }

  async csv(): Promise<string> {
    const header = ["email", "name", "company", "role", "channels", "note", "status", "owner_note", "source", "referrer", "joined"];
    const rows = (await this.list()).map((e) =>
      [e.email, e.name, e.company, e.role, e.channels.join(" "), e.note, e.status, e.ownerNote, e.source, e.referrer, e.createdAt].map(cell).join(","),
    );
    return [header.join(","), ...rows].join("\n") + "\n";
  }
}
