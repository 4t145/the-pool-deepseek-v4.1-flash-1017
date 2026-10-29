import {
  AdditiveBlending,
  Box3,
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  Data3DTexture,
  DataUtils,
  DoubleSide,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  RGBAFormat,
  Ray,
  Vector3,
  type Material,
  type Scene,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import {
  accumulateShSample,
  contactOcclusion,
  createProbeGrid,
  gridDimensionsForQuality,
  hammersley,
  nearestProbeIndex,
  probeCount,
  probePosition,
  probeRotation,
  samplesPerProbeForQuality,
  shBasis,
  shIrradiance,
  trilinearSample,
  uniformSphereDirection,
  wrap01,
  type ProbeGrid,
  type Vec3Tuple,
} from '../core/bakeMath';

/**
 * Static lighting bake for THE POOL.
 *
 * The room is static, so its indirect light is solved once at load instead of
 * every frame:
 *
 * 1. Every opaque mesh in the built scene (architecture, detail, props) is merged
 *    into one non-indexed world-space mesh with per-triangle albedo, emission and
 *    emitter kind, plus a `three-mesh-bvh` acceleration structure.
 * 2. A 3D probe grid is ray traced. Each probe shoots stratified uniform-sphere
 *    samples: hits on emissive panes (skylight, windows, tubes, corridor glow)
 *    contribute their radiance; hits on surfaces record a first-bounce sample
 *    (albedo, sun shadow visibility, fluorescent direct light).
 * 3. Two Jacobi bounce passes propagate radiance between probes using the same
 *    recorded ray hits, giving two indirections without extra rays. Baked
 *    occlusion is implicit: a probe in a corner sees less skylight and dimmer
 *    nearby albedo, exactly like a real light probe.
 * 4. The nine SH coefficients per probe are packed into the 7-slice texture atlas
 *    layout that three.js' built-in light-probe-grid shader samples, and a
 *    `PoolProbeVolume` is added to the scene. The renderer then adds the baked
 *    irradiance to the indirect diffuse of every lit material automatically.
 *
 * No wall clock and no `Math.random`: two runs over the same scene produce a
 * bit-identical grid (Hammersley sample directions rotated by a deterministic
 * per-probe hash).
 */

const EMITTER_NAMES = new Set(['window-glass', 'skylight', 'fluorescent', 'warm-glow', 'bulkhead-lamp']);
const EMITTER_KIND_INDEX: Record<string, number> = {
  'window-glass': 1,
  skylight: 2,
  fluorescent: 3,
  'warm-glow': 4,
  'bulkhead-lamp': 5,
};
/** Fraction of direct sun that survives each emitter pane type on a shadow ray. */
const EMITTER_TRANSMISSION: Record<number, number> = {
  1: 0.34, // window glass, frosted
  2: 0.62, // skylight panel, frosted
  3: 1,
  4: 1,
  5: 1, // bulkhead lamp domes sit inside the hall
};

/** Mean texture reflectance for materials whose albedo map is not sampled on the CPU. */
const MAP_ALBEDO_MEAN = 0.75;
const INV_PI = 1 / Math.PI;
const FOUR_PI = 4 * Math.PI;

export interface PointLightSample {
  position: Vector3;
  color: Color;
  intensity: number;
  distance: number;
  decay: number;
}

export interface BakeOptions {
  scene: Scene;
  quality: number;
  /** Unit vector pointing from the scene toward the sun. */
  sunDirection: Vector3;
  sunColor: Color;
  sunIntensity: number;
  pointLights?: readonly PointLightSample[];
  /** Jacobi bounce passes. 2 gives sky → wall → wall; 3 is softer still. */
  bounceCount?: number;
  /** Radius in metres of the contact-occlusion accent applied to close hits. 0 disables it. */
  aoAccentRadius?: number;
  /** How much of the contact accent to apply, 0..1. */
  aoAccentStrength?: number;
  seed?: number;
  maxRayDistance?: number;
}

export interface BakeStats {
  probes: number;
  gridDims: [number, number, number];
  samplesPerProbe: number;
  primaryRays: number;
  shadowRays: number;
  bounces: number;
  triangles: number;
  meshes: number;
  skippedMeshes: number;
  emitterTriangles: number;
  emitterHits: number[];
  misalignedGeometries: number;
  milliseconds: number;
  atlasSize: [number, number, number];
}

interface MergedScene {
  geometry: BufferGeometry;
  positions: Float32Array;
  meshOf: Uint32Array;
  names: string[];
  albedo: Float32Array;
  emission: Float32Array;
  emitterKind: Uint8Array;
  triangles: number;
  meshCount: number;
  skipped: number;
  emitterTriangles: number;
  misalignedGeometries: number;
}

function materialAlbedo(material: Material): [number, number, number] {
  const loose = material as Material & { color?: Color; map?: unknown; metalness?: number };
  const color = loose.color ?? new Color(1, 1, 1);
  const textureFactor = loose.map ? MAP_ALBEDO_MEAN : 1;
  // Metals have no diffuse lobe; keep their injected diffuse bounce negligible.
  const metalFactor = loose.metalness !== undefined && loose.metalness > 0.6 ? 0.08 : 1;
  const factor = textureFactor * metalFactor;
  let r = color.r;
  let g = color.g;
  let b = color.b;
  // A single-bounce diffuse solve on a saturated plastic overshoots badly: the
  // hero flume is one huge red surface, so raw sRGB-to-linear 0x9c1d16
  // (0.33, 0.012, 0.009) turns the whole ceiling brown. Real surfaces gain
  // saturation from roughness/specular layers that this diffuse-only estimate
  // cannot see, so pull very saturated albedos toward their luminance. The
  // material's on-screen colour is untouched; only the bounce albedo changes.
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max > 0 ? (max - min) / max : 0;
  if (saturation > 0.5) {
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const blend = Math.min(0.62, (saturation - 0.5) * 1.6);
    r += (luminance - r) * blend;
    g += (luminance - g) * blend;
    b += (luminance - b) * blend;
  }
  return [r * factor, g * factor, b * factor];
}

function materialEmission(material: Material): { radiance: [number, number, number]; kind: number } | null {
  if (!EMITTER_NAMES.has(material.name)) return null;
  const kind = EMITTER_KIND_INDEX[material.name] ?? 0;
  // An emissive pane with a modulation map emits its mean map value, not the
  // material's peak colour. Materials declare that mean in userData.
  const mean = (material.userData as { emissiveMean?: number }).emissiveMean ?? 1;
  const standard = material as Material & { emissive?: Color; emissiveIntensity?: number };
  if (standard.emissive) {
    const intensity = (standard.emissiveIntensity ?? 1) * mean;
    return {
      radiance: [standard.emissive.r * intensity, standard.emissive.g * intensity, standard.emissive.b * intensity],
      kind,
    };
  }
  const color = (material as MeshBasicMaterial).color;
  if (!color) return null;
  return { radiance: [color.r * mean, color.g * mean, color.b * mean], kind };
}

function shouldBakeMesh(mesh: Mesh): boolean {
  if (!mesh.visible || !mesh.geometry) return false;
  const material = mesh.material;
  if (Array.isArray(material)) return false;
  if (!material || material.visible === false) return false;
  if (material.name === 'water') return false;
  if (material.transparent && material.opacity < 0.98) return false;
  if (material.blending === AdditiveBlending) return false;
  return true;
}

/** Merge every opaque mesh into one world-space, non-indexed ray-tracing mesh. */
function mergeScene(scene: Scene): MergedScene {
  scene.updateMatrixWorld(true);
  const positionChunks: Float32Array[] = [];
  const meshOfChunks: Uint32Array[] = [];
  const names: string[] = [];
  const albedoChunks: Float32Array[] = [];
  const emissionChunks: Float32Array[] = [];
  const kindChunks: Uint8Array[] = [];
  let triangles = 0;
  let meshCount = 0;
  let skipped = 0;
  let emitterTriangles = 0;
  let misalignedGeometries = 0;

  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    if (!shouldBakeMesh(mesh)) {
      skipped += 1;
      return;
    }
    const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    const position = geometry.getAttribute('position') as BufferAttribute | undefined;
    if (!position) {
      geometry.dispose();
      skipped += 1;
      return;
    }
    const triangleCount = Math.floor(position.count / 3);
    if (position.array.length !== position.count * 3) {
      misalignedGeometries += 1;
      console.warn('[bake] non-contiguous position buffer on', mesh.name, position.array.length, position.count);
    }
    const albedo = materialAlbedo(mesh.material as Material);
    const emission = materialEmission(mesh.material as Material);
    if (emission) emitterTriangles += triangleCount;

    positionChunks.push(new Float32Array(position.array as ArrayLike<number>));
    const albedoChunk = new Float32Array(triangleCount * 3);
    const emissionChunk = new Float32Array(triangleCount * 3);
    const kindChunk = new Uint8Array(triangleCount);
    for (let t = 0; t < triangleCount; t++) {
      albedoChunk[t * 3] = albedo[0];
      albedoChunk[t * 3 + 1] = albedo[1];
      albedoChunk[t * 3 + 2] = albedo[2];
      if (emission) {
        emissionChunk[t * 3] = emission.radiance[0];
        emissionChunk[t * 3 + 1] = emission.radiance[1];
        emissionChunk[t * 3 + 2] = emission.radiance[2];
        kindChunk[t] = emission.kind;
      }
    }
    const meshOf = new Uint32Array(triangleCount);
    meshOf.fill(meshCount);
    meshOfChunks.push(meshOf);
    names.push(mesh.name);
    albedoChunks.push(albedoChunk);
    emissionChunks.push(emissionChunk);
    kindChunks.push(kindChunk);
    triangles += triangleCount;
    meshCount += 1;
    geometry.dispose();
  });

  const concatFloats = (chunks: Float32Array[]): Float32Array => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  };
  const concatBytes = (chunks: Uint8Array[]): Uint8Array => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  };

  const positions = concatFloats(positionChunks);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));

  return {
    geometry,
    positions,
    meshOf: (() => {
      const total = meshOfChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const merged = new Uint32Array(total);
      let offset = 0;
      for (const chunk of meshOfChunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      return merged;
    })(),
    names,
    albedo: concatFloats(albedoChunks),
    emission: concatFloats(emissionChunks),
    emitterKind: concatBytes(kindChunks),
    triangles,
    meshCount,
    skipped,
    emitterTriangles,
    misalignedGeometries,
  };
}

