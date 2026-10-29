import {
  ClampToEdgeWrapping,
  Color,
  DoubleSide,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
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
  type WebGLRenderer,
} from 'three';
import { LAYOUT } from './layout';
import { createNoiseTexture, createWaterNormalTexture } from './textures';

export interface WaterSystem {
  mesh: Mesh;
  material: ShaderMaterial;
  update(time: number, camera: PerspectiveCamera): void;
  renderReflection(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera): void;
  resize(width: number, height: number, scale: number): void;
  setReflectionScale(scale: number): void;
  dispose(): void;
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

  uniform sampler2D uReflection;
  uniform sampler2D uNormalA;
  uniform sampler2D uNormalB;
  uniform sampler2D uNoise;
  uniform float uTime;
  uniform vec3 uCameraPos;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uDeepColor;
  uniform vec3 uShallowColor;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uHalfWidth;
  uniform float uHalfLength;
  uniform float uReflectionStrength;
  uniform float uDistortion;

  varying vec4 vReflectCoord;
  varying vec3 vWorld;
  varying vec3 vViewPosition;

  float saturate(float value) {
    return clamp(value, 0.0, 1.0);
  }

  void main() {
    vec2 reflectUv = vReflectCoord.xy / max(vReflectCoord.w, 0.0001);

    vec2 worldUv = vWorld.xz;
    vec3 nA = texture2D(uNormalA, worldUv * 0.19 + vec2(uTime * 0.012, uTime * 0.017)).xyz * 2.0 - 1.0;
    vec3 nB = texture2D(uNormalB, worldUv * 0.42 + vec2(-uTime * 0.019, uTime * 0.010)).xyz * 2.0 - 1.0;
    vec2 slope = nA.xy * 0.60 + nB.xy * 0.40;

    // Ripples emanating from the floating toys; subtle, but they read as scale.
    float ringRipple = 0.0;
    vec3 ringA = vec3(1.75, 0.0, -3.0);
    vec3 ringB = vec3(-2.15, 0.0, -7.6);
    for (int i = 0; i < 2; i++) {
      vec3 center = i == 0 ? ringA : ringB;
      float dist = length(vWorld.xz - center.xz);
      float wave = sin(dist * 16.0 - uTime * 1.9) * exp(-dist * 2.0) * 0.12;
      ringRipple += wave;
    }
    slope += vec2(ringRipple, ringRipple * 0.6);

    vec3 normal = normalize(vec3(slope.x, 1.0, slope.y));
    vec3 viewDir = normalize(uCameraPos - vWorld);
    float ndv = saturate(dot(normal, viewDir));
    float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

    // Distort the planar reflection by the surface slope. The reflection RT is
    // already filtered, so this stays stable when the camera moves.
    vec2 distortion = normal.xz * uDistortion * (0.35 + 0.65 * (1.0 - ndv));
    vec3 reflection = texture2D(uReflection, reflectUv + distortion).rgb;
    reflection *= uReflectionStrength;

    vec3 body = mix(uShallowColor, uDeepColor, saturate(0.25 + 0.75 * (1.0 - ndv)));
    vec3 color = mix(body, reflection, saturate(fresnel * 1.12));

    vec3 lightDir = normalize(uSunDirection);
    vec3 halfVector = normalize(lightDir + viewDir);
    float specular = pow(saturate(dot(normal, halfVector)), 680.0) * 9.0;
    specular += pow(saturate(dot(normal, halfVector)), 90.0) * 0.22;
    color += uSunColor * specular;

    float edge = min(uHalfWidth - abs(vWorld.x), uHalfLength - abs(vWorld.z));
    float foamNoise = texture2D(uNoise, vWorld.xz * 0.55 + vec2(uTime * 0.004, uTime * -0.003)).r;
    float foam = (1.0 - smoothstep(0.0, 0.28, edge)) * (0.25 + 0.75 * foamNoise);
    foam *= 0.22;
    color = mix(color, vec3(0.66, 0.74, 0.70), foam);

    // A faint scum line where the water works against the coping.
    float scum = (1.0 - smoothstep(0.0, 0.12, edge)) * 0.08;
    color = mix(color, vec3(0.38, 0.40, 0.34), scum);

    float distanceToCamera = length(vViewPosition);
    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);
    color = mix(color, uFogColor, saturate(fogFactor));

