import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { parseConfig } from "./helpers";
import type { Account, ColdConfig, Offer } from "./types";

export * from "./types";
export * from "./helpers";

/** The repository root (where cold.yaml lives). */
export const ROOT = path.resolve(import.meta.dir, "../../..");

/**
 * Read cold.yaml (or COLD_CONFIG). Without one, the example file is used so
 * lint, list and preview work out of the box; anything that sends refuses an
 * example config.
 */
export function loadConfig(): ColdConfig {
  const explicit = process.env.COLD_CONFIG;
  const file = explicit ? path.resolve(explicit) : path.join(ROOT, "cold.yaml");
  const useExample = !explicit && !existsSync(file);
  const source = useExample ? path.join(ROOT, "cold.example.yaml") : file;
  if (!existsSync(source)) throw new Error(`${path.relative(process.cwd(), source) || source} not found. Copy cold.example.yaml to cold.yaml.`);
  let raw: unknown;
  try {
    raw = parse(readFileSync(source, "utf8"));
  } catch (err) {
    throw new Error(`${path.basename(source)} is not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  const { config, errors } = parseConfig(raw, path.basename(source), useExample);
  if (!config) throw new Error(`${path.basename(source)} has problems:\n  - ${errors.join("\n  - ")}`);
  return config;
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
