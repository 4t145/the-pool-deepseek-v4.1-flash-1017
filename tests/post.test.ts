import { describe, expect, it } from 'vitest';
import {
  aces,
  agx,
  BLOOM_KNEE,
  BLOOM_THRESHOLD,
  brightPass,
  chromaticOffsetUv,
  compositeDisplay,
  dither,
  filmGrain,
  grade,
  grainFrame,
  GRAIN_FRAME_RATE,
  LETTERBOX_ASPECT,
  letterboxBars,
  srgbDecode,
  srgbEncode,
  toneMap,
  vignetteFactor,
  type Rgb,
} from '../src/core/post';

const neutral = (value: number): Rgb => [value, value, value];
const lum = (rgb: Rgb): number => rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;

describe('display transform', () => {
  it('maps neutral input to neutral output for both curves', () => {
    for (const value of [0.001, 0.02, 0.18, 1, 4]) {
      for (const curve of ['agx', 'aces'] as const) {
        const mapped = curve === 'agx' ? agx(neutral(value)) : aces(neutral(value));
        expect(mapped[0]).toBeCloseTo(mapped[1], 3);
        expect(mapped[1]).toBeCloseTo(mapped[2], 3);
      }
    }
  });

  it('is monotonic and bounded in [0,1]', () => {
    let previous = -1;
    for (let i = 0; i <= 60; i++) {
      const value = Math.pow(10, -3 + (i / 60) * 4); // 0.001 .. 10
      const mapped = agx(neutral(value));
      const display = srgbEncode(mapped[0]);
      expect(display).toBeGreaterThanOrEqual(previous - 1e-7);
      expect(display).toBeGreaterThanOrEqual(0);
      expect(display).toBeLessThanOrEqual(1);
      previous = display;
    }
  });

  it('keeps more highlight structure than ACES in the top two stops', () => {
    for (const value of [1.5, 2, 3, 4, 8]) {
      const agxDisplay = srgbEncode(agx(neutral(value))[0]);
      const acesDisplay = srgbEncode(aces(neutral(value))[0]);
      expect(agxDisplay).toBeLessThan(acesDisplay);
      expect(agxDisplay).toBeLessThanOrEqual(1);
    }
    // Middle grey is a sensible photographic value on both curves.
    const midAgx = srgbEncode(agx(neutral(0.18))[0]);
    expect(midAgx).toBeGreaterThan(0.4);
    expect(midAgx).toBeLessThan(0.64);
  });

  it('applies exposure exactly once inside the transform', () => {
    for (const curve of ['agx', 'aces'] as const) {
      const base = srgbEncode(toneMap(neutral(0.2), 1, curve)[0]);
      const brighter = srgbEncode(toneMap(neutral(0.2), 1.5, curve)[0]);
      expect(brighter).toBeGreaterThan(base);
      expect(toneMap(neutral(0.2), 1, curve)).toEqual(toneMap(neutral(0.2), 1, curve));
    }
  });

  it('uses the exact sRGB transfer as the only encode', () => {
    expect(srgbEncode(0)).toBe(0);
    expect(srgbEncode(1)).toBeCloseTo(1, 8);
    for (const value of [0.001, 0.01, 0.05, 0.25, 0.75]) {
      expect(srgbDecode(srgbEncode(value))).toBeCloseTo(value, 8);
    }
  });
});

describe('bloom bright pass', () => {
  it('contributes nothing below threshold - knee', () => {
    const below = BLOOM_THRESHOLD - BLOOM_KNEE - 0.01;
    expect(brightPass(neutral(below))).toEqual([0, 0, 0]);
    expect(brightPass([0.2, 0.3, 0.1])).toEqual([0, 0, 0]);
  });

  it('is continuous across the knee', () => {
    const atThreshold = brightPass(neutral(BLOOM_THRESHOLD));
    const justAbove = brightPass(neutral(BLOOM_THRESHOLD + 1e-5));
    const kneeEdge = BLOOM_THRESHOLD + BLOOM_KNEE;
    expect(Math.abs(atThreshold[0] - justAbove[0])).toBeLessThan(1e-3);
    // Above the knee the pass is exactly (luminance - threshold).
    expect(brightPass(neutral(kneeEdge + 1))[0]).toBeCloseTo(kneeEdge + 1 - BLOOM_THRESHOLD, 5);
  });

  it('preserves hue while keeping the excess energy', () => {
    const warm: Rgb = [2.4, 1.7, 1.1];
    const bloom = brightPass(warm);
    expect(bloom[0]).toBeGreaterThan(bloom[1]);
    expect(bloom[1]).toBeGreaterThan(bloom[2]);
    expect(bloom[0]).toBeLessThan(warm[0]);
    expect(lum(bloom)).toBeGreaterThan(0);
  });
});

