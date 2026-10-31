import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { APP_ROOT } from "../config/root";
import type { Files } from "../storage";
import { lintMessage, lintObjections, lintSequences, toMessage, toSequences } from "./helpers";
import type { Library, LintIssue, Message, Sequence } from "./types";

export * from "./types";
export * from "./helpers";

/** The library that ships with COLD. */
export const BUNDLED_MESSAGES = path.join(APP_ROOT, "messages");

/** messages/ in the repository, or a copy under COLD_HOME so edits made on a server outlive a redeploy. */
export const MESSAGES_DIR = process.env.COLD_HOME ? path.join(path.resolve(process.env.COLD_HOME), "messages") : BUNDLED_MESSAGES;

/** Under COLD_HOME, start from a copy of the bundled library the first time. */
export function seedMessages(): void {
  if (MESSAGES_DIR !== BUNDLED_MESSAGES && !existsSync(MESSAGES_DIR)) cpSync(BUNDLED_MESSAGES, MESSAGES_DIR, { recursive: true });
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/**
 * Lint every message and build the library from the files under messages/
 * (paths inside it, with their text). Messages with errors are left out and
 * reported in `issues`, so a broken file never gets sent.
 */
function buildLibrary(sources: Map<string, string>): { library: Library; issues: LintIssue[] } {
  const issues: LintIssue[] = [];
  const messages: Message[] = [];
  const display = (rel: string) => `messages/${rel}`;

  for (const rel of [...sources.keys()].sort()) {
    if (!rel.endsWith(".md") || path.posix.basename(rel) === "README.md") continue;
    const { message, issues: found } = toMessage(rel, sources.get(rel)!, display(rel));
    issues.push(...found);
    if (!message) continue;
    const lint = lintMessage(message);
    issues.push(...lint);
    if (!lint.some((i) => i.level === "error")) messages.push(message);
  }

  const sequences = toSequences(messages);
  issues.push(...lintSequences(sequences));

  let objections: Library["objections"] = [];
  const objectionsSource = sources.get("call/objections.yaml");
  if (objectionsSource !== undefined) {
    const result = lintObjections(parse(objectionsSource), display("call/objections.yaml"));
    objections = result.objections;
    issues.push(...result.issues);
  }

  return {
    library: { messages, sequences, callScripts: messages.filter((m) => m.channel === "call"), objections },
    issues,
  };
}

const isLibraryFile = (rel: string) => rel.endsWith(".md") || rel === "call/objections.yaml";

/** Read every message under a messages folder on disk and lint it. */
export function loadLibrary(root = MESSAGES_DIR): { library: Library; issues: LintIssue[] } {
  const sources = new Map<string, string>();
  for (const file of walk(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (isLibraryFile(rel)) sources.set(rel, readFileSync(file, "utf8"));
  }
  return buildLibrary(sources);
}

/** The library from your files (messages/ in them): the database on a server without a disk. */
export async function loadLibraryFrom(files: Files, dir = "messages"): Promise<{ library: Library; issues: LintIssue[] }> {
  const sources = new Map<string, string>();
  for (const [p, text] of await files.readAll(dir)) {
    const rel = p.slice(dir.length + 1);
    if (isLibraryFile(rel)) sources.set(rel, text);
  }
  return buildLibrary(sources);
}

/** On a server without a disk, start from a copy of the bundled library, as COLD_HOME does on disk. */
export async function seedMessagesInto(files: Files, dir = "messages"): Promise<void> {
  if ((await files.list(dir, { deep: true })).length) return;
  await files.writeAll(walk(BUNDLED_MESSAGES).map((file): [string, string] => [`${dir}/${path.relative(BUNDLED_MESSAGES, file).split(path.sep).join("/")}`, readFileSync(file, "utf8")]));
}

/** Find a sequence by id, or by a unique suffix ("founder-direct" -> "email/personal/founder-direct"). */
export function findSequence(library: Library, query: string): Sequence | undefined {
  const exact = library.sequences.find((s) => s.id === query);
  if (exact) return exact;
  const matches = library.sequences.filter((s) => s.id.endsWith(`/${query}`));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Find a single message (or call script) by id, or by a unique suffix. */
export function findMessage(library: Library, query: string): Message | undefined {
  const exact = library.messages.find((m) => m.id === query);
  if (exact) return exact;
  const matches = library.messages.filter((m) => m.id.endsWith(`/${query}`));
  return matches.length === 1 ? matches[0] : undefined;
}
