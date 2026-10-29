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
  varying vec2 vUv;

  void main() {
    vec3 color = texture2D(tSrc, vUv).rgb;
    float luminance = max(max(color.r, color.g), color.b);
    float soft = clamp(luminance - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 0.0001);
    float contribution = max(soft, luminance - uThreshold) / max(luminance, 0.0001);
    gl_FragColor = vec4(min(color * contribution, vec3(48.0)), 1.0);
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

const FINAL_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform vec2 uResolution;
  uniform float uTime;
  uniform float uExposure;
  uniform float uBloomStrength;
  uniform float uGrain;
  uniform float uVignette;
  uniform float uChromatic;
  uniform float uLetterbox;
  uniform float uAspect;
  uniform float uTargetAspect;
  uniform float uSaturation;
  uniform float uContrast;
  varying vec2 vUv;

  // ACES fitted (Stephen Hill), using the 1.0 exposure RRT+ODT approximation.
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

  vec3 aces(vec3 color) {
    color = ACES_INPUT * color;
    color = rrtOdt(color);
    color = ACES_OUTPUT * color;
    return clamp(color, 0.0, 1.0);
  }

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec2 centered = vUv - 0.5;
    float caAmount = uChromatic * dot(centered, centered);
    vec2 ca = centered * caAmount * 0.0025;

    vec3 sceneColor;
    sceneColor.r = texture2D(tScene, vUv + ca).r;
    sceneColor.g = texture2D(tScene, vUv).g;
    sceneColor.b = texture2D(tScene, vUv - ca).b;

    vec3 bloom = texture2D(tBloom, vUv).rgb;
    vec3 color = sceneColor + bloom * uBloomStrength;
    color *= uExposure;
    color = aces(color);

    // Linear -> display. The final pass owns the output transform.
    color = pow(color, vec3(1.0 / 2.2));

    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luma), color, uSaturation);
    color = (color - 0.5) * uContrast + 0.5;
    // A restrained cold shadow / warm highlight split.
    color += vec3(-0.004, 0.006, 0.009) * (1.0 - smoothstep(0.0, 0.5, luma));
    color *= vec3(1.002, 1.0, 0.997);

    float vignette = 1.0 - uVignette * smoothstep(0.18, 0.86, length(centered * vec2(1.0, 0.8)));
    color *= vignette;

    float grain = hash(vUv * uResolution + fract(uTime * 0.37) * 100.0) - 0.5;
    color += grain * uGrain;

    if (uLetterbox > 0.5) {
      float bars = max(0.0, 0.5 - (uAspect / uTargetAspect) * 0.5);
      if (vUv.y < bars || vUv.y > 1.0 - bars) color = vec3(0.0);
    }

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  }
`;

export interface PostOptions {
  letterbox: boolean;
  exposure?: number;
  bloom?: number;
}

/**
 * HDR scene -> thresholded bloom pyramid -> filmic composite.
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
  private width = 1;
  private height = 1;
  private options: Required<PostOptions>;

  constructor(renderer: WebGLRenderer, quality: QualityPreset, options: PostOptions) {
    this.renderer = renderer;
    this.quality = quality;
    this.options = {
      letterbox: options.letterbox,
      exposure: options.exposure ?? 1.12,
      bloom: options.bloom ?? 0.5,
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
        uThreshold: { value: 1.25 },
        uKnee: { value: 0.55 },
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
        uGrain: { value: 0.022 },
        uVignette: { value: 0.34 },
        uChromatic: { value: 1.0 },
        uLetterbox: { value: this.options.letterbox ? 1 : 0 },
        uAspect: { value: 16 / 9 },
        uTargetAspect: { value: 2.39 },
        uSaturation: { value: 1.05 },
        uContrast: { value: 1.035 },
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
    this.brightMaterial.uniforms.tSrc!.value = target.texture;
    this.brightMaterial.uniforms.uTexel!.value.set(1 / this.width, 1 / this.height);
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
    for (const target of this.bloomTargets) target.dispose();
    this.brightMaterial.dispose();
    this.downMaterial.dispose();
    this.upMaterial.dispose();
    this.finalMaterial.dispose();
    this.quad.geometry.dispose();
    this.quadScene.remove(this.quad);
  }
}

