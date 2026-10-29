import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  PlaneGeometry,
  Vector3,
  type Material,
  type Mesh,
  Mesh as ThreeMesh,
  type Object3D,
} from 'three';

/**
 * Planar world-space UVs. Tile scale is expressed in metres, so every surface in
 * the building shares one continuous grid: 1 UV unit = 1 metre = 8 tiles.
 * Call after the geometry has been baked into world space.
 */
export function applyWorldUVs(geometry: BufferGeometry, metresPerTexture = 1): void {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  if (!position || !normal) throw new Error('applyWorldUVs requires position and normal attributes');
  const uvs = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const nx = Math.abs(normal.getX(i));
    const ny = Math.abs(normal.getY(i));
    const nz = Math.abs(normal.getZ(i));
    const x = position.getX(i) / metresPerTexture;
    const y = position.getY(i) / metresPerTexture;
    const z = position.getZ(i) / metresPerTexture;
    if (nx >= ny && nx >= nz) {
      uvs[i * 2] = z;
      uvs[i * 2 + 1] = y;
    } else if (ny >= nx && ny >= nz) {
      uvs[i * 2] = x;
      uvs[i * 2 + 1] = z;
    } else {
      uvs[i * 2] = x;
      uvs[i * 2 + 1] = y;
    }
  }
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
}

export function addStaticMesh(
  parent: Object3D,
  geometry: BufferGeometry,
  material: Material,
  name: string,
  options: { castShadow?: boolean; receiveShadow?: boolean; renderOrder?: number } = {},
): Mesh {
  const mesh = new ThreeMesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  if (options.renderOrder !== undefined) mesh.renderOrder = options.renderOrder;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  parent.add(mesh);
  return mesh;
}

/** Axis-aligned box already positioned in world space, with planar UVs. */
export function worldBox(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
): BufferGeometry {
  const box = new BoxGeometry(width, height, depth);
  box.translate(x, y, z);
  applyWorldUVs(box);
  return box;
}

/** A plane in world space, rotated around Y, with UVs in metres. */
export function wallPlane(
  width: number,
  height: number,
  x: number,
  y: number,
  z: number,
  rotationY: number,
): BufferGeometry {
  const geometry = new PlaneGeometry(width, height);
  geometry.rotateY(rotationY);
  geometry.translate(x, y, z);
  applyWorldUVs(geometry);
  return geometry;
}

/** Reflect a world-space position across the water plane. */
export function mirrorCameraPosition(position: Vector3, planeY = 0): Vector3 {
  return new Vector3(position.x, planeY * 2 - position.y, position.z);
}
