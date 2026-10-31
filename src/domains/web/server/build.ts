#!/usr/bin/env bun
/**
 * `bun run build`: bundle the public site and the app into dist/. A server
 * with NODE_ENV=production serves them from there instead of bundling them
 * when it starts (the Dockerfile runs this); `bun run ui` keeps bundling
 * your latest changes.
 */
import path from "node:path";
import { APP_ROOT } from "../../config";
import { bundle, DIST, writeBundle } from "./assets";

const dir = path.join(APP_ROOT, DIST);
const bundled = await bundle(APP_ROOT);
await writeBundle(bundled, dir);
console.log(`Bundled the site and the app into ${path.relative(process.cwd(), dir) || "."}/ (${bundled.files.size} files under assets/).`);
