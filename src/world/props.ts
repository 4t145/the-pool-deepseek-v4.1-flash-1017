import {
  BackSide,
  BoxGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  FrontSide,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  Quaternion,
  RepeatWrapping,
  RingGeometry,
  SRGBColorSpace,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  BufferAttribute,
  type BufferGeometry,
  type Material,
  type Object3D,
  type Scene,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LAYOUT } from './layout';
import type { MaterialLibrary } from './materials';
import { addStaticMesh, applyWorldUVs } from './geometry';
import { flumeSpiralPoints, postPositions, railingSpans, ringFloatPose } from './propLayout';
import { Rng } from '../core/rng';
import { clamp } from '../core/math';

export interface PropsSystem {
  group: Group;
  /**
   * Cloned flume materials (they replace the shared red PVC), exposed so the
   * water caustics pass can patch them. `materials.redPlastic` itself is no
   * longer used by the flume, so caustics applied to that library material
   * would never reach these meshes.
   */
  causticTargets: readonly Material[];
  update(time: number): void;
}

const UP = new Vector3(0, 1, 0);
const FORWARD = new Vector3(0, 0, 1);

// ---------------------------------------------------------------------------
// Small geometry / texture helpers
// ---------------------------------------------------------------------------

function canvasTexture(canvas: HTMLCanvasElement, srgb: boolean): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Subtle tileable orange-peel normal map for the rotomoulded PVC. The flume
 * surface is glossy, so a very low-amplitude bump keeps the highlight from
 * looking like a perfect CG cylinder without reading as bumpy plastic.
 */
function createPeelNormalTexture(seed = 913, size = 128): Texture {
  const lattice = 32;
  const periodic = (ix: number, iy: number): number => {
    const x = ((ix % lattice) + lattice) % lattice;
    const y = ((iy % lattice) + lattice) % lattice;
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smoothNoise = (x: number, y: number): number => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = periodic(xi, yi);
    const b = periodic(xi + 1, yi);
    const c = periodic(xi, yi + 1);
    const d = periodic(xi + 1, yi + 1);
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  };
  const samples = lattice / 4;
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * samples;
      const v = (y / size) * samples;
      height[y * size + x] = smoothNoise(u, v) * 0.65 + smoothNoise(u * 2.1 + 3, v * 2.1 + 7) * 0.35;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  const image = ctx.createImageData(size, size);
  const strength = 0.55;
  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const dx = (height[y * size + xp] ?? 0) - (height[y * size + xm] ?? 0);
      const dy = (height[yp * size + x] ?? 0) - (height[ym * size + x] ?? 0);
      const nx = -dx * strength;
      const ny = -dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const o = (y * size + x) * 4;
      image.data[o] = Math.round((nx / len) * 0.5 * 255 + 127.5);
      image.data[o + 1] = Math.round((ny / len) * 0.5 * 255 + 127.5);
      image.data[o + 2] = Math.round((nz / len) * 0.5 * 255 + 127.5);
      image.data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = canvasTexture(canvas, false);
  texture.minFilter = LinearMipmapLinearFilter;
  return texture;
}

/**
 * Cylindrical UVs for the flume tower: u is arc length around the column and v
 * is world height, so the 125 mm tile grid keeps its scale around the curve
 * instead of switching axis at the 45° world-space seams `applyWorldUVs` gives.
 */
function applyCylindricalUVs(geometry: BufferGeometry, centerX: number, centerZ: number, radius: number): void {
  const position = geometry.getAttribute('position');
  const uvs = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i) - centerX;
    const z = position.getZ(i) - centerZ;
    let angle = Math.atan2(z, x);
    if (angle < 0) angle += Math.PI * 2;
    uvs[i * 2] = angle * radius;
    uvs[i * 2 + 1] = position.getY(i);
  }
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
}

