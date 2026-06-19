// Seeded PRNG (mulberry32). The sim uses ONLY this — never Math.random — so a
// run is fully reproducible from (seed + identical player actions). Forward hook
// for daily-seed runs later.

export interface Rng {
  /** float in [0, 1) */
  next(): number;
  /** integer in [0, maxExclusive) */
  int(maxExclusive: number): number;
  /** float in [min, max) */
  range(min: number, max: number): number;
  /** uniform element of a non-empty array */
  pick<T>(arr: readonly T[]): T;
  /** current internal state (for save/restore / debugging) */
  state: number;
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0;

  const next = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int: (maxExclusive: number) => Math.floor(next() * maxExclusive),
    range: (min: number, max: number) => min + next() * (max - min),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)],
    get state() {
      return s >>> 0;
    },
    set state(v: number) {
      s = v >>> 0;
    },
  };
}

/** Weighted pick: returns the index chosen with probability proportional to weights. */
export function weightedIndex(rng: Rng, weights: number[]): number {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (total <= 0) return rng.int(weights.length);
  let r = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i] > 0 ? weights[i] : 0;
    if (r < w) return i;
    r -= w;
  }
  return weights.length - 1;
}
