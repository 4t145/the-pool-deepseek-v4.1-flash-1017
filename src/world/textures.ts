import {
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { hash2, Rng } from '../core/rng';
import { clamp, smoothstep } from '../core/math';
import { TILE, profileHeight } from '../core/tileMath';

export interface TileTextureSet {
  albedo: Texture;
  normal: Texture;
  roughness: Texture;
  height: Texture;
  ao: Texture;
  /** Seamless low-frequency dirt/stain field sampled in world metres. */
  grime: Texture;
  /** World metres covered by one repeat of the set. */
  worldSize: number;
  /** Number of tiles across one repeat (kept for world-UV math). */
  tiles: number;
  tileMetres: number;
  /** POM height-map resolution in pixels per tile edge. */
  heightSize: number;
  /** Glaze relief converted to tile UV units, for the parallax uniform. */
  reliefTileUnits: number;
  /** Suggested ray-march steps for the quality tier. */
  parallaxSteps: number;
}

interface TileOptions {
  size?: number;
  tiles?: number;
  worldSize?: number;
  seed?: number;
  anisotropy?: number;
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });

function makeCanvas(size: number, height = size): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = height;
  return canvas;
}

function canvasTexture(
  canvas: HTMLCanvasElement,
  srgb: boolean,
  anisotropy: number,
  wrap: typeof RepeatWrapping | typeof ClampToEdgeWrapping = RepeatWrapping,
): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.wrapS = wrap;
  texture.wrapT = wrap;
  texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  texture.anisotropy = anisotropy;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Smooth value noise, approximate but cheap. Input in pixels. */
function valueNoise(x: number, y: number, seed: number): number {
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

function fbm(x: number, y: number, seed: number, octaves = 3): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + i * 131);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

const wrapIndex = (value: number, period: number): number => ((value % period) + period) % period;

/** Value noise whose lattice wraps every `period` cells, so textures tile. */
function periodicNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = wrapIndex(xi, period);
  const y0 = wrapIndex(yi, period);
  const x1 = wrapIndex(xi + 1, period);
  const y1 = wrapIndex(yi + 1, period);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

