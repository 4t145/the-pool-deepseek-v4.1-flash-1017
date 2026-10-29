import {
  CatmullRomCurve3,
  CircleGeometry,
  CylinderGeometry,
  Group,
  MathUtils,
  Mesh,
  MeshPhysicalMaterial,
  Quaternion,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  type Scene,
} from 'three';
import { LAYOUT } from './layout';
import type { MaterialLibrary } from './materials';
import { addStaticMesh, applyWorldUVs } from './geometry';

export interface PropsSystem {
  group: Group;
  update(time: number): void;
}

function makeSlide(materials: MaterialLibrary): Group {
  const group = new Group();
  group.name = 'slide';

  // A corkscrew flume falling out of the flooded hall. The points are authored
  // by hand so the silhouette reads from the arrival camera.
  const points = [
    new Vector3(5.35, 7.25, -12.55),
    new Vector3(4.05, 6.95, -12.05),
    new Vector3(2.95, 6.2, -13.25),
    new Vector3(2.85, 5.05, -15.1),
    new Vector3(4.15, 3.75, -16.35),
    new Vector3(5.95, 2.75, -15.15),
    new Vector3(6.15, 1.55, -13.55),
    new Vector3(5.15, 0.7, -15.05),
    new Vector3(3.35, 0.34, -16.35),
  ];
  const curve = new CatmullRomCurve3(points, false, 'catmullrom', 0.42);
  const tube = new TubeGeometry(curve, 260, 0.98, 28, false);
  const slideMesh = new Mesh(tube, materials.redPlastic);
  slideMesh.name = 'slide.flume';
  slideMesh.castShadow = true;
  slideMesh.receiveShadow = true;
  group.add(slideMesh);

  // Open mouth: a dark recess plus a rolled rim, so the tube reads as hollow.
  const end = points[points.length - 1]!;
  const tangent = curve.getTangent(1).normalize();
  const quat = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), tangent);
  const rim = new Mesh(new TorusGeometry(0.97, 0.1, 12, 56), materials.redPlastic);
  rim.position.copy(end).addScaledVector(tangent, 0.02);
  rim.quaternion.copy(quat);
  rim.castShadow = true;
  group.add(rim);
  const recess = new Mesh(new CircleGeometry(0.9, 40), new MeshPhysicalMaterial({
    color: 0x150504,
    roughness: 0.55,
    metalness: 0,
  }));
  recess.position.copy(end).addScaledVector(tangent, 0.06);
  recess.quaternion.copy(quat);
  group.add(recess);

  // Entry funnel at the top.
  const funnel = new Mesh(new CylinderGeometry(1.22, 0.98, 1.15, 32, 1, true), materials.redPlastic);
  funnel.position.set(5.35, 7.52, -12.55);
  funnel.castShadow = true;
  group.add(funnel);

  // Tiled support tower and its little red landing.
  const towerGeometry = new CylinderGeometry(0.58, 0.72, 7.1, 24);
  towerGeometry.translate(5.65, 3.55, -13.15);
  applyWorldUVs(towerGeometry);
  const tower = new Mesh(towerGeometry, materials.tileWall);
  tower.castShadow = true;
  tower.receiveShadow = true;
  group.add(tower);
  const landing = new Mesh(new CylinderGeometry(1.45, 1.45, 0.18, 24), materials.redPlastic);
  landing.position.set(5.5, 7.12, -12.8);
  landing.castShadow = true;
  group.add(landing);

  // Chrome supports bite into the water and carry the helix.
  for (const [index, t] of [0.22, 0.46, 0.7].entries()) {
    const p = curve.getPoint(t);
    const foot = new Vector3(5.05 - index * 0.35, LAYOUT.water.surface, p.z - 0.2);
    const height = Math.max(0.25, p.y - 0.8);
    const support = new Mesh(new CylinderGeometry(0.055, 0.07, height, 10), materials.chrome);
    support.position.set(foot.x, height / 2, foot.z);
    support.castShadow = true;
    group.add(support);
    const strut = new Mesh(new CylinderGeometry(0.04, 0.04, 1.2, 8), materials.chrome);
    strut.position.set((foot.x + p.x) / 2, p.y - 0.55, (foot.z + p.z) / 2);
    strut.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(p.x - foot.x, 0.5, p.z - foot.z).normalize());
    strut.castShadow = true;
    group.add(strut);
  }

  return group;
}

