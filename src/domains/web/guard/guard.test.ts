import { describe, expect, test } from "bun:test";
import { localHosts, refuseRequest } from ".";

const hosts = localHosts(4100);
const req = (path: string, headers: Record<string, string>) => new Request(`http://127.0.0.1:4100${path}`, { headers });

describe("refuseRequest", () => {
  test("serves the page on localhost, and API calls with the header", () => {
    expect(refuseRequest(req("/", { host: "localhost:4100" }), hosts)).toBeUndefined();
    expect(refuseRequest(req("/api/status", { host: "127.0.0.1:4100", "x-cold": "1" }), hosts)).toBeUndefined();
    expect(refuseRequest(req("/api/status", { host: "127.0.0.1:4100", "x-cold": "1", origin: "http://127.0.0.1:4100" }), hosts)).toBeUndefined();
  });

  test("refuses another Host (DNS rebinding)", () => {
    expect(refuseRequest(req("/", { host: "evil.example:4100" }), hosts)).toBe("cold only answers on localhost");
    expect(refuseRequest(req("/api/status", { host: "evil.example", "x-cold": "1" }), hosts)).toBe("cold only answers on localhost");
  });

  test("refuses API calls without the header, or from another origin", () => {
    expect(refuseRequest(req("/api/campaigns", { host: "localhost:4100" }), hosts)).toBe("missing the x-cold header");
    expect(refuseRequest(req("/api/campaigns", { host: "localhost:4100", "x-cold": "1", origin: "https://evil.example" }), hosts)).toBe("cross-origin requests are not allowed");
  });
});
