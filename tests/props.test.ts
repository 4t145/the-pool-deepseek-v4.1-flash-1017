import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { LAYOUT } from '../src/world/layout';
import {
  flumeSpiralPoints,
  postPositions,
  railingSpans,
  ringFloatPose,
  wrapAngle,
} from '../src/world/propLayout';

describe('flume spiral', () => {
  const options = {
    center: new Vector3(4.55, 0, -14.5),
    startAngle: Math.PI * 0.38,
    turns: -1.25,
    startRadius: 1.25,
    endRadius: 1.95,
    topY: 6.25,
    bottomY: 1.35,
    samples: 16,
    wobble: 0.055,
  };

  it('is deterministic for identical options', () => {
    const a = flumeSpiralPoints(options);
    const b = flumeSpiralPoints(options);
    expect(a).toEqual(b);
    expect(a).toHaveLength(16);
  });

  it('descends monotonically and stays clear of the tower axis', () => {
    const points = flumeSpiralPoints(options);
    expect(points[0]!.y).toBeCloseTo(6.25, 5);
    expect(points[points.length - 1]!.y).toBeCloseTo(1.35, 5);
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.y).toBeLessThan(points[i - 1]!.y);
    }
    const minRadius = Math.min(
      ...points.map((point) => Math.hypot(point.x - options.center.x, point.z - options.center.z)),
    );
    // The tube (r = 0.82) wraps a 0.4 m tower at its top, so the centre line
    // must stay outside 1.22 m or the corkscrew would cut into the column.
    expect(minRadius).toBeGreaterThan(0.4 + 0.82);
  });

  it('grows away from the axis as it falls', () => {
    const points = flumeSpiralPoints(options);
    const first = Math.hypot(points[0]!.x - options.center.x, points[0]!.z - options.center.z);
    const last = Math.hypot(
      points[points.length - 1]!.x - options.center.x,
      points[points.length - 1]!.z - options.center.z,
    );
    expect(last).toBeGreaterThan(first + 0.4);
  });
});

describe('ring float pose', () => {
  it('floats so the waterline cuts the tube and never leaves the surface', () => {
    const tube = 0.18;
    const halfHeight = tube * 0.58;
    for (let time = 0; time < 30; time += 0.37) {
      const pose = ringFloatPose(time, 1.7, tube, 0.58);
      expect(pose.y).toBeGreaterThan(halfHeight * 0.4);
      expect(pose.y).toBeLessThan(halfHeight * 0.7);
      // Water cuts the tube: part below the surface, part above.
      expect(pose.y - halfHeight).toBeLessThan(0);
      expect(pose.y + halfHeight).toBeGreaterThan(0);
      expect(Math.abs(pose.tilt)).toBeLessThan(0.02);
    }
  });

  it('is deterministic and bounded in motion', () => {
    const a = ringFloatPose(12.25, 0.4, 0.16, 0.58);
    const b = ringFloatPose(12.25, 0.4, 0.16, 0.58);
    expect(a).toEqual(b);
    let min = Infinity;
    let max = -Infinity;
    for (let time = 0; time < 12; time += 0.1) {
      const pose = ringFloatPose(time, 0.4, 0.16, 0.58);
      min = Math.min(min, pose.y);
      max = Math.max(max, pose.y);
    }
    expect(max - min).toBeLessThan(0.03);
  });
});

describe('railing layout', () => {
  it('cuts a bay at every ladder and keeps the rest of the rail', () => {
    const spans = railingSpans(-27.6, 27.6, LAYOUT.ladders.z, 0.68);
    expect(spans.length).toBe(LAYOUT.ladders.z.length + 1);
    for (const span of spans) {
      expect(span.to).toBeGreaterThan(span.from);
      for (const ladderZ of LAYOUT.ladders.z) {
        const overlaps = span.from < ladderZ + 0.68 && span.to > ladderZ - 0.68;
        expect(overlaps).toBe(false);
      }
    }
    // Coverage: no unexplained gaps; the ends are anchored at the requested bounds.
    expect(spans[0]!.from).toBeCloseTo(-27.6, 5);
    expect(spans[spans.length - 1]!.to).toBeCloseTo(27.6, 5);
    for (let i = 1; i < spans.length; i++) {
      const gap = spans[i]!.from - spans[i - 1]!.to;
      expect(gap).toBeCloseTo(1.36, 5);
    }
  });

  it('spaces posts inside a span, always including both ends', () => {
    const span = { from: -3.4, to: 4.2 };
    const posts = postPositions(span, 2.6);
    expect(posts[0]).toBeCloseTo(span.from, 5);
    expect(posts[posts.length - 1]).toBeCloseTo(span.to, 5);
    for (let i = 1; i < posts.length; i++) {
      expect(posts[i]! - posts[i - 1]!).toBeLessThanOrEqual(2.6 + 1e-6);
    }
  });
});

describe('layout anchors', () => {
  it('exposes the flume mouth for water/foam consumers', () => {
    const slide = LAYOUT.slide;
    expect(slide.end.y).toBeLessThan(slide.tubeRadius);
    expect(slide.mouthDirection.length()).toBeCloseTo(1, 5);
    expect(slide.mouthRadius).toBeGreaterThan(slide.tubeRadius - 0.1);
    // The mouth must be reachable from the tower without leaving the hall.
    expect(Math.abs(slide.end.x)).toBeLessThan(LAYOUT.hall.halfWidth);
    expect(Math.abs(slide.end.z)).toBeLessThan(LAYOUT.hall.zMax);
  });
});

describe('wrapAngle', () => {
  it('wraps into (-PI, PI]', () => {
    expect(wrapAngle(0)).toBeCloseTo(0, 6);
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI, 6);
    expect(wrapAngle(Math.PI * 1.25)).toBeCloseTo(-Math.PI * 0.75, 6);
    expect(wrapAngle(-Math.PI * 2.5)).toBeCloseTo(-Math.PI * 0.5, 6);
  });
});
