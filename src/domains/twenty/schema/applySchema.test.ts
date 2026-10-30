import { describe, expect, test } from "bun:test";
import { applySchema } from "./applySchema";
import { SCHEMA_MANIFEST } from "./manifest";
import type { MetadataRequest } from "./types";

/** An in-memory metadata API: answers the snapshot query and records creates. */
function fakeWorkspace(objects: Record<string, string[]>) {
  const state = new Map(Object.entries(objects).map(([name, fields], i) => [name, { id: `obj-${i}`, fields: new Set(fields) }]));
  const created: string[] = [];
  const request: MetadataRequest = async <T>(query: string, variables?: Record<string, unknown>) => {
    if (query.includes("createOneObject")) {
      const o = (variables!.input as { object: { nameSingular: string } }).object;
      state.set(o.nameSingular, { id: `obj-new-${o.nameSingular}`, fields: new Set(["id", "name"]) });
      created.push(`object ${o.nameSingular}`);
      return {} as T;
    }
    if (query.includes("createOneField")) {
      const f = (variables!.input as { field: { objectMetadataId: string; name: string; relationCreationPayload?: { targetObjectMetadataId: string; targetFieldLabel: string } } }).field;
      const owner = [...state.entries()].find(([, o]) => o.id === f.objectMetadataId)!;
      owner[1].fields.add(f.name);
      created.push(`field ${owner[0]}.${f.name}`);
      return {} as T;
    }
    const edges = [...state.entries()].map(([name, o]) => ({
      node: { id: o.id, nameSingular: name, namePlural: `${name}s`, fields: { edges: [...o.fields].map((f) => ({ node: { name: f, type: "TEXT", isActive: true, options: null } })) } },
    }));
    return { objects: { edges } } as T;
  };
  return { request, created, state };
}

describe("applySchema", () => {
  test("creates coldTouch, its fields, coldTrigger on person, and the relations; skips dialer objects that are absent", async () => {
    const ws = fakeWorkspace({ person: ["id", "name"], company: ["id", "name"] });
    const report = await applySchema(ws.request);
    const touchFields = SCHEMA_MANIFEST.objects[0]!.fields.length;
    expect(ws.created).toContain("object coldTouch");
    expect(ws.created.filter((c) => c.startsWith("field coldTouch.")).length).toBe(touchFields + 2);
    expect(ws.created).toContain("field person.coldTrigger");
    expect(report.items.filter((i) => i.status === "skipped").map((i) => `${i.object}.${i.name}`).sort()).toEqual(["agencyProspect.coldTrigger", "coldTouch.agencyPerson", "coldTouch.agencyProspect"]);
    expect(report.items.some((i) => i.status === "failed")).toBe(false);
  });

  test("wires the dialer's objects when they exist", async () => {
    const ws = fakeWorkspace({ person: [], company: [], agencyProspect: [], agencyPerson: [] });
    await applySchema(ws.request);
    expect(ws.created).toContain("field agencyProspect.coldTrigger");
    expect(ws.created).toContain("field coldTouch.agencyProspect");
    expect(ws.created).toContain("field coldTouch.agencyPerson");
  });

  test("is idempotent: a second run creates nothing", async () => {
    const ws = fakeWorkspace({ person: [], company: [] });
    await applySchema(ws.request);
    const before = ws.created.length;
    const report = await applySchema(ws.request);
    expect(ws.created.length).toBe(before);
    expect(report.items.every((i) => i.status === "present" || i.status === "skipped")).toBe(true);
  });

  test("a dry run only reads", async () => {
    const ws = fakeWorkspace({ person: [], company: [] });
    const report = await applySchema(ws.request, { dryRun: true });
    expect(ws.created).toEqual([]);
    expect(report.items.some((i) => i.status === "missing")).toBe(true);
  });
});
