/** Twenty field types the cold schema uses (FieldMetadataType). */
export type SchemaFieldType = "TEXT" | "NUMBER" | "BOOLEAN" | "DATE_TIME" | "SELECT";

export interface SchemaSelectOption {
  value: string;
  label: string;
  color: string;
}

export interface SchemaField {
  name: string;
  type: SchemaFieldType;
  label: string;
  description?: string;
  icon?: string;
  options?: SchemaSelectOption[];
}

/** A custom object. Twenty adds id, name, createdAt and the other standard fields itself. */
export interface SchemaObject {
  nameSingular: string;
  namePlural: string;
  labelSingular: string;
  labelPlural: string;
  description: string;
  icon: string;
  fields: SchemaField[];
}

/** Fields added to an object that already exists (person, or the dialer's agencyProspect). */
export interface SchemaExtension {
  object: string;
  /** Skip quietly when the object is not in the workspace (the dialer is not installed). */
  optional: boolean;
  fields: SchemaField[];
}

/**
 * A MANY_TO_ONE relation from `object` to `target`. Twenty creates the
 * ONE_TO_MANY inverse on the target, named from targetFieldLabel. The REST
 * foreign key is `${name}Id`.
 */
export interface SchemaRelation {
  object: string;
  name: string;
  label: string;
  icon: string;
  target: string;
  targetFieldName: string;
  targetFieldLabel: string;
  targetFieldIcon: string;
  /** Skip quietly when the target object does not exist. */
  optional: boolean;
}

export interface SchemaManifest {
  objects: SchemaObject[];
  extensions: SchemaExtension[];
  relations: SchemaRelation[];
}

export type ApplyStatus = "created" | "present" | "missing" | "skipped" | "failed";

export interface ApplyItem {
  kind: "object" | "field" | "relation";
  object: string;
  name: string;
  status: ApplyStatus;
  note?: string;
}

export interface ApplyReport {
  dryRun: boolean;
  items: ApplyItem[];
}

/** Sends one metadata GraphQL document; resolves to `data`. */
export type MetadataRequest = <T = unknown>(query: string, variables?: Record<string, unknown>) => Promise<T>;
