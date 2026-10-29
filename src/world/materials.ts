import {
  Color,
  DoubleSide,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Material,
  type Texture,
  type WebGLRenderer,
} from 'three';
import type { TileTextureSet } from './textures';

export interface MaterialLibrary {
  tileWall: MeshPhysicalMaterial;
  tileFloor: MeshPhysicalMaterial;
  tileUnderwater: MeshPhysicalMaterial;
  tileDark: MeshStandardMaterial;
  plaster: MeshStandardMaterial;
  concrete: MeshStandardMaterial;
  chrome: MeshStandardMaterial;
  darkMetal: MeshStandardMaterial;
  redPlastic: MeshPhysicalMaterial;
  whitePlastic: MeshPhysicalMaterial;
  vinyl: Record<string, MeshPhysicalMaterial>;
  sign: MeshStandardMaterial;
  signDeep: MeshStandardMaterial;
  windowGlass: MeshBasicMaterial;
  skylightGlass: MeshBasicMaterial;
  fluorescent: MeshBasicMaterial;
  warmGlow: MeshBasicMaterial;
  black: MeshBasicMaterial;
  poolTileBand: MeshStandardMaterial;
}

export interface MaterialOptions {
  tiles: TileTextureSet;
  renderer: WebGLRenderer;
  signNoDiving: Texture;
  signDepth: Texture;
}

function configure<T extends MeshStandardMaterial>(material: T): T {
  material.envMapIntensity = 0.85;
  return material;
}

