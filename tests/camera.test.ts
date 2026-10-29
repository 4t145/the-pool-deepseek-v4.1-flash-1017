import { describe, expect, it } from 'vitest';
import {
  CINEMATIC_DURATION,
  CINEMATIC_KEYS,
  LAYOUT,
  SHOTS,
  getShot,
  type CameraShot,
} from '../src/world/layout';
import {
  createClosedCameraPath,
  directionAngle,
  viewDirection,
  wrapTime,
  type CameraPathKey,
} from '../src/app/cameraPath';

const SAMPLES = 2400;
const DEG = Math.PI / 180;

const poseAt = (position: readonly [number, number, number], target: readonly [number, number, number]) => ({
  position: { x: position[0], y: position[1], z: position[2] },
  target: { x: target[0], y: target[1], z: target[2] },
});

/** Pinhole projection into [0,1] screen space (16:9), for composition checks. */
function project(shot: CameraShot, point: readonly [number, number, number]): { u: number; v: number; depth: number } {
  const px = shot.position[0];
  const py = shot.position[1];
  const pz = shot.position[2];
  const forward = [
    shot.target[0] - px,
    shot.target[1] - py,
    shot.target[2] - pz,
  ] as const;
  const forwardLength = Math.hypot(...forward);
  const f = forward.map((component) => component / forwardLength) as unknown as [number, number, number];
  // Camera basis: screen-right is cross(forward, world-up); looking toward +Z
  // means world +X is screen-left, per the LAYOUT convention.
  const right = [-f[2], 0, f[0]] as const;
  const rightLength = Math.hypot(...right);
  const r = right.map((component) => component / rightLength) as unknown as [number, number, number];
  const up = [
    r[1] * f[2] - r[2] * f[1],
    r[2] * f[0] - r[0] * f[2],
    r[0] * f[1] - r[1] * f[0],
  ] as const;
  const dx = point[0] - px;
  const dy = point[1] - py;
  const dz = point[2] - pz;
  const depth = dx * f[0] + dy * f[1] + dz * f[2];
  const tanHalf = Math.tan((shot.fov * DEG) / 2);
  const x = (dx * r[0] + dy * r[1] + dz * r[2]) / (depth * tanHalf * (16 / 9));
  const y = (dx * up[0] + dy * up[1] + dz * up[2]) / (depth * tanHalf);
  return { u: (x + 1) / 2, v: (1 - y) / 2, depth };
}

describe('guided camera path', () => {
  const path = createClosedCameraPath(CINEMATIC_KEYS, CINEMATIC_DURATION);

  it('runs for 40-60 s', () => {
    expect(CINEMATIC_DURATION).toBeGreaterThanOrEqual(40);
    expect(CINEMATIC_DURATION).toBeLessThanOrEqual(60);
  });

  it('closes with the same pose and the same velocity at the wrap', () => {
    const start = path.sample(0);
    const end = path.sample(CINEMATIC_DURATION - 1e-6);
    const positionDelta = Math.hypot(
      end.position[0] - start.position[0],
      end.position[1] - start.position[1],
      end.position[2] - start.position[2],
    );
    const targetDelta = Math.hypot(
      end.target[0] - start.target[0],
      end.target[1] - start.target[1],
      end.target[2] - start.target[2],
    );
    const velocityStart = path.velocity(1e-6);
    const velocityEnd = path.velocity(CINEMATIC_DURATION - 1e-6);
    const velocityDelta = Math.hypot(
      velocityEnd[0] - velocityStart[0],
      velocityEnd[1] - velocityStart[1],
      velocityEnd[2] - velocityStart[2],
    );
    expect(positionDelta).toBeLessThan(1e-4);
    expect(targetDelta).toBeLessThan(1e-3);
    expect(velocityDelta).toBeLessThan(1e-4);
    expect(path.sample(CINEMATIC_DURATION).position[0]).toBeCloseTo(start.position[0], 5);
  });

  it('moves slowly: peak translation speed below 2.6 m/s', () => {
    const dt = CINEMATIC_DURATION / SAMPLES;
    let peak = 0;
    for (let index = 0; index <= SAMPLES; index++) {
      const velocity = path.velocity(index * dt);
      peak = Math.max(peak, Math.hypot(velocity[0], velocity[1], velocity[2]));
    }
    expect(peak).toBeLessThan(2.6);
    expect(peak).toBeGreaterThan(0.5);
  });

  it('pans slowly: peak view-direction rate below 15 °/s', () => {
    const dt = CINEMATIC_DURATION / SAMPLES;
    let previous = viewDirection(path.sample(0));
    let peak = 0;
    for (let index = 1; index <= SAMPLES; index++) {
      const direction = viewDirection(path.sample(index * dt));
      peak = Math.max(peak, directionAngle(previous, direction) / dt);
      previous = direction;
    }
    expect(peak / DEG).toBeLessThan(15);
  });

  it('passes through all seven composition poses', () => {
    for (const shot of SHOTS) {
      const key = CINEMATIC_KEYS.find(
        (candidate) =>
          Math.abs(candidate.position[0] - shot.position[0]) < 1e-9 &&
          Math.abs(candidate.position[2] - shot.position[2]) < 1e-9,
      );
      expect(key, `${shot.id} is not a cinematic key`).toBeDefined();
      const pose = path.sample(key!.time);
      const distance = Math.hypot(
        pose.position[0] - shot.position[0],
        pose.position[1] - shot.position[1],
        pose.position[2] - shot.position[2],
      );
      const angle = directionAngle(
        viewDirection(pose),
        viewDirection({ position: shot.position, target: shot.target }),
      );
      expect(distance).toBeLessThan(1e-4);
      expect(angle / DEG).toBeLessThan(0.01);
    }
  });

  it('stays inside the hall and clear of the flume envelope', () => {
    const dt = CINEMATIC_DURATION / SAMPLES;
    for (let index = 0; index <= SAMPLES; index++) {
      const position = path.sample(index * dt).position;
      const [x, y, z] = position;
      expect(Math.abs(x)).toBeLessThan(LAYOUT.hall.halfWidth - 0.2);
      expect(y).toBeGreaterThan(LAYOUT.water.surface + 0.3);
      expect(y).toBeLessThan(LAYOUT.hall.ceiling - 0.2);
      expect(z).toBeGreaterThan(LAYOUT.hall.zMin + 0.4);
      expect(z).toBeLessThan(LAYOUT.hall.zMax - 0.4);
      // Negotiated with the props lane: the redesigned corkscrew reaches
      // x = 2.3 at the near end, so the return leg stays at x <= 2.0.
      if (z > -18 && z < -12 && y < 6.6) expect(x).toBeLessThanOrEqual(2.0);
    }
  });

  it('is deterministic across instances', () => {
    const again = createClosedCameraPath(CINEMATIC_KEYS, CINEMATIC_DURATION);
    for (let index = 0; index < 32; index++) {
      const time = (index / 31) * CINEMATIC_DURATION;
      expect(again.sample(time)).toEqual(path.sample(time));
    }
  });

  it('wraps negative and large times instead of clamping', () => {
    expect(wrapTime(-1, 56)).toBe(55);
    expect(path.sample(-1).position[2]).toBeCloseTo(path.sample(55).position[2], 6);
    expect(path.sample(CINEMATIC_DURATION + 4).position[0]).toBeCloseTo(path.sample(4).position[0], 6);
  });
});

