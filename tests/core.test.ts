import { describe, expect, it } from 'vitest';
import { Rng, hash2, hashSeed } from '../src/core/rng';
import { clamp, damp, easeInOutCubic, smoothstep, wrap } from '../src/core/math';

describe('Rng', () => {
  it('is deterministic for a seed and independent across seeds', () => {
    const a = new Rng('the-pool');
    const b = new Rng('the-pool');
    const c = new Rng('the-pool-2');
    const sequenceA = Array.from({ length: 24 }, () => a.next());
    const sequenceB = Array.from({ length: 24 }, () => b.next());
    const sequenceC = Array.from({ length: 24 }, () => c.next());
    expect(sequenceA).toEqual(sequenceB);
    expect(sequenceA).not.toEqual(sequenceC);
    expect(sequenceA.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it('forks without collapsing the stream', () => {
    const rng = new Rng(42);
    const fork = rng.fork('tiles');
    expect(fork.next()).not.toBe(rng.next());
    expect(hashSeed('x')).not.toBe(hashSeed('y'));
    const h = hash2(3, 7, 9);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(1);
  });
});

describe('math', () => {
  it('clamps and smooths at the edges', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5);
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(wrap(11, 0, 10)).toBeCloseTo(1);
    expect(damp(0, 1, 100, 0.016)).toBeGreaterThan(0.7);
  });
});
