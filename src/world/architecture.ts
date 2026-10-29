import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  MeshBasicMaterial,
  type Material,
  Path,
  PlaneGeometry,
  Shape,
  ShapeGeometry,
  type BufferGeometry,
  type Mesh,
  type Object3D,
  type Scene,
} from 'three';
import { LAYOUT } from './layout';
import { addStaticMesh, applyWorldUVs, wallPlane, worldBox } from './geometry';
import type { MaterialLibrary } from './materials';
import { buildRoomDetail, type RoomDetail } from './architectureDetail';
import { createFrostedPaneTexture, createSkylightTexture, createWarmDoorwayTexture, hdrColor } from './lightTextures';

interface ArchOpening {
  cx: number;
  width: number;
  bottom: number;
  spring: number;
  /** Radius defaults to half the width. */
  radius?: number;
}

function archPath(opening: ArchOpening): Path {
  const half = opening.width / 2;
  const radius = opening.radius ?? half;
  const path = new Path();
  path.moveTo(opening.cx - half, opening.bottom);
  path.lineTo(opening.cx - half, opening.spring);
  path.absarc(opening.cx, opening.spring, radius, Math.PI, 0, true);
  path.lineTo(opening.cx + half, opening.bottom);
  path.closePath();
  return path;
}

function shapeWithHoles(width: number, height: number, holes: readonly ArchOpening[], cx = 0, bottom = 0): Shape {
  const shape = new Shape();
  shape.moveTo(cx - width / 2, bottom);
  shape.lineTo(cx + width / 2, bottom);
  shape.lineTo(cx + width / 2, bottom + height);
  shape.lineTo(cx - width / 2, bottom + height);
  shape.closePath();
  for (const hole of holes) shape.holes.push(archPath(hole));
  return shape;
}

function flatShape(shape: Shape, curveSegments = 28): BufferGeometry {
  const geometry = new ShapeGeometry(shape, curveSegments);
  applyWorldUVs(geometry);
  return geometry;
}

export interface Architecture {
  group: Group;
  occluders: Mesh[];
  detail: RoomDetail;
}

/**
 * Static building fabric. Everything is authored in world space so tile seams
 * continue across adjacent walls, and so a later light bake can ray-cast the
 * same meshes without instancing ambiguity.
 */
