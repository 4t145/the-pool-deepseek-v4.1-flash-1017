import {
  BackSide,
  BoxGeometry,
  Color,
  CubeCamera,
  DirectionalLight,
  FogExp2,
  HalfFloatType,
  HemisphereLight,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  PMREMGenerator,
  RectAreaLight,
  Scene,
  WebGLCubeRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { LAYOUT } from './layout';
import { bakeLighting, type BakeStats, type BakedLighting, type PointLightSample } from './lightBake';
import { buildVolumetrics, type Volumetrics } from './volumetrics';

export interface Lighting {
  sun: DirectionalLight;
  skylight: RectAreaLight;
  pointLights: PointLight[];
  environment: Texture | null;
  probes: BakedLighting | null;
  volumetrics: Volumetrics | null;
  bakeStats: BakeStats | null;
  update(time: number): void;
  freezeShadows(): void;
}

export interface LightingOptions {
  scene: Scene;
  renderer: WebGLRenderer;
  quality: number;
}

const SUN_DIRECTION = [-12.5, 27, -14] as const;

/**
 * Capture the real room into an IBL probe before the water is built. This is a
 * one-time bake: the emissive skylight, windows and lit tile now drive every
 * specular response in the scene, including the chrome and the water reflection.
 * Diffuse bounce comes from the separate probe-grid bake; the IBL is kept mostly
 * for specular and a small residual diffuse.
 */
function bakeRoomEnvironment(scene: Scene, renderer: WebGLRenderer, cubeSize: number): Texture | null {
  const target = new WebGLCubeRenderTarget(cubeSize, {
    type: HalfFloatType,
    colorSpace: LinearSRGBColorSpace,
    generateMipmaps: false,
  });
  const camera = new CubeCamera(0.1, 80, target);
  camera.position.set(0, 2.4, 0);
  scene.add(camera);
  const previousTarget = renderer.getRenderTarget();
  const previousAutoClear = renderer.autoClear;
  renderer.autoClear = true;
  try {
    camera.update(renderer, scene);
    const pmrem = new PMREMGenerator(renderer);
    pmrem.compileCubemapShader();
    const env = pmrem.fromCubemap(target.texture).texture;
    env.name = 'pool.environment';
    pmrem.dispose();
    return env;
  } catch (error) {
    console.warn('Environment bake failed; falling back to analytic lighting.', error);
    return null;
  } finally {
    scene.remove(camera);
    target.dispose();
    camera.children.forEach((child) => {
      if ((child as Mesh).isMesh) {
        (child as Mesh).geometry.dispose();
        const material = (child as Mesh).material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    });
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
  }
}

/** A small fallback IBL: cool sky above, warm tile bounce below. */
function fallbackEnvironment(renderer: WebGLRenderer): Texture {
  const envScene = new Scene();
  envScene.background = new Color(0x10191a);
  const shell = new Mesh(
    new BoxGeometry(26, 14, 70),
    new MeshBasicMaterial({ color: 0x2c3b3a, side: BackSide, toneMapped: false }),
  );
  envScene.add(shell);
  const sky = new Mesh(
    new PlaneGeometry(3.8, 45),
    new MeshBasicMaterial({ color: new Color(0xf2f8ff).multiplyScalar(2.4), side: BackSide, toneMapped: false }),
  );
  sky.rotation.x = Math.PI / 2;
  sky.position.set(0, 6.8, 0);
  envScene.add(sky);
  const pmrem = new PMREMGenerator(renderer);
  const env = pmrem.fromScene(envScene, 0.03).texture;
  env.name = 'pool.environment.fallback';
  pmrem.dispose();
  envScene.traverse((object) => {
    if ((object as Mesh).isMesh) {
      const mesh = object as Mesh;
      mesh.geometry.dispose();
      (mesh.material as MeshBasicMaterial).dispose();
    }
  });
  return env;
}

/**
 * The baked probe grid now supplies the room's directional diffuse bounce, so
 * the IBL's own diffuse contribution would double-count it. Keep the env map
 * (chrome needs the window/skylight reflections) but attenuate it on dielectric
 * materials only; metals keep their authored response.
 */
function attenuateDielectricIbl(scene: Scene, factor: number): void {
  const patched = new Set<MeshStandardMaterial>();
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material;
    if (Array.isArray(material)) return;
    if (!(material instanceof MeshStandardMaterial) && !(material instanceof MeshPhysicalMaterial)) return;
    if (patched.has(material)) return;
    patched.add(material);
    if (material.metalness > 0.6) return;
    material.envMapIntensity *= factor;
    material.needsUpdate = true;
  });
}

