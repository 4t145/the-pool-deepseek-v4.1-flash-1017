/**
 * Display / post math for THE POOL.
 *
 * This module is the CPU reference for the final composite in
 * `src/render/PostPipeline.ts`. The shader mirrors these formulations exactly;
 * the unit tests here pin the properties the render must have (single display
 * transform, highlight containment, contained bloom, deterministic grain,
 * correct letterbox). Keep the two in sync when changing a curve.
 *
 * Colour convention: the scene target is linear sRGB HDR. `aces()` and
 * `agx()` return *display-linear* values (what a monitor would see before the
 * sRGB transfer function). `srgbEncode()` applies that transfer exactly once.
 * There is no second tone map or gamma stage anywhere in the chain.
 */

export type ToneCurveName = 'agx' | 'aces';
export type Rgb = readonly [number, number, number];

/** Threshold above which the bloom bright-pass starts contributing (linear HDR, pre-exposure). */
export const BLOOM_THRESHOLD = 1.5;
/** Soft-knee width around the bloom threshold; keeps the highlight ramp continuous. */
export const BLOOM_KNEE = 0.35;
/** Peak bloom multiplier of the whole chain (the API value scales this). */
export const BLOOM_GAIN = 0.68;
/** Fine monochrome grain amplitude in display units. */
export const GRAIN_AMOUNT = 0.017;
/** Vignette strength at the frame corners. */
export const VIGNETTE_AMOUNT = 0.24;
/** Edge chromatic aberration scale (UV units at the frame corner, before masking). */
export const CHROMATIC_AMOUNT = 1.0;
/** Saturation and contrast of the contained grade (display space). */
export const GRADE_SATURATION = 1.09;
export const GRADE_CONTRAST = 1.1;
/** Grain cadence; the trailer steps the clock at exactly this rate. */
export const GRAIN_FRAME_RATE = 24;
/** Optional 2.39:1 presentation mask. */
export const LETTERBOX_ASPECT = 2.39;

const ACES_INPUT = [
  0.59719, 0.076, 0.0284,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777,
] as const;

const ACES_OUTPUT = [
  1.60475, -0.10208, -0.00327,
  -0.53108, 1.10813, -0.07276,
  -0.07367, -0.00605, 1.07602,
] as const;

// three.js r186 AgX constants (column-major, copied verbatim from
// ShaderChunk/tonemapping_pars_fragment so the CPU and GPU agree).
const AGX_INSET = [
  0.856627153315983, 0.137318972929847, 0.11189821299995,
  0.0951212405381588, 0.761241990602591, 0.0767994186031903,
  0.0482516061458583, 0.101439036467562, 0.811302368396859,
] as const;

const AGX_OUTSET = [
  1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
  -0.11060664309660323, 1.157823702216272, -0.11060664309660294,
  -0.016493938717834573, -0.016493938717834257, 1.2519364065950405,
] as const;

const REC2020_FROM_SRGB = [
  0.6274, 0.0691, 0.0164,
  0.3293, 0.9195, 0.088,
  0.0433, 0.0113, 0.8956,
] as const;

const SRGB_FROM_REC2020 = [
  1.6605, -0.1246, -0.0182,
  -0.5876, 1.1329, -0.1006,
  -0.0728, -0.0083, 1.1187,
] as const;

const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Column-major 3x3 * column vector, matching GLSL's `mat3 * vec3`. */
function mat3mul(m: readonly number[], v: Rgb): [number, number, number] {
  return [
    m[0]! * v[0] + m[3]! * v[1] + m[6]! * v[2],
    m[1]! * v[0] + m[4]! * v[1] + m[7]! * v[2],
    m[2]! * v[0] + m[5]! * v[1] + m[8]! * v[2],
  ];
}

const mapRgb = (v: Rgb, fn: (value: number) => number): [number, number, number] => [
  fn(v[0]),
  fn(v[1]),
  fn(v[2]),
];

/**
 * ACES filmic fitted curve (Stephen Hill's RRT+ODT approximation). Returns
 * display-linear values. Exposure is applied by the caller; unlike three.js we
 * do not apply the 1/0.6 viewing-environment boost — the shot exposure is the
 * only creative control.
 */
export function aces(rgb: Rgb): [number, number, number] {
  let color = mat3mul(ACES_INPUT, rgb);
  color = mapRgb(color, (v) => {
    const a = v * (v + 0.0245786) - 0.000090537;
    const b = v * (0.983729 * v + 0.432951) + 0.238081;
    return a / b;
  });
  color = mat3mul(ACES_OUTPUT, color);
  return color.map(clamp01) as [number, number, number];
}

