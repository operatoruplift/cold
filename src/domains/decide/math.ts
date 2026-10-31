/** Small, pure numerics for decisions and learning. */

export const clamp01 = (x: unknown): number => {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

/** Probabilities over exactly these options, adding up to 1 (weights or percentages are scaled). Nothing usable gives even odds. */
export function normalize(probabilities: Record<string, unknown> | undefined, options: string[]): Record<string, number> {
  const raw = options.map((o) => {
    const n = Number(probabilities?.[o]);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  const total = raw.reduce((a, b) => a + b, 0);
  return Object.fromEntries(options.map((o, i) => [o, total > 0 ? raw[i]! / total : 1 / options.length]));
}

/** The option with the highest probability; the first one on a tie. */
export function argmax(probabilities: Record<string, number>): string {
  let best = "";
  let top = -1;
  for (const [option, p] of Object.entries(probabilities)) {
    if (p > top) {
      best = option;
      top = p;
    }
  }
  return best;
}

/** 1 when all the probability is on one option, 0 when it is spread evenly: one minus normalised entropy. */
export function concentration(probabilities: Record<string, number>): number {
  const ps = Object.values(probabilities);
  if (ps.length < 2) return 1;
  const entropy = -ps.reduce((sum, p) => (p > 0 ? sum + p * Math.log(p) : sum), 0);
  return clamp01(1 - entropy / Math.log(ps.length));
}

/** A seeded random source, so a report computed twice reads the same. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** A Gamma(shape, 1) draw (Marsaglia and Tsang; shapes under 1 are boosted). */
function gamma(shape: number, random: () => number): number {
  if (shape < 1) return gamma(shape + 1, random) * Math.pow(Math.max(random(), 1e-12), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(random);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(Math.max(u, 1e-300)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** A Beta(a, b) draw. */
export function sampleBeta(a: number, b: number, random: () => number): number {
  const x = gamma(Math.max(a, 1e-3), random);
  const y = gamma(Math.max(b, 1e-3), random);
  return x + y > 0 ? x / (x + y) : 0;
}

/** Wilson's interval for a rate of wins out of n, at about 90% (z = 1.645). */
export function wilson(wins: number, n: number, z = 1.645): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = wins / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** How likely each arm is the best one, from wins out of n each with an even prior. Monte Carlo, seeded. */
export function chanceBest(arms: Record<string, { wins: number; n: number }>, draws = 4000, random = seeded(7)): Record<string, number> {
  const names = Object.keys(arms);
  const best = Object.fromEntries(names.map((n) => [n, 0])) as Record<string, number>;
  if (!names.length) return best;
  for (let i = 0; i < draws; i++) {
    let top = "";
    let value = -1;
    for (const name of names) {
      const { wins, n } = arms[name]!;
      const draw = sampleBeta(1 + wins, 1 + Math.max(0, n - wins), random);
      if (draw > value) {
        value = draw;
        top = name;
      }
    }
    best[top]!++;
  }
  return Object.fromEntries(names.map((n) => [n, best[n]! / draws]));
}
