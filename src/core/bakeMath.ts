/**
 * Pure math for the static lighting bake: probe-grid addressing, trilinear
 * sampling, spherical-harmonics evaluation and low-discrepancy directions.
 *
 * Everything here is deterministic, has no three.js/WebGL dependency, and is
 * covered by `tests/bake.test.ts`. The SH basis and irradiance convolution match
 * three.js `SphericalHarmonics3` exactly (the renderer's `sampler3D` probe-grid
 * shader uses the same constants), so a bake computed with these helpers can be
 * uploaded as-is and read back by the GPU.
 */

export type Vec3Tuple = readonly [number, number, number];

export interface ProbeGrid {
  readonly dims: Vec3Tuple;
  readonly min: Vec3Tuple;
  readonly max: Vec3Tuple;
}

/** The hall box that the probe grid covers. Probes below the waterline are useless. */
export const DEFAULT_GRID_MIN: Vec3Tuple = [-8.4, 0.2, -29];
export const DEFAULT_GRID_MAX: Vec3Tuple = [8.4, 8.5, 29];

/**
 * Probe counts scale with the quality preset. The bake is a one-off load cost
 * (no per-frame rays); the hall's aspect ratio means Z wants the most probes.
 */
export function gridDimensionsForQuality(quality: number): [number, number, number] {
  const q = Math.min(1, Math.max(0, quality));
  const x = Math.round(11 + 7 * q); // 11..18
  const y = Math.round(6 + 3 * q); // 6..9
  const z = Math.round(22 + 14 * q); // 22..36
  return [x, y, z];
}

/** Hemisphere directions per probe. */
export function samplesPerProbeForQuality(quality: number): number {
  const q = Math.min(1, Math.max(0, quality));
  return Math.round(20 + 28 * q); // 20..48
}

export function createProbeGrid(
  dims: Vec3Tuple,
  min: Vec3Tuple = DEFAULT_GRID_MIN,
  max: Vec3Tuple = DEFAULT_GRID_MAX,
): ProbeGrid {
  if (dims[0] < 2 || dims[1] < 2 || dims[2] < 2) throw new Error('ProbeGrid needs at least 2 probes per axis');
  for (let axis = 0; axis < 3; axis++) {
    if (!(max[axis]! > min[axis]!)) throw new Error('ProbeGrid max must exceed min on every axis');
  }
  return { dims, min, max };
}

export function probeCount(grid: ProbeGrid): number {
  return grid.dims[0] * grid.dims[1] * grid.dims[2];
}

/** World position of a probe. Probe order is x fastest, then y, then z. */
export function probePosition(
  grid: ProbeGrid,
  ix: number,
  iy: number,
  iz: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  out[0] = grid.min[0] + ((grid.max[0] - grid.min[0]) * ix) / (grid.dims[0] - 1);
  out[1] = grid.min[1] + ((grid.max[1] - grid.min[1]) * iy) / (grid.dims[1] - 1);
  out[2] = grid.min[2] + ((grid.max[2] - grid.min[2]) * iz) / (grid.dims[2] - 1);
  return out;
}

