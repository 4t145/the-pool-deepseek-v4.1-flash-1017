import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  NoToneMapping,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type Scene as ThreeScene,
  type WebGLRenderer,
} from 'three';
import type { QualityPreset } from '../app/quality';
import {
  BLOOM_GAIN,
  BLOOM_KNEE,
  BLOOM_THRESHOLD,
  CHROMATIC_AMOUNT,
  GRAIN_AMOUNT,
  GRAIN_FRAME_RATE,
  GRADE_CONTRAST,
  BLOOM_MASK_LAYER,
  isBloomEmitter,
  GRADE_SATURATION,
  LETTERBOX_ASPECT,
  VIGNETTE_AMOUNT,
  type ToneCurveName,
} from '../core/post';

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const BRIGHT_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uThreshold;
  uniform float uKnee;
  uniform float uClamp;
  varying vec2 vUv;

  void main() {
    vec3 color = texture2D(tSrc, vUv).rgb;
    float luminance = max(max(color.r, color.g), color.b);
    // C1-continuous soft knee. The source is the emissive mask, so this only
    // shapes how hard window/skylight/tube highlights bloom.
    float soft = min(max(0.0, luminance - uThreshold + uKnee), 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 0.0001);
    float contribution = max(soft, luminance - uThreshold) / max(luminance, 0.0001);
    vec3 bloom = color * contribution;
    gl_FragColor = vec4(min(bloom, vec3(uClamp)), 1.0);
  }
`;

const DOWN_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  varying vec2 vUv;

  vec3 sampleAt(vec2 offset) {
    return texture2D(tSrc, vUv + offset * uTexel).rgb;
  }

  void main() {
    vec3 color = sampleAt(vec2(0.0)) * 0.125;
    color += (sampleAt(vec2(-1.0, 0.0)) + sampleAt(vec2(1.0, 0.0)) +
              sampleAt(vec2(0.0, -1.0)) + sampleAt(vec2(0.0, 1.0))) * 0.125;
    color += (sampleAt(vec2(-1.0, -1.0)) + sampleAt(vec2(1.0, -1.0)) +
              sampleAt(vec2(-1.0, 1.0)) + sampleAt(vec2(1.0, 1.0))) * 0.0625;
    color += (sampleAt(vec2(-2.0, 0.0)) + sampleAt(vec2(2.0, 0.0)) +
              sampleAt(vec2(0.0, -2.0)) + sampleAt(vec2(0.0, 2.0))) * 0.03125;
    gl_FragColor = vec4(color, 1.0);
  }
`;

const UP_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  varying vec2 vUv;

  vec3 sampleAt(vec2 offset) {
    return texture2D(tSrc, vUv + offset * uTexel).rgb;
  }

  void main() {
    vec3 color = sampleAt(vec2(0.0)) * 4.0;
    color += (sampleAt(vec2(-1.0, 0.0)) + sampleAt(vec2(1.0, 0.0)) +
              sampleAt(vec2(0.0, -1.0)) + sampleAt(vec2(0.0, 1.0))) * 2.0;
    color += sampleAt(vec2(-1.0, -1.0)) + sampleAt(vec2(1.0, -1.0)) +
             sampleAt(vec2(-1.0, 1.0)) + sampleAt(vec2(1.0, 1.0));
    gl_FragColor = vec4(color / 16.0, 1.0);
  }
