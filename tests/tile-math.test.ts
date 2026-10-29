import { describe, expect, it } from 'vitest';
import {
  TILE,
  algaeStrength,
  chipMask,
  detailFade,
  footprintFromDerivative,
  isChipped,
  parallaxOffsetTiles,
  profileHeight,
  reliefHeightMetres,
  tileCell,
  tileHash,
  tilesPerMetre,
  variationFade,
  waterlineBand,
} from '../src/core/tileMath';

describe('tile geometry', () => {
  it('puts eight 125 mm tiles in one world metre', () => {
    expect(tilesPerMetre()).toBeCloseTo(8);
    expect(tileCell(0.0625, 0.1875)).toMatchObject({ ix: 0, iy: 1 });
    const cell = tileCell(0.0625, 0.0625);
    expect(cell.u).toBeCloseTo(0.5);
    expect(cell.edgeMetres).toBeCloseTo(0.061);
  });

  it('treats negative world coordinates symmetrically', () => {
    const cell = tileCell(-0.0625, -0.0625);
    expect(cell.ix).toBe(-1);
    expect(cell.iy).toBe(-1);
    expect(cell.u).toBeCloseTo(0.5);
    expect(cell.edgeMetres).toBeCloseTo(0.061);
  });

  it('has a flat glaze, a chamfer, a rolled edge and a recessed grout floor', () => {
    expect(profileHeight(0)).toBe(0);
    expect(profileHeight(TILE.groutMetres * 0.5)).toBe(0);
    expect(profileHeight(0.061)).toBe(1);
    const midChamfer = profileHeight(TILE.groutMetres * 0.5 + TILE.bevelMetres * 0.5);
    expect(midChamfer).toBeGreaterThan(0.05);
    expect(midChamfer).toBeLessThan(0.35);
    // The rolled edge reaches almost all the way to the glaze over its run.
    const midRoll = profileHeight(TILE.groutMetres * 0.5 + TILE.bevelMetres + TILE.rollMetres * 0.5);
    expect(midRoll).toBeGreaterThan(0.6);
    expect(midRoll).toBeLessThan(0.9);
    // Monotonic across the chamfer and the roll.
    let previous = -1;
    const start = TILE.groutMetres * 0.5;
    const end = start + TILE.bevelMetres + TILE.rollMetres;
    for (let i = 0; i <= 20; i++) {
      const edge = start * (1 - i / 20) + end * (i / 20);
      const value = profileHeight(edge);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(reliefHeightMetres(0.061)).toBeCloseTo(TILE.reliefMetres);
  });
});

describe('tile parallax', () => {
  it('grows with grazing angles but stays bounded', () => {
    const faceOn = parallaxOffsetTiles(0.0012, 0.125, 1);
    const grazing = parallaxOffsetTiles(0.0012, 0.125, 0.15);
    expect(faceOn).toBeGreaterThan(0);
    expect(grazing).toBeGreaterThan(faceOn);
    expect(grazing).toBeLessThanOrEqual(0.35);
    // A degenerate view behaves like the clamp, not infinity.
    expect(Number.isFinite(parallaxOffsetTiles(0.0012, 0.125, 0))).toBe(true);
  });

  it('fades detail and per-tile variation at different footprints', () => {
    expect(detailFade(0)).toBe(1);
    expect(detailFade(2)).toBe(0);
    expect(detailFade(0.4)).toBeGreaterThan(0);
    expect(detailFade(0.4)).toBeLessThan(1);
    expect(variationFade(0.3)).toBe(1);
    expect(variationFade(3)).toBe(0);
    // Variation survives further than bevel detail, which is the point.
    expect(variationFade(0.6)).toBeGreaterThan(detailFade(0.6));
    expect(footprintFromDerivative(-0.02)).toBeCloseTo(0.02);
  });
});

describe('per-tile variation', () => {
  it('hashes deterministically into [0, 1)', () => {
    for (let i = 0; i < 200; i++) {
      const value = tileHash(i, i * 7 + 3);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      expect(tileHash(i, i * 7 + 3)).toBe(value);
    }
    expect(tileHash(3, 9)).not.toBe(tileHash(9, 3));
  });

  it('marks only a small fraction of tiles as chipped', () => {
    let chips = 0;
    for (let i = 0; i < 4000; i++) {
      if (isChipped(tileHash(i, 11))) chips++;
    }
    const rate = chips / 4000;
    expect(rate).toBeGreaterThan(0.01);
    expect(rate).toBeLessThan(0.09);
  });

  it('puts a chip only near the chosen corner', () => {
    expect(chipMask(1, 1, 1, 1)).toBeGreaterThan(0.9);
    expect(chipMask(0.5, 0.5, 1, 1)).toBe(0);
    expect(chipMask(0, 0, 1, 1)).toBe(0);
    expect(chipMask(0, 0, 0, 0)).toBeGreaterThan(0.9);
  });
});

describe('waterline grime', () => {
  it('peaks at the waterline and decays with distance', () => {
    expect(waterlineBand(0)).toBeCloseTo(1);
    expect(waterlineBand(1.5)).toBeLessThan(0.05);
    expect(waterlineBand(-1.5)).toBeLessThan(0.05);
    // Underwater growth reaches further than the dry salt bloom above it.
    expect(waterlineBand(-0.2)).toBeGreaterThan(waterlineBand(0.2));
  });

  it('gates algae by the drift noise and amount', () => {
    expect(algaeStrength(0, 0, 0, 1)).toBeGreaterThan(0.4);
    expect(algaeStrength(0, 0, 0, 0)).toBe(0);
    expect(algaeStrength(2, 0, 1, 1)).toBeLessThan(0.05);
    const low = algaeStrength(-0.1, 0, 0.8, 0.6);
    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThanOrEqual(0.6);
  });
});
