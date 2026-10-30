import { SCHEMA_MANIFEST } from "./manifest";
import type { ApplyItem, ApplyReport, MetadataRequest, SchemaField, SchemaManifest, SchemaRelation } from "./types";

export interface LiveField {
  type: string;
  isActive: boolean;
  options: Array<{ value: string }> | null;
}

export interface LiveObject {
  id: string;
  nameSingular: string;
  namePlural: string;
  fields: Map<string, LiveField>;
}

const SNAPSHOT_QUERY = `{ objects(paging: { first: 1000 }) { edges { node { id nameSingular namePlural
  fields(paging: { first: 1000 }) { edges { node { name type isActive options } } } } } } }`;

const CREATE_OBJECT = `mutation CreateObject($input: CreateOneObjectInput!) {
  createOneObject(input: $input) { id nameSingular } }`;

const CREATE_FIELD = `mutation CreateField($input: CreateOneFieldMetadataInput!) {
  createOneField(input: $input) { id name } }`;

interface SnapshotData {
  objects: { edges: Array<{ node: { id: string; nameSingular: string; namePlural: string; fields: { edges: Array<{ node: { name: string; type: string; isActive?: boolean; options?: unknown } }> } } }> };
}

/** Read-only: every object in the workspace with its fields. */
export async function readLiveSchema(request: MetadataRequest): Promise<Map<string, LiveObject>> {
  const data = await request<SnapshotData>(SNAPSHOT_QUERY);
  const out = new Map<string, LiveObject>();
  for (const { node } of data.objects.edges) {
    const fields = new Map<string, LiveField>();
    for (const { node: f } of node.fields.edges) {
      fields.set(f.name, { type: f.type, isActive: f.isActive !== false, options: Array.isArray(f.options) ? (f.options as Array<{ value: string }>) : null });
    }
    out.set(node.nameSingular, { id: node.id, nameSingular: node.nameSingular, namePlural: node.namePlural, fields });
  }
  return out;
}

const isExistsError = (err: unknown) => /already exists|already used by another field/i.test(String((err as Error)?.message ?? ""));

/** Drift on a field that exists: different type, inactive, or SELECT values it lacks. Reported, never changed. */
function driftNote(want: { type: string; options?: Array<{ value: string }> }, live: LiveField): string | undefined {
  const notes: string[] = [];
  if (live.type !== want.type) notes.push(`type is ${live.type}, manifest says ${want.type}`);
  if (!live.isActive) notes.push("field is inactive");
  if (want.options && live.options) {
    const have = new Set(live.options.map((o) => o.value));
    const lacking = want.options.filter((o) => !have.has(o.value)).map((o) => o.value);
    if (lacking.length) notes.push(`missing options ${lacking.join(", ")}`);
  }
  return notes.length ? notes.join("; ") : undefined;
}

function fieldInput(objectMetadataId: string, f: SchemaField): Record<string, unknown> {
  return {
    objectMetadataId,
    type: f.type,
    name: f.name,
    label: f.label,
    description: f.description ?? "",
    ...(f.icon ? { icon: f.icon } : {}),
    isNullable: true,
    isLabelSyncedWithName: false,
    ...(f.options ? { options: f.options.map((o, position) => ({ ...o, position })) } : {}),
  };
}

function relationInput(objectMetadataId: string, targetObjectMetadataId: string, r: SchemaRelation): Record<string, unknown> {
  return {
    objectMetadataId,
    type: "RELATION",
    name: r.name,
    label: r.label,
    description: "",
    icon: r.icon,
    isNullable: true,
    isLabelSyncedWithName: false,
    settings: { relationType: "MANY_TO_ONE", onDelete: "SET_NULL", joinColumnName: `${r.name}Id` },
    relationCreationPayload: { targetObjectMetadataId, targetFieldLabel: r.targetFieldLabel, targetFieldIcon: r.targetFieldIcon, type: "MANY_TO_ONE" },
  };
}

/**
 * Bring a workspace up to the manifest: objects, then their fields, then
 * fields on existing objects, then relations. Idempotent and additive: it
 * creates what is missing, never edits or deletes, and reports drift on what
 * is present. Optional parts (the dialer's objects) are skipped when absent.
 * With dryRun it only reads, and reports what it would create as "missing".
 */