`;

/**
 * Final composite. This is the only place a display transform happens:
 * linear-sRGB HDR -> +bloom -> exposure -> AgX or ACES -> sRGB OETF -> grade ->
 * vignette -> deterministic grain/dither -> optional 2.39 letterbox.
 */
const FINAL_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform vec2 uResolution;
  uniform float uTime;
  uniform float uExposure;
  uniform float uBloomStrength;
  uniform float uBloomGain;
  uniform float uToneCurve;
  uniform float uGrain;
  uniform float uDither;
  uniform float uVignette;
  uniform float uChromatic;
  uniform float uLetterbox;
  uniform float uAspect;
  uniform float uTargetAspect;
  uniform float uSaturation;
  uniform float uContrast;
  uniform float uFrameRate;

  varying vec2 vUv;

  // ---- ACES (Stephen Hill RRT+ODT fit) --------------------------------------
  const mat3 ACES_INPUT = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );
  const mat3 ACES_OUTPUT = mat3(
     1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602
  );

  vec3 rrtOdt(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }

  vec3 acesCurve(vec3 color) {
    color = ACES_INPUT * color;
    color = rrtOdt(color);
    color = ACES_OUTPUT * color;
    return clamp(color, 0.0, 1.0);
  }

  // ---- AgX (Blender/Filament via three.js r186) -----------------------------
  // Input and output are linear-sRGB; the internal 2.2 power is part of the AgX
  // curve (as in three.js), not a second display gamma.
  const mat3 AGX_INSET = mat3(
    0.856627153315983, 0.137318972929847, 0.11189821299995,
    0.0951212405381588, 0.761241990602591, 0.0767994186031903,
    0.0482516061458583, 0.101439036467562, 0.811302368396859
  );
  const mat3 AGX_OUTSET = mat3(
     1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
    -0.11060664309660323,  1.157823702216272, -0.11060664309660294,
    -0.016493938717834573, -0.016493938717834257, 1.2519364065950405
  );
  const mat3 REC2020_FROM_SRGB = mat3(
    0.6274, 0.0691, 0.0164,
    0.3293, 0.9195, 0.0880,
    0.0433, 0.0113, 0.8956
  );
  const mat3 SRGB_FROM_REC2020 = mat3(
     1.6605, -0.1246, -0.0182,
    -0.5876,  1.1329, -0.1006,
    -0.0728, -0.0083,  1.1187
  );
  const float AGX_MIN_EV = -12.47393;
  const float AGX_MAX_EV = 4.026069;

  vec3 agxContrast(vec3 x) {
    vec3 x2 = x * x;
    vec3 x4 = x2 * x2;
    return + 15.5 * x4 * x2
      - 40.14 * x4 * x
      + 31.96 * x4
      - 6.868 * x2 * x
      + 0.4298 * x2
      + 0.1191 * x
      - 0.00232;
  }

  vec3 agxCurve(vec3 color) {
    color = REC2020_FROM_SRGB * color;
    color = AGX_INSET * color;
    color = max(color, vec3(1e-10));
    color = log2(color);
    color = clamp((color - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0.0, 1.0);
    color = agxContrast(color);
    color = AGX_OUTSET * color;
    color = pow(max(vec3(0.0), color), vec3(2.2));
    color = SRGB_FROM_REC2020 * color;
    return clamp(color, 0.0, 1.0);
  }

  // Exact sRGB OETF. The one and only gamma encode.
  vec3 linearToSrgb(vec3 color) {
    vec3 low = color * 12.92;
    vec3 high = 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(high, low, step(color, vec3(0.0031308)));
  }

  // Dave Hoskins hash; stable for identical pixel/frame inputs.
  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec2 uv = vUv;
    vec2 centered = uv - 0.5;
    float radial2 = dot(centered, centered);

    // Edge-only chromatic aberration: exactly zero at the centre, ~1-2 px at
    // the corners. No RGB split on the subject.
    vec2 ca = centered * (uChromatic * 0.004 * radial2 * radial2);
    vec3 sceneColor;
    sceneColor.r = texture2D(tScene, clamp(uv + ca, vec2(0.0), vec2(1.0))).r;
    sceneColor.g = texture2D(tScene, uv).g;
    sceneColor.b = texture2D(tScene, clamp(uv - ca, vec2(0.0), vec2(1.0))).b;

    // Bloom is added in linear HDR before the display transform.
    vec3 bloom = texture2D(tBloom, uv).rgb;
    vec3 color = sceneColor + bloom * uBloomStrength * uBloomGain;

    // Single display transform.
    color *= uExposure;
    color = uToneCurve < 0.5 ? agxCurve(color) : acesCurve(color);
    color = linearToSrgb(color);

    // Contained grade: contrast from light, not a LUT. Tiny cool-shadow /
    // warm-highlight split, red kept saturated rather than neon.
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luma), color, uSaturation);
    color = (color - 0.5) * uContrast + 0.5;
    float shadow = 1.0 - smoothstep(0.02, 0.44, luma);
    float highlight = smoothstep(0.62, 1.0, luma);
    color += vec3(-0.0035, 0.0045, 0.009) * shadow;
    color += vec3(0.005, 0.002, -0.0025) * highlight;

    // Gentle vignette; never a black tube.
    float radius = length(centered * vec2(1.0, 0.82));
    color *= 1.0 - uVignette * smoothstep(0.18, 0.86, radius);

    // Film grain at 24 fps cadence. Keyed on quantised scene time and pixel
    // coords, so renderAt(t) is deterministic and the trailer steps cleanly.
    float frame = floor(uTime * uFrameRate + 0.0001);
    vec2 pixel = uv * uResolution;
    float grain = hash13(vec3(pixel, frame))
      + hash13(vec3(pixel + vec2(101.0, 37.0), frame + 13.0)) - 1.0;
    float shadowWeight = mix(1.35, 0.55, smoothstep(0.03, 0.65, luma));
    color += grain * uGrain * shadowWeight;

    // Triangular dither (±0.5 LSB) keeps fog/ceiling gradients from banding
    // after the 8-bit encode.
    float dither = hash13(vec3(pixel + vec2(17.0, 89.0), frame + 5.0))
      + hash13(vec3(pixel + vec2(61.0, 23.0), frame + 29.0)) - 1.0;
    color += dither * uDither / 510.0;

    // Optional 2.39:1 presentation mask. Stills stay 16:9.
    if (uLetterbox > 0.5) {
      float bars = uAspect < uTargetAspect ? (1.0 - uAspect / uTargetAspect) * 0.5 : 0.0;
      if (uv.y < bars || uv.y > 1.0 - bars) color = vec3(0.0);
    }

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  }
`;

