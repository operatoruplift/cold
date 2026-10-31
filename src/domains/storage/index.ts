import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "../db";

/** A path inside your folder: forward slashes, nothing absolute, no way out of it. */
export function safePath(p: string): string {
  const clean = p.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (!clean || clean.startsWith("/") || /^[a-z]:/i.test(clean) || clean.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Not a path inside your folder: ${p}`);
  }
  return clean;
}

/**
 * Your own files: cold.yaml, the message library, prospect lists, campaigns.
 * On your computer they are files in your folder, where the command line
 * reads them too; on Vercel they are rows in the database, because a
 * function there has no disk that lasts.
 */
export interface Files {
  /** "the database", or the folder: for messages that say where something went. */
  readonly where: string;
  /** A path as you would recognise it in a message. */
  display(path: string): string;
  read(path: string): Promise<string | undefined>;
  /** Every file under a folder with its content, in one go. */
  readAll(dir: string): Promise<Map<string, string>>;
  write(path: string, content: string): Promise<void>;
  /** Several files at once (a first copy of the message library). */
  writeAll(entries: Array<[path: string, content: string]>): Promise<void>;
  remove(path: string): Promise<boolean>;
  /** Files in a folder ("" for the top), sorted; with deep, everything under it too. */
  list(dir?: string, options?: { deep?: boolean }): Promise<string[]>;
}

export class DiskFiles implements Files {
  constructor(readonly root: string) {}

  get where(): string {
    return this.root;
  }

  full(p: string): string {
    return path.join(this.root, safePath(p));
  }

  /** Paths inside your folder, as the app shows them: "cold.yaml", "prospects-austin.csv". */
  display(p: string): string {
    return safePath(p);
  }

  async read(p: string): Promise<string | undefined> {
    const file = this.full(p);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  }

  async readAll(dir: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const p of await this.list(dir, { deep: true })) out.set(p, readFileSync(this.full(p), "utf8"));
    return out;
  }

  /** Written to a temporary file first, so a crash mid-write cannot leave half a file. */
  async write(p: string, content: string): Promise<void> {
    const file = this.full(p);
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temp, content);
    renameSync(temp, file);
  }

  async writeAll(entries: Array<[string, string]>): Promise<void> {
    for (const [p, content] of entries) await this.write(p, content);
  }

  async remove(p: string): Promise<boolean> {
    const file = this.full(p);
    if (!existsSync(file)) return false;
    rmSync(file);
    return true;
  }

  async list(dir = "", options: { deep?: boolean } = {}): Promise<string[]> {
    const base = dir ? this.full(dir) : this.root;
    if (!existsSync(base)) return [];
    const walk = (folder: string): string[] =>
      readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) return options.deep && !entry.name.startsWith(".") && entry.name !== "node_modules" ? walk(full) : [];
        return entry.isFile() ? [full] : [];
      });
    return walk(base)
      .map((file) => path.relative(this.root, file).split(path.sep).join("/"))
      .sort();
  }
}

/** Your files as rows of the database's files table. Every change bumps data_version, so other servers drop what they cached. */
export class DbFiles implements Files {
  readonly where = "the database";

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  display(p: string): string {
    return `${safePath(p)} (in the database)`;
  }

  async read(p: string): Promise<string | undefined> {
    return (await this.db.get<{ content: string }>("SELECT content FROM files WHERE path = ?", safePath(p)))?.content;
  }

  async readAll(dir: string): Promise<Map<string, string>> {
    const prefix = `${safePath(dir)}/`;
    const rows = await this.db.all<{ path: string; content: string }>("SELECT path, content FROM files WHERE substr(path, 1, ?) = ? ORDER BY path", prefix.length, prefix);
    return new Map(rows.map((r) => [r.path, r.content]));
  }

  async write(p: string, content: string): Promise<void> {
    await this.writeAll([[p, content]]);
  }

  async writeAll(entries: Array<[string, string]>): Promise<void> {
    if (!entries.length) return;
    const at = this.now().toISOString();
    await this.db.batch([
      ...entries.map(([p, content]) => ["INSERT INTO files (path, content, updated_at) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at", safePath(p), content, at] as [string, string, string, string]),
      bumpVersion("data_version"),
    ]);
  }

  async remove(p: string): Promise<boolean> {
    const found = await this.db.get("SELECT 1 AS found FROM files WHERE path = ?", safePath(p));
    if (!found) return false;
    await this.db.batch([["DELETE FROM files WHERE path = ?", safePath(p)], bumpVersion("data_version")]);
    return true;
  }

  async list(dir = "", options: { deep?: boolean } = {}): Promise<string[]> {
    const prefix = dir ? `${safePath(dir)}/` : "";
    const rows = await this.db.all<{ path: string }>("SELECT path FROM files WHERE substr(path, 1, ?) = ? ORDER BY path", prefix.length, prefix);
    return rows.map((r) => r.path).filter((p) => options.deep || !p.slice(prefix.length).includes("/"));
  }
}

/** A meta row that changes whenever something it stands for does. */
export const bumpVersion = (key: "data_version" | "secrets_version"): [string, string, string] => [
  "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  key,
  randomUUID(),
];

/**
 * The keys and passwords you save in Settings: SMTP and IMAP URLs, the Twenty
 * and Anthropic keys. On your computer they go to .env.local; on Vercel into
 * the database, encrypted with COLD_SECRET_KEY, which lives only in Vercel's
 * environment settings.
 */
export interface Secrets {
  /** For the message after saving: ".env.local", or "the database (encrypted)". */
  readonly where: string;
  /** Save values (an empty one removes the key) and use them on this server straight away. */
  save(values: Record<string, string>): Promise<void>;
  /** Pick up what another server saved. */
  refresh(): Promise<void>;
}

/** Replace or remove KEY=value lines in an env file, keeping everything else as it is. */
export function writeEnvFile(file: string, values: Record<string, string>): void {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  for (const [name, value] of Object.entries(values)) {
    const index = lines.findIndex((l) => new RegExp(`^\\s*${name}\\s*=`).test(l));
    const quoted = /[\s#"']/.test(value) ? JSON.stringify(value) : value;
    if (!value) {
      if (index !== -1) lines.splice(index, 1);
    } else if (index !== -1) lines[index] = `${name}=${quoted}`;
    else lines.push(`${name}=${quoted}`);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${lines.filter((l, i) => l.trim() || i < lines.length - 1).join("\n").trim()}\n`);
}

