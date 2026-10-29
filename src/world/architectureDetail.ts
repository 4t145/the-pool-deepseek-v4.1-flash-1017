import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  CylinderGeometry,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  SphereGeometry,
  TorusGeometry,
  Group,
  type Material,
  type Mesh,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addStaticMesh, applyWorldUVs } from './geometry';
import type { MaterialLibrary } from './materials';
import { createSignTexture } from './textures';
import { hash2, Rng } from '../core/rng';
import { CEILING_RIB_Z, CEILING_RIB_SPACING, LAMP_RADIUS, ROOM_DETAIL } from './roomDetailLayout';
import { LAYOUT } from './layout';

/**
 * Non-structural room dressing: the small municipal hardware that makes the
 * hall feel maintained rather than extruded. Everything is merged per material
 * so the whole pass costs well under thirty draw calls.
 *
 * Geometry is authored in world space like the rest of the architecture
 * (1 UV unit = 1 metre) and never moves, so the lighting bake stays valid.
 */
export interface RoomDetail {
  group: Group;
  /** Materials that should be treated as light emitters by the bake. */
  emitterMaterialNames: readonly string[];
  drawMeshes: readonly Mesh[];
}

const H = LAYOUT.hall;

const box = (width: number, height: number, depth: number, x: number, y: number, z: number): BufferGeometry => {
  const geometry = new BoxGeometry(width, height, depth);
  geometry.translate(x, y, z);
  return geometry;
};

const cylinderX = (radius: number, length: number, x: number, y: number, z: number, segments = 10): BufferGeometry => {
  const geometry = new CylinderGeometry(radius, radius, length, segments, 1);
  geometry.rotateZ(Math.PI / 2);
  geometry.translate(x, y, z);
  return geometry;
};

const cylinderY = (radius: number, length: number, x: number, y: number, z: number, segments = 8): BufferGeometry => {
  const geometry = new CylinderGeometry(radius, radius, length, segments, 1);
  geometry.translate(x, y, z);
  return geometry;
};

const cylinderZ = (radius: number, length: number, x: number, y: number, z: number, segments = 10): BufferGeometry => {
  const geometry = new CylinderGeometry(radius, radius, length, segments, 1);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(x, y, z);
  return geometry;
};

/** Wall-hugging quad. `side` is +1 for the x = +halfWidth wall. */
const wallQuad = (width: number, height: number, side: number, x: number, y: number, z: number): BufferGeometry => {
  const geometry = new PlaneGeometry(width, height);
  geometry.rotateY(side > 0 ? -Math.PI / 2 : Math.PI / 2);
  geometry.translate(x, y, z);
  applyWorldUVs(geometry);
  return geometry;
};

/** Horizontal quad seen from above. */
const floorQuad = (width: number, depth: number, x: number, y: number, z: number): BufferGeometry => {
  const geometry = new PlaneGeometry(width, depth);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(x, y, z);
  return geometry;
};

