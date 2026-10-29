import { describe, expect, it } from 'vitest';
import {
  Color,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Scene,
  Vector3,
} from 'three';
import { buildArchitecture } from '../src/world/architecture';
import { buildProps } from '../src/world/props';
import { bakeLighting } from '../src/world/lightBake';
import type { MaterialLibrary } from '../src/world/materials';

const stubMaterials = (): MaterialLibrary => {
  const standard = (name: string, color: number) => new MeshStandardMaterial({ name, color, roughness: 0.8 });
  const physical = (name: string, color: number) => new MeshPhysicalMaterial({ name, color, roughness: 0.4 });
  const basic = (name: string, color: number, intensity = 1) => {
    const material = new MeshBasicMaterial({ name, color, toneMapped: false });
    material.color.multiplyScalar(intensity);
    return material;
  };
  return {
    tileWall: physical('tile.wall', 0xf4f0e6),
    tileFloor: physical('tile.floor', 0xe9e5db),
    tileUnderwater: physical('tile.underwater', 0x9fb6ad),
    tileDark: standard('tile.band', 0x20443f),
    plaster: standard('plaster', 0xd9d6cb),
    concrete: standard('concrete', 0x6f6c63),
    chrome: standard('chrome', 0xdfe3e2),
    darkMetal: standard('dark-metal', 0x2a2d2c),
    redPlastic: physical('red-plastic', 0x9c1d16),
    whitePlastic: physical('white-plastic', 0xe6e2d8),
    vinyl: {
      red: physical('vinyl-red', 0xc83426),
      yellow: physical('vinyl-yellow', 0xe8b21b),
      blue: physical('vinyl-blue', 0x2b53b8),
    },
    sign: standard('sign', 0xffffff),
    signDeep: standard('sign.deep', 0xffffff),
    windowGlass: basic('window-glass', 0xf7fbff, 2.1),
    skylightGlass: basic('skylight', 0xffffff, 2.8),
    fluorescent: basic('fluorescent', 0xdcefff, 2.4),
    warmGlow: basic('warm-glow', 0xffc38a, 1.6),
    black: new MeshBasicMaterial({ name: 'void', color: 0x000000 }),
    poolTileBand: standard('pool-band', 0x1e514b),
  } as unknown as MaterialLibrary;
};

describe('light bake benchmark', () => {
  it('bakes the real architecture + props in reasonable time', () => {
    const scene = new Scene();
    const materials = stubMaterials();
    buildArchitecture(scene, materials);
    buildProps(scene, materials);
    const baked = bakeLighting({
      scene,
      quality: 1,
      sunDirection: new Vector3(-12.5, 27, -14).normalize(),
      sunColor: new Color(0xf2ead7),
      sunIntensity: 3.8,
      pointLights: [],
      bounceCount: 2,
    });
    const byName = new Map<string, { count: number; color: string }>();
    scene.traverse((o) => { const m = o as any; if (!m.isMesh) return; const mat = m.material; if (!mat) return; const entry = byName.get(mat.name) ?? { count: 0, color: mat.color ? mat.color.getHexString() : '-' }; entry.count += Math.floor((m.geometry.getAttribute('position')?.count ?? 0) / 3); byName.set(mat.name, entry); });
    console.log('[emitters]', JSON.stringify([...byName.entries()].filter(([n]) => ['window-glass', 'skylight', 'fluorescent', 'warm-glow', 'red-plastic', 'void'].includes(n))));
    console.log('[bake]', JSON.stringify(baked.stats));
    console.log('[samples]', JSON.stringify([
      ['mid-up', baked.sampleIrradiance([0, 2, 0], [0, 1, 0])],
      ['mid-down', baked.sampleIrradiance([0, 2, 0], [0, -1, 0])],
      ['floor-up', baked.sampleIrradiance([0, 0.3, 0], [0, 1, 0])],
      ['ceiling-up', baked.sampleIrradiance([0, 8.2, 0], [0, 1, 0])],
      ['ceiling-down', baked.sampleIrradiance([0, 8.2, 0], [0, -1, 0])],
      ['wall-left', baked.sampleIrradiance([-8, 4, 0], [1, 0, 0])],
      ['corner', baked.sampleIrradiance([-8.2, 0.3, -28.8], [0.7, 0.7, 0])],
    ]));
    const up = baked.sampleIrradiance([0, 1.2, 0], [0, 1, 0]);
    const down = baked.sampleIrradiance([0, 7.8, 0], [0, -1, 0]);
    const wall = baked.sampleIrradiance([7.8, 4, 0], [-1, 0, 0]);
    // eslint-disable-next-line no-console
    console.log('[bake] floor-up', up, 'ceiling-down', down, 'wall-in', wall);
    expect(baked.stats.probes).toBeGreaterThan(1000);
    expect(up[0] + up[1] + up[2]).toBeGreaterThan(0);
    expect(down[0] + down[1] + down[2]).toBeGreaterThan(0);
    void wall;
    baked.dispose();
  }, 240_000);
});
