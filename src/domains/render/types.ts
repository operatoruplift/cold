/** One piece of a parsed message template. */
export type TemplateNode =
  | { kind: "text"; value: string }
  | { kind: "variable"; name: string; fallback?: string; raw: string }
  | { kind: "variants"; options: TemplateNode[][]; raw: string };

export interface ParsedTemplate {
  nodes: TemplateNode[];
  /** Syntax problems, each prefixed with its line number. Empty when the template is valid. */
  errors: string[];
}

/**
 * strict: every variable needs a value or a fallback, otherwise it is reported missing.
 * partial: variables without a value stay as {{name}} (used for call scripts a rep reads live).
 */
export type RenderMode = "strict" | "partial";

export interface RenderOptions {
  mode: RenderMode;
  /** The same seed always picks the same variants, so a prospect always gets the same wording. */
  seed: string;
}

export interface RenderResult {
  text: string;
  /** Variables with no value and no fallback (strict mode only). */
  missing: string[];
  /** Variables the rendered text referenced. */
  used: string[];
}

export type Variables = Record<string, string | undefined>;

/** Where a variable's value comes from. */
export type VariableScope = "prospect" | "account" | "offer";

export interface VariableSpec {
  name: string;
  scope: VariableScope;
  /** How it must read inside a sentence. */
  description: string;
  example: string;
}