describe('camera path validation', () => {
  const base = (time: number, x = 0): CameraPathKey => ({
    time,
    position: [x, 1, 0],
    target: [x, 1, 5],
    fov: 50,
  });

  it('rejects unordered or degenerate keys', () => {
    expect(() => createClosedCameraPath([base(0), base(1), base(1.5)], 10)).not.toThrow();
    expect(() => createClosedCameraPath([base(0), base(2), base(1)], 10)).toThrow(/increase/);
    expect(() => createClosedCameraPath([base(0), base(1), base(2)], 2)).toThrow(/inside the loop/);
    expect(() =>
      createClosedCameraPath(
        [
          { time: 0, position: [0, 1, 0], target: [0, 1, 0], fov: 50 },
          base(2),
          base(4),
        ],
        10,
      ),
    ).toThrow(/looks at its own position/);
    expect(() => createClosedCameraPath([base(0), base(2)], 10)).toThrow();
  });

  it('moves through a straight corridor without overshoot', () => {
    const keys: CameraPathKey[] = [
      { time: 0, position: [0, 1, -10], target: [0, 1, 0], fov: 50 },
      { time: 5, position: [0, 1, -5], target: [0, 1, 5], fov: 50 },
      { time: 10, position: [0, 1, 0], target: [0, 1, 10], fov: 50 },
      { time: 15, position: [0, 1, -5], target: [0, 1, 5], fov: 50 },
    ];
    const path = createClosedCameraPath(keys, 20);
    for (let index = 0; index <= 100; index++) {
      const position = path.sample((index / 100) * 20).position;
      expect(Math.abs(position[0])).toBeLessThan(1e-9);
      expect(position[2]).toBeGreaterThanOrEqual(-10.001);
      expect(position[2]).toBeLessThanOrEqual(0.001);
    }
  });
});

