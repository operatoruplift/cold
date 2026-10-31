#!/usr/bin/env bun
/**
 * `bun run build`: bundle the public site and the app into dist/. A server
 * with NODE_ENV=production serves them from there instead of bundling them
 * when it starts (the Dockerfile runs this); `bun run ui` keeps bundling
 * your latest changes.
 *
 * `bun run build:vercel` (--static <folder>): the whole site and app as
 * static files, head tags and service worker included, for Vercel's CDN.
 */
import path from "node:path";
import { APP_ROOT } from "../../config";
import { buildAssets, bundle, DIST, writeBundle, writeStatic } from "./assets";
import { serverSettings } from "./settings";

const args = process.argv.slice(2);
const at = args.indexOf("--static");
const bundled = await bundle(APP_ROOT);
if (at === -1) {
  const dir = path.join(APP_ROOT, DIST);
  await writeBundle(bundled, dir);
  console.log(`Bundled the site and the app into ${path.relative(process.cwd(), dir) || "."}/ (${bundled.files.size} files under assets/).`);
} else {
  const dir = path.resolve(args[at + 1] ?? path.join(DIST, "static"));
  const { publicUrl } = serverSettings();
  const assets = buildAssets(bundled, { appRoot: APP_ROOT, publicUrl });
  await writeStatic(assets, dir);
  console.log(`Wrote the site and the app for ${publicUrl.origin} into ${path.relative(process.cwd(), dir) || "."}/ (${assets.files.size + 2} files, version ${assets.version}).`);
}
