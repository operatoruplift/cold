import { beforeEach, describe, expect, test } from "bun:test";
import { OwnerAuth } from "../../auth";
import { openDatabase } from "../../db";
import { Waitlist } from "../../waitlist";
import type { BuiltAssets } from "./assets";
import { clientAddress, createHandler, SetupCode } from "./handler";
import { serverSettings } from "./settings";

const assets: BuiltAssets = {
  version: "test",
  pages: { site: "<html>site</html>", app: "<html>app</html>" },
  files: new Map([["/brand/cold-logo.svg", { body: () => "<svg/>", type: "image/svg+xml", cacheControl: "public, max-age=3600" }]]),
};

let handler: (request: Request) => Promise<Response>;
let auth: OwnerAuth;
let waitlist: Waitlist;
let setup: SetupCode;
let announced: string[];
const privateCalls: string[] = [];

beforeEach(async () => {
  const db = await openDatabase(":memory:");
  auth = new OwnerAuth(db);
  waitlist = new Waitlist(db);
  announced = [];
  setup = new SetupCode((code) => announced.push(code));
  handler = createHandler({
    settings: serverSettings({ COLD_UI_PORT: "4100" }),
    assets,
    version: assets.version,
    auth,
    waitlist,
    setup,
    privateApi: async (request) => {
      privateCalls.push(new URL(request.url).pathname);
      return Response.json({ private: true });
    },
    clientIp: () => "127.0.0.1",
  });
});

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return handler(
    new Request(`http://127.0.0.1:4100${path}`, {
      method,
      headers: { host: "localhost:4100", ...(path.startsWith("/api/") ? { "x-cold": "1" } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}
const cookieOf = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";

describe("the public side", () => {
  test("serves the site, the app shell and static files, with security headers", async () => {
    const site = await call("GET", "/");
    expect(await site.text()).toBe("<html>site</html>");
    expect(site.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(site.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await (await call("GET", "/app/campaigns/x")).text()).toBe("<html>app</html>");
    const redirect = await call("GET", "/app?setup=AB");
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/app/?setup=AB");
    expect((await call("GET", "/brand/cold-logo.svg")).headers.get("content-type")).toBe("image/svg+xml");
    expect((await call("GET", "/nope")).status).toBe(404);
  });

  test("the waitlist takes signups without a login", async () => {
    const response = await call("POST", "/api/waitlist", { email: "dana@example.com", elapsedMs: 5000 });
    expect(response.status).toBe(201);
    expect((await waitlist.counts()).total).toBe(1);
    expect((await call("POST", "/api/waitlist", { email: "bad" })).status).toBe(400);
  });

  test("everything else in the API needs the owner's session", async () => {
    const response = await call("GET", "/api/status");
    expect(response.status).toBe(401);
    expect(privateCalls).toEqual([]);
    expect((await call("GET", "/api/waitlist")).status).toBe(401);
  });
});

describe("signing in", () => {
  test("first run: the setup code creates the owner and signs them in", async () => {
    await setup.issue();
    expect((await (await call("GET", "/api/session")).json()) as object).toMatchObject({ signedIn: false, setupRequired: true });
    expect((await call("POST", "/api/session/setup", { code: "WRON-GCOD-EXXX", email: "me@cold.dev", password: "correct horse battery" })).status).toBe(403);
    const created = await call("POST", "/api/session/setup", { code: announced[0], email: "me@cold.dev", password: "correct horse battery" });
    expect(created.status).toBe(201);
    const cookie = cookieOf(created);
    expect(cookie).toStartWith("cold_session=");
    expect(created.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    expect((await call("GET", "/api/status", undefined, { cookie })).status).toBe(200);
    expect(privateCalls).toContain("/api/status");
    // The code is spent.
    expect((await call("POST", "/api/session/setup", { code: announced[0], email: "x@cold.dev", password: "correct horse battery" })).status).toBe(409);
  });

  test("login, the waitlist admin, and logout", async () => {
    await auth.setOwner("me@cold.dev", "correct horse battery");
    expect((await call("POST", "/api/session/login", { email: "me@cold.dev", password: "wrong password!!" })).status).toBe(401);
    const login = await call("POST", "/api/session/login", { email: "me@cold.dev", password: "correct horse battery" });
    const cookie = cookieOf(login);
    expect(login.status).toBe(200);
    await waitlist.join({ email: "dana@example.com", channels: [] });
    const list = (await (await call("GET", "/api/waitlist", undefined, { cookie })).json()) as { entries: unknown[] };
    expect(list.entries).toHaveLength(1);
    const csv = await call("GET", "/api/waitlist.csv", undefined, { cookie });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const logout = await call("POST", "/api/session/logout", {}, { cookie });
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call("GET", "/api/waitlist", undefined, { cookie })).status).toBe(401);
  });

  test("too many wrong passwords from one address are slowed down", async () => {
    await auth.setOwner("me@cold.dev", "correct horse battery");
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await call("POST", "/api/session/login", { email: "me@cold.dev", password: `wrong password ${i}` })).status;
    expect(last).toBe(429);
  });

  test("twenty wrong setup codes replace the code", async () => {
    await setup.issue();
    for (let i = 0; i < 20; i++) await setup.check("nope");
    expect(announced).toHaveLength(2);
    expect(announced[0]).not.toBe(announced[1]);
  });
});

describe("guards", () => {
  test("a foreign Host or Origin is refused before anything runs", async () => {
    expect((await call("GET", "/", undefined, { host: "evil.example" })).status).toBe(403);
    expect((await call("POST", "/api/waitlist", { email: "a@b.co" }, { origin: "https://evil.example" })).status).toBe(403);
  });

  test("client address: the socket's, or the X-Forwarded-For entry the trusted proxies added", () => {
    // A client wrote 6.6.6.6 itself; the front door saw 203.0.113.9; the host's proxy saw the front door at 76.76.21.21.
    const request = new Request("http://x/", { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9, 76.76.21.21" } });
    expect(clientAddress(1, () => "10.0.0.1")(request)).toBe("76.76.21.21");
    expect(clientAddress(2, () => "10.0.0.1")(request)).toBe("203.0.113.9");
    expect(clientAddress(0, () => "10.0.0.1")(request)).toBe("10.0.0.1");
    expect(clientAddress(5, () => "10.0.0.1")(request)).toBe("6.6.6.6");
  });

  test("hosted settings answer on the public name with secure cookies", () => {
    const s = serverSettings({ COLD_PUBLIC_URL: "https://cold.example.com/", PORT: "8080" });
    expect(s).toMatchObject({ mode: "hosted", hostname: "0.0.0.0", port: 8080, secureCookies: true, proxyHops: 1 });
    expect(s.hosts).toContain("cold.example.com");
    expect(s.origins).toContain("https://cold.example.com");
    expect(() => serverSettings({ COLD_PUBLIC_URL: "ftp://x" })).toThrow("https://");
    expect(serverSettings({ RAILWAY_PUBLIC_DOMAIN: "cold-production.up.railway.app" }).publicUrl.href).toBe("https://cold-production.up.railway.app/");
    expect(serverSettings({ FLY_APP_NAME: "cold" }).hosts).toContain("cold.fly.dev");
    // Behind Vercel: the public address is the front door, Railway's domain still answers, and two hops are trusted.
    const front = serverSettings({ COLD_PUBLIC_URL: "https://coldthecompany.vercel.app", RAILWAY_PUBLIC_DOMAIN: "cold-production.up.railway.app", COLD_PROXY_HOPS: "2" });
    expect(front.publicUrl.href).toBe("https://coldthecompany.vercel.app/");
    expect(front.hosts).toEqual(expect.arrayContaining(["coldthecompany.vercel.app", "cold-production.up.railway.app"]));
    expect(front.origins).toContain("https://coldthecompany.vercel.app");
    expect(front.proxyHops).toBe(2);
    expect(serverSettings({ COLD_PUBLIC_URL: "https://x.example", COLD_TRUST_PROXY: "0" }).proxyHops).toBe(0);
    expect(() => serverSettings({ COLD_REQUIRE_PUBLIC_URL: "1" })).toThrow("Set COLD_PUBLIC_URL");
  });
});
