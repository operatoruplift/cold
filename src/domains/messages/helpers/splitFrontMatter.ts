import { parse } from "yaml";

export interface FrontMatter {
  data: Record<string, unknown>;
  body: string;
  error?: string;
}

/** Split "---\nyaml\n---\nbody". Pure. */
export function splitFrontMatter(source: string): FrontMatter {
  const text = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { data: {}, body: text.trim(), error: "missing front matter: start the file with a --- line" };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: text.trim(), error: "front matter is never closed: add a --- line after it" };
  const body = text.slice(end + 4).replace(/^[^\n]*\n?/, "").replace(/^\n+/, "").replace(/\s+$/, "");
  try {
    const data: unknown = parse(text.slice(4, end)) ?? {};
    if (typeof data !== "object" || Array.isArray(data)) return { data: {}, body, error: "front matter must be key: value lines" };
    return { data: data as Record<string, unknown>, body };
  } catch (err) {
    return { data: {}, body, error: `front matter is not valid YAML: ${(err as Error).message.split("\n")[0]}` };
  }
}