/** Deterministic value noise, used only for procedural grime / print textures. */
function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const hash = (ix: number, iy: number): number => {
    let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/**
 * Grime mask for the flume: broad blotches plus vertical run-off streaks.
 * Sampled in the PVC stain shader with world-space coordinates, so the stain
 * follows the physical tube instead of its UV unwrap.
 */
function createFlumeGrimeTexture(seed = 4711, size = 512): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Streaks are stretched along V so drips read as vertical run-off.
      const streaks = valueNoise(u * 46, v * 3.4, seed) * 0.62 + valueNoise(u * 17, v * 1.6, seed + 31) * 0.38;
      const blotch = valueNoise(u * 5, v * 5, seed + 71);
      const grain = valueNoise(u * 190, v * 190, seed + 17) * 0.14;
      const value = clamp(streaks * 0.68 + blotch * 0.24 + grain, 0, 1);
      const o = (y * size + x) * 4;
      const byte = Math.round(value * 255);
      image.data[o] = byte;
      image.data[o + 1] = byte;
      image.data[o + 2] = byte;
      image.data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvasTexture(canvas, false);
}

/**
 * Printed vinyl for an inflatable ring: base colour, broad contrasting printed
 * bands, soft printed edges, scuffs and a darkening where the mould seam runs.
 * `u` wraps around the ring and `v` around the tube, so a band in v is a
 * painted stripe running around the ring. Printed, not a separate plastic band.
 */
