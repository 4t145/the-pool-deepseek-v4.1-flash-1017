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

export interface TileTextureSet {
  albedo: Texture;
  normal: Texture;
  roughness: Texture;
  height: Texture;
  ao: Texture;
  /** World metres covered by one repeat of the set. */
  worldSize: number;
  /** Number of tiles across one repeat. */
  tiles: number;
  tileMetres: number;
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

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
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

/**
 * The tile set is generated at runtime rather than shipped as a texture: the
 * grout recess, bevel, per-tile tilt and dirt distribution are all physical
 * values that the lightmap / POM shader can use independently.
 *
 * Layout: one repeat = worldSize metres, containing `tiles` ceramic tiles.
 */
export function createTileTextures(renderer: WebGLRenderer, options: TileOptions = {}): TileTextureSet {
  const size = options.size ?? 2048;
  const tiles = options.tiles ?? 8;
  const worldSize = options.worldSize ?? 1;
  const seed = options.seed ?? 1337;
  const maxAniso = Math.min(renderer.capabilities.getMaxAnisotropy(), options.anisotropy ?? 16);

  const albedoCanvas = makeCanvas(size);
  const normalCanvas = makeCanvas(size);
  const roughnessCanvas = makeCanvas(size);
  const heightCanvas = makeCanvas(size);
  const aoCanvas = makeCanvas(size);

  const albedo = new ImageData(size, size);
  const normal = new ImageData(size, size);
  const rough = new ImageData(size, size);
  const heightPixels = new ImageData(size, size);
  const ao = new ImageData(size, size);

  const pitch = size / tiles;
  // 3 mm grout on a 125 mm tile.
  const groutHalf = 0.0125;
  const bevel = 0.05;

  const heightField = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = x / pitch;
      const gy = y / pitch;
      const col = Math.floor(gx);
      const row = Math.floor(gy);
      const fx = gx - col;
      const fy = gy - row;

      const edge = Math.min(fx, 1 - fx, fy, 1 - fy);
      const tileSeed = hash2(col, row, seed);
      const tileSeed2 = hash2(col + 71, row + 19, seed + 5);

      // The glaze sits slightly proud of the grout, with a soft chamfered edge.
      const mask = smoothstep(groutHalf, groutHalf + bevel, edge);
      const tilt = (tileSeed - 0.5) * 0.018 * (fx - 0.5) + (tileSeed2 - 0.5) * 0.018 * (fy - 0.5);
      const cellLift = (tileSeed - 0.5) * 0.014;
      const grain = (fbm(x * 0.055, y * 0.055, seed + 9, 3) - 0.5) * 0.012;
      const micro = (hash2(x, y, seed + 3) - 0.5) * 0.0035;
      let h = 0.16 + 0.65 * mask + cellLift * mask + tilt * mask + grain + micro;

      // A rare chipped corner: lower the bevel locally and darken the grout line.
      const chip = tileSeed2 > 0.955 && edge < 0.1 ? smoothstep(0.1, 0.02, edge) * 0.2 : 0;
      h -= chip;

      const idx = y * size + x;
      heightField[idx] = clamp(h, 0, 1);

      // ---- Albedo -------------------------------------------------------
      const broad = fbm(x * 0.012, y * 0.012, seed + 40, 2);
      const stain = smoothstep(0.62, 0.48, broad);
      const dirtEdge = 1 - smoothstep(groutHalf, groutHalf + 0.12, edge);

      const palette = [
        [0.913, 0.899, 0.848],
        [0.892, 0.900, 0.878],
        [0.868, 0.850, 0.800],
        [0.930, 0.918, 0.876],
        [0.838, 0.865, 0.835],
      ] as const;
      const base = palette[Math.floor(tileSeed * palette.length)] ?? palette[0];
      const perTile = 0.94 + tileSeed2 * 0.11;
      const speck = hash2(x * 3 + 17, y * 3 + 5, seed + 17);
      const fleck = speck > 0.9965 ? -0.23 : speck < 0.002 ? 0.08 : 0;
      const shade = perTile * (0.97 + 0.045 * broad) * (1 - 0.085 * dirtEdge) * (1 - 0.16 * stain);

      let ar = base[0] * shade + fleck;
      let ag = base[1] * shade + fleck * 0.9;
      let ab = base[2] * shade + fleck * 0.75;
      if (mask < 0.32) {
        const groutN = 0.82 + 0.36 * fbm(x * 0.14, y * 0.14, seed + 63, 2);
        const g = 0.315 * groutN;
        // Blend grout to tile over the chamfer so the transition is not a hard cartoon line.
        const blend = smoothstep(0.32, 0.0, mask);
        ar = ar * (1 - blend) + g * 1.02 * blend;
        ag = ag * (1 - blend) + g * 0.99 * blend;
        ab = ab * (1 - blend) + g * 0.86 * blend;
      }
      // A few hairline cracks, only on the rarest tiles.
      const crackSeed = hash2(col, row, seed + 91);
      if (crackSeed > 0.975) {
        const cx = hash2(col, row, seed + 12);
        const ang = hash2(col, row, seed + 34) * Math.PI;
        const dx = (fx - 0.25 - cx * 0.5) * Math.cos(ang) + (fy - 0.5) * Math.sin(ang);
        const crack = Math.exp(-Math.pow(dx / 0.004, 2)) * smoothstep(0.03, 0.12, edge);
        const dark = 1 - crack * 0.45;
        ar *= dark;
        ag *= dark;
        ab *= dark;
      }

      const aoValue = 0.52 + 0.48 * smoothstep(0.0, 0.16, mask) * (0.75 + 0.25 * mask);
      const roughness = mask > 0.5 ? 0.065 + 0.06 * broad + 0.22 * dirtEdge : 0.78 + 0.12 * broad;

      const o = idx * 4;
      albedo.data[o] = Math.round(clamp(ar, 0, 1) * 255);
      albedo.data[o + 1] = Math.round(clamp(ag, 0, 1) * 255);
      albedo.data[o + 2] = Math.round(clamp(ab, 0, 1) * 255);
      albedo.data[o + 3] = 255;

      rough.data[o] = Math.round(clamp(roughness, 0, 1) * 255);
      rough.data[o + 1] = Math.round(clamp(roughness, 0, 1) * 255);
      rough.data[o + 2] = Math.round(clamp(roughness, 0, 1) * 255);
      rough.data[o + 3] = 255;

      const aoByte = Math.round(clamp(aoValue, 0, 1) * 255);
      ao.data[o] = aoByte;
      ao.data[o + 1] = aoByte;
      ao.data[o + 2] = aoByte;
      ao.data[o + 3] = 255;

      const hp = Math.round(clamp(h, 0, 1) * 255);
      heightPixels.data[o] = hp;
      heightPixels.data[o + 1] = hp;
      heightPixels.data[o + 2] = hp;
      heightPixels.data[o + 3] = 255;
    }
  }

  // Tangent-space normals from the height field (wrapping sample).
  const strength = 2.4;
  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const dx =
        (heightField[y * size + xp] ?? 0) -
        (heightField[y * size + xm] ?? 0);
      const dy =
        (heightField[yp * size + x] ?? 0) -
        (heightField[ym * size + x] ?? 0);
      let nx = -dx * strength;
      let ny = -dy * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const o = (y * size + x) * 4;
      normal.data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      normal.data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normal.data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normal.data[o + 3] = 255;
    }
  }

  albedoCanvas.getContext('2d')?.putImageData(albedo, 0, 0);
  normalCanvas.getContext('2d')?.putImageData(normal, 0, 0);
  roughnessCanvas.getContext('2d')?.putImageData(rough, 0, 0);
  heightCanvas.getContext('2d')?.putImageData(heightPixels, 0, 0);
  aoCanvas.getContext('2d')?.putImageData(ao, 0, 0);

  return {
    albedo: canvasTexture(albedoCanvas, true, maxAniso),
    normal: canvasTexture(normalCanvas, false, maxAniso),
    roughness: canvasTexture(roughnessCanvas, false, maxAniso),
    height: canvasTexture(heightCanvas, false, maxAniso),
    ao: canvasTexture(aoCanvas, false, maxAniso),
    worldSize,
    tiles,
    tileMetres: worldSize / tiles,
  };
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
