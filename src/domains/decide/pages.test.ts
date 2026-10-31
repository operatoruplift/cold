import { describe, expect, test } from "bun:test";
import { checkUrl, collectSite, decodeEntities, fetchText, privateAddress, rankLinks, readHtml, robotsAllows } from "./pages";
import type { Fetch } from "./types";

describe("only the public internet is read", () => {
  test("private, loopback, link-local and reserved addresses are refused, in every spelling", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1"])
      expect(privateAddress(ip)).toBe(true);
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1", "2002:c0a8:101::1", "2001:db8::1", "[::1]"])
      expect(privateAddress(ip)).toBe(true);
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(privateAddress(ip)).toBe(false);
    expect(privateAddress("not an ip")).toBe(true);
  });

  test("web addresses are checked before anything is fetched", () => {
    expect(checkUrl("clearviewtint.example").href).toBe("https://clearviewtint.example/");
    expect(checkUrl("http://clearviewtint.example/about#team").href).toBe("http://clearviewtint.example/about");
    for (const bad of ["ftp://x.example", "javascript:alert(1)", "https://user:pw@x.example", "https://x.example:8080", "http://localhost/", "http://intranet/", "http://printer.local/", "http://2130706433/", "http://0x7f.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "not a url at all"])
      expect(() => checkUrl(bad)).toThrow();
  });

  test("a site whose name resolves to a private address, or that redirects to one, is not read", async () => {
    const fetched: string[] = [];
    const fetch: Fetch = async (url) => {
      fetched.push(url);
      return url.includes("redirector") ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }) : new Response("<html>ok</html>", { headers: { "content-type": "text/html" } });
    };
    const resolve = async (host: string) => (host === "sneaky.example" ? ["10.0.0.5"] : ["93.184.216.34"]);
    await expect(fetchText(new URL("https://sneaky.example/"), { fetch, resolve })).rejects.toThrow("not on the public internet");
    expect(fetched).toEqual([]);
    await expect(fetchText(new URL("https://redirector.example/"), { fetch, resolve })).rejects.toThrow("not on the public internet");
    expect(fetched).toEqual(["https://redirector.example/"]);
  });

  test("a huge page is cut short, and something that isn't a page is skipped", async () => {
    const resolve = async () => ["93.184.216.34"];
    const big: Fetch = async () => new Response("a".repeat(50_000), { headers: { "content-type": "text/html" } });
    expect((await fetchText(new URL("https://big.example/"), { fetch: big, resolve, maxBytes: 1000 })).body.length).toBe(1000);
    const pdf: Fetch = async () => new Response("%PDF", { headers: { "content-type": "application/pdf" } });
    await expect(fetchText(new URL("https://pdf.example/"), { fetch: pdf, resolve })).rejects.toThrow("not a web page");
  });
});

describe("robots.txt", () => {
  const robots = `# a comment
User-agent: *
Disallow: /private
Allow: /private/press

User-agent: GPTBot
User-agent: COLD-research
Disallow: /team$
Disallow: /*.json
`;
  test("COLD follows its own group when there is one, else the * group; the longest rule wins", () => {
    expect(robotsAllows(robots, "/team")).toBe(false);
    expect(robotsAllows(robots, "/team/dana")).toBe(true);
    expect(robotsAllows(robots, "/data/feed.json")).toBe(false);
    expect(robotsAllows(robots, "/private")).toBe(true);
    expect(robotsAllows(robots, "/private", "OtherBot")).toBe(false);
    expect(robotsAllows(robots, "/private/press", "OtherBot")).toBe(true);
    expect(robotsAllows("", "/anything")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow:\n", "/anything")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /\n", "/")).toBe(false);
  });
});

describe("reading a page", () => {
  const html = `<!doctype html><html><head><title>Clearview Tint &amp; Wrap | Round Rock</title>
<meta name="description" content="Window tint for cars and homes.">
<script type="application/ld+json">{"@type":"AutoRepair","name":"Clearview Tint","aggregateRating":{"ratingValue":4.8,"reviewCount":212}}</script>
<style>.x{color:red}</style></head>
<body><nav><a href="/">Home</a> <a href="/about-us">About us</a> <a href="/careers">We're hiring</a> <a href="/privacy">Privacy</a>
<a href="https://instagram.com/clearview">IG</a> <a href="mailto:hi@clearview.example">Email</a> <a href="/blog/second-bay-open">News</a></nav>
<h1>Tint done right</h1><p>Family-owned since 2014.<br>Now with a <b>second bay</b> in Round Rock&nbsp;&mdash; book online.</p>
<script>alert("no")</script><!-- hidden --></body></html>`;

  test("text, title, description and structured data come out; scripts, styles and comments don't", () => {
    const page = readHtml(html, new URL("https://clearview.example/"));
    expect(page.title).toBe("Clearview Tint & Wrap | Round Rock");
    expect(page.description).toBe("Window tint for cars and homes.");
    expect(page.data).toContain('"reviewCount":212');
    expect(page.text).toContain("Family-owned since 2014.\nNow with a second bay in Round Rock — book online.");
    expect(page.text).not.toContain("alert");
    expect(page.text).not.toContain("color:red");
    expect(page.text).not.toContain("hidden");
    expect(decodeEntities("&#8217;&#x2019;&bogus;")).toBe("’’&bogus;");
  });

  test("the pages worth reading come first; other sites, legal pages and the home page are left out", () => {
    const page = readHtml(html, new URL("https://clearview.example/"));
    expect(rankLinks(page.links, new URL("https://clearview.example/"))).toEqual(["https://clearview.example/about-us", "https://clearview.example/careers", "https://clearview.example/blog/second-bay-open"]);
  });

  test("a whole site: home first, then the best pages, within the page limit and robots.txt", async () => {
    const pages: Record<string, string> = {
      "https://clearview.example/robots.txt": "User-agent: *\nDisallow: /careers",
      "https://clearview.example/": html,
      "https://clearview.example/about-us": "<html><body><h2>About</h2><p>Dana Reyes started Clearview in 2014.</p></body></html>",
      "https://clearview.example/blog/second-bay-open": "<html><body><p>Our second bay opened in September.</p></body></html>",
    };
    const asked: string[] = [];
    const fetch: Fetch = async (url) => {
      asked.push(url);
      const body = pages[url];
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { headers: { "content-type": url.endsWith(".txt") ? "text/plain" : "text/html; charset=utf-8" } });
    };
    const site = await collectSite("clearview.example", { fetch, resolve: async () => ["93.184.216.34"], maxPages: 3 });
    expect(site.pages.map((p) => p.url)).toEqual(["https://clearview.example/", "https://clearview.example/about-us", "https://clearview.example/blog/second-bay-open"]);
    expect(site.pages[0]!.text.startsWith('Structured data: {"@type":"AutoRepair"')).toBe(true);
    expect(site.pages[1]!.text).toContain("Dana Reyes started Clearview in 2014.");
    expect(site.skipped).toEqual([{ url: "https://clearview.example/careers", reason: "robots.txt asks not to read it." }]);
    expect(asked).not.toContain("https://clearview.example/careers");
  });

  test("a site that can't be read says why, and nothing is thrown", async () => {
    expect(await collectSite("http://localhost:3000")).toEqual({ pages: [], skipped: [{ url: "http://localhost:3000", reason: "Only the normal web ports are read." }] });
    const down: Fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect((await collectSite("https://down.example", { fetch: down, resolve: async () => ["93.184.216.34"] })).skipped).toEqual([{ url: "https://down.example/", reason: "The site could not be reached." }]);
  });
});