    float alpha = mix(0.86, 0.99, fresnel);
    alpha = max(alpha, foam);
    gl_FragColor = vec4(color, alpha);
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
    Math.max(2, Math.floor(size.x * 0.65)),
    Math.max(2, Math.floor(size.y * 0.65)),
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

  const normalB = createWaterNormalTexture(renderer, 512, 821);
  const noise = createNoiseTexture(renderer, 256, 17);

  const material = new ShaderMaterial({
    name: 'water',
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uReflection: { value: reflectionTarget.texture },
      uNormalA: { value: normalTexture },
      uNormalB: { value: normalB },
      uNoise: { value: noise },
      uTime: { value: 0 },
      uTextureMatrix: { value: new Matrix4() },
      uCameraPos: { value: camera.position.clone() },
      uSunDirection: { value: new Vector3(-12.5, 27, -14).normalize() },
      uSunColor: { value: new Color(0xfff0d2) },
      uDeepColor: { value: new Color(0x071817) },
      uShallowColor: { value: new Color(0x0d2b27) },
      uFogColor: { value: new Color(0x93a9ac) },
      uFogDensity: { value: 0.0105 },
      uHalfWidth: { value: LAYOUT.water.halfWidth },
      uHalfLength: { value: (LAYOUT.water.zMax - LAYOUT.water.zMin) / 2 },
      uReflectionStrength: { value: 0.82 },
      uDistortion: { value: 0.03 },
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
  let reflectionScale = qualityScale;
  let currentWidth = Math.max(2, Math.floor(size.x * reflectionScale));
  let currentHeight = Math.max(2, Math.floor(size.y * reflectionScale));

  const water: WaterSystem = {
    mesh,
    material,
    update(time, activeCamera) {
      material.uniforms.uTime!.value = time;
      material.uniforms.uCameraPos!.value.copy(activeCamera.position);
      const sunDirection = new Vector3(-12.5, 27, -14).normalize();
      material.uniforms.uSunDirection!.value.copy(sunDirection);
    },
    renderReflection(activeRenderer, activeScene, activeCamera) {
      activeCamera.updateMatrixWorld();
      const matrix = reflectCamera(activeCamera, virtualCamera);
      material.uniforms.uTextureMatrix!.value.copy(matrix);
      mesh.visible = false;
      const previousTarget = activeRenderer.getRenderTarget();
      const previousAutoClear = activeRenderer.autoClear;
      const previousShadowAutoUpdate = activeRenderer.shadowMap.autoUpdate;
      activeRenderer.shadowMap.autoUpdate = false;
      activeRenderer.autoClear = true;
      activeRenderer.setRenderTarget(reflectionTarget);
      activeRenderer.clear(true, true, false);
      activeRenderer.render(activeScene, virtualCamera);
      activeRenderer.setRenderTarget(previousTarget);
      activeRenderer.autoClear = previousAutoClear;
      activeRenderer.shadowMap.autoUpdate = previousShadowAutoUpdate;
      mesh.visible = true;
    },
    resize(width, height, scale) {
      reflectionScale = scale;
      currentWidth = Math.max(2, Math.floor(width * scale));
      currentHeight = Math.max(2, Math.floor(height * scale));
      reflectionTarget.setSize(currentWidth, currentHeight);
    },
    setReflectionScale(scale) {
      reflectionScale = scale;
      reflectionTarget.setSize(Math.max(2, Math.floor(currentWidth * scale)), Math.max(2, Math.floor(currentHeight * scale)));
    },
    dispose() {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
      reflectionTarget.dispose();
      normalB.dispose();
      noise.dispose();
    },
  };

  return water;
}
