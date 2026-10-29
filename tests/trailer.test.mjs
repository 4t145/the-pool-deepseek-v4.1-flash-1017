import { describe, expect, it } from 'vitest';
import {
  buildTrailerPlan,
  buildXfadeFilter,
  frameName,
  parseSegments,
  validateTrailerPlan,
} from '../scripts/lib/trailer-plan.mjs';

describe('trailer plan', () => {
  it('samples exact 24 fps times for every segment', () => {
    const plan = buildTrailerPlan({ segments: [{ start: 14, duration: 2 }], fps: 24 });
    const times = plan.segments[0].frames.map((frame) => frame.time);
    expect(plan.segments[0].frameCount).toBe(48);
    expect(times[0]).toBeCloseTo(14, 6);
    expect(times[1]).toBeCloseTo(14 + 1 / 24, 6);
    expect(times[47] - times[0]).toBeCloseTo(47 / 24, 6);
    // Every step is exactly one frame; drift would break grain cadence.
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeCloseTo(1 / 24, 5);
  });

  it('keeps the default cut inside the 20–30 s acceptance window', () => {
    const plan = buildTrailerPlan();
    const validation = validateTrailerPlan(plan);
    expect(validation.ok).toBe(true);
    expect(plan.totalSeconds).toBeGreaterThanOrEqual(20);
    expect(plan.totalSeconds).toBeLessThanOrEqual(30);
    expect(plan.totalFrames).toBe(576);
    expect(plan.width).toBe(1920);
    expect(plan.height).toBe(1080);
    expect(plan.fps).toBe(24);
  });

  it('measures xfade offsets on the accumulated, already-crossfaded stream', () => {
    const plan = buildTrailerPlan({
      segments: [
        { start: 0, duration: 8 },
        { start: 14, duration: 8 },
        { start: 33, duration: 8 },
      ],
      crossfade: 0.6,
    });
    // 8 - 0.6 = 7.4, then 8 + 8 - 0.6 - 0.6 = 14.8.
    expect(plan.offsets).toEqual([7.4, 14.8]);
    expect(plan.totalSeconds).toBeCloseTo(22.8, 6);
    const filter = buildXfadeFilter(plan);
    expect(filter).toContain('offset=7.400');
    expect(filter).toContain('offset=14.800');
    expect(filter?.trim().endsWith('[v]')).toBe(true);
    expect(filter?.match(/xfade=/g)?.length).toBe(2);
  });

  it('retimes a cut to an exact requested duration on the frame grid', () => {
    const plan = buildTrailerPlan({
      segments: [
        { start: 0, duration: 8.4167 },
        { start: 14, duration: 8.4167 },
        { start: 33, duration: 8.4167 },
      ],
      crossfade: 0.6,
    });
    expect(Math.abs(plan.totalSeconds - 24.05)).toBeLessThan(0.1);
    expect(validateTrailerPlan(plan).ok).toBe(true);
  });

  it('rejects plans outside the acceptance bounds', () => {
    const short = buildTrailerPlan({ segments: [{ start: 0, duration: 5 }] });
    expect(validateTrailerPlan(short).ok).toBe(false);
    expect(validateTrailerPlan(short).problems[0]).toMatch(/outside 20–30s/);

    const long = buildTrailerPlan({ segments: [{ start: 0, duration: 35 }] });
    expect(validateTrailerPlan(long).ok).toBe(false);

    const wrongFps = buildTrailerPlan({ fps: 30, segments: [{ start: 0, duration: 24 }] });
    expect(validateTrailerPlan(wrongFps).ok).toBe(false);
  });

  it('refuses frames past the end of the guided take', () => {
    expect(() =>
      buildTrailerPlan({ segments: [{ start: 47, duration: 4 }], cinematicDuration: 49 }),
    ).toThrow(/exceeds the guided take/);
  });

  it('parses segment specs and rejects garbage', () => {
    expect(parseSegments('0:8,14:8,33:8')).toEqual([
      { start: 0, duration: 8 },
      { start: 14, duration: 8 },
      { start: 33, duration: 8 },
    ]);
    expect(() => parseSegments('0:0')).toThrow(/Invalid trailer segment/);
    expect(() => parseSegments('nope')).toThrow(/Invalid trailer segment/);
    expect(parseSegments(null).length).toBe(3);
  });

  it('pins the frame filename format', () => {
    expect(frameName(0)).toBe('frame_00000.png');
    expect(frameName(575)).toBe('frame_00575.png');
    expect(frameName(3, 'jpg')).toBe('frame_00003.jpg');
  });
});