export interface PostOptions {
  letterbox: boolean;
  exposure?: number;
  bloom?: number;
  /** Display transform; AgX is the default because it protects this scene's highlights. */
  toneCurve?: ToneCurveName;
  grain?: number;
  dither?: number;
  vignette?: number;
  chromatic?: number;
}

interface ResolvedPostOptions {
  letterbox: boolean;
  exposure: number;
  bloom: number;
  toneCurve: ToneCurveName;
  grain: number;
  dither: number;
  vignette: number;
  chromatic: number;
}

/**
 * HDR scene -> thresholded bloom pyramid -> single display transform + grade.
 * The scene target is multisampled; the bloom chain runs at half resolution and
 * below, which keeps a 6-level pyramid cheap even at 4K.
 */
export class PostPipeline {
  private readonly renderer: WebGLRenderer;
  private readonly quality: QualityPreset;
  private readonly quadScene = new Scene();
  private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: Mesh;
  private readonly brightMaterial: ShaderMaterial;
  private readonly downMaterial: ShaderMaterial;
  private readonly upMaterial: ShaderMaterial;
  private readonly finalMaterial: ShaderMaterial;

  private sceneTarget: WebGLRenderTarget | null = null;
  private bloomTargets: WebGLRenderTarget[] = [];
  /** Half-res render of emissive materials only; the sole source of bloom. */
  private bloomMaskTarget: WebGLRenderTarget | null = null;
  private bloomMaskPrepared = false;
  private width = 1;
  private height = 1;
  private options: ResolvedPostOptions;