/** Geometric (face) normal, oriented toward `toward`. */
function faceNormalAt(merged: MergedScene, faceIndex: number, toward: Vector3, out: Vector3): Vector3 {
  const a = faceIndex * 9;
  const positions = merged.positions;
  const ax = positions[a]!;
  const ay = positions[a + 1]!;
  const az = positions[a + 2]!;
  const e1x = positions[a + 3]! - ax;
  const e1y = positions[a + 4]! - ay;
  const e1z = positions[a + 5]! - az;
  const e2x = positions[a + 6]! - ax;
  const e2y = positions[a + 7]! - ay;
  const e2z = positions[a + 8]! - az;
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const length = Math.hypot(nx, ny, nz) || 1;
  nx /= length;
  ny /= length;
  nz /= length;
  if (nx * toward.x + ny * toward.y + nz * toward.z < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  return out.set(nx, ny, nz);
}

interface BakeSamples {
  hit: Uint8Array;
  normal: Float32Array;
  albedo: Float32Array;
  sun: Float32Array;
  point: Float32Array;
  direction: Float32Array;
  nearest: Int32Array;
  weight: Float32Array;
}

function allocateSamples(count: number): BakeSamples {
  return {
    hit: new Uint8Array(count),
    normal: new Float32Array(count * 3),
    albedo: new Float32Array(count * 3),
    sun: new Float32Array(count * 3),
    point: new Float32Array(count * 3),
    direction: new Float32Array(count * 3),
    nearest: new Int32Array(count),
    weight: new Float32Array(count),
  };
}

/** Matches three.js getDistanceAttenuation for a point light (decay, optional cutoff). */
function pointLightIrradiance(
  lights: readonly PointLightSample[],
  position: Vector3,
  normal: Vector3,
  out: [number, number, number],
): [number, number, number] {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  for (const light of lights) {
    const dx = light.position.x - position.x;
    const dy = light.position.y - position.y;
    const dz = light.position.z - position.z;
    const distanceSq = dx * dx + dy * dy + dz * dz;
    if (distanceSq < 1e-6) continue;
    const distance = Math.sqrt(distanceSq);
    if (light.distance > 0 && distance > light.distance) continue;
    const cosTheta = (dx * normal.x + dy * normal.y + dz * normal.z) / distance;
    if (cosTheta <= 0) continue;
    let falloff = 1 / Math.max(Math.pow(distance, light.decay), 0.01);
    if (light.distance > 0) {
      const ratio = distance / light.distance;
      const cutoff = Math.max(0, 1 - ratio * ratio * ratio * ratio);
      falloff *= cutoff * cutoff;
    }
    const scale = light.intensity * falloff * cosTheta;
    out[0] += light.color.r * scale;
    out[1] += light.color.g * scale;
    out[2] += light.color.b * scale;
  }
  return out;
}

/**
 * The object the renderer recognises as a light-probe grid. It owns the packed
 * SH atlas; three.js samples it for every lit material in the scene.
 */
export class PoolProbeVolume extends Object3D {
  readonly isLightProbeGrid = true;
  texture: Data3DTexture | null = null;
  readonly boundingBox = new Box3();
  readonly resolution = new Vector3(1, 1, 1);

  constructor() {
    super();
    this.name = 'light-probe-grid';
    this.matrixAutoUpdate = false;
    this.frustumCulled = false;
  }
}

export interface BakedLighting {
  volume: PoolProbeVolume;
  grid: ProbeGrid;
  /** Interleaved 27-channel SH coefficients per probe (x fastest). */
  coefficients: Float32Array;
  stats: BakeStats;
  /** CPU trilinear irradiance lookup, used by diagnostics and tests. */
  sampleIrradiance(position: Vec3Tuple, normal: Vec3Tuple, out?: [number, number, number]): [number, number, number];
  dispose(): void;
}

/**
 * Pack interleaved SH coefficients into the atlas layout expected by three.js'
 * `lightprobes_pars_fragment` chunk: 7 RGBA slices per probe, padded by one probe
 * at each end of Z so hardware trilinear filtering never bleeds across probes.
 */
export function packProbeAtlas(
  grid: ProbeGrid,
  coefficients: Float32Array,
): { data: Uint16Array; width: number; height: number; depth: number } {
  const [nx, ny, nz] = grid.dims;
  const paddedSlices = nz + 2;
  const depth = 7 * paddedSlices;
  const width = nx;
  const height = ny;
  const data = new Uint16Array(width * height * depth * 4);
  const write = (x: number, y: number, z: number, r: number, g: number, b: number, a: number): void => {
    const offset = ((z * height + y) * width + x) * 4;
    data[offset] = DataUtils.toHalfFloat(r);
    data[offset + 1] = DataUtils.toHalfFloat(g);
    data[offset + 2] = DataUtils.toHalfFloat(b);
    data[offset + 3] = DataUtils.toHalfFloat(a);
  };

  for (let iz = 0; iz < nz; iz++) {
    // Duplicate the first and last probe into the padding slices.
    const sources = iz === 0 ? [0, 0] : iz === nz - 1 ? [iz, iz] : [iz];
    for (const sourceZ of sources) {
      const sliceIndex = 1 + sourceZ;
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const probe = (sourceZ * ny + iy) * nx + ix;
          const probeOffset = probe * 27;
          const c = (index: number, channel: number): number => coefficients[probeOffset + index * 3 + channel]!;
          write(ix, iy, sliceIndex, c(0, 0), c(0, 1), c(0, 2), c(1, 0));
          write(ix, iy, paddedSlices + sliceIndex, c(1, 1), c(1, 2), c(2, 0), c(2, 1));
          write(ix, iy, 2 * paddedSlices + sliceIndex, c(2, 2), c(3, 0), c(3, 1), c(3, 2));
          write(ix, iy, 3 * paddedSlices + sliceIndex, c(4, 0), c(4, 1), c(4, 2), c(5, 0));
          write(ix, iy, 4 * paddedSlices + sliceIndex, c(5, 1), c(5, 2), c(6, 0), c(6, 1));
          write(ix, iy, 5 * paddedSlices + sliceIndex, c(6, 2), c(7, 0), c(7, 1), c(7, 2));
          write(ix, iy, 6 * paddedSlices + sliceIndex, c(8, 0), c(8, 1), c(8, 2), 0);
        }
      }
    }
  }

  return { data, width, height, depth };
}

