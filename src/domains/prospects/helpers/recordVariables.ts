import { toSnakeCase } from "./normalize";

type Composite = Record<string, unknown>;

/** A phone composite as one string: "+1" + "5125550101". */
export function phoneFromComposite(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Composite;
  const number = typeof p.primaryPhoneNumber === "string" ? p.primaryPhoneNumber.trim() : "";
  if (!number) return undefined;
  const code = typeof p.primaryPhoneCallingCode === "string" ? p.primaryPhoneCallingCode.trim() : "";
  return number.startsWith("+") || !code ? number : `${code}${number}`;
}

/**
 * Every scalar field on a Twenty record as a snake_case template variable.
 * Composites collapse to their primary value (LINKS -> url, EMAILS -> email,
 * PHONES -> number, FULL_NAME -> "first last"). Relations and objects are
 * skipped. Pure.
 */
export function recordVariables(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) {
    if (name === "id" || name.endsWith("Id") || name === "position" || name === "searchVector") continue;
    let text: string | undefined;
    if (typeof value === "string") text = value;
    else if (typeof value === "number" || typeof value === "boolean") text = String(value);
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      const c = value as Composite;
      if (typeof c.primaryLinkUrl === "string") text = c.primaryLinkUrl;
      else if (typeof c.primaryEmail === "string") text = c.primaryEmail;
      else if ("primaryPhoneNumber" in c) text = phoneFromComposite(c);
      else if ("firstName" in c || "lastName" in c) text = [c.firstName, c.lastName].filter((s) => typeof s === "string" && s).join(" ");
    }
    if (text?.trim()) out[toSnakeCase(name)] = text.trim();
  }
  return out;
}
