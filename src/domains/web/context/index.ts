import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AiError, AiStore, aiConfigured, claudeCall, type MessagesCall } from "../../ai";
import { APP_ROOT, configFromText, DEFAULT_CALL_HOURS, type Account, type ColdConfig, type DecideSettings } from "../../config";
import type { Db } from "../../db";
import { claudeDecider, DecideStore, jevConfigured, jevProvider, subqConfigured, subqReader, type CollectOptions, type DecisionProvider, type LongReader } from "../../decide";
import { reacherFromEnv, smtpTransport, type MailTransport } from "../../email";
import { loadLibraryFrom } from "../../messages";
import { loadProspects, prospectsFromCsv, type Prospect } from "../../prospects";
import { DbFiles, DiskFiles, EnvFileSecrets, secretKey, type Files, type Secrets } from "../../storage";
import { DbStore, filesJournal, openStore, twentyClient, TwentyStore, type TouchStore } from "../../touches";
import { xAppFromEnv, XClient, XStore, type XFetch } from "../../xApi";
import { LISTEN_PREFIX, ListenStore, listenProspect } from "../../listen";
import { LeadWatch } from "../../leads";
import type { TwentyClient } from "../../twenty";
import { CampaignStore } from "../campaigns";
import { processScoreItem } from "../decide/engine";
import { ScoreJobs } from "../decide/jobs";
import { SendJobs } from "../sends";

export interface WebContextOptions {
  /** A folder holding your files (cold.yaml, messages/, prospect lists, .cold/): what `bun run ui` uses. */
  root?: string;
  /** Or any storage for them, such as the database on a server without a disk. Give root or files. */
  files?: Files;
  /** Where Settings saves keys. With root, .env.local in it. */
  secrets?: Secrets;
  /** The app's database: AI runs and drafts, and on a server without a disk the touch log too. */
  db?: Db;
  /** Tests swap out Claude, Jev, SubQ, the web, the mailbox, the clock and the delays. */
  aiCall?: () => MessagesCall;
  decider?: () => DecisionProvider;
  reader?: () => LongReader;
  /** How diligence reads prospects' websites. */
  pages?: Pick<CollectOptions, "fetch" | "resolve">;
  transport?: (account: Account) => MailTransport;
  /** How cold reaches X's API (tests hand it a fake X). */
  xFetch?: XFetch;
  /** Twenty, when not from TWENTY_BASE_URL and TWENTY_API_KEY (tests hand it a fake). */
  twenty?: () => TwentyClient | undefined;
  /** How lead alerts reach ntfy (tests hand it a fake). */
  ntfyFetch?: typeof fetch;
  /** The app's address, for links in lead alerts: "https://cold.example.com/app/". */
  appUrl?: string;
  now?: () => Date;
  random?: () => number;
}

/** COLD_SECRET_KEY as a key, or undefined when it is unset or unusable (the X store then says what to do). */
function usableSecretKey(): Buffer | undefined {
  try {
    return secretKey();
  } catch {
    return undefined;
  }
}

const PROSPECT_TTL_MS = 5 * 60 * 1000;
const STORE_TTL_MS = 5 * 60 * 1000;
const CONFIG = "cold.yaml";
export const OWN_LIST = /^prospects[^/]*\.csv$/i;

export interface ConfigState {
  config?: ColdConfig;
  error?: string;
  /** cold.yaml as you would recognise it: a path on disk, or "(in the database)". */
  file: string;
  isExample: boolean;
}

/**
 * What every API call shares. On disk, config and messages are read fresh on
 * each request (you may have just edited them); in the database they are kept
 * until any server changes a file. Prospects and the touch store are cached
 * for five minutes, because loading them from Twenty costs requests.
 */
export class WebContext {
  readonly files: Files;
  readonly secrets?: Secrets;
  readonly campaigns: CampaignStore;
  /** AI runs and drafts; only when the app has its database. */
  readonly ai?: AiStore;
  /** Email sends, kept in the database so they outlive the server; only with the database. */
  readonly sends?: SendJobs;
  /** The decision engine's decisions and what it learned; only with the database. */
  readonly decisions?: DecideStore;
  /** Whole lists scored on the server, kept in the database; only with the database. */
  readonly scoring?: ScoreJobs;
  /** X connections, sign-ins and sends through X's API; only with the database. */
  readonly x?: XStore;
  /** Listening matches OpenMagpie delivered; only with the database. */
  readonly listening?: ListenStore;
  /** Pushes an alert when one of offer's quiz leads comes in; only with the database. */
  readonly leads?: LeadWatch;
  private readonly prospectCache = new Map<string, { at: number; prospects: Prospect[] }>();
  private storeCache?: { at: number; key: string; store: Promise<TouchStore> };
  private kept: { config?: Promise<ConfigState>; library?: ReturnType<typeof loadLibraryFrom> } = {};
  private versions?: string;

