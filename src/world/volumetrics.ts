import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  Points,
  ShaderMaterial,
  type Scene,
} from 'three';
import { LAYOUT } from './layout';
import { Rng } from '../core/rng';

/**
 * Restrained volumetric light. The hall is sealed by geometry, so instead of a
 * full-screen ray-march (which would need a depth prepass and a post-pipeline
 * change) the shafts are soft additive volumetric cards seated under the
 * skylight aperture. They depth-test against the opaque scene, fade when seen
 * edge-on, and never write depth. Dust motes are one additive Points cloud whose
 * drift is evaluated in the shader from the scene clock, so `renderAt(t)` is
 * deterministic and per-frame CPU cost is zero. All cards share one merged
 * geometry and material: the whole system is two draw calls.
 */

const SHAFT_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute float aIntensity;
  attribute vec3 aColor;
  varying vec2 vUv;
  varying vec3 vWorld;
  varying float vSeed;
  varying float vIntensity;
  varying vec3 vColor;
  void main() {
    vUv = uv;
    vSeed = aSeed;
    vIntensity = aIntensity;
    vColor = aColor;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SHAFT_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vWorld;
  varying float vSeed;
  varying float vIntensity;
  varying vec3 vColor;

  // Cheap value noise; deterministic and smooth at these frequencies.
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  void main() {
    // Parabolic falloff over the whole width, plus a slow lateral wobble, so the
    // card boundary is never a straight line even when seen broadside.
    float wobble = sin(vUv.y * 9.0 + vSeed * 3.1) * 0.035 + sin(vUv.y * 23.0 + vSeed) * 0.012;
    float acrossCoord = abs(vUv.x - 0.5 + wobble) * 2.0;
    float across = pow(max(0.0, 1.0 - acrossCoord), 1.9);
    // Taper the shaft toward the water so its bottom edge dies out.
    float along = smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.72, vUv.y);
    // Cards are world-Z aligned; fade them out when seen edge-on so they never
    // read as flat sheets from a side camera.
    vec3 toCamera = cameraPosition - vWorld;
    float viewLength = max(length(toCamera), 1e-4);
    float edgeOn = smoothstep(0.02, 0.42, abs(dot(toCamera / viewLength, vec3(0.0, 0.0, 1.0))));
    float streaks = 0.62 + 0.38 * noise(vec2(vUv.x * 5.0 + vSeed, vWorld.y * 1.7 - uTime * 0.035));
    // Clamp every pow() base and the final radiance: interpolated UVs at the
    // card border can be an ulp outside [0,1], and pow(negative, y) is NaN. NaN
    // in an additive blend comes out black, which is exactly the hard 1 px
    // dashed stroke this shader used to paint along each card edge.
    float lift = mix(0.22, 1.0, pow(clamp(vUv.y, 0.0, 1.0), 0.8));
    float body = max(across * along * streaks * edgeOn * lift, 0.0);
    gl_FragColor = vec4(max(vColor, vec3(0.0)) * vIntensity * body, 1.0);
  }
`;

const DUST_VERTEX = /* glsl */ `
  attribute float aPhase;
  attribute float aSpeed;
  attribute float aSize;
  uniform float uTime;
  uniform float uPixelRatio;
  varying float vFade;
  void main() {
    vec3 p = position;
    // Slow deterministic drift; wraps inside the shaft volume.
    p.y = mod(p.y + uTime * aSpeed * 0.05, 9.2) + 0.2;
    p.x += sin(uTime * 0.11 + aPhase) * 0.16;
    p.z += cos(uTime * 0.09 + aPhase * 1.7) * 0.2;
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    // Motes swell a little near the skylight so looking up reads as dust in the beam.
    gl_PointSize = min(2.6, aSize * uPixelRatio * (4.2 / max(-mv.z, 1.0))) * (0.7 + 0.8 * smoothstep(4.5, 9.0, position.y));
    vFade = smoothstep(0.6, 2.0, -mv.z) * (1.0 - smoothstep(7.0, 17.0, -mv.z));
  }
`;

const DUST_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uIntensity;
  varying float vFade;
  void main() {
    vec2 centered = gl_PointCoord - 0.5;
    float d = length(centered);
    float alpha = smoothstep(0.5, 0.05, d);
    if (alpha <= 0.001) discard;
    gl_FragColor = vec4(uColor * uIntensity * alpha * vFade, 1.0);
  }
`;

export interface Volumetrics {
  group: Group;
  update(time: number): void;
  dispose(): void;
}

export interface VolumetricOptions {
  scene: Scene;
  /** Overall shaft gain, art-directed rather than physical. */
  intensity?: number;
  seed?: string | number;
}

interface Card {
  center: [number, number, number];
  width: number;
  height: number;
  tilt: number;
  seed: number;
  intensity: number;
  color: Color;
}