describe('deterministic film grain', () => {
  it('quantises the clock to 24 fps and is stable for renderAt', () => {
    expect(GRAIN_FRAME_RATE).toBe(24);
    expect(grainFrame(0)).toBe(0);
    expect(grainFrame(1 / 24)).toBe(1);
    expect(grainFrame(1 / 24 - 1e-4)).toBe(0);
    expect(grainFrame(3.2)).toBe(grainFrame(3.2));
    expect(grainFrame(3.2)).not.toBe(grainFrame(3.2 + 1 / 24));
  });

  it('returns identical samples for identical pixel/frame and differs across frames', () => {
    const a = filmGrain(120, 80, 76, 0.3);
    const b = filmGrain(120, 80, 76, 0.3);
    const c = filmGrain(120, 80, 77, 0.3);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('is stronger in shadows and stays subtle', () => {
    let shadowSum = 0;
    let highlightSum = 0;
    for (let i = 0; i < 4000; i++) {
      shadowSum += Math.abs(filmGrain(i % 97, Math.floor(i / 97), 5, 0.08));
      highlightSum += Math.abs(filmGrain(i % 97, Math.floor(i / 97), 5, 0.85));
    }
    expect(shadowSum).toBeGreaterThan(highlightSum);
    const sample = filmGrain(17, 29, 11, 0.2);
    expect(Math.abs(sample)).toBeLessThan(0.05);
  });

  it('dithers by at most half an 8-bit step', () => {
    for (let i = 0; i < 500; i++) {
      expect(Math.abs(dither(i, i * 3, 7))).toBeLessThanOrEqual(0.5 / 255 + 1e-9);
    }
    expect(dither(5, 9, 3)).toBe(dither(5, 9, 3));
  });
});

describe('letterbox', () => {
  it('stays clean at 16:9 and applies symmetric bars for wider images', () => {
    // A 16:9 frame presenting a 2.39:1 image gets ~12.8% bars top and bottom.
    expect(letterboxBars(16 / 9)).toBeCloseTo((1 - 16 / 9 / LETTERBOX_ASPECT) / 2, 8);
    expect(letterboxBars(16 / 9) * 1080).toBeCloseTo(138.33, 1);
    expect(letterboxBars(LETTERBOX_ASPECT)).toBe(0);
    expect(letterboxBars(21 / 9)).toBeGreaterThan(0);
    expect(letterboxBars(21 / 9)).toBeLessThan(letterboxBars(16 / 9));
    expect(letterboxBars(2.76)).toBe(0);
    expect(letterboxBars(16 / 9)).toBeLessThan(letterboxBars(4 / 3));
    expect(letterboxBars(2.39 / 2)).toBeLessThan(0.5);
  });
});

describe('lens and grade', () => {
  it('has no chromatic aberration at the centre and only edges at the corners', () => {
    expect(chromaticOffsetUv(0.5, 0.5)).toEqual([0, 0]);
    const edge = chromaticOffsetUv(0.5, 0.01);
    const mid = chromaticOffsetUv(0.5, 0.3);
    expect(Math.abs(edge[1])).toBeGreaterThan(Math.abs(mid[1]));
    expect(Math.abs(edge[0])).toBeLessThan(1e-6);
    // Under two pixels at 1080p.
    expect(Math.abs(edge[1]) * 1080).toBeLessThan(2);
    expect(chromaticOffsetUv(0.1, 0.5)[0]).toBeLessThan(0);
    expect(chromaticOffsetUv(0.9, 0.5)[0]).toBeGreaterThan(0);
  });

  it('has a gentle vignette that is neutral at the centre', () => {
    expect(vignetteFactor(0.5, 0.5)).toBeCloseTo(1, 8);
    expect(vignetteFactor(0.02, 0.02)).toBeGreaterThan(0.7);
    expect(vignetteFactor(0.02, 0.02)).toBeLessThanOrEqual(1);
    expect(vignetteFactor(0.5, 0.08)).toBeLessThan(vignetteFactor(0.5, 0.3));
  });

  it('keeps neutrals neutral and clamps the grade', () => {
    for (const value of [0.05, 0.4, 0.8]) {
      const graded = grade(neutral(value));
      expect(Math.abs(graded[0] - graded[1])).toBeLessThan(0.012);
      expect(Math.abs(graded[1] - graded[2])).toBeLessThan(0.012);
      expect(graded[0]).toBeGreaterThanOrEqual(0);
      expect(graded[0]).toBeLessThanOrEqual(1);
    }
    const desaturated = grade([0.8, 0.2, 0.1], 0);
    expect(Math.abs(desaturated[0] - desaturated[1])).toBeLessThan(0.012);
    expect(Math.abs(desaturated[1] - desaturated[2])).toBeLessThan(0.012);
  });
});

describe('composite', () => {
  it('is deterministic and bounded', () => {
    const hdr: Rgb = [0.4, 0.32, 0.25];
    const bloom: Rgb = [0.2, 0.18, 0.15];
    const a = compositeDisplay(hdr, bloom, { exposure: 1.25, bloomStrength: 0.34 });
    const b = compositeDisplay(hdr, bloom, { exposure: 1.25, bloomStrength: 0.34 });
    expect(a).toEqual(b);
    for (const channel of a) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
  });

  it('only adds bloom when the bloom buffer has energy', () => {
    const hdr: Rgb = [0.4, 0.32, 0.25];
    const dark = compositeDisplay(hdr, [0, 0, 0]);
    const lit = compositeDisplay(hdr, [1, 0.9, 0.8]);
    expect(lit[0]).toBeGreaterThan(dark[0]);
    expect(lit[1]).toBeGreaterThan(dark[1]);
  });
});
