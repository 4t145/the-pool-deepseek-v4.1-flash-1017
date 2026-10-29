/**
 * Water optics math.
 *
 * The GPU water shader and these functions implement the same model:
 *   - Snell refraction at the air/water interface (n_air / n_water);
 *   - Beer–Lambert transmittance over the underwater path;
 *   - Schlick Fresnel reflectance;
 *   - analytic basin exit for the refraction sample and path length;
 *   - deterministic ring/flume wakes and caustic focus patterns.
 *
 * Keeping the reference implementation here means the tuning constants and the
 * edge-case behaviour (total internal reflection, rays that never leave the
 * basin, negative distances) are unit-testable without a GPU. The shader is
 * compiled from the same numbers; if a constant changes it must change in both
 * places (the GLSL mirrors are marked with `WATER_*` comments).
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });

export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

export const normalize = (a: Vec3): Vec3 => {
  const len = length(a);
  return len > 1e-9 ? scale(a, 1 / len) : { x: 0, y: 1, z: 0 };
};

/** Index of refraction: air -> water. WATER_ETA. */
export const WATER_ETA = 1.0 / 1.333;

/**
 * Snell refraction. `incident` is the direction of propagation (from the eye
 * into the surface), `normal` points out of the water toward the air.
 * Returns null under total internal reflection (only possible going water -> air
 * with eta > 1; the water shader uses eta < 1 and never hits it, but the API
 * must be honest).
 */
export function refract(incident: Vec3, normal: Vec3, eta: number): Vec3 | null {
  const cosi = -dot(normal, incident);
  const k = 1 - eta * eta * (1 - cosi * cosi);
  if (k < 0) return null;
  const factor = eta * cosi - Math.sqrt(k);
  return normalize(add(scale(incident, eta), scale(normal, factor)));
}

/** Schlick reflectance. WATER_F0 = 0.02 for a flat air/water interface. */
export function schlickReflectance(cosTheta: number, f0 = 0.02): number {
  const c = Math.min(1, Math.max(0, cosTheta));
  const inv = 1 - c;
  return f0 + (1 - f0) * inv * inv * inv * inv * inv;
}

/**
 * Beer–Lambert transmittance per channel. `absorption` is the extinction
 * coefficient in inverse metres; red is absorbed first, which is what makes the
 * deep end read green-black while the shallow end keeps some warmth.
 */
export function beerLambertTransmittance(distance: number, absorption: Vec3): Vec3 {
  const d = Math.max(0, distance);
  return {
    x: Math.exp(-absorption.x * d),
    y: Math.exp(-absorption.y * d),
    z: Math.exp(-absorption.z * d),
  };
}

/**
 * Distance from a ray origin inside an axis-aligned box to the exit face.
 * The water shader uses this from the point just under the surface; the basin
 * box (walls + floor) is the main underwater occluder, so the path length is
 * also the absorption distance. Returns null if the direction does not leave
 * the box (degenerate) or immediately points outside.
 */
export function intersectBoxExit(origin: Vec3, direction: Vec3, bounds: Bounds): { distance: number; point: Vec3 } | null {
  let distance = Number.POSITIVE_INFINITY;
  const axes: Array<['x' | 'y' | 'z', number]> = [
    ['x', direction.x],
    ['y', direction.y],
    ['z', direction.z],
  ];
  const originComponents = origin as unknown as Record<'x' | 'y' | 'z', number>;
  const minComponents = bounds.min as unknown as Record<'x' | 'y' | 'z', number>;
  const maxComponents = bounds.max as unknown as Record<'x' | 'y' | 'z', number>;
  for (const [axis, component] of axes) {
    if (Math.abs(component) < 1e-9) continue;
    const target = component > 0 ? maxComponents[axis] : minComponents[axis];
    const t = (target - originComponents[axis]) / component;
    if (t > 0 && t < distance) distance = t;
  }
  if (!Number.isFinite(distance)) return null;
  return { distance, point: add(origin, scale(direction, distance)) };
}

/** Perspective depth buffer value -> positive view-space distance. */
export function linearizeDepth(depth: number, near: number, far: number): number {
  const d = Math.min(1, Math.max(0, depth));
  // (2 near far) / (far + near - (2 d - 1) (far - near))
  return (2 * near * far) / (far + near - (2 * d - 1) * (far - near));
}

export interface WakeConfig {
  /** Peak radial displacement in metres. WATER_WAKE_AMPLITUDE. */
  amplitude: number;
  /** Radians per metre along the radius. WATER_WAKE_FREQUENCY. */
  frequency: number;
  /** Radians per second. WATER_WAKE_SPEED. */
  speed: number;
  /** Exponential spatial decay per metre. WATER_WAKE_DECAY. */
  decay: number;
}

/** Mirrors the wake constants in the water fragment shader. */
export const RING_WAKE: WakeConfig = { amplitude: 0.0065, frequency: 7.5, speed: 1.7, decay: 0.85 };
export const MOUTH_WAKE: WakeConfig = { amplitude: 0.015, frequency: 4.8, speed: 2.3, decay: 0.6 };

/**
 * Analytic radial wake from a floating object or the flume mouth. The height is
 * zero at the object rim (distance 0) and decays outward; the slope is the exact
 * derivative of the same profile, so the shader never has to finite-difference
 * a texture, which keeps ripples temporally stable.
 */
export function wakeHeight(distance: number, time: number, phase: number, config: WakeConfig = RING_WAKE): number {
  const d = Math.max(0, distance);
  const angle = d * config.frequency - time * config.speed + phase;
  return config.amplitude * Math.exp(-d * config.decay) * Math.sin(angle);
}

export function wakeSlope(distance: number, time: number, phase: number, config: WakeConfig = RING_WAKE): number {
  const d = Math.max(0, distance);
  const angle = d * config.frequency - time * config.speed + phase;
  const envelope = config.amplitude * Math.exp(-d * config.decay);
  return envelope * (config.frequency * Math.cos(angle) - config.decay * Math.sin(angle));
}

/**
 * Caustic focus pattern on a submerged surface. Two crossing wave trains make a
 * web of bright lines where they cancel; the exponent sharpens the lines more
 * near the surface (less dispersion) and softens them at the basin floor.
 * Mirrors `causticLattice` in the water/underwater shader, including constants.
 */
export function causticLattice(x: number, z: number, time: number, depth: number): number {
  // WATER_CAUSTIC_SCALE
  const base = 26.0;
  const d1x = 0.8202;
  const d1z = 0.5721;
  const d2x = -0.4550;
  const d2z = 0.8905;
  const d3x = 0.3417;
  const d3z = -0.9398;
  const a = Math.sin((x * d1x + z * d1z) * base + time * 0.9);
  const b = Math.sin((x * d2x + z * d2z) * (base * 0.83) - time * 1.15 + 1.7);
  const c = Math.sin((x * d3x + z * d3z) * (base * 1.37) + time * 0.7 + 3.1);
  const web = Math.min(Math.abs(a + b), Math.abs(a + c));
  const depthFactor = Math.min(1, Math.max(0, depth / 3.2));
  const sharp = 10.0 + (5.0 - 10.0) * depthFactor;
  return Math.pow(Math.min(1, Math.max(0, 1 - web * 0.85)), sharp);
}

/** Cone-of-influence test for the water simulation: is a point inside the basin footprint? */
export function isInsideBasin(x: number, z: number, halfWidth: number, halfLength: number): boolean {
  return Math.abs(x) <= halfWidth && Math.abs(z) <= halfLength;
}
