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

export interface Lighting {
  sun: DirectionalLight;
  skylight: RectAreaLight;
  pointLights: PointLight[];
  environment: Texture | null;
  update(time: number): void;
  freezeShadows(): void;
}

export interface LightingOptions {
  scene: Scene;
  renderer: WebGLRenderer;
  quality: number;
}

/**
 * Capture the real room into an IBL probe before the water is built. This is a
 * one-time bake: the emissive skylight, windows and lit tile now drive every
 * specular response in the scene, including the chrome and the water reflection.
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

export function buildLighting(options: LightingOptions): Lighting {
  const { scene, renderer, quality } = options;
  RectAreaLightUniformsLib.init();

  scene.fog = new FogExp2(new Color(0x93a9ac), 0.0105);
  scene.background = new Color(0x060b0c);

  const hemisphere = new HemisphereLight(0xdde9ea, 0x1b2724, 0.55);
  scene.add(hemisphere);

  // The sun is deliberately a little oblique: long soft bars of light rather
  // than a single theatrical shaft.
  const sun = new DirectionalLight(0xf2ead7, 3.8);
  sun.position.set(-11, 27, -7);
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

  const skylight = new RectAreaLight(0xd9e8ef, 3.4, 3.7, 44);
  skylight.position.set(0, 8.9, 2.5);
  skylight.rotation.x = Math.PI / 2;
  scene.add(skylight);

  // Window spill cards: no shadows, but they put the cold window sheen on the
  // glaze and the water at the correct grazing angles.
  for (const side of [-1, 1] as const) {
    for (const z of [-15.5, -4.5, 8.5, 18.5]) {
      const light = new RectAreaLight(0xdce9f0, 1.25, 1.2, 1.9);
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

  const corridorLight = new PointLight(0xffab61, 55, 24, 2);
  corridorLight.position.set(LAYOUT.floodLight.position.x, 2.8, 32.5);
  scene.add(corridorLight);

  let environment: Texture | null = null;
  if (quality >= 0.55) {
    environment = bakeRoomEnvironment(scene, renderer, quality >= 0.9 ? 256 : 128);
  }
  if (!environment) environment = fallbackEnvironment(renderer);
  scene.environment = environment;
  scene.environmentIntensity = 1.0;

  const baseIntensities = pointLights.map((light) => light.intensity);
  let frozen = false;

  return {
    sun,
    skylight,
    pointLights,
    environment,
    update(time: number) {
      // One tired ballast at the far end of the hall. Barely there, on purpose.
      const flicker = Math.sin(time * 7.1) * 0.5 + Math.sin(time * 13.7 + 1.3) * 0.3;
      const far = pointLights[pointLights.length - 1];
      if (far) far.intensity = baseIntensities[baseIntensities.length - 1]! * (0.88 + 0.12 * Math.max(0, flicker));
    },
    freezeShadows() {
      if (frozen) return;
      frozen = true;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
    },
  };
}
