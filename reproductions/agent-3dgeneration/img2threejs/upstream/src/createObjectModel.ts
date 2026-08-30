import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

type SdfVector = readonly [number, number, number];
type SdfTransform = { position?: SdfVector; translation?: SdfVector; rotation?: SdfVector; scale?: SdfVector };
type SdfPrimitive = {
  readonly id: string;
  readonly type: 'sphere' | 'capsule' | 'box' | 'cone' | 'ellipsoid';
  readonly center?: SdfVector;
  readonly radius?: number | SdfVector;
  readonly height?: number;
  readonly size?: SdfVector;
  readonly dimensions?: SdfVector;
  readonly radii?: SdfVector;
  readonly transform?: SdfTransform;
};
type SdfOperation = {
  readonly id?: string;
  readonly output?: string;
  readonly type: 'smooth-union' | 'subtract' | 'intersect';
  readonly left: string;
  readonly right: string;
  readonly radius?: number;
};
type SdfDescriptor = {
  readonly primitives: readonly SdfPrimitive[];
  readonly operations?: readonly SdfOperation[];
  readonly resolution: number;
  readonly bounds?: { readonly min: SdfVector; readonly max: SdfVector };
};
type SdfFunction = (point: THREE.Vector3) => number;

function sdfSphere(point: THREE.Vector3, radius: number): number {
  return point.length() - radius;
}

function sdfCapsule(point: THREE.Vector3, radius: number, height: number): number {
  const halfHeight = height * 0.5;
  const y = Math.max(-halfHeight, Math.min(halfHeight, point.y));
  return point.distanceTo(new THREE.Vector3(0, y, 0)) - radius;
}

function sdfBox(point: THREE.Vector3, size: SdfVector): number {
  const q = new THREE.Vector3(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z))
    .sub(new THREE.Vector3(size[0] * 0.5, size[1] * 0.5, size[2] * 0.5));
  return q.clone().max(new THREE.Vector3()).length() + Math.min(Math.max(q.x, q.y, q.z), 0);
}

function sdfCone(point: THREE.Vector3, radius: number, height: number): number {
  const halfHeight = height * 0.5;
  const taper = radius * (1 - (point.y + halfHeight) / height);
  return Math.max(Math.hypot(point.x, point.z) - Math.max(0, taper), Math.abs(point.y) - halfHeight);
}

function sdfEllipsoid(point: THREE.Vector3, radii: SdfVector): number {
  const scaled = new THREE.Vector3(point.x / radii[0], point.y / radii[1], point.z / radii[2]);
  return (scaled.length() - 1) * Math.min(radii[0], radii[1], radii[2]);
}

function sdfRadii(primitive: SdfPrimitive): SdfVector {
  const radius = primitive.radius;
  if (primitive.radii) return primitive.radii;
  if (typeof radius === 'number') return [radius, radius, radius];
  return radius ?? [0.5, 0.5, 0.5];
}

function smin(left: number, right: number, radius: number): number {
  const blend = Math.max(radius - Math.abs(left - right), 0) / radius;
  return Math.min(left, right) - blend * blend * radius * 0.25;
}

function sdfLocalPoint(point: THREE.Vector3, primitive: SdfPrimitive): { point: THREE.Vector3; scale: number } {
  const transform = primitive.transform;
  const translation = transform?.position ?? transform?.translation ?? primitive.center ?? [0, 0, 0];
  const rotation = transform?.rotation ?? [0, 0, 0];
  const scale = transform?.scale ?? [1, 1, 1];
  const local = point.clone().sub(new THREE.Vector3(translation[0], translation[1], translation[2]));
  const inverseRotation = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2]))
    .invert();
  local.applyQuaternion(inverseRotation);
  local.set(local.x / scale[0], local.y / scale[1], local.z / scale[2]);
  return { point: local, scale: Math.min(scale[0], scale[1], scale[2]) };
}

function sdfPrimitive(point: THREE.Vector3, primitive: SdfPrimitive): number {
  const local = sdfLocalPoint(point, primitive);
  let distance: number;
  switch (primitive.type) {
    case 'sphere':
      distance = sdfSphere(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.5);
      break;
    case 'capsule':
      distance = sdfCapsule(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.25, primitive.height ?? 1);
      break;
    case 'box':
      distance = sdfBox(local.point, primitive.size ?? primitive.dimensions ?? [1, 1, 1]);
      break;
    case 'cone':
      distance = sdfCone(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.5, primitive.height ?? 1);
      break;
    case 'ellipsoid':
      distance = sdfEllipsoid(local.point, sdfRadii(primitive));
      break;
  }
  return distance * local.scale;
}

function sdfSample(descriptor: SdfDescriptor): SdfFunction {
  const nodes = new Map<string, SdfFunction>();
  for (const primitive of descriptor.primitives) nodes.set(primitive.id, (point) => sdfPrimitive(point, primitive));
  let result = descriptor.primitives.length > 0 ? nodes.get(descriptor.primitives[0].id) : undefined;
  for (let index = 0; index < (descriptor.operations?.length ?? 0); index += 1) {
    const operation = descriptor.operations?.[index];
    if (!operation) continue;
    const left = nodes.get(operation.left);
    const right = nodes.get(operation.right);
    if (!left || !right) continue;
    let combined: SdfFunction;
    switch (operation.type) {
      case 'smooth-union':
        combined = (point) => smin(left(point), right(point), operation.radius ?? 0.1);
        break;
      case 'subtract':
        combined = (point) => Math.max(left(point), -right(point));
        break;
      case 'intersect':
        combined = (point) => Math.max(left(point), right(point));
        break;
    }
    nodes.set(operation.id ?? operation.output ?? `operation-${index}`, combined);
    result = combined;
  }
  return result ?? (() => Infinity);
}

