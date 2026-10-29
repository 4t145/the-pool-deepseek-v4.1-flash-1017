import { LAYOUT } from './layout';

/**
 * Placement data for the non-structural room dressing (deck hardware, pool
 * markings, wall lamps, ceiling services, notices).
 *
 * Everything here is pure numbers derived from `LAYOUT`, so it can be validated
 * in tests without a renderer. `architectureDetail.ts` turns it into merged
 * geometry. No anchor in `LAYOUT` is moved: the detail is clamped to the
 * existing shell so camera compositions and the lighting bake stay valid.
 */

const H = LAYOUT.hall;
const W = LAYOUT.water;

/** Radius of the chrome cage lamps; also the keep-out around a lamp centre. */
export const LAMP_RADIUS = 0.13;

/** Window centres are 5.6 m apart; fixtures sit on the pier between two windows. */
export function midpointsBetween(centers: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < centers.length - 1; i++) {
    const a = centers[i];
    const b = centers[i + 1];
    if (a === undefined || b === undefined) continue;
    out.push((a + b) / 2);
  }
  return out;
}

/** Evenly spaced positions centred in [min, max]; never closer than 1 mm. */
export function positionsBetween(min: number, max: number, pitch: number): number[] {
  if (!(pitch > 0) || !(max > min)) return [];
  const count = Math.max(1, Math.floor((max - min) / pitch) + 1);
  const span = (count - 1) * pitch;
  const start = (min + max) / 2 - span / 2;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(start + i * pitch);
  return out;
}

/** Lane division centres for `lanes` equal-width lanes across the water. */
export function laneLineXs(halfWidth: number, lanes: number): number[] {
  if (lanes < 2) return [];
  const width = (halfWidth * 2) / lanes;
  const out: number[] = [];
  for (let i = 1; i < lanes; i++) out.push(-halfWidth + width * i);
  return out;
}

/**
 * Ceiling rib centres, mirroring the loop in `architecture.ts`
 * (`for (let z = -27.8; z <= 28; z += 5.6)`). Hangers attach to the slab
 * between ribs; sprinkler drops hang just under a rib.
 */
export const CEILING_RIB_Z: readonly number[] = (() => {
  const out: number[] = [];
  for (let z = -27.8; z <= 28; z += 5.6) out.push(z);
  return out;
})();

export const CEILING_RIB_SPACING = 5.6;

export type WallSide = -1 | 1;

export interface NoticePlacement {
  id: string;
  side: WallSide;
  z: number;
  y: number;
  width: number;
  height: number;
  lines: readonly string[];
  background: string;
  ink: string;
}

const windowPiers = midpointsBetween(LAYOUT.windows.centers);

