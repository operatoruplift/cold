import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { lintMessage, lintObjections, lintSequences, toMessage, toSequences } from "./helpers";
import type { Library, LintIssue, Message, Sequence } from "./types";

export * from "./types";
export * from "./helpers";

/** messages/ at the repository root. */
export const MESSAGES_DIR = path.resolve(import.meta.dir, "../../../messages");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/**
 * Read every message under messages/ and lint it. Messages with errors are
 * left out of the library and reported in `issues`, so a broken file never
 * gets sent.
 */
export function loadLibrary(root = MESSAGES_DIR): { library: Library; issues: LintIssue[] } {
  const issues: LintIssue[] = [];
  const messages: Message[] = [];
  const display = (file: string) => path.join("messages", path.relative(root, file));

  for (const file of walk(root).sort()) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (!rel.endsWith(".md") || rel === "README.md" || path.basename(rel) === "README.md") continue;
    const { message, issues: found } = toMessage(rel, readFileSync(file, "utf8"), display(file));
    issues.push(...found);
    if (!message) continue;
    const lint = lintMessage(message);
    issues.push(...lint);
    if (!lint.some((i) => i.level === "error")) messages.push(message);
  }

  const sequences = toSequences(messages);
  issues.push(...lintSequences(sequences));

  const objectionsFile = path.join(root, "call", "objections.yaml");
  let objections: Library["objections"] = [];
  if (existsSync(objectionsFile)) {
    const result = lintObjections(parse(readFileSync(objectionsFile, "utf8")), display(objectionsFile));
    objections = result.objections;
    issues.push(...result.issues);
  }

  return {
    library: { messages, sequences, callScripts: messages.filter((m) => m.channel === "call"), objections },
    issues,
  };
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