/** Normalized grid coordinate in [0,1]^3 for a world position. */
export function gridCoordinate(
  grid: ProbeGrid,
  position: Vec3Tuple,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  out[0] = (position[0] - grid.min[0]) / (grid.max[0] - grid.min[0]);
  out[1] = (position[1] - grid.min[1]) / (grid.max[1] - grid.min[1]);
  out[2] = (position[2] - grid.min[2]) / (grid.max[2] - grid.min[2]);
  return out;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Trilinear sample of a channel-interleaved float grid. Values outside clamp to
 * the edge probes, matching GL_CLAMP_TO_EDGE on the uploaded 3D texture.
 */
export function trilinearSample(
  grid: ProbeGrid,
  data: Float32Array | readonly number[],
  position: Vec3Tuple,
  channels: number,
  out: number[],
): number[] {
  const [nx, ny, nz] = grid.dims;
  const c = gridCoordinate(grid, position);
  const fx = clamp01(c[0]) * (nx - 1);
  const fy = clamp01(c[1]) * (ny - 1);
  const fz = clamp01(c[2]) * (nz - 1);
  const ix = Math.min(nx - 2, Math.floor(fx));
  const iy = Math.min(ny - 2, Math.floor(fy));
  const iz = Math.min(nz - 2, Math.floor(fz));
  const tx = fx - ix;
  const ty = fy - iy;
  const tz = fz - iz;
  const index = (x: number, y: number, z: number): number => ((z * ny + y) * nx + x) * channels;
  const i000 = index(ix, iy, iz);
  const i100 = index(ix + 1, iy, iz);
  const i010 = index(ix, iy + 1, iz);
  const i110 = index(ix + 1, iy + 1, iz);
  const i001 = index(ix, iy, iz + 1);
  const i101 = index(ix + 1, iy, iz + 1);
  const i011 = index(ix, iy + 1, iz + 1);
  const i111 = index(ix + 1, iy + 1, iz + 1);
  for (let channel = 0; channel < channels; channel++) {
    const c000 = data[i000 + channel]!;
    const c100 = data[i100 + channel]!;
    const c010 = data[i010 + channel]!;
    const c110 = data[i110 + channel]!;
    const c001 = data[i001 + channel]!;
    const c101 = data[i101 + channel]!;
    const c011 = data[i011 + channel]!;
    const c111 = data[i111 + channel]!;
    const x00 = c000 + (c100 - c000) * tx;
    const x10 = c010 + (c110 - c010) * tx;
    const x01 = c001 + (c101 - c001) * tx;
    const x11 = c011 + (c111 - c011) * tx;
    const y0 = x00 + (x10 - x00) * ty;
    const y1 = x01 + (x11 - x01) * ty;
    out[channel] = y0 + (y1 - y0) * tz;
  }
  return out;
}

/** Linear index of the probe closest to `position` (used for the cheap bounce lookup). */
export function nearestProbeIndex(grid: ProbeGrid, position: Vec3Tuple): number {
  const c = gridCoordinate(grid, position);
  const ix = Math.round(clamp01(c[0]) * (grid.dims[0] - 1));
  const iy = Math.round(clamp01(c[1]) * (grid.dims[1] - 1));
  const iz = Math.round(clamp01(c[2]) * (grid.dims[2] - 1));
  return (iz * grid.dims[1] + iy) * grid.dims[0] + ix;
}

function radicalInverseVdC(bits: number): number {
  let value = bits >>> 0;
  value = ((value << 16) | (value >>> 16)) >>> 0;
  value = (((value & 0x55555555) << 1) | ((value & 0xaaaaaaaa) >>> 1)) >>> 0;
  value = (((value & 0x33333333) << 2) | ((value & 0xcccccccc) >>> 2)) >>> 0;
  value = (((value & 0x0f0f0f0f) << 4) | ((value & 0xf0f0f0f0) >>> 4)) >>> 0;
  value = (((value & 0x00ff00ff) << 8) | ((value & 0xff00ff00) >>> 8)) >>> 0;
  return value / 4294967296;
}

/** Van der Corput base 2 (the x component of a Hammersley set). */
export function radicalInverse(index: number): number {
  return radicalInverseVdC(index >>> 0);
}

/** Hammersley point `index` of `count`, both components in [0,1). */
export function hammersley(index: number, count: number): [number, number] {
  if (count <= 0) throw new Error('hammersley: count must be positive');
  return [index / count, radicalInverse(index)];
}

/**
 * Per-probe rotation of the sample set (Cranley–Patterson). Deterministic hash of
 * (probeIndex, seed), so probes de-clump without a shared RNG stream and two
 * bakes of the same scene produce bit-identical grids.
 */
export function probeRotation(probeIndex: number, seed: number): [number, number] {
  let h = Math.imul(probeIndex ^ seed, 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  const a = h / 4294967296;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  const b = h / 4294967296;
  return [a, b];
}

export function wrap01(value: number, offset: number): number {
  const wrapped = value + offset;
  return wrapped - Math.floor(wrapped);
}

/**
 * Uniform (area-preserving) direction on the unit sphere from two numbers in
 * [0,1). Uniform, not cosine-weighted, because the SH projection integrates the
 * full sphere; the cosine convolution happens later in the SH irradiance
 * evaluation, which is where three.js expects it.
 */
export function uniformSphereDirection(u1: number, u2: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const z = 1 - 2 * u1;
  const radius = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = 2 * Math.PI * u2;
  out[0] = radius * Math.cos(phi);
  out[1] = radius * Math.sin(phi);
  out[2] = z;
  return out;
}

// ---------------------------------------------------------------------------
// Spherical harmonics (identical conventions to three.js SphericalHarmonics3)
// ---------------------------------------------------------------------------

/** Real SH basis, band 0..2, matching `SphericalHarmonics3.getBasisAt`. */
export function shBasis(normal: Vec3Tuple, out: number[]): number[] {
  const [x, y, z] = normal;
  out[0] = 0.282095;
  out[1] = 0.488603 * y;
  out[2] = 0.488603 * z;
  out[3] = 0.488603 * x;
  out[4] = 1.092548 * x * y;
  out[5] = 1.092548 * y * z;
  out[6] = 0.315392 * (3 * z * z - 1);
  out[7] = 1.092548 * x * z;
  out[8] = 0.546274 * (x * x - y * y);
  return out;
}

/**
 * Irradiance for a surface normal from irradiance-convolved SH coefficients.
 * Matches three.js `SphericalHarmonics3.getIrradianceAt` and therefore the
 * probe-grid shader the renderer samples.
 */
export function shIrradiance(
  coefficients: Float32Array | readonly number[],
  offset: number,
  normal: Vec3Tuple,
  out: [number, number, number],
): [number, number, number] {
  const [x, y, z] = normal;
  // Interleaved layout: coefficient i holds r,g,b at offset + i * 3.
  const w0 = 0.886227;
  const w1 = 2 * 0.511664 * y;
  const w2 = 2 * 0.511664 * z;
  const w3 = 2 * 0.511664 * x;
  const w4 = 2 * 0.429043 * x * y;
  const w5 = 2 * 0.429043 * y * z;
  const w6 = 0.743125 * z * z - 0.247708;
  const w7 = 2 * 0.429043 * x * z;
  const w8 = 0.429043 * (x * x - y * y);
  const base = offset;
  for (let channel = 0; channel < 3; channel++) {
    out[channel] = coefficients[base + channel]! * w0 +
      coefficients[base + 3 + channel]! * w1 +
      coefficients[base + 6 + channel]! * w2 +
      coefficients[base + 9 + channel]! * w3 +
      coefficients[base + 12 + channel]! * w4 +
      coefficients[base + 15 + channel]! * w5 +
      coefficients[base + 18 + channel]! * w6 +
      coefficients[base + 21 + channel]! * w7 +
      coefficients[base + 24 + channel]! * w8;
  }
  out[0] = Math.max(0, out[0]);
  out[1] = Math.max(0, out[1]);
  out[2] = Math.max(0, out[2]);
  return out;
}

/**
 * Accumulate one radiance sample into interleaved SH coefficients:
 * `coefficients[i * 3 + channel] += radiance[channel] * basis[i] * scale`.
 */
export function accumulateShSample(
  coefficients: Float32Array,
  offset: number,
  radiance: Vec3Tuple,
  basis: readonly number[],
  scale: number,
): void {
  for (let i = 0; i < 9; i++) {
    const weight = basis[i]! * scale;
    coefficients[offset + i * 3] += radiance[0] * weight;
    coefficients[offset + i * 3 + 1] += radiance[1] * weight;
    coefficients[offset + i * 3 + 2] += radiance[2] * weight;
  }
}

/**
 * Weight for a directional hit during occlusion accumulation. Contact darkening
 * fades smoothly to zero at `radius`.
 */
export function contactOcclusion(distance: number, radius: number): number {
  if (radius <= 0) throw new Error('contactOcclusion: radius must be positive');
  const t = Math.min(1, Math.max(0, distance / radius));
  return 1 - t * t * (3 - 2 * t);
}