export function bakeLighting(options: BakeOptions): BakedLighting {
  const startedAt = performance.now();
  const quality = Math.min(1, Math.max(0, options.quality));
  const bounceCount = options.bounceCount ?? 2;
  const seed = options.seed ?? 0x51ff;
  const maxRayDistance = options.maxRayDistance ?? 90;
  const aoAccentRadius = options.aoAccentRadius ?? 0.32;
  const aoAccentStrength = options.aoAccentStrength ?? 0.35;

  const merged = mergeScene(options.scene);
  const bvh = new MeshBVH(merged.geometry, { targetLeafSize: 12, maxDepth: 64 });

  // three-mesh-bvh reorders the geometry's index buffer in place and reports the
  // intersected triangle in *BVH order*. Every per-face table (albedo, emission,
  // emitter kind, mesh name) is keyed by the original triangle order, so build the
  // permutation once and translate every hit through it.
  const bvhIndex = merged.geometry.index;
  const bvhTriangleCount = Math.floor((bvhIndex?.count ?? merged.positions.length / 3) / 3);
  const originalTriangle = new Uint32Array(bvhTriangleCount);
  for (let t = 0; t < bvhTriangleCount; t++) {
    const vertexIndex = bvhIndex ? bvhIndex.getX(t * 3) : t * 3;
    originalTriangle[t] = Math.floor(vertexIndex / 3);
  }
  const originalTriangleOf = (hit: { faceIndex?: number | null }): number => originalTriangle[hit.faceIndex ?? 0] ?? 0;

  const grid = createProbeGrid(gridDimensionsForQuality(quality));
  const probes = probeCount(grid);
  const samplesPerProbe = samplesPerProbeForQuality(quality);
  const totalSamples = probes * samplesPerProbe;

  const directSh = new Float32Array(probes * 27);
  const totalSh = new Float32Array(probes * 27);
  const bounceSh = new Float32Array(probes * 27);
  const samples = allocateSamples(totalSamples);
  const baseSamples: Array<[number, number]> = [];
  for (let i = 0; i < samplesPerProbe; i++) baseSamples.push(hammersley(i, samplesPerProbe));

  const ray = new Ray();
  const hitNormal = new Vector3();
  const towardProbe = new Vector3();
  const shadowOrigin = new Vector3();
  const basis = new Array<number>(9).fill(0);
  const radiance: [number, number, number] = [0, 0, 0];
  const pointIrr: [number, number, number] = [0, 0, 0];
  const probeWorld: [number, number, number] = [0, 0, 0];
  const direction: [number, number, number] = [0, 0, 0];
  const sunDirection = options.sunDirection.clone().normalize();
  const sunColor = options.sunColor;
  const sunIntensity = options.sunIntensity;
  const pointLights = options.pointLights ?? [];
  let primaryRays = 0;
  let shadowRays = 0;
  const emitterHits = [0, 0, 0, 0, 0, 0];

  /** Transmittance toward the sun: 0 shadowed, 1 direct, partial through frosted panes. */
  const sunTransmittance = (position: Vector3, normal: Vector3): number => {
    if (normal.x * sunDirection.x + normal.y * sunDirection.y + normal.z * sunDirection.z <= 0) return 0;
    shadowRays += 1;
    shadowOrigin.copy(position).addScaledVector(normal, 0.015);
    ray.origin.copy(shadowOrigin);
    ray.direction.copy(sunDirection);
    const hit = bvh.raycastFirst(ray, DoubleSide, 0.012, maxRayDistance);
    if (!hit) return 1;
    // `faceIndex` is the triangle index (three-mesh-bvh `intersectTri` overwrites the
    // vertex index), and the bake mesh is non-indexed, so per-face tables line up.
    const kind = merged.emitterKind[originalTriangleOf(hit)] ?? 0;
    if (kind === 0) return 0;
    return EMITTER_TRANSMISSION[kind] ?? 1;
  };

  // ---- Pass A: probe visibility, emitter radiance, first-bounce samples -----
  for (let iz = 0; iz < grid.dims[2]; iz++) {
    for (let iy = 0; iy < grid.dims[1]; iy++) {
      for (let ix = 0; ix < grid.dims[0]; ix++) {
        const probe = (iz * grid.dims[1] + iy) * grid.dims[0] + ix;
        probePosition(grid, ix, iy, iz, probeWorld);
        const rotation = probeRotation(probe, seed);
        const probeShOffset = probe * 27;
        const sampleBase = probe * samplesPerProbe;
        for (let s = 0; s < samplesPerProbe; s++) {
          const [u1, u2] = baseSamples[s]!;
          uniformSphereDirection(wrap01(u1, rotation[0]), wrap01(u2, rotation[1]), direction);
          ray.origin.set(probeWorld[0], probeWorld[1], probeWorld[2]);
          ray.direction.set(direction[0], direction[1], direction[2]);
          primaryRays += 1;
          const hit = bvh.raycastFirst(ray, DoubleSide, 0.004, maxRayDistance);
          if (!hit) continue;
          const triangle = originalTriangleOf(hit);
          const kind = merged.emitterKind[triangle] ?? 0;
          const index = sampleBase + s;
          if (kind !== 0) {
            emitterHits[kind] = (emitterHits[kind] ?? 0) + 1;
            radiance[0] = merged.emission[triangle * 3]!;
            radiance[1] = merged.emission[triangle * 3 + 1]!;
            radiance[2] = merged.emission[triangle * 3 + 2]!;
            shBasis(direction, basis);
            accumulateShSample(directSh, probeShOffset, radiance, basis, FOUR_PI / samplesPerProbe);
            continue;
          }
          samples.hit[index] = 1;
          const hitPoint = hit.point;
          samples.direction[index * 3] = direction[0];
          samples.direction[index * 3 + 1] = direction[1];
          samples.direction[index * 3 + 2] = direction[2];
          towardProbe.set(probeWorld[0] - hitPoint.x, probeWorld[1] - hitPoint.y, probeWorld[2] - hitPoint.z).normalize();
          faceNormalAt(merged, triangle, towardProbe, hitNormal);
          samples.normal[index * 3] = hitNormal.x;
          samples.normal[index * 3 + 1] = hitNormal.y;
          samples.normal[index * 3 + 2] = hitNormal.z;
          samples.albedo[index * 3] = merged.albedo[triangle * 3]!;
          samples.albedo[index * 3 + 1] = merged.albedo[triangle * 3 + 1]!;
          samples.albedo[index * 3 + 2] = merged.albedo[triangle * 3 + 2]!;
          const transmission = sunTransmittance(hitPoint, hitNormal);
          const sunCos = Math.max(
            0,
            hitNormal.x * sunDirection.x + hitNormal.y * sunDirection.y + hitNormal.z * sunDirection.z,
          );
          const sunScale = transmission * sunCos * sunIntensity;
          samples.sun[index * 3] = sunColor.r * sunScale;
          samples.sun[index * 3 + 1] = sunColor.g * sunScale;
          samples.sun[index * 3 + 2] = sunColor.b * sunScale;
          pointLightIrradiance(pointLights, hitPoint, hitNormal, pointIrr);
          samples.point[index * 3] = pointIrr[0];
          samples.point[index * 3 + 1] = pointIrr[1];
          samples.point[index * 3 + 2] = pointIrr[2];
          samples.nearest[index] = nearestProbeIndex(grid, [hitPoint.x, hitPoint.y, hitPoint.z]);
          const occlusion = aoAccentRadius > 0 ? contactOcclusion(hit.distance, aoAccentRadius) : 0;
          samples.weight[index] = 1 - occlusion * aoAccentStrength;
        }
      }
    }
  }

  // ---- Bounce passes: two indirections from the recorded ray hits -----------
  const irradiance: [number, number, number] = [0, 0, 0];
  for (let bounce = 0; bounce < bounceCount; bounce++) {
    bounceSh.fill(0);
    for (let probe = 0; probe < probes; probe++) {
      const sampleBase = probe * samplesPerProbe;
      const probeShOffset = probe * 27;
      for (let s = 0; s < samplesPerProbe; s++) {
        const index = sampleBase + s;
        if (!samples.hit[index]) continue;
        shIrradiance(
          totalSh,
          samples.nearest[index]! * 27,
          [samples.normal[index * 3]!, samples.normal[index * 3 + 1]!, samples.normal[index * 3 + 2]!],
          irradiance,
        );
        irradiance[0] += samples.sun[index * 3]! + samples.point[index * 3]!;
        irradiance[1] += samples.sun[index * 3 + 1]! + samples.point[index * 3 + 1]!;
        irradiance[2] += samples.sun[index * 3 + 2]! + samples.point[index * 3 + 2]!;
        const scale = (samples.weight[index]! * INV_PI) / samplesPerProbe;
        radiance[0] = samples.albedo[index * 3]! * irradiance[0] * scale;
        radiance[1] = samples.albedo[index * 3 + 1]! * irradiance[1] * scale;
        radiance[2] = samples.albedo[index * 3 + 2]! * irradiance[2] * scale;
        shBasis(
          [samples.direction[index * 3]!, samples.direction[index * 3 + 1]!, samples.direction[index * 3 + 2]!],
          basis,
        );
        accumulateShSample(bounceSh, probeShOffset, radiance, basis, FOUR_PI);
      }
    }
    for (let i = 0; i < totalSh.length; i++) totalSh[i] = directSh[i]! + bounceSh[i]!;
  }
  if (bounceCount === 0) totalSh.set(directSh);

  const { data, width, height, depth } = packProbeAtlas(grid, totalSh);
  const texture = new Data3DTexture(data, width, height, depth);
  texture.name = 'pool.probes';
  texture.format = RGBAFormat;
  texture.type = HalfFloatType;
  texture.colorSpace = LinearSRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.wrapR = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  const volume = new PoolProbeVolume();
  volume.texture = texture;
  volume.boundingBox.min.set(grid.min[0], grid.min[1], grid.min[2]);
  volume.boundingBox.max.set(grid.max[0], grid.max[1], grid.max[2]);
  volume.resolution.set(grid.dims[0], grid.dims[1], grid.dims[2]);

  const stats: BakeStats = {
    probes,
    gridDims: [grid.dims[0], grid.dims[1], grid.dims[2]],
    samplesPerProbe,
    primaryRays,
    shadowRays,
    bounces: bounceCount,
    triangles: merged.triangles,
    meshes: merged.meshCount,
    skippedMeshes: merged.skipped,
    emitterTriangles: merged.emitterTriangles,
    emitterHits,
    misalignedGeometries: merged.misalignedGeometries,
    milliseconds: performance.now() - startedAt,
    atlasSize: [width, height, depth],
  };

  // The BVH is only needed during the bake; keeping it alive would cost memory.
  merged.geometry.dispose();
  void bvh;

  const coefficientSample = new Array<number>(27).fill(0);

  return {
    volume,
    grid,
    coefficients: totalSh,
    stats,
    sampleIrradiance(position, normal, out = [0, 0, 0]) {
      trilinearSample(grid, totalSh, position, 27, coefficientSample);
      return shIrradiance(coefficientSample, 0, normal, out);
    },
    dispose() {
      volume.removeFromParent();
      texture.dispose();
    },
  };
}