export class EnvFileSecrets implements Secrets {
  readonly where = ".env.local";

  constructor(private readonly file: string) {}

  async save(values: Record<string, string>): Promise<void> {
    writeEnvFile(this.file, values);
    for (const [name, value] of Object.entries(values)) {
      if (value) process.env[name] = value;
      else delete process.env[name];
    }
  }

  async refresh(): Promise<void> {
    // Read once at start (loadEnvFiles); only this server writes the file.
  }
}

/** AES-256-GCM with the key name bound in, so a value cannot be moved to another key. */
function seal(key: Buffer, name: string, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

function unseal(key: Buffer, name: string, sealed: string): string {
  const [version, iv, tag, body] = sealed.split(":");
  if (version !== "v1" || !iv || !tag || body === undefined) throw new Error(`${name} is not stored in a form this version can read.`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(name));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

/** The encryption key from COLD_SECRET_KEY: any long random string. */
export function secretKey(env: Record<string, string | undefined> = process.env): Buffer | undefined {
  const raw = env.COLD_SECRET_KEY?.trim();
  if (!raw) return undefined;
  if (raw.length < 32) throw new Error("COLD_SECRET_KEY is too short: use at least 32 random characters.");
  return createHash("sha256").update(raw).digest();
}

export class DbSecrets implements Secrets {
  readonly where = "the database (encrypted)";
  private version?: string;
  /** What this server's environment said before any saved value replaced it. */
  private readonly original = new Map<string, string | undefined>();

  constructor(
    private readonly db: Db,
    private readonly key: Buffer | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private requireKey(): Buffer {
    if (!this.key) throw new Error("Saving keys here needs COLD_SECRET_KEY in the server's environment (Vercel, Settings, Environment Variables). Add it, redeploy, and save again.");
    return this.key;
  }

  async save(values: Record<string, string>): Promise<void> {
    const key = this.requireKey();
    const at = this.now().toISOString();
    await this.db.batch([
      ...Object.entries(values).map(([name, value]): [string, ...string[]] =>
        value ? ["INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", name, seal(key, name, value), at] : ["DELETE FROM secrets WHERE name = ?", name],
      ),
      bumpVersion("secrets_version"),
    ]);
    this.version = undefined;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const version = (await this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'secrets_version'"))?.value ?? "";
    if (version === this.version) return;
    const rows = await this.db.all<{ name: string; value: string }>("SELECT name, value FROM secrets");
    const saved = new Map<string, string>();
    if (rows.length) {
      const key = this.requireKey();
      for (const row of rows) saved.set(row.name, unseal(key, row.name, row.value));
    }
    // Names saved before but removed since go back to what the environment had.
    for (const [name, value] of this.original) {
      if (saved.has(name)) continue;
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      this.original.delete(name);
    }
    for (const [name, value] of saved) {
      if (!this.original.has(name)) this.original.set(name, process.env[name]);
      process.env[name] = value;
    }
    this.version = version;
  }
}