function createRingPrintTexture(primary: number, secondary: number, seed: number): Texture {
  const width = 512;
  const height = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  const base = new Color(primary);
  const band = new Color(secondary);
  const rng = new Rng(seed);
  ctx.fillStyle = `#${base.clone().lerp(new Color(0xf2efe6), 0.08).getHexString()}`;
  ctx.fillRect(0, 0, width, height);

  const drawBand = (center: number, thickness: number): void => {
    ctx.fillStyle = `#${band.clone().lerp(base, 0.12).getHexString()}`;
    for (let x = 0; x < width; x += 4) {
      const edge = Math.sin((x / width) * Math.PI * 8 + seed) * 2.4;
      ctx.fillRect(x, center - thickness / 2 + edge, 5, thickness);
    }
    // Pad-printed ink edge: a faint shadow under the band and a sheen on top.
    ctx.fillStyle = 'rgba(0,0,0,0.10)';
    ctx.fillRect(0, center - thickness / 2, width, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(0, center - thickness / 2 + 2, width, 2);
  };

  drawBand(height * 0.27, height * 0.13);
  drawBand(height * 0.73, height * 0.13);

  // Mould seam: darkened band at the UV seam.
  const seamGradient = ctx.createLinearGradient(0, 0, 0, height);
  seamGradient.addColorStop(0.0, 'rgba(0,0,0,0.24)');
  seamGradient.addColorStop(0.06, 'rgba(0,0,0,0.0)');
  seamGradient.addColorStop(0.94, 'rgba(0,0,0,0.0)');
  seamGradient.addColorStop(1.0, 'rgba(0,0,0,0.24)');
  ctx.fillStyle = seamGradient;
  ctx.fillRect(0, 0, width, height);

  // Scuffs and waterline dirt. Deterministic.
  for (let i = 0; i < 260; i++) {
    const x = rng.next() * width;
    const y = rng.next() * height;
    const w = 1 + rng.next() * 9;
    const h = 1 + rng.next() * 2;
    const light = rng.next() > 0.45;
    ctx.fillStyle = light ? `rgba(255,255,255,${0.015 + rng.next() * 0.05})` : `rgba(20,26,22,${0.01 + rng.next() * 0.05})`;
    ctx.fillRect(x, y, w, h);
  }
  for (let i = 0; i < 34; i++) {
    const x = rng.next() * width;
    const y = rng.next() * height;
    ctx.fillStyle = `rgba(38,50,38,${0.03 + rng.next() * 0.05})`;
    ctx.beginPath();
    ctx.ellipse(x, y, 3 + rng.next() * 18, 1 + rng.next() * 5, rng.next() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvasTexture(canvas, true);
}

/** Collects world-space geometry and merges it into a single draw call. */
class GeometryBatch {
  private readonly parts: BufferGeometry[] = [];

  add(geometry: BufferGeometry): void {
    this.parts.push(geometry);
  }

  addTransformed(geometry: BufferGeometry, position?: Vector3, quaternion?: Quaternion, scale?: Vector3): void {
    const matrix = new Matrix4().compose(position ?? new Vector3(), quaternion ?? new Quaternion(), scale ?? new Vector3(1, 1, 1));
    geometry.applyMatrix4(matrix);
    this.parts.push(geometry);
  }

  /** Cylinder between two world points, with the transform baked in. */
  addRod(a: Vector3, b: Vector3, radius: number, segments = 10): void {
    const direction = new Vector3().subVectors(b, a);
    const length = direction.length();
    if (length < 1e-4) return;
    const geometry = new CylinderGeometry(radius, radius, length, segments, 1, false);
    const quaternion = new Quaternion().setFromUnitVectors(UP, direction.normalize());
    const midpoint = new Vector3().addVectors(a, b).multiplyScalar(0.5);
    this.addTransformed(geometry, midpoint, quaternion);
  }

  build(material: Material, name: string, parent: Object3D): Mesh | null {
    if (this.parts.length === 0) return null;
    const merged = mergeGeometries(this.parts, false);
    for (const part of this.parts) part.dispose();
    this.parts.length = 0;
    if (!merged) {
      console.warn(`[props] failed to merge ${name}`);
      return null;
    }
    merged.computeBoundingSphere();
    return addStaticMesh(parent, merged, material, name, { castShadow: true, receiveShadow: true });
  }
}

// ---------------------------------------------------------------------------
// Flume material: red PVC with world-space waterline staining
// ---------------------------------------------------------------------------

function createFlumePvcMaterial(base: MeshPhysicalMaterial, grime: Texture, peel: Texture): MeshPhysicalMaterial {
  const material = base.clone();
  material.name = 'flume.pvc.stained';
  material.side = FrontSide;
  material.roughness = 0.2;
  material.clearcoat = 1;
  material.clearcoatRoughness = 0.07;
  material.normalMap = peel;
  material.normalScale = new Vector2(0.14, 0.14);
  peel.repeat.set(86, 30);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGrime = { value: grime };
    shader.uniforms.uWaterline = { value: LAYOUT.water.surface };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPropWorld;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vPropWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vPropWorld;
        uniform sampler2D uGrime;
        uniform float uWaterline;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float propY = vPropWorld.y - uWaterline;
        // Wet band just above the waterline, plus a sharp historic tide mark.
        float wetBand = smoothstep(1.2, 0.1, propY);
        float tide = exp(-pow((propY - 0.85) / 0.055, 2.0));
        float algae = smoothstep(0.3, -0.05, propY);
        float streakA = texture2D(uGrime, vec2((vPropWorld.x + vPropWorld.z) * 0.22, propY * 0.052 + 0.17)).r;
        float streakB = texture2D(uGrime, vec2((vPropWorld.x - vPropWorld.z) * 0.09 + 0.41, propY * 0.017 + 0.63)).r;
        float streak = smoothstep(0.40, 0.80, streakA * 0.62 + streakB * 0.48);
        float grime = clamp(wetBand * (0.3 + 0.55 * streak) + tide * 0.6 + algae * 0.35, 0.0, 1.0);
        vec3 stain = mix(diffuseColor.rgb, vec3(0.062, 0.074, 0.047), grime * 0.82);
        stain = mix(stain, stain * vec3(0.74, 0.94, 0.68), algae * 0.42);
        // A pale mineral scale line where splash water has dried for years.
        float scaleLine = exp(-pow((propY - 0.13) / 0.075, 2.0)) * (0.35 + 0.65 * streak);
        stain = mix(stain, vec3(0.33, 0.35, 0.29), scaleLine * 0.5);
        // Sun-bleached shoulders above the waterline.
        stain *= 1.0 + smoothstep(1.6, 4.5, propY) * 0.06;
        diffuseColor.rgb = stain;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + grime * 0.34 + algae * 0.12, 0.0, 1.0);`,
      );
  };
  material.customProgramCacheKey = () => 'pool.flume.pvc.stain.v1';
  material.needsUpdate = true;
  return material;
}

function createFlumeLinerMaterial(base: MeshPhysicalMaterial): MeshPhysicalMaterial {
  const material = base.clone();
  material.name = 'flume.liner';
  material.side = BackSide;
  material.color = new Color(0x6a1c14);
  material.emissive = new Color(0x140604);
  material.roughness = 0.52;
  material.clearcoat = 0.4;
  material.clearcoatRoughness = 0.32;
  material.metalness = 0;
  // The liner's UV.x runs along the tube (1 = the open mouth). Fade the inner
  // wall to black over the last ~0.7 m so the throat reads as depth instead of
  // a flat dark cap, and leave a faint wet sheen right at the opening.
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vTubeU;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vTubeU = uv.x;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vTubeU;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float throatDepth = smoothstep(0.994, 0.955, vTubeU);
        diffuseColor.rgb *= mix(1.0, 0.035, throatDepth);
        diffuseColor.rgb += vec3(0.03, 0.007, 0.003) * smoothstep(0.965, 0.999, vTubeU);`,
      );
  };
  material.customProgramCacheKey = () => 'pool.flume.liner.v2';
  material.needsUpdate = true;
  return material;
}

