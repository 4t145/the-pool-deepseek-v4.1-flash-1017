import {
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  LinearFilter,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import { hash2 } from '../core/rng';

/**
 * Procedural emissive-pane textures owned by the lighting lane. These are not
 * architectural tile maps (w4 owns those); they give the clipped window and
 * skylight highlights internal structure — frost, dirt, seams, per-bay exposure
 * variation — so the brightest areas of the frame still carry detail instead of
 * clipping to a flat white rectangle.
 *
 * All textures are 8-bit sRGB modulation maps; their HDR radiance comes from the
 * owning material's linear colour, keeping the single-display-transform contract.
 */

function makeTexture(width: number, height: number, fill: (x: number, y: number, out: number[]) => void): DataTexture {
  const data = new Uint8Array(width * height * 4);
  const out = [0, 0, 0, 255];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      fill(x, y, out);
      const offset = (y * width + x) * 4;
      data[offset] = Math.max(0, Math.min(255, Math.round(out[0])));
      data[offset + 1] = Math.max(0, Math.min(255, Math.round(out[1])));
      data[offset + 2] = Math.max(0, Math.min(255, Math.round(out[2])));
      data[offset + 3] = 255;
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function smoothNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/**
 * A frosted pane: brighter toward the sky, dimmer at the sill, faint vertical
 * drip streaks and a grimy frame contact band. `base` is the peak value before
 * the material's HDR colour multiplies it.
 */
export function createFrostedPaneTexture(width = 256, height = 384, seed = 4113): DataTexture {
  return makeTexture(width, height, (x, y, out) => {
    const u = x / (width - 1);
    const v = y / (height - 1); // 0 = sill, 1 = head
    const vertical = 0.62 + 0.38 * Math.pow(v, 0.72);
    const frost = smoothNoise(u * 5.5, v * 9, seed) * 0.1 + smoothNoise(u * 21, v * 34, seed + 1) * 0.05;
    // Drip streaks run down the pane.
    const streak = smoothNoise(u * 26, v * 1.4 + 3.7, seed + 2);
    const dirt = Math.pow(1 - v, 2.1) * 0.18 + streak * 0.045;
    // Grime where the pane meets the frame.
    const edge = Math.min(u, 1 - u, v, 1 - v);
    const border = 1 - 0.2 * (1 - Math.min(1, edge / 0.06));
    const value = Math.max(0, Math.min(1, (vertical + frost - dirt) * border));
    out[0] = value * 245;
    out[1] = value * 252;
    out[2] = value * 255;
    out[3] = 255;
  });
}

/**
 * A long skylight run: a soft exposure gradient plus per-bay variation and dirty
 * seams aligned with the structural mullions. `bays` and `seamOffset` are in UV
 * space so the seams can sit on the existing mullion geometry.
 */
export function createSkylightTexture(
  width = 64,
  height = 1024,
  options: { bays?: number; seamOffset?: number; seed?: number } = {},
): DataTexture {
  const bays = options.bays ?? 9;
  const seamOffset = options.seamOffset ?? 0.055;
  const seed = options.seed ?? 9271;
  return makeTexture(width, height, (x, y, out) => {
    const u = x / (width - 1);
    const v = y / (height - 1);
    // A gentle lengthwise gradient: the far half catches a little more sky.
    const gradient = 0.86 + 0.14 * v;
    const bay = Math.floor((v - seamOffset) * bays + 0.5);
    const bayVariation = 0.94 + 0.12 * hash2(bay, 7, seed);
    const seamPhase = (v - seamOffset) * bays;
    const seamDistance = Math.abs(seamPhase - Math.round(seamPhase)) / bays;
    const seam = 1 - 0.16 * Math.max(0, 1 - seamDistance / 0.006);
    // Frosted-glass dirt and a couple of long streaks.
    const dirt = smoothNoise(u * 4, v * 46, seed + 3) * 0.06 + smoothNoise(u * 9, v * 3.2, seed + 4) * 0.035;
    const value = Math.max(0, Math.min(1, gradient * bayVariation * seam - dirt * 0.6));
    out[0] = value * 246;
    out[1] = value * 251;
    out[2] = value * 252;
    out[3] = 255;
  });
}

/**
 * The warm opening at the far end: a doorway-shaped glow with a soft vertical
 * falloff and two suggestion-of-corridor silhouettes, so the arch never reads as
 * a flat orange rectangle.
 */
export function createWarmDoorwayTexture(width = 256, height = 384, seed = 7717): DataTexture {
  return makeTexture(width, height, (x, y, out) => {
    const u = x / (width - 1);
    const v = y / (height - 1);
    // Bright at eye height, falling off toward the floor and the head.
    const vertical = 0.55 + 0.45 * Math.exp(-Math.pow((v - 0.52) / 0.4, 2));
    const horizontal = 1 - 0.35 * Math.pow(Math.abs(u - 0.5) * 2, 2.2);
    const haze = smoothNoise(u * 3.2, v * 5.5, seed) * 0.08;
    // Two dark verticals read as a far doorframe inside the glow.
    const farFrame = Math.min(
      Math.abs(u - 0.34) < 0.012 || Math.abs(u - 0.66) < 0.012 ? 0.62 : 1,
      Math.abs(v - 0.72) < 0.008 ? 0.75 : 1,
    );
    const value = Math.max(0, Math.min(1, (vertical * horizontal + haze) * farFrame));
    out[0] = value * 255;
    out[1] = value * 196;
    out[2] = value * 138;
    out[3] = 255;
  });
}

/** Linear HDR colour helper for the emissive materials. */
export function hdrColor(hex: number, intensity: number): Color {
  return new Color(hex).multiplyScalar(intensity);
}
