/** An X handle from what a list or a touch holds: "@name", "name" or a profile link. Undefined when it isn't one. Pure. */
export function handleOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const fromUrl = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i.exec(trimmed)?.[1];
  const handle = (fromUrl ?? trimmed).replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : undefined;
}