export async function applySchema(request: MetadataRequest, options: { dryRun?: boolean; manifest?: SchemaManifest; onItem?: (item: ApplyItem) => void } = {}): Promise<ApplyReport> {
  const manifest = options.manifest ?? SCHEMA_MANIFEST;
  const dryRun = options.dryRun ?? false;
  const items: ApplyItem[] = [];
  const push = (item: ApplyItem) => {
    items.push(item);
    options.onItem?.(item);
  };

  let live = await readLiveSchema(request);

  let createdObject = false;
  for (const o of manifest.objects) {
    if (live.has(o.nameSingular)) {
      push({ kind: "object", object: o.nameSingular, name: o.namePlural, status: "present" });
      continue;
    }
    if (dryRun) {
      push({ kind: "object", object: o.nameSingular, name: o.namePlural, status: "missing" });
      continue;
    }
    try {
      await request(CREATE_OBJECT, {
        input: { object: { nameSingular: o.nameSingular, namePlural: o.namePlural, labelSingular: o.labelSingular, labelPlural: o.labelPlural, description: o.description, icon: o.icon, isLabelSyncedWithName: false } },
      });
      createdObject = true;
      push({ kind: "object", object: o.nameSingular, name: o.namePlural, status: "created" });
    } catch (err) {
      push({ kind: "object", object: o.nameSingular, name: o.namePlural, status: "failed", note: (err as Error).message });
    }
  }
  if (createdObject) live = await readLiveSchema(request);

  const fieldGroups = [
    ...manifest.objects.map((o) => ({ object: o.nameSingular, optional: false, fields: o.fields })),
    ...manifest.extensions,
  ];
  for (const group of fieldGroups) {
    const obj = live.get(group.object);
    for (const f of group.fields) {
      const item = { kind: "field" as const, object: group.object, name: f.name };
      const existing = obj?.fields.get(f.name);
      if (existing) {
        push({ ...item, status: "present", note: driftNote(f, existing) });
        continue;
      }
      if (!obj && group.optional) {
        push({ ...item, status: "skipped", note: `no ${group.object} object in this workspace` });
        continue;
      }
      if (dryRun) {
        push({ ...item, status: "missing" });
        continue;
      }
      if (!obj) {
        push({ ...item, status: "failed", note: `object ${group.object} does not exist` });
        continue;
      }
      try {
        await request(CREATE_FIELD, { input: { field: fieldInput(obj.id, f) } });
        push({ ...item, status: "created" });
      } catch (err) {
        push({ ...item, status: isExistsError(err) ? "present" : "failed", note: isExistsError(err) ? undefined : (err as Error).message });
      }
    }
  }

  for (const r of manifest.relations) {
    const item = { kind: "relation" as const, object: r.object, name: r.name };
    const source = live.get(r.object);
    const target = live.get(r.target);
    const existing = source?.fields.get(r.name);
    if (existing) {
      push({ ...item, status: "present", note: driftNote({ type: "RELATION" }, existing) });
      continue;
    }
    if (!target && r.optional) {
      push({ ...item, status: "skipped", note: `no ${r.target} object in this workspace` });
      continue;
    }
    if (dryRun) {
      push({ ...item, status: "missing", note: `-> ${r.target}.${r.targetFieldName}` });
      continue;
    }
    if (!source || !target) {
      push({ ...item, status: "failed", note: `object ${!source ? r.object : r.target} does not exist` });
      continue;
    }
    if (target.fields.has(r.targetFieldName)) {
      push({ ...item, status: "failed", note: `${r.target}.${r.targetFieldName} already exists without this relation` });
      continue;
    }
    try {
      await request(CREATE_FIELD, { input: { field: relationInput(source.id, target.id, r) } });
      push({ ...item, status: "created" });
    } catch (err) {
      push({ ...item, status: isExistsError(err) ? "present" : "failed", note: isExistsError(err) ? undefined : (err as Error).message });
    }
  }

  return { dryRun, items };
}
