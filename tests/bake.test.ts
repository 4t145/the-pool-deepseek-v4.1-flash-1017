import { describe, expect, it } from 'vitest';
import { SphericalHarmonics3, Vector3 } from 'three';
import {
  accumulateShSample,
  contactOcclusion,
  createProbeGrid,
  gridCoordinate,
  gridDimensionsForQuality,
  hammersley,
  nearestProbeIndex,
  probeCount,
  probePosition,
  probeRotation,
  radicalInverse,
  samplesPerProbeForQuality,
  shBasis,
  shIrradiance,
  trilinearSample,
  uniformSphereDirection,
  wrap01,
} from '../src/core/bakeMath';

describe('probe grid addressing', () => {
  it('orders probes x-fastest, then y, then z, and spans min..max exactly', () => {
    const grid = createProbeGrid([3, 2, 2], [-1, 0, -2], [1, 1, 2]);
    expect(probeCount(grid)).toBe(12);
    expect(probePosition(grid, 0, 0, 0)).toEqual([-1, 0, -2]);
    expect(probePosition(grid, 2, 1, 1)).toEqual([1, 1, 2]);
    expect(probePosition(grid, 1, 0, 0)[0]).toBeCloseTo(0);
    expect(gridCoordinate(grid, [0, 0.5, 0])[0]).toBeCloseTo(0.5);
  });

  it('finds the nearest probe by index for a sample between probes', () => {
    const grid = createProbeGrid([2, 2, 2], [0, 0, 0], [1, 1, 1]);
    expect(nearestProbeIndex(grid, [0.1, 0.1, 0.1])).toBe(0);
    expect(nearestProbeIndex(grid, [0.9, 0.9, 0.9])).toBe(7);
    // index order is x + y*2 + z*4
    expect(nearestProbeIndex(grid, [0.9, 0.1, 0.9])).toBe(1 + 0 + 4);
    // outside the box clamps instead of wrapping or throwing
    expect(nearestProbeIndex(grid, [-5, 9, 0.4])).toBe(0 + 2 + 0);
  });

  it('rejects degenerate grids', () => {
    expect(() => createProbeGrid([1, 2, 2])).toThrow();
    expect(() => createProbeGrid([2, 2, 2], [0, 0, 0], [0, 1, 1])).toThrow();
  });

  it('scales probe and sample counts with the quality preset', () => {
    const low = gridDimensionsForQuality(0);
    const ultra = gridDimensionsForQuality(1);
    for (let axis = 0; axis < 3; axis++) expect(ultra[axis]!).toBeGreaterThan(low[axis]!);
    expect(samplesPerProbeForQuality(1)).toBeGreaterThan(samplesPerProbeForQuality(0));
    // deterministic, and clamps out-of-range quality instead of exploding
    expect(gridDimensionsForQuality(1.5)).toEqual(ultra);
    expect(gridDimensionsForQuality(-1)).toEqual(low);
  });
});

describe('trilinear probe sampling', () => {
  const grid = createProbeGrid([2, 2, 2], [0, 0, 0], [1, 1, 1]);

  it('reproduces probe values exactly at grid nodes', () => {
    const data = new Float32Array(8 * 3);
    for (let i = 0; i < 8; i++) data.set([i, i * 2, i * 3], i * 3);
    for (let iz = 0; iz < 2; iz++) {
      for (let iy = 0; iy < 2; iy++) {
        for (let ix = 0; ix < 2; ix++) {
          // Probe 0 is at [0,0,0]; probe 7 at [1,1,1]. Index order matches nearestProbeIndex.
          const position: [number, number, number] = [ix, iy, iz];
          const out = trilinearSample(grid, data, position, 3, [0, 0, 0]);
          const index = (iz * 2 + iy) * 2 + ix;
          expect(out[0]).toBeCloseTo(index);
          expect(out[1]).toBeCloseTo(index * 2);
          expect(out[2]).toBeCloseTo(index * 3);
        }
      }
    }
  });

  it('interpolates the box centre as the mean of the eight corners', () => {
    const data = new Float32Array(8 * 3);
    for (let i = 0; i < 8; i++) data.set([i, i, i], i * 3);
    const out = trilinearSample(grid, data, [0.5, 0.5, 0.5], 3, [0, 0, 0]);
    expect(out[0]).toBeCloseTo(3.5);
  });

  it('clamps outside the grid to the edge probes', () => {
    const data = new Float32Array(8 * 3).fill(1);
    data.set([9, 9, 9], 7 * 3);
    expect(trilinearSample(grid, data, [2, 2, 2], 3, [0, 0, 0])[0]).toBeCloseTo(9);
    expect(trilinearSample(grid, data, [-2, -2, -2], 3, [0, 0, 0])[0]).toBeCloseTo(1);
  });

  it('supports grids with more than three interleaved channels', () => {
    const channels = 27;
    const data = new Float32Array(8 * channels);
    for (let i = 0; i < 8; i++) for (let c = 0; c < channels; c++) data[i * channels + c] = i * 10 + c;
    const out = new Array<number>(channels).fill(0);
    trilinearSample(grid, data, [1, 1, 1], channels, out);
    expect(out[0]).toBeCloseTo(70);
    expect(out[26]).toBeCloseTo(96);
  });
});