function periodicFbm(x: number, y: number, period: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * periodicNoise(x * freq, y * freq, Math.max(1, Math.round(period * freq)), seed + i * 149);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * The tile set is generated at runtime rather than shipped as a texture: grout
 * recess, chamfer and glaze relief are physical values, and the shader needs
 * them in metres to do real parallax occlusion.
 *
 * One repeat of the generated maps is **one 125 mm tile**. Per-tile colour,
 * tilt and chipped corners are derived in the fragment shader from the tile's
 * integer world coordinates, so the building never shows a repeating block:
 * there is no `8×8` stamp to spot, only a repeated single-tile profile, which
 * is what real hand-set ceramic looks like.
 */
export function createTileTextures(renderer: WebGLRenderer, options: TileOptions = {}): TileTextureSet {
  const size = options.size ?? 2048;
  const tiles = options.tiles ?? 8;
  const worldSize = options.worldSize ?? 1;
  const seed = options.seed ?? 1337;
  const maxAniso = Math.min(renderer.capabilities.getMaxAnisotropy(), options.anisotropy ?? 16);
  const tileMetres = worldSize / tiles;

  const albedo = new ImageData(size, size);
  const normal = new ImageData(size, size);
  const heightPixels = new ImageData(size, size);
  const roughness = new ImageData(size, size);
  const ao = new ImageData(size, size);

  const heights = new Float32Array(size * size);

  // Pixel pitch in millimetres; used to derive physically-correct normal slopes
  // from the height field instead of guessing a normal-map strength.
  const spacingMm = (tileMetres * 1000) / size;
  const bevel = TILE.bevelMetres;
  const roll = TILE.rollMetres;
  const reliefMm = TILE.reliefMetres * 1000;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const edgeMm = Math.min(u, 1 - u, v, 1 - v) * tileMetres * 1000;
      const idx = y * size + x;

      // ---- Height field (millimetres above the grout floor) --------------
      const glazeMask = profileHeight(edgeMm / 1000, bevel, TILE.groutMetres, roll);
      // Slight wave in the fired glaze, plus grout pits.
      const warp = (periodicFbm(u * 26, v * 26, 26, seed + 11, 3) - 0.5) * 0.05;
      const pit = (periodicFbm(u * 90, v * 90, 90, seed + 71, 3) - 0.5) * 0.05;
      const groutFloor = (periodicFbm(u * 64, v * 64, 64, seed + 33, 3) - 0.5) * 0.04;
      const heightMm = glazeMask * reliefMm + (warp + pit) * glazeMask + groutFloor * (1 - glazeMask);
      heights[idx] = heightMm;

      // ---- Albedo --------------------------------------------------------
      const mottle = periodicFbm(u * 14, v * 14, 14, seed + 5, 3);
      const fine = periodicFbm(u * 70, v * 70, 70, seed + 9, 2);
      // Bone glaze: warm, never pure white. #e6e0d1-ish with a little cool
      // variation so the wall does not read as one flat cream.
      const glazeR = 0.9 + (mottle - 0.5) * 0.055 + (fine - 0.5) * 0.02;
      const glazeG = 0.882 + (mottle - 0.5) * 0.05 + (fine - 0.5) * 0.018;
      const glazeB = 0.824 + (mottle - 0.5) * 0.045 + (fine - 0.5) * 0.016;

      // Mid-grey, slightly warm grout. It must stay darker than the glaze but
      // not read as a black drawn line: the cavity AO below does that job.
      const groutTone = 0.47 + (periodicFbm(u * 48, v * 48, 48, seed + 63, 3) - 0.5) * 0.2;
      const groutR = groutTone * 1.02;
      const groutG = groutTone * 0.99;
      const groutB = groutTone * 0.9;

      // The chamfer catches dirt first: a dark line at the bottom of the
      // bevel, lighter towards the glaze.
      const bevelDirt = smoothstep(0.0, 0.12, glazeMask) * (1 - smoothstep(0.26, 0.62, glazeMask));
      const dirtR = 0.52;
      const dirtG = 0.49;
      const dirtB = 0.42;

      const mixBase = glazeMask;
      let r = groutR + (glazeR - groutR) * mixBase;
      let g = groutG + (glazeG - groutG) * mixBase;
      let b = groutB + (glazeB - groutB) * mixBase;
      r = r + (dirtR - r) * bevelDirt * 0.34;
      g = g + (dirtG - g) * bevelDirt * 0.34;
      b = b + (dirtB - b) * bevelDirt * 0.34;

      // Sparse glaze flecks (iron spots in cheap ceramic), a handful per tile.
      const fleck = hash2(x * 3 + 17, y * 3 + 5, seed + 17);
      if (fleck > 0.9975) {
        r *= 0.62;
        g *= 0.6;
        b *= 0.58;
      } else if (fleck < 0.0016) {
        r = Math.min(1, r * 1.08);
        g = Math.min(1, g * 1.07);
        b = Math.min(1, b * 1.06);
      }

      const o = idx * 4;
      albedo.data[o] = Math.round(clamp(r, 0, 1) * 255);
      albedo.data[o + 1] = Math.round(clamp(g, 0, 1) * 255);
      albedo.data[o + 2] = Math.round(clamp(b, 0, 1) * 255);
      albedo.data[o + 3] = 255;

      // ---- Roughness / AO ------------------------------------------------
      // Glaze is near-mirror; the grout joint and chamfer are the only rough
      // parts, which is what makes the grout read as a groove.
      const glazeRough = 0.05 + mottle * 0.05 + (fleck > 0.99 ? 0.08 : 0);
      const groutRough = 0.72 + periodicFbm(u * 40, v * 40, 40, seed + 91, 2) * 0.18;
      const roughnessValue = glazeRough + (groutRough - glazeRough) * (1 - glazeMask);
      const roughByte = Math.round(clamp(roughnessValue, 0, 1) * 255);
      roughness.data[o] = roughByte;
      roughness.data[o + 1] = roughByte;
      roughness.data[o + 2] = roughByte;
      roughness.data[o + 3] = 255;

      // Cavity AO: deepest in the grout joint, plus a soft gradient up the
      // chamfer. This is contact darkening inside one tile, not a room bake.
      // Contact shadow in the joint, fading up the rolled glaze edge. This is
      // what makes the grout read as a groove at a distance even when the
      // bevel itself is below one pixel.
      const aoValue = 0.52 + 0.48 * smoothstep(0.0, 0.42, glazeMask) + 0.05 * bevelDirt;
      const aoByte = Math.round(clamp(aoValue, 0, 1) * 255);
      ao.data[o] = aoByte;
      ao.data[o + 1] = aoByte;
      ao.data[o + 2] = aoByte;
      ao.data[o + 3] = 255;

      const heightByte = Math.round(clamp(heightMm / reliefMm, 0, 1) * 255);
      heightPixels.data[o] = heightByte;
      heightPixels.data[o + 1] = heightByte;
      heightPixels.data[o + 2] = heightByte;
      heightPixels.data[o + 3] = 255;
    }
  }

  // Tangent-space normals from the metric height field. Central differences in
  // millimetres; canvas textures flip Y, so the image row direction maps to -v.
  const sampleHeight = (x: number, y: number): number => heights[wrapIndex(y, size) * size + wrapIndex(x, size)]!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dhdu = (sampleHeight(x + 1, y) - sampleHeight(x - 1, y)) / (2 * spacingMm);
      const dhdv = -(sampleHeight(x, y + 1) - sampleHeight(x, y - 1)) / (2 * spacingMm);
      const nx = -dhdu;
      const ny = -dhdv;
      const nz = 1;
      const length = Math.hypot(nx, ny, nz);
      const o = (y * size + x) * 4;
      normal.data[o] = Math.round((nx / length) * 127.5 + 127.5);
      normal.data[o + 1] = Math.round((ny / length) * 127.5 + 127.5);
      normal.data[o + 2] = Math.round((nz / length) * 127.5 + 127.5);
      normal.data[o + 3] = 255;
    }
  }

  const albedoCanvas = makeCanvas(size);
  const normalCanvas = makeCanvas(size);
  const roughnessCanvas = makeCanvas(size);
  const heightCanvas = makeCanvas(size);
  const aoCanvas = makeCanvas(size);
  albedoCanvas.getContext('2d')?.putImageData(albedo, 0, 0);
  normalCanvas.getContext('2d')?.putImageData(normal, 0, 0);
  roughnessCanvas.getContext('2d')?.putImageData(roughness, 0, 0);
  heightCanvas.getContext('2d')?.putImageData(heightPixels, 0, 0);
  aoCanvas.getContext('2d')?.putImageData(ao, 0, 0);

  const grime = createGrimeTexture(renderer, 512, seed + 401, maxAniso);

  return {
    albedo: canvasTexture(albedoCanvas, true, maxAniso),
    normal: canvasTexture(normalCanvas, false, maxAniso),
    roughness: canvasTexture(roughnessCanvas, false, maxAniso),
    height: canvasTexture(heightCanvas, false, maxAniso),
    ao: canvasTexture(aoCanvas, false, maxAniso),
    grime,
    worldSize,
    tiles,
    tileMetres,
    heightSize: size,
    reliefTileUnits: TILE.reliefMetres / tileMetres,
    parallaxSteps: size >= 2048 ? 12 : 8,
  };
}