// ---------------------------------------------------------------------------
// Flume
// ---------------------------------------------------------------------------

/**
 * The hero flume. A tiled column rises out of the flooded basin and carries a
 * red boarding platform; a closed PVC corkscrew wraps it and dives to a
 * half-submerged mouth aimed at the camera.
 */
function buildFlume(
  materials: MaterialLibrary,
  grime: Texture,
  chrome: GeometryBatch,
): { group: Group; causticTargets: Material[] } {
  const S = LAYOUT.slide;
  const group = new Group();
  group.name = 'slide';
  const tubeRadius = S.tubeRadius;
  const mouth = S.end.clone();
  const mouthDirection = S.mouthDirection.clone().normalize();
  const peel = createPeelNormalTexture();
  const pvcMaterial = createFlumePvcMaterial(materials.redPlastic, grime, peel);

  // Hand-authored silhouette. The spiral generator supplies the corkscrew; the
  // tail points the open mouth at the camera and dips it below the water plane.
  const spiral = flumeSpiralPoints({
    center: new Vector3(S.tower.x, 0, S.tower.z),
    startAngle: Math.PI * 0.38,
    turns: -1.25,
    startRadius: 1.25,
    endRadius: 1.95,
    topY: S.platformY - 0.3,
    bottomY: 1.35,
    samples: 16,
    wobble: 0.055,
  });
  // The point before the mouth is placed on the mouth axis so the curve's end
  // tangent matches `mouthDirection` and the rim cannot be misaligned.
  const approach = mouth.clone().addScaledVector(mouthDirection, -1.8);
  const controlPoints = [...spiral, new Vector3(5.95, 1.06, -15.5), approach, mouth.clone()];
  const curve = new CatmullRomCurve3(controlPoints, false, 'catmullrom', 0.32);
  const tubeLength = curve.getLength();

  // ---- Tube + hollow mouth -------------------------------------------------
  const pvcBatch = new GeometryBatch();
  pvcBatch.add(new TubeGeometry(curve, 360, tubeRadius, 26, false));
  const mouthQuaternion = new Quaternion().setFromUnitVectors(FORWARD, mouthDirection);
  // Rolled lip: a short flared collar, a solid rim torus, and an annulus that
  // closes the wall thickness. The inner liner (BackSide) reads as a wet throat.
  const flare = new CylinderGeometry(tubeRadius + 0.075, tubeRadius, 0.36, 46, 1, true);
  const flareQuaternion = new Quaternion().setFromUnitVectors(UP, mouthDirection);
  pvcBatch.addTransformed(flare, mouth.clone().addScaledVector(mouthDirection, 0.02), flareQuaternion);
  const rim = new TorusGeometry(tubeRadius + 0.055, 0.072, 16, 72);
  pvcBatch.addTransformed(rim, mouth.clone().addScaledVector(mouthDirection, 0.2), mouthQuaternion);
  const lipAnnulus = new RingGeometry(tubeRadius - 0.055, tubeRadius + 0.055, 56, 1);
  pvcBatch.addTransformed(lipAnnulus, mouth.clone().addScaledVector(mouthDirection, 0.06), mouthQuaternion);

  // A chrome repair coupling, bolted around the tube just behind the mouth, so
  // the splash end reads as maintained hardware rather than a smooth toy.
  {
    const clampT = 1 - 1.6 / tubeLength;
    const clampPoint = curve.getPointAt(clampT);
    const clampTangent = curve.getTangentAt(clampT).normalize();
    const axial = new Quaternion().setFromUnitVectors(UP, clampTangent);
    const sleeve = new CylinderGeometry(tubeRadius + 0.045, tubeRadius + 0.045, 0.16, 40, 1, true);
    chrome.addTransformed(sleeve, clampPoint, axial);
    for (const side of [-1, 1] as const) {
      const edge = new TorusGeometry(tubeRadius + 0.048, 0.032, 8, 48);
      const edgeQuaternion = new Quaternion().setFromUnitVectors(FORWARD, clampTangent);
      chrome.addTransformed(edge, clampPoint.clone().addScaledVector(clampTangent, side * 0.08), edgeQuaternion);
    }
    const baseX = new Vector3().crossVectors(clampTangent, UP).normalize();
    if (baseX.lengthSq() < 1e-4) baseX.set(1, 0, 0);
    const baseY = new Vector3().crossVectors(clampTangent, baseX).normalize();
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const radial = baseX.clone().multiplyScalar(Math.cos(angle)).addScaledVector(baseY, Math.sin(angle));
      const bolt = new CylinderGeometry(0.021, 0.021, 0.03, 8);
      const boltQuaternion = new Quaternion().setFromUnitVectors(UP, radial);
      chrome.addTransformed(
        bolt,
        clampPoint.clone().addScaledVector(radial, tubeRadius + 0.05),
        boltQuaternion,
      );
    }
  }

  const pvcMesh = pvcBatch.build(pvcMaterial, 'slide.flume', group);
  if (pvcMesh) pvcMesh.castShadow = true;

  const linerMaterial = createFlumeLinerMaterial(materials.redPlastic);
  const liner = new Mesh(new TubeGeometry(curve, 220, tubeRadius - 0.055, 22, false), linerMaterial);
  liner.name = 'slide.liner';
  liner.castShadow = false;
  group.add(liner);

  // ---- Tower, platform, funnel --------------------------------------------
  const towerTop = S.platformY - 0.1;
  const lowerTower = new CylinderGeometry(0.4, 0.62, -LAYOUT.water.floor, 26, 1, false);
  lowerTower.translate(S.tower.x, LAYOUT.water.floor / 2, S.tower.z);
  applyCylindricalUVs(lowerTower, S.tower.x, S.tower.z, 0.5);
  addStaticMesh(group, lowerTower, materials.tileUnderwater, 'slide.tower.submerged');
  const upperTower = new CylinderGeometry(0.4, 0.58, towerTop, 26, 1, false);
  upperTower.translate(S.tower.x, towerTop / 2, S.tower.z);
  applyCylindricalUVs(upperTower, S.tower.x, S.tower.z, 0.5);
  addStaticMesh(group, upperTower, materials.tileWall, 'slide.tower');

  const towerBase = new CylinderGeometry(0.85, 0.95, 0.32, 24, 1, false);
  towerBase.translate(S.tower.x, LAYOUT.water.floor + 0.16, S.tower.z);
  applyWorldUVs(towerBase);
  addStaticMesh(group, towerBase, materials.concrete, 'slide.tower.base');

  // The funnel sits just outside the spiral's first point so the chute is
  // continuous; the platform is a red disc with a skirt below.
  const funnelAngle = Math.PI * 0.38;
  const funnelRadius = 1.15;
  const funnelPosition = new Vector3(
    S.tower.x + Math.cos(funnelAngle) * funnelRadius,
    S.platformY - 0.33,
    S.tower.z + Math.sin(funnelAngle) * funnelRadius,
  );
  const platformBatch = new GeometryBatch();
  const platform = new CylinderGeometry(1.45, 1.36, 0.16, 44);
  platformBatch.addTransformed(platform, new Vector3(S.tower.x, S.platformY, S.tower.z));
  const skirt = new CylinderGeometry(1.12, 0.8, 0.58, 36, 1, true);
  platformBatch.addTransformed(skirt, new Vector3(S.tower.x, S.platformY - 0.35, S.tower.z));
  const funnel = new CylinderGeometry(1.05, tubeRadius + 0.02, 0.95, 44, 1, true);
  platformBatch.addTransformed(funnel, funnelPosition.clone().setY(S.platformY + 0.14));
  const platformMesh = platformBatch.build(pvcMaterial, 'slide.platform', group);
  if (platformMesh) platformMesh.castShadow = true;

  // Platform guard rail with an opening facing the funnel.
  const railRadius = 1.32;
  const railArc = Math.PI * 0.92;
  const railStart = railArc * 0.5 + Math.PI - funnelAngle;
  const railGeometry = new TorusGeometry(railRadius, 0.026, 8, 64, railArc);
  railGeometry.rotateX(Math.PI / 2);
  railGeometry.rotateY(railStart);
  chrome.addTransformed(railGeometry, new Vector3(S.tower.x, S.platformY + 0.92, S.tower.z));
  const railPosts = 6;
  for (let i = 0; i < railPosts; i++) {
    const worldAngle = -railStart + (railArc * i) / (railPosts - 1);
    const x = S.tower.x + Math.cos(worldAngle) * railRadius;
    const z = S.tower.z + Math.sin(worldAngle) * railRadius;
    chrome.addRod(new Vector3(x, S.platformY + 0.02, z), new Vector3(x, S.platformY + 0.92, z), 0.02, 8);
  }

  // Chrome collars + struts tying the corkscrew to the tower.
  for (const t of [0.28, 0.5, 0.72]) {
    const point = curve.getPointAt(t);
    const radial = new Vector3(point.x - S.tower.x, 0, point.z - S.tower.z);
    if (radial.lengthSq() < 1e-4) continue;
    radial.normalize();
    const collarY = clamp(point.y - 0.75, 0.4, towerTop - 0.2);
    const collar = new TorusGeometry(0.54, 0.035, 8, 36);
    collar.rotateX(Math.PI / 2);
    chrome.addTransformed(collar, new Vector3(S.tower.x, collarY, S.tower.z));
    const anchor = new Vector3(S.tower.x + radial.x * 0.52, collarY, S.tower.z + radial.z * 0.52);
    chrome.addRod(anchor, point, 0.048, 10);
    chrome.addRod(
      new Vector3(S.tower.x + radial.x * 0.52, collarY - 0.62, S.tower.z + radial.z * 0.52),
      new Vector3(point.x, point.y - 0.42, point.z),
      0.036,
      8,
    );
    const clampRing = new TorusGeometry(tubeRadius + 0.035, 0.035, 8, 48);
    const clampQuaternion = new Quaternion().setFromUnitVectors(FORWARD, curve.getTangentAt(t).normalize());
    chrome.addTransformed(clampRing, point, clampQuaternion);
  }

  return { group, causticTargets: [pvcMaterial, linerMaterial] };
}