export const ROOM_DETAIL = {
  /** Coping-top overflow slot with a stainless grate. */
  gutter: {
    innerX: W.halfWidth + 0.05,
    outerX: W.halfWidth + 0.17,
    zMin: W.zMin + 0.5,
    zMax: W.zMax - 0.5,
    barPitch: 0.12,
    plateTopY: H.deck + 0.0035,
    barTopY: H.deck + 0.007,
    sideRailWidth: 0.014,
  },
  /** Poured-deck control joints, aligned to the column rhythm. */
  deckJoints: {
    sideXMin: W.halfWidth + 0.36,
    sideXMax: H.halfWidth - 0.03,
    sideZs: [...LAYOUT.columns.z],
    endDeckZs: [W.zMin - 0.92, W.zMax + 0.92],
    endXs: positionsBetween(-7.0, 7.0, 2.8),
    width: 0.028,
    y: H.deck + 0.0015,
  },
  /** Painted lane markings, floor stripes plus end-wall verticals. */
  laneLines: {
    xs: laneLineXs(W.halfWidth, 6),
    width: 0.25,
    floorY: W.floor + 0.005,
    zMin: W.zMin + 0.6,
    zMax: W.zMax - 0.6,
    endWallInset: 0.004,
    endWallYMin: W.floor + 0.12,
    endWallYMax: -0.3,
    crossBarZs: [W.zMax - 2.3, W.zMin + 2.3],
    crossBarHalfWidth: 6.4,
  },
  /** Chrome caged bulkhead lamps on the piers between the windows. */
  lamps: {
    zs: windowPiers,
    y: LAYOUT.windows.centerY - 1.08,
    /** Indices into `zs` (both sides share the index) that are still lit. */
    litIndices: [1, 4, 6],
  },
  /** High-level ventilation grilles above every third window pier. */
  grilles: {
    zs: [-16.4, 0.8, 17.6],
    y: 7.31,
    width: 1.86,
    height: 0.62,
    x: H.halfWidth - 0.035,
  },
  /** Galvanised services under the ceiling, split by the transverse arch screen. */
  pipes: {
    xs: [-3.05, 3.05],
    y: 8.02,
    radius: 0.07,
    zSections: [
      [-28.2, 18.0],
      [18.95, 28.2],
    ] as ReadonlyArray<readonly [number, number]>,
    hangerPitch: CEILING_RIB_SPACING,
    hangerTopY: H.ceiling - 0.02,
    sprinklerPitch: CEILING_RIB_SPACING,
    sprinklerDrop: 0.22,
    conduit: {
      x: H.halfWidth - 0.045,
      y: 7.86,
      radius: 0.035,
      zMin: -28.2,
      zMax: 28.2,
      boxPitch: 9.2,
    },
  },
  /** Ceiling access hatch. */
  hatch: {
    x: -5.0,
    z: -6.5,
    width: 1.0,
    depth: 0.8,
    frameY: H.ceiling - 0.03,
    panelY: H.ceiling - 0.011,
  },
  /** Enamel notices on the wall piers, clear of the existing two signs. */
  notices: [
    {
      id: 'shower',
      side: 1,
      z: -16.4,
      y: 2.14,
      width: 0.99,
      height: 0.5,
      lines: ['SHOWER', 'BEFORE ENTERING'],
      background: '#1d3a3d',
      ink: '#e9e3d2',
    },
    {
      id: 'running',
      side: -1,
      z: -11.0,
      y: 1.92,
      width: 0.86,
      height: 0.44,
      lines: ['NO RUNNING'],
      background: '#233c3a',
      ink: '#ece6d6',
    },
    {
      id: 'capacity',
      side: 1,
      z: 17.6,
      y: 2.3,
      width: 0.74,
      height: 0.4,
      lines: ['CAPACITY', '120'],
      background: '#1b3538',
      ink: '#e6dfcd',
    },
    {
      id: 'bottles',
      side: -1,
      z: 1.2,
      y: 2.46,
      width: 0.92,
      height: 0.46,
      lines: ['NO GLASS', 'ON DECK'],
      background: '#203a3b',
      ink: '#e8e2d1',
    },
  ] as readonly NoticePlacement[],
  /** Dark teal tile band straddling the waterline, plus a thin algae strip. */
  waterLine: {
    xInset: 0.004,
    bandYMin: -0.18,
    bandYMax: 0.1,
    algaeYMin: -0.02,
    algaeYMax: 0.088,
    zMin: W.zMin + 0.2,
    zMax: W.zMax - 0.2,
  },
} as const;

/** True when a point is inside the hall clear of walls, ceiling and basin. */
export function isInsideHall(x: number, y: number, z: number, margin = 0.01): boolean {
  return (
    Math.abs(x) <= H.halfWidth - margin &&
    y >= W.floor + margin &&
    y <= H.ceiling - margin &&
    z >= H.zMin + margin &&
    z <= H.zMax - margin
  );
}

/** A wall fixture centred at `z` must not cover a window opening. */
export function fixtureClearsWindows(z: number, halfWidth: number): boolean {
  const half = LAYOUT.windows.width / 2;
  return LAYOUT.windows.centers.every((center) => Math.abs(z - center) > half + halfWidth);
}

