import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Bundle, buildAssets, bundle, readBundle, writeBundle } from "../domains/web/server/assets";

// The server bundles the site and the app when it starts, or serves them from
// `bun run build`. Bundle them here too, so a page that does not bundle fails
// CI instead of a browser.
const appRoot = path.resolve(import.meta.dir, "../..");
const publicUrl = new URL("https://cold.example.com");
let bundled: Bundle;
beforeAll(async () => {
  bundled = await bundle(appRoot);
});

test("the site and the app bundle, with every file the service worker needs", async () => {
  const assets = buildAssets(bundled, { appRoot, publicUrl });
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

test("a bundle from bun run build serves exactly what bundling at start does", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cold-dist-"));
  try {
    expect(readBundle(dir)).toBeUndefined();
    await writeBundle(bundled, dir);
    const fresh = buildAssets(bundled, { appRoot, publicUrl });
    const prebuilt = buildAssets(readBundle(dir)!, { appRoot, publicUrl });
    expect(prebuilt.version).toBe(fresh.version);
    expect(prebuilt.pages).toEqual(fresh.pages);
    expect([...prebuilt.files.keys()].sort()).toEqual([...fresh.files.keys()].sort());
    for (const [url, file] of fresh.files) {
      if (!url.startsWith("/assets/")) continue;
      const served = prebuilt.files.get(url)!;
      expect(served.type).toBe(file.type);
      expect(served.cacheControl).toBe(file.cacheControl);
      expect(await new Response(served.body()).text()).toBe(await new Response(file.body()).text());
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