// ---------------------------------------------------------------------------
// Railings and ladders
// ---------------------------------------------------------------------------

function buildRailings(chrome: GeometryBatch): Group {
  const group = new Group();
  group.name = 'railings';
  const deckY = LAYOUT.hall.deck;
  const top = LAYOUT.railings.topY;
  const zMin = -27.6;
  const zMax = 27.6;
  for (const side of [-1, 1] as const) {
    const x = side * LAYOUT.railings.x;
    const spans = railingSpans(zMin, zMax, LAYOUT.ladders.z, 0.68);
    for (const span of spans) {
      chrome.addRod(new Vector3(x, top, span.from), new Vector3(x, top, span.to), 0.031, 12);
      chrome.addRod(new Vector3(x, top - 0.38, span.from), new Vector3(x, top - 0.38, span.to), 0.019, 8);
      for (const z of postPositions(span, 2.6)) {
        chrome.addRod(new Vector3(x, deckY, z), new Vector3(x, top, z), 0.023, 8);
        const flange = new CylinderGeometry(0.058, 0.065, 0.024, 12);
        chrome.addTransformed(flange, new Vector3(x, deckY + 0.012, z));
      }
      // Turned-down end posts so every rail span terminates on the deck.
      for (const z of [span.from, span.to]) {
        const endCap = new CylinderGeometry(0.033, 0.033, 0.035, 12);
        chrome.addTransformed(endCap, new Vector3(x, top, z));
      }
    }
  }
  return group;
}

