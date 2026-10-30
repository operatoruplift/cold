/** FNV-1a: a small, stable 32-bit hash. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** An index in [0, count) chosen by the seed: the same seed always gets the same answer. */
export function pickVariant(seed: string, count: number): number {
  return count <= 1 ? 0 : hash32(seed) % count;
}
