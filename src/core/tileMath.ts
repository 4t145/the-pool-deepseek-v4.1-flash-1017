import { clamp, smoothstep } from './math';

/**
 * Physical constants for the pool's glazed ceramic. The shader and the texture
 * generator both build on these numbers, so a change here moves the whole
 * building's tile scale at once — the same contract `applyWorldUVs` has.
 *
 * The acceptance brief asks for 125 mm tiles, 2.5–3 mm grout and a 1.5 mm
 * chamfer; the glaze sits ~1.2 mm proud of the grout course.
 */
export const TILE = {
  /** Nominal tile pitch, metres (125 mm). */
  metres: 0.125,
  /** Grout joint width, metres. */
  groutMetres: 0.003,
  /** Chamfer from grout floor up to the start of the glaze roll, metres. */
  bevelMetres: 0.0015,
  /** Rounded glaze edge from the chamfer out to the flat face, metres. */
  rollMetres: 0.0065,
  /** Glaze height above the bottom of the grout joint, metres. */
  reliefMetres: 0.0022,
  /** Vertical spacing of the submerged algae band, metres. */
  algaeWidthMetres: 0.3,
} as const;

/** Tiles per world metre (8 for 125 mm tile). */
export const tilesPerMetre = (metresPerTile: number = TILE.metres): number => 1 / metresPerTile;

export interface TileCell {
  /** Integer tile coordinates in the world grid. */
  ix: number;
  iy: number;
  /** Tile-local coordinates in [0, 1). */
  u: number;
  v: number;
  /** Distance from the tile edge, metres. */
  edgeMetres: number;
}

/** Split world UV (metres) into tile index + local coordinates. */
export function tileCell(worldU: number, worldV: number, metresPerTile: number = TILE.metres): TileCell {
  const gx = worldU / metresPerTile;
  const gy = worldV / metresPerTile;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const u = gx - ix;
  const v = gy - iy;
  const edge = Math.min(u, 1 - u, v, 1 - v) * metresPerTile;
  return { ix, iy, u, v, edgeMetres: edge };
}

/**
 * Analytic cross-section of one tile, 0 at the grout floor and 1 on the flat
 * glaze. Two stages, as real pressed ceramic has: a steep 1.5 mm chamfer where
 * the glaze breaks, then a soft rolled-over edge (the glaze pools and rounds)
 * that catches a broad highlight. Mirrored exactly in the tile shader's
 * texture generator.
 */
export function profileHeight(
  edgeMetres: number,
  bevelMetres: number = TILE.bevelMetres,
  groutMetres: number = TILE.groutMetres,
  rollMetres: number = TILE.rollMetres,
): number {
  const groutHalf = groutMetres * 0.5;
  const chamfer = smoothstep(groutHalf, groutHalf + bevelMetres, edgeMetres);
  const roll = smoothstep(groutHalf + bevelMetres, groutHalf + bevelMetres + rollMetres, edgeMetres);
  return chamfer * 0.3 + roll * 0.7;
}

/** Height of the ceramic surface above the grout floor, in metres. */
export function reliefHeightMetres(edgeMetres: number): number {
  return profileHeight(edgeMetres) * TILE.reliefMetres;
}

/**
 * Maximum texture-space offset a parallax ray can reach, in tile units. The
 * fragment shader walks the height field along this direction; clamping it
 * keeps grazing-angle pixels from smearing across several tiles.
 */
export function parallaxOffsetTiles(
  reliefMetres: number = TILE.reliefMetres,
  metresPerTile: number = TILE.metres,
  viewNormalComponent = 1,
  maxOffsetTiles = 0.35,
): number {
  const vn = Math.max(Math.abs(viewNormalComponent), 0.12);
  return Math.min(reliefMetres / (metresPerTile * vn), maxOffsetTiles);
}

/**
 * How much of the high-frequency tile detail survives at a given screen-space
 * footprint (tile units per pixel). Beyond ~0.75 tile/pixel the bevel is below
 * the pixel and must fade to the tile average or it moires.
 */
export function detailFade(footprintTiles: number, start = 0.18, end = 0.75): number {
  return 1 - smoothstep(start, end, footprintTiles);
}

/**
 * Per-tile colour variation is procedural, so it is not mip-filtered and must
 * fade out earlier than the albedo detail to avoid a shimmering check pattern
 * on distant walls.
 */
export function variationFade(footprintTiles: number, start = 0.45, end = 1.8): number {
  return 1 - smoothstep(start, end, footprintTiles);
}

/** Screen-space footprint for one dimension: UV units per pixel. */
export function footprintFromDerivative(duv: number): number {
  return Math.abs(duv);
}

/** Mirrors the GLSL `tileHash` used for per-tile variation (0..1). */
export function tileHash(ix: number, iy: number): number {
  const s = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Gaussian band around the waterline. `underwaterWeight` biases the band so a
 * submerged wall keeps more growth below the surface than above it.
 */
export function waterlineBand(y: number, waterlineY = 0, widthMetres = TILE.algaeWidthMetres, underwaterWeight = 1): number {
  const below = y <= waterlineY;
  const width = widthMetres * (below ? Math.max(underwaterWeight, 0.05) : 0.55);
  const t = (y - waterlineY) / Math.max(width, 1e-4);
  return Math.exp(-t * t);
}

/** Algae tint strength: waterline band gated by a slow drift noise. */
export function algaeStrength(y: number, waterlineY: number, noise: number, amount: number, widthMetres = TILE.algaeWidthMetres): number {
  const band = waterlineBand(y, waterlineY, widthMetres);
  const drift = clamp(0.45 + 0.75 * noise, 0, 1.2);
  return clamp(band * drift * amount, 0, 1);
}

/**
 * Chip mask for a rare broken corner. `u`/`v` are tile-local, `corner` selects
 * which corner (0/1 on each axis), `radius` is in tile units.
 */
export function chipMask(u: number, v: number, cornerU: number, cornerV: number, radius = 0.085): number {
  const du = u - (cornerU > 0.5 ? 1 : 0);
  const dv = v - (cornerV > 0.5 ? 1 : 0);
  const d = Math.hypot(du, dv);
  return 1 - smoothstep(radius * 0.35, radius, d);
}

/** True when a tile hash selects a chipped tile. */
export function isChipped(tileHashValue: number, rate = 0.045): boolean {
  return tileHashValue > 1 - rate;
}
