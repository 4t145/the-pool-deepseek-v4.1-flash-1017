/**
 * Time-keyed, closed camera path math.
 *
 * The guided take has to loop without a cut: the last frame of the take must
 * equal the first frame not only in pose but in motion. Instead of sampling an
 * open spline and snapping back to the start (the baseline behaviour), this
 * module treats the keys as a cycle and evaluates a cubic Hermite segment
 * between every pair, with the tangent at each key derived from the previous
 * and next key across the wrap. The result is a C1 curve over the whole loop.
 *
 * Orientation is interpolated as yaw/pitch rather than as a raw look-at point:
 * interpolating a point can swing the view direction through the camera and
 * produce a whip pan when the point passes close to the eye. Angles also let
 * the wrap take the short way around. Tangents are flattened at local extrema
 * (the monotone-cubic rule) so a key where the camera changes direction cannot
 * overshoot into a wall or produce a lurch.
 *
 * The module deliberately has no three.js dependency: it is the unit-tested
 * mathematical core behind `Cinematics`.
 */

export type Vec3Tuple = readonly [number, number, number];

export interface CameraPathKey {
  time: number;
  position: Vec3Tuple;
  target: Vec3Tuple;
  fov: number;
}

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export interface CameraPath {
  readonly duration: number;
  /** Pose at an arbitrary scene time; time wraps around the loop. */
  sample(time: number): CameraPose;
  /** Analytic position derivative in m/s at an arbitrary scene time. */
  velocity(time: number): [number, number, number];
  /** Key times in seconds (the final key's time is the closing key, < duration). */
  readonly times: readonly number[];
}

export const wrapTime = (time: number, duration: number): number => {
  if (!Number.isFinite(time)) throw new Error('cameraPath: time must be finite');
  const wrapped = time % duration;
  return wrapped < 0 ? wrapped + duration : wrapped;
};

/** Fritsch–Carlson style tangent: average slope, flattened at extrema. */
function keyTangent(previous: number, current: number, next: number, hIn: number, hOut: number): number {
  const sIn = (current - previous) / hIn;
  const sOut = (next - current) / hOut;
  if (sIn * sOut <= 0) return 0;
  return (sIn + sOut) * 0.5;
}

export interface CameraPathOptions {
  /** Reject malformed keys (defaults to true). */
  validate?: boolean;
}

interface AngleKey {
  yaw: number;
  pitch: number;
  distance: number;
}

const TAU = Math.PI * 2;

/** Fold an angle delta into (-π, π] so the loop turns the short way. */
function shortestDelta(delta: number): number {
  let value = delta % TAU;
  if (value > Math.PI) value -= TAU;
  if (value <= -Math.PI) value += TAU;
  return value;
}

class HermiteCycle implements CameraPath {
  readonly duration: number;
  readonly times: readonly number[];
  private readonly positions: Vec3Tuple[];
  private readonly angles: AngleKey[];
  private readonly fovs: number[];
  private readonly positionTangents: Array<[number, number, number]>;
  private readonly yawTangents: number[];
  private readonly pitchTangents: number[];
  private readonly distanceTangents: number[];
  private readonly fovTangents: number[];
  private readonly segmentDurations: number[];

  constructor(keys: readonly CameraPathKey[], duration: number, options: CameraPathOptions = {}) {
    if (keys.length < 3) throw new Error('cameraPath: need at least three keys for a closed loop');
    if (!(duration > 0) || !Number.isFinite(duration)) throw new Error('cameraPath: duration must be positive');
    if (options.validate !== false) {
      if (keys[0]!.time !== 0) throw new Error('cameraPath: first key must be at t=0');
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        if (!Number.isFinite(key.time) || !Number.isFinite(key.fov)) {
          throw new Error(`cameraPath: key ${i} has a non-finite time or fov`);
        }
        if (i > 0 && key.time <= keys[i - 1]!.time) {
          throw new Error(`cameraPath: key times must increase (key ${i})`);
        }
        if (key.time !== 0 && key.time >= duration) {
          throw new Error(`cameraPath: key ${i} must sit inside the loop (t=${key.time} >= ${duration})`);
        }
        for (const value of [...key.position, ...key.target]) {
          if (!Number.isFinite(value)) throw new Error(`cameraPath: key ${i} has a non-finite position`);
        }
        const dx = key.target[0] - key.position[0];
        const dy = key.target[1] - key.position[1];
        const dz = key.target[2] - key.position[2];
        if (Math.hypot(dx, dy, dz) < 1e-6) throw new Error(`cameraPath: key ${i} looks at its own position`);
      }
    }

