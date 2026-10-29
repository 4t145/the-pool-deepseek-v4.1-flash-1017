/** Deterministic, seedable per-system RNG. Never use Math.random inside the scene graph. */
export class Rng {
  private state: number;

  constructor(seed: number | string) {
    this.state = hashSeed(seed);
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  /** Roughly normal, mean 0, sd 1 (sum of three uniforms). */
  gaussian(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 2.0;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  fork(label: string): Rng {
    return new Rng(`${this.state}:${label}`);
  }
}

/** FNV-1a style hash. Stable across runs and platforms. */
export function hashSeed(seed: number | string): number {
  const text = typeof seed === 'number' ? String(seed) : seed;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stateless 2D hash in [0,1), used by texture generators. */
export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
