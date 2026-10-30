import { expect, test } from "bun:test";
import path from "node:path";
import { buildAssets } from "../domains/web/server/assets";

// The server bundles the site and the app in memory when it starts. Build
// them here too, so a page that does not bundle fails CI instead of a browser.
test("the site and the app bundle, with every file the service worker needs", async () => {
  const assets = await buildAssets({ appRoot: path.resolve(import.meta.dir, "../.."), publicUrl: new URL("https://cold.example.com") });
  expect(assets.pages.app).toContain('<div id="root">');
  expect(assets.pages.app).toContain('<link rel="manifest" href="/manifest.webmanifest">');
  expect(assets.pages.site).toContain("Break<br");
  expect(assets.pages.site).toContain('content="https://cold.example.com/og.png"');

  const js = await Promise.all([...assets.files].filter(([url]) => url.startsWith("/assets/") && url.endsWith(".js")).map(([, f]) => new Response(f.body()).text()));
  expect(js.length).toBeGreaterThanOrEqual(2);
  // The browser bundles must not pull in server code (node:fs, the mail and AI clients, the database).
  expect(js.join("\n")).not.toMatch(/node:fs|nodemailer|imapflow|bun:sqlite|@anthropic-ai\/sdk/);

  // Every file the service worker precaches is one the server hands out.
  const worker = await new Response(assets.files.get("/sw.js")!.body()).text();
  const shell = JSON.parse(/const SHELL = (\[.*?\]);/.exec(worker)![1]!) as string[];
  for (const url of shell) expect(url === "/app/" || assets.files.has(url)).toBe(true);
  for (const url of ["/manifest.webmanifest", "/favicon.ico", "/icons/icon-512.png", "/icons/maskable-512.png", "/fonts/inter-latin.woff2", "/brand/cold-logo.svg"]) expect(assets.files.has(url)).toBe(true);
});