function buildLadders(chrome: GeometryBatch): Group {
  const group = new Group();
  group.name = 'ladders';
  const deckY = LAYOUT.hall.deck;
  // The ladder handrails rise just above the guard rail and land on the coping,
  // so each ladder reads as a bay in the rail instead of intersecting it.
  const handleY = 1.56;
  for (const side of [-1, 1] as const) {
    const x = side * (LAYOUT.ladders.x + 0.03);
    const handleX = side * (LAYOUT.railings.x - 0.04);
    for (const z of LAYOUT.ladders.z) {
      for (const dz of [-0.28, 0.28]) {
        // Rails enter the water and stop a metre under the surface.
        chrome.addRod(new Vector3(x, -1.02, z + dz), new Vector3(x, 1.42, z + dz), 0.031, 10);
        // Grab handle: up, over the coping, then down onto a deck flange.
        chrome.addRod(new Vector3(x, 1.42, z + dz), new Vector3(handleX, handleY, z + dz), 0.029, 10);
        chrome.addRod(new Vector3(handleX, handleY, z + dz), new Vector3(handleX, deckY, z + dz), 0.027, 8);
        const elbow = new CylinderGeometry(0.036, 0.036, 0.05, 12);
        chrome.addTransformed(elbow, new Vector3(x, 1.42, z + dz), new Quaternion().setFromUnitVectors(UP, new Vector3(0, 0, 1)));
        const flange = new CylinderGeometry(0.06, 0.07, 0.026, 12);
        chrome.addTransformed(flange, new Vector3(handleX, deckY + 0.013, z + dz));
      }
      for (let i = 0; i < 6; i++) {
        const y = -0.9 + i * 0.3;
        chrome.addRod(new Vector3(x, y, z - 0.28), new Vector3(x, y, z + 0.28), 0.024, 8);
      }
      const plate = new CylinderGeometry(0.11, 0.13, 0.02, 12);
      chrome.addTransformed(plate, new Vector3(x + side * 0.06, deckY + 0.01, z));
    }
  }
  return group;
}