    this.duration = duration;
    this.times = keys.map((key) => key.time);
    this.positions = keys.map((key) => [key.position[0], key.position[1], key.position[2]] as const);
    this.fovs = keys.map((key) => key.fov);
    this.segmentDurations = keys.map((key, index) =>
      index + 1 < keys.length ? keys[index + 1]!.time - key.time : duration - key.time,
    );

    // Orientation keys in yaw/pitch, with yaw unwrapped across the loop so the
    // camera never spins the long way around. The first key's yaw is the anchor.
    const rawAngles: AngleKey[] = keys.map((key) => {
      const dx = key.target[0] - key.position[0];
      const dy = key.target[1] - key.position[1];
      const dz = key.target[2] - key.position[2];
      const horizontal = Math.hypot(dx, dz);
      return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, horizontal), distance: Math.hypot(dx, dy, dz) };
    });
    const unwrapped: AngleKey[] = rawAngles.map((entry) => ({ ...entry }));
    for (let i = 1; i < unwrapped.length; i++) {
      unwrapped[i]!.yaw = unwrapped[i - 1]!.yaw + shortestDelta(unwrapped[i]!.yaw - unwrapped[i - 1]!.yaw);
    }
    // The closing key is key 0 itself. Express it relative to the last key so
    // the final segment approaches the same angle the first segment leaves.
    const closingYaw = unwrapped[unwrapped.length - 1]!.yaw + shortestDelta(unwrapped[0]!.yaw - unwrapped[unwrapped.length - 1]!.yaw);
    if (Math.abs(closingYaw - unwrapped[0]!.yaw) > 1e-9) {
      // A net half-turn or more across the loop is a deliberate, but unsupported,
      // case: the pose would not line up at the seam.
      throw new Error('cameraPath: loop needs a matching orientation at the seam');
    }
    this.angles = unwrapped;

    const count = keys.length;
    this.positionTangents = [];
    this.yawTangents = [];
    this.pitchTangents = [];
    this.distanceTangents = [];
    this.fovTangents = [];
    for (let i = 0; i < count; i++) {
      const previous = (i - 1 + count) % count;
      const next = (i + 1) % count;
      const inDuration = i === 0 ? this.times[0]! + duration - this.times[previous]! : this.times[i]! - this.times[previous]!;
      const outDuration = i === count - 1 ? duration - this.times[i]! + this.times[next]! : this.times[next]! - this.times[i]!;
      const p = this.positions[i]!;
      const previousPosition = this.positions[previous]!;
      const nextPosition = this.positions[next]!;
      this.positionTangents.push([
        keyTangent(previousPosition[0], p[0], nextPosition[0], inDuration, outDuration),
        keyTangent(previousPosition[1], p[1], nextPosition[1], inDuration, outDuration),
        keyTangent(previousPosition[2], p[2], nextPosition[2], inDuration, outDuration),
      ]);
      this.yawTangents.push(
        keyTangent(this.angles[previous]!.yaw, this.angles[i]!.yaw, this.angles[next]!.yaw, inDuration, outDuration),
      );
      this.pitchTangents.push(
        keyTangent(this.angles[previous]!.pitch, this.angles[i]!.pitch, this.angles[next]!.pitch, inDuration, outDuration),
      );
      this.distanceTangents.push(
        keyTangent(this.angles[previous]!.distance, this.angles[i]!.distance, this.angles[next]!.distance, inDuration, outDuration),
      );
      this.fovTangents.push(
        keyTangent(this.fovs[previous]!, this.fovs[i]!, this.fovs[next]!, inDuration, outDuration),
      );
    }
  }

  private segmentIndex(time: number): number {
    const times = this.times;
    let low = 0;
    let high = times.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (times[mid]! <= time) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  private segmentAt(time: number): { index: number; local: number; duration: number } {
    const wrapped = wrapTime(time, this.duration);
    const index = this.segmentIndex(wrapped);
    return {
      index,
      local: (wrapped - this.times[index]!) / this.segmentDurations[index]!,
      duration: this.segmentDurations[index]!,
    };
  }

  private static hermite(a: number, b: number, tangentA: number, tangentB: number, local: number, duration: number): number {
    const l2 = local * local;
    const l3 = l2 * local;
    const h00 = 2 * l3 - 3 * l2 + 1;
    const h10 = l3 - 2 * l2 + local;
    const h01 = -2 * l3 + 3 * l2;
    const h11 = l3 - l2;
    return h00 * a + h10 * duration * tangentA + h01 * b + h11 * duration * tangentB;
  }

  sample(time: number): CameraPose {
    const { index, local, duration } = this.segmentAt(time);
    const next = (index + 1) % this.positions.length;
    const p = this.positions[index]!;
    const pNext = this.positions[next]!;
    const mP = this.positionTangents[index]!;
    const mPNext = this.positionTangents[next]!;
    const position: [number, number, number] = [
      HermiteCycle.hermite(p[0], pNext[0], mP[0], mPNext[0], local, duration),
      HermiteCycle.hermite(p[1], pNext[1], mP[1], mPNext[1], local, duration),
      HermiteCycle.hermite(p[2], pNext[2], mP[2], mPNext[2], local, duration),
    ];
    const yaw = HermiteCycle.hermite(
      this.angles[index]!.yaw,
      this.angles[next]!.yaw,
      this.yawTangents[index]!,
      this.yawTangents[next]!,
      local,
      duration,
    );
    const pitch = HermiteCycle.hermite(
      this.angles[index]!.pitch,
      this.angles[next]!.pitch,
      this.pitchTangents[index]!,
      this.pitchTangents[next]!,
      local,
      duration,
    );
    const distance = HermiteCycle.hermite(
      this.angles[index]!.distance,
      this.angles[next]!.distance,
      this.distanceTangents[index]!,
      this.distanceTangents[next]!,
      local,
      duration,
    );
    const cosPitch = Math.cos(pitch);
    const target: [number, number, number] = [
      position[0] + Math.sin(yaw) * cosPitch * distance,
      position[1] + Math.sin(pitch) * distance,
      position[2] + Math.cos(yaw) * cosPitch * distance,
    ];
    const fov = HermiteCycle.hermite(
      this.fovs[index]!,
      this.fovs[next]!,
      this.fovTangents[index]!,
      this.fovTangents[next]!,
      local,
      duration,
    );
    return { position, target, fov };
  }

  velocity(time: number): [number, number, number] {
    const { index, local, duration } = this.segmentAt(time);
    const next = (index + 1) % this.positions.length;
    const p = this.positions[index]!;
    const pNext = this.positions[next]!;
    const mP = this.positionTangents[index]!;
    const mPNext = this.positionTangents[next]!;
    const derivative = (a: number, b: number, ma: number, mb: number): number => {
      const l2 = local * local;
      const dh00 = 6 * l2 - 6 * local;
      const dh10 = 3 * l2 - 4 * local + 1;
      const dh01 = -6 * l2 + 6 * local;
      const dh11 = 3 * l2 - 2 * local;
      // d/du of the Hermite basis, then /du/dt for m/s.
      return (dh00 * a + dh01 * b + duration * (dh10 * ma + dh11 * mb)) / duration;
    };
    return [derivative(p[0], pNext[0], mP[0], mPNext[0]), derivative(p[1], pNext[1], mP[1], mPNext[1]), derivative(p[2], pNext[2], mP[2], mPNext[2])];
  }
}

/** Build the closed, C1 camera path behind the guided take. */
export function createClosedCameraPath(
  keys: readonly CameraPathKey[],
  duration: number,
  options: CameraPathOptions = {},
): CameraPath {
  return new HermiteCycle(keys, duration, options);
}

interface OrientationPose {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

/** Direction (unit length) from a pose's position toward its target. */
export function viewDirection(pose: OrientationPose): [number, number, number] {
  const dx = pose.target[0] - pose.position[0];
  const dy = pose.target[1] - pose.position[1];
  const dz = pose.target[2] - pose.position[2];
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-9) return [0, 0, 1];
  return [dx / length, dy / length, dz / length];
}

/** Angle between two view directions in radians. */
export function directionAngle(a: [number, number, number], b: [number, number, number]): number {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(dot);
}