/** As above, but only when the fixture's vertical extent actually reaches the window. */
export function fixtureClearsWindowsAt(
  z: number,
  halfWidth: number,
  y: number,
  halfHeight: number,
): boolean {
  const win = LAYOUT.windows;
  const bottom = y - halfHeight;
  const top = y + halfHeight;
  const windowBottom = win.centerY - win.height / 2;
  const windowTop = win.centerY + win.height / 2;
  if (top < windowBottom || bottom > windowTop) return true;
  return fixtureClearsWindows(z, halfWidth);
}

/** A wall fixture must not sit inside a column's footprint. */
export function fixtureClearsColumns(z: number, halfWidth: number): boolean {
  const half = LAYOUT.columns.size / 2;
  return LAYOUT.columns.z.every((center) => Math.abs(z - center) > half + halfWidth);
}

/** Null when the placement data is consistent, otherwise a human-readable reason. */
export function validateRoomDetail(): string | null {
  const detail = ROOM_DETAIL;

  for (const z of detail.lamps.zs) {
    if (Math.abs(z) >= H.zMax - 0.5) return `lamp at z=${z} outside the hall`;
    if (!fixtureClearsWindowsAt(z, LAMP_RADIUS, detail.lamps.y, LAMP_RADIUS)) return `lamp at z=${z} covers a window`;
    if (!fixtureClearsColumns(z, LAMP_RADIUS)) return `lamp at z=${z} intersects a column`;
  }
  for (const z of detail.grilles.zs) {
    if (!fixtureClearsWindowsAt(z, detail.grilles.width / 2, detail.grilles.y, detail.grilles.height / 2)) {
      return `grille at z=${z} covers a window`;
    }
    if (!fixtureClearsColumns(z, detail.grilles.width / 2)) return `grille at z=${z} intersects a column`;
  }
  for (const notice of detail.notices) {
    if (!fixtureClearsWindowsAt(notice.z, notice.width / 2, notice.y, notice.height / 2)) {
      return `notice ${notice.id} covers a window`;
    }
    if (!fixtureClearsColumns(notice.z, notice.width / 2)) return `notice ${notice.id} intersects a column`;
    if (notice.y - notice.height / 2 <= H.deck) return `notice ${notice.id} below the deck`;
  }
  if (detail.gutter.innerX <= W.halfWidth) return 'gutter slot inside the water';
  if (detail.gutter.outerX >= detail.deckJoints.sideXMin) return 'gutter slot overlaps the deck joint zone';
  if (detail.laneLines.xs.some((x) => Math.abs(x) > W.halfWidth - 0.5)) return 'lane line outside the water';
  if (detail.laneLines.floorY <= W.floor) return 'lane markings sink into the basin floor';
  for (const [a, b] of detail.pipes.zSections) {
    if (a >= b) return 'pipe section is empty';
  }
  // The transverse arch screen occupies z in [18.4, 18.78]; services must not pass through it.
  if (detail.pipes.zSections[0]![1] > 18.4) return 'forward pipe section crosses the arch screen';
  if (detail.pipes.zSections[1]![0] < 18.78) return 'rear pipe section crosses the arch screen';
  for (const x of detail.pipes.xs) {
    if (Math.abs(x) - detail.pipes.radius < LAYOUT.skylight.halfWidth) return 'pipe hangs inside the skylight aperture';
  }
  if (!isInsideHall(detail.hatch.x, detail.hatch.panelY, detail.hatch.z)) return 'hatch outside the ceiling';
  if (detail.waterLine.bandYMin < W.floor || detail.waterLine.bandYMax > H.deck) return 'waterline band outside the basin wall';
  if (detail.waterLine.algaeYMax > detail.waterLine.bandYMax + 0.01) return 'algae strip above the waterline band';
  return null;
}
