import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { parseConfig } from "./helpers";
import type { Account, ColdConfig, Offer } from "./types";

export * from "./types";
export * from "./helpers";

/** The repository root (where cold.yaml lives). */
export const ROOT = path.resolve(import.meta.dir, "../../..");

/** Where cold.yaml is (COLD_CONFIG wins), and the example used when it does not exist yet. */
export function configPaths(root = ROOT): { file: string; example: string } {
  const explicit = process.env.COLD_CONFIG;
  return { file: explicit ? path.resolve(explicit) : path.join(root, "cold.yaml"), example: path.join(root, "cold.example.yaml") };
}

/** Parse and validate one config file. Throws with every problem listed. */
export function loadConfigFile(file: string, isExample = false): ColdConfig {
  if (!existsSync(file)) throw new Error(`${path.relative(process.cwd(), file) || file} not found. Copy cold.example.yaml to cold.yaml.`);
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${path.basename(file)} is not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  const { config, errors } = parseConfig(raw, path.basename(file), isExample);
  if (!config) throw new Error(`${path.basename(file)} has problems:\n  - ${errors.join("\n  - ")}`);
  return config;
}

/**
 * Read cold.yaml (or COLD_CONFIG). Without one, the example file is used so
 * lint, list and preview work out of the box; anything that sends refuses an
 * example config.
 */
export function loadConfig(root = ROOT): ColdConfig {
  const { file, example } = configPaths(root);
  const useExample = !process.env.COLD_CONFIG && !existsSync(file);
  return loadConfigFile(useExample ? example : file, useExample);
}

/** KEY=value lines from .env.local and .env next to cold.yaml. The real environment wins. */
export function loadEnvFiles(root = ROOT): void {
  for (const file of [path.join(root, ".env.local"), path.join(root, ".env")]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  }
}

export function getAccount(config: ColdConfig, key: string | undefined): Account {
  const keys = Object.keys(config.accounts);
  const chosen = key ?? (keys.length === 1 ? keys[0] : undefined);
  if (!chosen) throw new Error(`Pick an account with --account (${keys.join(", ")}).`);
  const account = config.accounts[chosen];
  if (!account) throw new Error(`No account "${chosen}" in ${config.file} (have: ${keys.join(", ")}).`);
  return account;
}

export function getOffer(config: ColdConfig, key: string | undefined): Offer | undefined {
  const chosen = key ?? config.defaultOffer ?? (Object.keys(config.offers).length === 1 ? Object.keys(config.offers)[0] : undefined);
  if (!chosen) return undefined;
  const offer = config.offers[chosen];
  if (!offer) throw new Error(`No offer "${chosen}" in ${config.file} (have: ${Object.keys(config.offers).join(", ") || "none"}).`);
  return offer;
}