  constructor(readonly options: WebContextOptions) {
    if (!options.files && !options.root) throw new Error("A WebContext needs a root folder or files.");
    this.files = options.files ?? new DiskFiles(options.root!);
    this.secrets = options.secrets ?? (options.root ? new EnvFileSecrets(path.join(options.root, ".env.local")) : undefined);
    this.campaigns = new CampaignStore(this.files);
    if (options.db) {
      this.ai = new AiStore(options.db, () => this.now());
      this.decisions = new DecideStore(options.db, () => this.now());
      this.scoring = new ScoreJobs(options.db, { process: (spec, item) => processScoreItem(this, spec, item) });
      this.sends = new SendJobs(options.db, {
        // Opened when a send picks up, from what is saved now: on Vercel that may be a later function than the one that queued it.
        tools: async (plan) => {
          await this.freshen();
          const store = await this.store(await this.requireConfig());
          return { store, transport: options.transport?.(plan.account) ?? smtpTransport(plan.account), verifier: reacherFromEnv() };
        },
        now: () => this.now(),
        random: options.random,
      });
      this.x = new XStore(options.db, { key: usableSecretKey(), requireKey: this.storage === "database", now: () => this.now() });
      this.listening = new ListenStore(options.db);
      this.leads = new LeadWatch({ db: options.db, client: () => this.twenty(), appUrl: options.appUrl, hours: async () => (await this.config()).config?.calls ?? DEFAULT_CALL_HOURS, fetch: options.ntfyFetch, now: () => this.now() });
    }
  }

  /** Twenty, once TWENTY_BASE_URL and TWENTY_API_KEY are set. */
  twenty(): TwentyClient | undefined {
    return this.options.twenty ? this.options.twenty() : twentyClient();
  }

  /** X's API through the owner's developer app, once X_CLIENT_ID is set. */
  xClient(): XClient | undefined {
    const app = xAppFromEnv();
    return app ? new XClient(app, this.options.xFetch, () => this.now()) : undefined;
  }

  /** Where your files are: a folder on this computer, or the database. */
  get storage(): "disk" | "database" {
    return this.files instanceof DbFiles ? "database" : "disk";
  }

  /** The folder of your files on disk, for paths outside the storage (COLD_CONFIG, a CSV given by full path). */
  get root(): string | undefined {
    return this.files instanceof DiskFiles ? this.files.root : undefined;
  }

  /** Claude, with the API key from the environment (or the test's fake). */
  claude(): MessagesCall {
    return this.options.aiCall?.() ?? claudeCall();
  }

  now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Who answers the decision questions: Jev when it has a key (or cold.yaml says so), else Claude. */
  decider(settings: DecideSettings): DecisionProvider {
    if (this.options.decider) return this.options.decider();
    const choice = settings.provider;
    if (choice === "jev" || (choice === "auto" && jevConfigured())) return jevProvider();
    if (choice === "auto" && !aiConfigured() && !this.options.aiCall) throw new AiError("Add a TypeSafe API key (TYPESAFE_API_KEY, for Jev) or an Anthropic API key (ANTHROPIC_API_KEY, for Claude) in Settings to score prospects.", 400);
    return claudeDecider({ call: this.claude() });
  }

  /** Who reads a prospect's site for diligence: SubQ when it has a key (or cold.yaml says so); undefined means Claude. */
  reader(settings: DecideSettings): LongReader | undefined {
    if (this.options.reader) return this.options.reader();
    const choice = settings.diligence;
    if (choice === "subq" || (choice === "auto" && subqConfigured())) return subqReader();
    return undefined;
  }

  /**
   * Before each request on a server without a disk: pick up keys and files
   * another server saved. One small query.
   */
  async freshen(): Promise<void> {
    const db = this.options.db;
    if (this.storage !== "database" || !db) return;
    const rows = await db.all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key IN ('data_version', 'secrets_version') ORDER BY key");
    const versions = rows.map((r) => `${r.key}=${r.value}`).join("&");
    if (versions === this.versions) return;
    if (this.versions !== undefined) this.invalidate();
    await this.secrets?.refresh();
    this.versions = versions;
  }

  /** cold.yaml as text: yours, or the example when there is none yet. */
  async configText(): Promise<{ text: string; exists: boolean; file: string }> {
    const explicit = process.env.COLD_CONFIG;
    if (explicit && this.storage === "disk") {
      const file = path.resolve(explicit);
      if (!existsSync(file)) throw new Error(`COLD_CONFIG points at ${file}, which does not exist.`);
      return { text: readFileSync(file, "utf8"), exists: true, file };
    }
    const own = await this.files.read(CONFIG);
    if (own !== undefined) return { text: own, exists: true, file: this.files.display(CONFIG) };
    return { text: readFileSync(path.join(APP_ROOT, "cold.example.yaml"), "utf8"), exists: false, file: "cold.example.yaml" };
  }

  /** Save cold.yaml (COLD_CONFIG's file, when set). Returns where it went. */
  async saveConfig(yaml: string): Promise<string> {
    const text = yaml.endsWith("\n") ? yaml : `${yaml}\n`;
    const explicit = process.env.COLD_CONFIG;
    if (explicit && this.storage === "disk") {
      await new DiskFiles(path.dirname(path.resolve(explicit))).write(path.basename(explicit), text);
      this.invalidate();
      return path.resolve(explicit);
    }
    await this.files.write(CONFIG, text);
    this.invalidate();
    return this.files.display(CONFIG);
  }

