import { Vector3 } from 'three';

/**
 * One authoritative world layout. Every system reads these anchors so that water,
 * tile, props, lighting, camera paths and the bake cannot drift apart.
 *
 * Axes: +X right when facing +Z (the far arch), +Y up, water surface at y = 0.
 * Units are metres.
 */
export const LAYOUT = {
  hall: {
    halfWidth: 8.4,
    zMin: -29,
    zMax: 29,
    ceiling: 8.6,
    deck: 0.35,
  },
  water: {
    halfWidth: 7.2,
    zMin: -27.5,
    zMax: 27.5,
    surface: 0,
    depth: 3.2,
    /** Dark basin plaster under the tiles. */
    floor: -3.2,
  },
  pool: {
    /** Distance from the water edge to the basin wall face. */
    copingWidth: 0.34,
    edgeThickness: 0.18,
  },
  skylight: {
    halfWidth: 1.9,
    zMin: -20,
    zMax: 25,
    wellHeight: 1.15,
    panelY: 9.7,
  },
  windows: {
    centers: [-23.0, -17.4, -11.8, -6.2, -0.6, 5.0, 10.6, 16.2, 21.8],
    width: 1.26,
    height: 2.05,
    centerY: 5.65,
    recess: 0.16,
  },
  columns: {
    x: 7.9,
    z: [-24.4, -18.8, -13.2, -7.6, -2.0, 3.6, 9.2, 14.8, 20.4, 26.0],
    size: 0.62,
  },
  arcade: {
    springY: 4.55,
    thickness: 0.34,
  },
  farArch: {
    width: 4.3,
    springY: 3.35,
    z: 29,
  },
  stairs: {
    x: 0,
    z: 26.55,
    width: 4.6,
    steps: 6,
  },
  ladders: {
    z: [-21, -13, -5, 3, 11, 19],
    x: 7.08,
  },
  railings: {
    x: 7.48,
    topY: 1.34,
  },
  slide: {
    tower: new Vector3(5.65, 0, -13.2),
    topY: 7.15,
    helixRadius: 2.35,
    end: new Vector3(3.25, 0.28, -16.1),
    tubeRadius: 0.98,
  },
  rings: [
    { id: 'yellow', color: 0xe8b21b, position: new Vector3(-2.15, 0.045, -7.6), radius: 0.56, tube: 0.16, phase: 0.0 },
    { id: 'red', color: 0xc83426, position: new Vector3(1.75, 0.045, -3.0), radius: 0.64, tube: 0.18, phase: 1.7 },
    { id: 'blue', color: 0x2b53b8, position: new Vector3(0.55, 0.045, 8.4), radius: 0.52, tube: 0.15, phase: 3.4 },
  ],
  floodLight: {
    position: new Vector3(0, 2.6, 33.5),
    color: 0xffb26b,
  },
  cameraStart: new Vector3(0.35, 1.12, -25.4),
} as const;

export interface CameraShot {
  id: string;
  index: number;
  label: string;
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  fov: number;
  /** Roll in radians (positive = clockwise). */
  roll?: number;
}

export const SHOTS: readonly CameraShot[] = [
  {
    id: 'arrival',
    index: 1,
    label: 'Arrival',
    position: [0.35, 1.12, -25.4],
    target: [0.1, 1.24, -4.0],
    fov: 52,
  },
  {
    id: 'flume',
    index: 2,
    label: 'The Flume',
    position: [-1.6, 0.95, -18.6],
    target: [4.65, 2.7, -12.9],
    fov: 46,
  },
  {
    id: 'ring',
    index: 3,
    label: 'Still Water',
    position: [0.12, 0.62, -6.4],
    target: [1.75, 0.08, -3.05],
    fov: 42,
  },
  {
    id: 'arch',
    index: 4,
    label: 'The Arch',
    position: [-0.3, 1.25, 6.5],
    target: [0.0, 1.5, 29.0],
    fov: 50,
  },
  {
    id: 'skylight',
    index: 5,
    label: 'Ascension',
    position: [0.0, 0.45, -9.0],
    target: [0.0, 8.6, 0.0],
    fov: 70,
  },
  {
    id: 'tile',
    index: 6,
    label: 'Skin',
    position: [5.85, 1.05, -1.2],
    target: [8.4, 0.55, -1.2],
    fov: 34,
  },
  {
    id: 'float',
    index: 7,
    label: 'Float',
    position: [0.4, 5.6, -7.5],
    target: [0.0, 0.0, 3.5],
    fov: 55,
  },
] as const;

export const getShot = (id: string): CameraShot | undefined => SHOTS.find((shot) => shot.id === id);

export interface CinematicKey {
  time: number;
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  fov: number;
}

/**
 * One slow, continuous take down the hall. Keys are deliberately sparse: the
 * curve supplies the smoothness, the key spacing supplies the rhythm.
 */
export const CINEMATIC_KEYS: readonly CinematicKey[] = [
  { time: 0.0, position: [0.35, 1.1, -25.4], target: [0.0, 1.2, -6.0], fov: 52 },
  { time: 7.0, position: [1.2, 1.02, -21.0], target: [-3.2, 2.1, -12.0], fov: 48 },
  { time: 13.0, position: [1.9, 0.92, -18.2], target: [-4.8, 2.8, -12.7], fov: 45 },
  { time: 19.0, position: [0.5, 0.78, -11.2], target: [-1.6, 1.2, -5.0], fov: 47 },
  { time: 25.0, position: [0.1, 0.62, -6.2], target: [1.8, 0.12, -3.0], fov: 43 },
  { time: 31.0, position: [-0.2, 0.9, 0.5], target: [0.0, 1.2, 15.0], fov: 48 },
  { time: 37.0, position: [0.0, 1.15, 5.0], target: [0.0, 2.4, 26.0], fov: 50 },
  { time: 43.0, position: [0.0, 0.65, 8.0], target: [0.0, 7.8, 12.0], fov: 64 },
  { time: 49.0, position: [0.0, 1.3, 12.0], target: [0.0, 2.2, 29.0], fov: 52 },
] as const;

export const CINEMATIC_DURATION = 49;