describe('shot compositions', () => {
  it('keeps every camera and target inside the room with a usable lens', () => {
    for (const shot of SHOTS) {
      expect(getShot(shot.id)).toBe(shot);
      expect(shot.fov).toBeGreaterThanOrEqual(24);
      expect(shot.fov).toBeLessThanOrEqual(72);
      const [px, py, pz] = shot.position;
      const [tx, ty, tz] = shot.target;
      expect(Math.abs(px)).toBeLessThan(LAYOUT.hall.halfWidth - 0.3);
      expect(py).toBeGreaterThan(LAYOUT.water.surface + 0.25);
      expect(py).toBeLessThan(LAYOUT.hall.ceiling - 0.3);
      expect(pz).toBeGreaterThan(LAYOUT.hall.zMin + 0.3);
      expect(pz).toBeLessThan(LAYOUT.hall.zMax - 0.3);
      expect(Math.abs(tx)).toBeLessThanOrEqual(LAYOUT.hall.halfWidth);
      expect(ty).toBeGreaterThanOrEqual(0);
      expect(ty).toBeLessThanOrEqual(LAYOUT.hall.ceiling);
      expect(tz).toBeGreaterThanOrEqual(LAYOUT.hall.zMin);
      expect(tz).toBeLessThanOrEqual(LAYOUT.hall.zMax);
      expect(Math.hypot(tx - px, ty - py, tz - pz)).toBeGreaterThan(1);
    }
  });

  it('frames the arrival poster: flume mass left, far arch centre, water in front', () => {
    const arrival = getShot('arrival')!;
    const flumeMass = project(arrival, [LAYOUT.slide.tower.x, 3.2, LAYOUT.slide.tower.z]);
    expect(flumeMass.depth).toBeGreaterThan(0);
    expect(flumeMass.u).toBeGreaterThan(0.02);
    expect(flumeMass.u).toBeLessThan(0.5);
    expect(flumeMass.v).toBeGreaterThan(0.02);
    expect(flumeMass.v).toBeLessThan(0.98);

    const arch = project(arrival, [0, LAYOUT.farArch.springY, LAYOUT.farArch.z]);
    expect(arch.depth).toBeGreaterThan(0);
    expect(arch.u).toBeGreaterThan(0.35);
    expect(arch.u).toBeLessThan(0.75);
    expect(arch.v).toBeGreaterThan(0.2);
    expect(arch.v).toBeLessThan(0.75);

    // The near water surface must occupy the lower half of the frame.
    const nearWater = project(arrival, [0, 0, -18]);
    expect(nearWater.depth).toBeGreaterThan(0);
    expect(nearWater.v).toBeGreaterThan(0.5);
  });

  it('aims the flume shot toward the hollow mouth anchor', () => {
    const flume = getShot('flume')!;
    const mouth = LAYOUT.slide.end;
    const distance = Math.hypot(
      mouth.x - flume.position[0],
      mouth.y - flume.position[1],
      mouth.z - flume.position[2],
    );
    expect(distance).toBeGreaterThan(2);
    const angle = directionAngle(
      viewDirection({ position: flume.position, target: flume.target }),
      viewDirection({ position: flume.position, target: [mouth.x, mouth.y + 0.9, mouth.z] }),
    );
    expect(angle / DEG).toBeLessThan(25);
    const projected = project(flume, [mouth.x, mouth.y, mouth.z]);
    expect(projected.depth).toBeGreaterThan(0);
    expect(projected.u).toBeGreaterThan(0.1);
    expect(projected.u).toBeLessThan(0.9);
    expect(projected.v).toBeGreaterThan(0.15);
    expect(projected.v).toBeLessThan(0.95);
  });

  it('keeps the waterline crossing the skin shot', () => {
    const skin = getShot('tile')!;
    const waterline = project(skin, [LAYOUT.water.halfWidth, LAYOUT.water.surface, 4.2]);
    expect(waterline.depth).toBeGreaterThan(0);
    expect(waterline.u).toBeGreaterThan(0.1);
    expect(waterline.u).toBeLessThan(0.95);
    expect(waterline.v).toBeGreaterThan(0.1);
    expect(waterline.v).toBeLessThan(0.95);
  });

  it('puts water in the bottom third of the ascension shot', () => {
    const skylight = getShot('skylight')!;
    const waterAhead = project(skylight, [0, 0, -6.5]);
    expect(waterAhead.depth).toBeGreaterThan(0);
    expect(waterAhead.v).toBeGreaterThan(0.62);
    const skylightPanel = project(skylight, [0, LAYOUT.skylight.panelY, 2]);
    expect(skylightPanel.u).toBeGreaterThan(0.3);
    expect(skylightPanel.u).toBeLessThan(0.7);
    expect(skylightPanel.v).toBeLessThan(0.45);
  });

  it('contains the flume and all three rings in the float frame', () => {
    const float = getShot('float')!;
    for (const ring of LAYOUT.rings) {
      const projected = project(float, [ring.position.x, 0, ring.position.z]);
      expect(projected.depth, `${ring.id} is behind the float camera`).toBeGreaterThan(0);
      expect(projected.u).toBeGreaterThan(-0.25);
      expect(projected.u).toBeLessThan(1.25);
      expect(projected.v).toBeGreaterThan(-0.25);
      expect(projected.v).toBeLessThan(1.25);
    }
    const flumeFootprint = project(float, [LAYOUT.slide.end.x, 0.3, LAYOUT.slide.end.z]);
    expect(flumeFootprint.depth).toBeGreaterThan(0);
    expect(flumeFootprint.u).toBeGreaterThan(-0.25);
    expect(flumeFootprint.u).toBeLessThan(1.25);
    expect(flumeFootprint.v).toBeGreaterThan(-0.25);
    expect(flumeFootprint.v).toBeLessThan(1.25);
  });
});