/**
 * Seamless multi-octave dirt field. One repeat covers a few metres, sampled in
 * world metres by the tile shader for drip streaks, blotching and algae drift.
 */
export function createGrimeTexture(renderer: WebGLRenderer, size = 512, seed = 77, anisotropy = 8): Texture {
  const canvas = makeCanvas(size);
  const image = new ImageData(size, size);
  const coarsePeriod = 6;
  const finePeriod = 24;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const coarse = periodicFbm(u * coarsePeriod, v * coarsePeriod, coarsePeriod, seed, 4);
      const fine = periodicFbm(u * finePeriod, v * finePeriod, finePeriod, seed + 37, 3);
      const value = clamp(coarse * 0.72 + fine * 0.28, 0, 1);
      const o = (y * size + x) * 4;
      const byte = Math.round(value * 255);
      image.data[o] = byte;
      image.data[o + 1] = byte;
      image.data[o + 2] = byte;
      image.data[o + 3] = 255;
    }
  }
  canvas.getContext('2d')?.putImageData(image, 0, 0);
  const texture = canvasTexture(canvas, false, Math.min(renderer.capabilities.getMaxAnisotropy(), anisotropy));
  texture.name = 'tile.grime';
  return texture;
}

/** Tileable normal map for the water surface. Two layers are scrolled in the shader. */
export function createWaterNormalTexture(renderer: WebGLRenderer, size = 512, seed = 820): Texture {
  const canvas = makeCanvas(size);
  const image = new ImageData(size, size);
  const height = new Float32Array(size * size);

  const waves: Array<{ fx: number; fy: number; amp: number; phase: number }> = [];
  const rng = new Rng(seed);
  for (let i = 0; i < 9; i++) {
    waves.push({
      fx: rng.int(1, 7),
      fy: rng.int(1, 7),
      amp: rng.range(0.4, 1.0) / (1 + i * 0.35),
      phase: rng.range(0, Math.PI * 2),
    });
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let h = 0;
      for (const w of waves) {
        h += w.amp * Math.sin((u * w.fx + v * w.fy) * Math.PI * 2 + w.phase);
      }
      // A little ridge detail keeps highlights from looking like a pure sine.
      h += 0.25 * Math.sin((u * 13 - v * 9) * Math.PI * 2 + 1.2);
      height[y * size + x] = h;
    }
  }

  const normalStrength = 1.4;
  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const dx = (height[y * size + xp] ?? 0) - (height[y * size + xm] ?? 0);
      const dy = (height[yp * size + x] ?? 0) - (height[ym * size + x] ?? 0);
      const nx = -dx * normalStrength;
      const ny = -dy * normalStrength;
      const nz = 8;
      const len = Math.hypot(nx, ny, nz);
      const o = (y * size + x) * 4;
      image.data[o] = Math.round((nx / len) * 127.5 + 127.5);
      image.data[o + 1] = Math.round((ny / len) * 127.5 + 127.5);
      image.data[o + 2] = Math.round((nz / len) * 127.5 + 127.5);
      image.data[o + 3] = 255;
    }
  }
  const ctx = canvas.getContext('2d');
  ctx?.putImageData(image, 0, 0);
  const texture = canvasTexture(canvas, false, Math.min(renderer.capabilities.getMaxAnisotropy(), 16));
  return texture;
}