export function createMaterials(options: MaterialOptions): MaterialLibrary {
  const { tiles, signNoDiving, signDepth } = options;

  const tileWall = configure(
    new MeshPhysicalMaterial({
      name: 'tile.wall',
      map: tiles.albedo,
      normalMap: tiles.normal,
      roughnessMap: tiles.roughness,
      metalness: 0,
      roughness: 1,
      clearcoat: 0.9,
      clearcoatRoughness: 0.07,
    }),
  );

  // The expression above is intentionally avoided: construct the vector explicitly
  // so the material API stays readable and version-stable.
  tileWall.normalScale.set(0.75, 0.75);
  tileWall.color = new Color(0xf4f0e6);

  const tileFloor = configure(
    new MeshPhysicalMaterial({
      name: 'tile.floor',
      map: tiles.albedo,
      normalMap: tiles.normal,
      roughnessMap: tiles.roughness,
      metalness: 0,
      roughness: 1,
      clearcoat: 0.55,
      clearcoatRoughness: 0.16,
    }),
  );
  tileFloor.normalScale.set(0.9, 0.9);
  tileFloor.color = new Color(0xe9e5db);

  const tileUnderwater = configure(
    new MeshPhysicalMaterial({
      name: 'tile.underwater',
      map: tiles.albedo,
      normalMap: tiles.normal,
      roughnessMap: tiles.roughness,
      metalness: 0,
      roughness: 1,
      clearcoat: 0.4,
      clearcoatRoughness: 0.2,
    }),
  );
  tileUnderwater.normalScale.set(0.9, 0.9);
  tileUnderwater.color = new Color(0x9fb6ad);

  const tileDark = configure(
    new MeshStandardMaterial({
      name: 'tile.band',
      map: tiles.albedo,
      normalMap: tiles.normal,
      roughnessMap: tiles.roughness,
      color: 0x20443f,
      roughness: 1,
      metalness: 0,
    }),
  );
  tileDark.normalScale.set(1.1, 1.1);

  const plaster = configure(
    new MeshStandardMaterial({
      name: 'plaster',
      color: 0xd9d6cb,
      roughness: 0.9,
      metalness: 0,
    }),
  );
  plaster.envMapIntensity = 0.5;

  const concrete = configure(
    new MeshStandardMaterial({
      name: 'concrete',
      color: 0x6f6c63,
      roughness: 0.82,
      metalness: 0,
    }),
  );
  concrete.envMapIntensity = 0.45;

  const chrome = configure(
    new MeshStandardMaterial({
      name: 'chrome',
      color: 0xdfe3e2,
      metalness: 1,
      roughness: 0.075,
    }),
  );
  chrome.envMapIntensity = 1.35;

  const darkMetal = configure(
    new MeshStandardMaterial({
      name: 'dark-metal',
      color: 0x2a2d2c,
      metalness: 0.85,
      roughness: 0.32,
    }),
  );

  const redPlastic = configure(
    new MeshPhysicalMaterial({
      name: 'red-plastic',
      color: 0x9c1d16,
      roughness: 0.22,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.075,
      sheen: 0.25,
      sheenColor: new Color(0xff6a4e),
      sheenRoughness: 0.6,
    }),
  );
  redPlastic.envMapIntensity = 1.05;

  const whitePlastic = configure(
    new MeshPhysicalMaterial({
      name: 'white-plastic',
      color: 0xe6e2d8,
      roughness: 0.34,
      metalness: 0,
      clearcoat: 0.8,
      clearcoatRoughness: 0.18,
    }),
  );

  const makeVinyl = (color: number, map?: Texture): MeshPhysicalMaterial => {
    const material = configure(
      new MeshPhysicalMaterial({
        name: `vinyl-${color.toString(16)}`,
        color,
        map,
        roughness: 0.26,
        metalness: 0,
        clearcoat: 0.75,
        clearcoatRoughness: 0.12,
        sheen: 0.3,
        sheenColor: new Color(0xffffff),
        sheenRoughness: 0.4,
      }),
    );
    material.envMapIntensity = 0.95;
    return material;
  };

  const sign = configure(
    new MeshStandardMaterial({
      name: 'sign',
      map: signNoDiving,
      roughness: 0.48,
      metalness: 0.05,
      color: 0xffffff,
      transparent: false,
    }),
  );

  const signDeep = configure(
    new MeshStandardMaterial({
      name: 'sign.deep',
      map: signDepth,
      roughness: 0.5,
      metalness: 0.02,
      color: 0xffffff,
    }),
  );

  const windowGlass = new MeshBasicMaterial({
    name: 'window-glass',
    color: 0xf7fbff,
    toneMapped: false,
  });
  windowGlass.color.multiplyScalar(2.1);

  const skylightGlass = new MeshBasicMaterial({
    name: 'skylight',
    color: 0xffffff,
    toneMapped: false,
  });
  skylightGlass.color.multiplyScalar(2.8);

  const fluorescent = new MeshBasicMaterial({
    name: 'fluorescent',
    color: 0xdcefff,
    toneMapped: false,
  });
  fluorescent.color.multiplyScalar(2.4);

  const warmGlow = new MeshBasicMaterial({
    name: 'warm-glow',
    color: 0xffc38a,
    toneMapped: false,
  });
  warmGlow.color.multiplyScalar(1.6);

  const black = new MeshBasicMaterial({ name: 'void', color: 0x000000 });

  const poolTileBand = new MeshStandardMaterial({
    name: 'pool-band',
    color: 0x1e514b,
    roughness: 0.45,
    metalness: 0.02,
  });

  // Planar architecture must cast and receive from both faces: the sun sits
  // outside the shell and the interior sees the back of the ceiling plane.
  for (const material of [tileWall, tileFloor, tileUnderwater, tileDark, plaster, concrete]) {
    material.side = DoubleSide;
  }

  void signDepth;

  return {
    tileWall,
    tileFloor,
    tileUnderwater,
    tileDark,
    plaster,
    concrete,
    chrome,
    darkMetal,
    redPlastic,
    whitePlastic,
    vinyl: {
      red: makeVinyl(0xc83426),
      yellow: makeVinyl(0xe8b21b),
      blue: makeVinyl(0x2b53b8),
    },
    sign,
    signDeep,
    windowGlass,
    skylightGlass,
    fluorescent,
    warmGlow,
    black,
    poolTileBand,
  };
}
