import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The app is bundled by Bun from index.html when `bun run ui` starts. Build it
// here too, so a page that does not bundle fails CI instead of the browser.
test("the web app bundles", async () => {
  const outdir = mkdtempSync(path.join(tmpdir(), "cold-web-build-"));
  try {
    const result = await Bun.build({ entrypoints: [path.join(import.meta.dir, "index.html")], outdir, minify: true });
    expect(result.logs.filter((l) => l.level === "error").map((l) => l.message)).toEqual([]);
    expect(result.success).toBe(true);
    const files = readdirSync(outdir);
    expect(files.some((f) => f.endsWith(".js"))).toBe(true);
    expect(files.some((f) => f.endsWith(".css"))).toBe(true);
    const html = readFileSync(path.join(outdir, "index.html"), "utf8");
    expect(html).toContain('<div id="root">');
    // The browser bundle must not pull in server code (node:fs and friends).
    const js = files.filter((f) => f.endsWith(".js")).map((f) => readFileSync(path.join(outdir, f), "utf8")).join("\n");
    expect(js).not.toMatch(/node:fs|nodemailer|imapflow/);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
});