export function createNoiseTexture(renderer: WebGLRenderer, size = 512, seed = 77): Texture {
  const canvas = makeCanvas(size);
  const image = new ImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.02, y * 0.02, seed, 5) * 0.7 + fbm(x * 0.12, y * 0.12, seed + 3, 3) * 0.3;
      const o = (y * size + x) * 4;
      const v = Math.round(clamp(n, 0, 1) * 255);
      image.data[o] = v;
      image.data[o + 1] = v;
      image.data[o + 2] = v;
      image.data[o + 3] = 255;
    }
  }
  canvas.getContext('2d')?.putImageData(image, 0, 0);
  return canvasTexture(canvas, false, Math.min(renderer.capabilities.getMaxAnisotropy(), 8));
}

/** Painted enamel sign, used for the depth markers and the no-diving notice. */
export function createSignTexture(
  lines: readonly string[],
  options: { width?: number; height?: number; background?: string; ink?: string; border?: boolean } = {},
): Texture {
  const width = options.width ?? 1024;
  const height = options.height ?? 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  ctx.fillStyle = options.background ?? '#203b3f';
  ctx.fillRect(0, 0, width, height);
  // Worn enamel: a few broad translucent scuffs.
  for (let i = 0; i < 26; i++) {
    const rx = hash2(i, 1, 4) * width;
    const ry = hash2(i, 2, 4) * height;
    const rw = 20 + hash2(i, 3, 4) * 220;
    const rh = 2 + hash2(i, 4, 4) * 10;
    ctx.fillStyle = `rgba(255,255,255,${0.015 + hash2(i, 5, 4) * 0.035})`;
    ctx.fillRect(rx, ry, rw, rh);
  }
  if (options.border !== false) {
    ctx.strokeStyle = options.ink ?? '#e8e4d8';
    ctx.lineWidth = 6;
    ctx.strokeRect(28, 28, width - 56, height - 56);
  }
  ctx.fillStyle = options.ink ?? '#e8e4d8';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineHeight = height / (lines.length + 1.2);
  lines.forEach((line, index) => {
    const fontSize = Math.min(height * 0.22, (width / Math.max(line.length * 0.62, 1)) * 1.15);
    ctx.font = `600 ${fontSize}px "Helvetica Neue", Arial, sans-serif`;
    ctx.fillText(line, width / 2, lineHeight * (index + 1), width * 0.84);
  });
  return canvasTexture(canvas, true, 8, ClampToEdgeWrapping);
}

/** Soft, slightly dirty vinyl striping for the inflatable rings. */
export function createVinylTexture(renderer: WebGLRenderer, colorA: string, colorB: string): Texture {
  const width = 512;
  const height = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  ctx.fillStyle = colorA;
  ctx.fillRect(0, 0, width, height);
  const bands = 4;
  for (let i = 0; i < bands; i++) {
    if (i % 2 === 0) continue;
    ctx.fillStyle = colorB;
    ctx.fillRect((i / bands) * width, 0, width / bands, height);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect((i / bands) * width, 0, 6, height);
  }
  for (let i = 0; i < 220; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.01 + hash2(i, 8, 9) * 0.05})`;
    ctx.fillRect(hash2(i, 6, 9) * width, hash2(i, 7, 9) * height, 1 + hash2(i, 9, 9) * 6, 1);
  }
  const texture = canvasTexture(canvas, true, Math.min(renderer.capabilities.getMaxAnisotropy(), 8));
  return texture;
}

/** Await a paint so the loader can show progress during long procedural builds. */
export const yieldToPaint = nextFrame;