function polygonizeSdf(descriptor: SdfDescriptor): THREE.BufferGeometry {
  // SURFACE NETS, not a voxel shell.
  //
  // This used to emit one axis-aligned quad per exposed voxel face, which is a Minecraft surface:
  // every face is axis-aligned, every edge is a 90-degree step, and the result is stair-stepped at
  // exactly the scale of the sampling grid. For a subject whose whole identity is smooth blended
  // organic form -- which is the only kind of subject anyone reaches for an implicit surface to
  // build -- that is worse than the assembled primitives it was meant to replace.
  //
  // Naive surface nets places ONE vertex per sign-changing cell, at the average of the linearly
  // interpolated crossings on that cell's edges, and joins the four cells around each crossing
  // edge into a quad. It is compact, manifold, and smooth, and it is a natural fit for a field
  // that can be sampled anywhere rather than only at corners.
  //
  // Normals come from the field GRADIENT, not from face averaging: the gradient is the exact
  // surface normal of the implicit surface, so shading no longer carries the grid's imprint.
  const resolution = Math.max(4, Math.min(64, Math.floor(descriptor.resolution)));
  const defaultBounds: { readonly min: SdfVector; readonly max: SdfVector } = { min: [-2, -2, -2], max: [2, 2, 2] };
  const bounds = descriptor.bounds ?? defaultBounds;
  const min = new THREE.Vector3(bounds.min[0], bounds.min[1], bounds.min[2]);
  const step = new THREE.Vector3(
    (bounds.max[0] - bounds.min[0]) / resolution,
    (bounds.max[1] - bounds.min[1]) / resolution,
    (bounds.max[2] - bounds.min[2]) / resolution,
  );
  const sample = sdfSample(descriptor);
  const scratch = new THREE.Vector3();

  // Corner grid: one more corner than cells on each axis.
  const side = resolution + 1;
  const field = new Float32Array(side * side * side);
  const cornerAt = (x: number, y: number, z: number): number => (z * side + y) * side + x;
  for (let z = 0; z < side; z += 1) {
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        scratch.set(min.x + x * step.x, min.y + y * step.y, min.z + z * step.z);
        field[cornerAt(x, y, z)] = sample(scratch);
      }
    }
  }

  // The 12 cell edges as corner-offset pairs.
  const CUBE_EDGES: readonly (readonly [number, number, number, number, number, number])[] = [
    [0, 0, 0, 1, 0, 0], [1, 0, 0, 1, 1, 0], [0, 1, 0, 1, 1, 0], [0, 0, 0, 0, 1, 0],
    [0, 0, 1, 1, 0, 1], [1, 0, 1, 1, 1, 1], [0, 1, 1, 1, 1, 1], [0, 0, 1, 0, 1, 1],
    [0, 0, 0, 0, 0, 1], [1, 0, 0, 1, 0, 1], [1, 1, 0, 1, 1, 1], [0, 1, 0, 0, 1, 1],
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const cellVertex = new Int32Array(resolution * resolution * resolution).fill(-1);
  const cellAt = (x: number, y: number, z: number): number => (z * resolution + y) * resolution + x;

  // Central-difference gradient, stepped at a fraction of a cell so it follows the field rather
  // than the grid.
  const epsilon = Math.min(step.x, step.y, step.z) * 0.25;
  const gradient = (point: THREE.Vector3): THREE.Vector3 => {
    const gx = sample(scratch.set(point.x + epsilon, point.y, point.z))
      - sample(scratch.set(point.x - epsilon, point.y, point.z));
    const gy = sample(scratch.set(point.x, point.y + epsilon, point.z))
      - sample(scratch.set(point.x, point.y - epsilon, point.z));
    const gz = sample(scratch.set(point.x, point.y, point.z + epsilon))
      - sample(scratch.set(point.x, point.y, point.z - epsilon));
    const normal = new THREE.Vector3(gx, gy, gz);
    // A point where the field is flat has no defined normal; +Y is arbitrary but finite, and
    // leaving a zero vector would poison every lighting calculation downstream.
    return normal.lengthSq() < 1e-20 ? new THREE.Vector3(0, 1, 0) : normal.normalize();
  };

  for (let z = 0; z < resolution; z += 1) {
    for (let y = 0; y < resolution; y += 1) {
      for (let x = 0; x < resolution; x += 1) {
        let crossings = 0;
        let sumX = 0;
        let sumY = 0;
        let sumZ = 0;
        for (const [ax, ay, az, bx, by, bz] of CUBE_EDGES) {
          const a = field[cornerAt(x + ax, y + ay, z + az)];
          const b = field[cornerAt(x + bx, y + by, z + bz)];
          if ((a <= 0) === (b <= 0)) continue;
          const t = a / (a - b);
          sumX += (ax + (bx - ax) * t);
          sumY += (ay + (by - ay) * t);
          sumZ += (az + (bz - az) * t);
          crossings += 1;
        }
        if (crossings === 0) continue;
        const px = min.x + (x + sumX / crossings) * step.x;
        const py = min.y + (y + sumY / crossings) * step.y;
        const pz = min.z + (z + sumZ / crossings) * step.z;
        cellVertex[cellAt(x, y, z)] = positions.length / 3;
        positions.push(px, py, pz);
        const normal = gradient(new THREE.Vector3(px, py, pz));
        normals.push(normal.x, normal.y, normal.z);
      }
    }
  }

  // One quad per sign-changing grid edge, joining the four cells that share it.
  //
  // Winding, worked out rather than guessed. For the +x edge from corner (x,y,z), the four cells
  // around it are (x, y-1, z-1), (x, y, z-1), (x, y, z), (x, y-1, z); in the (y,z) plane that
  // traversal is +y, +z, -y, whose cross product is +x. So when the corner is INSIDE and its
  // neighbour is outside, the unflipped order already faces out, and the flip belongs on the
  // opposite case. Getting this backwards is invisible in the normals -- those come from the
  // gradient and stay correct -- and shows only as back-face culling removing the front surface,
  // i.e. the model rendering as a hollow shell with its interior visible.
  const quad = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, c, b, a, d, c);
    else indices.push(a, b, c, a, c, d);
  };
  // Each quad joins the FOUR cells sharing one grid edge, so every one of those cells must exist.
  // Bounding only the edge axis and the lower end of the other two let y/z reach `resolution`, which
  // is a corner index, not a cell index: `cellAt` then strides into an unrelated slot (with
  // resolution 8, `cellAt(3, 8, 1)` is 131 -- the slot for cell (3, 0, 2)) or past the end of the
  // array, where a typed-array read yields `undefined`. `undefined < 0` is false, so the guard in
  // `quad` passed it through to `setIndex`, which coerces it to 0. Measured on a sphere reaching its
  // own bounds at resolution 8: 60 out-of-range reads and 108 aliased reads. A surface that touches
  // the sampling box is therefore left OPEN at that face rather than closed with wrong triangles --
  // pad `bounds` past the surface to get a closed mesh.
  for (let z = 0; z < side; z += 1) {
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const here = field[cornerAt(x, y, z)] <= 0;
        if (x + 1 < side && y > 0 && z > 0 && y < side - 1 && z < side - 1
          && here !== (field[cornerAt(x + 1, y, z)] <= 0)) {
          quad(
            cellVertex[cellAt(x, y - 1, z - 1)], cellVertex[cellAt(x, y, z - 1)],
            cellVertex[cellAt(x, y, z)], cellVertex[cellAt(x, y - 1, z)], !here,
          );
        }
        if (y + 1 < side && x > 0 && z > 0 && x < side - 1 && z < side - 1
          && here !== (field[cornerAt(x, y + 1, z)] <= 0)) {
          quad(
            cellVertex[cellAt(x - 1, y, z - 1)], cellVertex[cellAt(x - 1, y, z)],
            cellVertex[cellAt(x, y, z)], cellVertex[cellAt(x, y, z - 1)], !here,
          );
        }
        if (z + 1 < side && x > 0 && y > 0 && x < side - 1 && y < side - 1
          && here !== (field[cornerAt(x, y, z + 1)] <= 0)) {
          quad(
            cellVertex[cellAt(x - 1, y - 1, z)], cellVertex[cellAt(x, y - 1, z)],
            cellVertex[cellAt(x, y, z)], cellVertex[cellAt(x - 1, y, z)], !here,
          );
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function buildTubeGeometry(
  path: { points: [number, number, number][]; radius?: number; radialSegments?: number; closed?: boolean },
): THREE.TubeGeometry {
  const vectors = path.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, path.closed ?? false);
  const tubularSegments = Math.max(8, path.points.length * 6);
  return new THREE.TubeGeometry(curve, tubularSegments, path.radius ?? 0.05, path.radialSegments ?? 8, path.closed ?? false);
}

type TaperedStation = { position: [number, number, number]; rx: number; rz: number; twist?: number };

// Frames come from PARALLEL TRANSPORT, not from a Frenet frame. A Frenet frame is defined by
// the curve's normal, which flips sign wherever the path has an inflection or straightens out,
// and every flip twists the surface 180 degrees within one segment. Carrying the previous frame
// forward and removing only its along-path component keeps the twist continuous. THREE's own
// extrudePath and TubeGeometry do not expose this, which is why this is hand-built.
function buildTaperedSweepGeometry(
  sweep: { stations: TaperedStation[]; radialSegments?: number; capEnds?: boolean },
): THREE.BufferGeometry {
  const stations = sweep.stations;
  if (stations.length < 2) throw new Error('tapered-sweep needs at least two stations');
  const radial = Math.max(3, sweep.radialSegments ?? 10);
  const centres = stations.map((s) => new THREE.Vector3(...s.position));

  const tangents = centres.map((_, i) => {
    const prev = centres[Math.max(0, i - 1)];
    const next = centres[Math.min(centres.length - 1, i + 1)];
    const t = next.clone().sub(prev);
    // Coincident neighbours would normalise to NaN and poison every downstream vertex.
    return t.lengthSq() < 1e-12 ? new THREE.Vector3(0, 1, 0) : t.normalize();
  });

  // Seed a reference axis that is not parallel to the first tangent, or the first cross
  // product is degenerate and the whole sweep collapses to a line.
  let ref = new THREE.Vector3(0, 0, 1);
  if (Math.abs(tangents[0].dot(ref)) > 0.9) ref = new THREE.Vector3(1, 0, 0);

  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  let carried = ref.clone().sub(tangents[0].clone().multiplyScalar(ref.dot(tangents[0]))).normalize();
  for (let i = 0; i < tangents.length; i += 1) {
    const t = tangents[i];
    // Project the carried frame back onto the plane perpendicular to this tangent.
    const n = carried.clone().sub(t.clone().multiplyScalar(carried.dot(t)));
    if (n.lengthSq() < 1e-12) {
      const fallback = Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      n.copy(fallback.sub(t.clone().multiplyScalar(fallback.dot(t))));
    }
    n.normalize();
    normals.push(n);
    binormals.push(new THREE.Vector3().crossVectors(t, n).normalize());
    carried = n;
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ringStart: number[] = [];
  const isPoint: boolean[] = [];

  for (let i = 0; i < stations.length; i += 1) {
    const st = stations[i];
    const v = i / (stations.length - 1);
    ringStart.push(positions.length / 3);
    // A station whose section has collapsed emits ONE vertex, not a ring of radius zero.
    // A degenerate ring still carries `radial` coincident vertices and `radial` zero-area
    // triangles, so the lock ends in a blunt cap the width of the floating-point noise
    // rather than at a point -- and a hair lock, a horn or a blade tip has to reach a point.
    if (st.rx <= 1e-6 && st.rz <= 1e-6) {
      isPoint.push(true);
      positions.push(centres[i].x, centres[i].y, centres[i].z);
      uvs.push(0.5, v);
      continue;
    }
    isPoint.push(false);
    const twist = ((st.twist ?? 0) * Math.PI) / 180;
    for (let j = 0; j <= radial; j += 1) {
      const theta = (j / radial) * Math.PI * 2 + twist;
      const offset = normals[i].clone().multiplyScalar(Math.cos(theta) * st.rx)
        .add(binormals[i].clone().multiplyScalar(Math.sin(theta) * st.rz));
      const p = centres[i].clone().add(offset);
      positions.push(p.x, p.y, p.z);
      uvs.push(j / radial, v);
    }
  }

  for (let i = 0; i < stations.length - 1; i += 1) {
    const a0 = ringStart[i];
    const b0 = ringStart[i + 1];
    if (isPoint[i] && isPoint[i + 1]) continue;   // two collapsed stations bound nothing
    for (let j = 0; j < radial; j += 1) {
      // Wound so the face normal points radially OUTWARD.
      //
      // Ring vertices advance from `normal` toward `binormal`, and binormal is
      // tangent x normal, so increasing theta runs counter-clockwise seen from the
      // far end of the segment. Taking the ring-to-ring edge first therefore puts
      // the cross product on the inside. Measured as signed volume on the built
      // mesh: every tapered-sweep came out negative -- a torso at -0.0674 and a
      // tail at -0.0044 against a positive ellipsoid head -- so every sweep this
      // generator has ever emitted rendered its back faces, with normals pointing
      // into the solid and every lighting judgement made on the wrong surface.
      if (isPoint[i]) indices.push(a0, b0 + j + 1, b0 + j);
      else if (isPoint[i + 1]) indices.push(a0 + j, a0 + j + 1, b0);
      else indices.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
    }
  }

  if (sweep.capEnds ?? true) {
    for (const end of [0, stations.length - 1]) {
      if (isPoint[end]) continue;   // a point end is already closed
      const centreIndex = positions.length / 3;
      positions.push(centres[end].x, centres[end].y, centres[end].z);
      uvs.push(0.5, end === 0 ? 0 : 1);
      const base = ringStart[end];
      for (let j = 0; j < radial; j += 1) {
        if (end === 0) indices.push(centreIndex, base + j + 1, base + j);
        else indices.push(centreIndex, base + j, base + j + 1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Stylized Anatomical Heart
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createStylizedAnatomicalHeartModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Stylized Anatomical Heart";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 32.0, "aspect": 0.765, "orientation": {"yaw": 0.0, "pitch": -0.03, "roll": 0.0}, "positionHint": [0.0, 0.15, 6.0], "note": "Approximate anterior matched-view camera for an uncalibrated vision-context set; not a clinical or solved pose."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["myocardium"] = createSculptMaterial(
    "myocardium",
    {"id": "myocardium", "name": "Myocardium", "type": "physical", "qualityTier": "hero", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#B73742", "color": "#B73742", "albedo": {"dominant": "#B73742", "secondary": ["#8D2636", "#D36A6C"], "samplingNotes": "Sample only the named tissue footprint; exclude hotspot rings, background, pedestal and UI."}, "colorVariation": {"palette": ["#B73742", "#8D2636", "#D36A6C"], "pattern": "low-frequency tissue mottling", "amplitude": 0.08, "heightCorrelation": 0.15}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-like generated object coordinates", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Object-scale stable relief; no source-photo projection."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.4, "amplitude": 0.09, "role": "broad tissue value and volume variation"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.035, "role": "shallow lobes, creases and vessel-wall variation"}, {"id": "micro", "frequency": 38.0, "amplitude": 0.012, "role": "restrained highlight breakup"}], "roughness": {"base": 0.46, "variation": 0.08, "map": "independent-procedural-myocardium-roughness", "localResponse": "slightly lower on exposed crests and higher in grooves"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "independent-procedural-myocardium-height-normal", "strength": 0.18, "scale": 18.0, "space": "tangent"}, "bump": {"pattern": "bounded organic relief", "amplitude": 0.025, "scale": 12.0}, "displacement": {"pattern": "macro-only", "amplitude": 0.015, "scale": 2.0, "silhouetteAffects": false}, "ambientOcclusion": {"map": "independent-procedural-myocardium-ao", "cavityStrength": 0.22, "contactShadowBias": 0.35, "notes": "Only contact/groove cavities; do not paint global dark gradients."}, "clearcoat": 0.16, "clearcoatRoughness": 0.52, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2A0B16"}, "localOverrides": [{"id": "fiber-relief", "region": "ventricular surfaces", "roughness": 0.52, "normalStrength": 0.16, "evidenceRefs": ["anterior", "posterior", "right-oblique"]}, {"id": "region-roughness", "region": "inferior and groove zones", "roughness": 0.58, "color": "#8F263A", "evidenceRefs": ["anterior", "posterior"]}], "shaderNotes": ["Use broad semi-gloss highlights; avoid a single global toy-plastic response.", "Keep albedo, roughness, normal/height and AO independent."], "notes": "Stylized tissue PBR estimate grounded in multi-view reference crops; not inverse-rendered clinical material data.", "referencePbr": {"version": "1", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-crops\\posterior\\myocardium.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "reference-pixel-extraction", "verdict": "pass", "usable": true, "confidence": 0.782, "estimatedFidelity": 0.782, "targetThreshold": 0.7, "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\myocardium\\myocardium_albedo.png", "url": "/references/heart-multiview/material-evidence/myocardium/myocardium_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\myocardium\\myocardium_roughness.png", "url": "/references/heart-multiview/material-evidence/myocardium/myocardium_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\myocardium\\myocardium_height.png", "url": "/references/heart-multiview/material-evidence/myocardium/myocardium_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\myocardium\\myocardium_normal.png", "url": "/references/heart-multiview/material-evidence/myocardium/myocardium_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\myocardium\\myocardium_ao.png", "url": "/references/heart-multiview/material-evidence/myocardium/myocardium_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "hardLimit": "single-image PBR extraction is an estimate; 70%+ extraction confidence still needs render screenshot review"}, "finishClass": "biological-tissue-satin", "automatedFinishClassification": "unclassified", "finishClassificationCorrection": {"authority": "agent-vision", "reason": "The verified crop is biological teaching-model tissue, not metal, gemstone, coating or translucent mineral.", "excludedReferenceElements": ["hotspot rings", "background", "pedestal", "UI", "text"]}},
    options
  );
  materialMap["arterial"] = createSculptMaterial(
    "arterial",
    {"id": "arterial", "name": "Arterial great vessels", "type": "physical", "qualityTier": "hero", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#D34645", "color": "#D34645", "albedo": {"dominant": "#D34645", "secondary": ["#A72F3A", "#E07770"], "samplingNotes": "Sample only the named tissue footprint; exclude hotspot rings, background, pedestal and UI."}, "colorVariation": {"palette": ["#D34645", "#A72F3A", "#E07770"], "pattern": "low-frequency tissue mottling", "amplitude": 0.08, "heightCorrelation": 0.15}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-like generated object coordinates", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Object-scale stable relief; no source-photo projection."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.4, "amplitude": 0.09, "role": "broad tissue value and volume variation"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.035, "role": "shallow lobes, creases and vessel-wall variation"}, {"id": "micro", "frequency": 38.0, "amplitude": 0.012, "role": "restrained highlight breakup"}], "roughness": {"base": 0.34, "variation": 0.07, "map": "independent-procedural-arterial-roughness", "localResponse": "slightly lower on exposed crests and higher in grooves"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "independent-procedural-arterial-height-normal", "strength": 0.18, "scale": 18.0, "space": "tangent"}, "bump": {"pattern": "bounded organic relief", "amplitude": 0.025, "scale": 12.0}, "displacement": {"pattern": "macro-only", "amplitude": 0.015, "scale": 2.0, "silhouetteAffects": false}, "ambientOcclusion": {"map": "independent-procedural-arterial-ao", "cavityStrength": 0.22, "contactShadowBias": 0.35, "notes": "Only contact/groove cavities; do not paint global dark gradients."}, "clearcoat": 0.22, "clearcoatRoughness": 0.42, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2A0B16"}, "localOverrides": [{"id": "arch-highlight-band", "region": "aortic arch crest", "roughness": 0.3, "evidenceRefs": ["anterior", "posterior", "superior"]}], "shaderNotes": ["Use broad semi-gloss highlights; avoid a single global toy-plastic response.", "Keep albedo, roughness, normal/height and AO independent."], "notes": "Stylized tissue PBR estimate grounded in multi-view reference crops; not inverse-rendered clinical material data.", "referencePbr": {"version": "1", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-crops\\posterior\\arterial.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "reference-pixel-extraction", "verdict": "pass", "usable": true, "confidence": 0.892, "estimatedFidelity": 0.892, "targetThreshold": 0.7, "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\arterial\\arterial_albedo.png", "url": "/references/heart-multiview/material-evidence/arterial/arterial_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\arterial\\arterial_roughness.png", "url": "/references/heart-multiview/material-evidence/arterial/arterial_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\arterial\\arterial_height.png", "url": "/references/heart-multiview/material-evidence/arterial/arterial_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\arterial\\arterial_normal.png", "url": "/references/heart-multiview/material-evidence/arterial/arterial_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\arterial\\arterial_ao.png", "url": "/references/heart-multiview/material-evidence/arterial/arterial_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "hardLimit": "single-image PBR extraction is an estimate; 70%+ extraction confidence still needs render screenshot review"}, "finishClass": "biological-vessel-semi-gloss", "automatedFinishClassification": "unclassified", "finishClassificationCorrection": {"authority": "agent-vision", "reason": "The verified crop is biological teaching-model tissue, not metal, gemstone, coating or translucent mineral.", "excludedReferenceElements": ["hotspot rings", "background", "pedestal", "UI", "text"]}},
    options
  );
  materialMap["venous"] = createSculptMaterial(
    "venous",
    {"id": "venous", "name": "Venous and pulmonary vessels", "type": "physical", "qualityTier": "hero", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#742B4B", "color": "#742B4B", "albedo": {"dominant": "#742B4B", "secondary": ["#4E1A39", "#9A5270"], "samplingNotes": "Sample only the named tissue footprint; exclude hotspot rings, background, pedestal and UI."}, "colorVariation": {"palette": ["#742B4B", "#4E1A39", "#9A5270"], "pattern": "low-frequency tissue mottling", "amplitude": 0.08, "heightCorrelation": 0.15}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-like generated object coordinates", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Object-scale stable relief; no source-photo projection."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.4, "amplitude": 0.09, "role": "broad tissue value and volume variation"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.035, "role": "shallow lobes, creases and vessel-wall variation"}, {"id": "micro", "frequency": 38.0, "amplitude": 0.012, "role": "restrained highlight breakup"}], "roughness": {"base": 0.39, "variation": 0.08, "map": "independent-procedural-venous-roughness", "localResponse": "slightly lower on exposed crests and higher in grooves"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "independent-procedural-venous-height-normal", "strength": 0.18, "scale": 18.0, "space": "tangent"}, "bump": {"pattern": "bounded organic relief", "amplitude": 0.025, "scale": 12.0}, "displacement": {"pattern": "macro-only", "amplitude": 0.015, "scale": 2.0, "silhouetteAffects": false}, "ambientOcclusion": {"map": "independent-procedural-venous-ao", "cavityStrength": 0.22, "contactShadowBias": 0.35, "notes": "Only contact/groove cavities; do not paint global dark gradients."}, "clearcoat": 0.17, "clearcoatRoughness": 0.48, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2A0B16"}, "localOverrides": [{"id": "venous-value-shift", "region": "caval and pulmonary trunks", "roughness": 0.43, "color": "#6A2848", "evidenceRefs": ["left-oblique", "posterior", "superior"]}], "shaderNotes": ["Use broad semi-gloss highlights; avoid a single global toy-plastic response.", "Keep albedo, roughness, normal/height and AO independent."], "notes": "Stylized tissue PBR estimate grounded in multi-view reference crops; not inverse-rendered clinical material data.", "referencePbr": {"version": "1", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-crops\\right-oblique\\venous.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "reference-pixel-extraction", "verdict": "pass", "usable": true, "confidence": 0.909, "estimatedFidelity": 0.909, "targetThreshold": 0.7, "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\venous\\venous_albedo.png", "url": "/references/heart-multiview/material-evidence/venous/venous_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\venous\\venous_roughness.png", "url": "/references/heart-multiview/material-evidence/venous/venous_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\venous\\venous_height.png", "url": "/references/heart-multiview/material-evidence/venous/venous_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\venous\\venous_normal.png", "url": "/references/heart-multiview/material-evidence/venous/venous_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\venous\\venous_ao.png", "url": "/references/heart-multiview/material-evidence/venous/venous_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "hardLimit": "single-image PBR extraction is an estimate; 70%+ extraction confidence still needs render screenshot review"}, "finishClass": "biological-vessel-satin", "automatedFinishClassification": "unclassified", "finishClassificationCorrection": {"authority": "agent-vision", "reason": "The verified crop is biological teaching-model tissue, not metal, gemstone, coating or translucent mineral.", "excludedReferenceElements": ["hotspot rings", "background", "pedestal", "UI", "text"]}},
    options
  );
  materialMap["coronary-artery"] = createSculptMaterial(
    "coronary-artery",
    {"id": "coronary-artery", "name": "Coronary arteries", "type": "physical", "qualityTier": "hero", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#CC363B", "color": "#CC363B", "albedo": {"dominant": "#CC363B", "secondary": ["#8F2030", "#E56464"], "samplingNotes": "Sample only the named tissue footprint; exclude hotspot rings, background, pedestal and UI."}, "colorVariation": {"palette": ["#CC363B", "#8F2030", "#E56464"], "pattern": "low-frequency tissue mottling", "amplitude": 0.08, "heightCorrelation": 0.15}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-like generated object coordinates", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Object-scale stable relief; no source-photo projection."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.4, "amplitude": 0.09, "role": "broad tissue value and volume variation"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.035, "role": "shallow lobes, creases and vessel-wall variation"}, {"id": "micro", "frequency": 38.0, "amplitude": 0.012, "role": "restrained highlight breakup"}], "roughness": {"base": 0.31, "variation": 0.07, "map": "independent-procedural-coronary-artery-roughness", "localResponse": "slightly lower on exposed crests and higher in grooves"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "independent-procedural-coronary-artery-height-normal", "strength": 0.18, "scale": 18.0, "space": "tangent"}, "bump": {"pattern": "bounded organic relief", "amplitude": 0.025, "scale": 12.0}, "displacement": {"pattern": "macro-only", "amplitude": 0.015, "scale": 2.0, "silhouetteAffects": false}, "ambientOcclusion": {"map": "independent-procedural-coronary-artery-ao", "cavityStrength": 0.22, "contactShadowBias": 0.35, "notes": "Only contact/groove cavities; do not paint global dark gradients."}, "clearcoat": 0.2, "clearcoatRoughness": 0.4, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2A0B16"}, "localOverrides": [{"id": "artery-scale-response", "region": "primary vs secondary branches", "roughness": 0.34, "evidenceRefs": ["anterior", "left-oblique"]}], "shaderNotes": ["Use broad semi-gloss highlights; avoid a single global toy-plastic response.", "Keep albedo, roughness, normal/height and AO independent."], "notes": "Stylized tissue PBR estimate grounded in multi-view reference crops; not inverse-rendered clinical material data.", "referencePbr": {"version": "1", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-crops\\anterior\\coronary-artery.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "reference-pixel-extraction", "verdict": "pass", "usable": true, "confidence": 0.811, "estimatedFidelity": 0.811, "targetThreshold": 0.7, "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\coronary-artery\\coronary-artery_albedo.png", "url": "/references/heart-multiview/material-evidence/coronary-artery/coronary-artery_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\coronary-artery\\coronary-artery_roughness.png", "url": "/references/heart-multiview/material-evidence/coronary-artery/coronary-artery_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\coronary-artery\\coronary-artery_height.png", "url": "/references/heart-multiview/material-evidence/coronary-artery/coronary-artery_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\coronary-artery\\coronary-artery_normal.png", "url": "/references/heart-multiview/material-evidence/coronary-artery/coronary-artery_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\coronary-artery\\coronary-artery_ao.png", "url": "/references/heart-multiview/material-evidence/coronary-artery/coronary-artery_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "hardLimit": "single-image PBR extraction is an estimate; 70%+ extraction confidence still needs render screenshot review"}, "finishClass": "biological-vessel-semi-gloss", "automatedFinishClassification": "unclassified", "finishClassificationCorrection": {"authority": "agent-vision", "reason": "The verified crop is biological teaching-model tissue, not metal, gemstone, coating or translucent mineral.", "excludedReferenceElements": ["hotspot rings", "background", "pedestal", "UI", "text"]}},
    options
  );
  materialMap["coronary-vein"] = createSculptMaterial(
    "coronary-vein",
    {"id": "coronary-vein", "name": "Coronary veins", "type": "physical", "qualityTier": "hero", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#541C44", "color": "#541C44", "albedo": {"dominant": "#541C44", "secondary": ["#2F0F2C", "#783157"], "samplingNotes": "Sample only the named tissue footprint; exclude hotspot rings, background, pedestal and UI."}, "colorVariation": {"palette": ["#541C44", "#2F0F2C", "#783157"], "pattern": "low-frequency tissue mottling", "amplitude": 0.08, "heightCorrelation": 0.15}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-like generated object coordinates", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Object-scale stable relief; no source-photo projection."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.4, "amplitude": 0.09, "role": "broad tissue value and volume variation"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.035, "role": "shallow lobes, creases and vessel-wall variation"}, {"id": "micro", "frequency": 38.0, "amplitude": 0.012, "role": "restrained highlight breakup"}], "roughness": {"base": 0.36, "variation": 0.08, "map": "independent-procedural-coronary-vein-roughness", "localResponse": "slightly lower on exposed crests and higher in grooves"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "independent-procedural-coronary-vein-height-normal", "strength": 0.18, "scale": 18.0, "space": "tangent"}, "bump": {"pattern": "bounded organic relief", "amplitude": 0.025, "scale": 12.0}, "displacement": {"pattern": "macro-only", "amplitude": 0.015, "scale": 2.0, "silhouetteAffects": false}, "ambientOcclusion": {"map": "independent-procedural-coronary-vein-ao", "cavityStrength": 0.22, "contactShadowBias": 0.35, "notes": "Only contact/groove cavities; do not paint global dark gradients."}, "clearcoat": 0.17, "clearcoatRoughness": 0.46, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2A0B16"}, "localOverrides": [{"id": "vein-scale-response", "region": "anterior and posterior venous trunks", "roughness": 0.4, "evidenceRefs": ["anterior", "posterior", "right-oblique"]}], "shaderNotes": ["Use broad semi-gloss highlights; avoid a single global toy-plastic response.", "Keep albedo, roughness, normal/height and AO independent."], "notes": "Stylized tissue PBR estimate grounded in multi-view reference crops; not inverse-rendered clinical material data.", "referencePbr": {"version": "1", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-crops\\anterior\\coronary-vein.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "reference-pixel-extraction", "verdict": "pass", "usable": true, "confidence": 0.878, "estimatedFidelity": 0.878, "targetThreshold": 0.7, "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\coronary-vein\\coronary-vein_albedo.png", "url": "/references/heart-multiview/material-evidence/coronary-vein/coronary-vein_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\coronary-vein\\coronary-vein_roughness.png", "url": "/references/heart-multiview/material-evidence/coronary-vein/coronary-vein_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\coronary-vein\\coronary-vein_height.png", "url": "/references/heart-multiview/material-evidence/coronary-vein/coronary-vein_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\coronary-vein\\coronary-vein_normal.png", "url": "/references/heart-multiview/material-evidence/coronary-vein/coronary-vein_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\coronary-vein\\coronary-vein_ao.png", "url": "/references/heart-multiview/material-evidence/coronary-vein/coronary-vein_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "hardLimit": "single-image PBR extraction is an estimate; 70%+ extraction confidence still needs render screenshot review"}, "finishClass": "biological-vessel-satin", "automatedFinishClassification": "unclassified", "finishClassificationCorrection": {"authority": "agent-vision", "reason": "The verified crop is biological teaching-model tissue, not metal, gemstone, coating or translucent mineral.", "excludedReferenceElements": ["hotspot rings", "background", "pedestal", "UI", "text"]}},
    options
  );
  materialMap["epicardial-fat"] = createSculptMaterial(
    "epicardial-fat",
    {"id": "epicardial-fat", "name": "Epicardial fat", "type": "physical", "qualityTier": "hero", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#EE9F90", "color": "#EE9F90", "albedo": {"dominant": "#EE9F90", "secondary": ["#DC7C78", "#F4BCAC"], "samplingNotes": "Sample only the named tissue footprint; exclude hotspot rings, background, pedestal and UI."}, "colorVariation": {"palette": ["#EE9F90", "#DC7C78", "#F4BCAC"], "pattern": "low-frequency tissue mottling", "amplitude": 0.08, "heightCorrelation": 0.15}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-like generated object coordinates", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Object-scale stable relief; no source-photo projection."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.4, "amplitude": 0.09, "role": "broad tissue value and volume variation"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.035, "role": "shallow lobes, creases and vessel-wall variation"}, {"id": "micro", "frequency": 38.0, "amplitude": 0.012, "role": "restrained highlight breakup"}], "roughness": {"base": 0.4, "variation": 0.08, "map": "independent-procedural-epicardial-fat-roughness", "localResponse": "slightly lower on exposed crests and higher in grooves"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "independent-procedural-epicardial-fat-height-normal", "strength": 0.18, "scale": 18.0, "space": "tangent"}, "bump": {"pattern": "bounded organic relief", "amplitude": 0.025, "scale": 12.0}, "displacement": {"pattern": "macro-only", "amplitude": 0.015, "scale": 2.0, "silhouetteAffects": false}, "ambientOcclusion": {"map": "independent-procedural-epicardial-fat-ao", "cavityStrength": 0.22, "contactShadowBias": 0.35, "notes": "Only contact/groove cavities; do not paint global dark gradients."}, "clearcoat": 0.2, "clearcoatRoughness": 0.5, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2A0B16"}, "localOverrides": [{"id": "lobule-crest-gloss", "region": "fat lobule crests", "roughness": 0.34, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"]}], "shaderNotes": ["Use broad semi-gloss highlights; avoid a single global toy-plastic response.", "Keep albedo, roughness, normal/height and AO independent."], "notes": "Stylized tissue PBR estimate grounded in multi-view reference crops; not inverse-rendered clinical material data.", "referencePbr": {"version": "1", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-crops\\right-oblique\\epicardial-fat.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "reference-pixel-extraction", "verdict": "pass", "usable": true, "confidence": 0.832, "estimatedFidelity": 0.832, "targetThreshold": 0.7, "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\epicardial-fat\\epicardial-fat_albedo.png", "url": "/references/heart-multiview/material-evidence/epicardial-fat/epicardial-fat_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\epicardial-fat\\epicardial-fat_roughness.png", "url": "/references/heart-multiview/material-evidence/epicardial-fat/epicardial-fat_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\epicardial-fat\\epicardial-fat_height.png", "url": "/references/heart-multiview/material-evidence/epicardial-fat/epicardial-fat_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\epicardial-fat\\epicardial-fat_normal.png", "url": "/references/heart-multiview/material-evidence/epicardial-fat/epicardial-fat_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\epicardial-fat\\epicardial-fat_ao.png", "url": "/references/heart-multiview/material-evidence/epicardial-fat/epicardial-fat_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "hardLimit": "single-image PBR extraction is an estimate; 70%+ extraction confidence still needs render screenshot review"}, "finishClass": "biological-fat-wet-satin", "automatedFinishClassification": "unclassified", "finishClassificationCorrection": {"authority": "agent-vision", "reason": "The verified crop is biological teaching-model tissue, not metal, gemstone, coating or translucent mineral.", "excludedReferenceElements": ["hotspot rings", "background", "pedestal", "UI", "text"]}},
    options
  );
  materialMap["lumen"] = createSculptMaterial(
    "lumen",
    {"id": "lumen", "name": "Recessed vessel lumen", "type": "physical", "qualityTier": "utility", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#2D0814", "color": "#2D0814", "albedo": {"dominant": "#2D0814", "secondary": ["#120309"], "samplingNotes": "Sample only the named tissue footprint; exclude hotspot rings, background, pedestal and UI."}, "colorVariation": {"palette": ["#2D0814", "#120309"], "pattern": "low-frequency tissue mottling", "amplitude": 0.08, "heightCorrelation": 0.15}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-like generated object coordinates", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Object-scale stable relief; no source-photo projection."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.4, "amplitude": 0.09, "role": "broad tissue value and volume variation"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.035, "role": "shallow lobes, creases and vessel-wall variation"}, {"id": "micro", "frequency": 38.0, "amplitude": 0.012, "role": "restrained highlight breakup"}], "roughness": {"base": 0.7, "variation": 0.02, "map": "independent-procedural-lumen-roughness", "localResponse": "slightly lower on exposed crests and higher in grooves"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "independent-procedural-lumen-height-normal", "strength": 0.18, "scale": 18.0, "space": "tangent"}, "bump": {"pattern": "bounded organic relief", "amplitude": 0.025, "scale": 12.0}, "displacement": {"pattern": "macro-only", "amplitude": 0.015, "scale": 2.0, "silhouetteAffects": false}, "ambientOcclusion": {"map": "independent-procedural-lumen-ao", "cavityStrength": 0.22, "contactShadowBias": 0.35, "notes": "Only contact/groove cavities; do not paint global dark gradients."}, "clearcoat": 0.0, "clearcoatRoughness": 0.7999999999999999, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2A0B16"}, "localOverrides": [{"id": "lumen-depth-darkening", "region": "recessed tube interiors", "roughness": 0.76, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique", "superior"]}], "shaderNotes": ["Use broad semi-gloss highlights; avoid a single global toy-plastic response.", "Keep albedo, roughness, normal/height and AO independent."], "notes": "Stylized tissue PBR estimate grounded in multi-view reference crops; not inverse-rendered clinical material data."},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_ventricular_body_0 = makeAttachmentEndpoint(null);
  const node_ventricular_body_0 = new THREE.Group();
  node_ventricular_body_0.name = "Continuous asymmetric ventricular body__pivot";
  node_ventricular_body_0.scale.set(1, 1, 1);
  if (endpoint_ventricular_body_0) {
    node_ventricular_body_0.position.copy(endpoint_ventricular_body_0.start);
    node_ventricular_body_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ventricular_body_0.position.set(0.08, -0.35, 0.0);
    node_ventricular_body_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_ventricular_body_0.userData.sculptComponent = {"id": "ventricular-body", "name": "Continuous asymmetric ventricular body", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.94, "primitive": "capsule", "topologyClass": "implicit", "topologyRationale": "The ventricular myocardium is one seam-free asymmetric volume across all views with a widened lower belly and a subject-right offset apex.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "sdf": {"primitives": [{"id": "lv", "type": "ellipsoid", "center": [0.2, -0.28, -0.03], "radii": [0.92, 1.28, 0.7], "transform": {"rotation": [0.0, 0.0, 0.08]}}, {"id": "rv", "type": "ellipsoid", "center": [-0.31, -0.03, 0.26], "radii": [0.66, 0.9, 0.52], "transform": {"rotation": [0.0, -0.12, -0.1]}}, {"id": "apex", "type": "cone", "center": [0.38, -1.08, 0.04], "radius": 0.43, "height": 1.18, "transform": {"rotation": [0.0, 0.0, -0.1]}}], "operations": [{"id": "lv-rv", "type": "smooth-union", "left": "lv", "right": "rv", "radius": 0.24}, {"id": "heart-volume", "type": "smooth-union", "left": "lv-rv", "right": "apex", "radius": 0.2}], "resolution": 46, "bounds": {"min": [-1.2, -1.7, -0.9], "max": [1.35, 1.1, 1.0]}}}, "parent": null, "attachment": null, "dimensions": {"width": 2.08, "height": 2.65, "depth": 1.55, "units": "relative-heart-height", "confidence": 0.94}, "transform": {"position": [0.08, -0.35, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "ventricular-body-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ventricular-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "apex-offset", "kind": "contour", "description": "Inferior apex offset and taper.", "evidenceRefs": ["anterior", "left-oblique", "right-oblique"]}, {"id": "right-ventricular-wrap", "kind": "ridge", "description": "Anterior right-ventricular volume wrap.", "evidenceRefs": ["anterior", "right-oblique"]}, {"id": "atrioventricular-groove", "kind": "groove", "description": "Broad AV groove receiving fat and vessels.", "evidenceRefs": ["anterior", "posterior"]}, {"id": "forbidden-overlay-exclusion", "kind": "decal", "description": "Explicit negative constraint excluding non-subject overlays.", "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique", "superior"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_ventricular_body_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "ventricular-body-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ventricular-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["root"] ?? root).add(node_ventricular_body_0);
  nodes["ventricular-body"] = node_ventricular_body_0;
  const mesh_ventricular_body_0Geometry = polygonizeSdf({"primitives": [{"id": "lv", "type": "ellipsoid", "center": [0.2, -0.28, -0.03], "radii": [0.92, 1.28, 0.7], "transform": {"rotation": [0.0, 0.0, 0.08]}}, {"id": "rv", "type": "ellipsoid", "center": [-0.31, -0.03, 0.26], "radii": [0.66, 0.9, 0.52], "transform": {"rotation": [0.0, -0.12, -0.1]}}, {"id": "apex", "type": "cone", "center": [0.38, -1.08, 0.04], "radius": 0.43, "height": 1.18, "transform": {"rotation": [0.0, 0.0, -0.1]}}], "operations": [{"id": "lv-rv", "type": "smooth-union", "left": "lv", "right": "rv", "radius": 0.24}, {"id": "heart-volume", "type": "smooth-union", "left": "lv-rv", "right": "apex", "radius": 0.2}], "resolution": 46, "bounds": {"min": [-1.2, -1.7, -0.9], "max": [1.35, 1.1, 1.0]}});
  if (!endpoint_ventricular_body_0) {
    mesh_ventricular_body_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_ventricular_body_0 = new THREE.Mesh(
    mesh_ventricular_body_0Geometry,
    createSculptMaterial("myocardium", {"id": "myocardium", "name": "Myocardium", "type": "physical", "qualityTier": "hero", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#B73742", "color": "#B73742", "albedo": {"dominant": "#B73742", "secondary": ["#8D2636", "#D36A6C"], "samplingNotes": "Sample only the named tissue footprint; exclude hotspot rings, background, pedestal and UI."}, "colorVariation": {"palette": ["#B73742", "#8D2636", "#D36A6C"], "pattern": "low-frequency tissue mottling", "amplitude": 0.08, "heightCorrelation": 0.15}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-like generated object coordinates", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Object-scale stable relief; no source-photo projection."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.4, "amplitude": 0.09, "role": "broad tissue value and volume variation"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.035, "role": "shallow lobes, creases and vessel-wall variation"}, {"id": "micro", "frequency": 38.0, "amplitude": 0.012, "role": "restrained highlight breakup"}], "roughness": {"base": 0.46, "variation": 0.08, "map": "independent-procedural-myocardium-roughness", "localResponse": "slightly lower on exposed crests and higher in grooves"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "independent-procedural-myocardium-height-normal", "strength": 0.18, "scale": 18.0, "space": "tangent"}, "bump": {"pattern": "bounded organic relief", "amplitude": 0.025, "scale": 12.0}, "displacement": {"pattern": "macro-only", "amplitude": 0.015, "scale": 2.0, "silhouetteAffects": false}, "ambientOcclusion": {"map": "independent-procedural-myocardium-ao", "cavityStrength": 0.22, "contactShadowBias": 0.35, "notes": "Only contact/groove cavities; do not paint global dark gradients."}, "clearcoat": 0.16, "clearcoatRoughness": 0.52, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2A0B16"}, "localOverrides": [{"id": "fiber-relief", "region": "ventricular surfaces", "roughness": 0.52, "normalStrength": 0.16, "evidenceRefs": ["anterior", "posterior", "right-oblique"]}, {"id": "region-roughness", "region": "inferior and groove zones", "roughness": 0.58, "color": "#8F263A", "evidenceRefs": ["anterior", "posterior"]}], "shaderNotes": ["Use broad semi-gloss highlights; avoid a single global toy-plastic response.", "Keep albedo, roughness, normal/height and AO independent."], "notes": "Stylized tissue PBR estimate grounded in multi-view reference crops; not inverse-rendered clinical material data.", "referencePbr": {"version": "1", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-crops\\posterior\\myocardium.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "reference-pixel-extraction", "verdict": "pass", "usable": true, "confidence": 0.782, "estimatedFidelity": 0.782, "targetThreshold": 0.7, "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\myocardium\\myocardium_albedo.png", "url": "/references/heart-multiview/material-evidence/myocardium/myocardium_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\myocardium\\myocardium_roughness.png", "url": "/references/heart-multiview/material-evidence/myocardium/myocardium_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\myocardium\\myocardium_height.png", "url": "/references/heart-multiview/material-evidence/myocardium/myocardium_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\myocardium\\myocardium_normal.png", "url": "/references/heart-multiview/material-evidence/myocardium/myocardium_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\.img2threejs\\heart\\material-evidence\\myocardium\\myocardium_ao.png", "url": "/references/heart-multiview/material-evidence/myocardium/myocardium_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "hardLimit": "single-image PBR extraction is an estimate; 70%+ extraction confidence still needs render screenshot review"}, "finishClass": "biological-tissue-satin", "automatedFinishClassification": "unclassified", "finishClassificationCorrection": {"authority": "agent-vision", "reason": "The verified crop is biological teaching-model tissue, not metal, gemstone, coating or translucent mineral.", "excludedReferenceElements": ["hotspot rings", "background", "pedestal", "UI", "text"]}}, options, true)
  );
  mesh_ventricular_body_0.name = "Continuous asymmetric ventricular body";
  if (endpoint_ventricular_body_0) {
    mesh_ventricular_body_0.position.copy(endpoint_ventricular_body_0.midpoint);
    mesh_ventricular_body_0.quaternion.copy(endpoint_ventricular_body_0.quaternion);
  }
  mesh_ventricular_body_0.castShadow = options.castShadow ?? true;
  mesh_ventricular_body_0.receiveShadow = options.receiveShadow ?? true;
  mesh_ventricular_body_0.userData.sculptComponent = {"id": "ventricular-body", "name": "Continuous asymmetric ventricular body", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.94, "primitive": "capsule", "topologyClass": "implicit", "topologyRationale": "The ventricular myocardium is one seam-free asymmetric volume across all views with a widened lower belly and a subject-right offset apex.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "sdf": {"primitives": [{"id": "lv", "type": "ellipsoid", "center": [0.2, -0.28, -0.03], "radii": [0.92, 1.28, 0.7], "transform": {"rotation": [0.0, 0.0, 0.08]}}, {"id": "rv", "type": "ellipsoid", "center": [-0.31, -0.03, 0.26], "radii": [0.66, 0.9, 0.52], "transform": {"rotation": [0.0, -0.12, -0.1]}}, {"id": "apex", "type": "cone", "center": [0.38, -1.08, 0.04], "radius": 0.43, "height": 1.18, "transform": {"rotation": [0.0, 0.0, -0.1]}}], "operations": [{"id": "lv-rv", "type": "smooth-union", "left": "lv", "right": "rv", "radius": 0.24}, {"id": "heart-volume", "type": "smooth-union", "left": "lv-rv", "right": "apex", "radius": 0.2}], "resolution": 46, "bounds": {"min": [-1.2, -1.7, -0.9], "max": [1.35, 1.1, 1.0]}}}, "parent": null, "attachment": null, "dimensions": {"width": 2.08, "height": 2.65, "depth": 1.55, "units": "relative-heart-height", "confidence": 0.94}, "transform": {"position": [0.08, -0.35, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "ventricular-body-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ventricular-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "apex-offset", "kind": "contour", "description": "Inferior apex offset and taper.", "evidenceRefs": ["anterior", "left-oblique", "right-oblique"]}, {"id": "right-ventricular-wrap", "kind": "ridge", "description": "Anterior right-ventricular volume wrap.", "evidenceRefs": ["anterior", "right-oblique"]}, {"id": "atrioventricular-groove", "kind": "groove", "description": "Broad AV groove receiving fat and vessels.", "evidenceRefs": ["anterior", "posterior"]}, {"id": "forbidden-overlay-exclusion", "kind": "decal", "description": "Explicit negative constraint excluding non-subject overlays.", "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique", "superior"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_ventricular_body_0.add(mesh_ventricular_body_0);
  meshes["ventricular-body"] = mesh_ventricular_body_0;
  colliders["ventricular-body"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["ventricular-body"] ??= [];
  destructionGroups["ventricular-body"].push(node_ventricular_body_0);
  const socket_ventricular_body_ventricular_body_surface_0 = new THREE.Object3D();
  socket_ventricular_body_ventricular_body_surface_0.name = "ventricular-body-surface";
  socket_ventricular_body_ventricular_body_surface_0.position.set(0.0, 0.0, 0.0);
  socket_ventricular_body_ventricular_body_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_ventricular_body_ventricular_body_surface_0.userData.socket = {"id": "ventricular-body-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_ventricular_body_0.add(socket_ventricular_body_ventricular_body_surface_0);
  sockets["ventricular-body:ventricular-body-surface"] = socket_ventricular_body_ventricular_body_surface_0;

  const endpoint_atrial_complex_1 = makeAttachmentEndpoint(null);
  const node_atrial_complex_1 = new THREE.Group();
  node_atrial_complex_1.name = "Asymmetric atrial and auricular complex__pivot";
  node_atrial_complex_1.scale.set(1, 1, 1);
  if (endpoint_atrial_complex_1) {
    node_atrial_complex_1.position.copy(endpoint_atrial_complex_1.start);
    node_atrial_complex_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_atrial_complex_1.position.set(0.02, 0.7, -0.04);
    node_atrial_complex_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_atrial_complex_1.userData.sculptComponent = {"id": "atrial-complex", "name": "Asymmetric atrial and auricular complex", "level": "macro", "role": "body", "importance": 0.93, "confidence": 0.88, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Separate low-profile superior atrial masses overlap the ventricular shoulder; they must never collapse into one detached sphere.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.02, 0.7, -0.04], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"]}, "dimensions": {"width": 1.48, "height": 0.62, "depth": 1.12, "units": "relative-heart-height", "confidence": 0.88}, "transform": {"position": [0.02, 0.7, -0.04], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "atrial-complex-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "atrial-complex", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_atrial_complex_1.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "atrial-complex-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "atrial-complex", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["ventricular-body"] ?? root).add(node_atrial_complex_1);
  nodes["atrial-complex"] = node_atrial_complex_1;
  const mesh_atrial_complex_1Geometry = endpoint_atrial_complex_1
    ? new THREE.CylinderGeometry(endpoint_atrial_complex_1.endRadius, endpoint_atrial_complex_1.baseRadius, endpoint_atrial_complex_1.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_atrial_complex_1) {
    mesh_atrial_complex_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_atrial_complex_1 = new THREE.Mesh(
    mesh_atrial_complex_1Geometry,
    materialMap["myocardium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_atrial_complex_1.name = "Asymmetric atrial and auricular complex";
  if (endpoint_atrial_complex_1) {
    mesh_atrial_complex_1.position.copy(endpoint_atrial_complex_1.midpoint);
    mesh_atrial_complex_1.quaternion.copy(endpoint_atrial_complex_1.quaternion);
  }
  mesh_atrial_complex_1.castShadow = options.castShadow ?? true;
  mesh_atrial_complex_1.receiveShadow = options.receiveShadow ?? true;
  mesh_atrial_complex_1.userData.sculptComponent = {"id": "atrial-complex", "name": "Asymmetric atrial and auricular complex", "level": "macro", "role": "body", "importance": 0.93, "confidence": 0.88, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Separate low-profile superior atrial masses overlap the ventricular shoulder; they must never collapse into one detached sphere.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.02, 0.7, -0.04], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"]}, "dimensions": {"width": 1.48, "height": 0.62, "depth": 1.12, "units": "relative-heart-height", "confidence": 0.88}, "transform": {"position": [0.02, 0.7, -0.04], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "atrial-complex-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "atrial-complex", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_atrial_complex_1.add(mesh_atrial_complex_1);
  meshes["atrial-complex"] = mesh_atrial_complex_1;
  colliders["atrial-complex"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["atrial-complex"] ??= [];
  destructionGroups["atrial-complex"].push(node_atrial_complex_1);
  const socket_atrial_complex_atrial_complex_surface_0 = new THREE.Object3D();
  socket_atrial_complex_atrial_complex_surface_0.name = "atrial-complex-surface";
  socket_atrial_complex_atrial_complex_surface_0.position.set(0.0, 0.0, 0.0);
  socket_atrial_complex_atrial_complex_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_atrial_complex_atrial_complex_surface_0.userData.socket = {"id": "atrial-complex-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_atrial_complex_1.add(socket_atrial_complex_atrial_complex_surface_0);
  sockets["atrial-complex:atrial-complex-surface"] = socket_atrial_complex_atrial_complex_surface_0;

  const attachment_aortic_system_2 = {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [-0.12, 0.58, 0.02], "localEnd": [0.62, 1.4, -0.58], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior", "superior"]};
  const endpoint_aortic_system_2 = makeAttachmentEndpoint(attachment_aortic_system_2);
  const node_aortic_system_2 = new THREE.Group();
  node_aortic_system_2.name = "Aortic root, ascending segment and arch__pivot";
  node_aortic_system_2.scale.set(1, 1, 1);
  if (endpoint_aortic_system_2) {
    node_aortic_system_2.position.copy(endpoint_aortic_system_2.start);
    node_aortic_system_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_aortic_system_2.position.set(0.0, 0.0, 0.0);
    node_aortic_system_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_aortic_system_2.userData.sculptComponent = {"id": "aortic-system", "name": "Aortic root, ascending segment and arch", "level": "macro", "role": "vessel", "importance": 0.98, "confidence": 0.94, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "A thick branching tubular system rises from the base and sweeps posteriorly.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.12, 0.58, 0.02], [-0.12, 1.2, 0.0], [0.0, 1.68, -0.12], [0.42, 1.72, -0.42], [0.62, 1.4, -0.58]], "radius": 0.25, "radialSegments": 12, "closed": false}}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [-0.12, 0.58, 0.02], "localEnd": [0.62, 1.4, -0.58], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.94}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "logical-alias", "logicalAliasOf": "ventricular-body", "pivot": {"mode": "delegated-parent", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "aortic-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "root-arch-sweep", "kind": "contour", "description": "Wide root and posterior arch sweep.", "evidenceRefs": ["anterior", "posterior", "superior"]}, {"id": "three-hollow-branches", "kind": "hole", "description": "Exactly three thick-walled superior branch openings.", "evidenceRefs": ["anterior", "posterior", "superior"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 74, 73, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["anterior", "posterior", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "posterior", "superior"], "details": [], "fidelityTier": "hero"};
  node_aortic_system_2.userData.actionProfile = {"animationRole": "logical-alias", "logicalAliasOf": "ventricular-body", "pivot": {"mode": "delegated-parent", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "aortic-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["ventricular-body"] ?? root).add(node_aortic_system_2);
  nodes["aortic-system"] = node_aortic_system_2;
  const mesh_aortic_system_2Geometry = endpoint_aortic_system_2
    ? new THREE.CylinderGeometry(endpoint_aortic_system_2.endRadius, endpoint_aortic_system_2.baseRadius, endpoint_aortic_system_2.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.12, 0.58, 0.02], [-0.12, 1.2, 0.0], [0.0, 1.68, -0.12], [0.42, 1.72, -0.42], [0.62, 1.4, -0.58]], "radius": 0.25, "radialSegments": 12, "closed": false});
  if (!endpoint_aortic_system_2) {
    mesh_aortic_system_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_aortic_system_2 = new THREE.Mesh(
    mesh_aortic_system_2Geometry,
    materialMap["arterial"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_aortic_system_2.name = "Aortic root, ascending segment and arch";
  if (endpoint_aortic_system_2) {
    mesh_aortic_system_2.position.copy(endpoint_aortic_system_2.midpoint);
    mesh_aortic_system_2.quaternion.copy(endpoint_aortic_system_2.quaternion);
  }
  mesh_aortic_system_2.castShadow = options.castShadow ?? true;
  mesh_aortic_system_2.receiveShadow = options.receiveShadow ?? true;
  mesh_aortic_system_2.userData.sculptComponent = {"id": "aortic-system", "name": "Aortic root, ascending segment and arch", "level": "macro", "role": "vessel", "importance": 0.98, "confidence": 0.94, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "A thick branching tubular system rises from the base and sweeps posteriorly.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.12, 0.58, 0.02], [-0.12, 1.2, 0.0], [0.0, 1.68, -0.12], [0.42, 1.72, -0.42], [0.62, 1.4, -0.58]], "radius": 0.25, "radialSegments": 12, "closed": false}}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [-0.12, 0.58, 0.02], "localEnd": [0.62, 1.4, -0.58], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.94}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "logical-alias", "logicalAliasOf": "ventricular-body", "pivot": {"mode": "delegated-parent", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "aortic-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "root-arch-sweep", "kind": "contour", "description": "Wide root and posterior arch sweep.", "evidenceRefs": ["anterior", "posterior", "superior"]}, {"id": "three-hollow-branches", "kind": "hole", "description": "Exactly three thick-walled superior branch openings.", "evidenceRefs": ["anterior", "posterior", "superior"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 74, 73, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["anterior", "posterior", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "posterior", "superior"], "details": [], "fidelityTier": "hero"};
  node_aortic_system_2.add(mesh_aortic_system_2);
  meshes["aortic-system"] = mesh_aortic_system_2;
  colliders["aortic-system"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["aortic-system"] ??= [];
  destructionGroups["aortic-system"].push(node_aortic_system_2);
  const socket_aortic_system_aortic_system_surface_0 = new THREE.Object3D();
  socket_aortic_system_aortic_system_surface_0.name = "aortic-system-surface";
  socket_aortic_system_aortic_system_surface_0.position.set(0.0, 0.0, 0.0);
  socket_aortic_system_aortic_system_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_aortic_system_aortic_system_surface_0.userData.socket = {"id": "aortic-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_aortic_system_2.add(socket_aortic_system_aortic_system_surface_0);
  sockets["aortic-system:aortic-system-surface"] = socket_aortic_system_aortic_system_surface_0;

  const attachment_pulmonary_venous_system_3 = {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.18, 0.52, 0.38], "localEnd": [0.25, 1.25, 0.54], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique", "superior"]};
  const endpoint_pulmonary_venous_system_3 = makeAttachmentEndpoint(attachment_pulmonary_venous_system_3);
  const node_pulmonary_venous_system_3 = new THREE.Group();
  node_pulmonary_venous_system_3.name = "Pulmonary trunk, caval and return-vessel system__pivot";
  node_pulmonary_venous_system_3.scale.set(1, 1, 1);
  if (endpoint_pulmonary_venous_system_3) {
    node_pulmonary_venous_system_3.position.copy(endpoint_pulmonary_venous_system_3.start);
    node_pulmonary_venous_system_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pulmonary_venous_system_3.position.set(0.0, 0.0, 0.0);
    node_pulmonary_venous_system_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_pulmonary_venous_system_3.userData.sculptComponent = {"id": "pulmonary-venous-system", "name": "Pulmonary trunk, caval and return-vessel system", "level": "macro", "role": "vessel", "importance": 0.97, "confidence": 0.9, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multiple thick tubes cross and enter the atrial complex with view-consistent roots.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.18, 0.52, 0.38], [0.16, 0.98, 0.58], [0.25, 1.25, 0.54]], "radius": 0.22, "radialSegments": 12, "closed": false}}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.18, 0.52, 0.38], "localEnd": [0.25, 1.25, 0.54], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.9}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "logical-alias", "logicalAliasOf": "ventricular-body", "pivot": {"mode": "delegated-parent", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "pulmonary-venous-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-venous-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "venous", "materialLayers": ["venous"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "anterior-crossing", "kind": "contour", "description": "Pulmonary trunk crosses anterior to aortic root.", "evidenceRefs": ["anterior", "superior"]}, {"id": "hollow-branch-ends", "kind": "hole", "description": "Bilateral pulmonary branch lumens.", "evidenceRefs": ["anterior", "left-oblique", "right-oblique", "superior"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(70, 23, 51, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(70, 23, 51, 1.0)"}, {"position": 1.0, "color": "rgba(116, 43, 75, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique", "superior"], "details": [], "fidelityTier": "hero"};
  node_pulmonary_venous_system_3.userData.actionProfile = {"animationRole": "logical-alias", "logicalAliasOf": "ventricular-body", "pivot": {"mode": "delegated-parent", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "pulmonary-venous-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-venous-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["ventricular-body"] ?? root).add(node_pulmonary_venous_system_3);
  nodes["pulmonary-venous-system"] = node_pulmonary_venous_system_3;
  const mesh_pulmonary_venous_system_3Geometry = endpoint_pulmonary_venous_system_3
    ? new THREE.CylinderGeometry(endpoint_pulmonary_venous_system_3.endRadius, endpoint_pulmonary_venous_system_3.baseRadius, endpoint_pulmonary_venous_system_3.length, 32, 12)
    : buildTubeGeometry({"points": [[0.18, 0.52, 0.38], [0.16, 0.98, 0.58], [0.25, 1.25, 0.54]], "radius": 0.22, "radialSegments": 12, "closed": false});
  if (!endpoint_pulmonary_venous_system_3) {
    mesh_pulmonary_venous_system_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pulmonary_venous_system_3 = new THREE.Mesh(
    mesh_pulmonary_venous_system_3Geometry,
    materialMap["venous"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pulmonary_venous_system_3.name = "Pulmonary trunk, caval and return-vessel system";
  if (endpoint_pulmonary_venous_system_3) {
    mesh_pulmonary_venous_system_3.position.copy(endpoint_pulmonary_venous_system_3.midpoint);
    mesh_pulmonary_venous_system_3.quaternion.copy(endpoint_pulmonary_venous_system_3.quaternion);
  }
  mesh_pulmonary_venous_system_3.castShadow = options.castShadow ?? true;
  mesh_pulmonary_venous_system_3.receiveShadow = options.receiveShadow ?? true;
  mesh_pulmonary_venous_system_3.userData.sculptComponent = {"id": "pulmonary-venous-system", "name": "Pulmonary trunk, caval and return-vessel system", "level": "macro", "role": "vessel", "importance": 0.97, "confidence": 0.9, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multiple thick tubes cross and enter the atrial complex with view-consistent roots.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.18, 0.52, 0.38], [0.16, 0.98, 0.58], [0.25, 1.25, 0.54]], "radius": 0.22, "radialSegments": 12, "closed": false}}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.18, 0.52, 0.38], "localEnd": [0.25, 1.25, 0.54], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.9}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "logical-alias", "logicalAliasOf": "ventricular-body", "pivot": {"mode": "delegated-parent", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "pulmonary-venous-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-venous-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "venous", "materialLayers": ["venous"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "anterior-crossing", "kind": "contour", "description": "Pulmonary trunk crosses anterior to aortic root.", "evidenceRefs": ["anterior", "superior"]}, {"id": "hollow-branch-ends", "kind": "hole", "description": "Bilateral pulmonary branch lumens.", "evidenceRefs": ["anterior", "left-oblique", "right-oblique", "superior"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(70, 23, 51, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(70, 23, 51, 1.0)"}, {"position": 1.0, "color": "rgba(116, 43, 75, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique", "superior"], "details": [], "fidelityTier": "hero"};
  node_pulmonary_venous_system_3.add(mesh_pulmonary_venous_system_3);
  meshes["pulmonary-venous-system"] = mesh_pulmonary_venous_system_3;
  colliders["pulmonary-venous-system"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["pulmonary-venous-system"] ??= [];
  destructionGroups["pulmonary-venous-system"].push(node_pulmonary_venous_system_3);
  const socket_pulmonary_venous_system_pulmonary_venous_system_surface_0 = new THREE.Object3D();
  socket_pulmonary_venous_system_pulmonary_venous_system_surface_0.name = "pulmonary-venous-system-surface";
  socket_pulmonary_venous_system_pulmonary_venous_system_surface_0.position.set(0.0, 0.0, 0.0);
  socket_pulmonary_venous_system_pulmonary_venous_system_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_pulmonary_venous_system_pulmonary_venous_system_surface_0.userData.socket = {"id": "pulmonary-venous-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_pulmonary_venous_system_3.add(socket_pulmonary_venous_system_pulmonary_venous_system_surface_0);
  sockets["pulmonary-venous-system:pulmonary-venous-system-surface"] = socket_pulmonary_venous_system_pulmonary_venous_system_surface_0;

  const attachment_coronary_network_4 = {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.05, 0.75, 0.7], "localEnd": [-0.1, -1.25, 0.25], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"]};
  const endpoint_coronary_network_4 = makeAttachmentEndpoint(attachment_coronary_network_4);
  const node_coronary_network_4 = new THREE.Group();
  node_coronary_network_4.name = "Surface-attached coronary artery and vein network__pivot";
  node_coronary_network_4.scale.set(1, 1, 1);
  if (endpoint_coronary_network_4) {
    node_coronary_network_4.position.copy(endpoint_coronary_network_4.start);
    node_coronary_network_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_coronary_network_4.position.set(0.0, 0.0, 0.0);
    node_coronary_network_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_coronary_network_4.userData.sculptComponent = {"id": "coronary-network", "name": "Surface-attached coronary artery and vein network", "level": "macro", "role": "vessel", "importance": 0.94, "confidence": 0.84, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "A hierarchical curve network follows myocardial grooves and wraps laterally/posteriorly.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.05, 0.75, 0.7], [0.04, 0.1, 0.82], [0.08, -0.65, 0.68], [-0.1, -1.25, 0.25]], "radius": 0.045, "radialSegments": 8, "closed": false}}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.05, 0.75, 0.7], "localEnd": [-0.1, -1.25, 0.25], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.84}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "coronary-network-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coronary-network", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "coronary-vein", "materialLayers": ["coronary-vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "anterior-trunks", "kind": "ridge", "description": "Anterior artery and vein trunks.", "evidenceRefs": ["anterior"]}, {"id": "lateral-wrap", "kind": "ridge", "description": "Flush lateral wrap paths.", "evidenceRefs": ["left-oblique", "right-oblique"]}, {"id": "posterior-continuation", "kind": "ridge", "description": "Sparse posterior continuation with tapered ends.", "evidenceRefs": ["posterior"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(47, 15, 44, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(47, 15, 44, 1.0)"}, {"position": 1.0, "color": "rgba(84, 28, 68, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_coronary_network_4.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "coronary-network-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coronary-network", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["ventricular-body"] ?? root).add(node_coronary_network_4);
  nodes["coronary-network"] = node_coronary_network_4;
  const mesh_coronary_network_4Geometry = endpoint_coronary_network_4
    ? new THREE.CylinderGeometry(endpoint_coronary_network_4.endRadius, endpoint_coronary_network_4.baseRadius, endpoint_coronary_network_4.length, 32, 12)
    : buildTubeGeometry({"points": [[0.05, 0.75, 0.7], [0.04, 0.1, 0.82], [0.08, -0.65, 0.68], [-0.1, -1.25, 0.25]], "radius": 0.045, "radialSegments": 8, "closed": false});
  if (!endpoint_coronary_network_4) {
    mesh_coronary_network_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_coronary_network_4 = new THREE.Mesh(
    mesh_coronary_network_4Geometry,
    materialMap["coronary-vein"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coronary_network_4.name = "Surface-attached coronary artery and vein network";
  if (endpoint_coronary_network_4) {
    mesh_coronary_network_4.position.copy(endpoint_coronary_network_4.midpoint);
    mesh_coronary_network_4.quaternion.copy(endpoint_coronary_network_4.quaternion);
  }
  mesh_coronary_network_4.castShadow = options.castShadow ?? true;
  mesh_coronary_network_4.receiveShadow = options.receiveShadow ?? true;
  mesh_coronary_network_4.userData.sculptComponent = {"id": "coronary-network", "name": "Surface-attached coronary artery and vein network", "level": "macro", "role": "vessel", "importance": 0.94, "confidence": 0.84, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "A hierarchical curve network follows myocardial grooves and wraps laterally/posteriorly.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.05, 0.75, 0.7], [0.04, 0.1, 0.82], [0.08, -0.65, 0.68], [-0.1, -1.25, 0.25]], "radius": 0.045, "radialSegments": 8, "closed": false}}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.05, 0.75, 0.7], "localEnd": [-0.1, -1.25, 0.25], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.84}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "coronary-network-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coronary-network", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "coronary-vein", "materialLayers": ["coronary-vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "anterior-trunks", "kind": "ridge", "description": "Anterior artery and vein trunks.", "evidenceRefs": ["anterior"]}, {"id": "lateral-wrap", "kind": "ridge", "description": "Flush lateral wrap paths.", "evidenceRefs": ["left-oblique", "right-oblique"]}, {"id": "posterior-continuation", "kind": "ridge", "description": "Sparse posterior continuation with tapered ends.", "evidenceRefs": ["posterior"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(47, 15, 44, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(47, 15, 44, 1.0)"}, {"position": 1.0, "color": "rgba(84, 28, 68, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_coronary_network_4.add(mesh_coronary_network_4);
  meshes["coronary-network"] = mesh_coronary_network_4;
  colliders["coronary-network"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["coronary-network"] ??= [];
  destructionGroups["coronary-network"].push(node_coronary_network_4);
  const socket_coronary_network_coronary_network_surface_0 = new THREE.Object3D();
  socket_coronary_network_coronary_network_surface_0.name = "coronary-network-surface";
  socket_coronary_network_coronary_network_surface_0.position.set(0.0, 0.0, 0.0);
  socket_coronary_network_coronary_network_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_coronary_network_coronary_network_surface_0.userData.socket = {"id": "coronary-network-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_coronary_network_4.add(socket_coronary_network_coronary_network_surface_0);
  sockets["coronary-network:coronary-network-surface"] = socket_coronary_network_coronary_network_surface_0;

  const endpoint_epicardial_fat_5 = makeAttachmentEndpoint(null);
  const node_epicardial_fat_5 = new THREE.Group();
  node_epicardial_fat_5.name = "Lobulated epicardial fat and auricular cover__pivot";
  node_epicardial_fat_5.scale.set(1, 1, 1);
  if (endpoint_epicardial_fat_5) {
    node_epicardial_fat_5.position.copy(endpoint_epicardial_fat_5.start);
    node_epicardial_fat_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_epicardial_fat_5.position.set(0.0, 0.58, 0.1);
    node_epicardial_fat_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_epicardial_fat_5.userData.sculptComponent = {"id": "epicardial-fat", "name": "Lobulated epicardial fat and auricular cover", "level": "macro", "role": "fat-pad", "importance": 0.91, "confidence": 0.9, "primitive": "instanced-cluster", "topologyClass": "continuous-sculpt", "topologyRationale": "Irregular overlapping organic lobules cover the superior AV region with asymmetric distribution.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "baseGeometry": "ellipsoid"}, "parent": "atrial-complex", "attachment": {"parentId": "atrial-complex", "parentSocket": "atrial-complex-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.58, 0.1], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"]}, "dimensions": {"width": 1.7, "height": 0.72, "depth": 1.35, "units": "relative-heart-height", "confidence": 0.9}, "transform": {"position": [0.0, 0.58, 0.1], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "epicardial-fat-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "epicardial-fat", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "epicardial-fat", "materialLayers": ["epicardial-fat"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "left-lobule-cluster", "kind": "ridge", "description": "Broad irregular left AV fat lobules.", "evidenceRefs": ["anterior", "left-oblique", "posterior"]}, {"id": "right-lobule-cluster", "kind": "ridge", "description": "Smaller right AV fat lobules.", "evidenceRefs": ["anterior", "right-oblique"]}, {"id": "posterior-cap", "kind": "ridge", "description": "Broad irregular posterior fat cap.", "evidenceRefs": ["posterior"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 159, 144, 1.0)", "secondaryAlbedo": "rgba(220, 124, 120, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(220, 124, 120, 1.0)"}, {"position": 1.0, "color": "rgba(238, 159, 144, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_epicardial_fat_5.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "epicardial-fat-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "epicardial-fat", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["atrial-complex"] ?? root).add(node_epicardial_fat_5);
  nodes["epicardial-fat"] = node_epicardial_fat_5;
  const mesh_epicardial_fat_5Geometry = endpoint_epicardial_fat_5
    ? new THREE.CylinderGeometry(endpoint_epicardial_fat_5.endRadius, endpoint_epicardial_fat_5.baseRadius, endpoint_epicardial_fat_5.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_epicardial_fat_5) {
    mesh_epicardial_fat_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_epicardial_fat_5 = new THREE.Mesh(
    mesh_epicardial_fat_5Geometry,
    materialMap["epicardial-fat"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_epicardial_fat_5.name = "Lobulated epicardial fat and auricular cover";
  if (endpoint_epicardial_fat_5) {
    mesh_epicardial_fat_5.position.copy(endpoint_epicardial_fat_5.midpoint);
    mesh_epicardial_fat_5.quaternion.copy(endpoint_epicardial_fat_5.quaternion);
  }
  mesh_epicardial_fat_5.castShadow = options.castShadow ?? true;
  mesh_epicardial_fat_5.receiveShadow = options.receiveShadow ?? true;
  mesh_epicardial_fat_5.userData.sculptComponent = {"id": "epicardial-fat", "name": "Lobulated epicardial fat and auricular cover", "level": "macro", "role": "fat-pad", "importance": 0.91, "confidence": 0.9, "primitive": "instanced-cluster", "topologyClass": "continuous-sculpt", "topologyRationale": "Irregular overlapping organic lobules cover the superior AV region with asymmetric distribution.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "baseGeometry": "ellipsoid"}, "parent": "atrial-complex", "attachment": {"parentId": "atrial-complex", "parentSocket": "atrial-complex-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.58, 0.1], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"]}, "dimensions": {"width": 1.7, "height": 0.72, "depth": 1.35, "units": "relative-heart-height", "confidence": 0.9}, "transform": {"position": [0.0, 0.58, 0.1], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "epicardial-fat-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "epicardial-fat", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "epicardial-fat", "materialLayers": ["epicardial-fat"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "left-lobule-cluster", "kind": "ridge", "description": "Broad irregular left AV fat lobules.", "evidenceRefs": ["anterior", "left-oblique", "posterior"]}, {"id": "right-lobule-cluster", "kind": "ridge", "description": "Smaller right AV fat lobules.", "evidenceRefs": ["anterior", "right-oblique"]}, {"id": "posterior-cap", "kind": "ridge", "description": "Broad irregular posterior fat cap.", "evidenceRefs": ["posterior"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 159, 144, 1.0)", "secondaryAlbedo": "rgba(220, 124, 120, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(220, 124, 120, 1.0)"}, {"position": 1.0, "color": "rgba(238, 159, 144, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "posterior", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_epicardial_fat_5.add(mesh_epicardial_fat_5);
  meshes["epicardial-fat"] = mesh_epicardial_fat_5;
  colliders["epicardial-fat"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["epicardial-fat"] ??= [];
  destructionGroups["epicardial-fat"].push(node_epicardial_fat_5);
  const socket_epicardial_fat_epicardial_fat_surface_0 = new THREE.Object3D();
  socket_epicardial_fat_epicardial_fat_surface_0.name = "epicardial-fat-surface";
  socket_epicardial_fat_epicardial_fat_surface_0.position.set(0.0, 0.0, 0.0);
  socket_epicardial_fat_epicardial_fat_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_epicardial_fat_epicardial_fat_surface_0.userData.socket = {"id": "epicardial-fat-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_epicardial_fat_5.add(socket_epicardial_fat_epicardial_fat_surface_0);
  sockets["epicardial-fat:epicardial-fat-surface"] = socket_epicardial_fat_epicardial_fat_surface_0;

  const endpoint_left_ventricular_mass_6 = makeAttachmentEndpoint(null);
  const node_left_ventricular_mass_6 = new THREE.Group();
  node_left_ventricular_mass_6.name = "Left ventricular/apical dominant mass__pivot";
  node_left_ventricular_mass_6.scale.set(1, 1, 1);
  if (endpoint_left_ventricular_mass_6) {
    node_left_ventricular_mass_6.position.copy(endpoint_left_ventricular_mass_6.start);
    node_left_ventricular_mass_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_left_ventricular_mass_6.position.set(-0.22, -0.38, -0.02);
    node_left_ventricular_mass_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_left_ventricular_mass_6.userData.sculptComponent = {"id": "left-ventricular-mass", "name": "Left ventricular/apical dominant mass", "level": "meso", "role": "body", "importance": 0.78, "confidence": 0.82, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named left ventricular/apical dominant mass as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [-0.22, -0.38, -0.02], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "posterior"]}, "dimensions": {"width": 1.22, "height": 2.25, "depth": 1.2, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [-0.22, -0.38, -0.02], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": false, "materialState": false}, "sockets": [{"id": "left-ventricular-mass-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-ventricular-mass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "posterior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "posterior"], "details": [], "fidelityTier": "hero"};
  node_left_ventricular_mass_6.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": false, "materialState": false}, "sockets": [{"id": "left-ventricular-mass-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-ventricular-mass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["ventricular-body"] ?? root).add(node_left_ventricular_mass_6);
  nodes["left-ventricular-mass"] = node_left_ventricular_mass_6;
  const mesh_left_ventricular_mass_6Geometry = endpoint_left_ventricular_mass_6
    ? new THREE.CylinderGeometry(endpoint_left_ventricular_mass_6.endRadius, endpoint_left_ventricular_mass_6.baseRadius, endpoint_left_ventricular_mass_6.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_left_ventricular_mass_6) {
    mesh_left_ventricular_mass_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_left_ventricular_mass_6 = new THREE.Mesh(
    mesh_left_ventricular_mass_6Geometry,
    materialMap["myocardium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_left_ventricular_mass_6.name = "Left ventricular/apical dominant mass";
  if (endpoint_left_ventricular_mass_6) {
    mesh_left_ventricular_mass_6.position.copy(endpoint_left_ventricular_mass_6.midpoint);
    mesh_left_ventricular_mass_6.quaternion.copy(endpoint_left_ventricular_mass_6.quaternion);
  }
  mesh_left_ventricular_mass_6.castShadow = options.castShadow ?? true;
  mesh_left_ventricular_mass_6.receiveShadow = options.receiveShadow ?? true;
  mesh_left_ventricular_mass_6.userData.sculptComponent = {"id": "left-ventricular-mass", "name": "Left ventricular/apical dominant mass", "level": "meso", "role": "body", "importance": 0.78, "confidence": 0.82, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named left ventricular/apical dominant mass as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [-0.22, -0.38, -0.02], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "posterior"]}, "dimensions": {"width": 1.22, "height": 2.25, "depth": 1.2, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [-0.22, -0.38, -0.02], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": false, "materialState": false}, "sockets": [{"id": "left-ventricular-mass-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-ventricular-mass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "posterior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "posterior"], "details": [], "fidelityTier": "hero"};
  node_left_ventricular_mass_6.add(mesh_left_ventricular_mass_6);
  meshes["left-ventricular-mass"] = mesh_left_ventricular_mass_6;
  colliders["left-ventricular-mass"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["left-ventricular-mass"] ??= [];
  destructionGroups["left-ventricular-mass"].push(node_left_ventricular_mass_6);
  const socket_left_ventricular_mass_left_ventricular_mass_surface_0 = new THREE.Object3D();
  socket_left_ventricular_mass_left_ventricular_mass_surface_0.name = "left-ventricular-mass-surface";
  socket_left_ventricular_mass_left_ventricular_mass_surface_0.position.set(0.0, 0.0, 0.0);
  socket_left_ventricular_mass_left_ventricular_mass_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_left_ventricular_mass_left_ventricular_mass_surface_0.userData.socket = {"id": "left-ventricular-mass-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_left_ventricular_mass_6.add(socket_left_ventricular_mass_left_ventricular_mass_surface_0);
  sockets["left-ventricular-mass:left-ventricular-mass-surface"] = socket_left_ventricular_mass_left_ventricular_mass_surface_0;

  const endpoint_right_ventricular_wrap_7 = makeAttachmentEndpoint(null);
  const node_right_ventricular_wrap_7 = new THREE.Group();
  node_right_ventricular_wrap_7.name = "Anterior right ventricular wrap__pivot";
  node_right_ventricular_wrap_7.scale.set(1, 1, 1);
  if (endpoint_right_ventricular_wrap_7) {
    node_right_ventricular_wrap_7.position.copy(endpoint_right_ventricular_wrap_7.start);
    node_right_ventricular_wrap_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_right_ventricular_wrap_7.position.set(0.3, -0.02, 0.38);
    node_right_ventricular_wrap_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_right_ventricular_wrap_7.userData.sculptComponent = {"id": "right-ventricular-wrap", "name": "Anterior right ventricular wrap", "level": "meso", "role": "body", "importance": 0.78, "confidence": 0.82, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named anterior right ventricular wrap as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.3, -0.02, 0.38], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "right-oblique"]}, "dimensions": {"width": 1.05, "height": 1.65, "depth": 0.82, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.3, -0.02, 0.38], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-ventricular-wrap-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-ventricular-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_right_ventricular_wrap_7.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-ventricular-wrap-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-ventricular-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["ventricular-body"] ?? root).add(node_right_ventricular_wrap_7);
  nodes["right-ventricular-wrap"] = node_right_ventricular_wrap_7;
  const mesh_right_ventricular_wrap_7Geometry = endpoint_right_ventricular_wrap_7
    ? new THREE.CylinderGeometry(endpoint_right_ventricular_wrap_7.endRadius, endpoint_right_ventricular_wrap_7.baseRadius, endpoint_right_ventricular_wrap_7.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_right_ventricular_wrap_7) {
    mesh_right_ventricular_wrap_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_right_ventricular_wrap_7 = new THREE.Mesh(
    mesh_right_ventricular_wrap_7Geometry,
    materialMap["myocardium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_right_ventricular_wrap_7.name = "Anterior right ventricular wrap";
  if (endpoint_right_ventricular_wrap_7) {
    mesh_right_ventricular_wrap_7.position.copy(endpoint_right_ventricular_wrap_7.midpoint);
    mesh_right_ventricular_wrap_7.quaternion.copy(endpoint_right_ventricular_wrap_7.quaternion);
  }
  mesh_right_ventricular_wrap_7.castShadow = options.castShadow ?? true;
  mesh_right_ventricular_wrap_7.receiveShadow = options.receiveShadow ?? true;
  mesh_right_ventricular_wrap_7.userData.sculptComponent = {"id": "right-ventricular-wrap", "name": "Anterior right ventricular wrap", "level": "meso", "role": "body", "importance": 0.78, "confidence": 0.82, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named anterior right ventricular wrap as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.3, -0.02, 0.38], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "right-oblique"]}, "dimensions": {"width": 1.05, "height": 1.65, "depth": 0.82, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.3, -0.02, 0.38], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-ventricular-wrap-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-ventricular-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_right_ventricular_wrap_7.add(mesh_right_ventricular_wrap_7);
  meshes["right-ventricular-wrap"] = mesh_right_ventricular_wrap_7;
  colliders["right-ventricular-wrap"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["right-ventricular-wrap"] ??= [];
  destructionGroups["right-ventricular-wrap"].push(node_right_ventricular_wrap_7);
  const socket_right_ventricular_wrap_right_ventricular_wrap_surface_0 = new THREE.Object3D();
  socket_right_ventricular_wrap_right_ventricular_wrap_surface_0.name = "right-ventricular-wrap-surface";
  socket_right_ventricular_wrap_right_ventricular_wrap_surface_0.position.set(0.0, 0.0, 0.0);
  socket_right_ventricular_wrap_right_ventricular_wrap_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_right_ventricular_wrap_right_ventricular_wrap_surface_0.userData.socket = {"id": "right-ventricular-wrap-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_right_ventricular_wrap_7.add(socket_right_ventricular_wrap_right_ventricular_wrap_surface_0);
  sockets["right-ventricular-wrap:right-ventricular-wrap-surface"] = socket_right_ventricular_wrap_right_ventricular_wrap_surface_0;

  const endpoint_apex_volume_8 = makeAttachmentEndpoint(null);
  const node_apex_volume_8 = new THREE.Group();
  node_apex_volume_8.name = "Inferior tapered apex__pivot";
  node_apex_volume_8.scale.set(1, 1, 1);
  if (endpoint_apex_volume_8) {
    node_apex_volume_8.position.copy(endpoint_apex_volume_8.start);
    node_apex_volume_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_apex_volume_8.position.set(-0.18, -1.25, 0.08);
    node_apex_volume_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_apex_volume_8.userData.sculptComponent = {"id": "apex-volume", "name": "Inferior tapered apex", "level": "meso", "role": "body", "importance": 0.78, "confidence": 0.82, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named inferior tapered apex as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.0, -0.5, 0.0], "rx": 0.35, "rz": 0.3}, {"position": [0.0, 0.15, 0.0], "rx": 0.52, "rz": 0.42}, {"position": [0.0, 0.55, 0.0], "rx": 0.08, "rz": 0.07}], "radialSegments": 18, "capEnds": true}}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [-0.18, -1.25, 0.08], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "right-oblique"]}, "dimensions": {"width": 0.72, "height": 1.15, "depth": 0.68, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [-0.18, -1.25, 0.08], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "logical-alias", "logicalAliasOf": "ventricular-body", "pivot": {"mode": "delegated-parent", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": false, "materialState": false}, "sockets": [], "collider": {"type": "delegated-parent", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "apex-volume", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_apex_volume_8.userData.actionProfile = {"animationRole": "logical-alias", "logicalAliasOf": "ventricular-body", "pivot": {"mode": "delegated-parent", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": false, "materialState": false}, "sockets": [], "collider": {"type": "delegated-parent", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "apex-volume", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["ventricular-body"] ?? root).add(node_apex_volume_8);
  nodes["apex-volume"] = node_apex_volume_8;
  const mesh_apex_volume_8Geometry = endpoint_apex_volume_8
    ? new THREE.CylinderGeometry(endpoint_apex_volume_8.endRadius, endpoint_apex_volume_8.baseRadius, endpoint_apex_volume_8.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.5, 0.0], "rx": 0.35, "rz": 0.3}, {"position": [0.0, 0.15, 0.0], "rx": 0.52, "rz": 0.42}, {"position": [0.0, 0.55, 0.0], "rx": 0.08, "rz": 0.07}], "radialSegments": 18, "capEnds": true});
  if (!endpoint_apex_volume_8) {
    mesh_apex_volume_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_apex_volume_8 = new THREE.Mesh(
    mesh_apex_volume_8Geometry,
    materialMap["myocardium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_apex_volume_8.name = "Inferior tapered apex";
  if (endpoint_apex_volume_8) {
    mesh_apex_volume_8.position.copy(endpoint_apex_volume_8.midpoint);
    mesh_apex_volume_8.quaternion.copy(endpoint_apex_volume_8.quaternion);
  }
  mesh_apex_volume_8.castShadow = options.castShadow ?? true;
  mesh_apex_volume_8.receiveShadow = options.receiveShadow ?? true;
  mesh_apex_volume_8.userData.sculptComponent = {"id": "apex-volume", "name": "Inferior tapered apex", "level": "meso", "role": "body", "importance": 0.78, "confidence": 0.82, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named inferior tapered apex as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.0, -0.5, 0.0], "rx": 0.35, "rz": 0.3}, {"position": [0.0, 0.15, 0.0], "rx": 0.52, "rz": 0.42}, {"position": [0.0, 0.55, 0.0], "rx": 0.08, "rz": 0.07}], "radialSegments": 18, "capEnds": true}}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [-0.18, -1.25, 0.08], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "right-oblique"]}, "dimensions": {"width": 0.72, "height": 1.15, "depth": 0.68, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [-0.18, -1.25, 0.08], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "logical-alias", "logicalAliasOf": "ventricular-body", "pivot": {"mode": "delegated-parent", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": false, "materialState": false}, "sockets": [], "collider": {"type": "delegated-parent", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "apex-volume", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_apex_volume_8.add(mesh_apex_volume_8);
  meshes["apex-volume"] = mesh_apex_volume_8;
  colliders["apex-volume"] = {"type": "delegated-parent", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["apex-volume"] ??= [];
  destructionGroups["apex-volume"].push(node_apex_volume_8);

  const endpoint_atrioventricular_groove_9 = makeAttachmentEndpoint(null);
  const node_atrioventricular_groove_9 = new THREE.Group();
  node_atrioventricular_groove_9.name = "Atrioventricular groove relief__pivot";
  node_atrioventricular_groove_9.scale.set(1, 1, 1);
  if (endpoint_atrioventricular_groove_9) {
    node_atrioventricular_groove_9.position.copy(endpoint_atrioventricular_groove_9.start);
    node_atrioventricular_groove_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_atrioventricular_groove_9.position.set(0.0, 0.48, 0.05);
    node_atrioventricular_groove_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_atrioventricular_groove_9.userData.sculptComponent = {"id": "atrioventricular-groove", "name": "Atrioventricular groove relief", "level": "meso", "role": "surface-relief", "importance": 0.78, "confidence": 0.82, "primitive": "torus", "topologyClass": "surface-relief", "topologyRationale": "Multi-view evidence requires the named atrioventricular groove relief as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.48, 0.05], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior"]}, "dimensions": {"width": 1.55, "height": 0.18, "depth": 1.25, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.48, 0.05], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "logical-alias", "logicalAliasOf": "coronary-network", "pivot": {"mode": "delegated-parent", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": false, "materialState": false}, "sockets": [], "collider": {"type": "delegated-parent", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "atrioventricular-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "posterior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "posterior"], "details": [], "fidelityTier": "hero"};
  node_atrioventricular_groove_9.userData.actionProfile = {"animationRole": "logical-alias", "logicalAliasOf": "coronary-network", "pivot": {"mode": "delegated-parent", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": false, "materialState": false}, "sockets": [], "collider": {"type": "delegated-parent", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "atrioventricular-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["ventricular-body"] ?? root).add(node_atrioventricular_groove_9);
  nodes["atrioventricular-groove"] = node_atrioventricular_groove_9;
  const mesh_atrioventricular_groove_9Geometry = endpoint_atrioventricular_groove_9
    ? new THREE.CylinderGeometry(endpoint_atrioventricular_groove_9.endRadius, endpoint_atrioventricular_groove_9.baseRadius, endpoint_atrioventricular_groove_9.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.08, 24, 96);
  if (!endpoint_atrioventricular_groove_9) {
    mesh_atrioventricular_groove_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_atrioventricular_groove_9 = new THREE.Mesh(
    mesh_atrioventricular_groove_9Geometry,
    materialMap["myocardium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_atrioventricular_groove_9.name = "Atrioventricular groove relief";
  if (endpoint_atrioventricular_groove_9) {
    mesh_atrioventricular_groove_9.position.copy(endpoint_atrioventricular_groove_9.midpoint);
    mesh_atrioventricular_groove_9.quaternion.copy(endpoint_atrioventricular_groove_9.quaternion);
  }
  mesh_atrioventricular_groove_9.castShadow = options.castShadow ?? true;
  mesh_atrioventricular_groove_9.receiveShadow = options.receiveShadow ?? true;
  mesh_atrioventricular_groove_9.userData.sculptComponent = {"id": "atrioventricular-groove", "name": "Atrioventricular groove relief", "level": "meso", "role": "surface-relief", "importance": 0.78, "confidence": 0.82, "primitive": "torus", "topologyClass": "surface-relief", "topologyRationale": "Multi-view evidence requires the named atrioventricular groove relief as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.48, 0.05], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior"]}, "dimensions": {"width": 1.55, "height": 0.18, "depth": 1.25, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.48, 0.05], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "logical-alias", "logicalAliasOf": "coronary-network", "pivot": {"mode": "delegated-parent", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": false, "materialState": false}, "sockets": [], "collider": {"type": "delegated-parent", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "atrioventricular-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "posterior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "posterior"], "details": [], "fidelityTier": "hero"};
  node_atrioventricular_groove_9.add(mesh_atrioventricular_groove_9);
  meshes["atrioventricular-groove"] = mesh_atrioventricular_groove_9;
  colliders["atrioventricular-groove"] = {"type": "delegated-parent", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["atrioventricular-groove"] ??= [];
  destructionGroups["atrioventricular-groove"].push(node_atrioventricular_groove_9);

  const attachment_anterior_interventricular_groove_10 = {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.03, 0.48, 0.7], "localEnd": [-0.18, -1.34, 0.16], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior"]};
  const endpoint_anterior_interventricular_groove_10 = makeAttachmentEndpoint(attachment_anterior_interventricular_groove_10);
  const node_anterior_interventricular_groove_10 = new THREE.Group();
  node_anterior_interventricular_groove_10.name = "Anterior interventricular groove__pivot";
  node_anterior_interventricular_groove_10.scale.set(1, 1, 1);
  if (endpoint_anterior_interventricular_groove_10) {
    node_anterior_interventricular_groove_10.position.copy(endpoint_anterior_interventricular_groove_10.start);
    node_anterior_interventricular_groove_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_anterior_interventricular_groove_10.position.set(0.0, 0.0, 0.0);
    node_anterior_interventricular_groove_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_anterior_interventricular_groove_10.userData.sculptComponent = {"id": "anterior-interventricular-groove", "name": "Anterior interventricular groove", "level": "meso", "role": "surface-relief", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "Multi-view evidence requires the named anterior interventricular groove as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.03, 0.48, 0.7], [0.02, -0.1, 0.78], [-0.08, -0.78, 0.55], [-0.18, -1.34, 0.16]], "radius": 0.025, "radialSegments": 8, "closed": false}}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.03, 0.48, 0.7], "localEnd": [-0.18, -1.34, 0.16], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "logical-alias", "logicalAliasOf": "coronary-network", "pivot": {"mode": "delegated-parent", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": false, "materialState": false}, "sockets": [], "collider": {"type": "delegated-parent", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "anterior-interventricular-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior"], "details": [], "fidelityTier": "hero"};
  node_anterior_interventricular_groove_10.userData.actionProfile = {"animationRole": "logical-alias", "logicalAliasOf": "coronary-network", "pivot": {"mode": "delegated-parent", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": false, "materialState": false}, "sockets": [], "collider": {"type": "delegated-parent", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "anterior-interventricular-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["ventricular-body"] ?? root).add(node_anterior_interventricular_groove_10);
  nodes["anterior-interventricular-groove"] = node_anterior_interventricular_groove_10;
  const mesh_anterior_interventricular_groove_10Geometry = endpoint_anterior_interventricular_groove_10
    ? new THREE.CylinderGeometry(endpoint_anterior_interventricular_groove_10.endRadius, endpoint_anterior_interventricular_groove_10.baseRadius, endpoint_anterior_interventricular_groove_10.length, 32, 12)
    : buildTubeGeometry({"points": [[0.03, 0.48, 0.7], [0.02, -0.1, 0.78], [-0.08, -0.78, 0.55], [-0.18, -1.34, 0.16]], "radius": 0.025, "radialSegments": 8, "closed": false});
  if (!endpoint_anterior_interventricular_groove_10) {
    mesh_anterior_interventricular_groove_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_anterior_interventricular_groove_10 = new THREE.Mesh(
    mesh_anterior_interventricular_groove_10Geometry,
    materialMap["myocardium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_anterior_interventricular_groove_10.name = "Anterior interventricular groove";
  if (endpoint_anterior_interventricular_groove_10) {
    mesh_anterior_interventricular_groove_10.position.copy(endpoint_anterior_interventricular_groove_10.midpoint);
    mesh_anterior_interventricular_groove_10.quaternion.copy(endpoint_anterior_interventricular_groove_10.quaternion);
  }
  mesh_anterior_interventricular_groove_10.castShadow = options.castShadow ?? true;
  mesh_anterior_interventricular_groove_10.receiveShadow = options.receiveShadow ?? true;
  mesh_anterior_interventricular_groove_10.userData.sculptComponent = {"id": "anterior-interventricular-groove", "name": "Anterior interventricular groove", "level": "meso", "role": "surface-relief", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "Multi-view evidence requires the named anterior interventricular groove as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.03, 0.48, 0.7], [0.02, -0.1, 0.78], [-0.08, -0.78, 0.55], [-0.18, -1.34, 0.16]], "radius": 0.025, "radialSegments": 8, "closed": false}}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.03, 0.48, 0.7], "localEnd": [-0.18, -1.34, 0.16], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "logical-alias", "logicalAliasOf": "coronary-network", "pivot": {"mode": "delegated-parent", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": false, "visibility": false, "materialState": false}, "sockets": [], "collider": {"type": "delegated-parent", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "anterior-interventricular-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior"], "details": [], "fidelityTier": "hero"};
  node_anterior_interventricular_groove_10.add(mesh_anterior_interventricular_groove_10);
  meshes["anterior-interventricular-groove"] = mesh_anterior_interventricular_groove_10;
  colliders["anterior-interventricular-groove"] = {"type": "delegated-parent", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["anterior-interventricular-groove"] ??= [];
  destructionGroups["anterior-interventricular-groove"].push(node_anterior_interventricular_groove_10);

  const endpoint_left_atrium_11 = makeAttachmentEndpoint(null);
  const node_left_atrium_11 = new THREE.Group();
  node_left_atrium_11.name = "Left atrial mass__pivot";
  node_left_atrium_11.scale.set(1, 1, 1);
  if (endpoint_left_atrium_11) {
    node_left_atrium_11.position.copy(endpoint_left_atrium_11.start);
    node_left_atrium_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_left_atrium_11.position.set(0.42, 0.83, -0.18);
    node_left_atrium_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_left_atrium_11.userData.sculptComponent = {"id": "left-atrium", "name": "Left atrial mass", "level": "meso", "role": "body", "importance": 0.78, "confidence": 0.82, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named left atrial mass as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "atrial-complex", "attachment": {"parentId": "atrial-complex", "parentSocket": "atrial-complex-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.42, 0.83, -0.18], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["posterior", "right-oblique"]}, "dimensions": {"width": 0.78, "height": 0.72, "depth": 0.78, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.42, 0.83, -0.18], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-atrium-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-atrium", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["posterior", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["posterior", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_left_atrium_11.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-atrium-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-atrium", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["atrial-complex"] ?? root).add(node_left_atrium_11);
  nodes["left-atrium"] = node_left_atrium_11;
  const mesh_left_atrium_11Geometry = endpoint_left_atrium_11
    ? new THREE.CylinderGeometry(endpoint_left_atrium_11.endRadius, endpoint_left_atrium_11.baseRadius, endpoint_left_atrium_11.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_left_atrium_11) {
    mesh_left_atrium_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_left_atrium_11 = new THREE.Mesh(
    mesh_left_atrium_11Geometry,
    materialMap["myocardium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_left_atrium_11.name = "Left atrial mass";
  if (endpoint_left_atrium_11) {
    mesh_left_atrium_11.position.copy(endpoint_left_atrium_11.midpoint);
    mesh_left_atrium_11.quaternion.copy(endpoint_left_atrium_11.quaternion);
  }
  mesh_left_atrium_11.castShadow = options.castShadow ?? true;
  mesh_left_atrium_11.receiveShadow = options.receiveShadow ?? true;
  mesh_left_atrium_11.userData.sculptComponent = {"id": "left-atrium", "name": "Left atrial mass", "level": "meso", "role": "body", "importance": 0.78, "confidence": 0.82, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named left atrial mass as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "atrial-complex", "attachment": {"parentId": "atrial-complex", "parentSocket": "atrial-complex-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.42, 0.83, -0.18], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["posterior", "right-oblique"]}, "dimensions": {"width": 0.78, "height": 0.72, "depth": 0.78, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.42, 0.83, -0.18], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-atrium-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-atrium", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["posterior", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["posterior", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_left_atrium_11.add(mesh_left_atrium_11);
  meshes["left-atrium"] = mesh_left_atrium_11;
  colliders["left-atrium"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["left-atrium"] ??= [];
  destructionGroups["left-atrium"].push(node_left_atrium_11);
  const socket_left_atrium_left_atrium_surface_0 = new THREE.Object3D();
  socket_left_atrium_left_atrium_surface_0.name = "left-atrium-surface";
  socket_left_atrium_left_atrium_surface_0.position.set(0.0, 0.0, 0.0);
  socket_left_atrium_left_atrium_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_left_atrium_left_atrium_surface_0.userData.socket = {"id": "left-atrium-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_left_atrium_11.add(socket_left_atrium_left_atrium_surface_0);
  sockets["left-atrium:left-atrium-surface"] = socket_left_atrium_left_atrium_surface_0;

  const endpoint_right_atrium_12 = makeAttachmentEndpoint(null);
  const node_right_atrium_12 = new THREE.Group();
  node_right_atrium_12.name = "Right atrial mass__pivot";
  node_right_atrium_12.scale.set(1, 1, 1);
  if (endpoint_right_atrium_12) {
    node_right_atrium_12.position.copy(endpoint_right_atrium_12.start);
    node_right_atrium_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_right_atrium_12.position.set(-0.42, 0.78, -0.06);
    node_right_atrium_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_right_atrium_12.userData.sculptComponent = {"id": "right-atrium", "name": "Right atrial mass", "level": "meso", "role": "body", "importance": 0.78, "confidence": 0.82, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named right atrial mass as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "atrial-complex", "attachment": {"parentId": "atrial-complex", "parentSocket": "atrial-complex-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [-0.42, 0.78, -0.06], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique"]}, "dimensions": {"width": 0.9, "height": 0.82, "depth": 0.82, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [-0.42, 0.78, -0.06], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-atrium-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-atrium", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique"], "details": [], "fidelityTier": "hero"};
  node_right_atrium_12.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-atrium-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-atrium", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["atrial-complex"] ?? root).add(node_right_atrium_12);
  nodes["right-atrium"] = node_right_atrium_12;
  const mesh_right_atrium_12Geometry = endpoint_right_atrium_12
    ? new THREE.CylinderGeometry(endpoint_right_atrium_12.endRadius, endpoint_right_atrium_12.baseRadius, endpoint_right_atrium_12.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_right_atrium_12) {
    mesh_right_atrium_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_right_atrium_12 = new THREE.Mesh(
    mesh_right_atrium_12Geometry,
    materialMap["myocardium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_right_atrium_12.name = "Right atrial mass";
  if (endpoint_right_atrium_12) {
    mesh_right_atrium_12.position.copy(endpoint_right_atrium_12.midpoint);
    mesh_right_atrium_12.quaternion.copy(endpoint_right_atrium_12.quaternion);
  }
  mesh_right_atrium_12.castShadow = options.castShadow ?? true;
  mesh_right_atrium_12.receiveShadow = options.receiveShadow ?? true;
  mesh_right_atrium_12.userData.sculptComponent = {"id": "right-atrium", "name": "Right atrial mass", "level": "meso", "role": "body", "importance": 0.78, "confidence": 0.82, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named right atrial mass as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "atrial-complex", "attachment": {"parentId": "atrial-complex", "parentSocket": "atrial-complex-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [-0.42, 0.78, -0.06], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique"]}, "dimensions": {"width": 0.9, "height": 0.82, "depth": 0.82, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [-0.42, 0.78, -0.06], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-atrium-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-atrium", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique"], "details": [], "fidelityTier": "hero"};
  node_right_atrium_12.add(mesh_right_atrium_12);
  meshes["right-atrium"] = mesh_right_atrium_12;
  colliders["right-atrium"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["right-atrium"] ??= [];
  destructionGroups["right-atrium"].push(node_right_atrium_12);
  const socket_right_atrium_right_atrium_surface_0 = new THREE.Object3D();
  socket_right_atrium_right_atrium_surface_0.name = "right-atrium-surface";
  socket_right_atrium_right_atrium_surface_0.position.set(0.0, 0.0, 0.0);
  socket_right_atrium_right_atrium_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_right_atrium_right_atrium_surface_0.userData.socket = {"id": "right-atrium-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_right_atrium_12.add(socket_right_atrium_right_atrium_surface_0);
  sockets["right-atrium:right-atrium-surface"] = socket_right_atrium_right_atrium_surface_0;

  const endpoint_left_auricle_13 = makeAttachmentEndpoint(null);
  const node_left_auricle_13 = new THREE.Group();
  node_left_auricle_13.name = "Left auricular appendage__pivot";
  node_left_auricle_13.scale.set(1, 1, 1);
  if (endpoint_left_auricle_13) {
    node_left_auricle_13.position.copy(endpoint_left_auricle_13.start);
    node_left_auricle_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_left_auricle_13.position.set(0.62, 0.78, 0.34);
    node_left_auricle_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_left_auricle_13.userData.sculptComponent = {"id": "left-auricle", "name": "Left auricular appendage", "level": "meso", "role": "body", "importance": 0.78, "confidence": 0.82, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named left auricular appendage as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "atrial-complex", "attachment": {"parentId": "atrial-complex", "parentSocket": "atrial-complex-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.62, 0.78, 0.34], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "right-oblique"]}, "dimensions": {"width": 0.58, "height": 0.55, "depth": 0.52, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.62, 0.78, 0.34], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-auricle-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-auricle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_left_auricle_13.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-auricle-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-auricle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["atrial-complex"] ?? root).add(node_left_auricle_13);
  nodes["left-auricle"] = node_left_auricle_13;
  const mesh_left_auricle_13Geometry = endpoint_left_auricle_13
    ? new THREE.CylinderGeometry(endpoint_left_auricle_13.endRadius, endpoint_left_auricle_13.baseRadius, endpoint_left_auricle_13.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_left_auricle_13) {
    mesh_left_auricle_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_left_auricle_13 = new THREE.Mesh(
    mesh_left_auricle_13Geometry,
    materialMap["myocardium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_left_auricle_13.name = "Left auricular appendage";
  if (endpoint_left_auricle_13) {
    mesh_left_auricle_13.position.copy(endpoint_left_auricle_13.midpoint);
    mesh_left_auricle_13.quaternion.copy(endpoint_left_auricle_13.quaternion);
  }
  mesh_left_auricle_13.castShadow = options.castShadow ?? true;
  mesh_left_auricle_13.receiveShadow = options.receiveShadow ?? true;
  mesh_left_auricle_13.userData.sculptComponent = {"id": "left-auricle", "name": "Left auricular appendage", "level": "meso", "role": "body", "importance": 0.78, "confidence": 0.82, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named left auricular appendage as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "atrial-complex", "attachment": {"parentId": "atrial-complex", "parentSocket": "atrial-complex-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.62, 0.78, 0.34], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "right-oblique"]}, "dimensions": {"width": 0.58, "height": 0.55, "depth": 0.52, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.62, 0.78, 0.34], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-auricle-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-auricle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_left_auricle_13.add(mesh_left_auricle_13);
  meshes["left-auricle"] = mesh_left_auricle_13;
  colliders["left-auricle"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["left-auricle"] ??= [];
  destructionGroups["left-auricle"].push(node_left_auricle_13);
  const socket_left_auricle_left_auricle_surface_0 = new THREE.Object3D();
  socket_left_auricle_left_auricle_surface_0.name = "left-auricle-surface";
  socket_left_auricle_left_auricle_surface_0.position.set(0.0, 0.0, 0.0);
  socket_left_auricle_left_auricle_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_left_auricle_left_auricle_surface_0.userData.socket = {"id": "left-auricle-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_left_auricle_13.add(socket_left_auricle_left_auricle_surface_0);
  sockets["left-auricle:left-auricle-surface"] = socket_left_auricle_left_auricle_surface_0;

  const endpoint_right_auricle_14 = makeAttachmentEndpoint(null);
  const node_right_auricle_14 = new THREE.Group();
  node_right_auricle_14.name = "Right auricular appendage__pivot";
  node_right_auricle_14.scale.set(1, 1, 1);
  if (endpoint_right_auricle_14) {
    node_right_auricle_14.position.copy(endpoint_right_auricle_14.start);
    node_right_auricle_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_right_auricle_14.position.set(-0.62, 0.72, 0.28);
    node_right_auricle_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_right_auricle_14.userData.sculptComponent = {"id": "right-auricle", "name": "Right auricular appendage", "level": "meso", "role": "body", "importance": 0.78, "confidence": 0.82, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named right auricular appendage as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "atrial-complex", "attachment": {"parentId": "atrial-complex", "parentSocket": "atrial-complex-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [-0.62, 0.72, 0.28], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique"]}, "dimensions": {"width": 0.66, "height": 0.6, "depth": 0.56, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [-0.62, 0.72, 0.28], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-auricle-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-auricle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique"], "details": [], "fidelityTier": "hero"};
  node_right_auricle_14.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-auricle-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-auricle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["atrial-complex"] ?? root).add(node_right_auricle_14);
  nodes["right-auricle"] = node_right_auricle_14;
  const mesh_right_auricle_14Geometry = endpoint_right_auricle_14
    ? new THREE.CylinderGeometry(endpoint_right_auricle_14.endRadius, endpoint_right_auricle_14.baseRadius, endpoint_right_auricle_14.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_right_auricle_14) {
    mesh_right_auricle_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_right_auricle_14 = new THREE.Mesh(
    mesh_right_auricle_14Geometry,
    materialMap["myocardium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_right_auricle_14.name = "Right auricular appendage";
  if (endpoint_right_auricle_14) {
    mesh_right_auricle_14.position.copy(endpoint_right_auricle_14.midpoint);
    mesh_right_auricle_14.quaternion.copy(endpoint_right_auricle_14.quaternion);
  }
  mesh_right_auricle_14.castShadow = options.castShadow ?? true;
  mesh_right_auricle_14.receiveShadow = options.receiveShadow ?? true;
  mesh_right_auricle_14.userData.sculptComponent = {"id": "right-auricle", "name": "Right auricular appendage", "level": "meso", "role": "body", "importance": 0.78, "confidence": 0.82, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named right auricular appendage as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "atrial-complex", "attachment": {"parentId": "atrial-complex", "parentSocket": "atrial-complex-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [-0.62, 0.72, 0.28], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique"]}, "dimensions": {"width": 0.66, "height": 0.6, "depth": 0.56, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [-0.62, 0.72, 0.28], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-auricle-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-auricle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique"], "details": [], "fidelityTier": "hero"};
  node_right_auricle_14.add(mesh_right_auricle_14);
  meshes["right-auricle"] = mesh_right_auricle_14;
  colliders["right-auricle"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["right-auricle"] ??= [];
  destructionGroups["right-auricle"].push(node_right_auricle_14);
  const socket_right_auricle_right_auricle_surface_0 = new THREE.Object3D();
  socket_right_auricle_right_auricle_surface_0.name = "right-auricle-surface";
  socket_right_auricle_right_auricle_surface_0.position.set(0.0, 0.0, 0.0);
  socket_right_auricle_right_auricle_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_right_auricle_right_auricle_surface_0.userData.socket = {"id": "right-auricle-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_right_auricle_14.add(socket_right_auricle_right_auricle_surface_0);
  sockets["right-auricle:right-auricle-surface"] = socket_right_auricle_right_auricle_surface_0;

  const attachment_aortic_root_15 = {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [-0.12, 0.55, 0.02], "localEnd": [-0.08, 1.24, -0.02], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "superior"]};
  const endpoint_aortic_root_15 = makeAttachmentEndpoint(attachment_aortic_root_15);
  const node_aortic_root_15 = new THREE.Group();
  node_aortic_root_15.name = "Aortic root__pivot";
  node_aortic_root_15.scale.set(1, 1, 1);
  if (endpoint_aortic_root_15) {
    node_aortic_root_15.position.copy(endpoint_aortic_root_15.start);
    node_aortic_root_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_aortic_root_15.position.set(0.0, 0.0, 0.0);
    node_aortic_root_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_aortic_root_15.userData.sculptComponent = {"id": "aortic-root", "name": "Aortic root", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named aortic root as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.12, 0.55, 0.02], [-0.12, 0.95, 0.02], [-0.08, 1.24, -0.02]], "radius": 0.26, "radialSegments": 12, "closed": false}}, "parent": "aortic-system", "attachment": {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [-0.12, 0.55, 0.02], "localEnd": [-0.08, 1.24, -0.02], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "aortic-root-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 74, 73, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["anterior", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "superior"], "details": [], "fidelityTier": "hero"};
  node_aortic_root_15.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "aortic-root-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["aortic-system"] ?? root).add(node_aortic_root_15);
  nodes["aortic-root"] = node_aortic_root_15;
  const mesh_aortic_root_15Geometry = endpoint_aortic_root_15
    ? new THREE.CylinderGeometry(endpoint_aortic_root_15.endRadius, endpoint_aortic_root_15.baseRadius, endpoint_aortic_root_15.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.12, 0.55, 0.02], [-0.12, 0.95, 0.02], [-0.08, 1.24, -0.02]], "radius": 0.26, "radialSegments": 12, "closed": false});
  if (!endpoint_aortic_root_15) {
    mesh_aortic_root_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_aortic_root_15 = new THREE.Mesh(
    mesh_aortic_root_15Geometry,
    materialMap["arterial"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_aortic_root_15.name = "Aortic root";
  if (endpoint_aortic_root_15) {
    mesh_aortic_root_15.position.copy(endpoint_aortic_root_15.midpoint);
    mesh_aortic_root_15.quaternion.copy(endpoint_aortic_root_15.quaternion);
  }
  mesh_aortic_root_15.castShadow = options.castShadow ?? true;
  mesh_aortic_root_15.receiveShadow = options.receiveShadow ?? true;
  mesh_aortic_root_15.userData.sculptComponent = {"id": "aortic-root", "name": "Aortic root", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named aortic root as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.12, 0.55, 0.02], [-0.12, 0.95, 0.02], [-0.08, 1.24, -0.02]], "radius": 0.26, "radialSegments": 12, "closed": false}}, "parent": "aortic-system", "attachment": {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [-0.12, 0.55, 0.02], "localEnd": [-0.08, 1.24, -0.02], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "aortic-root-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 74, 73, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["anterior", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "superior"], "details": [], "fidelityTier": "hero"};
  node_aortic_root_15.add(mesh_aortic_root_15);
  meshes["aortic-root"] = mesh_aortic_root_15;
  colliders["aortic-root"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["aortic-root"] ??= [];
  destructionGroups["aortic-root"].push(node_aortic_root_15);
  const socket_aortic_root_aortic_root_surface_0 = new THREE.Object3D();
  socket_aortic_root_aortic_root_surface_0.name = "aortic-root-surface";
  socket_aortic_root_aortic_root_surface_0.position.set(0.0, 0.0, 0.0);
  socket_aortic_root_aortic_root_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_aortic_root_aortic_root_surface_0.userData.socket = {"id": "aortic-root-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_aortic_root_15.add(socket_aortic_root_aortic_root_surface_0);
  sockets["aortic-root:aortic-root-surface"] = socket_aortic_root_aortic_root_surface_0;

  const attachment_ascending_aorta_16 = {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [-0.08, 1.08, -0.02], "localEnd": [0.02, 1.72, -0.18], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior"]};
  const endpoint_ascending_aorta_16 = makeAttachmentEndpoint(attachment_ascending_aorta_16);
  const node_ascending_aorta_16 = new THREE.Group();
  node_ascending_aorta_16.name = "Ascending aorta__pivot";
  node_ascending_aorta_16.scale.set(1, 1, 1);
  if (endpoint_ascending_aorta_16) {
    node_ascending_aorta_16.position.copy(endpoint_ascending_aorta_16.start);
    node_ascending_aorta_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ascending_aorta_16.position.set(0.0, 0.0, 0.0);
    node_ascending_aorta_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_ascending_aorta_16.userData.sculptComponent = {"id": "ascending-aorta", "name": "Ascending aorta", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named ascending aorta as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.08, 1.08, -0.02], [-0.08, 1.48, -0.08], [0.02, 1.72, -0.18]], "radius": 0.25, "radialSegments": 12, "closed": false}}, "parent": "aortic-system", "attachment": {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [-0.08, 1.08, -0.02], "localEnd": [0.02, 1.72, -0.18], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "ascending-aorta-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ascending-aorta", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 74, 73, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["anterior", "posterior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "posterior"], "details": [], "fidelityTier": "hero"};
  node_ascending_aorta_16.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "ascending-aorta-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ascending-aorta", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["aortic-system"] ?? root).add(node_ascending_aorta_16);
  nodes["ascending-aorta"] = node_ascending_aorta_16;
  const mesh_ascending_aorta_16Geometry = endpoint_ascending_aorta_16
    ? new THREE.CylinderGeometry(endpoint_ascending_aorta_16.endRadius, endpoint_ascending_aorta_16.baseRadius, endpoint_ascending_aorta_16.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.08, 1.08, -0.02], [-0.08, 1.48, -0.08], [0.02, 1.72, -0.18]], "radius": 0.25, "radialSegments": 12, "closed": false});
  if (!endpoint_ascending_aorta_16) {
    mesh_ascending_aorta_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_ascending_aorta_16 = new THREE.Mesh(
    mesh_ascending_aorta_16Geometry,
    materialMap["arterial"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ascending_aorta_16.name = "Ascending aorta";
  if (endpoint_ascending_aorta_16) {
    mesh_ascending_aorta_16.position.copy(endpoint_ascending_aorta_16.midpoint);
    mesh_ascending_aorta_16.quaternion.copy(endpoint_ascending_aorta_16.quaternion);
  }
  mesh_ascending_aorta_16.castShadow = options.castShadow ?? true;
  mesh_ascending_aorta_16.receiveShadow = options.receiveShadow ?? true;
  mesh_ascending_aorta_16.userData.sculptComponent = {"id": "ascending-aorta", "name": "Ascending aorta", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named ascending aorta as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.08, 1.08, -0.02], [-0.08, 1.48, -0.08], [0.02, 1.72, -0.18]], "radius": 0.25, "radialSegments": 12, "closed": false}}, "parent": "aortic-system", "attachment": {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [-0.08, 1.08, -0.02], "localEnd": [0.02, 1.72, -0.18], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "ascending-aorta-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ascending-aorta", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 74, 73, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["anterior", "posterior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "posterior"], "details": [], "fidelityTier": "hero"};
  node_ascending_aorta_16.add(mesh_ascending_aorta_16);
  meshes["ascending-aorta"] = mesh_ascending_aorta_16;
  colliders["ascending-aorta"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["ascending-aorta"] ??= [];
  destructionGroups["ascending-aorta"].push(node_ascending_aorta_16);
  const socket_ascending_aorta_ascending_aorta_surface_0 = new THREE.Object3D();
  socket_ascending_aorta_ascending_aorta_surface_0.name = "ascending-aorta-surface";
  socket_ascending_aorta_ascending_aorta_surface_0.position.set(0.0, 0.0, 0.0);
  socket_ascending_aorta_ascending_aorta_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_ascending_aorta_ascending_aorta_surface_0.userData.socket = {"id": "ascending-aorta-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_ascending_aorta_16.add(socket_ascending_aorta_ascending_aorta_surface_0);
  sockets["ascending-aorta:ascending-aorta-surface"] = socket_ascending_aorta_ascending_aorta_surface_0;

  const attachment_aortic_arch_17 = {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [0.0, 1.68, -0.14], "localEnd": [0.68, 1.28, -0.62], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior", "superior"]};
  const endpoint_aortic_arch_17 = makeAttachmentEndpoint(attachment_aortic_arch_17);
  const node_aortic_arch_17 = new THREE.Group();
  node_aortic_arch_17.name = "Aortic arch__pivot";
  node_aortic_arch_17.scale.set(1, 1, 1);
  if (endpoint_aortic_arch_17) {
    node_aortic_arch_17.position.copy(endpoint_aortic_arch_17.start);
    node_aortic_arch_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_aortic_arch_17.position.set(0.0, 0.0, 0.0);
    node_aortic_arch_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_aortic_arch_17.userData.sculptComponent = {"id": "aortic-arch", "name": "Aortic arch", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named aortic arch as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.0, 1.68, -0.14], [0.3, 1.82, -0.32], [0.62, 1.65, -0.54], [0.68, 1.28, -0.62]], "radius": 0.24, "radialSegments": 12, "closed": false}}, "parent": "aortic-system", "attachment": {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [0.0, 1.68, -0.14], "localEnd": [0.68, 1.28, -0.62], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "aortic-arch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-arch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 74, 73, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["anterior", "posterior", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "posterior", "superior"], "details": [], "fidelityTier": "hero"};
  node_aortic_arch_17.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "aortic-arch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-arch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["aortic-system"] ?? root).add(node_aortic_arch_17);
  nodes["aortic-arch"] = node_aortic_arch_17;
  const mesh_aortic_arch_17Geometry = endpoint_aortic_arch_17
    ? new THREE.CylinderGeometry(endpoint_aortic_arch_17.endRadius, endpoint_aortic_arch_17.baseRadius, endpoint_aortic_arch_17.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, 1.68, -0.14], [0.3, 1.82, -0.32], [0.62, 1.65, -0.54], [0.68, 1.28, -0.62]], "radius": 0.24, "radialSegments": 12, "closed": false});
  if (!endpoint_aortic_arch_17) {
    mesh_aortic_arch_17Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_aortic_arch_17 = new THREE.Mesh(
    mesh_aortic_arch_17Geometry,
    materialMap["arterial"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_aortic_arch_17.name = "Aortic arch";
  if (endpoint_aortic_arch_17) {
    mesh_aortic_arch_17.position.copy(endpoint_aortic_arch_17.midpoint);
    mesh_aortic_arch_17.quaternion.copy(endpoint_aortic_arch_17.quaternion);
  }
  mesh_aortic_arch_17.castShadow = options.castShadow ?? true;
  mesh_aortic_arch_17.receiveShadow = options.receiveShadow ?? true;
  mesh_aortic_arch_17.userData.sculptComponent = {"id": "aortic-arch", "name": "Aortic arch", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named aortic arch as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.0, 1.68, -0.14], [0.3, 1.82, -0.32], [0.62, 1.65, -0.54], [0.68, 1.28, -0.62]], "radius": 0.24, "radialSegments": 12, "closed": false}}, "parent": "aortic-system", "attachment": {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [0.0, 1.68, -0.14], "localEnd": [0.68, 1.28, -0.62], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "aortic-arch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-arch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 74, 73, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["anterior", "posterior", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "posterior", "superior"], "details": [], "fidelityTier": "hero"};
  node_aortic_arch_17.add(mesh_aortic_arch_17);
  meshes["aortic-arch"] = mesh_aortic_arch_17;
  colliders["aortic-arch"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["aortic-arch"] ??= [];
  destructionGroups["aortic-arch"].push(node_aortic_arch_17);
  const socket_aortic_arch_aortic_arch_surface_0 = new THREE.Object3D();
  socket_aortic_arch_aortic_arch_surface_0.name = "aortic-arch-surface";
  socket_aortic_arch_aortic_arch_surface_0.position.set(0.0, 0.0, 0.0);
  socket_aortic_arch_aortic_arch_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_aortic_arch_aortic_arch_surface_0.userData.socket = {"id": "aortic-arch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_aortic_arch_17.add(socket_aortic_arch_aortic_arch_surface_0);
  sockets["aortic-arch:aortic-arch-surface"] = socket_aortic_arch_aortic_arch_surface_0;

  const attachment_brachiocephalic_branch_18 = {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [0.05, 1.68, -0.18], "localEnd": [-0.12, 2.28, -0.1], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior", "superior"]};
  const endpoint_brachiocephalic_branch_18 = makeAttachmentEndpoint(attachment_brachiocephalic_branch_18);
  const node_brachiocephalic_branch_18 = new THREE.Group();
  node_brachiocephalic_branch_18.name = "Brachiocephalic arch branch__pivot";
  node_brachiocephalic_branch_18.scale.set(1, 1, 1);
  if (endpoint_brachiocephalic_branch_18) {
    node_brachiocephalic_branch_18.position.copy(endpoint_brachiocephalic_branch_18.start);
    node_brachiocephalic_branch_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_brachiocephalic_branch_18.position.set(0.0, 0.0, 0.0);
    node_brachiocephalic_branch_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_brachiocephalic_branch_18.userData.sculptComponent = {"id": "brachiocephalic-branch", "name": "Brachiocephalic arch branch", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named brachiocephalic arch branch as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.05, 1.68, -0.18], [-0.02, 2.05, -0.12], [-0.12, 2.28, -0.1]], "radius": 0.13, "radialSegments": 12, "closed": false}}, "parent": "aortic-system", "attachment": {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [0.05, 1.68, -0.18], "localEnd": [-0.12, 2.28, -0.1], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "brachiocephalic-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brachiocephalic-branch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 74, 73, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["anterior", "posterior", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "posterior", "superior"], "details": [], "fidelityTier": "hero"};
  node_brachiocephalic_branch_18.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "brachiocephalic-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brachiocephalic-branch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["aortic-system"] ?? root).add(node_brachiocephalic_branch_18);
  nodes["brachiocephalic-branch"] = node_brachiocephalic_branch_18;
  const mesh_brachiocephalic_branch_18Geometry = endpoint_brachiocephalic_branch_18
    ? new THREE.CylinderGeometry(endpoint_brachiocephalic_branch_18.endRadius, endpoint_brachiocephalic_branch_18.baseRadius, endpoint_brachiocephalic_branch_18.length, 32, 12)
    : buildTubeGeometry({"points": [[0.05, 1.68, -0.18], [-0.02, 2.05, -0.12], [-0.12, 2.28, -0.1]], "radius": 0.13, "radialSegments": 12, "closed": false});
  if (!endpoint_brachiocephalic_branch_18) {
    mesh_brachiocephalic_branch_18Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_brachiocephalic_branch_18 = new THREE.Mesh(
    mesh_brachiocephalic_branch_18Geometry,
    materialMap["arterial"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_brachiocephalic_branch_18.name = "Brachiocephalic arch branch";
  if (endpoint_brachiocephalic_branch_18) {
    mesh_brachiocephalic_branch_18.position.copy(endpoint_brachiocephalic_branch_18.midpoint);
    mesh_brachiocephalic_branch_18.quaternion.copy(endpoint_brachiocephalic_branch_18.quaternion);
  }
  mesh_brachiocephalic_branch_18.castShadow = options.castShadow ?? true;
  mesh_brachiocephalic_branch_18.receiveShadow = options.receiveShadow ?? true;
  mesh_brachiocephalic_branch_18.userData.sculptComponent = {"id": "brachiocephalic-branch", "name": "Brachiocephalic arch branch", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named brachiocephalic arch branch as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.05, 1.68, -0.18], [-0.02, 2.05, -0.12], [-0.12, 2.28, -0.1]], "radius": 0.13, "radialSegments": 12, "closed": false}}, "parent": "aortic-system", "attachment": {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [0.05, 1.68, -0.18], "localEnd": [-0.12, 2.28, -0.1], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "brachiocephalic-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brachiocephalic-branch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 74, 73, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["anterior", "posterior", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "posterior", "superior"], "details": [], "fidelityTier": "hero"};
  node_brachiocephalic_branch_18.add(mesh_brachiocephalic_branch_18);
  meshes["brachiocephalic-branch"] = mesh_brachiocephalic_branch_18;
  colliders["brachiocephalic-branch"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["brachiocephalic-branch"] ??= [];
  destructionGroups["brachiocephalic-branch"].push(node_brachiocephalic_branch_18);
  const socket_brachiocephalic_branch_brachiocephalic_branch_surface_0 = new THREE.Object3D();
  socket_brachiocephalic_branch_brachiocephalic_branch_surface_0.name = "brachiocephalic-branch-surface";
  socket_brachiocephalic_branch_brachiocephalic_branch_surface_0.position.set(0.0, 0.0, 0.0);
  socket_brachiocephalic_branch_brachiocephalic_branch_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_brachiocephalic_branch_brachiocephalic_branch_surface_0.userData.socket = {"id": "brachiocephalic-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_brachiocephalic_branch_18.add(socket_brachiocephalic_branch_brachiocephalic_branch_surface_0);
  sockets["brachiocephalic-branch:brachiocephalic-branch-surface"] = socket_brachiocephalic_branch_brachiocephalic_branch_surface_0;

  const attachment_left_carotid_branch_19 = {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [0.25, 1.78, -0.28], "localEnd": [0.28, 2.3, -0.22], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior", "superior"]};
  const endpoint_left_carotid_branch_19 = makeAttachmentEndpoint(attachment_left_carotid_branch_19);
  const node_left_carotid_branch_19 = new THREE.Group();
  node_left_carotid_branch_19.name = "Left carotid arch branch__pivot";
  node_left_carotid_branch_19.scale.set(1, 1, 1);
  if (endpoint_left_carotid_branch_19) {
    node_left_carotid_branch_19.position.copy(endpoint_left_carotid_branch_19.start);
    node_left_carotid_branch_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_left_carotid_branch_19.position.set(0.0, 0.0, 0.0);
    node_left_carotid_branch_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_left_carotid_branch_19.userData.sculptComponent = {"id": "left-carotid-branch", "name": "Left carotid arch branch", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named left carotid arch branch as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.25, 1.78, -0.28], [0.26, 2.08, -0.24], [0.28, 2.3, -0.22]], "radius": 0.11, "radialSegments": 12, "closed": false}}, "parent": "aortic-system", "attachment": {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [0.25, 1.78, -0.28], "localEnd": [0.28, 2.3, -0.22], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-carotid-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-carotid-branch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 74, 73, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["anterior", "posterior", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "posterior", "superior"], "details": [], "fidelityTier": "hero"};
  node_left_carotid_branch_19.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-carotid-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-carotid-branch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["aortic-system"] ?? root).add(node_left_carotid_branch_19);
  nodes["left-carotid-branch"] = node_left_carotid_branch_19;
  const mesh_left_carotid_branch_19Geometry = endpoint_left_carotid_branch_19
    ? new THREE.CylinderGeometry(endpoint_left_carotid_branch_19.endRadius, endpoint_left_carotid_branch_19.baseRadius, endpoint_left_carotid_branch_19.length, 32, 12)
    : buildTubeGeometry({"points": [[0.25, 1.78, -0.28], [0.26, 2.08, -0.24], [0.28, 2.3, -0.22]], "radius": 0.11, "radialSegments": 12, "closed": false});
  if (!endpoint_left_carotid_branch_19) {
    mesh_left_carotid_branch_19Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_left_carotid_branch_19 = new THREE.Mesh(
    mesh_left_carotid_branch_19Geometry,
    materialMap["arterial"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_left_carotid_branch_19.name = "Left carotid arch branch";
  if (endpoint_left_carotid_branch_19) {
    mesh_left_carotid_branch_19.position.copy(endpoint_left_carotid_branch_19.midpoint);
    mesh_left_carotid_branch_19.quaternion.copy(endpoint_left_carotid_branch_19.quaternion);
  }
  mesh_left_carotid_branch_19.castShadow = options.castShadow ?? true;
  mesh_left_carotid_branch_19.receiveShadow = options.receiveShadow ?? true;
  mesh_left_carotid_branch_19.userData.sculptComponent = {"id": "left-carotid-branch", "name": "Left carotid arch branch", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named left carotid arch branch as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.25, 1.78, -0.28], [0.26, 2.08, -0.24], [0.28, 2.3, -0.22]], "radius": 0.11, "radialSegments": 12, "closed": false}}, "parent": "aortic-system", "attachment": {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [0.25, 1.78, -0.28], "localEnd": [0.28, 2.3, -0.22], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-carotid-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-carotid-branch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 74, 73, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["anterior", "posterior", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "posterior", "superior"], "details": [], "fidelityTier": "hero"};
  node_left_carotid_branch_19.add(mesh_left_carotid_branch_19);
  meshes["left-carotid-branch"] = mesh_left_carotid_branch_19;
  colliders["left-carotid-branch"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["left-carotid-branch"] ??= [];
  destructionGroups["left-carotid-branch"].push(node_left_carotid_branch_19);
  const socket_left_carotid_branch_left_carotid_branch_surface_0 = new THREE.Object3D();
  socket_left_carotid_branch_left_carotid_branch_surface_0.name = "left-carotid-branch-surface";
  socket_left_carotid_branch_left_carotid_branch_surface_0.position.set(0.0, 0.0, 0.0);
  socket_left_carotid_branch_left_carotid_branch_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_left_carotid_branch_left_carotid_branch_surface_0.userData.socket = {"id": "left-carotid-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_left_carotid_branch_19.add(socket_left_carotid_branch_left_carotid_branch_surface_0);
  sockets["left-carotid-branch:left-carotid-branch-surface"] = socket_left_carotid_branch_left_carotid_branch_surface_0;

  const attachment_left_subclavian_branch_20 = {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [0.47, 1.7, -0.43], "localEnd": [0.68, 2.18, -0.42], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior", "superior"]};
  const endpoint_left_subclavian_branch_20 = makeAttachmentEndpoint(attachment_left_subclavian_branch_20);
  const node_left_subclavian_branch_20 = new THREE.Group();
  node_left_subclavian_branch_20.name = "Left subclavian arch branch__pivot";
  node_left_subclavian_branch_20.scale.set(1, 1, 1);
  if (endpoint_left_subclavian_branch_20) {
    node_left_subclavian_branch_20.position.copy(endpoint_left_subclavian_branch_20.start);
    node_left_subclavian_branch_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_left_subclavian_branch_20.position.set(0.0, 0.0, 0.0);
    node_left_subclavian_branch_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_left_subclavian_branch_20.userData.sculptComponent = {"id": "left-subclavian-branch", "name": "Left subclavian arch branch", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named left subclavian arch branch as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.47, 1.7, -0.43], [0.56, 1.98, -0.44], [0.68, 2.18, -0.42]], "radius": 0.12, "radialSegments": 12, "closed": false}}, "parent": "aortic-system", "attachment": {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [0.47, 1.7, -0.43], "localEnd": [0.68, 2.18, -0.42], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-subclavian-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-subclavian-branch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 74, 73, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["anterior", "posterior", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "posterior", "superior"], "details": [], "fidelityTier": "hero"};
  node_left_subclavian_branch_20.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-subclavian-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-subclavian-branch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["aortic-system"] ?? root).add(node_left_subclavian_branch_20);
  nodes["left-subclavian-branch"] = node_left_subclavian_branch_20;
  const mesh_left_subclavian_branch_20Geometry = endpoint_left_subclavian_branch_20
    ? new THREE.CylinderGeometry(endpoint_left_subclavian_branch_20.endRadius, endpoint_left_subclavian_branch_20.baseRadius, endpoint_left_subclavian_branch_20.length, 32, 12)
    : buildTubeGeometry({"points": [[0.47, 1.7, -0.43], [0.56, 1.98, -0.44], [0.68, 2.18, -0.42]], "radius": 0.12, "radialSegments": 12, "closed": false});
  if (!endpoint_left_subclavian_branch_20) {
    mesh_left_subclavian_branch_20Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_left_subclavian_branch_20 = new THREE.Mesh(
    mesh_left_subclavian_branch_20Geometry,
    materialMap["arterial"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_left_subclavian_branch_20.name = "Left subclavian arch branch";
  if (endpoint_left_subclavian_branch_20) {
    mesh_left_subclavian_branch_20.position.copy(endpoint_left_subclavian_branch_20.midpoint);
    mesh_left_subclavian_branch_20.quaternion.copy(endpoint_left_subclavian_branch_20.quaternion);
  }
  mesh_left_subclavian_branch_20.castShadow = options.castShadow ?? true;
  mesh_left_subclavian_branch_20.receiveShadow = options.receiveShadow ?? true;
  mesh_left_subclavian_branch_20.userData.sculptComponent = {"id": "left-subclavian-branch", "name": "Left subclavian arch branch", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named left subclavian arch branch as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.47, 1.7, -0.43], [0.56, 1.98, -0.44], [0.68, 2.18, -0.42]], "radius": 0.12, "radialSegments": 12, "closed": false}}, "parent": "aortic-system", "attachment": {"parentId": "aortic-system", "parentSocket": "aortic-system-surface", "localStart": [0.47, 1.7, -0.43], "localEnd": [0.68, 2.18, -0.42], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "posterior", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-subclavian-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-subclavian-branch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 74, 73, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["anterior", "posterior", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "posterior", "superior"], "details": [], "fidelityTier": "hero"};
  node_left_subclavian_branch_20.add(mesh_left_subclavian_branch_20);
  meshes["left-subclavian-branch"] = mesh_left_subclavian_branch_20;
  colliders["left-subclavian-branch"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["left-subclavian-branch"] ??= [];
  destructionGroups["left-subclavian-branch"].push(node_left_subclavian_branch_20);
  const socket_left_subclavian_branch_left_subclavian_branch_surface_0 = new THREE.Object3D();
  socket_left_subclavian_branch_left_subclavian_branch_surface_0.name = "left-subclavian-branch-surface";
  socket_left_subclavian_branch_left_subclavian_branch_surface_0.position.set(0.0, 0.0, 0.0);
  socket_left_subclavian_branch_left_subclavian_branch_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_left_subclavian_branch_left_subclavian_branch_surface_0.userData.socket = {"id": "left-subclavian-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_left_subclavian_branch_20.add(socket_left_subclavian_branch_left_subclavian_branch_surface_0);
  sockets["left-subclavian-branch:left-subclavian-branch-surface"] = socket_left_subclavian_branch_left_subclavian_branch_surface_0;

  const attachment_pulmonary_trunk_21 = {"parentId": "pulmonary-venous-system", "parentSocket": "pulmonary-venous-system-surface", "localStart": [0.18, 0.5, 0.38], "localEnd": [0.23, 1.18, 0.57], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "superior"]};
  const endpoint_pulmonary_trunk_21 = makeAttachmentEndpoint(attachment_pulmonary_trunk_21);
  const node_pulmonary_trunk_21 = new THREE.Group();
  node_pulmonary_trunk_21.name = "Pulmonary trunk__pivot";
  node_pulmonary_trunk_21.scale.set(1, 1, 1);
  if (endpoint_pulmonary_trunk_21) {
    node_pulmonary_trunk_21.position.copy(endpoint_pulmonary_trunk_21.start);
    node_pulmonary_trunk_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pulmonary_trunk_21.position.set(0.0, 0.0, 0.0);
    node_pulmonary_trunk_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_pulmonary_trunk_21.userData.sculptComponent = {"id": "pulmonary-trunk", "name": "Pulmonary trunk", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named pulmonary trunk as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.18, 0.5, 0.38], [0.18, 0.92, 0.58], [0.23, 1.18, 0.57]], "radius": 0.22, "radialSegments": 12, "closed": false}}, "parent": "pulmonary-venous-system", "attachment": {"parentId": "pulmonary-venous-system", "parentSocket": "pulmonary-venous-system-surface", "localStart": [0.18, 0.5, 0.38], "localEnd": [0.23, 1.18, 0.57], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "pulmonary-trunk-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-trunk", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "venous", "materialLayers": ["venous"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(70, 23, 51, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(70, 23, 51, 1.0)"}, {"position": 1.0, "color": "rgba(116, 43, 75, 1.0)"}]}, "evidenceRefs": ["anterior", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "superior"], "details": [], "fidelityTier": "hero"};
  node_pulmonary_trunk_21.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "pulmonary-trunk-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-trunk", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["pulmonary-venous-system"] ?? root).add(node_pulmonary_trunk_21);
  nodes["pulmonary-trunk"] = node_pulmonary_trunk_21;
  const mesh_pulmonary_trunk_21Geometry = endpoint_pulmonary_trunk_21
    ? new THREE.CylinderGeometry(endpoint_pulmonary_trunk_21.endRadius, endpoint_pulmonary_trunk_21.baseRadius, endpoint_pulmonary_trunk_21.length, 32, 12)
    : buildTubeGeometry({"points": [[0.18, 0.5, 0.38], [0.18, 0.92, 0.58], [0.23, 1.18, 0.57]], "radius": 0.22, "radialSegments": 12, "closed": false});
  if (!endpoint_pulmonary_trunk_21) {
    mesh_pulmonary_trunk_21Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pulmonary_trunk_21 = new THREE.Mesh(
    mesh_pulmonary_trunk_21Geometry,
    materialMap["venous"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pulmonary_trunk_21.name = "Pulmonary trunk";
  if (endpoint_pulmonary_trunk_21) {
    mesh_pulmonary_trunk_21.position.copy(endpoint_pulmonary_trunk_21.midpoint);
    mesh_pulmonary_trunk_21.quaternion.copy(endpoint_pulmonary_trunk_21.quaternion);
  }
  mesh_pulmonary_trunk_21.castShadow = options.castShadow ?? true;
  mesh_pulmonary_trunk_21.receiveShadow = options.receiveShadow ?? true;
  mesh_pulmonary_trunk_21.userData.sculptComponent = {"id": "pulmonary-trunk", "name": "Pulmonary trunk", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named pulmonary trunk as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.18, 0.5, 0.38], [0.18, 0.92, 0.58], [0.23, 1.18, 0.57]], "radius": 0.22, "radialSegments": 12, "closed": false}}, "parent": "pulmonary-venous-system", "attachment": {"parentId": "pulmonary-venous-system", "parentSocket": "pulmonary-venous-system-surface", "localStart": [0.18, 0.5, 0.38], "localEnd": [0.23, 1.18, 0.57], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "pulmonary-trunk-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-trunk", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "venous", "materialLayers": ["venous"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(70, 23, 51, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(70, 23, 51, 1.0)"}, {"position": 1.0, "color": "rgba(116, 43, 75, 1.0)"}]}, "evidenceRefs": ["anterior", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "superior"], "details": [], "fidelityTier": "hero"};
  node_pulmonary_trunk_21.add(mesh_pulmonary_trunk_21);
  meshes["pulmonary-trunk"] = mesh_pulmonary_trunk_21;
  colliders["pulmonary-trunk"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["pulmonary-trunk"] ??= [];
  destructionGroups["pulmonary-trunk"].push(node_pulmonary_trunk_21);
  const socket_pulmonary_trunk_pulmonary_trunk_surface_0 = new THREE.Object3D();
  socket_pulmonary_trunk_pulmonary_trunk_surface_0.name = "pulmonary-trunk-surface";
  socket_pulmonary_trunk_pulmonary_trunk_surface_0.position.set(0.0, 0.0, 0.0);
  socket_pulmonary_trunk_pulmonary_trunk_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_pulmonary_trunk_pulmonary_trunk_surface_0.userData.socket = {"id": "pulmonary-trunk-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_pulmonary_trunk_21.add(socket_pulmonary_trunk_pulmonary_trunk_surface_0);
  sockets["pulmonary-trunk:pulmonary-trunk-surface"] = socket_pulmonary_trunk_pulmonary_trunk_surface_0;

  const attachment_left_pulmonary_branch_22 = {"parentId": "pulmonary-venous-system", "parentSocket": "pulmonary-venous-system-surface", "localStart": [0.21, 1.13, 0.54], "localEnd": [1.02, 1.16, 0.42], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "superior"]};
  const endpoint_left_pulmonary_branch_22 = makeAttachmentEndpoint(attachment_left_pulmonary_branch_22);
  const node_left_pulmonary_branch_22 = new THREE.Group();
  node_left_pulmonary_branch_22.name = "Left pulmonary artery branch__pivot";
  node_left_pulmonary_branch_22.scale.set(1, 1, 1);
  if (endpoint_left_pulmonary_branch_22) {
    node_left_pulmonary_branch_22.position.copy(endpoint_left_pulmonary_branch_22.start);
    node_left_pulmonary_branch_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_left_pulmonary_branch_22.position.set(0.0, 0.0, 0.0);
    node_left_pulmonary_branch_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_left_pulmonary_branch_22.userData.sculptComponent = {"id": "left-pulmonary-branch", "name": "Left pulmonary artery branch", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named left pulmonary artery branch as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.21, 1.13, 0.54], [0.62, 1.2, 0.5], [1.02, 1.16, 0.42]], "radius": 0.16, "radialSegments": 12, "closed": false}}, "parent": "pulmonary-venous-system", "attachment": {"parentId": "pulmonary-venous-system", "parentSocket": "pulmonary-venous-system-surface", "localStart": [0.21, 1.13, 0.54], "localEnd": [1.02, 1.16, 0.42], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-pulmonary-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-pulmonary-branch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "venous", "materialLayers": ["venous"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(70, 23, 51, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(70, 23, 51, 1.0)"}, {"position": 1.0, "color": "rgba(116, 43, 75, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "superior"], "details": [], "fidelityTier": "hero"};
  node_left_pulmonary_branch_22.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-pulmonary-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-pulmonary-branch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["pulmonary-venous-system"] ?? root).add(node_left_pulmonary_branch_22);
  nodes["left-pulmonary-branch"] = node_left_pulmonary_branch_22;
  const mesh_left_pulmonary_branch_22Geometry = endpoint_left_pulmonary_branch_22
    ? new THREE.CylinderGeometry(endpoint_left_pulmonary_branch_22.endRadius, endpoint_left_pulmonary_branch_22.baseRadius, endpoint_left_pulmonary_branch_22.length, 32, 12)
    : buildTubeGeometry({"points": [[0.21, 1.13, 0.54], [0.62, 1.2, 0.5], [1.02, 1.16, 0.42]], "radius": 0.16, "radialSegments": 12, "closed": false});
  if (!endpoint_left_pulmonary_branch_22) {
    mesh_left_pulmonary_branch_22Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_left_pulmonary_branch_22 = new THREE.Mesh(
    mesh_left_pulmonary_branch_22Geometry,
    materialMap["venous"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_left_pulmonary_branch_22.name = "Left pulmonary artery branch";
  if (endpoint_left_pulmonary_branch_22) {
    mesh_left_pulmonary_branch_22.position.copy(endpoint_left_pulmonary_branch_22.midpoint);
    mesh_left_pulmonary_branch_22.quaternion.copy(endpoint_left_pulmonary_branch_22.quaternion);
  }
  mesh_left_pulmonary_branch_22.castShadow = options.castShadow ?? true;
  mesh_left_pulmonary_branch_22.receiveShadow = options.receiveShadow ?? true;
  mesh_left_pulmonary_branch_22.userData.sculptComponent = {"id": "left-pulmonary-branch", "name": "Left pulmonary artery branch", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named left pulmonary artery branch as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.21, 1.13, 0.54], [0.62, 1.2, 0.5], [1.02, 1.16, 0.42]], "radius": 0.16, "radialSegments": 12, "closed": false}}, "parent": "pulmonary-venous-system", "attachment": {"parentId": "pulmonary-venous-system", "parentSocket": "pulmonary-venous-system-surface", "localStart": [0.21, 1.13, 0.54], "localEnd": [1.02, 1.16, 0.42], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-pulmonary-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-pulmonary-branch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "venous", "materialLayers": ["venous"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(70, 23, 51, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(70, 23, 51, 1.0)"}, {"position": 1.0, "color": "rgba(116, 43, 75, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "superior"], "details": [], "fidelityTier": "hero"};
  node_left_pulmonary_branch_22.add(mesh_left_pulmonary_branch_22);
  meshes["left-pulmonary-branch"] = mesh_left_pulmonary_branch_22;
  colliders["left-pulmonary-branch"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["left-pulmonary-branch"] ??= [];
  destructionGroups["left-pulmonary-branch"].push(node_left_pulmonary_branch_22);
  const socket_left_pulmonary_branch_left_pulmonary_branch_surface_0 = new THREE.Object3D();
  socket_left_pulmonary_branch_left_pulmonary_branch_surface_0.name = "left-pulmonary-branch-surface";
  socket_left_pulmonary_branch_left_pulmonary_branch_surface_0.position.set(0.0, 0.0, 0.0);
  socket_left_pulmonary_branch_left_pulmonary_branch_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_left_pulmonary_branch_left_pulmonary_branch_surface_0.userData.socket = {"id": "left-pulmonary-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_left_pulmonary_branch_22.add(socket_left_pulmonary_branch_left_pulmonary_branch_surface_0);
  sockets["left-pulmonary-branch:left-pulmonary-branch-surface"] = socket_left_pulmonary_branch_left_pulmonary_branch_surface_0;

  const attachment_right_pulmonary_branch_23 = {"parentId": "pulmonary-venous-system", "parentSocket": "pulmonary-venous-system-surface", "localStart": [0.18, 1.1, 0.5], "localEnd": [-0.92, 1.1, 0.28], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "right-oblique", "superior"]};
  const endpoint_right_pulmonary_branch_23 = makeAttachmentEndpoint(attachment_right_pulmonary_branch_23);
  const node_right_pulmonary_branch_23 = new THREE.Group();
  node_right_pulmonary_branch_23.name = "Right pulmonary artery branch__pivot";
  node_right_pulmonary_branch_23.scale.set(1, 1, 1);
  if (endpoint_right_pulmonary_branch_23) {
    node_right_pulmonary_branch_23.position.copy(endpoint_right_pulmonary_branch_23.start);
    node_right_pulmonary_branch_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_right_pulmonary_branch_23.position.set(0.0, 0.0, 0.0);
    node_right_pulmonary_branch_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_right_pulmonary_branch_23.userData.sculptComponent = {"id": "right-pulmonary-branch", "name": "Right pulmonary artery branch", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named right pulmonary artery branch as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.18, 1.1, 0.5], [-0.3, 1.16, 0.42], [-0.92, 1.1, 0.28]], "radius": 0.16, "radialSegments": 12, "closed": false}}, "parent": "pulmonary-venous-system", "attachment": {"parentId": "pulmonary-venous-system", "parentSocket": "pulmonary-venous-system-surface", "localStart": [0.18, 1.1, 0.5], "localEnd": [-0.92, 1.1, 0.28], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "right-oblique", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-pulmonary-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-pulmonary-branch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "venous", "materialLayers": ["venous"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(70, 23, 51, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(70, 23, 51, 1.0)"}, {"position": 1.0, "color": "rgba(116, 43, 75, 1.0)"}]}, "evidenceRefs": ["anterior", "right-oblique", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "right-oblique", "superior"], "details": [], "fidelityTier": "hero"};
  node_right_pulmonary_branch_23.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-pulmonary-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-pulmonary-branch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["pulmonary-venous-system"] ?? root).add(node_right_pulmonary_branch_23);
  nodes["right-pulmonary-branch"] = node_right_pulmonary_branch_23;
  const mesh_right_pulmonary_branch_23Geometry = endpoint_right_pulmonary_branch_23
    ? new THREE.CylinderGeometry(endpoint_right_pulmonary_branch_23.endRadius, endpoint_right_pulmonary_branch_23.baseRadius, endpoint_right_pulmonary_branch_23.length, 32, 12)
    : buildTubeGeometry({"points": [[0.18, 1.1, 0.5], [-0.3, 1.16, 0.42], [-0.92, 1.1, 0.28]], "radius": 0.16, "radialSegments": 12, "closed": false});
  if (!endpoint_right_pulmonary_branch_23) {
    mesh_right_pulmonary_branch_23Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_right_pulmonary_branch_23 = new THREE.Mesh(
    mesh_right_pulmonary_branch_23Geometry,
    materialMap["venous"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_right_pulmonary_branch_23.name = "Right pulmonary artery branch";
  if (endpoint_right_pulmonary_branch_23) {
    mesh_right_pulmonary_branch_23.position.copy(endpoint_right_pulmonary_branch_23.midpoint);
    mesh_right_pulmonary_branch_23.quaternion.copy(endpoint_right_pulmonary_branch_23.quaternion);
  }
  mesh_right_pulmonary_branch_23.castShadow = options.castShadow ?? true;
  mesh_right_pulmonary_branch_23.receiveShadow = options.receiveShadow ?? true;
  mesh_right_pulmonary_branch_23.userData.sculptComponent = {"id": "right-pulmonary-branch", "name": "Right pulmonary artery branch", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named right pulmonary artery branch as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.18, 1.1, 0.5], [-0.3, 1.16, 0.42], [-0.92, 1.1, 0.28]], "radius": 0.16, "radialSegments": 12, "closed": false}}, "parent": "pulmonary-venous-system", "attachment": {"parentId": "pulmonary-venous-system", "parentSocket": "pulmonary-venous-system-surface", "localStart": [0.18, 1.1, 0.5], "localEnd": [-0.92, 1.1, 0.28], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "right-oblique", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-pulmonary-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-pulmonary-branch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "venous", "materialLayers": ["venous"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(70, 23, 51, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(70, 23, 51, 1.0)"}, {"position": 1.0, "color": "rgba(116, 43, 75, 1.0)"}]}, "evidenceRefs": ["anterior", "right-oblique", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "right-oblique", "superior"], "details": [], "fidelityTier": "hero"};
  node_right_pulmonary_branch_23.add(mesh_right_pulmonary_branch_23);
  meshes["right-pulmonary-branch"] = mesh_right_pulmonary_branch_23;
  colliders["right-pulmonary-branch"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["right-pulmonary-branch"] ??= [];
  destructionGroups["right-pulmonary-branch"].push(node_right_pulmonary_branch_23);
  const socket_right_pulmonary_branch_right_pulmonary_branch_surface_0 = new THREE.Object3D();
  socket_right_pulmonary_branch_right_pulmonary_branch_surface_0.name = "right-pulmonary-branch-surface";
  socket_right_pulmonary_branch_right_pulmonary_branch_surface_0.position.set(0.0, 0.0, 0.0);
  socket_right_pulmonary_branch_right_pulmonary_branch_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_right_pulmonary_branch_right_pulmonary_branch_surface_0.userData.socket = {"id": "right-pulmonary-branch-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_right_pulmonary_branch_23.add(socket_right_pulmonary_branch_right_pulmonary_branch_surface_0);
  sockets["right-pulmonary-branch:right-pulmonary-branch-surface"] = socket_right_pulmonary_branch_right_pulmonary_branch_surface_0;

  const attachment_vena_cava_system_24 = {"parentId": "pulmonary-venous-system", "parentSocket": "pulmonary-venous-system-surface", "localStart": [-0.55, 0.65, -0.18], "localEnd": [-0.6, 2.02, -0.3], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["left-oblique", "posterior", "right-oblique", "superior"]};
  const endpoint_vena_cava_system_24 = makeAttachmentEndpoint(attachment_vena_cava_system_24);
  const node_vena_cava_system_24 = new THREE.Group();
  node_vena_cava_system_24.name = "Superior and inferior vena-cava paths__pivot";
  node_vena_cava_system_24.scale.set(1, 1, 1);
  if (endpoint_vena_cava_system_24) {
    node_vena_cava_system_24.position.copy(endpoint_vena_cava_system_24.start);
    node_vena_cava_system_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vena_cava_system_24.position.set(0.0, 0.0, 0.0);
    node_vena_cava_system_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_vena_cava_system_24.userData.sculptComponent = {"id": "vena-cava-system", "name": "Superior and inferior vena-cava paths", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named superior and inferior vena-cava paths as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.55, 0.65, -0.18], [-0.58, 1.25, -0.28], [-0.6, 2.02, -0.3]], "radius": 0.19, "radialSegments": 12, "closed": false}}, "parent": "pulmonary-venous-system", "attachment": {"parentId": "pulmonary-venous-system", "parentSocket": "pulmonary-venous-system-surface", "localStart": [-0.55, 0.65, -0.18], "localEnd": [-0.6, 2.02, -0.3], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["left-oblique", "posterior", "right-oblique", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "vena-cava-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "vena-cava-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "venous", "materialLayers": ["venous"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "hollow-openings", "kind": "hole", "description": "Hollow caval openings with wall thickness.", "evidenceRefs": ["left-oblique", "posterior", "right-oblique", "superior"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(70, 23, 51, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(70, 23, 51, 1.0)"}, {"position": 1.0, "color": "rgba(116, 43, 75, 1.0)"}]}, "evidenceRefs": ["left-oblique", "posterior", "right-oblique", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["left-oblique", "posterior", "right-oblique", "superior"], "details": [], "fidelityTier": "hero"};
  node_vena_cava_system_24.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "vena-cava-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "vena-cava-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["pulmonary-venous-system"] ?? root).add(node_vena_cava_system_24);
  nodes["vena-cava-system"] = node_vena_cava_system_24;
  const mesh_vena_cava_system_24Geometry = endpoint_vena_cava_system_24
    ? new THREE.CylinderGeometry(endpoint_vena_cava_system_24.endRadius, endpoint_vena_cava_system_24.baseRadius, endpoint_vena_cava_system_24.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.55, 0.65, -0.18], [-0.58, 1.25, -0.28], [-0.6, 2.02, -0.3]], "radius": 0.19, "radialSegments": 12, "closed": false});
  if (!endpoint_vena_cava_system_24) {
    mesh_vena_cava_system_24Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_vena_cava_system_24 = new THREE.Mesh(
    mesh_vena_cava_system_24Geometry,
    materialMap["venous"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vena_cava_system_24.name = "Superior and inferior vena-cava paths";
  if (endpoint_vena_cava_system_24) {
    mesh_vena_cava_system_24.position.copy(endpoint_vena_cava_system_24.midpoint);
    mesh_vena_cava_system_24.quaternion.copy(endpoint_vena_cava_system_24.quaternion);
  }
  mesh_vena_cava_system_24.castShadow = options.castShadow ?? true;
  mesh_vena_cava_system_24.receiveShadow = options.receiveShadow ?? true;
  mesh_vena_cava_system_24.userData.sculptComponent = {"id": "vena-cava-system", "name": "Superior and inferior vena-cava paths", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named superior and inferior vena-cava paths as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.55, 0.65, -0.18], [-0.58, 1.25, -0.28], [-0.6, 2.02, -0.3]], "radius": 0.19, "radialSegments": 12, "closed": false}}, "parent": "pulmonary-venous-system", "attachment": {"parentId": "pulmonary-venous-system", "parentSocket": "pulmonary-venous-system-surface", "localStart": [-0.55, 0.65, -0.18], "localEnd": [-0.6, 2.02, -0.3], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["left-oblique", "posterior", "right-oblique", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "vena-cava-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "vena-cava-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "venous", "materialLayers": ["venous"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "hollow-openings", "kind": "hole", "description": "Hollow caval openings with wall thickness.", "evidenceRefs": ["left-oblique", "posterior", "right-oblique", "superior"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(70, 23, 51, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(70, 23, 51, 1.0)"}, {"position": 1.0, "color": "rgba(116, 43, 75, 1.0)"}]}, "evidenceRefs": ["left-oblique", "posterior", "right-oblique", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["left-oblique", "posterior", "right-oblique", "superior"], "details": [], "fidelityTier": "hero"};
  node_vena_cava_system_24.add(mesh_vena_cava_system_24);
  meshes["vena-cava-system"] = mesh_vena_cava_system_24;
  colliders["vena-cava-system"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["vena-cava-system"] ??= [];
  destructionGroups["vena-cava-system"].push(node_vena_cava_system_24);
  const socket_vena_cava_system_vena_cava_system_surface_0 = new THREE.Object3D();
  socket_vena_cava_system_vena_cava_system_surface_0.name = "vena-cava-system-surface";
  socket_vena_cava_system_vena_cava_system_surface_0.position.set(0.0, 0.0, 0.0);
  socket_vena_cava_system_vena_cava_system_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_vena_cava_system_vena_cava_system_surface_0.userData.socket = {"id": "vena-cava-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_vena_cava_system_24.add(socket_vena_cava_system_vena_cava_system_surface_0);
  sockets["vena-cava-system:vena-cava-system-surface"] = socket_vena_cava_system_vena_cava_system_surface_0;

  const attachment_pulmonary_return_system_25 = {"parentId": "pulmonary-venous-system", "parentSocket": "pulmonary-venous-system-surface", "localStart": [-0.82, 0.78, -0.48], "localEnd": [0.75, 0.78, -0.42], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["posterior", "right-oblique", "superior"]};
  const endpoint_pulmonary_return_system_25 = makeAttachmentEndpoint(attachment_pulmonary_return_system_25);
  const node_pulmonary_return_system_25 = new THREE.Group();
  node_pulmonary_return_system_25.name = "Paired pulmonary return vessels__pivot";
  node_pulmonary_return_system_25.scale.set(1, 1, 1);
  if (endpoint_pulmonary_return_system_25) {
    node_pulmonary_return_system_25.position.copy(endpoint_pulmonary_return_system_25.start);
    node_pulmonary_return_system_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pulmonary_return_system_25.position.set(0.0, 0.0, 0.0);
    node_pulmonary_return_system_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_pulmonary_return_system_25.userData.sculptComponent = {"id": "pulmonary-return-system", "name": "Paired pulmonary return vessels", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named paired pulmonary return vessels as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.82, 0.78, -0.48], [-0.35, 0.78, -0.5], [0.15, 0.76, -0.48], [0.75, 0.78, -0.42]], "radius": 0.12, "radialSegments": 12, "closed": false}}, "parent": "pulmonary-venous-system", "attachment": {"parentId": "pulmonary-venous-system", "parentSocket": "pulmonary-venous-system-surface", "localStart": [-0.82, 0.78, -0.48], "localEnd": [0.75, 0.78, -0.42], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["posterior", "right-oblique", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "pulmonary-return-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-return-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "venous", "materialLayers": ["venous"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "paired-openings", "kind": "hole", "description": "Paired posterior return tube openings.", "evidenceRefs": ["posterior", "right-oblique", "superior"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(70, 23, 51, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(70, 23, 51, 1.0)"}, {"position": 1.0, "color": "rgba(116, 43, 75, 1.0)"}]}, "evidenceRefs": ["posterior", "right-oblique", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["posterior", "right-oblique", "superior"], "details": [], "fidelityTier": "hero"};
  node_pulmonary_return_system_25.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "pulmonary-return-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-return-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["pulmonary-venous-system"] ?? root).add(node_pulmonary_return_system_25);
  nodes["pulmonary-return-system"] = node_pulmonary_return_system_25;
  const mesh_pulmonary_return_system_25Geometry = endpoint_pulmonary_return_system_25
    ? new THREE.CylinderGeometry(endpoint_pulmonary_return_system_25.endRadius, endpoint_pulmonary_return_system_25.baseRadius, endpoint_pulmonary_return_system_25.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.82, 0.78, -0.48], [-0.35, 0.78, -0.5], [0.15, 0.76, -0.48], [0.75, 0.78, -0.42]], "radius": 0.12, "radialSegments": 12, "closed": false});
  if (!endpoint_pulmonary_return_system_25) {
    mesh_pulmonary_return_system_25Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pulmonary_return_system_25 = new THREE.Mesh(
    mesh_pulmonary_return_system_25Geometry,
    materialMap["venous"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pulmonary_return_system_25.name = "Paired pulmonary return vessels";
  if (endpoint_pulmonary_return_system_25) {
    mesh_pulmonary_return_system_25.position.copy(endpoint_pulmonary_return_system_25.midpoint);
    mesh_pulmonary_return_system_25.quaternion.copy(endpoint_pulmonary_return_system_25.quaternion);
  }
  mesh_pulmonary_return_system_25.castShadow = options.castShadow ?? true;
  mesh_pulmonary_return_system_25.receiveShadow = options.receiveShadow ?? true;
  mesh_pulmonary_return_system_25.userData.sculptComponent = {"id": "pulmonary-return-system", "name": "Paired pulmonary return vessels", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named paired pulmonary return vessels as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.82, 0.78, -0.48], [-0.35, 0.78, -0.5], [0.15, 0.76, -0.48], [0.75, 0.78, -0.42]], "radius": 0.12, "radialSegments": 12, "closed": false}}, "parent": "pulmonary-venous-system", "attachment": {"parentId": "pulmonary-venous-system", "parentSocket": "pulmonary-venous-system-surface", "localStart": [-0.82, 0.78, -0.48], "localEnd": [0.75, 0.78, -0.42], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["posterior", "right-oblique", "superior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "pulmonary-return-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-return-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "venous", "materialLayers": ["venous"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "paired-openings", "kind": "hole", "description": "Paired posterior return tube openings.", "evidenceRefs": ["posterior", "right-oblique", "superior"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(70, 23, 51, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(70, 23, 51, 1.0)"}, {"position": 1.0, "color": "rgba(116, 43, 75, 1.0)"}]}, "evidenceRefs": ["posterior", "right-oblique", "superior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["posterior", "right-oblique", "superior"], "details": [], "fidelityTier": "hero"};
  node_pulmonary_return_system_25.add(mesh_pulmonary_return_system_25);
  meshes["pulmonary-return-system"] = mesh_pulmonary_return_system_25;
  colliders["pulmonary-return-system"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["pulmonary-return-system"] ??= [];
  destructionGroups["pulmonary-return-system"].push(node_pulmonary_return_system_25);
  const socket_pulmonary_return_system_pulmonary_return_system_surface_0 = new THREE.Object3D();
  socket_pulmonary_return_system_pulmonary_return_system_surface_0.name = "pulmonary-return-system-surface";
  socket_pulmonary_return_system_pulmonary_return_system_surface_0.position.set(0.0, 0.0, 0.0);
  socket_pulmonary_return_system_pulmonary_return_system_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_pulmonary_return_system_pulmonary_return_system_surface_0.userData.socket = {"id": "pulmonary-return-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_pulmonary_return_system_25.add(socket_pulmonary_return_system_pulmonary_return_system_surface_0);
  sockets["pulmonary-return-system:pulmonary-return-system-surface"] = socket_pulmonary_return_system_pulmonary_return_system_surface_0;

  const attachment_anterior_coronary_trunks_26 = {"parentId": "coronary-network", "parentSocket": "coronary-network-surface", "localStart": [0.05, 0.7, 0.72], "localEnd": [-0.12, -1.28, 0.2], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior"]};
  const endpoint_anterior_coronary_trunks_26 = makeAttachmentEndpoint(attachment_anterior_coronary_trunks_26);
  const node_anterior_coronary_trunks_26 = new THREE.Group();
  node_anterior_coronary_trunks_26.name = "Anterior coronary trunks__pivot";
  node_anterior_coronary_trunks_26.scale.set(1, 1, 1);
  if (endpoint_anterior_coronary_trunks_26) {
    node_anterior_coronary_trunks_26.position.copy(endpoint_anterior_coronary_trunks_26.start);
    node_anterior_coronary_trunks_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_anterior_coronary_trunks_26.position.set(0.0, 0.0, 0.0);
    node_anterior_coronary_trunks_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_anterior_coronary_trunks_26.userData.sculptComponent = {"id": "anterior-coronary-trunks", "name": "Anterior coronary trunks", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named anterior coronary trunks as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.05, 0.7, 0.72], [0.04, 0.1, 0.82], [0.04, -0.62, 0.67], [-0.12, -1.28, 0.2]], "radius": 0.045, "radialSegments": 8, "closed": false}}, "parent": "coronary-network", "attachment": {"parentId": "coronary-network", "parentSocket": "coronary-network-surface", "localStart": [0.05, 0.7, 0.72], "localEnd": [-0.12, -1.28, 0.2], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "anterior-coronary-trunks-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "anterior-coronary-trunks", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "coronary-vein", "materialLayers": ["coronary-vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(47, 15, 44, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(47, 15, 44, 1.0)"}, {"position": 1.0, "color": "rgba(84, 28, 68, 1.0)"}]}, "evidenceRefs": ["anterior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior"], "details": [], "fidelityTier": "hero"};
  node_anterior_coronary_trunks_26.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "anterior-coronary-trunks-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "anterior-coronary-trunks", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["coronary-network"] ?? root).add(node_anterior_coronary_trunks_26);
  nodes["anterior-coronary-trunks"] = node_anterior_coronary_trunks_26;
  const mesh_anterior_coronary_trunks_26Geometry = endpoint_anterior_coronary_trunks_26
    ? new THREE.CylinderGeometry(endpoint_anterior_coronary_trunks_26.endRadius, endpoint_anterior_coronary_trunks_26.baseRadius, endpoint_anterior_coronary_trunks_26.length, 32, 12)
    : buildTubeGeometry({"points": [[0.05, 0.7, 0.72], [0.04, 0.1, 0.82], [0.04, -0.62, 0.67], [-0.12, -1.28, 0.2]], "radius": 0.045, "radialSegments": 8, "closed": false});
  if (!endpoint_anterior_coronary_trunks_26) {
    mesh_anterior_coronary_trunks_26Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_anterior_coronary_trunks_26 = new THREE.Mesh(
    mesh_anterior_coronary_trunks_26Geometry,
    materialMap["coronary-vein"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_anterior_coronary_trunks_26.name = "Anterior coronary trunks";
  if (endpoint_anterior_coronary_trunks_26) {
    mesh_anterior_coronary_trunks_26.position.copy(endpoint_anterior_coronary_trunks_26.midpoint);
    mesh_anterior_coronary_trunks_26.quaternion.copy(endpoint_anterior_coronary_trunks_26.quaternion);
  }
  mesh_anterior_coronary_trunks_26.castShadow = options.castShadow ?? true;
  mesh_anterior_coronary_trunks_26.receiveShadow = options.receiveShadow ?? true;
  mesh_anterior_coronary_trunks_26.userData.sculptComponent = {"id": "anterior-coronary-trunks", "name": "Anterior coronary trunks", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named anterior coronary trunks as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.05, 0.7, 0.72], [0.04, 0.1, 0.82], [0.04, -0.62, 0.67], [-0.12, -1.28, 0.2]], "radius": 0.045, "radialSegments": 8, "closed": false}}, "parent": "coronary-network", "attachment": {"parentId": "coronary-network", "parentSocket": "coronary-network-surface", "localStart": [0.05, 0.7, 0.72], "localEnd": [-0.12, -1.28, 0.2], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "anterior-coronary-trunks-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "anterior-coronary-trunks", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "coronary-vein", "materialLayers": ["coronary-vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(47, 15, 44, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(47, 15, 44, 1.0)"}, {"position": 1.0, "color": "rgba(84, 28, 68, 1.0)"}]}, "evidenceRefs": ["anterior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior"], "details": [], "fidelityTier": "hero"};
  node_anterior_coronary_trunks_26.add(mesh_anterior_coronary_trunks_26);
  meshes["anterior-coronary-trunks"] = mesh_anterior_coronary_trunks_26;
  colliders["anterior-coronary-trunks"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["anterior-coronary-trunks"] ??= [];
  destructionGroups["anterior-coronary-trunks"].push(node_anterior_coronary_trunks_26);
  const socket_anterior_coronary_trunks_anterior_coronary_trunks_surface_0 = new THREE.Object3D();
  socket_anterior_coronary_trunks_anterior_coronary_trunks_surface_0.name = "anterior-coronary-trunks-surface";
  socket_anterior_coronary_trunks_anterior_coronary_trunks_surface_0.position.set(0.0, 0.0, 0.0);
  socket_anterior_coronary_trunks_anterior_coronary_trunks_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_anterior_coronary_trunks_anterior_coronary_trunks_surface_0.userData.socket = {"id": "anterior-coronary-trunks-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_anterior_coronary_trunks_26.add(socket_anterior_coronary_trunks_anterior_coronary_trunks_surface_0);
  sockets["anterior-coronary-trunks:anterior-coronary-trunks-surface"] = socket_anterior_coronary_trunks_anterior_coronary_trunks_surface_0;

  const attachment_left_lateral_coronary_wrap_27 = {"parentId": "coronary-network", "parentSocket": "coronary-network-surface", "localStart": [-0.16, 0.58, 0.7], "localEnd": [-0.6, -0.72, -0.22], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["left-oblique"]};
  const endpoint_left_lateral_coronary_wrap_27 = makeAttachmentEndpoint(attachment_left_lateral_coronary_wrap_27);
  const node_left_lateral_coronary_wrap_27 = new THREE.Group();
  node_left_lateral_coronary_wrap_27.name = "Left lateral coronary wrap__pivot";
  node_left_lateral_coronary_wrap_27.scale.set(1, 1, 1);
  if (endpoint_left_lateral_coronary_wrap_27) {
    node_left_lateral_coronary_wrap_27.position.copy(endpoint_left_lateral_coronary_wrap_27.start);
    node_left_lateral_coronary_wrap_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_left_lateral_coronary_wrap_27.position.set(0.0, 0.0, 0.0);
    node_left_lateral_coronary_wrap_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_left_lateral_coronary_wrap_27.userData.sculptComponent = {"id": "left-lateral-coronary-wrap", "name": "Left lateral coronary wrap", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named left lateral coronary wrap as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.16, 0.58, 0.7], [-0.58, 0.32, 0.56], [-0.82, -0.18, 0.18], [-0.6, -0.72, -0.22]], "radius": 0.035, "radialSegments": 8, "closed": false}}, "parent": "coronary-network", "attachment": {"parentId": "coronary-network", "parentSocket": "coronary-network-surface", "localStart": [-0.16, 0.58, 0.7], "localEnd": [-0.6, -0.72, -0.22], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["left-oblique"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-lateral-coronary-wrap-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-lateral-coronary-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "coronary-artery", "materialLayers": ["coronary-artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(135, 29, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(135, 29, 45, 1.0)"}, {"position": 1.0, "color": "rgba(204, 54, 59, 1.0)"}]}, "evidenceRefs": ["left-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["left-oblique"], "details": [], "fidelityTier": "hero"};
  node_left_lateral_coronary_wrap_27.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-lateral-coronary-wrap-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-lateral-coronary-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["coronary-network"] ?? root).add(node_left_lateral_coronary_wrap_27);
  nodes["left-lateral-coronary-wrap"] = node_left_lateral_coronary_wrap_27;
  const mesh_left_lateral_coronary_wrap_27Geometry = endpoint_left_lateral_coronary_wrap_27
    ? new THREE.CylinderGeometry(endpoint_left_lateral_coronary_wrap_27.endRadius, endpoint_left_lateral_coronary_wrap_27.baseRadius, endpoint_left_lateral_coronary_wrap_27.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.16, 0.58, 0.7], [-0.58, 0.32, 0.56], [-0.82, -0.18, 0.18], [-0.6, -0.72, -0.22]], "radius": 0.035, "radialSegments": 8, "closed": false});
  if (!endpoint_left_lateral_coronary_wrap_27) {
    mesh_left_lateral_coronary_wrap_27Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_left_lateral_coronary_wrap_27 = new THREE.Mesh(
    mesh_left_lateral_coronary_wrap_27Geometry,
    materialMap["coronary-artery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_left_lateral_coronary_wrap_27.name = "Left lateral coronary wrap";
  if (endpoint_left_lateral_coronary_wrap_27) {
    mesh_left_lateral_coronary_wrap_27.position.copy(endpoint_left_lateral_coronary_wrap_27.midpoint);
    mesh_left_lateral_coronary_wrap_27.quaternion.copy(endpoint_left_lateral_coronary_wrap_27.quaternion);
  }
  mesh_left_lateral_coronary_wrap_27.castShadow = options.castShadow ?? true;
  mesh_left_lateral_coronary_wrap_27.receiveShadow = options.receiveShadow ?? true;
  mesh_left_lateral_coronary_wrap_27.userData.sculptComponent = {"id": "left-lateral-coronary-wrap", "name": "Left lateral coronary wrap", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named left lateral coronary wrap as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.16, 0.58, 0.7], [-0.58, 0.32, 0.56], [-0.82, -0.18, 0.18], [-0.6, -0.72, -0.22]], "radius": 0.035, "radialSegments": 8, "closed": false}}, "parent": "coronary-network", "attachment": {"parentId": "coronary-network", "parentSocket": "coronary-network-surface", "localStart": [-0.16, 0.58, 0.7], "localEnd": [-0.6, -0.72, -0.22], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["left-oblique"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-lateral-coronary-wrap-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-lateral-coronary-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "coronary-artery", "materialLayers": ["coronary-artery"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(135, 29, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(135, 29, 45, 1.0)"}, {"position": 1.0, "color": "rgba(204, 54, 59, 1.0)"}]}, "evidenceRefs": ["left-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["left-oblique"], "details": [], "fidelityTier": "hero"};
  node_left_lateral_coronary_wrap_27.add(mesh_left_lateral_coronary_wrap_27);
  meshes["left-lateral-coronary-wrap"] = mesh_left_lateral_coronary_wrap_27;
  colliders["left-lateral-coronary-wrap"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["left-lateral-coronary-wrap"] ??= [];
  destructionGroups["left-lateral-coronary-wrap"].push(node_left_lateral_coronary_wrap_27);
  const socket_left_lateral_coronary_wrap_left_lateral_coronary_wrap_surface_0 = new THREE.Object3D();
  socket_left_lateral_coronary_wrap_left_lateral_coronary_wrap_surface_0.name = "left-lateral-coronary-wrap-surface";
  socket_left_lateral_coronary_wrap_left_lateral_coronary_wrap_surface_0.position.set(0.0, 0.0, 0.0);
  socket_left_lateral_coronary_wrap_left_lateral_coronary_wrap_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_left_lateral_coronary_wrap_left_lateral_coronary_wrap_surface_0.userData.socket = {"id": "left-lateral-coronary-wrap-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_left_lateral_coronary_wrap_27.add(socket_left_lateral_coronary_wrap_left_lateral_coronary_wrap_surface_0);
  sockets["left-lateral-coronary-wrap:left-lateral-coronary-wrap-surface"] = socket_left_lateral_coronary_wrap_left_lateral_coronary_wrap_surface_0;

  const attachment_right_lateral_coronary_wrap_28 = {"parentId": "coronary-network", "parentSocket": "coronary-network-surface", "localStart": [0.2, 0.62, 0.68], "localEnd": [0.6, -0.72, -0.18], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["right-oblique"]};
  const endpoint_right_lateral_coronary_wrap_28 = makeAttachmentEndpoint(attachment_right_lateral_coronary_wrap_28);
  const node_right_lateral_coronary_wrap_28 = new THREE.Group();
  node_right_lateral_coronary_wrap_28.name = "Right lateral coronary wrap__pivot";
  node_right_lateral_coronary_wrap_28.scale.set(1, 1, 1);
  if (endpoint_right_lateral_coronary_wrap_28) {
    node_right_lateral_coronary_wrap_28.position.copy(endpoint_right_lateral_coronary_wrap_28.start);
    node_right_lateral_coronary_wrap_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_right_lateral_coronary_wrap_28.position.set(0.0, 0.0, 0.0);
    node_right_lateral_coronary_wrap_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_right_lateral_coronary_wrap_28.userData.sculptComponent = {"id": "right-lateral-coronary-wrap", "name": "Right lateral coronary wrap", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named right lateral coronary wrap as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.2, 0.62, 0.68], [0.62, 0.35, 0.52], [0.78, -0.12, 0.12], [0.6, -0.72, -0.18]], "radius": 0.035, "radialSegments": 8, "closed": false}}, "parent": "coronary-network", "attachment": {"parentId": "coronary-network", "parentSocket": "coronary-network-surface", "localStart": [0.2, 0.62, 0.68], "localEnd": [0.6, -0.72, -0.18], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["right-oblique"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-lateral-coronary-wrap-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-lateral-coronary-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "coronary-vein", "materialLayers": ["coronary-vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(47, 15, 44, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(47, 15, 44, 1.0)"}, {"position": 1.0, "color": "rgba(84, 28, 68, 1.0)"}]}, "evidenceRefs": ["right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["right-oblique"], "details": [], "fidelityTier": "hero"};
  node_right_lateral_coronary_wrap_28.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-lateral-coronary-wrap-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-lateral-coronary-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["coronary-network"] ?? root).add(node_right_lateral_coronary_wrap_28);
  nodes["right-lateral-coronary-wrap"] = node_right_lateral_coronary_wrap_28;
  const mesh_right_lateral_coronary_wrap_28Geometry = endpoint_right_lateral_coronary_wrap_28
    ? new THREE.CylinderGeometry(endpoint_right_lateral_coronary_wrap_28.endRadius, endpoint_right_lateral_coronary_wrap_28.baseRadius, endpoint_right_lateral_coronary_wrap_28.length, 32, 12)
    : buildTubeGeometry({"points": [[0.2, 0.62, 0.68], [0.62, 0.35, 0.52], [0.78, -0.12, 0.12], [0.6, -0.72, -0.18]], "radius": 0.035, "radialSegments": 8, "closed": false});
  if (!endpoint_right_lateral_coronary_wrap_28) {
    mesh_right_lateral_coronary_wrap_28Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_right_lateral_coronary_wrap_28 = new THREE.Mesh(
    mesh_right_lateral_coronary_wrap_28Geometry,
    materialMap["coronary-vein"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_right_lateral_coronary_wrap_28.name = "Right lateral coronary wrap";
  if (endpoint_right_lateral_coronary_wrap_28) {
    mesh_right_lateral_coronary_wrap_28.position.copy(endpoint_right_lateral_coronary_wrap_28.midpoint);
    mesh_right_lateral_coronary_wrap_28.quaternion.copy(endpoint_right_lateral_coronary_wrap_28.quaternion);
  }
  mesh_right_lateral_coronary_wrap_28.castShadow = options.castShadow ?? true;
  mesh_right_lateral_coronary_wrap_28.receiveShadow = options.receiveShadow ?? true;
  mesh_right_lateral_coronary_wrap_28.userData.sculptComponent = {"id": "right-lateral-coronary-wrap", "name": "Right lateral coronary wrap", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named right lateral coronary wrap as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.2, 0.62, 0.68], [0.62, 0.35, 0.52], [0.78, -0.12, 0.12], [0.6, -0.72, -0.18]], "radius": 0.035, "radialSegments": 8, "closed": false}}, "parent": "coronary-network", "attachment": {"parentId": "coronary-network", "parentSocket": "coronary-network-surface", "localStart": [0.2, 0.62, 0.68], "localEnd": [0.6, -0.72, -0.18], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["right-oblique"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-lateral-coronary-wrap-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-lateral-coronary-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "coronary-vein", "materialLayers": ["coronary-vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(47, 15, 44, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(47, 15, 44, 1.0)"}, {"position": 1.0, "color": "rgba(84, 28, 68, 1.0)"}]}, "evidenceRefs": ["right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["right-oblique"], "details": [], "fidelityTier": "hero"};
  node_right_lateral_coronary_wrap_28.add(mesh_right_lateral_coronary_wrap_28);
  meshes["right-lateral-coronary-wrap"] = mesh_right_lateral_coronary_wrap_28;
  colliders["right-lateral-coronary-wrap"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["right-lateral-coronary-wrap"] ??= [];
  destructionGroups["right-lateral-coronary-wrap"].push(node_right_lateral_coronary_wrap_28);
  const socket_right_lateral_coronary_wrap_right_lateral_coronary_wrap_surface_0 = new THREE.Object3D();
  socket_right_lateral_coronary_wrap_right_lateral_coronary_wrap_surface_0.name = "right-lateral-coronary-wrap-surface";
  socket_right_lateral_coronary_wrap_right_lateral_coronary_wrap_surface_0.position.set(0.0, 0.0, 0.0);
  socket_right_lateral_coronary_wrap_right_lateral_coronary_wrap_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_right_lateral_coronary_wrap_right_lateral_coronary_wrap_surface_0.userData.socket = {"id": "right-lateral-coronary-wrap-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_right_lateral_coronary_wrap_28.add(socket_right_lateral_coronary_wrap_right_lateral_coronary_wrap_surface_0);
  sockets["right-lateral-coronary-wrap:right-lateral-coronary-wrap-surface"] = socket_right_lateral_coronary_wrap_right_lateral_coronary_wrap_surface_0;

  const attachment_posterior_coronary_trunks_29 = {"parentId": "coronary-network", "parentSocket": "coronary-network-surface", "localStart": [0.1, 0.55, -0.68], "localEnd": [-0.16, -1.0, -0.28], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["posterior"]};
  const endpoint_posterior_coronary_trunks_29 = makeAttachmentEndpoint(attachment_posterior_coronary_trunks_29);
  const node_posterior_coronary_trunks_29 = new THREE.Group();
  node_posterior_coronary_trunks_29.name = "Posterior coronary continuation__pivot";
  node_posterior_coronary_trunks_29.scale.set(1, 1, 1);
  if (endpoint_posterior_coronary_trunks_29) {
    node_posterior_coronary_trunks_29.position.copy(endpoint_posterior_coronary_trunks_29.start);
    node_posterior_coronary_trunks_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_posterior_coronary_trunks_29.position.set(0.0, 0.0, 0.0);
    node_posterior_coronary_trunks_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_posterior_coronary_trunks_29.userData.sculptComponent = {"id": "posterior-coronary-trunks", "name": "Posterior coronary continuation", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named posterior coronary continuation as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.1, 0.55, -0.68], [0.02, 0.0, -0.75], [-0.1, -0.62, -0.58], [-0.16, -1.0, -0.28]], "radius": 0.034, "radialSegments": 8, "closed": false}}, "parent": "coronary-network", "attachment": {"parentId": "coronary-network", "parentSocket": "coronary-network-surface", "localStart": [0.1, 0.55, -0.68], "localEnd": [-0.16, -1.0, -0.28], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["posterior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "posterior-coronary-trunks-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "posterior-coronary-trunks", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "coronary-vein", "materialLayers": ["coronary-vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(47, 15, 44, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(47, 15, 44, 1.0)"}, {"position": 1.0, "color": "rgba(84, 28, 68, 1.0)"}]}, "evidenceRefs": ["posterior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["posterior"], "details": [], "fidelityTier": "hero"};
  node_posterior_coronary_trunks_29.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "posterior-coronary-trunks-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "posterior-coronary-trunks", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["coronary-network"] ?? root).add(node_posterior_coronary_trunks_29);
  nodes["posterior-coronary-trunks"] = node_posterior_coronary_trunks_29;
  const mesh_posterior_coronary_trunks_29Geometry = endpoint_posterior_coronary_trunks_29
    ? new THREE.CylinderGeometry(endpoint_posterior_coronary_trunks_29.endRadius, endpoint_posterior_coronary_trunks_29.baseRadius, endpoint_posterior_coronary_trunks_29.length, 32, 12)
    : buildTubeGeometry({"points": [[0.1, 0.55, -0.68], [0.02, 0.0, -0.75], [-0.1, -0.62, -0.58], [-0.16, -1.0, -0.28]], "radius": 0.034, "radialSegments": 8, "closed": false});
  if (!endpoint_posterior_coronary_trunks_29) {
    mesh_posterior_coronary_trunks_29Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_posterior_coronary_trunks_29 = new THREE.Mesh(
    mesh_posterior_coronary_trunks_29Geometry,
    materialMap["coronary-vein"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_posterior_coronary_trunks_29.name = "Posterior coronary continuation";
  if (endpoint_posterior_coronary_trunks_29) {
    mesh_posterior_coronary_trunks_29.position.copy(endpoint_posterior_coronary_trunks_29.midpoint);
    mesh_posterior_coronary_trunks_29.quaternion.copy(endpoint_posterior_coronary_trunks_29.quaternion);
  }
  mesh_posterior_coronary_trunks_29.castShadow = options.castShadow ?? true;
  mesh_posterior_coronary_trunks_29.receiveShadow = options.receiveShadow ?? true;
  mesh_posterior_coronary_trunks_29.userData.sculptComponent = {"id": "posterior-coronary-trunks", "name": "Posterior coronary continuation", "level": "meso", "role": "vessel", "importance": 0.78, "confidence": 0.82, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Multi-view evidence requires the named posterior coronary continuation as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.1, 0.55, -0.68], [0.02, 0.0, -0.75], [-0.1, -0.62, -0.58], [-0.16, -1.0, -0.28]], "radius": 0.034, "radialSegments": 8, "closed": false}}, "parent": "coronary-network", "attachment": {"parentId": "coronary-network", "parentSocket": "coronary-network-surface", "localStart": [0.1, 0.55, -0.68], "localEnd": [-0.16, -1.0, -0.28], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["posterior"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "posterior-coronary-trunks-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "posterior-coronary-trunks", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "coronary-vein", "materialLayers": ["coronary-vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(47, 15, 44, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(47, 15, 44, 1.0)"}, {"position": 1.0, "color": "rgba(84, 28, 68, 1.0)"}]}, "evidenceRefs": ["posterior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["posterior"], "details": [], "fidelityTier": "hero"};
  node_posterior_coronary_trunks_29.add(mesh_posterior_coronary_trunks_29);
  meshes["posterior-coronary-trunks"] = mesh_posterior_coronary_trunks_29;
  colliders["posterior-coronary-trunks"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["posterior-coronary-trunks"] ??= [];
  destructionGroups["posterior-coronary-trunks"].push(node_posterior_coronary_trunks_29);
  const socket_posterior_coronary_trunks_posterior_coronary_trunks_surface_0 = new THREE.Object3D();
  socket_posterior_coronary_trunks_posterior_coronary_trunks_surface_0.name = "posterior-coronary-trunks-surface";
  socket_posterior_coronary_trunks_posterior_coronary_trunks_surface_0.position.set(0.0, 0.0, 0.0);
  socket_posterior_coronary_trunks_posterior_coronary_trunks_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_posterior_coronary_trunks_posterior_coronary_trunks_surface_0.userData.socket = {"id": "posterior-coronary-trunks-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_posterior_coronary_trunks_29.add(socket_posterior_coronary_trunks_posterior_coronary_trunks_surface_0);
  sockets["posterior-coronary-trunks:posterior-coronary-trunks-surface"] = socket_posterior_coronary_trunks_posterior_coronary_trunks_surface_0;

  const endpoint_left_fat_pad_30 = makeAttachmentEndpoint(null);
  const node_left_fat_pad_30 = new THREE.Group();
  node_left_fat_pad_30.name = "Left lobulated epicardial fat pad__pivot";
  node_left_fat_pad_30.scale.set(1, 1, 1);
  if (endpoint_left_fat_pad_30) {
    node_left_fat_pad_30.position.copy(endpoint_left_fat_pad_30.start);
    node_left_fat_pad_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_left_fat_pad_30.position.set(-0.48, 0.58, 0.25);
    node_left_fat_pad_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_left_fat_pad_30.userData.sculptComponent = {"id": "left-fat-pad", "name": "Left lobulated epicardial fat pad", "level": "meso", "role": "fat-pad", "importance": 0.78, "confidence": 0.82, "primitive": "instanced-cluster", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named left lobulated epicardial fat pad as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "baseGeometry": "ellipsoid"}, "parent": "epicardial-fat", "attachment": {"parentId": "epicardial-fat", "parentSocket": "epicardial-fat-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [-0.48, 0.58, 0.25], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "posterior"]}, "dimensions": {"width": 0.9, "height": 0.55, "depth": 0.72, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [-0.48, 0.58, 0.25], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-fat-pad-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-fat-pad", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "epicardial-fat", "materialLayers": ["epicardial-fat"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 159, 144, 1.0)", "secondaryAlbedo": "rgba(220, 124, 120, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(220, 124, 120, 1.0)"}, {"position": 1.0, "color": "rgba(238, 159, 144, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "posterior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "posterior"], "details": [], "fidelityTier": "hero"};
  node_left_fat_pad_30.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-fat-pad-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-fat-pad", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["epicardial-fat"] ?? root).add(node_left_fat_pad_30);
  nodes["left-fat-pad"] = node_left_fat_pad_30;
  const mesh_left_fat_pad_30Geometry = endpoint_left_fat_pad_30
    ? new THREE.CylinderGeometry(endpoint_left_fat_pad_30.endRadius, endpoint_left_fat_pad_30.baseRadius, endpoint_left_fat_pad_30.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_left_fat_pad_30) {
    mesh_left_fat_pad_30Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_left_fat_pad_30 = new THREE.Mesh(
    mesh_left_fat_pad_30Geometry,
    materialMap["epicardial-fat"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_left_fat_pad_30.name = "Left lobulated epicardial fat pad";
  if (endpoint_left_fat_pad_30) {
    mesh_left_fat_pad_30.position.copy(endpoint_left_fat_pad_30.midpoint);
    mesh_left_fat_pad_30.quaternion.copy(endpoint_left_fat_pad_30.quaternion);
  }
  mesh_left_fat_pad_30.castShadow = options.castShadow ?? true;
  mesh_left_fat_pad_30.receiveShadow = options.receiveShadow ?? true;
  mesh_left_fat_pad_30.userData.sculptComponent = {"id": "left-fat-pad", "name": "Left lobulated epicardial fat pad", "level": "meso", "role": "fat-pad", "importance": 0.78, "confidence": 0.82, "primitive": "instanced-cluster", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named left lobulated epicardial fat pad as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "baseGeometry": "ellipsoid"}, "parent": "epicardial-fat", "attachment": {"parentId": "epicardial-fat", "parentSocket": "epicardial-fat-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [-0.48, 0.58, 0.25], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "left-oblique", "posterior"]}, "dimensions": {"width": 0.9, "height": 0.55, "depth": 0.72, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [-0.48, 0.58, 0.25], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "left-fat-pad-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-fat-pad", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "epicardial-fat", "materialLayers": ["epicardial-fat"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 159, 144, 1.0)", "secondaryAlbedo": "rgba(220, 124, 120, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(220, 124, 120, 1.0)"}, {"position": 1.0, "color": "rgba(238, 159, 144, 1.0)"}]}, "evidenceRefs": ["anterior", "left-oblique", "posterior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "left-oblique", "posterior"], "details": [], "fidelityTier": "hero"};
  node_left_fat_pad_30.add(mesh_left_fat_pad_30);
  meshes["left-fat-pad"] = mesh_left_fat_pad_30;
  colliders["left-fat-pad"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["left-fat-pad"] ??= [];
  destructionGroups["left-fat-pad"].push(node_left_fat_pad_30);
  const socket_left_fat_pad_left_fat_pad_surface_0 = new THREE.Object3D();
  socket_left_fat_pad_left_fat_pad_surface_0.name = "left-fat-pad-surface";
  socket_left_fat_pad_left_fat_pad_surface_0.position.set(0.0, 0.0, 0.0);
  socket_left_fat_pad_left_fat_pad_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_left_fat_pad_left_fat_pad_surface_0.userData.socket = {"id": "left-fat-pad-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_left_fat_pad_30.add(socket_left_fat_pad_left_fat_pad_surface_0);
  sockets["left-fat-pad:left-fat-pad-surface"] = socket_left_fat_pad_left_fat_pad_surface_0;

  const endpoint_right_fat_pad_31 = makeAttachmentEndpoint(null);
  const node_right_fat_pad_31 = new THREE.Group();
  node_right_fat_pad_31.name = "Right lobulated epicardial fat pad__pivot";
  node_right_fat_pad_31.scale.set(1, 1, 1);
  if (endpoint_right_fat_pad_31) {
    node_right_fat_pad_31.position.copy(endpoint_right_fat_pad_31.start);
    node_right_fat_pad_31.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_right_fat_pad_31.position.set(0.52, 0.56, 0.28);
    node_right_fat_pad_31.rotation.set(0.0, 0.0, 0.0);
  }
  node_right_fat_pad_31.userData.sculptComponent = {"id": "right-fat-pad", "name": "Right lobulated epicardial fat pad", "level": "meso", "role": "fat-pad", "importance": 0.78, "confidence": 0.82, "primitive": "instanced-cluster", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named right lobulated epicardial fat pad as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "baseGeometry": "ellipsoid"}, "parent": "epicardial-fat", "attachment": {"parentId": "epicardial-fat", "parentSocket": "epicardial-fat-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.52, 0.56, 0.28], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "right-oblique"]}, "dimensions": {"width": 0.68, "height": 0.5, "depth": 0.62, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.52, 0.56, 0.28], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-fat-pad-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-fat-pad", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "epicardial-fat", "materialLayers": ["epicardial-fat"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 159, 144, 1.0)", "secondaryAlbedo": "rgba(220, 124, 120, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(220, 124, 120, 1.0)"}, {"position": 1.0, "color": "rgba(238, 159, 144, 1.0)"}]}, "evidenceRefs": ["anterior", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_right_fat_pad_31.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-fat-pad-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-fat-pad", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["epicardial-fat"] ?? root).add(node_right_fat_pad_31);
  nodes["right-fat-pad"] = node_right_fat_pad_31;
  const mesh_right_fat_pad_31Geometry = endpoint_right_fat_pad_31
    ? new THREE.CylinderGeometry(endpoint_right_fat_pad_31.endRadius, endpoint_right_fat_pad_31.baseRadius, endpoint_right_fat_pad_31.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_right_fat_pad_31) {
    mesh_right_fat_pad_31Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_right_fat_pad_31 = new THREE.Mesh(
    mesh_right_fat_pad_31Geometry,
    materialMap["epicardial-fat"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_right_fat_pad_31.name = "Right lobulated epicardial fat pad";
  if (endpoint_right_fat_pad_31) {
    mesh_right_fat_pad_31.position.copy(endpoint_right_fat_pad_31.midpoint);
    mesh_right_fat_pad_31.quaternion.copy(endpoint_right_fat_pad_31.quaternion);
  }
  mesh_right_fat_pad_31.castShadow = options.castShadow ?? true;
  mesh_right_fat_pad_31.receiveShadow = options.receiveShadow ?? true;
  mesh_right_fat_pad_31.userData.sculptComponent = {"id": "right-fat-pad", "name": "Right lobulated epicardial fat pad", "level": "meso", "role": "fat-pad", "importance": 0.78, "confidence": 0.82, "primitive": "instanced-cluster", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named right lobulated epicardial fat pad as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "baseGeometry": "ellipsoid"}, "parent": "epicardial-fat", "attachment": {"parentId": "epicardial-fat", "parentSocket": "epicardial-fat-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.52, 0.56, 0.28], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["anterior", "right-oblique"]}, "dimensions": {"width": 0.68, "height": 0.5, "depth": 0.62, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.52, 0.56, 0.28], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "right-fat-pad-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "right-fat-pad", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "epicardial-fat", "materialLayers": ["epicardial-fat"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 159, 144, 1.0)", "secondaryAlbedo": "rgba(220, 124, 120, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(220, 124, 120, 1.0)"}, {"position": 1.0, "color": "rgba(238, 159, 144, 1.0)"}]}, "evidenceRefs": ["anterior", "right-oblique"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["anterior", "right-oblique"], "details": [], "fidelityTier": "hero"};
  node_right_fat_pad_31.add(mesh_right_fat_pad_31);
  meshes["right-fat-pad"] = mesh_right_fat_pad_31;
  colliders["right-fat-pad"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["right-fat-pad"] ??= [];
  destructionGroups["right-fat-pad"].push(node_right_fat_pad_31);
  const socket_right_fat_pad_right_fat_pad_surface_0 = new THREE.Object3D();
  socket_right_fat_pad_right_fat_pad_surface_0.name = "right-fat-pad-surface";
  socket_right_fat_pad_right_fat_pad_surface_0.position.set(0.0, 0.0, 0.0);
  socket_right_fat_pad_right_fat_pad_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_right_fat_pad_right_fat_pad_surface_0.userData.socket = {"id": "right-fat-pad-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_right_fat_pad_31.add(socket_right_fat_pad_right_fat_pad_surface_0);
  sockets["right-fat-pad:right-fat-pad-surface"] = socket_right_fat_pad_right_fat_pad_surface_0;

  const endpoint_posterior_fat_cap_32 = makeAttachmentEndpoint(null);
  const node_posterior_fat_cap_32 = new THREE.Group();
  node_posterior_fat_cap_32.name = "Posterior lobulated epicardial fat cap__pivot";
  node_posterior_fat_cap_32.scale.set(1, 1, 1);
  if (endpoint_posterior_fat_cap_32) {
    node_posterior_fat_cap_32.position.copy(endpoint_posterior_fat_cap_32.start);
    node_posterior_fat_cap_32.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_posterior_fat_cap_32.position.set(0.0, 0.62, -0.45);
    node_posterior_fat_cap_32.rotation.set(0.0, 0.0, 0.0);
  }
  node_posterior_fat_cap_32.userData.sculptComponent = {"id": "posterior-fat-cap", "name": "Posterior lobulated epicardial fat cap", "level": "meso", "role": "fat-pad", "importance": 0.78, "confidence": 0.82, "primitive": "instanced-cluster", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named posterior lobulated epicardial fat cap as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "baseGeometry": "ellipsoid"}, "parent": "epicardial-fat", "attachment": {"parentId": "epicardial-fat", "parentSocket": "epicardial-fat-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.62, -0.45], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["posterior"]}, "dimensions": {"width": 1.55, "height": 0.52, "depth": 0.58, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.62, -0.45], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "posterior-fat-cap-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "posterior-fat-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "epicardial-fat", "materialLayers": ["epicardial-fat"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 159, 144, 1.0)", "secondaryAlbedo": "rgba(220, 124, 120, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(220, 124, 120, 1.0)"}, {"position": 1.0, "color": "rgba(238, 159, 144, 1.0)"}]}, "evidenceRefs": ["posterior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["posterior"], "details": [], "fidelityTier": "hero"};
  node_posterior_fat_cap_32.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "posterior-fat-cap-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "posterior-fat-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["epicardial-fat"] ?? root).add(node_posterior_fat_cap_32);
  nodes["posterior-fat-cap"] = node_posterior_fat_cap_32;
  const mesh_posterior_fat_cap_32Geometry = endpoint_posterior_fat_cap_32
    ? new THREE.CylinderGeometry(endpoint_posterior_fat_cap_32.endRadius, endpoint_posterior_fat_cap_32.baseRadius, endpoint_posterior_fat_cap_32.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_posterior_fat_cap_32) {
    mesh_posterior_fat_cap_32Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_posterior_fat_cap_32 = new THREE.Mesh(
    mesh_posterior_fat_cap_32Geometry,
    materialMap["epicardial-fat"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_posterior_fat_cap_32.name = "Posterior lobulated epicardial fat cap";
  if (endpoint_posterior_fat_cap_32) {
    mesh_posterior_fat_cap_32.position.copy(endpoint_posterior_fat_cap_32.midpoint);
    mesh_posterior_fat_cap_32.quaternion.copy(endpoint_posterior_fat_cap_32.quaternion);
  }
  mesh_posterior_fat_cap_32.castShadow = options.castShadow ?? true;
  mesh_posterior_fat_cap_32.receiveShadow = options.receiveShadow ?? true;
  mesh_posterior_fat_cap_32.userData.sculptComponent = {"id": "posterior-fat-cap", "name": "Posterior lobulated epicardial fat cap", "level": "meso", "role": "fat-pad", "importance": 0.78, "confidence": 0.82, "primitive": "instanced-cluster", "topologyClass": "continuous-sculpt", "topologyRationale": "Multi-view evidence requires the named posterior lobulated epicardial fat cap as an independently reviewable organic structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "baseGeometry": "ellipsoid"}, "parent": "epicardial-fat", "attachment": {"parentId": "epicardial-fat", "parentSocket": "epicardial-fat-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.62, -0.45], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["posterior"]}, "dimensions": {"width": 1.55, "height": 0.52, "depth": 0.58, "units": "relative-heart-height", "confidence": 0.82}, "transform": {"position": [0.0, 0.62, -0.45], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "posterior-fat-cap-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "posterior-fat-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "epicardial-fat", "materialLayers": ["epicardial-fat"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Surface relief must remain subordinate to the shared five-view silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 159, 144, 1.0)", "secondaryAlbedo": "rgba(220, 124, 120, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(220, 124, 120, 1.0)"}, {"position": 1.0, "color": "rgba(238, 159, 144, 1.0)"}]}, "evidenceRefs": ["posterior"], "note": "Reference-observed tissue region; highlights are lighting response, not albedo."}, "evidenceRefs": ["posterior"], "details": [], "fidelityTier": "hero"};
  node_posterior_fat_cap_32.add(mesh_posterior_fat_cap_32);
  meshes["posterior-fat-cap"] = mesh_posterior_fat_cap_32;
  colliders["posterior-fat-cap"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["posterior-fat-cap"] ??= [];
  destructionGroups["posterior-fat-cap"].push(node_posterior_fat_cap_32);
  const socket_posterior_fat_cap_posterior_fat_cap_surface_0 = new THREE.Object3D();
  socket_posterior_fat_cap_posterior_fat_cap_surface_0.name = "posterior-fat-cap-surface";
  socket_posterior_fat_cap_posterior_fat_cap_surface_0.position.set(0.0, 0.0, 0.0);
  socket_posterior_fat_cap_posterior_fat_cap_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_posterior_fat_cap_posterior_fat_cap_surface_0.userData.socket = {"id": "posterior-fat-cap-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_posterior_fat_cap_32.add(socket_posterior_fat_cap_posterior_fat_cap_surface_0);
  sockets["posterior-fat-cap:posterior-fat-cap-surface"] = socket_posterior_fat_cap_posterior_fat_cap_surface_0;
  // repetition system "aortic-branch-set": 3 authored elements are realized by showcase/src/demos/stylized-anatomical-heart/createStylizedAnatomicalHeartModelV2.ts; generic instancing is intentionally skipped.
  // repetition system "coronary-artery-network": 7 authored elements are realized by showcase/src/demos/stylized-anatomical-heart/createStylizedAnatomicalHeartModelV2.ts; generic instancing is intentionally skipped.
  // repetition system "coronary-vein-network": 8 authored elements are realized by showcase/src/demos/stylized-anatomical-heart/createStylizedAnatomicalHeartModelV2.ts; generic instancing is intentionally skipped.
  // repetition system "epicardial-fat-lobules": 77 authored elements are realized by showcase/src/demos/stylized-anatomical-heart/createStylizedAnatomicalHeartModelV2.ts; generic instancing is intentionally skipped.

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createStylizedAnatomicalHeartLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Stylized Anatomical Heart look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = ["key light: large warm-neutral area light from upper-left/anterior, intensity about 3.2 with soft shadow radius", "fill light: broad cool-neutral front/right fill at about 35 percent of key intensity", "rim/environment light: soft posterior-top hemisphere contribution separating vessel silhouettes", "exposure and tone mapping: ACES filmic tone mapping, exposure near 1.05, highlight roll-off preserving semi-gloss tissue", "contact shadow and AO: subtle local contact shadows at tissue/vessel/fat attachments; no reference pedestal geometry", "review background: neutral warm off-white only in the viewer scene, never part of the returned heart group"];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createStylizedAnatomicalHeartEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameStylizedAnatomicalHeartCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createStylizedAnatomicalHeartPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureStylizedAnatomicalHeartRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createStylizedAnatomicalHeartInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