/** Approximate AgX contrast sigmoid used by three.js/Filament (log-encoded input). */
export function agxContrast(value: number): number {
  const x2 = value * value;
  const x4 = x2 * x2;
  return (
    15.5 * x4 * x2 -
    40.14 * x4 * value +
    31.96 * x4 -
    6.868 * x2 * value +
    0.4298 * x2 +
    0.1191 * value -
    0.00232
  );
}

/**
 * AgX (Blender/Filament via three.js r186). Returns display-linear values with
 * the same internal curve as three's AgXToneMapping, including the AgX output
 * transfer; the caller still applies `srgbEncode()` exactly once. AgX keeps
 * highlight structure better than ACES on this scene, which is why it is the
 * default display transform.
 */
export function agx(rgb: Rgb, exposure = 1): [number, number, number] {
  let color: Rgb = [rgb[0] * exposure, rgb[1] * exposure, rgb[2] * exposure];
  color = mat3mul(REC2020_FROM_SRGB, color);
  color = mat3mul(AGX_INSET, color);
  color = mapRgb(color, (v) => Math.log2(Math.max(v, 1e-10)));
  color = mapRgb(color, (v) => clamp01((v - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV)));
  color = mapRgb(color, agxContrast);
  color = mat3mul(AGX_OUTSET, color);
  color = mapRgb(color, (v) => Math.pow(Math.max(0, v), 2.2));
  color = mat3mul(SRGB_FROM_REC2020, color);
  return color.map(clamp01) as [number, number, number];
}

/** Single display transform. `exposure` is part of the transform, applied once. */
export function toneMap(rgb: Rgb, exposure: number, curve: ToneCurveName): [number, number, number] {
  const exposed: Rgb = [rgb[0] * exposure, rgb[1] * exposure, rgb[2] * exposure];
  return curve === 'agx' ? agx(exposed, 1) : aces(exposed);
}