function makeLadder(materials: MaterialLibrary, x: number, z: number, side: number): Group {
  const ladder = new Group();
  const railX = x;
  for (const dz of [-0.3, 0.3]) {
    const rail = new Mesh(new CylinderGeometry(0.032, 0.032, 2.05, 10), materials.chrome);
    rail.position.set(railX, 0.22, z + dz);
    rail.castShadow = true;
    ladder.add(rail);
    const handle = new Mesh(new CylinderGeometry(0.03, 0.03, 0.42, 10), materials.chrome);
    handle.rotation.z = Math.PI / 2;
    handle.position.set(railX + side * 0.21, 1.24, z + dz);
    handle.castShadow = true;
    ladder.add(handle);
  }
  for (const y of [-0.62, -0.3, 0.02, 0.34]) {
    const rung = new Mesh(new CylinderGeometry(0.026, 0.026, 0.6, 10), materials.chrome);
    rung.rotation.x = Math.PI / 2;
    rung.position.set(railX, y, z);
    rung.castShadow = true;
    ladder.add(rung);
  }
  return ladder;
}

function makeRailing(materials: MaterialLibrary, side: number): Group {
  const railing = new Group();
  const x = side * LAYOUT.railings.x;
  const top = LAYOUT.railings.topY;
  const length = 52;
  const topRail = new Mesh(new CylinderGeometry(0.03, 0.03, length, 10), materials.chrome);
  topRail.rotation.x = Math.PI / 2;
  topRail.position.set(x, top, 0);
  topRail.castShadow = true;
  railing.add(topRail);
  const midRail = new Mesh(new CylinderGeometry(0.018, 0.018, length, 8), materials.chrome);
  midRail.rotation.x = Math.PI / 2;
  midRail.position.set(x, top - 0.38, 0);
  midRail.castShadow = true;
  railing.add(midRail);
  for (let z = -26; z <= 26; z += 2.6) {
    const post = new Mesh(new CylinderGeometry(0.022, 0.026, top - 0.35, 8), materials.chrome);
    post.position.set(x, 0.35 + (top - 0.35) / 2, z);
    post.castShadow = true;
    railing.add(post);
  }
  return railing;
}

function makeRing(
  materials: MaterialLibrary,
  color: number,
  radius: number,
  tube: number,
  position: Vector3,
  phase: number,
): { group: Group; baseY: number; phase: number } {
  const group = new Group();
  const material = materials.vinyl[color === 0xc83426 ? 'red' : color === 0xe8b21b ? 'yellow' : 'blue']!;
  const torus = new Mesh(new TorusGeometry(radius, tube, 18, 72), material);
  torus.rotation.x = Math.PI / 2;
  torus.scale.z = 0.56;
  torus.castShadow = true;
  torus.receiveShadow = true;
  group.add(torus);
  const valve = new Mesh(new CylinderGeometry(0.035, 0.04, 0.05, 10), materials.whitePlastic);
  valve.position.set(radius * 0.7, 0.045, 0);
  group.add(valve);
  group.position.copy(position);
  group.position.y = 0.12;
  return { group, baseY: 0.12, phase };
}

export function buildProps(scene: Scene, materials: MaterialLibrary): PropsSystem {
  const group = new Group();
  group.name = 'props';

  group.add(makeSlide(materials));

  for (const side of [-1, 1] as const) {
    group.add(makeRailing(materials, side));
    for (const z of LAYOUT.ladders.z) {
      group.add(makeLadder(materials, side * (LAYOUT.ladders.x + 0.03), z, side));
    }
  }

  const rings = LAYOUT.rings.map((config) =>
    makeRing(materials, config.color, config.radius, config.tube, config.position, config.phase),
  );
  for (const ring of rings) group.add(ring.group);

  scene.add(group);

  return {
    group,
    update(time: number) {
      for (const ring of rings) {
        const bob = Math.sin(time * 0.62 + ring.phase) * 0.018;
        ring.group.position.y = ring.baseY + bob;
        ring.group.rotation.y = Math.sin(time * 0.09 + ring.phase) * 0.12;
        ring.group.rotation.z = Math.sin(time * 0.5 + ring.phase) * 0.012;
      }
    },
  };
}