describe('sample sequences', () => {
  it('produces unit-length, area-uniform sphere directions with negligible bias', () => {
    const count = 2048;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let i = 0; i < count; i++) {
      const [u1, u2] = hammersley(i, count);
      const [x, y, z] = uniformSphereDirection(u1, u2);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
      sx += x;
      sy += y;
      sz += z;
    }
    expect(Math.abs(sx / count)).toBeLessThan(0.01);
    expect(Math.abs(sy / count)).toBeLessThan(0.02);
    expect(Math.abs(sz / count)).toBeLessThan(0.02);
  });

  it('has a deterministic, well-distributed per-probe rotation', () => {
    expect(probeRotation(17, 1234)).toEqual(probeRotation(17, 1234));
    expect(probeRotation(17, 1234)).not.toEqual(probeRotation(18, 1234));
    const [a, b] = probeRotation(3, 9);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(1);
    expect(wrap01(0.75, 0.5)).toBeCloseTo(0.25);
    expect(wrap01(0.1, 0.95)).toBeCloseTo(0.05);
  });

  it('has well-defined Hammersley endpoints', () => {
    expect(radicalInverse(0)).toBe(0);
    expect(radicalInverse(1)).toBeCloseTo(0.5);
    expect(radicalInverse(2)).toBeCloseTo(0.25);
    expect(hammersley(0, 4)).toEqual([0, 0]);
    expect(() => hammersley(0, 0)).toThrow();
  });
});

describe('spherical harmonics match three.js SphericalHarmonics3', () => {
  it('evaluates the same basis values', () => {
    const normals: Array<[number, number, number]> = [
      [0, 1, 0],
      [0.3, -0.4, 0.866],
      [-0.577, 0.577, 0.577],
      [1, 0, 0],
    ];
    const target = new Array<number>(9).fill(0);
    for (const normal of normals) {
      const v = new Vector3(...normal);
      const expected = new Array<number>(9).fill(0);
      SphericalHarmonics3.getBasisAt(v, expected);
      shBasis(normal, target);
      for (let i = 0; i < 9; i++) expect(target[i]).toBeCloseTo(expected[i]!, 10);
    }
  });

  it('evaluates the same cosine-convolved irradiance', () => {
    // Build an SH from a bright sky patch and compare CPU irradiance to three.
    const sh = new SphericalHarmonics3();
    const basis = new Array<number>(9).fill(0);
    const radiance = new Vector3(1.4, 1.6, 1.9);
    const count = 512;
    for (let i = 0; i < count; i++) {
      const [u1, u2] = hammersley(i, count);
      const direction = uniformSphereDirection(u1, u2);
      // only the upper hemisphere emits, like a skylight
      if (direction[1] <= 0) continue;
      SphericalHarmonics3.getBasisAt(new Vector3(...direction), basis);
      for (let c = 0; c < 9; c++) {
        sh.coefficients[c]!.x += (radiance.x * basis[c]!) / count;
        sh.coefficients[c]!.y += (radiance.y * basis[c]!) / count;
        sh.coefficients[c]!.z += (radiance.z * basis[c]!) / count;
      }
    }
    sh.scale(4 * Math.PI);

    const coefficients = new Float32Array(27);
    for (let c = 0; c < 9; c++) {
      coefficients[c * 3] = sh.coefficients[c]!.x;
      coefficients[c * 3 + 1] = sh.coefficients[c]!.y;
      coefficients[c * 3 + 2] = sh.coefficients[c]!.z;
    }

    const normals: Array<[number, number, number]> = [
      [0, 1, 0],
      [0, -1, 0],
      [0.5, 0.5, 0.707],
      [0.9, 0.1, 0.4],
    ];
    const expected = new Vector3();
    const out: [number, number, number] = [0, 0, 0];
    for (const normal of normals) {
      const n = new Vector3(...normal).normalize();
      sh.getIrradianceAt(n, expected);
      shIrradiance(coefficients, 0, [n.x, n.y, n.z], out);
      // coefficients are float32 in the bake path, so compare with an absolute tolerance
      expect(Math.abs(out[0] - Math.max(0, expected.x))).toBeLessThan(1e-3);
      expect(Math.abs(out[1] - Math.max(0, expected.y))).toBeLessThan(1e-3);
      expect(Math.abs(out[2] - Math.max(0, expected.z))).toBeLessThan(1e-3);
    }
  });

  it('accumulates samples with the same scale convention as the SH projection', () => {
    const coefficients = new Float32Array(27);
    const basis = new Array<number>(9).fill(0);
    const direction: [number, number, number] = [0, 1, 0];
    shBasis(direction, basis);
    accumulateShSample(coefficients, 0, [2, 4, 6], basis, 1);
    // coeff 0 for the +Y direction is (2,4,6) * 0.282095, stored interleaved.
    expect(coefficients[0]).toBeCloseTo(2 * 0.282095);
    expect(coefficients[1]).toBeCloseTo(4 * 0.282095);
    expect(coefficients[2]).toBeCloseTo(6 * 0.282095);
    // coefficient 1 (band 1, y term) is 0.488603 for +Y
    expect(coefficients[3]).toBeCloseTo(2 * 0.488603);
    expect(coefficients[1 * 3 + 2]).toBeCloseTo(6 * 0.488603);
  });
});

describe('contact occlusion', () => {
  it('fades monotonically to zero at the radius and clamps beyond it', () => {
    expect(contactOcclusion(0, 1)).toBeCloseTo(1);
    expect(contactOcclusion(0.5, 1)).toBeCloseTo(0.5);
    expect(contactOcclusion(1, 1)).toBeCloseTo(0);
    expect(contactOcclusion(4, 1)).toBe(0);
    expect(() => contactOcclusion(0.1, 0)).toThrow();
  });
});
