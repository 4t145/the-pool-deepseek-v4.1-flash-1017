import { describe, expect, it } from 'vitest';
import {
  CEILING_RIB_Z,
  ROOM_DETAIL,
  fixtureClearsColumns,
  fixtureClearsWindows,
  fixtureClearsWindowsAt,
  isInsideHall,
  laneLineXs,
  midpointsBetween,
  positionsBetween,
  validateRoomDetail,
} from '../src/world/roomDetailLayout';
import { LAYOUT } from '../src/world/layout';

describe('room detail placement', () => {
  it('is internally consistent', () => {
    expect(validateRoomDetail()).toBeNull();
  });

  it('puts a lamp on every pier between windows and nowhere near them', () => {
    const piers = midpointsBetween(LAYOUT.windows.centers);
    expect(ROOM_DETAIL.lamps.zs).toEqual(piers);
    expect(ROOM_DETAIL.lamps.zs).toHaveLength(LAYOUT.windows.centers.length - 1);
    for (const z of ROOM_DETAIL.lamps.zs) {
      expect(fixtureClearsWindows(z, 0.13)).toBe(true);
      expect(fixtureClearsColumns(z, 0.13)).toBe(true);
      expect(Math.abs(z)).toBeLessThan(LAYOUT.hall.zMax - 0.5);
    }
  });

  it('rejects a fixture that covers a window or a column', () => {
    expect(fixtureClearsWindows(LAYOUT.windows.centers[0]!, 0.13)).toBe(false);
    expect(fixtureClearsColumns(LAYOUT.columns.z[0]!, 0.13)).toBe(false);
  });

  it('keeps grate bars evenly spaced inside the gutter slot', () => {
    const gutter = ROOM_DETAIL.gutter;
    const bars: number[] = [];
    for (let z = gutter.zMin; z <= gutter.zMax; z += gutter.barPitch) bars.push(z);
    expect(bars.length).toBeGreaterThan(100);
    expect(bars[0]).toBeCloseTo(gutter.zMin);
    for (const z of bars) expect(z).toBeLessThanOrEqual(gutter.zMax);
    expect(gutter.innerX).toBeGreaterThan(LAYOUT.water.halfWidth);
    expect(gutter.outerX).toBeLessThan(LAYOUT.hall.halfWidth);
  });

  it('paints lanes symmetrically inside the water and above the basin floor', () => {
    const lanes = ROOM_DETAIL.laneLines;
    expect(lanes.xs).toHaveLength(5);
    expect(lanes.xs[0]).toBeCloseTo(-4.8);
    expect(lanes.xs[4]).toBeCloseTo(4.8);
    for (const x of lanes.xs) {
      expect(Math.abs(x)).toBeLessThan(LAYOUT.water.halfWidth - 0.5);
    }
    expect(lanes.floorY).toBeGreaterThan(LAYOUT.water.floor);
    expect(lanes.floorY - LAYOUT.water.floor).toBeLessThan(0.02);
    expect(lanes.zMin).toBeGreaterThan(LAYOUT.water.zMin);
    expect(lanes.zMax).toBeLessThan(LAYOUT.water.zMax);
  });

  it('does not run ceiling services through the transverse arch screen', () => {
    const [front, rear] = ROOM_DETAIL.pipes.zSections;
    expect(front).toBeDefined();
    expect(rear).toBeDefined();
    expect(front![1]).toBeLessThanOrEqual(18.4);
    expect(rear![0]).toBeGreaterThanOrEqual(18.78);
    expect(rear![1]).toBeLessThan(LAYOUT.hall.zMax);
    for (const x of ROOM_DETAIL.pipes.xs) {
      expect(Math.abs(x) - ROOM_DETAIL.pipes.radius).toBeGreaterThan(LAYOUT.skylight.halfWidth);
    }
    for (const rib of CEILING_RIB_Z) {
      expect(rib).toBeGreaterThan(LAYOUT.hall.zMin);
      expect(rib).toBeLessThanOrEqual(28);
    }
  });

  it('keeps the waterline band on the basin wall and the algae line inside it', () => {
    const waterLine = ROOM_DETAIL.waterLine;
    expect(waterLine.bandYMin).toBeLessThan(LAYOUT.water.surface);
    expect(waterLine.bandYMax).toBeGreaterThan(0);
    expect(waterLine.bandYMax).toBeLessThan(LAYOUT.hall.deck);
    expect(waterLine.algaeYMin).toBeGreaterThanOrEqual(waterLine.bandYMin);
    expect(waterLine.algaeYMax).toBeLessThanOrEqual(waterLine.bandYMax + 0.01);
    expect(waterLine.xInset).toBeGreaterThan(0);
  });

  it('mounts notices on clear wall piers, above the deck and away from each other', () => {
    const notices = ROOM_DETAIL.notices;
    expect(notices.length).toBeGreaterThanOrEqual(3);
    expect(new Set(notices.map((notice) => notice.id)).size).toBe(notices.length);
    const existingSignZ = [-8.6, 10.5];
    for (const notice of notices) {
      expect(fixtureClearsWindowsAt(notice.z, notice.width / 2, notice.y, notice.height / 2)).toBe(true);
      expect(fixtureClearsColumns(notice.z, notice.width / 2)).toBe(true);
      expect(notice.y - notice.height / 2).toBeGreaterThan(LAYOUT.hall.deck + 0.5);
      for (const z of existingSignZ) expect(Math.abs(notice.z - z)).toBeGreaterThan(0.8);
      expect(isInsideHall(notice.side * (LAYOUT.hall.halfWidth - 0.006), notice.y, notice.z, 0.005)).toBe(true);
    }
    for (let i = 0; i < notices.length; i++) {
      for (let j = i + 1; j < notices.length; j++) {
        const a = notices[i]!;
        const b = notices[j]!;
        if (a.side !== b.side) continue;
        expect(Math.abs(a.z - b.z)).toBeGreaterThan((a.width + b.width) / 2);
      }
    }
  });

  it('spaces helpers deterministically without touching the hall shell', () => {
    expect(positionsBetween(0, 10, 2.5)).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(positionsBetween(0, 10, 2.5)).toEqual(positionsBetween(0, 10, 2.5));
    expect(positionsBetween(5, 5, 1)).toEqual([]);
    expect(positionsBetween(0, 5, 0)).toEqual([]);
    expect(laneLineXs(7.2, 6).map((x) => Number(x.toFixed(6)) + 0)).toEqual([-4.8, -2.4, 0, 2.4, 4.8]);
    expect(laneLineXs(7.2, 1)).toEqual([]);
    expect(midpointsBetween([-1, 1, 4])).toEqual([0, 2.5]);
    expect(isInsideHall(0, 1, 0)).toBe(true);
    expect(isInsideHall(LAYOUT.hall.halfWidth + 0.5, 1, 0)).toBe(false);
    expect(isInsideHall(0, 1, LAYOUT.hall.zMin - 0.5)).toBe(false);
  });
});
