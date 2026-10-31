import { randomUUID } from "node:crypto";
import type { Files } from "../../storage";
import type { Campaign, CampaignInput } from "../types";

/**
 * Campaigns live in .cold/campaigns.json next to the touch log: local to this
 * machine, never committed (on a server without a disk, the same file in the
 * database). Files are written whole through a temporary copy, so a crash
 * mid-write cannot leave half a file.
 */
export class CampaignStore {
  constructor(
    private readonly files: Files,
    readonly path = ".cold/campaigns.json",
  ) {}

  async list(): Promise<Campaign[]> {
    const text = await this.files.read(this.path);
    if (!text) return [];
    try {
      const data = JSON.parse(text) as { campaigns?: Campaign[] };
      return Array.isArray(data.campaigns) ? data.campaigns : [];
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<Campaign | undefined> {
    return (await this.list()).find((c) => c.id === id);
  }

  async create(input: CampaignInput, now = new Date()): Promise<Campaign> {
    const campaign: Campaign = { ...clean(input), id: randomUUID().slice(0, 8), createdAt: now.toISOString() };
    await this.write([...(await this.list()), campaign]);
    return campaign;
  }

  async update(id: string, input: CampaignInput): Promise<Campaign | undefined> {
    const all = await this.list();
    const index = all.findIndex((c) => c.id === id);
    if (index === -1) return undefined;
    const updated: Campaign = { ...all[index]!, ...clean(input), id };
    all[index] = updated;
    await this.write(all);
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    const all = await this.list();
    const kept = all.filter((c) => c.id !== id);
    if (kept.length === all.length) return false;
    await this.write(kept);
    return true;
  }

  private async write(campaigns: Campaign[]): Promise<void> {
    await this.files.write(this.path, `${JSON.stringify({ campaigns }, null, 2)}\n`);
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
