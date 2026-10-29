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
    // Three-quarter from the near-left corner: the whole corkscrew, the hollow
    // mouth and its waterline reflection all read from here.
    id: 'flume',
    index: 2,
    label: 'The Flume',
    position: [-2.4, 1.0, -20.2],
    target: [4.2, 2.1, -15.2],
    fov: 47,
  },
  {
    // Almost at the surface, close enough that the ring, its reflection and the
    // ripple rings behind it share the frame.
    id: 'ring',
    index: 3,
    label: 'Still Water',
    position: [1.05, 0.58, -4.9],
    target: [1.8, 0.05, -3.05],
    fov: 38,
  },
  {
    // Off the centre line: the arch screen is seen in perspective, with the
    // blue ring in the middle ground and the warm corridor beyond.
    id: 'arch',
    index: 4,
    label: 'The Arch',
    position: [2.6, 0.85, 2.0],
    target: [-0.8, 2.0, 29.0],
    fov: 50,
  },
  {
    // Low and close to the water: skylight slot above, frosted windows both
    // sides, water and its floating punctuation in the bottom third.
    id: 'skylight',
    index: 5,
    label: 'Ascension',
    position: [0.15, 0.42, -10.5],
    target: [0.1, 5.8, 2.0],
    fov: 70,
  },
  {
    // Material proof: coping, glazed tile under grazing light and the wet band
    // at the waterline, framed along the wall with a chrome rail overhead.
    id: 'tile',
    index: 6,
    label: 'Skin',
    position: [6.55, 0.8, 2.6],
    target: [7.4, 0.25, 4.2],
    fov: 26,
  },
  {
    // High over the near end: flume footprint on the left, rings receding, the
    // whole basin and the arch screen in one frame.
    id: 'float',
    index: 7,
    label: 'Float',
    position: [1.9, 6.5, -22.0],
    target: [1.2, 0.0, -7.0],
    fov: 58,
  },
] as const;

export const getShot = (id: string): CameraShot | undefined => SHOTS.find((shot) => shot.id === id);

export interface CinematicKey {
  time: number;
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  fov: number;
}

const shotKey = (id: string, time: number): CinematicKey => {
  const shot = getShot(id);
  if (!shot) throw new Error(`CINEMATIC_KEYS references unknown shot "${id}"`);
  return { time, position: shot.position, target: shot.target, fov: shot.fov };
};

/**
 * One slow, continuous take through the seven compositions, closed into a loop.
 *
 * The shot poses are reused verbatim (so the take literally visits each
 * composition) and a single high return key eases the camera back toward the
 * arrival pose. The path itself is a closed cubic Hermite cycle
 * (`app/cameraPath.ts`): the wrap is C1-continuous in position and orientation,
 * and the monotone tangents keep the camera from overshooting into the basin
 * walls or the flume.
 *
 * The spacing is paced against segment length (roughly 1.3–1.8 m/s chord speed)
 * so the take reads as one calm drift instead of fast transits between beats
 * (peak translation is 1.78 m/s, peak pan 13.3 deg/s). The arrival pose stays on
 * the loop point as a deliberate near-still beat.
 */
export const CINEMATIC_KEYS: readonly CinematicKey[] = [
  shotKey('arrival', 0),
  shotKey('flume', 6),
  shotKey('ring', 16),
  shotKey('arch', 21),
  shotKey('tile', 25.5),
  shotKey('skylight', 36.5),
  shotKey('float', 46.5),
  {
    time: 51,
    position: [0.9, 2.8, -21.5],
    target: [0.5, 1.4, -5.0],
    fov: 55,
  },
] as const;

export const CINEMATIC_DURATION = 56;
