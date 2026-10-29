import { describe, expect, it } from 'vitest';
import {
  beerLambertTransmittance,
  causticLattice,
  dot,
  intersectBoxExit,
  length,
  linearizeDepth,
  MOUTH_WAKE,
  normalize,
  refract,
  RING_WAKE,
  schlickReflectance,
  wakeHeight,
  wakeSlope,
  WATER_ETA,
  type Bounds,
  vec3,
} from '../src/core/waterOptics';

const BASIN: Bounds = { min: vec3(-7.2, -3.2, -27.5), max: vec3(7.2, 0, 27.5) };

describe('water optics', () => {
  it('refracts along Snell law and is reversible at normal incidence', () => {
    const straightDown = refract(vec3(0, -1, 0), vec3(0, 1, 0), WATER_ETA);
    expect(straightDown).not.toBeNull();
    expect(length(normalize(straightDown!))).toBeCloseTo(1, 6);
    expect(straightDown!.y).toBeCloseTo(-1, 6);
    expect(straightDown!.x).toBeCloseTo(0, 6);

    // 53.13 deg incidence: sin(theta_i) = 0.8, so sin(theta_t) = 0.8 / 1.333.
    const incident = normalize(vec3(0.8, -0.6, 0));
    const refracted = refract(incident, vec3(0, 1, 0), WATER_ETA)!;
    const sinTransmitted = Math.hypot(refracted.x, refracted.z);
    expect(sinTransmitted).toBeCloseTo(0.8 / 1.333, 5);
    // Refraction bends toward the normal.
    expect(refracted.y).toBeLessThan(incident.y);
  });

  it('reports total internal reflection going water -> air', () => {
    // 60 deg from the normal inside the water is past the 48.6 deg critical angle.
    const steep = normalize(vec3(0.92, 0.39, 0));
    expect(refract(steep, vec3(0, 1, 0), 1.333)).toBeNull();
    // A gentle angle still transmits.
    expect(refract(normalize(vec3(0.3, 0.95, 0)), vec3(0, 1, 0), 1.333)).not.toBeNull();
  });

  it('fresnel rises from the water f0 to unity at grazing', () => {
    expect(schlickReflectance(1)).toBeCloseTo(0.02, 6);
    expect(schlickReflectance(0)).toBeCloseTo(1, 6);
    let previous = -1;
    for (let i = 0; i <= 20; i++) {
      // Grazing angle as cos(theta) falls from 1 to 0.
      const value = schlickReflectance(1 - i / 20);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('absorbs red faster than green and blue over the basin depth', () => {
    const surface = beerLambertTransmittance(0, vec3(0.75, 0.34, 0.3));
    expect(surface.x).toBeCloseTo(1, 9);
    const floor = beerLambertTransmittance(3.2, vec3(0.75, 0.34, 0.3));
    expect(floor.x).toBeLessThan(floor.y);
    expect(floor.y).toBeLessThan(1);
    expect(floor.x).toBeGreaterThan(0);
    const deep = beerLambertTransmittance(6, vec3(0.75, 0.34, 0.3));
    expect(deep.x).toBeLessThan(floor.x);
    expect(deep.y).toBeLessThan(floor.y);
  });

  it('finds the basin exit and the underwater path length', () => {
    const down = intersectBoxExit(vec3(0, -0.02, 0), vec3(0, -1, 0), BASIN)!;
    expect(down.distance).toBeCloseTo(3.18, 6);
    expect(down.point.y).toBeCloseTo(-3.2, 6);

    const sideways = intersectBoxExit(vec3(0, -1, 0), vec3(1, 0, 0), BASIN)!;
    expect(sideways.distance).toBeCloseTo(7.2, 6);
    expect(sideways.point.x).toBeCloseTo(7.2, 6);

    const upward = intersectBoxExit(vec3(0, -1, 0), vec3(0, 1, 0), BASIN)!;
    expect(upward.distance).toBeCloseTo(1, 6);

    // A ray already outside the box and pointing away never exits it.
    expect(intersectBoxExit(vec3(0, 1, 0), vec3(0, 1, 0), BASIN)).toBeNull();
    // A direction of exactly zero length is degenerate.
    expect(intersectBoxExit(vec3(0, -1, 0), vec3(0, 0, 0), BASIN)).toBeNull();
  });

  it('linearizes the depth buffer between near and far', () => {
    expect(linearizeDepth(0, 0.05, 140)).toBeCloseTo(0.05, 6);
    expect(linearizeDepth(1, 0.05, 140)).toBeCloseTo(140, 6);
    expect(linearizeDepth(0.5, 0.05, 140)).toBeLessThan(140);
    expect(linearizeDepth(0.5, 0.05, 140)).toBeGreaterThan(0.05);
  });
});

describe('deterministic surface detail', () => {
  it('wakes decay away from the source and are bounded by the amplitude', () => {
    for (let i = 0; i < 40; i++) {
      const distance = i * 0.5;
      const height = wakeHeight(distance, 2.4, 1.7);
      const envelope = RING_WAKE.amplitude * Math.exp(-distance * RING_WAKE.decay);
      expect(Math.abs(height)).toBeLessThanOrEqual(envelope + 1e-12);
    }
    expect(Math.abs(wakeHeight(40, 2.4, 1.7))).toBeLessThan(1e-6);
  });

  it('wake slope is the exact derivative of the wake height', () => {
    const step = 1e-5;
    for (const distance of [0.05, 0.5, 1.7, 4.2]) {
      for (const config of [RING_WAKE, MOUTH_WAKE]) {
        const numeric = (wakeHeight(distance + step, 3.1, 0.4, config) - wakeHeight(distance - step, 3.1, 0.4, config)) / (2 * step);
        expect(wakeSlope(distance, 3.1, 0.4, config)).toBeCloseTo(numeric, 4);
      }
    }
  });

  it('caustic focus is deterministic, bounded and sparse', () => {
    let sum = 0;
    let samples = 0;
    let min = 1;
    let max = 0;
    for (let x = -6; x <= 6; x += 0.37) {
      for (let z = -6; z <= 6; z += 0.41) {
        const value = causticLattice(x, z, 4.2, 3.2);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
        expect(value).toBe(causticLattice(x, z, 4.2, 3.2));
        sum += value;
        samples += 1;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
    const mean = sum / samples;
    // Caustics are bright lines, not a wash: most of the floor stays dark.
    expect(mean).toBeLessThan(0.35);
    expect(max).toBeGreaterThan(0.6);
    expect(min).toBeLessThan(0.05);
    // It animates with the scene clock.
    expect(causticLattice(1.3, -2.1, 4.2, 2)).not.toBeCloseTo(causticLattice(1.3, -2.1, 5.2, 2), 6);
  });

  it('matches the shader normal convention after refraction', () => {
    const incident = normalize(vec3(-0.4, -0.9, 0.2));
    const normal = normalize(vec3(0.05, 1, -0.03));
    const refracted = refract(incident, normal, WATER_ETA)!;
    // The transmitted ray stays on the same side of the surface plane.
    expect(dot(refracted, normal)).toBeLessThan(0);
    expect(length(refracted)).toBeCloseTo(1, 6);
  });
});
