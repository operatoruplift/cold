import path from "node:path";
import type { ColdConfig } from "../config";
import { ROOT } from "../config";
import { TwentyClient, twentyConfigFromEnv } from "../twenty";
import { FileStore } from "./fileStore";
import { TwentyStore } from "./twentyStore";
import type { TouchStore } from "./types";

export * from "./types";
export * from "./helpers";
export { DbStore } from "./dbStore";
export { FileStore } from "./fileStore";
export { fileJournal, filesJournal, TouchNotSavedError, TwentyStore, touchName, type Journal } from "./twentyStore";

/** The Twenty client when TWENTY_BASE_URL and TWENTY_API_KEY are set. */
export function twentyClient(): TwentyClient | undefined {
  const config = twentyConfigFromEnv();
  return config ? new TwentyClient(config) : undefined;
}

/** The touch log the config asks for: Twenty, the local file, or Twenty when it is configured (auto). */
export async function openStore(config: ColdConfig, root = ROOT): Promise<TouchStore> {
  const client = twentyClient();
  if (config.store === "twenty" && !client) throw new Error("store: twenty needs TWENTY_BASE_URL and TWENTY_API_KEY in .env.local");
  if (config.store !== "file" && client) return TwentyStore.open(client, path.resolve(root, ".cold/unsaved.jsonl"));
  return new FileStore(path.resolve(root, config.logFile));
}
