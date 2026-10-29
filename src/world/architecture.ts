import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  MeshBasicMaterial,
  type Material,
  MeshStandardMaterial,
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

  // A deep, dim service corridor behind the arch.
  const corridorMaterial = new MeshStandardMaterial({
    color: 0x121a1a,
    roughness: 0.92,
    metalness: 0,
    side: DoubleSide,
  });
  const farWall = H.zMax;
  const corridorLength = 6.0;
  add(wallPlane(7.2, 7.2, 0, 3.6, farWall + corridorLength, Math.PI), corridorMaterial, 'corridor.end', {
    castShadow: false,
    receiveShadow: false,
  });
  add(wallPlane(corridorLength, 7.2, -3.6, 3.6, farWall + corridorLength / 2, Math.PI / 2), corridorMaterial, 'corridor.left', {
    castShadow: false,
    receiveShadow: false,
  });
  add(wallPlane(corridorLength, 7.2, 3.6, 3.6, farWall + corridorLength / 2, -Math.PI / 2), corridorMaterial, 'corridor.right', {
    castShadow: false,
    receiveShadow: false,
  });
  const corridorGlow = new PlaneGeometry(4.4, 4.4);
  corridorGlow.rotateY(Math.PI);
  corridorGlow.translate(0, 3.1, farWall + corridorLength - 0.02);
  add(corridorGlow, materials.warmGlow, 'corridor.glow', { castShadow: false, receiveShadow: false });
  const corridorFloor = new PlaneGeometry(7.2, corridorLength);
  corridorFloor.rotateX(-Math.PI / 2);
  corridorFloor.translate(0, H.deck, farWall + corridorLength / 2);
  applyWorldUVs(corridorFloor);
  add(corridorFloor, materials.tileFloor, 'corridor.floor', { castShadow: false });

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

  // Warm spill plane just behind the arch so the opening never reads as a hole in space.
  const spill = new PlaneGeometry(LAYOUT.farArch.width - 0.1, 4.2);
  spill.rotateY(Math.PI);
  spill.translate(0, 2.1, H.zMax + 0.55);
  const spillMaterial = new MeshBasicMaterial({
    color: new Color(0xffbd83),
    transparent: true,
    opacity: 0.16,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  add(spill, spillMaterial, 'far.spill', { castShadow: false, receiveShadow: false });

  group.traverse((object) => {
    if ((object as Mesh).isMesh) {
      object.frustumCulled = true;
    }
  });

  return { group, occluders };
}
