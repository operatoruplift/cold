import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The repository: the example config, examples/ and the bundled message
 * library. A bundled server (Vercel) may not keep this file where it was,
 * and its files sit in the working directory instead; COLD_APP_ROOT says so
 * outright.
 */
function appRoot(): string {
  if (process.env.COLD_APP_ROOT) return path.resolve(process.env.COLD_APP_ROOT);
  const here = path.resolve(import.meta.dir, "../../..");
  return existsSync(path.join(here, "cold.example.yaml")) ? here : process.cwd();
}

export const APP_ROOT = appRoot();
