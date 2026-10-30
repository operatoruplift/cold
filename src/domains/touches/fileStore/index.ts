import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Touch, TouchStore } from "../types";

const SUPPRESSING = new Set(["OPTED_OUT", "BOUNCED", "UNDELIVERABLE"]);

/**
 * The touch log as JSON lines in a local file (.cold/touches.jsonl). Used
 * when Twenty is not configured, and in tests. Append-only.
 */
export class FileStore implements TouchStore {
  readonly kind = "file" as const;

  constructor(readonly file: string) {}

  get where(): string {
    const relative = path.relative(process.cwd(), this.file);
    return relative && !relative.startsWith("..") ? relative : this.file;
  }

  private all(): Touch[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Touch];
        } catch {
          return [];
        }
      });
  }

  async record(touch: Touch): Promise<void> {
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(touch)}\n`);
  }

  async forProspects(identities: string[]): Promise<Touch[]> {
    const ids = new Set(identities);
    return this.all().filter((t) => ids.has(t.prospectKey) || (!!t.toAddress && ids.has(`email:${t.toAddress.toLowerCase()}`)));
  }

  async suppressions(): Promise<Touch[]> {
    return this.all().filter((t) => SUPPRESSING.has(t.kind));
  }

  async since(isoTime: string, filter: { account?: string; channel?: Touch["channel"]; kind?: Touch["kind"] } = {}): Promise<Touch[]> {
    return this.all().filter(
      (t) =>
        t.occurredAt >= isoTime &&
        (!filter.account || t.account === filter.account) &&
        (!filter.channel || t.channel === filter.channel) &&
        (!filter.kind || t.kind === filter.kind),
    );
  }

  async markDoNotContact(): Promise<void> {
    // Nothing to mark: a file has no source records. The OPTED_OUT touch is the record.
  }
}