  /** cold.yaml, or the example when there is none yet. Never throws: errors come back in words. */
  config(): Promise<ConfigState> {
    if (this.storage === "database" && this.kept.config) return this.kept.config;
    const loading = this.configText().then(
      ({ text, exists, file }) => {
        try {
          return { config: configFromText(text, exists ? CONFIG : "cold.example.yaml", !exists), file, isExample: !exists };
        } catch (err) {
          return { error: (err as Error).message, file, isExample: !exists };
        }
      },
      (err: Error): ConfigState => ({ error: err.message, file: CONFIG, isExample: false }),
    );
    if (this.storage === "database") this.kept.config = loading;
    return loading;
  }

  async requireConfig(): Promise<ColdConfig> {
    const { config, error } = await this.config();
    if (!config) throw new Error(error);
    return config;
  }

  library(): ReturnType<typeof loadLibraryFrom> {
    if (this.storage === "database" && this.kept.library) return this.kept.library;
    const loading = loadLibraryFrom(this.files);
    if (this.storage === "database") this.kept.library = loading;
    return loading;
  }

  /** The touch log, cached; reopened when the store settings or Twenty credentials change. */
  store(config: ColdConfig): Promise<TouchStore> {
    const key = [config.store, config.logFile, process.env.TWENTY_BASE_URL ?? "", process.env.TWENTY_API_KEY ? "key" : ""].join("|");
    const cached = this.storeCache;
    if (cached && cached.key === key && Date.now() - cached.at < STORE_TTL_MS) return cached.store;
    const store = this.openStore(config);
    this.storeCache = { at: Date.now(), key, store };
    store.catch(() => {
      if (this.storeCache?.store === store) this.storeCache = undefined;
    });
    return store;
  }

  private async openStore(config: ColdConfig): Promise<TouchStore> {
    if (this.storage === "disk") return openStore(config, this.root);
    const client = twentyClient();
    if (config.store === "twenty" && !client) throw new Error("store: twenty needs TWENTY_BASE_URL and TWENTY_API_KEY, set in Settings.");
    if (config.store !== "file" && client) return TwentyStore.open(client, filesJournal(this.files, ".cold/unsaved.jsonl"));
    if (!this.options.db) throw new Error("The touch log needs the app's database.");
    return new DbStore(this.options.db);
  }

  /**
   * A CSV source's text and, when it is one of your own files, its path:
   * your files first, then the examples that ship with COLD.
   */
  async csv(source: string): Promise<{ text: string; path?: string; label: string }> {
    if (!source.startsWith("csv:")) throw new Error(`${source} is not a CSV source.`);
    const file = source.slice(4);
    if (path.isAbsolute(file)) {
      if (this.storage !== "disk" || !existsSync(file)) throw new Error(`No CSV at ${file}`);
      return { text: readFileSync(file, "utf8"), label: file };
    }
    const own = await this.files.read(file).catch(() => undefined);
    if (own !== undefined) return { text: own, path: file, label: this.files.display(file) };
    const bundled = path.join(APP_ROOT, file);
    if (!file.split(/[\\/]/).includes("..") && existsSync(bundled)) return { text: readFileSync(bundled, "utf8"), label: file };
    throw new Error(`No CSV named ${file}.`);
  }

  /** Your own prospect lists: prospects*.csv at the top of your files. */
  async ownLists(): Promise<string[]> {
    return (await this.files.list("")).filter((p) => OWN_LIST.test(p));
  }

  async prospects(source: string, where?: string, refresh = false): Promise<Prospect[]> {
    const key = `${source}|${where ?? ""}`;
    const cached = this.prospectCache.get(key);
    if (!refresh && cached && Date.now() - cached.at < PROSPECT_TTL_MS) return cached.prospects;
    let prospects: Prospect[];
    if (source.startsWith("csv:")) {
      if (where) throw new Error("A Twenty filter only applies to a Twenty source.");
      prospects = prospectsFromCsv((await this.csv(source)).text);
    } else if (source.startsWith(LISTEN_PREFIX)) {
      if (where) throw new Error("A Twenty filter only applies to a Twenty source.");
      if (!this.listening) throw new Error("Listening needs the app's database.");
      const watch = source.slice(LISTEN_PREFIX.length);
      prospects = (await this.listening.items({ watch: watch === "all" ? undefined : watch, limit: 2000 })).map(listenProspect);
    } else {
      prospects = await loadProspects(source, { where: where || undefined, client: this.twenty() });
    }
    this.prospectCache.set(key, { at: Date.now(), prospects });
    return prospects;
  }

  /** After settings or files change: drop everything cached. */
  invalidate(): void {
    this.prospectCache.clear();
    this.storeCache = undefined;
    this.kept = {};
  }
}
