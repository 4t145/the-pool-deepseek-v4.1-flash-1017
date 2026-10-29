import {
  ClampToEdgeWrapping,
  Color,
  DoubleSide,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Material,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Scene,
  type Texture,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';
import { LAYOUT } from './layout';
import { createNoiseTexture, createWaterNormalTexture } from './textures';
import { MOUTH_WAKE, RING_WAKE, WATER_ETA } from '../core/waterOptics';
import { addShaderHook } from '../core/shaderHooks';

export interface WaterSystem {
  mesh: Mesh;
  material: ShaderMaterial;
  update(time: number, camera: PerspectiveCamera): void;
  /** Opaque scene colour without the water, used as the refraction source. */
  renderRefraction(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera): void;
  renderReflection(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera): void;
  resize(width: number, height: number, scale: number): void;
  setReflectionScale(scale: number): void;
  dispose(): void;
}

export interface UnderwaterCaustics {
  /** Chain a caustic-light term into a lit material without clobbering its other patches. */
  apply(material: Material, options?: { strength?: number; scale?: number }): void;
  update(time: number): void;
}

/**
 * The caustic pattern is evaluated procedurally in world space (no texture, no
 * repeat) by three crossing wave trains; the bright web is where they cancel.
 * Mirrors `causticLattice` in `src/core/waterOptics.ts` — keep constants in sync.
 * Shared by the underwater material patch and the water surface overlay so the
 * two cannot drift.
 */
const CAUSTIC_LATTICE_GLSL = /* glsl */ `
  float poolCausticLattice(vec2 p, float t, float depth) {
    float base = 26.0;
    vec2 d1 = vec2(0.8202, 0.5721);
    vec2 d2 = vec2(-0.4550, 0.8905);
    vec2 d3 = vec2(0.3417, -0.9398);
    float a = sin(dot(p, d1) * base + t * 0.9);
    float b = sin(dot(p, d2) * (base * 0.83) - t * 1.15 + 1.7);
    float c = sin(dot(p, d3) * (base * 1.37) + t * 0.7 + 3.1);
    float web = min(abs(a + b), abs(a + c));
    float depthFactor = clamp(depth / 3.2, 0.0, 1.0);
    float sharp = mix(10.0, 5.0, depthFactor);
    return pow(clamp(1.0 - web * 0.85, 0.0, 1.0), sharp);
  }
`;

const CAUSTIC_GLSL =
  /* glsl */ `
  varying vec3 vPoolCausticWorld;
  varying vec3 vPoolCausticNormal;
  uniform float uCausticTime;
  uniform float uCausticStrength;
  uniform float uCausticScale;
` + CAUSTIC_LATTICE_GLSL;

/**
 * Underwater caustics for the basin tile, steps, lane band and the submerged
 * flume. The caustic light is registered through the shared `addShaderHook`
 * convention (src/core/shaderHooks.ts), so it chains with tile POM, flume
 * staining and any later material patch. The term is added to `outgoingLight`
 * before the opaque fragment, masked to fragments below the water line.
 * Materials are lit in the same pass that the refraction prepass and the planar
 * reflection see, so no extra render target or rebake is needed.
 */
export function buildUnderwaterCaustics(): UnderwaterCaustics {
  const timeUniform = { value: 0 };
  return {
    apply(material, options = {}) {
      const strength = options.strength ?? 0.65;
      const scale = options.scale ?? 1;
      addShaderHook(material, 'caustics', (shader) => {
        shader.uniforms.uCausticTime = timeUniform;
        shader.uniforms.uCausticStrength = { value: strength };
        shader.uniforms.uCausticScale = { value: scale };
        shader.vertexShader =
          'varying vec3 vPoolCausticWorld;\nvarying vec3 vPoolCausticNormal;\n' +
          shader.vertexShader.replace(
            '#include <project_vertex>',
            `#include <project_vertex>
            vPoolCausticWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
            vPoolCausticNormal = normalize( mat3( modelMatrix ) * normal );`,
          );
        shader.fragmentShader =
          `${CAUSTIC_GLSL}\n` +
          shader.fragmentShader.replace(
            '#include <opaque_fragment>',
            `
            {
              float poolUnder = smoothstep( 0.08, -0.10, vPoolCausticWorld.y );
              if ( poolUnder > 0.001 ) {
                float poolDepth = clamp( -vPoolCausticWorld.y, 0.0, 3.4 );
                vec2 poolPoint = vPoolCausticWorld.xz * uCausticScale;
                float poolCaustic = poolCausticLattice( poolPoint, uCausticTime, poolDepth );
                float poolFacing = 0.3 + 0.7 * clamp( vPoolCausticNormal.y, 0.0, 1.0 );
                float poolFalloff = mix( 1.15, 0.35, smoothstep( 0.0, 3.2, poolDepth ) );
                outgoingLight += diffuseColor.rgb * uCausticStrength * poolCaustic * poolUnder * poolFacing * poolFalloff;
              }
            }
            #include <opaque_fragment>`,
          );
      });
    },
    update(time) {
      timeUniform.value = time;
    },
  };
}

const VERTEX = /* glsl */ `
  uniform mat4 uTextureMatrix;
  varying vec4 vReflectCoord;
  varying vec3 vWorld;
  varying vec3 vViewPosition;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vReflectCoord = uTextureMatrix * world;
    vec4 mvPosition = viewMatrix * world;
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;

  #define RING_COUNT 3

  ${CAUSTIC_LATTICE_GLSL}

  uniform vec3 uCausticColor;
  uniform float uCausticStrength;

  uniform sampler2D uReflection;
  uniform sampler2D uScene;
  uniform sampler2D uNormalA;
  uniform sampler2D uNormalB;
  uniform sampler2D uNormalC;
  uniform sampler2D uNoise;
  uniform vec2 uTexel;
  uniform mat4 uSceneViewProjection;
  uniform float uTime;
  uniform vec3 uCameraPos;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uAbsorption;
  uniform vec3 uScatterColor;
  uniform vec3 uDeepColor;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uHalfWidth;
  uniform float uHalfLength;
  uniform float uFloorY;
  uniform vec4 uRingCenters[RING_COUNT];
  uniform float uRingPhases[RING_COUNT];
  uniform vec4 uMouth;
  uniform float uRefractionOn;
  uniform float uReflectionStrength;
  uniform float uFoamStrength;
  uniform float uDistortion;

  varying vec4 vReflectCoord;
  varying vec3 vWorld;
  varying vec3 vViewPosition;

  float saturate(float value) {
    return clamp(value, 0.0, 1.0);
  }

  // Mirrors src/core/waterOptics.ts wakeHeight/wakeSlope (RING_WAKE constants).
  float ringWakeSlope(float d, float t, float phase) {
    float angle = d * ${RING_WAKE.frequency.toFixed(2)} - t * ${RING_WAKE.speed.toFixed(2)} + phase;
    return ${RING_WAKE.amplitude.toFixed(4)} * exp(-d * ${RING_WAKE.decay.toFixed(2)})
      * (${RING_WAKE.frequency.toFixed(2)} * cos(angle) - ${RING_WAKE.decay.toFixed(2)} * sin(angle));
  }

  // Mirrors MOUTH_WAKE: a slower, wider boil where the flume meets the pool.
  float mouthWakeSlope(float d, float t) {
    float angle = d * ${MOUTH_WAKE.frequency.toFixed(2)} - t * ${MOUTH_WAKE.speed.toFixed(2)};
    return ${MOUTH_WAKE.amplitude.toFixed(4)} * exp(-d * ${MOUTH_WAKE.decay.toFixed(2)})
      * (${MOUTH_WAKE.frequency.toFixed(2)} * cos(angle) - ${MOUTH_WAKE.decay.toFixed(2)} * sin(angle));
  }

  // Distance from a point just under the surface to the basin exit, along the
  // refracted ray. The basin box is the dominant underwater occluder, so this is
  // the Beer-Lambert path length without any depth texture.
  float basinExit(vec3 origin, vec3 dir) {
    float best = 48.0;
    if (abs(dir.x) > 1e-5) {
      float tx = ((dir.x > 0.0 ? uHalfWidth : -uHalfWidth) - origin.x) / dir.x;
      if (tx > 0.0) best = min(best, tx);
    }
    if (abs(dir.z) > 1e-5) {
      float tz = ((dir.z > 0.0 ? uHalfLength : -uHalfLength) - origin.z) / dir.z;
      if (tz > 0.0) best = min(best, tz);
    }
    if (dir.y < -1e-5) {
      float ty = (uFloorY - origin.y) / dir.y;
      if (ty > 0.0) best = min(best, ty);
    }
    return best;
  }

  vec2 surfaceSlope(vec2 p) {
    vec3 nA = texture2D(uNormalA, p * 0.17 + vec2(uTime * 0.012, uTime * 0.019)).xyz * 2.0 - 1.0;
    vec3 nB = texture2D(uNormalB, p * 0.39 + vec2(-uTime * 0.021, uTime * 0.013)).xyz * 2.0 - 1.0;
    vec3 nC = texture2D(uNormalC, p * 0.86 + vec2(uTime * 0.031, -uTime * 0.026)).xyz * 2.0 - 1.0;
    return nA.xy * 0.5 + nB.xy * 0.32 + nC.xy * 0.18;
  }

  vec2 wakeGradient(vec2 p) {
    vec2 total = vec2(0.0);
    for (int i = 0; i < RING_COUNT; i++) {
      vec2 delta = p - uRingCenters[i].xy;
      float radius = uRingCenters[i].z;
      float r = max(length(delta), 1e-4);
      float d = max(r - radius, 0.0);
      total += (delta / r) * ringWakeSlope(d, uTime, uRingPhases[i]);
    }
    vec2 mouthDelta = p - uMouth.xy;
    float mouthR = max(length(mouthDelta), 1e-4);
    total += (mouthDelta / mouthR) * mouthWakeSlope(max(mouthR - uMouth.z, 0.0), uTime);
    return total;
  }

  float contactFoam(vec2 p, float noiseValue) {
    float foam = 0.0;
    for (int i = 0; i < RING_COUNT; i++) {
      vec2 delta = p - uRingCenters[i].xy;
      float r = length(delta);
      float radius = uRingCenters[i].z;
      float tube = uRingCenters[i].w;
      float band = 1.0 - smoothstep(tube * 0.55, tube * 1.2 + 0.02, abs(r - radius));
      foam = max(foam, band * (0.32 + 0.68 * noiseValue));
    }
    float mouthR = length(p - uMouth.xy);
    float mouthMask = 1.0 - smoothstep(uMouth.z * 0.35, uMouth.z * 1.05, mouthR);
    foam = max(foam, mouthMask * (0.3 + 0.7 * noiseValue) * uMouth.w);
    return foam;
  }

  vec3 reflectionColor(vec2 uv, float distanceToCamera) {
    // Micro-roughness widens the reflection with distance; fixed taps keep it
    // temporally stable (no jitter, no frame-dependent noise).
    float blur = mix(0.25, 1.25, saturate(distanceToCamera / 46.0));
    vec2 step0 = uTexel * blur;
    vec3 color = texture2D(uReflection, uv).rgb * 0.4;
    color += texture2D(uReflection, uv + vec2(step0.x, 0.0)).rgb * 0.15;
    color += texture2D(uReflection, uv - vec2(step0.x, 0.0)).rgb * 0.15;
    color += texture2D(uReflection, uv + vec2(0.0, step0.y)).rgb * 0.15;
    color += texture2D(uReflection, uv - vec2(0.0, step0.y)).rgb * 0.15;
    return color;
  }

  void main() {
    vec3 toCamera = uCameraPos - vWorld;
    float cameraDistance = length(toCamera);
    vec3 viewDir = toCamera / max(cameraDistance, 1e-4);

    // Looking up from inside the pool: the surface behaves like a dim ceiling.
    if (uCameraPos.y < 0.02) {
      gl_FragColor = vec4(uDeepColor * 0.8, 1.0);
      return;
    }

    vec2 worldUv = vWorld.xz;
    float noiseValue = texture2D(uNoise, worldUv * 0.31 + vec2(uTime * 0.003, uTime * -0.0025)).r;
    float fineNoise = texture2D(uNoise, worldUv * 1.7 + vec2(uTime * -0.011, uTime * 0.008)).r;

    vec2 slope = surfaceSlope(worldUv) * 1.5 + wakeGradient(worldUv);
    vec3 normal = normalize(vec3(slope.x, 1.0, slope.y));
    float ndv = saturate(dot(normal, viewDir));
    float fresnel = mix(0.02, 1.0, pow(1.0 - ndv, 5.0));

    // ---- Refraction ------------------------------------------------------
    vec3 incident = -viewDir;
    vec3 refractedDir = refract(incident, normal, ${WATER_ETA.toFixed(5)});
    vec3 entry = vWorld + vec3(0.0, -0.012, 0.0);
    float pathLength = basinExit(entry, refractedDir);
    vec3 hit = entry + refractedDir * pathLength;
    // The refraction source is drawn with a wider field of view: Snell's law
    // bends the near-field rays below the main frustum, so the underwater point
    // that a bottom-of-frame pixel sees is outside the frame without water. The
    // wide target keeps that geometry available and the projection below is the
    // matching one, which makes the refraction geometrically correct instead of
    // an offset guess.
    vec4 hitClip = uSceneViewProjection * vec4(hit, 1.0);
    vec3 transmitted = uDeepColor;
    if (hitClip.w > 0.0) {
      vec2 hitUv = hitClip.xy / hitClip.w * 0.5 + 0.5;
      if (hitUv.x > 0.002 && hitUv.x < 0.998 && hitUv.y > 0.002 && hitUv.y < 0.998) {
        transmitted = texture2D(uScene, hitUv).rgb;
      }
    }
    vec3 transmittance = exp(-uAbsorption * pathLength);
    vec3 refracted = transmitted * transmittance + uScatterColor * (1.0 - transmittance);

    // Crisp caustic web on the submerged surface. The material-level caustics are
    // already in the refract source but they are low-pass filtered by the
    // reduced-resolution prepass; this adds the sharp lines back at full
    // resolution, absorbed by the same water column.
    float hitDepth = clamp(-hit.y, 0.0, 3.4);
    float causticMask = mix(1.0, 0.12, smoothstep(0.8, 3.2, pathLength));
    float caustic = poolCausticLattice(hit.xz, uTime, hitDepth) * causticMask;
    refracted += uCausticColor * caustic * transmittance * uCausticStrength;

    refracted = mix(uDeepColor, refracted, uRefractionOn);

    // ---- Planar reflection ----------------------------------------------
    vec2 reflectUv = vReflectCoord.xy / max(vReflectCoord.w, 1e-4);
    vec2 distortion = normal.xz * uDistortion * (0.35 + 0.65 * (1.0 - ndv));
    // A still pool is not a perfect dielectric mirror: a thin film of suspended
    // matter at the interface pulls the reflection towards the deep body colour.
    vec3 reflection = mix(reflectionColor(reflectUv + distortion, cameraDistance), uDeepColor, 0.26) * uReflectionStrength;

    vec3 color = mix(refracted, reflection, fresnel);

    // ---- Sun glints ------------------------------------------------------
    vec3 lightDir = normalize(uSunDirection);
    vec3 halfVector = normalize(lightDir + viewDir);
    float specular = pow(saturate(dot(normal, halfVector)), 720.0) * 5.0;
    specular += pow(saturate(dot(normal, halfVector)), 110.0) * 0.07;
    color += uSunColor * specular * (0.35 + 0.65 * fresnel);

    // ---- Foam, scum and wakes -------------------------------------------
    float edge = min(uHalfWidth - abs(vWorld.x), uHalfLength - abs(vWorld.z));
    float copingBand = 1.0 - smoothstep(0.0, 0.2, edge);
    float scum = 1.0 - smoothstep(0.0, 0.06, edge);
    float foam = copingBand * (0.16 + 0.5 * noiseValue) * 0.2;
    foam += scum * 0.09 * (0.4 + 0.6 * fineNoise);
    foam = max(foam, contactFoam(worldUv, fineNoise) * 0.26);
    // A few drifting flecks, never white cartoon suds.
    float flecks = smoothstep(0.82, 0.94, fineNoise) * smoothstep(0.3, 0.9, noiseValue) * 0.055;
    foam += flecks;
    foam = saturate(foam * uFoamStrength);
    vec3 foamColor = vec3(0.42, 0.44, 0.42) * (0.5 + 0.5 * noiseValue);
    color = mix(color, foamColor, foam);

    // ---- Fog -------------------------------------------------------------
    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * cameraDistance * cameraDistance);
    color = mix(color, uFogColor, saturate(fogFactor));

    gl_FragColor = vec4(color, 1.0);
  }
`;

function reflectCamera(camera: PerspectiveCamera, virtualCamera: PerspectiveCamera): Matrix4 {
  const normal = new Vector3(0, 1, 0);
  const reflectorWorldPosition = new Vector3(0, LAYOUT.water.surface, 0);
  const cameraWorldPosition = camera.position.clone();
  const rotationMatrix = new Matrix4().extractRotation(camera.matrixWorld);
  const lookAtPosition = new Vector3(0, 0, -1).applyMatrix4(rotationMatrix).add(cameraWorldPosition);

  const view = reflectorWorldPosition.clone().sub(cameraWorldPosition).reflect(normal).negate().add(reflectorWorldPosition);
  const target = reflectorWorldPosition.clone().sub(lookAtPosition).reflect(normal).negate().add(reflectorWorldPosition);

  virtualCamera.position.copy(view);
  virtualCamera.up.set(0, 1, 0).applyMatrix4(rotationMatrix).reflect(normal);
  virtualCamera.lookAt(target);
  virtualCamera.far = camera.far;
  virtualCamera.near = camera.near;
  virtualCamera.fov = camera.fov;
  virtualCamera.aspect = camera.aspect;
  virtualCamera.updateMatrixWorld();
  virtualCamera.matrixWorldInverse.copy(virtualCamera.matrixWorld).invert();
  virtualCamera.projectionMatrix.copy(camera.projectionMatrix);

  const textureMatrix = new Matrix4();
  textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  textureMatrix.multiply(virtualCamera.projectionMatrix);
  textureMatrix.multiply(virtualCamera.matrixWorldInverse);

  // Oblique clipping keeps everything below the water plane out of the mirror.
  const reflectorPlane = new Plane();
  reflectorPlane.setFromNormalAndCoplanarPoint(normal, reflectorWorldPosition);
  reflectorPlane.applyMatrix4(virtualCamera.matrixWorldInverse);
  const clipPlane = new Vector4(reflectorPlane.normal.x, reflectorPlane.normal.y, reflectorPlane.normal.z, reflectorPlane.constant);
  const projection = virtualCamera.projectionMatrix;
  const q = new Vector4(
    (Math.sign(clipPlane.x) + projection.elements[8]!) / projection.elements[0]!,
    (Math.sign(clipPlane.y) + projection.elements[9]!) / projection.elements[5]!,
    -1,
    (1 + projection.elements[10]!) / projection.elements[14]!,
  );
  clipPlane.multiplyScalar(2 / clipPlane.dot(q));
  projection.elements[2] = clipPlane.x;
  projection.elements[6] = clipPlane.y;
  projection.elements[10] = clipPlane.z + 1 - 0.003;
  projection.elements[14] = clipPlane.w;

  return textureMatrix;
}

export function buildWater(
  scene: Scene,
  renderer: WebGLRenderer,
  camera: PerspectiveCamera,
  normalTexture: Texture,
  qualityScale: number,
): WaterSystem {
  const geometry = new PlaneGeometry(LAYOUT.water.halfWidth * 2, LAYOUT.water.zMax - LAYOUT.water.zMin, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, LAYOUT.water.surface, (LAYOUT.water.zMin + LAYOUT.water.zMax) / 2);

  const size = renderer.getDrawingBufferSize(new Vector2());
  const reflectionTarget = new WebGLRenderTarget(
    Math.max(2, Math.floor(size.x * qualityScale)),
    Math.max(2, Math.floor(size.y * qualityScale)),
    {
      type: HalfFloatType,
      colorSpace: LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    },
  );
  reflectionTarget.texture.name = 'water.reflection';
  reflectionTarget.texture.generateMipmaps = false;
  reflectionTarget.texture.wrapS = reflectionTarget.texture.wrapT = ClampToEdgeWrapping;

  // The refraction source is a reduced-resolution copy of the opaque scene. It
  // needs no depth attachment: the basin exit is solved analytically in the
  // shader, which avoids depth-edge stair-stepping through the ripples.
  const refractionScale = Math.max(0.3, qualityScale * 0.85);
  const refractionTarget = new WebGLRenderTarget(
    Math.max(2, Math.floor(size.x * refractionScale)),
    Math.max(2, Math.floor(size.y * refractionScale)),
    {
      type: HalfFloatType,
      colorSpace: LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    },
  );
  refractionTarget.texture.name = 'water.refraction';
  refractionTarget.texture.generateMipmaps = false;
  refractionTarget.texture.wrapS = refractionTarget.texture.wrapT = ClampToEdgeWrapping;

  const normalB = createWaterNormalTexture(renderer, 512, 821);
  const normalC = createWaterNormalTexture(renderer, 256, 990);
  const noise = createNoiseTexture(renderer, 256, 17);

  const ringCenters = LAYOUT.rings.map(
    (ring) => new Vector4(ring.position.x, ring.position.z, ring.radius, ring.tube),
  );
  const ringPhases = LAYOUT.rings.map((ring) => ring.phase);

  const material = new ShaderMaterial({
    name: 'water',
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uReflection: { value: reflectionTarget.texture },
      uScene: { value: refractionTarget.texture },
      uNormalA: { value: normalTexture },
      uNormalB: { value: normalB },
      uNormalC: { value: normalC },
      uNoise: { value: noise },
      uTexel: { value: new Vector2(1 / size.x, 1 / size.y) },
      uSceneViewProjection: { value: new Matrix4() },
      uTime: { value: 0 },
      uTextureMatrix: { value: new Matrix4() },
      uCameraPos: { value: camera.position.clone() },
      uSunDirection: { value: new Vector3(-12.5, 27, -14).normalize() },
      uSunColor: { value: new Color(0xfff0d2) },
      uAbsorption: { value: new Vector3(1.7, 0.9, 1.0) },
      uScatterColor: { value: new Color(0x0e2b27).multiplyScalar(0.12) },
      uDeepColor: { value: new Color(0x071817) },
      uFogColor: { value: new Color(0x93a9ac) },
      uFogDensity: { value: 0.0105 },
      uHalfWidth: { value: LAYOUT.water.halfWidth },
      uHalfLength: { value: (LAYOUT.water.zMax - LAYOUT.water.zMin) / 2 },
      uFloorY: { value: LAYOUT.water.floor },
      uRingCenters: { value: ringCenters },
      uRingPhases: { value: ringPhases },
      uMouth: {
        value: new Vector4(LAYOUT.slide.end.x, LAYOUT.slide.end.z, LAYOUT.slide.mouthRadius, 0.5),
      },
      uRefractionOn: { value: 1 },
      uCausticColor: { value: new Color(0xffe9c9).multiplyScalar(0.22) },
      uCausticStrength: { value: 1 },
      uReflectionStrength: { value: 0.62 },
      uFoamStrength: { value: 1 },
      uDistortion: { value: 0.018 },
    },
  });

  const mesh = new Mesh(geometry, material);
  mesh.name = 'water';
  mesh.renderOrder = 2;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  scene.add(mesh);

  const virtualCamera = new PerspectiveCamera();
  const refractionCamera = new PerspectiveCamera();
  let reflectionScale = qualityScale;
  let currentWidth = Math.max(2, Math.floor(size.x * reflectionScale));
  let currentHeight = Math.max(2, Math.floor(size.y * reflectionScale));

  /** Wider frustum used only for the refraction source, see the shader comment. */
  const REFRACTION_FOV_SCALE = 1.9;
  const syncRefractionCamera = (activeCamera: PerspectiveCamera): void => {
    refractionCamera.position.copy(activeCamera.position);
    refractionCamera.quaternion.copy(activeCamera.quaternion);
    refractionCamera.near = activeCamera.near;
    refractionCamera.far = activeCamera.far;
    refractionCamera.aspect = activeCamera.aspect;
    refractionCamera.fov = Math.min(118, activeCamera.fov * REFRACTION_FOV_SCALE);
    refractionCamera.updateProjectionMatrix();
    refractionCamera.updateMatrixWorld();
    material.uniforms.uSceneViewProjection!.value
      .copy(refractionCamera.projectionMatrix)
      .multiply(refractionCamera.matrixWorldInverse);
  };

  const renderPass = (
    activeRenderer: WebGLRenderer,
    activeScene: Scene,
    activeCamera: PerspectiveCamera,
    target: WebGLRenderTarget,
  ): void => {
    mesh.visible = false;
    const previousTarget = activeRenderer.getRenderTarget();
    const previousAutoClear = activeRenderer.autoClear;
    const previousShadowAutoUpdate = activeRenderer.shadowMap.autoUpdate;
    activeRenderer.shadowMap.autoUpdate = false;
    activeRenderer.autoClear = true;
    activeRenderer.setRenderTarget(target);
    activeRenderer.clear(true, true, false);
    activeRenderer.render(activeScene, activeCamera);
    activeRenderer.setRenderTarget(previousTarget);
    activeRenderer.autoClear = previousAutoClear;
    activeRenderer.shadowMap.autoUpdate = previousShadowAutoUpdate;
    mesh.visible = true;
  };

  /** Keeps only underwater geometry in the refraction source (see renderRefraction). */
  const refractionClipPlane = new Plane(new Vector3(0, -1, 0), -0.004);

  const water: WaterSystem = {
    mesh,
    material,
    update(time, activeCamera) {
      activeCamera.updateMatrixWorld();
      material.uniforms.uTime!.value = time;
      material.uniforms.uCameraPos!.value.copy(activeCamera.position);
    },
    renderRefraction(activeRenderer, activeScene, activeCamera) {
      if (activeCamera.position.y < 0.02) return;
      activeCamera.updateMatrixWorld();
      syncRefractionCamera(activeCamera);
      // Clip everything above the water plane. Without this, above-water props
      // (ladders, deck, rings) that happen to project onto the submerged point
      // would leak into the refracted image as bright, unabsorbed silhouettes.
      const previousClipping = activeRenderer.clippingPlanes;
      activeRenderer.clippingPlanes = [refractionClipPlane];
      renderPass(activeRenderer, activeScene, refractionCamera, refractionTarget);
      activeRenderer.clippingPlanes = previousClipping;
    },
    renderReflection(activeRenderer, activeScene, activeCamera) {
      activeCamera.updateMatrixWorld();
      const matrix = reflectCamera(activeCamera, virtualCamera);
      material.uniforms.uTextureMatrix!.value.copy(matrix);
      renderPass(activeRenderer, activeScene, virtualCamera, reflectionTarget);
    },
    resize(width, height, scale) {
      reflectionScale = scale;
      currentWidth = Math.max(2, Math.floor(width * scale));
      currentHeight = Math.max(2, Math.floor(height * scale));
      reflectionTarget.setSize(currentWidth, currentHeight);
      refractionTarget.setSize(
        Math.max(2, Math.floor(width * refractionScale)),
        Math.max(2, Math.floor(height * refractionScale)),
      );
      material.uniforms.uTexel!.value.set(1 / Math.max(width, 1), 1 / Math.max(height, 1));
    },
    setReflectionScale(scale) {
      reflectionScale = scale;
      reflectionTarget.setSize(
        Math.max(2, Math.floor(currentWidth * scale)),
        Math.max(2, Math.floor(currentHeight * scale)),
      );
    },
    dispose() {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
      reflectionTarget.dispose();
      refractionTarget.dispose();
      normalB.dispose();
      normalC.dispose();
      noise.dispose();
    },
  };

  return water;
}
