/** "reviewCount" -> "review_count", "First Name" -> "first_name". */
export function toSnakeCase(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/** A lowercase email address, or undefined when it is not one. */
export function normalizeEmail(value: string | undefined): string | undefined {
  const v = value?.trim().toLowerCase().replace(/^mailto:/, "");
  return v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : undefined;
}

/** "https://www.linkedin.com/in/Dana-Reyes/?x=1" -> "dana-reyes". */
export function linkedinSlug(value: string | undefined): string | undefined {
  const m = value ? /linkedin\.com\/(?:in|company)\/([^/?#\s]+)/i.exec(value) : null;
  return m ? decodeURIComponent(m[1]!).toLowerCase() : undefined;
}

/** "@Dana", "https://x.com/Dana", "twitter.com/dana" -> "dana". */
export function socialHandle(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const v = value.trim();
  const fromUrl = /(?:x|twitter|instagram|facebook)\.com\/([^/?#\s]+)/i.exec(v);
  const handle = (fromUrl ? fromUrl[1]! : v).replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_.]+$/.test(handle) ? handle : undefined;
}

/** "https://www.clearviewtint.com/" -> "clearviewtint.com". */
export function websiteHost(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  return v.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "").replace(/[/?#].*$/, "").toLowerCase() || undefined;
}

/** "Dana Reyes" -> ["Dana", "Reyes"]. */
export function splitName(full: string | undefined): [string | undefined, string | undefined] {
  const parts = full?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (parts.length === 0) return [undefined, undefined];
  return [parts[0], parts.length > 1 ? parts.slice(1).join(" ") : undefined];
}

/** "yes", "true", "1", "x" -> true. */
export function isTruthy(value: string | undefined): boolean {
  return /^(1|y|yes|true|x|dnc|do_not_contact)$/i.test(value?.trim() ?? "");
}
