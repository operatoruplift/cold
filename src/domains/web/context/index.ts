import { existsSync } from "node:fs";
import path from "node:path";
import { configPaths, loadConfigFile, type Account, type ColdConfig } from "../../config";
import type { MailTransport } from "../../email";
import { loadLibrary } from "../../messages";
import { loadProspects, type Prospect } from "../../prospects";
import { openStore, twentyClient, type TouchStore } from "../../touches";
import { CampaignStore } from "../campaigns";
import { JobRegistry } from "../jobs";

export interface WebContextOptions {
  /** Where cold.yaml, .env.local, .cold/ and prospect CSVs live. */
  root: string;
  messagesDir: string;
  /** Tests swap out the mailbox, the clock and the delays. */
  transport?: (account: Account) => MailTransport;
  now?: () => Date;
  random?: () => number;
}

const PROSPECT_TTL_MS = 5 * 60 * 1000;
const STORE_TTL_MS = 5 * 60 * 1000;

/**
 * What every API call shares. Config and messages are read fresh on each
 * request (they may have just been edited); prospects and the touch store are
 * cached for five minutes, because loading them from Twenty costs requests.
 */
export class WebContext {
  readonly campaigns: CampaignStore;
  readonly jobs = new JobRegistry();
  private readonly prospectCache = new Map<string, { at: number; prospects: Prospect[] }>();
  private storeCache?: { at: number; key: string; store: Promise<TouchStore> };

  constructor(readonly options: WebContextOptions) {
    this.campaigns = new CampaignStore(path.join(options.root, ".cold", "campaigns.json"));
  }

  get root(): string {
    return this.options.root;
  }

  now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** cold.yaml, or the example when there is none yet. Never throws: errors come back in words. */
  config(): { config?: ColdConfig; error?: string; file: string; isExample: boolean } {
    const { file, example } = configPaths(this.root);
    const isExample = !process.env.COLD_CONFIG && !existsSync(file);
    try {
      return { config: loadConfigFile(isExample ? example : file, isExample), file: isExample ? example : file, isExample };
    } catch (err) {
      return { error: (err as Error).message, file, isExample };
    }
  }

  requireConfig(): ColdConfig {
    const { config, error } = this.config();
    if (!config) throw new Error(error);
    return config;
  }

  library() {
    return loadLibrary(this.options.messagesDir);
  }

  /** The touch log, cached; reopened when the store settings or Twenty credentials change. */
  store(config: ColdConfig): Promise<TouchStore> {
    const key = [config.store, config.logFile, process.env.TWENTY_BASE_URL ?? "", process.env.TWENTY_API_KEY ? "key" : ""].join("|");
    const cached = this.storeCache;
    if (cached && cached.key === key && Date.now() - cached.at < STORE_TTL_MS) return cached.store;
    const store = openStore(config, this.root);
    this.storeCache = { at: Date.now(), key, store };
    store.catch(() => {
      if (this.storeCache?.store === store) this.storeCache = undefined;
    });
    return store;
  }

  /** A CSV source relative to the repository root, made absolute; other sources as given. */
  resolveSource(source: string): string {
    if (!source.startsWith("csv:")) return source;
    const file = source.slice(4);
    return `csv:${path.isAbsolute(file) ? file : path.join(this.root, file)}`;
  }

  async prospects(source: string, where?: string, refresh = false): Promise<Prospect[]> {
    const key = `${source}|${where ?? ""}`;
    const cached = this.prospectCache.get(key);
    if (!refresh && cached && Date.now() - cached.at < PROSPECT_TTL_MS) return cached.prospects;
    const prospects = await loadProspects(this.resolveSource(source), { where: where || undefined, client: twentyClient() });
    this.prospectCache.set(key, { at: Date.now(), prospects });
    return prospects;
  }

  /** After settings change: drop everything cached. */
  invalidate(): void {
    this.prospectCache.clear();
    this.storeCache = undefined;
  }
}
