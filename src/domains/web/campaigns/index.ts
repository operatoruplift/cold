import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Campaign, CampaignInput } from "../types";

/**
 * Campaigns live in .cold/campaigns.json next to the touch log: local to this
 * machine, never committed. Writes go to a temporary file first, so a crash
 * mid-write cannot leave a half-written file.
 */
export class CampaignStore {
  constructor(readonly file: string) {}

  list(): Campaign[] {
    if (!existsSync(this.file)) return [];
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as { campaigns?: Campaign[] };
      return Array.isArray(data.campaigns) ? data.campaigns : [];
    } catch {
      return [];
    }
  }

  get(id: string): Campaign | undefined {
    return this.list().find((c) => c.id === id);
  }

  create(input: CampaignInput, now = new Date()): Campaign {
    const campaign: Campaign = { ...clean(input), id: randomUUID().slice(0, 8), createdAt: now.toISOString() };
    this.write([...this.list(), campaign]);
    return campaign;
  }

  update(id: string, input: CampaignInput): Campaign | undefined {
    const all = this.list();
    const index = all.findIndex((c) => c.id === id);
    if (index === -1) return undefined;
    const updated: Campaign = { ...all[index]!, ...clean(input), id };
    all[index] = updated;
    this.write(all);
    return updated;
  }

  remove(id: string): boolean {
    const all = this.list();
    const kept = all.filter((c) => c.id !== id);
    if (kept.length === all.length) return false;
    this.write(kept);
    return true;
  }

  private write(campaigns: Campaign[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ campaigns }, null, 2)}\n`);
    renameSync(temp, this.file);
  }
}

function clean(input: CampaignInput): CampaignInput {
  return {
    name: input.name.trim(),
    sequence: input.sequence.trim(),
    account: input.account.trim(),
    offer: input.offer?.trim() || undefined,
    source: input.source.trim(),
    where: input.where?.trim() || undefined,
  };
}
