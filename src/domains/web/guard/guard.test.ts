import { describe, expect, test } from "bun:test";
import { localHosts, refuseRequest } from ".";

const hosts = localHosts(4100);
const access = { hosts, origins: hosts.map((h) => `http://${h}`) };
const req = (path: string, headers: Record<string, string>) => new Request(`http://127.0.0.1:4100${path}`, { headers });

describe("refuseRequest", () => {
  test("serves the page on localhost, and API calls with the header", () => {
    expect(refuseRequest(req("/", { host: "localhost:4100" }), access)).toBeUndefined();
    expect(refuseRequest(req("/api/status", { host: "127.0.0.1:4100", "x-cold": "1" }), access)).toBeUndefined();
    expect(refuseRequest(req("/api/status", { host: "127.0.0.1:4100", "x-cold": "1", origin: "http://127.0.0.1:4100" }), access)).toBeUndefined();
  });

  test("refuses another Host (DNS rebinding)", () => {
    expect(refuseRequest(req("/", { host: "evil.example:4100" }), access)).toBe("cold does not answer on evil.example:4100");
    expect(refuseRequest(req("/api/status", { host: "evil.example", "x-cold": "1" }), access)).toBe("cold does not answer on evil.example");
  });

  test("refuses API calls without the header, or from another origin", () => {
    expect(refuseRequest(req("/api/campaigns", { host: "localhost:4100" }), access)).toBe("missing the x-cold header");
    expect(refuseRequest(req("/api/campaigns", { host: "localhost:4100", "x-cold": "1", origin: "https://evil.example" }), access)).toBe("cross-origin requests are not allowed");
  });

  test("lets uptime checks reach /api/health from anywhere", () => {
    expect(refuseRequest(req("/api/health", { host: "10.0.0.7:8080" }), access)).toBeUndefined();
  });

  test("lets X send the owner back to /api/x/callback, a plain page load, on this server's hosts only", () => {
    expect(refuseRequest(req("/api/x/callback?state=s&code=c", { host: "127.0.0.1:4100" }), access)).toBeUndefined();
    expect(refuseRequest(req("/api/x/callback?state=s&code=c", { host: "evil.example" }), access)).toBe("cold does not answer on evil.example");
    expect(refuseRequest(new Request("http://127.0.0.1:4100/api/x/callback", { method: "POST", headers: { host: "127.0.0.1:4100" } }), access)).toBe("missing the x-cold header");
    expect(refuseRequest(req("/api/x/connect", { host: "127.0.0.1:4100" }), access)).toBe("missing the x-cold header");
  });

  test("a hosted server answers on its public name and origin", () => {
    const hosted = { hosts: ["cold.example.com"], origins: ["https://cold.example.com"] };
    expect(refuseRequest(req("/api/session", { host: "cold.example.com", "x-cold": "1", origin: "https://cold.example.com" }), hosted)).toBeUndefined();
    expect(refuseRequest(req("/api/session", { host: "cold.example.com", "x-cold": "1", origin: "http://cold.example.com" }), hosted)).toBe("cross-origin requests are not allowed");
  });
});
