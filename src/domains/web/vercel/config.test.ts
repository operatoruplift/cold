import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { contentSecurityPolicy, securityHeaders } from "../server/handler";

const config = JSON.parse(readFileSync(path.resolve(import.meta.dir, "../../../../vercel.json"), "utf8")) as {
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  rewrites: Array<{ source: string; destination: string }>;
  crons: Array<{ path: string }>;
  functions: Record<string, { includeFiles?: string }>;
};

// Vercel serves the pages itself, so vercel.json carries the headers the server would add.
test("vercel.json gives every page the server's security headers and CSP", () => {
  const all = Object.fromEntries(config.headers.find((h) => h.source === "/(.*)")!.headers.map((h) => [h.key, h.value]));
  expect(all).toEqual({ ...securityHeaders(true), "content-security-policy": contentSecurityPolicy(true) });
});

test("vercel.json sends /api to the function, the app's pages to its shell, and the cron to the tick", () => {
  expect(config.rewrites).toContainEqual({ source: "/api/(.*)", destination: "/api" });
  expect(config.rewrites).toContainEqual({ source: "/app/(.*)", destination: "/app/index.html" });
  expect(config.crons.map((c) => c.path)).toEqual(["/api/cron/tick"]);
  // The function reads the bundled library, the examples and the example config from disk.
  expect(config.functions["api/index.ts"]!.includeFiles).toBe("{messages/**,examples/**,cold.example.yaml}");
});
