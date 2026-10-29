import { Vector3 } from 'three';
import { clamp } from '../core/math';

/**
 * Pure, deterministic prop layout math.
 *
 * `props.ts` owns the meshes; this module owns the numbers so the flume curve,
 * ring float pose and railing cadence can be tested without a WebGL context and
 * reused by other systems (water wakes, capture framing) without building
 * geometry first.
 */

export interface FlumeSpiralOptions {
  /** Helix axis in world XZ. Y is ignored. */
  center: Vector3;
  /** Start angle in radians, measured in the XZ plane. */
  startAngle: number;
  /** Total rotations; negative values wind clockwise seen from above. */
  turns: number;
  startRadius: number;
  endRadius: number;
  topY: number;
  bottomY: number;
  /** Number of sampled control points, including both ends. */
  samples: number;
  /** Radial wobble amplitude in metres, to keep the corkscrew hand-made. */
  wobble?: number;
}

/**
 * Sample a descending corkscrew. Radius and height are eased so the pitch is
 * tight over the platform and opens up near the water, which is how a real
 * rotomoulded flume reads from below.
 *
 * The result is deterministic: same options -> bit-identical points.
 */
export function flumeSpiralPoints(options: FlumeSpiralOptions): Vector3[] {
  const samples = Math.max(2, Math.floor(options.samples));
  const wobble = options.wobble ?? 0;
  const points: Vector3[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    // Ease the radius growth and the descent independently so the top of the
    // helix is tight and the bottom sweeps wide over the pool.
    const radiusEase = t * t * (3 - 2 * t);
    const radius = options.startRadius + (options.endRadius - options.startRadius) * radiusEase;
    const heightEase = t * t * (3 - 2 * t) * 0.35 + t * 0.65;
    const y = options.topY + (options.bottomY - options.topY) * heightEase;
    const angle = options.startAngle + options.turns * Math.PI * 2 * t;
    const wobbleOffset = wobble * Math.sin(angle * 2.3 + 0.7) * (0.25 + 0.75 * t);
    points.push(
      new Vector3(
        options.center.x + Math.cos(angle) * (radius + wobbleOffset),
        y,
        options.center.z + Math.sin(angle) * (radius + wobbleOffset),
      ),
    );
  }
  return points;
}

export interface RingFloatPose {
  /** Centre height of the flattened torus above the water plane (metres). */
  y: number;
  /** Yaw in radians. */
  yaw: number;
  /** Roll in radians, deliberately tiny. */
  tilt: number;
}

/**
 * Where an inflatable ring sits for a given scene time. The ring is an
 * oblate torus: `tube * flatten` is its vertical half-height, and it floats so
 * the waterline cuts roughly 40 % of that thickness, never sinking or hopping.
 */
export function ringFloatPose(time: number, phase: number, tube: number, flatten = 0.58): RingFloatPose {
  const halfHeight = tube * flatten;
  const bob = Math.sin(time * 0.62 + phase) * 0.011;
  const y = halfHeight * 0.55 + bob;
  const yaw = phase * 0.37 + Math.sin(time * 0.09 + phase) * 0.12;
  const tilt = Math.sin(time * 0.5 + phase) * 0.012;
  return { y: clamp(y, halfHeight * 0.4, halfHeight * 0.7), yaw, tilt };
}

export interface RailSpan {
  from: number;
  to: number;
}

/**
 * Split a continuous guard rail into spans, cutting a bay around each ladder so
 * the ladder handrails become the rail there instead of intersecting it. Both
 * ends of every span are real rail ends; no span is shorter than `minSpan`.
 */
export function railingSpans(
  zMin: number,
  zMax: number,
  ladderZs: readonly number[],
  bayHalfWidth = 0.66,
  minSpan = 0.5,
): RailSpan[] {
  const cuts: Array<[number, number]> = [];
  for (const z of ladderZs) {
    const from = clamp(z - bayHalfWidth, zMin, zMax);
    const to = clamp(z + bayHalfWidth, zMin, zMax);
    if (to > from) cuts.push([from, to]);
  }
  cuts.sort((a, b) => a[0] - b[0]);
  const spans: RailSpan[] = [];
  let cursor = zMin;
  for (const [from, to] of cuts) {
    if (from - cursor >= 0.05) spans.push({ from: cursor, to: from });
    cursor = Math.max(cursor, to);
  }
  if (zMax - cursor >= 0.05) spans.push({ from: cursor, to: zMax });
  return spans.filter((span) => span.to - span.from >= Math.min(minSpan, zMax - zMin));
}

/** Evenly spaced post positions inside a span, always including both ends. */
export function postPositions(span: RailSpan, spacing: number): number[] {
  const length = span.to - span.from;
  if (length <= 1e-3) return [span.from];
  const count = Math.max(1, Math.round(length / spacing));
  const positions: number[] = [];
  for (let i = 0; i <= count; i++) positions.push(span.from + (length * i) / count);
  return positions;
}

/** Wrap an angle into (-PI, PI]. Used to keep wobble/roll continuous. */
export function wrapAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  let value = angle % twoPi;
  if (value > Math.PI) value -= twoPi;
  if (value <= -Math.PI) value += twoPi;
  return value;
}