export function buildLighting(options: LightingOptions): Lighting {
  const { scene, renderer, quality } = options;
  RectAreaLightUniformsLib.init();

  // A darker, cooler haze keeps depth without bleaching the warm far arch.
  scene.fog = new FogExp2(new Color(0x74898d), 0.0088);
  scene.background = new Color(0x060b0c);

  // Residual fill only: the probe grid owns the real bounce.
  const hemisphere = new HemisphereLight(0xd6e6e8, 0x1b2724, 0.14);
  scene.add(hemisphere);

  // The sun is deliberately a little oblique: long soft bars of light rather
  // than a single theatrical shaft.
  const sun = new DirectionalLight(0xf2ead7, 3.8);
  sun.position.set(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2]);
  sun.target.position.set(1.5, 0, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality >= 0.9 ? 4096 : 2048, quality >= 0.9 ? 4096 : 2048);
  sun.shadow.camera.left = -24;
  sun.shadow.camera.right = 24;
  sun.shadow.camera.top = 34;
  sun.shadow.camera.bottom = -34;
  sun.shadow.camera.near = 4;
  sun.shadow.camera.far = 70;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.035;
  sun.shadow.radius = 2.2;
  scene.add(sun);
  scene.add(sun.target);
  const sunDirection = sun.position.clone().sub(sun.target.position).normalize();

  // The skylight still needs an analytic light for a soft specular sheen on the
  // water and the glaze; its diffuse contribution now comes from the bake, so it
  // is kept low to avoid double counting.
  const skylight = new RectAreaLight(0xd9e8ef, 0.85, 3.7, 44);
  skylight.position.set(0, 8.9, 2.5);
  skylight.rotation.x = Math.PI / 2;
  scene.add(skylight);

  // Window spill cards: no shadows, but they put the cold window sheen on the
  // glaze and the water at the correct grazing angles.
  for (const side of [-1, 1] as const) {
    for (const z of [-15.5, -4.5, 8.5, 18.5]) {
      const light = new RectAreaLight(0xdce9f0, 0.3, 1.2, 1.9);
      light.position.set(side * 7.95, 5.65, z);
      light.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      scene.add(light);
    }
  }

  const pointLights: PointLight[] = [];
  for (const side of [-1, 1] as const) {
    for (const z of [-16, -1, 14]) {
      const light = new PointLight(0xd8e9f2, 13, 19, 2);
      light.position.set(side * 5.35, 7.25, z);
      scene.add(light);
      pointLights.push(light);
    }
  }

  // One warm lamp deep inside the corridor: it lights the tiled side walls so the
  // arch reads as a lit space, while the doorway plane supplies the warm depth.
  const corridorLight = new PointLight(0xff9a4d, 46, 26, 2);
  corridorLight.position.set(LAYOUT.floodLight.position.x, 2.6, LAYOUT.hall.zMax + 4.6);
  scene.add(corridorLight);
  pointLights.push(corridorLight);

  let environment: Texture | null = null;
  if (quality >= 0.55) {
    environment = bakeRoomEnvironment(scene, renderer, quality >= 0.9 ? 256 : 128);
  }
  if (!environment) environment = fallbackEnvironment(renderer);
  scene.environment = environment;
  scene.environmentIntensity = 0.8;

  // ---- Real static indirect: ray-traced SH probe grid ---------------------
  const pointLightSamples: PointLightSample[] = pointLights.map((light) => ({
    position: light.position.clone(),
    color: light.color.clone(),
    intensity: light.intensity,
    distance: light.distance,
    decay: light.decay,
  }));
  let probes: BakedLighting | null = null;
  try {
    probes = bakeLighting({
      scene,
      quality,
      sunDirection,
      sunColor: sun.color.clone(),
      sunIntensity: sun.intensity,
      pointLights: pointLightSamples,
      bounceCount: quality >= 0.85 ? 3 : 2,
      aoAccentRadius: 0.3,
      aoAccentStrength: quality >= 0.85 ? 0.4 : 0.3,
      seed: 0x51ff,
    });
    scene.add(probes.volume);
    attenuateDielectricIbl(scene, 0.42);
    const stats = probes.stats;
    console.info(
      `[pool] probe bake: ${stats.probes} probes ${stats.gridDims.join('x')}, N=${stats.samplesPerProbe}, ` +
        `${stats.primaryRays} rays + ${stats.shadowRays} shadow, ${stats.bounces} bounces, ` +
        `${stats.triangles} tris/${stats.meshes} meshes, ${stats.milliseconds.toFixed(0)} ms, hits ` + JSON.stringify(stats.emitterHits) + ', samples ' +
        JSON.stringify({
          floor: probes.sampleIrradiance([0, 0.4, 0], [0, 1, 0]).map((v) => Number(v.toFixed(3))),
          ceiling: probes.sampleIrradiance([0, 8.2, 0], [0, -1, 0]).map((v) => Number(v.toFixed(3))),
          corner: probes.sampleIrradiance([-8, 0.4, -28.8], [0.7, 0.7, 0]).map((v) => Number(v.toFixed(3))),
        }),
    );
  } catch (error) {
    console.warn('Probe bake failed; falling back to IBL-only lighting.', error);
  }

  const volumetrics = buildVolumetrics({ scene, intensity: quality >= 0.85 ? 1 : 0.6 });

  const baseIntensities = pointLights.map((light) => light.intensity);
  let frozen = false;

  return {
    sun,
    skylight,
    pointLights,
    environment,
    probes,
    volumetrics,
    bakeStats: probes?.stats ?? null,
    update(time: number) {
      // One tired ballast at the far end of the hall. Barely there, on purpose.
      const flicker = Math.sin(time * 7.1) * 0.5 + Math.sin(time * 13.7 + 1.3) * 0.3;
      const far = pointLights[pointLights.length - 1];
      if (far) far.intensity = baseIntensities[baseIntensities.length - 1]! * (0.88 + 0.12 * Math.max(0, flicker));
      volumetrics.update(time);
    },
    freezeShadows() {
      if (frozen) return;
      frozen = true;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
    },
  };
}