// ---------------------------------------------------------------------------
// Inflatable rings
// ---------------------------------------------------------------------------

interface FloatingRing {
  group: Group;
  phase: number;
  tube: number;
  flatten: number;
}

function buildRing(
  materials: MaterialLibrary,
  config: (typeof LAYOUT.rings)[number],
): FloatingRing {
  const group = new Group();
  group.name = `ring.${config.id}`;
  const flatten = 0.58;
  const radius = config.radius;
  const tube = config.tube;
  const isRed = config.id === 'red';

  const print = createRingPrintTexture(config.color, isRed ? 0xf2efe4 : 0xf4f1e6, Math.round(config.phase * 1000) + 31);
  const material = materials.vinyl[config.id as 'red' | 'yellow' | 'blue']!.clone();
  material.name = `vinyl.${config.id}.printed`;
  material.map = print;
  material.color = new Color(0xffffff);
  material.roughness = 0.3;
  material.clearcoat = 0.8;
  material.clearcoatRoughness = 0.14;

  const torus = new TorusGeometry(radius, tube, 22, 104);
  torus.rotateX(Math.PI / 2);
  torus.scale(1, flatten, 1);
  const ringMesh = new Mesh(torus, material);
  ringMesh.name = `ring.${config.id}.body`;
  ringMesh.castShadow = true;
  ringMesh.receiveShadow = true;
  group.add(ringMesh);

  // Moulded seams along the outer and inner equators, plus the rubber valve
  // patch and cap slot. Per-ring so they bob with the body.
  const seams = new GeometryBatch();
  for (const seamRadius of [radius + tube, radius - tube]) {
    const seam = new TorusGeometry(seamRadius, 0.0055, 6, 104);
    seam.rotateX(Math.PI / 2);
    seams.add(seam);
  }
  // The valve sits on the crown of the tube (radius = ring radius), where the
  // surface is flattest, so the patch ring and base cannot float or clip.
  const valveAngle = config.phase * 1.7 + 0.6;
  const valveX = Math.cos(valveAngle) * radius;
  const valveZ = Math.sin(valveAngle) * radius;
  const crown = tube * flatten;
  const patch = new TorusGeometry(0.078, 0.014, 8, 40);
  patch.rotateX(Math.PI / 2);
  seams.addTransformed(patch, new Vector3(valveX, crown - 0.005, valveZ));
  seams.build(
    new MeshStandardMaterial({ name: 'vinyl.seam', color: 0x55504a, roughness: 0.56, metalness: 0.02 }),
    `ring.${config.id}.seams`,
    group,
  );

  const valves = new GeometryBatch();
  const base = new CylinderGeometry(0.058, 0.064, 0.014, 20);
  valves.addTransformed(base, new Vector3(valveX, crown + 0.004, valveZ));
  const stem = new CylinderGeometry(0.03, 0.034, 0.038, 16);
  valves.addTransformed(stem, new Vector3(valveX, crown + 0.028, valveZ));
  const cap = new CylinderGeometry(0.043, 0.043, 0.02, 20);
  valves.addTransformed(cap, new Vector3(valveX, crown + 0.056, valveZ));
  valves.build(materials.whitePlastic.clone(), `ring.${config.id}.valve`, group);
  // Screw slot in the cap, dark rubber so it reads as a moulded part.
  const slotBatch = new GeometryBatch();
  const slot = new BoxGeometry(0.042, 0.004, 0.009);
  slotBatch.addTransformed(
    slot,
    new Vector3(valveX, crown + 0.067, valveZ),
    new Quaternion().setFromAxisAngle(UP, valveAngle + 0.5),
  );
  slotBatch.build(
    new MeshStandardMaterial({ name: 'vinyl.slot', color: 0x2c2926, roughness: 0.6, metalness: 0.02 }),
    `ring.${config.id}.slot`,
    group,
  );

  group.position.set(config.position.x, 0, config.position.z);
  const initial = ringFloatPose(0, config.phase, tube, flatten);
  group.position.y = initial.y;
  group.rotation.y = initial.yaw;
  group.rotation.z = initial.tilt;
  return { group, phase: config.phase, tube, flatten };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildProps(scene: Scene, materials: MaterialLibrary): PropsSystem {
  const group = new Group();
  group.name = 'props';

  const grime = createFlumeGrimeTexture();
  const chrome = new GeometryBatch();

  const flume = buildFlume(materials, grime, chrome);
  group.add(flume.group);
  group.add(buildRailings(chrome));
  group.add(buildLadders(chrome));
  chrome.build(materials.chrome, 'props.chrome', group);

  const rings = LAYOUT.rings.map((config) => buildRing(materials, config));
  for (const ring of rings) group.add(ring.group);

  scene.add(group);

  return {
    group,
    causticTargets: flume.causticTargets,
    update(time: number) {
      for (const ring of rings) {
        const pose = ringFloatPose(time, ring.phase, ring.tube, ring.flatten);
        ring.group.position.y = pose.y;
        ring.group.rotation.y = pose.yaw;
        ring.group.rotation.z = pose.tilt;
      }
    },
  };
}