/** Exact sRGB OETF (linear -> display). This is the one and only gamma encode. */
export function srgbEncode(value: number): number {
  const v = Math.max(0, value);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Inverse sRGB transfer, for tests and tooling. */
export function srgbDecode(value: number): number {
  const v = Math.max(0, value);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * Bloom bright-pass. Mirrors the shader exactly: a C1-continuous soft knee of
 * width `knee` around the threshold, then the excess is carried through scaled
 * per channel so the halo keeps its hue. Everything at or below
 * `threshold - knee` contributes exactly zero; the knee only lets near-emissive
 * highlights ramp in instead of popping.
 */
export function brightPass(rgb: Rgb, threshold = BLOOM_THRESHOLD, knee = BLOOM_KNEE): [number, number, number] {
  const luminance = Math.max(rgb[0], rgb[1], rgb[2]);
  const safeKnee = Math.max(knee, 1e-4);
  const soft = Math.min(Math.max(0, luminance - threshold + safeKnee), 2 * safeKnee);
  const kneeWeight = (soft * soft) / (4 * safeKnee);
  const contribution = Math.max(kneeWeight, luminance - threshold) / Math.max(luminance, 1e-4);
  return [rgb[0] * contribution, rgb[1] * contribution, rgb[2] * contribution];
}

/** Camera layer used by the half-res emissive mask pass. */
export const BLOOM_MASK_LAYER = 1;

/**
 * Emissive-mask classification for the bloom pass. A mesh contributes bloom
 * only when it carries a light-emitting material: materials that opt out of
 * tone mapping (`toneMapped: false`) or explicitly set `userData.bloom = true`;
 * `userData.bloom = false` always wins so volumetric/additive surfaces can opt
 * out. Kept pure so the render chain's containment rule is unit-tested.
 */
export interface BloomMaterialFlags {
  toneMapped?: boolean;
  userData?: { bloom?: boolean; [key: string]: unknown };
}

export function isBloomEmitter(material: BloomMaterialFlags): boolean {
  const override = material.userData?.bloom;
  if (override === true) return true;
  if (override === false) return false;
  return material.toneMapped === false;
}

/** Integer hash used by the deterministic grain/dither (stable across runs). */
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Grain frame index: quantised to 24 fps and safe for `renderAt(t)` determinism. */
export function grainFrame(time: number, frameRate = GRAIN_FRAME_RATE): number {
  return Math.floor(Math.max(0, time) * frameRate + 0.0001);
}

/**
 * Monochrome grain sample in [-1, 1]. Deterministic for (pixel, frame) so two
 * `renderAt(t)` captures are identical; stronger in shadows than in highlights.
 * Uses a triangular PDF (difference of two uniforms) so it reads as film rather
 * than digital noise.
 */
export function filmGrain(
  pixelX: number,
  pixelY: number,
  frame: number,
  displayLuminance: number,
  amount = GRAIN_AMOUNT,
): number {
  const a = hash3(pixelX, pixelY, frame);
  const b = hash3(pixelX + 101, pixelY + 37, frame + 13);
  const triangular = a + b - 1;
  const shadowWeight = lerp(1.35, 0.55, clamp01((displayLuminance - 0.03) / 0.62));
  return triangular * amount * shadowWeight;
}

/** Triangular dither in ±0.5/255 display units; kills gradients banding before encode. */
export function dither(pixelX: number, pixelY: number, frame: number): number {
  const a = hash3(pixelX + 17, pixelY + 89, frame + 5);
  const b = hash3(pixelX + 61, pixelY + 23, frame + 29);
  return (a + b - 1) / 510;
}

/**
 * Height of one letterbox bar as a fraction of the image height. A 16:9 canvas
 * showing a 2.39:1 frame gets the classic top/bottom bars; frames already wider
 * than the target keep the full image (no side masks in this pipeline).
 */
export function letterboxBars(aspect: number, targetAspect = LETTERBOX_ASPECT): number {
  if (!(aspect < targetAspect)) return 0;
  return (1 - aspect / targetAspect) / 2;
}

/** Radial chromatic aberration in UV units; zero at the centre, grows to the edge. */
export function chromaticOffsetUv(u: number, v: number, amount = CHROMATIC_AMOUNT): [number, number] {
  const cx = u - 0.5;
  const cy = v - 0.5;
  const r2 = cx * cx + cy * cy;
  const scale = amount * 0.004 * r2 * r2;
  return [cx * scale, cy * scale];
}

/** Vignette multiplier in [0,1]; exactly 1 in the centre, softened toward the corners. */
export function vignetteFactor(u: number, v: number, amount = VIGNETTE_AMOUNT): number {
  const cx = u - 0.5;
  const cy = (v - 0.5) * 0.82;
  const radius = Math.hypot(cx, cy);
  const t = clamp01((radius - 0.18) / (0.72 - 0.18));
  const smooth = t * t * (3 - 2 * t);
  return 1 - amount * smooth;
}

/**
 * Contained display grade applied after the single tone map: gentle saturation,
 * a touch of contrast, cool shadows / warm highlights. Kept tiny on purpose —
 * contrast must come from light, not from a LUT.
 */
export function grade(rgb: Rgb, saturation = GRADE_SATURATION, contrast = GRADE_CONTRAST): [number, number, number] {
  const luma = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  let color = [
    luma + (rgb[0] - luma) * saturation,
    luma + (rgb[1] - luma) * saturation,
    luma + (rgb[2] - luma) * saturation,
  ];
  color = color.map((v) => (v - 0.5) * contrast + 0.5);
  const shadow = 1 - clamp01((luma - 0.02) / 0.42);
  const highlight = clamp01((luma - 0.62) / 0.38);
  color = [
    color[0]! - 0.0035 * shadow + 0.005 * highlight,
    color[1]! + 0.0045 * shadow + 0.002 * highlight,
    color[2]! + 0.009 * shadow - 0.0025 * highlight,
  ];
  return color.map(clamp01) as [number, number, number];
}

/** CPU mirror of the final composite, used by tests and offline checks. */
export function compositeDisplay(
  hdr: Rgb,
  bloom: Rgb,
  options: { exposure?: number; bloomStrength?: number; curve?: ToneCurveName } = {},
): [number, number, number] {
  const exposure = options.exposure ?? 1.25;
  const bloomStrength = options.bloomStrength ?? 0.34;
  const curve = options.curve ?? 'agx';
  const combined: Rgb = [
    hdr[0] + bloom[0] * bloomStrength * BLOOM_GAIN,
    hdr[1] + bloom[1] * bloomStrength * BLOOM_GAIN,
    hdr[2] + bloom[2] * bloomStrength * BLOOM_GAIN,
  ];
  const mapped = toneMap(combined, exposure, curve);
  return mapped.map(srgbEncode) as [number, number, number];
}
