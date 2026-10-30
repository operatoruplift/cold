/**
 * A parsed header value (mailparser) as plain text: structured values like
 * content-type become "multipart/report; report-type=delivery-status",
 * address lists their text, dates ISO strings.
 */
export function headerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(headerText).join(", ");
  if (value && typeof value === "object") {
    const v = value as { value?: unknown; params?: Record<string, string>; text?: unknown };
    if (typeof v.value === "string") {
      const params = Object.entries(v.params ?? {}).map(([k, p]) => `${k}=${p}`);
      return [v.value, ...params].join("; ");
    }
    if (typeof v.text === "string") return v.text;
  }
  return String(value ?? "");
}