export function buildArchitecture(scene: Scene, materials: MaterialLibrary): Architecture {
  const group = new Group();
  group.name = 'architecture';
  scene.add(group);
  const occluders: Mesh[] = [];
  const add = (
    geometry: BufferGeometry,
    material: Material,
    name: string,
    options: { castShadow?: boolean; receiveShadow?: boolean } = {},
  ): Mesh => {
    const mesh = addStaticMesh(group, geometry, material, name, options);
    if (options.castShadow !== false) occluders.push(mesh);
    return mesh;
  };

  const H = LAYOUT.hall;
  const W = LAYOUT.water;
  const wallHeight = H.ceiling - H.deck;
  const wallCenterY = H.deck + wallHeight / 2;

  // Emissive pane detail (lighting lane): clipped highlights keep their frost,
  // dirt and seam structure instead of reading as flat white rectangles. The HDR
  // radiance still comes from the material colour, so the single display
  // transform contract is untouched. `emissiveMean` is the sRGB-decoded mean of
  // the modulation map, which the static live bake uses as the pane radiance.
  if (!materials.windowGlass.map) {
    materials.windowGlass.map = createFrostedPaneTexture();
    materials.windowGlass.color.copy(hdrColor(0xf7fbff, 2.95));
    materials.windowGlass.userData.emissiveMean = 0.62;
    materials.windowGlass.needsUpdate = true;
  }
  if (!materials.skylightGlass.map) {
    const skylightLength = LAYOUT.skylight.zMax - LAYOUT.skylight.zMin;
    materials.skylightGlass.map = createSkylightTexture(64, 1024, {
      bays: 9,
      seamOffset: 2.5 / skylightLength,
    });
    materials.skylightGlass.color.copy(hdrColor(0xffffff, 2.75));
    materials.skylightGlass.userData.emissiveMean = 0.78;
    materials.skylightGlass.needsUpdate = true;
  }

  // ---- Outer shell -------------------------------------------------------
  add(wallPlane(58, wallHeight, -H.halfWidth, wallCenterY, 0, Math.PI / 2), materials.tileWall, 'wall.left');
  add(wallPlane(58, wallHeight, H.halfWidth, wallCenterY, 0, -Math.PI / 2), materials.tileWall, 'wall.right');

  // Near wall: a dark service doorway implies the way back out.
  add(wallPlane(16.8, wallHeight, 0, wallCenterY, H.zMin, 0), materials.tileWall, 'wall.near');
  const nearDoor = new Shape();
  const nearArch: ArchOpening = { cx: 0, width: 3.3, bottom: H.deck, spring: 2.25, radius: 1.65 };
  nearDoor.moveTo(-1.65, H.deck);
  nearDoor.lineTo(-1.65, 2.25);
  nearDoor.absarc(0, 2.25, 1.65, Math.PI, 0, true);
  nearDoor.lineTo(1.65, H.deck);
  const nearDoorGeo = new ShapeGeometry(nearDoor, 28);
  nearDoorGeo.translate(0, 0, H.zMin + 0.012);
  add(nearDoorGeo, materials.black, 'near-door', { castShadow: false, receiveShadow: false });

  // ---- Deck + coping -----------------------------------------------------
  const deckY = H.deck;
  add(worldBox(0.86, deckY, 58, 7.97, deckY / 2, 0), materials.tileFloor, 'deck.right');
  add(worldBox(0.86, deckY, 58, -7.97, deckY / 2, 0), materials.tileFloor, 'deck.left');
  add(worldBox(15.08, deckY, 1.16, 0, deckY / 2, -28.42), materials.tileFloor, 'deck.near');
  add(worldBox(15.08, deckY, 1.16, 0, deckY / 2, 28.42), materials.tileFloor, 'deck.far');

  const copingW = 0.34;
  const copingH = 0.24;
  for (const side of [-1, 1] as const) {
    add(
      worldBox(copingW, copingH, 55, side * 7.37, deckY - copingH / 2, 0),
      materials.tileFloor,
      `coping.side.${side}`,
    );
  }
  add(worldBox(14.4, copingH, copingW, 0, deckY - copingH / 2, 27.67), materials.tileFloor, 'coping.far');
  add(worldBox(14.4, copingH, copingW, 0, deckY - copingH / 2, -27.67), materials.tileFloor, 'coping.near');
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      add(
        worldBox(copingW, copingH, copingW, sx * 7.37, deckY - copingH / 2, sz * 27.67),
        materials.tileFloor,
        `coping.corner.${sx}.${sz}`,
      );
    }
  }

  // ---- Basin -------------------------------------------------------------
  const basinCenterY = (H.deck + W.floor) / 2;
  const basinHeight = H.deck - W.floor;
  add(wallPlane(55, basinHeight, -W.halfWidth, basinCenterY, 0, Math.PI / 2), materials.tileUnderwater, 'basin.left');
  add(wallPlane(55, basinHeight, W.halfWidth, basinCenterY, 0, -Math.PI / 2), materials.tileUnderwater, 'basin.right');
  add(wallPlane(14.4, basinHeight, 0, basinCenterY, W.zMin, 0), materials.tileUnderwater, 'basin.near');
  add(wallPlane(14.4, basinHeight, 0, basinCenterY, W.zMax, Math.PI), materials.tileUnderwater, 'basin.far');
  const basinFloor = new PlaneGeometry(14.4, 55);
  basinFloor.rotateX(-Math.PI / 2);
  basinFloor.translate(0, W.floor, 0);
  applyWorldUVs(basinFloor);
  add(basinFloor, materials.tileUnderwater, 'basin.floor');

  // Dark lane tiles under the water line, visible through the surface.
  for (const side of [-1, 1] as const) {
    add(
      wallPlane(55, 0.22, side * (W.halfWidth - 0.005), 0.24, 0, side > 0 ? -Math.PI / 2 : Math.PI / 2),
      materials.poolTileBand,
      `basin.lane.${side}`,
      { castShadow: false },
    );
  }

  // ---- Tile wainscot + chrome rail on the dry walls ----------------------
  for (const side of [-1, 1] as const) {
    const x = side * (H.halfWidth - 0.006);
    add(
      wallPlane(58, 0.86, x, H.deck + 0.43, 0, side > 0 ? -Math.PI / 2 : Math.PI / 2),
      materials.tileDark,
      `wainscot.${side}`,
      { castShadow: false },
    );
    const trim = new BoxGeometry(0.035, 0.035, 58);
    trim.translate(x, H.deck + 0.86, 0);
    applyWorldUVs(trim);
    add(trim, materials.chrome, `wainscot.trim.${side}`, { castShadow: false });
  }
  add(
    wallPlane(16.8, 0.86, 0, H.deck + 0.43, H.zMin + 0.006, 0),
    materials.tileDark,
    'wainscot.near',
    { castShadow: false },
  );

  // ---- Ceiling with skylight aperture ------------------------------------
  // Shape space is (x, z); rotateX(+90°) maps shape +y to world +z and the
  // face normal to -y, so the ceiling is seen from inside the hall.
  const ceilingShape = new Shape();
  ceilingShape.moveTo(-8.4, -29);
  ceilingShape.lineTo(8.4, -29);
  ceilingShape.lineTo(8.4, 29);
  ceilingShape.lineTo(-8.4, 29);
  ceilingShape.closePath();
  const aperture = new Path();
  aperture.moveTo(-LAYOUT.skylight.halfWidth, LAYOUT.skylight.zMin);
  aperture.lineTo(LAYOUT.skylight.halfWidth, LAYOUT.skylight.zMin);
  aperture.lineTo(LAYOUT.skylight.halfWidth, LAYOUT.skylight.zMax);
  aperture.lineTo(-LAYOUT.skylight.halfWidth, LAYOUT.skylight.zMax);
  aperture.closePath();
  ceilingShape.holes.push(aperture);
  const ceilingGeometry = new ShapeGeometry(ceilingShape, 4);
  ceilingGeometry.rotateX(Math.PI / 2);
  ceilingGeometry.translate(0, H.ceiling, 0);
  applyWorldUVs(ceilingGeometry);
  add(ceilingGeometry, materials.plaster, 'ceiling', { receiveShadow: true });

  // Skylight well + frosted panel.
  const well = LAYOUT.skylight;
  for (const side of [-1, 1] as const) {
    add(
      wallPlane(well.zMax - well.zMin, well.wellHeight, side * well.halfWidth, H.ceiling + well.wellHeight / 2, (well.zMin + well.zMax) / 2, side > 0 ? -Math.PI / 2 : Math.PI / 2),
      materials.plaster,
      `skylight.well.${side}`,
      { castShadow: false, receiveShadow: false },
    );
  }
  add(
    wallPlane(well.halfWidth * 2, well.wellHeight, 0, H.ceiling + well.wellHeight / 2, well.zMin, 0),
    materials.plaster,
    'skylight.well.near',
    { castShadow: false, receiveShadow: false },
  );
  add(
    wallPlane(well.halfWidth * 2, well.wellHeight, 0, H.ceiling + well.wellHeight / 2, well.zMax, Math.PI),
    materials.plaster,
    'skylight.well.far',
    { castShadow: false, receiveShadow: false },
  );
  const skylightPanel = new PlaneGeometry(well.halfWidth * 2, well.zMax - well.zMin);
  skylightPanel.rotateX(Math.PI / 2);
  skylightPanel.translate(0, well.panelY, (well.zMin + well.zMax) / 2);
  add(skylightPanel, materials.skylightGlass, 'skylight.panel', { castShadow: false, receiveShadow: false });

  // A simple expressed frame around the aperture.
  for (const side of [-1, 1] as const) {
    const frame = new BoxGeometry(0.14, 0.2, well.zMax - well.zMin);
    frame.translate(side * well.halfWidth, H.ceiling - 0.04, (well.zMin + well.zMax) / 2);
    applyWorldUVs(frame);
    add(frame, materials.darkMetal, `skylight.frame.${side}`, { castShadow: false });
  }
  for (let z = well.zMin + 2.5; z < well.zMax; z += 5) {
    const mullion = new BoxGeometry(well.halfWidth * 2, 0.055, 0.055);
    mullion.translate(0, well.panelY - 0.02, z);
    applyWorldUVs(mullion);
    add(mullion, materials.darkMetal, `skylight.mullion.${z}`, { castShadow: false, receiveShadow: false });
  }

  // Ceiling ribs, split around the skylight.
  for (let z = -27.8; z <= 28; z += 5.6) {
    for (const side of [-1, 1] as const) {
      const length = 8.4 - well.halfWidth;
      const rib = new BoxGeometry(length, 0.5, 0.28);
      rib.translate(side * (well.halfWidth + length / 2), H.ceiling - 0.25, z);
      applyWorldUVs(rib);
      add(rib, materials.plaster, `ceiling.rib.${z}.${side}`, { receiveShadow: true });
    }
  }

  // ---- Windows -----------------------------------------------------------
  const win = LAYOUT.windows;
  for (const side of [-1, 1] as const) {
    for (const z of win.centers) {
      const wallX = side * H.halfWidth;
      const inward = side > 0 ? -1 : 1;
      const frameX = wallX + inward * 0.04;
      const glassX = wallX + inward * 0.11;
      const frame = new BoxGeometry(0.09, win.height + 0.16, win.width + 0.16);
      frame.translate(frameX, win.centerY, z);
      applyWorldUVs(frame);
      add(frame, materials.darkMetal, `window.frame.${side}.${z}`, { castShadow: false, receiveShadow: false });
      const glass = new PlaneGeometry(win.width, win.height);
      glass.rotateY(side > 0 ? -Math.PI / 2 : Math.PI / 2);
      glass.translate(glassX, win.centerY, z);
      add(glass, materials.windowGlass, `window.glass.${side}.${z}`, { castShadow: false, receiveShadow: false });
      // Mullions sit just proud of the frosted pane.
      const barX = glassX + inward * 0.012;
      for (const offset of [-0.34, 0, 0.34]) {
        const bar = new BoxGeometry(0.022, win.height - 0.05, 0.025);
        bar.translate(barX, win.centerY, z + offset * win.width);
        applyWorldUVs(bar);
        add(bar, materials.darkMetal, `window.bar.${side}.${z}.${offset}`, { castShadow: false, receiveShadow: false });
      }
      const transom = new BoxGeometry(0.022, 0.028, win.width - 0.04);
      transom.translate(barX, win.centerY + 0.42, z);
      applyWorldUVs(transom);
      add(transom, materials.darkMetal, `window.transom.${side}.${z}`, { castShadow: false, receiveShadow: false });
      const sill = new BoxGeometry(0.16, 0.055, win.width + 0.2);
      sill.translate(wallX + inward * 0.025, win.centerY - win.height / 2 - 0.05, z);
      applyWorldUVs(sill);
      add(sill, materials.whitePlastic, `window.sill.${side}.${z}`, { castShadow: false });
    }
  }

  // ---- Columns -----------------------------------------------------------
  for (const side of [-1, 1] as const) {
    for (const z of LAYOUT.columns.z) {
      const x = side * LAYOUT.columns.x;
      const column = new BoxGeometry(LAYOUT.columns.size, H.ceiling - H.deck, LAYOUT.columns.size);
      column.translate(x, H.deck + (H.ceiling - H.deck) / 2, z);
      applyWorldUVs(column);
      add(column, materials.tileWall, `column.${side}.${z}`);
      const base = new BoxGeometry(0.7, 0.95, 0.7);
      base.translate(x, H.deck + 0.475, z);
      applyWorldUVs(base);
      add(base, materials.tileDark, `column.base.${side}.${z}`, { castShadow: false });
      const trim = new BoxGeometry(0.72, 0.03, 0.72);
      trim.translate(x, H.deck + 0.95, z);
      applyWorldUVs(trim);
      add(trim, materials.chrome, `column.trim.${side}.${z}`, { castShadow: false });
      const capital = new BoxGeometry(0.8, 0.16, 0.8);
      capital.translate(x, H.ceiling - 0.1, z);
      applyWorldUVs(capital);
      add(capital, materials.plaster, `column.capital.${side}.${z}`, { castShadow: false });
    }
  }

  // ---- Transverse arch screen -------------------------------------------
  const screenShape = new Shape();
  screenShape.moveTo(-8.4, 0.02);
  screenShape.lineTo(8.4, 0.02);
  screenShape.lineTo(8.4, H.ceiling);
  screenShape.lineTo(-8.4, H.ceiling);
  screenShape.closePath();
  screenShape.holes.push(archPath({ cx: 0, width: 6.1, bottom: 0.12, spring: 3.55, radius: 3.05 }));
  screenShape.holes.push(archPath({ cx: -6.45, width: 2.25, bottom: H.deck, spring: 2.55, radius: 1.125 }));
  screenShape.holes.push(archPath({ cx: 6.45, width: 2.25, bottom: H.deck, spring: 2.55, radius: 1.125 }));
  const screenGeometry = new ExtrudeGeometry(screenShape, {
    depth: 0.38,
    bevelEnabled: false,
    curveSegments: 28,
  });
  screenGeometry.translate(0, 0, 18.4);
  applyWorldUVs(screenGeometry);
  add(screenGeometry, materials.tileWall, 'screen.arch');
  // Soffit shadow line under the big arch.
  const screenArchTrim = new ExtrudeGeometry(
    (() => {
      const outer = new Shape();
      outer.moveTo(-3.2, 0.0);
      outer.lineTo(-3.2, 3.55);
      outer.absarc(0, 3.55, 3.2, Math.PI, 0, true);
      outer.lineTo(3.2, 0.0);
      const inner = archPath({ cx: 0, width: 6.1, bottom: 0.12, spring: 3.55, radius: 3.05 });
      outer.holes.push(inner);
      return outer;
    })(),
    { depth: 0.42, bevelEnabled: false, curveSegments: 28 },
  );
  screenArchTrim.translate(0, 0, 18.38);
  applyWorldUVs(screenArchTrim);
  add(screenArchTrim, materials.plaster, 'screen.arch.trim', { castShadow: false });

  // ---- Far wall + warm corridor -----------------------------------------
  const farShape = new Shape();
  farShape.moveTo(-8.4, H.deck);
  farShape.lineTo(8.4, H.deck);
  farShape.lineTo(8.4, H.ceiling);
  farShape.lineTo(-8.4, H.ceiling);
  farShape.closePath();
  farShape.holes.push(archPath({ cx: 0, width: LAYOUT.farArch.width, bottom: 0.08, spring: LAYOUT.farArch.springY, radius: 2.15 }));
  const farGeometry = new ShapeGeometry(farShape, 32);
  farGeometry.rotateY(Math.PI);
  farGeometry.translate(0, 0, H.zMax);
  applyWorldUVs(farGeometry);
  add(farGeometry, materials.tileWall, 'wall.far');

  // ---- Deep warm service corridor behind the arch ------------------------
  // The warm opening has to read as depth, not a flat orange card: tiled side
  // walls catch the corridor lamp, a lit doorway sits at the far end with a
  // falloff map, and two silhouette layers (a frame and a pipe run) parallax
  // against the glow as the camera moves.
  const farWall = H.zMax;
  const corridorLength = 8.4;
  const corridorHalfWidth = 3.6;
  const corridorHeight = H.ceiling - H.deck;
  const corridorCenterY = H.deck + corridorHeight / 2;
  add(
    wallPlane(corridorHalfWidth * 2, corridorHeight, 0, corridorCenterY, farWall + corridorLength, Math.PI),
    materials.tileWall,
    'corridor.end',
    { castShadow: false },
  );
  add(
    wallPlane(corridorLength, corridorHeight, -corridorHalfWidth, corridorCenterY, farWall + corridorLength / 2, Math.PI / 2),
    materials.tileWall,
    'corridor.left',
    { castShadow: false },
  );
  add(
    wallPlane(corridorLength, corridorHeight, corridorHalfWidth, corridorCenterY, farWall + corridorLength / 2, -Math.PI / 2),
    materials.tileWall,
    'corridor.right',
    { castShadow: false },
  );
  const corridorCeiling = new PlaneGeometry(corridorHalfWidth * 2, corridorLength);
  corridorCeiling.rotateX(Math.PI / 2);
  corridorCeiling.translate(0, H.ceiling, farWall + corridorLength / 2);
  applyWorldUVs(corridorCeiling);
  add(corridorCeiling, materials.plaster, 'corridor.ceiling', { castShadow: false, receiveShadow: true });
  const corridorFloor = new PlaneGeometry(corridorHalfWidth * 2, corridorLength);
  corridorFloor.rotateX(-Math.PI / 2);
  corridorFloor.translate(0, H.deck, farWall + corridorLength / 2);
  applyWorldUVs(corridorFloor);
  add(corridorFloor, materials.tileFloor, 'corridor.floor', { castShadow: false });

  // The warm endpoint: a lit doorway with real falloff and a far-door silhouette.
  if (!materials.warmGlow.map) {
    materials.warmGlow.map = createWarmDoorwayTexture();
    materials.warmGlow.color.copy(hdrColor(0xff9d4c, 1.85));
    materials.warmGlow.userData.emissiveMean = 0.55;
    materials.warmGlow.needsUpdate = true;
  }
  const doorwayGlow = new PlaneGeometry(2.6, 3.9);
  doorwayGlow.rotateY(Math.PI);
  doorwayGlow.translate(0, H.deck + 1.95, farWall + corridorLength - 0.02);
  add(doorwayGlow, materials.warmGlow, 'corridor.doorway', { castShadow: false, receiveShadow: false });
  for (const side of [-1, 1] as const) {
    const jamb = new BoxGeometry(0.16, 3.9, 0.16);
    jamb.translate(side * 1.38, H.deck + 1.95, farWall + corridorLength - 0.12);
    applyWorldUVs(jamb);
    add(jamb, materials.darkMetal, `corridor.jamb.${side}`, { castShadow: false, receiveShadow: false });
  }
  const doorLintel = new BoxGeometry(2.92, 0.16, 0.16);
  doorLintel.translate(0, H.deck + 3.9, farWall + corridorLength - 0.12);
  applyWorldUVs(doorLintel);
  add(doorLintel, materials.darkMetal, 'corridor.lintel', { castShadow: false, receiveShadow: false });

  // Mid-depth silhouette: a steel frame the eye reads in front of the glow.
  for (const side of [-1, 1] as const) {
    const post = new BoxGeometry(0.22, 3.4, 0.22);
    post.translate(side * 2.55, H.deck + 1.7, farWall + 2.6);
    applyWorldUVs(post);
    add(post, materials.darkMetal, `corridor.post.${side}`, { castShadow: false, receiveShadow: false });
  }
  const frameLintel = new BoxGeometry(5.32, 0.2, 0.22);
  frameLintel.translate(0, H.deck + 3.4, farWall + 2.6);
  applyWorldUVs(frameLintel);
  add(frameLintel, materials.darkMetal, 'corridor.frame.lintel', { castShadow: false, receiveShadow: false });
  const corridorPipe = new CylinderGeometry(0.2, 0.2, corridorHalfWidth * 2, 12);
  corridorPipe.rotateZ(Math.PI / 2);
  corridorPipe.translate(0, 5.6, farWall + 5.6);
  applyWorldUVs(corridorPipe);
  add(corridorPipe, materials.darkMetal, 'corridor.pipe', { castShadow: false, receiveShadow: false });

  // A warm pool of light on the deck just inside the arch.
  const floorGlow = new PlaneGeometry(3.6, 2.4);
  floorGlow.rotateX(-Math.PI / 2);
  floorGlow.translate(0, H.deck + 0.006, farWall + 1.2);
  const floorGlowMaterial = new MeshBasicMaterial({
    color: hdrColor(0xffb26b, 0.5),
    transparent: true,
    opacity: 0.55,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  add(floorGlow, floorGlowMaterial, 'corridor.floor.pool', { castShadow: false, receiveShadow: false });

  // ---- Steps at the far end ---------------------------------------------
  const stair = LAYOUT.stairs;
  const stepHeight = 0.135;
  const stepDepth = 0.31;
  for (let i = 0; i < stair.steps; i++) {
    const top = H.deck - i * stepHeight;
    const z = W.zMax - i * stepDepth - stepDepth / 2;
    add(
      worldBox(stair.width, stepHeight, stepDepth, stair.x, top - stepHeight / 2, z),
      materials.tileFloor,
      `stairs.${i}`,
    );
  }

  // ---- Fluorescent fixtures ---------------------------------------------
  for (const side of [-1, 1] as const) {
    for (const z of [-20, -10, 0, 10, 20]) {
      const x = side * 5.35;
      const housing = new BoxGeometry(0.2, 0.11, 3.2);
      housing.translate(x, 7.48, z);
      applyWorldUVs(housing);
      add(housing, materials.darkMetal, `fixture.housing.${side}.${z}`, { castShadow: false });
      const tube = new PlaneGeometry(0.13, 3.0);
      tube.rotateX(Math.PI / 2);
      tube.translate(x, 7.415, z);
      add(tube, materials.fluorescent, `fixture.tube.${side}.${z}`, { castShadow: false, receiveShadow: false });
      for (const dz of [-1.45, 1.45]) {
        const rod = new CylinderGeometry(0.012, 0.012, 0.62, 6);
        rod.translate(x, 7.48 + 0.31, z + dz);
        add(rod, materials.darkMetal, `fixture.rod.${side}.${z}.${dz}`, { castShadow: false, receiveShadow: false });
      }
    }
  }

  // ---- Signs -------------------------------------------------------------
  const sign = new PlaneGeometry(1.75, 0.88);
  sign.rotateY(-Math.PI / 2);
  sign.translate(H.halfWidth - 0.035, 2.55, -8.6);
  add(sign, materials.sign, 'sign.no-diving', { castShadow: false, receiveShadow: true });

  const depthSign = new PlaneGeometry(1.5, 0.75);
  depthSign.rotateY(-Math.PI / 2);
  depthSign.translate(-H.halfWidth + 0.035, 2.55, 10.5);
  add(depthSign, materials.signDeep, 'sign.depth', { castShadow: false, receiveShadow: true });

  // ---- Far arch trim -----------------------------------------------------
  const trimShape = new Shape();
  const outerW = LAYOUT.farArch.width / 2 + 0.22;
  trimShape.moveTo(-outerW, 0.08);
  trimShape.lineTo(-outerW, LAYOUT.farArch.springY);
  trimShape.absarc(0, LAYOUT.farArch.springY, outerW, Math.PI, 0, true);
  trimShape.lineTo(outerW, 0.08);
  trimShape.closePath();
  const trimHole = archPath({
    cx: 0,
    width: LAYOUT.farArch.width,
    bottom: 0.08,
    spring: LAYOUT.farArch.springY,
    radius: 2.15,
  });
  trimShape.holes.push(trimHole);
  const trimGeo = new ExtrudeGeometry(trimShape, { depth: 0.3, bevelEnabled: false, curveSegments: 32 });
  trimGeo.translate(0, 0, H.zMax - 0.25);
  applyWorldUVs(trimGeo);
  add(trimGeo, materials.plaster, 'far.arch.trim', { castShadow: false });

  // Deck hardware, pool markings, wall lamps, ceiling services and notices.
  // Merged per material and static, so the lighting bake can treat it as fabric.
  const detail = buildRoomDetail(group, materials);
  group.traverse((object) => {
    if ((object as Mesh).isMesh) {
      object.frustumCulled = true;
    }
  });

  return { group, occluders, detail };
}
