import { describe, expect, it } from 'vitest';
import { CINEMATIC_DURATION, CINEMATIC_KEYS, LAYOUT, SHOTS, getShot } from '../src/world/layout';

describe('world layout', () => {
  it('keeps the water inside the hall and the decks walkable', () => {
    expect(LAYOUT.water.halfWidth).toBeLessThan(LAYOUT.hall.halfWidth);
    expect(LAYOUT.water.zMin).toBeGreaterThan(LAYOUT.hall.zMin);
    expect(LAYOUT.water.zMax).toBeLessThan(LAYOUT.hall.zMax);
    const sideDeck = LAYOUT.hall.halfWidth - LAYOUT.water.halfWidth;
    expect(sideDeck).toBeGreaterThan(0.8);
    expect(LAYOUT.water.surface).toBeGreaterThan(LAYOUT.water.floor);
    expect(LAYOUT.hall.deck).toBeGreaterThan(LAYOUT.water.surface);
  });

  it('has seven unique, framed camera shots', () => {
    expect(SHOTS).toHaveLength(7);
    expect(new Set(SHOTS.map((shot) => shot.id)).size).toBe(7);
    for (const shot of SHOTS) {
      expect(getShot(shot.id)).toBe(shot);
      expect(shot.fov).toBeGreaterThan(20);
      expect(shot.fov).toBeLessThan(90);
      const [x, y, z] = shot.position;
      expect(Math.abs(x)).toBeLessThan(LAYOUT.hall.halfWidth);
      expect(y).toBeGreaterThan(0.2);
      expect(y).toBeLessThan(LAYOUT.hall.ceiling);
      expect(z).toBeGreaterThan(LAYOUT.hall.zMin);
      expect(z).toBeLessThan(LAYOUT.hall.zMax);
      const distance = Math.hypot(
        shot.target[0] - shot.position[0],
        shot.target[1] - shot.position[1],
        shot.target[2] - shot.position[2],
      );
      expect(distance).toBeGreaterThan(1);
    }
  });

  it('keeps the cinematic keys ordered and inside the room', () => {
    expect(CINEMATIC_KEYS.length).toBeGreaterThan(4);
    let previous = -1;
    for (const key of CINEMATIC_KEYS) {
      expect(key.time).toBeGreaterThan(previous);
      previous = key.time;
      expect(Math.abs(key.position[0])).toBeLessThan(LAYOUT.hall.halfWidth);
      expect(key.position[1]).toBeGreaterThan(0.2);
      expect(key.position[1]).toBeLessThan(LAYOUT.hall.ceiling);
      expect(key.position[2]).toBeGreaterThan(LAYOUT.hall.zMin);
      expect(key.position[2]).toBeLessThan(LAYOUT.hall.zMax);
    }
    expect(CINEMATIC_KEYS[CINEMATIC_KEYS.length - 1]!.time).toBeLessThanOrEqual(CINEMATIC_DURATION);
  });
});