/** Stain texture for the algae line above the waterline. RGBA, alpha carries the mask. */
function createAlgaeTexture(seed = 5150): Texture {
  const width = 512;
  const height = 64;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  const image = ctx.createImageData(width, height);
  const rng = new Rng(seed);
  // Vertical colonies: each column gets a reach and a density; the strip gets
  // sparser towards the top so the deposit looks deposited, not painted.
  const columns = Array.from({ length: width }, () => ({
    reach: 0.35 + rng.next() * 0.65,
    density: 0.35 + rng.next() * 0.65,
    tint: rng.next(),
  }));
  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const column = columns[x]!;
      const ragged = 0.9 + 0.1 * Math.sin(x * 0.11 + y * 0.07) + 0.06 * (hash2(x, y, seed) - 0.5);
      const reach = column.reach * ragged;
      const vertical = Math.min(1, Math.max(0, (reach - v) / 0.12));
      const grain = 0.75 + 0.25 * hash2(x, y * 3, seed + 7);
      const alpha = Math.min(1, vertical * column.density * grain);
      const o = (y * width + x) * 4;
      image.data[o] = 46 + Math.round(column.tint * 16);
      image.data[o + 1] = 72 + Math.round(column.tint * 12);
      image.data[o + 2] = 62 + Math.round(column.tint * 10);
      image.data[o + 3] = Math.round(alpha * 190);
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

interface Bucket {
  material: Material;
  geometries: BufferGeometry[];
  name: string;
  receiveShadow?: boolean;
}

function flush(parent: Group, bucket: Bucket, meshes: Mesh[]): void {
  if (bucket.geometries.length === 0) return;
  const prepared = bucket.geometries.map((geometry) => (geometry.index ? geometry.toNonIndexed() : geometry));
  const merged = mergeGeometries(prepared, false);
  for (const geometry of prepared) {
    if (!bucket.geometries.includes(geometry)) geometry.dispose();
  }
  for (const geometry of bucket.geometries) geometry.dispose();
  if (!merged) throw new Error(`room detail: failed to merge ${bucket.name}`);
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  const mesh = addStaticMesh(parent, merged, bucket.material, bucket.name, {
    castShadow: false,
    receiveShadow: bucket.receiveShadow ?? true,
  });
  meshes.push(mesh);
}

export function buildRoomDetail(parent: Group, materials: MaterialLibrary): RoomDetail {
  const group = new Group();
  group.name = 'room-detail';
  parent.add(group);
  const drawMeshes: Mesh[] = [];

  const galvanised = new MeshStandardMaterial({
    name: 'galvanised',
    color: 0x8e9894,
    metalness: 0.82,
    roughness: 0.42,
  });
  const poolPaint = new MeshStandardMaterial({
    name: 'pool-paint',
    color: 0x123b39,
    metalness: 0.02,
    roughness: 0.33,
  });
  const deckJoint = new MeshStandardMaterial({
    name: 'deck-joint',
    color: 0x37382f,
    metalness: 0,
    roughness: 0.95,
  });
  const lampOn = new MeshStandardMaterial({
    name: 'bulkhead-lamp',
    color: 0x2a2f2c,
    emissive: new Color(0xffdcaa),
    emissiveIntensity: 2.6,
    metalness: 0,
    roughness: 0.3,
  });
  const lampOff = new MeshStandardMaterial({
    name: 'bulkhead-lamp-off',
    color: 0x596158,
    metalness: 0.05,
    roughness: 0.34,
  });
  // Brushed drain steel: unlike the mirror chrome on the rails it stays a
  // readable dark slot instead of a string of white dashes.
  const drainSteel = new MeshStandardMaterial({
    name: 'drain-steel',
    color: 0x626966,
    metalness: 0.72,
    roughness: 0.46,
  });
  drainSteel.envMapIntensity = 0.7;
  const algaeTexture = createAlgaeTexture();
  algaeTexture.repeat.set(0.18, 1 / (ROOM_DETAIL.waterLine.algaeYMax - ROOM_DETAIL.waterLine.algaeYMin));
  algaeTexture.offset.set(0, -ROOM_DETAIL.waterLine.algaeYMin / (ROOM_DETAIL.waterLine.algaeYMax - ROOM_DETAIL.waterLine.algaeYMin));
  algaeTexture.colorSpace = SRGBColorSpace;
  const algae = new MeshStandardMaterial({
    name: 'waterline-algae',
    map: algaeTexture,
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    metalness: 0,
    roughness: 0.62,
  });

  const darkMetal: Bucket = { material: materials.darkMetal, geometries: [], name: 'detail.dark-metal' };
  const chrome: Bucket = { material: materials.chrome, geometries: [], name: 'detail.chrome' };
  const grate: Bucket = { material: drainSteel, geometries: [], name: 'detail.grate' };
  const joints: Bucket = { material: deckJoint, geometries: [], name: 'detail.deck-joints' };
  const paint: Bucket = { material: poolPaint, geometries: [], name: 'detail.lane-markings' };
  const waterLine: Bucket = { material: materials.tileDark, geometries: [], name: 'detail.waterline-band' };
  const algaeBuckets: Bucket = { material: algae, geometries: [], name: 'detail.algae' };
  const lampsLit: Bucket = { material: lampOn, geometries: [], name: 'detail.lamps-on' };
  const lampsDark: Bucket = { material: lampOff, geometries: [], name: 'detail.lamps-off' };
  const services: Bucket = { material: galvanised, geometries: [], name: 'detail.ceiling-services' };
  const hatchPanel: Bucket = { material: materials.plaster, geometries: [], name: 'detail.hatch-panel' };

  // ---- Coping overflow slot + stainless grate ----------------------------
  const gutter = ROOM_DETAIL.gutter;
  const gutterLength = gutter.zMax - gutter.zMin;
  const gutterMid = (gutter.zMin + gutter.zMax) / 2;
  const gutterSlotWidth = gutter.outerX - gutter.innerX;
  const gutterSlotMid = (gutter.innerX + gutter.outerX) / 2;
  for (const side of [-1, 1] as const) {
    // Recessed stainless plate; sits 3.5 mm proud of the coping so it reads as
    // a flush cover instead of z-fighting with the tile.
    darkMetal.geometries.push(
      box(gutterSlotWidth, 0.005, gutterLength, side * gutterSlotMid, gutter.plateTopY, gutterMid),
    );
    grate.geometries.push(
      box(gutter.sideRailWidth, 0.012, gutterLength, side * gutter.innerX, gutter.barTopY, gutterMid),
      box(gutter.sideRailWidth, 0.012, gutterLength, side * gutter.outerX, gutter.barTopY, gutterMid),
    );
    for (let i = 0; ; i++) {
      const z = gutter.zMin + i * gutter.barPitch;
      if (z > gutter.zMax) break;
      grate.geometries.push(
        box(gutterSlotWidth - 0.01, 0.009, 0.013, side * gutterSlotMid, gutter.barTopY, z),
      );
    }
  }

  // ---- Deck control joints ------------------------------------------------
  const jointsSpec = ROOM_DETAIL.deckJoints;
  const sideJointWidth = jointsSpec.sideXMax - jointsSpec.sideXMin;
  const sideJointCenter = (jointsSpec.sideXMin + jointsSpec.sideXMax) / 2;
  for (const side of [-1, 1] as const) {
    for (const z of jointsSpec.sideZs) {
      joints.geometries.push(box(sideJointWidth, 0.006, jointsSpec.width, side * sideJointCenter, jointsSpec.y, z));
    }
  }
  for (const z of jointsSpec.endDeckZs) {
    for (const x of jointsSpec.endXs) {
      joints.geometries.push(box(jointsSpec.width, 0.006, 0.98, x, jointsSpec.y, z));
    }
  }

  // ---- Painted lane markings ---------------------------------------------
  const lanes = ROOM_DETAIL.laneLines;
  for (const x of lanes.xs) {
    paint.geometries.push(floorQuad(lanes.width, lanes.zMax - lanes.zMin, x, lanes.floorY, (lanes.zMin + lanes.zMax) / 2));
  }
  for (const z of lanes.crossBarZs) {
    paint.geometries.push(floorQuad(lanes.crossBarHalfWidth * 2, lanes.width, 0, lanes.floorY, z));
  }
  const endWallHeight = lanes.endWallYMax - lanes.endWallYMin;
  const endWallCenter = (lanes.endWallYMin + lanes.endWallYMax) / 2;
  for (const z of [LAYOUT.water.zMin + 0.004, LAYOUT.water.zMax - 0.004] as const) {
    for (const x of lanes.xs) {
      const geometry = new PlaneGeometry(lanes.width, endWallHeight);
      geometry.rotateY(z > 0 ? Math.PI : 0);
      geometry.translate(x, endWallCenter, z);
      paint.geometries.push(geometry);
    }
  }

  // ---- Waterline band + algae line ---------------------------------------
  const wl = ROOM_DETAIL.waterLine;
  const bandHeight = wl.bandYMax - wl.bandYMin;
  const bandCenter = (wl.bandYMin + wl.bandYMax) / 2;
  const algaeHeight = wl.algaeYMax - wl.algaeYMin;
  const algaeCenter = (wl.algaeYMin + wl.algaeYMax) / 2;
  for (const side of [-1, 1] as const) {
    const x = side * (LAYOUT.water.halfWidth - wl.xInset);
    waterLine.geometries.push(
      wallQuad(wl.zMax - wl.zMin, bandHeight, side, x, bandCenter, (wl.zMin + wl.zMax) / 2),
    );
    algaeBuckets.geometries.push(
      wallQuad(wl.zMax - wl.zMin, algaeHeight, side, x - side * 0.001, algaeCenter, (wl.zMin + wl.zMax) / 2),
    );
  }

  // ---- Caged bulkhead lamps ----------------------------------------------
  const lamps = ROOM_DETAIL.lamps;
  const lit = new Set<number>(lamps.litIndices);
  for (const side of [-1, 1] as const) {
    lamps.zs.forEach((z, index) => {
      const wallX = side * (H.halfWidth - 0.02);
      chrome.geometries.push(cylinderX(0.112, 0.026, wallX, lamps.y, z, 14));
      // Dome pointing into the room.
      const dome = new SphereGeometry(0.095, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
      dome.rotateZ(side > 0 ? Math.PI / 2 : -Math.PI / 2);
      dome.translate(side * (H.halfWidth - 0.045), lamps.y, z);
      (lit.has(index) ? lampsLit : lampsDark).geometries.push(dome);
      // Two cage rings and four longitudinal bars.
      for (const offset of [0.03, 0.17]) {
        const ring = new TorusGeometry(LAMP_RADIUS - 0.012, 0.007, 5, 14);
        ring.rotateY(Math.PI / 2);
        ring.translate(side * (H.halfWidth - 0.02 - offset), lamps.y, z);
        chrome.geometries.push(ring);
      }
      for (const angle of [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2]) {
        const radius = LAMP_RADIUS - 0.012;
        chrome.geometries.push(
          cylinderX(
            0.0055,
            0.2,
            side * (H.halfWidth - 0.115),
            lamps.y + Math.cos(angle) * radius,
            z + Math.sin(angle) * radius,
            5,
          ),
        );
      }
    });
  }

  // ---- Galvanised ceiling services ---------------------------------------
  const pipes = ROOM_DETAIL.pipes;
  const ribMids: number[] = [];
  for (const rib of CEILING_RIB_Z) ribMids.push(rib + CEILING_RIB_SPACING / 2);
  for (const x of pipes.xs) {
    for (const [z0, z1] of pipes.zSections) {
      const length = z1 - z0;
      const center = (z0 + z1) / 2;
      services.geometries.push(cylinderZ(pipes.radius, length, x, pipes.y, center, 12));
      // Hangers hang from the slab between ribs.
      for (const mid of ribMids) {
        if (mid < z0 + 0.4 || mid > z1 - 0.4) continue;
        const top = pipes.hangerTopY;
        const bottom = pipes.y + pipes.radius;
        services.geometries.push(cylinderY(0.009, top - bottom, x, (top + bottom) / 2, mid, 5));
        services.geometries.push(box(0.17, 0.03, 0.05, x, pipes.y + pipes.radius + 0.015, mid));
      }
      // Sprinkler drops under the ribs.
      for (const rib of CEILING_RIB_Z) {
        if (rib < z0 + 0.35 || rib > z1 - 0.35) continue;
        const headY = pipes.y - pipes.radius - pipes.sprinklerDrop;
        services.geometries.push(
          cylinderY(0.012, pipes.sprinklerDrop, x, pipes.y - pipes.radius - pipes.sprinklerDrop / 2, rib, 5),
        );
        const head = new SphereGeometry(0.032, 6, 4);
        head.translate(x, headY, rib);
        services.geometries.push(head);
      }
      // Wall conduit with junction boxes, same sections as the pipe runs.
      const conduit = pipes.conduit;
      services.geometries.push(cylinderZ(conduit.radius, length, conduit.x, conduit.y, center, 6));
      for (let z = z0 + 1.5; z <= z1 - 1.5; z += conduit.boxPitch) {
        services.geometries.push(box(0.1, 0.11, 0.17, conduit.x, conduit.y, z));
      }
    }
  }

  // ---- High-level ventilation grilles ------------------------------------
  const grilles = ROOM_DETAIL.grilles;
  for (const side of [-1, 1] as const) {
    for (const z of grilles.zs) {
      const x = side * grilles.x;
      const halfW = grilles.width / 2;
      const halfH = grilles.height / 2;
      darkMetal.geometries.push(
        box(0.01, grilles.height, grilles.width, side * (H.halfWidth - 0.008), grilles.y, z),
        box(0.07, 0.05, grilles.width, x, grilles.y + halfH, z),
        box(0.07, 0.05, grilles.width, x, grilles.y - halfH, z),
        box(0.07, grilles.height, 0.05, x, grilles.y, z + halfW),
        box(0.07, grilles.height, 0.05, x, grilles.y, z - halfW),
      );
      const slats = 7;
      for (let i = 1; i < slats; i++) {
        const y = grilles.y - halfH + (grilles.height / slats) * i;
        darkMetal.geometries.push(box(0.055, 0.042, grilles.width - 0.08, x, y, z));
      }
    }
  }

  // ---- Ceiling access hatch ----------------------------------------------
  const hatch = ROOM_DETAIL.hatch;
  const hatchRim = 0.06;
  darkMetal.geometries.push(
    box(hatch.width + 0.1, hatchRim, 0.05, hatch.x, hatch.frameY, hatch.z + hatch.depth / 2),
    box(hatch.width + 0.1, hatchRim, 0.05, hatch.x, hatch.frameY, hatch.z - hatch.depth / 2),
    box(0.05, hatchRim, hatch.depth, hatch.x + hatch.width / 2, hatch.frameY, hatch.z),
    box(0.05, hatchRim, hatch.depth, hatch.x - hatch.width / 2, hatch.frameY, hatch.z),
  );
  hatchPanel.geometries.push(box(hatch.width, 0.02, hatch.depth, hatch.x, hatch.panelY, hatch.z));

  // ---- Enamel notices ----------------------------------------------------
  const noticeMaterials: Material[] = [];
  for (const notice of ROOM_DETAIL.notices) {
    const texture = createSignTexture([...notice.lines], {
      width: 768,
      height: 384,
      background: notice.background,
      ink: notice.ink,
      border: true,
    });
    const material = new MeshStandardMaterial({
      name: `notice-${notice.id}`,
      map: texture,
      roughness: 0.52,
      metalness: 0.05,
    });
    noticeMaterials.push(material);
    const plane = new PlaneGeometry(notice.width, notice.height);
    plane.rotateY(notice.side > 0 ? -Math.PI / 2 : Math.PI / 2);
    plane.translate(notice.side * (H.halfWidth - 0.006), notice.y, notice.z);
    const mesh = addStaticMesh(group, plane, material, `detail.notice.${notice.id}`, {
      castShadow: false,
      receiveShadow: true,
    });
    drawMeshes.push(mesh);
    darkMetal.geometries.push(
      box(0.03, notice.height + 0.06, notice.width + 0.06, notice.side * (H.halfWidth + 0.01), notice.y, notice.z),
    );
  }

  // Flush every merged bucket.
  for (const bucket of [
    darkMetal,
    chrome,
    grate,
    joints,
    paint,
    waterLine,
    algaeBuckets,
    lampsLit,
    lampsDark,
    services,
    hatchPanel,
  ]) {
    flush(group, bucket, drawMeshes);
  }

  return {
    group,
    emitterMaterialNames: ['bulkhead-lamp'],
    drawMeshes,
  };
}