function buildCards(cards: Card[]): { geometry: BufferGeometry; material: ShaderMaterial } {
  const vertices: number[] = [];
  const uvs: number[] = [];
  const seeds: number[] = [];
  const intensities: number[] = [];
  const colors: number[] = [];
  for (const card of cards) {
    const cos = Math.cos(card.tilt);
    const sin = Math.sin(card.tilt);
    const halfWidth = card.width / 2;
    const halfHeight = card.height / 2;
    const corners: Array<[number, number, number, number]> = [
      [-halfWidth, -halfHeight, 0, 0],
      [halfWidth, -halfHeight, 1, 0],
      [halfWidth, halfHeight, 1, 1],
      [-halfWidth, halfHeight, 0, 1],
    ];
    for (const [x, y, u, v] of corners) {
      // Tilt in the XY plane, then translate into world space.
      vertices.push(card.center[0] + x * cos - y * sin, card.center[1] + x * sin + y * cos, card.center[2]);
      uvs.push(u, v);
      seeds.push(card.seed);
      intensities.push(card.intensity);
      colors.push(card.color.r, card.color.g, card.color.b);
    }
  }
  const indices: number[] = [];
  for (let i = 0; i < cards.length; i++) {
    const base = i * 4;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setAttribute('aSeed', new BufferAttribute(new Float32Array(seeds), 1));
  geometry.setAttribute('aIntensity', new BufferAttribute(new Float32Array(intensities), 1));
  geometry.setAttribute('aColor', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);

  const material = new ShaderMaterial({
    name: 'volumetric-shafts',
    vertexShader: SHAFT_VERTEX,
    fragmentShader: SHAFT_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
  });
  return { geometry, material };
}

export function buildVolumetrics(options: VolumetricOptions): Volumetrics {
  const { scene } = options;
  const intensity = options.intensity ?? 1;
  const rng = new Rng(options.seed ?? 'volumetrics');
  const group = new Group();
  group.name = 'volumetrics';
  scene.add(group);

  const cool = new Color(0xdfeef2);
  const warm = new Color(0xffb26b);
  const floorY = LAYOUT.hall.deck;
  const ceilingY = LAYOUT.hall.ceiling;
  const height = ceilingY - floorY + 1.6;
  // The sun sits at x = -12.5, y = 27, z = -14, so the beams leave the aperture
  // and land ~4.3 m toward +X. Tilt the cards along that ray and centre them at
  // the midpoint between the aperture and the water, so the shafts agree with the
  // sun bars that the shadow map actually casts.
  const sunLean = Math.atan2(12.5, 27);
  const beamCenterX = 2.1;
  const cards: Card[] = [];

  // Skylight shafts, one per structural bay, tilted with the oblique sun.
  let index = 0;
  for (let z = LAYOUT.skylight.zMin + 2; z <= LAYOUT.skylight.zMax - 1; z += 5.2) {
    cards.push({
      center: [beamCenterX + rng.range(-0.25, 0.25), (ceilingY + floorY) / 2 + 0.4, z],
      width: 0.7 + rng.range(-0.08, 0.12),
      height,
      tilt: sunLean,
      seed: index * 1.37,
      intensity: (0.026 + rng.range(0, 0.010)) * intensity,
      color: cool,
    });
    index += 1;
  }
  // Warm corridor haze: two layers so the arch reads as depth, not a card.
  cards.push({
    center: [0, 2.7, LAYOUT.hall.zMax + 2.2],
    width: 5.1,
    height: 5.4,
    tilt: 0,
    seed: 3.1,
    intensity: 0.06 * intensity,
    color: warm,
  });
  cards.push({
    center: [0, 2.7, LAYOUT.hall.zMax + 4.6],
    width: 7.5,
    height: 5.4,
    tilt: 0,
    seed: 5.7,
    intensity: 0.02 * intensity,
    color: warm,
  });

  const { geometry, material } = buildCards(cards);
  const shafts = new Mesh(geometry, material);
  shafts.name = 'volumetrics.shafts';
  shafts.renderOrder = 5;
  shafts.frustumCulled = false;
  group.add(shafts);

  // ---- Dust motes ---------------------------------------------------------
  const dustCount = 760;
  const positions = new Float32Array(dustCount * 3);
  const phases = new Float32Array(dustCount);
  const speeds = new Float32Array(dustCount);
  const sizes = new Float32Array(dustCount);
  for (let i = 0; i < dustCount; i++) {
    // Concentrate motes under the skylight volume, a few in the corridor haze.
    const corridor = rng.bool(0.12);
    const x = corridor ? rng.range(-1.4, 1.4) : rng.range(-1.9, 1.9);
    const y = rng.bool(0.55) ? rng.range(4.6, 9.4) : rng.range(0.2, 4.6);
    const z = corridor
      ? rng.range(LAYOUT.hall.zMax + 0.6, LAYOUT.hall.zMax + 5)
      : rng.range(LAYOUT.skylight.zMin, LAYOUT.skylight.zMax);
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    phases[i] = rng.range(0, Math.PI * 2);
    speeds[i] = rng.range(0.5, 1.6);
    sizes[i] = rng.range(0.5, 1.7);
  }
  const dustGeometry = new BufferGeometry();
  dustGeometry.setAttribute('position', new BufferAttribute(positions, 3));
  dustGeometry.setAttribute('aPhase', new BufferAttribute(phases, 1));
  dustGeometry.setAttribute('aSpeed', new BufferAttribute(speeds, 1));
  dustGeometry.setAttribute('aSize', new BufferAttribute(sizes, 1));
  const dustMaterial = new ShaderMaterial({
    name: 'volumetric-dust',
    vertexShader: DUST_VERTEX,
    fragmentShader: DUST_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new Color(0xf2f6f4) },
      uIntensity: { value: 0.16 * intensity },
      uPixelRatio: { value: 1 },
    },
  });
  const dust = new Points(dustGeometry, dustMaterial);
  dust.name = 'volumetrics.dust';
  dust.renderOrder = 6;
  dust.frustumCulled = false;
  group.add(dust);

  return {
    group,
    update(time) {
      material.uniforms.uTime!.value = time;
      dustMaterial.uniforms.uTime!.value = time;
    },
    dispose() {
      scene.remove(group);
      geometry.dispose();
      material.dispose();
      dustGeometry.dispose();
      dustMaterial.dispose();
    },
  };
}
