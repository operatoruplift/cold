import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface StaticFile {
  /** Read on each request, so large files are streamed rather than held in memory. */
  body: () => BodyInit;
  type: string;
  cacheControl: string;
}

export interface BuiltAssets {
  /** Changes whenever the site, the app or a public file changes. */
  version: string;
  pages: { site: string; app: string };
  files: Map<string, StaticFile>;
}

/** The bundled site and app: both pages, before the head tags that depend on the address, and the files they load. */
export interface Bundle {
  site: string;
  app: string;
  /** By file name, served at /assets/<name>. */
  files: Map<string, StaticFile>;
}

/** Where `bun run build` writes the bundle, in the app's folder. */
export const DIST = "dist";

const IMMUTABLE = "public, max-age=31536000, immutable";
const HOUR = "public, max-age=3600";
const ALWAYS_CHECK = "no-cache";

const TYPES: Record<string, string> = {
  ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith(".")) return [];
    return entry.isDirectory() ? walk(full, base) : [full];
  });
}

/** Tags every page gets: icons, and the font the first paint needs. */
const COMMON_HEAD = [
  '<link rel="icon" href="/favicon.ico" sizes="32x32">',
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
  '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">',
  '<link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>',
];

function siteHead(publicUrl: URL): string[] {
  const url = publicUrl.origin;
  return [
    '<meta name="theme-color" content="#FAFCFF">',
    `<link rel="canonical" href="${url}/">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="COLD">',
    '<meta property="og:title" content="COLD: break the ice.">',
    '<meta property="og:description" content="AI outbound, reimagined. Find the right people, write the first line, reach out by email, DM and call, and turn replies into meetings.">',
    `<meta property="og:url" content="${url}/">`,
    `<meta property="og:image" content="${url}/og.png">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
  ];
}

const APP_HEAD = [
  '<link rel="manifest" href="/manifest.webmanifest">',
  '<meta name="theme-color" content="#FAFCFF">',
  '<meta name="robots" content="noindex">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="COLD">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
];

const inject = (html: string, tags: string[]) => html.replace("</head>", `${tags.join("")}</head>`);

/** Bundle the public site (src/site) and the app (src/web) in memory. */
export async function bundle(appRoot: string, options: { minify?: boolean } = {}): Promise<Bundle> {
  const result = await Bun.build({
    entrypoints: [path.join(appRoot, "src/site/index.html"), path.join(appRoot, "src/web/index.html")],
    root: path.join(appRoot, "src"),
    minify: options.minify ?? true,
    publicPath: "/assets/",
    external: ["/fonts/*", "/brand/*", "/icons/*"],
    naming: { entry: "[dir]/[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!result.success) throw new Error(`The site and app did not build:\n${result.logs.map(String).join("\n")}`);

  const files = new Map<string, StaticFile>();
  let site = "";
  let app = "";
  for (const output of result.outputs) {
    const name = output.path.replace(/^\.\//, "");
    if (name === "site/index.html") site = await output.text();
    else if (name === "web/index.html") app = await output.text();
    else files.set(name, { body: () => output, type: output.type, cacheControl: IMMUTABLE });
  }
  if (!site || !app) throw new Error("The build did not produce both pages.");
  return { site, app, files };
}

/** Write a bundle to a folder (`bun run build`), replacing what was there. */
export async function writeBundle(bundled: Bundle, dir: string): Promise<void> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync(path.join(dir, "site.html"), bundled.site);
  writeFileSync(path.join(dir, "app.html"), bundled.app);
  for (const [name, file] of bundled.files) await Bun.write(path.join(dir, "assets", name), new Response(file.body()));
}

/**
 * Every page and file as a plain static site, for a CDN (Vercel): the site at
 * index.html, the app at app/index.html, the rest at their own paths.
 */
export async function writeStatic(assets: BuiltAssets, dir: string): Promise<void> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "app"), { recursive: true });
  writeFileSync(path.join(dir, "index.html"), assets.pages.site);
  writeFileSync(path.join(dir, "app", "index.html"), assets.pages.app);
  for (const [url, file] of assets.files) {
    const target = path.join(dir, url.slice(1));
    mkdirSync(path.dirname(target), { recursive: true });
    await Bun.write(target, new Response(file.body()));
  }
}

/** The bundle `bun run build` wrote to a folder, or undefined when there is none. */
export function readBundle(dir: string): Bundle | undefined {
  const assets = path.join(dir, "assets");
  if (!existsSync(path.join(dir, "site.html")) || !existsSync(path.join(dir, "app.html")) || !existsSync(assets)) return undefined;
  const files = new Map<string, StaticFile>();
  for (const file of walk(assets)) {
    files.set(path.relative(assets, file).split(path.sep).join("/"), { body: () => Bun.file(file), type: Bun.file(file).type, cacheControl: IMMUTABLE });
  }
  return { site: readFileSync(path.join(dir, "site.html"), "utf8"), app: readFileSync(path.join(dir, "app.html"), "utf8"), files };
}

/**
 * List every file the server hands out: the bundles under /assets (named by
 * content, so cached for a year), public/ as it is, the Inter font, and the
 * service worker, written with this build's file list so it can keep the app
 * working offline.
 */
export function buildAssets(bundled: Bundle, options: { appRoot: string; publicUrl: URL }): BuiltAssets {
  const { appRoot } = options;
  const { site, app } = bundled;
  const files = new Map<string, StaticFile>();
  const fingerprint = createHash("sha256").update(site).update(app);
  for (const name of [...bundled.files.keys()].sort()) {
    files.set(`/assets/${name}`, bundled.files.get(name)!);
    fingerprint.update(name);
  }

  const publicDir = path.join(appRoot, "public");
  for (const file of walk(publicDir)) {
    const url = `/${path.relative(publicDir, file).split(path.sep).join("/")}`;
    const ext = path.extname(file).toLowerCase();
    files.set(url, { body: () => Bun.file(file), type: TYPES[ext] ?? Bun.file(file).type, cacheControl: url === "/manifest.webmanifest" ? ALWAYS_CHECK : HOUR });
    fingerprint.update(url).update(readFileSync(file));
  }

  const fonts = path.join(path.dirname(Bun.resolveSync("@fontsource-variable/inter/package.json", appRoot)), "files");
  for (const [url, file] of [
    ["/fonts/inter-latin.woff2", "inter-latin-opsz-normal.woff2"],
    ["/fonts/inter-latin-ext.woff2", "inter-latin-ext-opsz-normal.woff2"],
  ] as const) {
    files.set(url, { body: () => Bun.file(path.join(fonts, file)), type: "font/woff2", cacheControl: IMMUTABLE });
  }

  const version = fingerprint.digest("hex").slice(0, 12);
  const shell = [
    "/app/",
    ...[...app.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]!),
    "/fonts/inter-latin.woff2",
    "/manifest.webmanifest",
    "/favicon.svg",
    "/icons/icon-192.png",
    "/brand/cold-logo.svg",
    "/brand/cold-mark.svg",
  ];
  const worker = readFileSync(path.join(appRoot, "src/web/sw.js"), "utf8").replace("__VERSION__", version).replace("__SHELL__", JSON.stringify([...new Set(shell)]));
  files.set("/sw.js", { body: () => worker, type: "text/javascript; charset=utf-8", cacheControl: ALWAYS_CHECK });

  return {
    version,
    pages: { site: inject(site, [...COMMON_HEAD, ...siteHead(options.publicUrl)]), app: inject(app, [...COMMON_HEAD, ...APP_HEAD]) },
    files,
  };
}