  constructor(renderer: WebGLRenderer, quality: QualityPreset, options: PostOptions) {
    this.renderer = renderer;
    this.quality = quality;
    this.options = {
      letterbox: options.letterbox,
      exposure: options.exposure ?? 1.2,
      bloom: options.bloom ?? 0.34,
      toneCurve: options.toneCurve ?? 'agx',
      grain: options.grain ?? GRAIN_AMOUNT,
      dither: options.dither ?? 1,
      vignette: options.vignette ?? VIGNETTE_AMOUNT,
      chromatic: options.chromatic ?? CHROMATIC_AMOUNT,
    };

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));

    this.brightMaterial = new ShaderMaterial({
      vertexShader: QUAD_VERTEX,
      fragmentShader: BRIGHT_FRAGMENT,
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new Vector2(1, 1) },
        uThreshold: { value: BLOOM_THRESHOLD },
        uKnee: { value: BLOOM_KNEE },
        uClamp: { value: 24 },
      },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this.downMaterial = new ShaderMaterial({
      vertexShader: QUAD_VERTEX,
      fragmentShader: DOWN_FRAGMENT,
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new Vector2(1, 1) },
      },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this.upMaterial = new ShaderMaterial({
      vertexShader: QUAD_VERTEX,
      fragmentShader: UP_FRAGMENT,
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new Vector2(1, 1) },
      },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: AdditiveBlending,
      toneMapped: false,
    });

    this.finalMaterial = new ShaderMaterial({
      vertexShader: QUAD_VERTEX,
      fragmentShader: FINAL_FRAGMENT,
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        uResolution: { value: new Vector2(1, 1) },
        uTime: { value: 0 },
        uExposure: { value: this.options.exposure },
        uBloomStrength: { value: this.options.bloom },
        uBloomGain: { value: BLOOM_GAIN },
        uToneCurve: { value: this.options.toneCurve === 'aces' ? 1 : 0 },
        uGrain: { value: this.options.grain },
        uDither: { value: this.options.dither },
        uVignette: { value: this.options.vignette },
        uChromatic: { value: this.options.chromatic },
        uLetterbox: { value: this.options.letterbox ? 1 : 0 },
        uAspect: { value: 16 / 9 },
        uTargetAspect: { value: LETTERBOX_ASPECT },
        uSaturation: { value: GRADE_SATURATION },
        uContrast: { value: GRADE_CONTRAST },
        uFrameRate: { value: GRAIN_FRAME_RATE },
      },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this.quad = new Mesh(geometry, this.brightMaterial);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.renderer.toneMapping = NoToneMapping;
  }

  get sceneTexture(): WebGLRenderTarget | null {
    return this.sceneTarget;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(2, Math.floor(width));
    const h = Math.max(2, Math.floor(height));
    this.width = w;
    this.height = h;
    if (!this.sceneTarget || w !== this.lastW || h !== this.lastH) {
      this.lastW = w;
      this.lastH = h;
      this.rebuildTargets();
    }
  }

  private lastW = 0;
  private lastH = 0;

  private rebuildTargets(): void {
    this.sceneTarget?.dispose();
    this.bloomMaskTarget?.dispose();
    for (const target of this.bloomTargets) target.dispose();
    this.bloomTargets = [];

    this.sceneTarget = new WebGLRenderTarget(this.width, this.height, {
      type: HalfFloatType,
      colorSpace: LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      samples: this.quality.msaaSamples,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false,
    });
    this.sceneTarget.texture.name = 'post.scene';

    const levels = Math.max(2, this.quality.bloomLevels);
    let w = this.width >> 1;
    let h = this.height >> 1;
    for (let i = 0; i < levels; i++) {
      const sw = Math.max(2, w);
      const sh = Math.max(2, h);
      const target = new WebGLRenderTarget(sw, sh, {
        type: HalfFloatType,
        colorSpace: LinearSRGBColorSpace,
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        generateMipmaps: false,
      });
      target.texture.name = `post.bloom.${i}`;
      this.bloomTargets.push(target);
      w >>= 1;
      h >>= 1;
    }

    this.bloomMaskTarget = new WebGLRenderTarget(
      Math.max(2, this.width >> 1),
      Math.max(2, this.height >> 1),
      {
        type: HalfFloatType,
        colorSpace: LinearSRGBColorSpace,
        depthBuffer: true,
        stencilBuffer: false,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        generateMipmaps: false,
      },
    );
    this.bloomMaskTarget.texture.name = 'post.bloomMask';
    this.bloomMaskPrepared = false;

    this.finalMaterial.uniforms.uResolution!.value.set(this.width, this.height);
    this.finalMaterial.uniforms.uAspect!.value = this.width / this.height;
  }

  isLetterboxEnabled(): boolean {
    return this.options.letterbox;
  }

  setLetterbox(enabled: boolean): void {
    this.options.letterbox = enabled;
    this.finalMaterial.uniforms.uLetterbox!.value = enabled ? 1 : 0;
  }

  setExposure(exposure: number): void {
    this.options.exposure = exposure;
    this.finalMaterial.uniforms.uExposure!.value = exposure;
  }

  setBloom(strength: number): void {
    this.options.bloom = strength;
    this.finalMaterial.uniforms.uBloomStrength!.value = strength;
  }

  /** Switch the single display transform. Not part of the public capture API. */
  setToneCurve(curve: ToneCurveName): void {
    this.options.toneCurve = curve;
    this.finalMaterial.uniforms.uToneCurve!.value = curve === 'aces' ? 1 : 0;
  }

  getToneCurve(): ToneCurveName {
    return this.options.toneCurve;
  }

  /** Bloom threshold/knee are relative to the emissive mask, not the scene. */
  setBloomThreshold(threshold: number, knee: number): void {
    this.brightMaterial.uniforms.uThreshold!.value = threshold;
    this.brightMaterial.uniforms.uKnee!.value = Math.max(1e-3, knee);
  }

  render(scene: ThreeScene, camera: PerspectiveCamera, time: number): void {
    if (!this.sceneTarget) this.rebuildTargets();
    const target = this.sceneTarget!;
    const renderer = this.renderer;

    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(target);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    renderer.autoClear = false;
    // Bloom comes from the emissive mask, not the scene colour: only window
    // panes, the skylight, fluorescent tubes and the warm arch glow can glow.
    this.renderEmissiveMask(scene, camera);
    const mask = this.bloomMaskTarget!;
    this.brightMaterial.uniforms.tSrc!.value = mask.texture;
    this.brightMaterial.uniforms.uTexel!.value.set(1 / mask.width, 1 / mask.height);
    this.draw(this.brightMaterial, this.bloomTargets[0]!, true);

    for (let i = 1; i < this.bloomTargets.length; i++) {
      const source = this.bloomTargets[i - 1]!;
      const destination = this.bloomTargets[i]!;
      this.downMaterial.uniforms.tSrc!.value = source.texture;
      this.downMaterial.uniforms.uTexel!.value.set(1 / source.width, 1 / source.height);
      this.draw(this.downMaterial, destination, true);
    }

    for (let i = this.bloomTargets.length - 1; i > 0; i--) {
      const source = this.bloomTargets[i]!;
      const destination = this.bloomTargets[i - 1]!;
      this.upMaterial.uniforms.tSrc!.value = source.texture;
      this.upMaterial.uniforms.uTexel!.value.set(1 / source.width, 1 / source.height);
      this.draw(this.upMaterial, destination, false);
    }

    this.finalMaterial.uniforms.tScene!.value = target.texture;
    this.finalMaterial.uniforms.tBloom!.value = this.bloomTargets[0]!.texture;
    this.finalMaterial.uniforms.uTime!.value = time;
    this.draw(this.finalMaterial, null, true);
    renderer.setRenderTarget(null);
    renderer.autoClear = previousAutoClear;
  }

  /**
   * Mark every emissive mesh once: materials that opt out of tone mapping
   * (`toneMapped === false`, the convention used for window glass, the
   * skylight, tubes and the warm arch) or set `userData.bloom = true`. They are
   * moved onto layer 1 so the mask camera sees only them.
   */
  private prepareBloomMask(scene: ThreeScene): void {
    if (this.bloomMaskPrepared) return;
    this.bloomMaskPrepared = true;
    scene.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const emissive = materials.some((material) => (material ? isBloomEmitter(material) : false));
      if (emissive) mesh.layers.enable(BLOOM_MASK_LAYER);
    });
  }

  private renderEmissiveMask(scene: ThreeScene, camera: PerspectiveCamera): void {
    const target = this.bloomMaskTarget;
    if (!target) return;
    this.prepareBloomMask(scene);
    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    const previousLayerMask = camera.layers.mask;
    try {
      renderer.setRenderTarget(target);
      renderer.clear(true, true, true);
      renderer.autoClear = false;
      camera.layers.set(BLOOM_MASK_LAYER);
      renderer.render(scene, camera);
    } finally {
      camera.layers.mask = previousLayerMask;
      renderer.autoClear = previousAutoClear;
      renderer.setRenderTarget(previousTarget);
    }
  }

  private draw(material: ShaderMaterial, target: WebGLRenderTarget | null, clear: boolean): void {
    const renderer = this.renderer;
    this.quad.material = material;
    renderer.setRenderTarget(target);
    if (clear && target) {
      renderer.clear(true, true, false);
    } else if (clear && !target) {
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, true, false);
    }
    renderer.render(this.quadScene, this.quadCamera);
  }

  dispose(): void {
    this.sceneTarget?.dispose();
    this.bloomMaskTarget?.dispose();
    for (const target of this.bloomTargets) target.dispose();
    this.brightMaterial.dispose();
    this.downMaterial.dispose();
    this.upMaterial.dispose();
    this.finalMaterial.dispose();
    this.quad.geometry.dispose();
    this.quadScene.remove(this.quad);
  }
}
