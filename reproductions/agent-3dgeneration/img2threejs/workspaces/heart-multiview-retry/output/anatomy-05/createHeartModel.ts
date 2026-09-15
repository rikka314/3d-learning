import * as THREE from 'three';
import { buildCoronaryAnatomy } from './coronaryAnatomy';
import layout from '../anatomy-layout.json';
import { createHeartMaterials, type MaterialId } from './heartMaterials';

type Runtime = {
  nodes: Record<string, THREE.Group>;
  meshes: Record<string, THREE.Mesh>;
  pivots: Record<string, THREE.Object3D>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, { type: string; halfExtents: number[] }>;
  destructionGroups: Record<string, string[]>;
};

const BUILD_PASS = 'anatomy-correction';
const Y_MIN = layout.bodyStations[0][0];
const Y_MAX = layout.bodyStations.at(-1)![0];
const TAU = Math.PI * 2;
const pixel = (x: number, y: number, z: number) => new THREE.Vector3((x - 560) / 280, (700 - y) / 280, z);

function bodyStation(y: number): number[] {
  const stations = layout.bodyStations;
  if (y <= Y_MIN) return [...stations[0]];
  if (y >= Y_MAX) return [...stations.at(-1)!];
  let index = 0;
  while (stations[index + 1][0] < y) index++;
  const t = (y - stations[index][0]) / (stations[index + 1][0] - stations[index][0]);
  const result = [y];
  for (let field = 1; field < 5; field++) {
    const a = stations[Math.max(0, index - 1)];
    const b = stations[index];
    const c = stations[index + 1];
    const d = stations[Math.min(stations.length - 1, index + 2)];
    const dy = c[0] - b[0];
    const m0 = (c[field] - a[field]) / (c[0] - a[0]);
    const m1 = (d[field] - b[field]) / (d[0] - b[0]);
    result.push((2 * t ** 3 - 3 * t ** 2 + 1) * b[field] + (t ** 3 - 2 * t ** 2 + t) * dy * m0
      + (-2 * t ** 3 + 3 * t ** 2) * c[field] + (t ** 3 - t ** 2) * dy * m1);
  }
  result[2] = Math.max(0.001, result[2]);
  result[3] = Math.max(0.001, result[3]);
  return result;
}

const anteriorAngle = (_y: number): number => 1.28;
const posteriorAngle = (_y: number): number => 4.08;

function surfaceAt(y: number, theta: number, offset = 0): THREE.Vector3 {
  const [, cx, rx, rz, cz] = bodyStation(y);
  const angleDistance = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  const iv = Math.exp(-((angleDistance(theta, anteriorAngle(y)) / 0.065) ** 2))
    + Math.exp(-((angleDistance(theta, posteriorAngle(y)) / 0.065) ** 2));
  const avHeight = -0.07 + 0.30 * Math.sin(theta);
  const av = Math.exp(-(((y - avHeight) / 0.070) ** 2));
  const depth = (y < 0.28 ? 0.028 * iv : 0) + 0.035 * av;
  const radial = offset - depth * Math.min(1, rx / 0.2);
  return new THREE.Vector3(cx + (rx + radial) * Math.cos(theta), y,
    cz + (rz + radial) * Math.sin(theta));
}

function bodyGeometry(): THREE.BufferGeometry {
  const rows = 84;
  const sides = 96;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= rows; row++) {
    const v = row / rows;
    const y = THREE.MathUtils.lerp(Y_MIN, Y_MAX, v);
    for (let side = 0; side <= sides; side++) {
      const theta = side / sides * TAU;
      positions.push(...surfaceAt(y, theta).toArray());
      uvs.push(side / sides, v);
    }
  }
  for (let row = 0; row < rows; row++) {
    for (let side = 0; side < sides; side++) {
      const a = row * (sides + 1) + side;
      const b = a + sides + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  // Actual end caps, rather than an open loft concealed by the review camera.
  for (const [row, bottom] of [[0, true], [rows, false]] as const) {
    const y = bottom ? Y_MIN : Y_MAX;
    const [, cx, , , cz] = bodyStation(y);
    const center = positions.length / 3;
    positions.push(cx, y, cz);
    uvs.push(0.5, bottom ? 0 : 1);
    for (let side = 0; side < sides; side++) {
      const a = row * (sides + 1) + side;
      if (bottom) indices.push(center, a, a + 1);
      else indices.push(center, a + 1, a);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function tubeGeometry(curve: THREE.Curve<THREE.Vector3>, radii: number[], segments: number, sides: number): THREE.TubeGeometry {
  const geometry = new THREE.TubeGeometry(curve, segments, 1, sides, false);
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  for (let row = 0; row <= segments; row++) {
    const t = row / segments;
    const center = curve.getPointAt(t);
    const p = t * (radii.length - 1);
    const lo = Math.min(Math.floor(p), radii.length - 2);
    const radius = THREE.MathUtils.lerp(radii[lo], radii[lo + 1], p - lo);
    for (let side = 0; side <= sides; side++) {
      const i = row * (sides + 1) + side;
      positions.setXYZ(i, center.x + normals.getX(i) * radius, center.y + normals.getY(i) * radius,
        center.z + normals.getZ(i) * radius);
    }
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function createHeartModel(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'heart-multiview-retry';
  root.scale.z = layout.depthScale;
  const { materials, ready } = createHeartMaterials();
  root.userData.materialReady = ready;
  const runtime: Runtime = { nodes: {}, meshes: {}, pivots: {}, sockets: {}, colliders: {}, destructionGroups: {} };

  function group(id: string, name: string, parent: THREE.Object3D = root): THREE.Group {
    const node = new THREE.Group();
    node.name = id;
    node.userData.sculptComponent = { id, name, nameZh: name };
    parent.add(node);
    runtime.nodes[id] = node;
    runtime.pivots[id] = node;
    return node;
  }

  function mesh(id: string, parent: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
    if (material.name === 'myocardium' || material.name === 'atrial') {
      const uv = geometry.getAttribute('uv');
      // A continuous, deterministic tissue flow breaks the repeated source patch's rectangular grid.
      // Periodic U terms keep both copies of the longitudinal seam aligned.
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i), v = uv.getY(i);
        uv.setXY(i, u + 0.035 * Math.sin(TAU * v * 0.73)
          + 0.008 * Math.sin(TAU * (u * 4 + v * 3.1)),
        v + 0.028 * Math.sin(TAU * (u * 3 + v * 0.71))
          + 0.009 * Math.sin(TAU * (u * 7 + v * 0.4)));
      }
    }
    geometry.computeBoundingSphere();
    const visual = new THREE.Mesh(geometry, material);
    visual.name = id;
    visual.userData.explodeWithParent = true;
    parent.add(visual);
    runtime.meshes[id] = visual;
    return visual;
  }

  const body = group('ventricular-body', '心室肌性主体');
  const envelope = bodyGeometry();
  root.userData.ventricularEnvelope = envelope;
  // One closed surface, partitioned by triangle indices for semantic selection. No duplicate shell.
  const partitions: Record<string, number[]> = { 'left-ventricle': [], 'right-ventricle': [] };
  const position = envelope.getAttribute('position');
  const sourceIndex = envelope.getIndex()!;
  for (let i = 0; i < sourceIndex.count; i += 3) {
    const ids = [sourceIndex.getX(i), sourceIndex.getX(i + 1), sourceIndex.getX(i + 2)];
    const center = new THREE.Vector3();
    for (const index of ids) center.add(new THREE.Vector3().fromBufferAttribute(position, index));
    center.multiplyScalar(1 / 3);
    const [, cx, rx, rz, cz] = bodyStation(center.y);
    const theta = (Math.atan2((center.z - cz) / rz, (center.x - cx) / rx) + TAU) % TAU;
    const right = center.y > -2.02 && theta >= anteriorAngle(center.y) && theta <= posteriorAngle(center.y);
    partitions[right ? 'right-ventricle' : 'left-ventricle'].push(...ids);
  }
  for (const [id, indices] of Object.entries(partitions)) {
    const node = group(id, id === 'left-ventricle' ? '左心室（外表面）' : '右心室（外表面）', body);
    const geometry = envelope.clone();
    geometry.setIndex(indices);
    mesh(`${id}-surface`, node, geometry, materials.myocardium);
    node.userData.anatomy = { kind: 'ventricular-surface-region', chamber: id, internalLumenModeled: false };
  }

  const atria = group('atrial-complex', '心房与心耳');
  function ellipsoid(id: string, label: string, center: THREE.Vector3, scale: THREE.Vector3, rotation: number, appendageOf: string | null): THREE.Group {
    const host = appendageOf ? runtime.nodes[appendageOf] : atria;
    if (!host) throw new Error(`Missing atrial host ${appendageOf}`);
    const node = group(id, label, host);
    host.updateWorldMatrix(true, false);
    root.updateWorldMatrix(true, false);
    node.position.copy(host.worldToLocal(root.localToWorld(center.clone())));
    node.rotation.z = rotation - (appendageOf ? host.rotation.z : 0);
    node.userData.anatomy = { kind: appendageOf ? 'atrial-appendage' : 'atrial-surface', appendageOf };
    const geometry = new THREE.SphereGeometry(1, 48, 32);
    const positions = geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
      const angle = Math.atan2(z, x);
      const auricle = id.includes('auricle');
      const amplitude = auricle ? 0.045 : 0.023;
      const ripple = 1 + amplitude * Math.sin(angle * 10 + y * 7) * (1 - y * y)
        + amplitude * 0.45 * Math.cos(y * 18 + angle * 5);
      const taper = auricle ? 0.87 + 0.13 * y : 1;
      positions.setXYZ(i, x * ripple * taper, y, z * ripple);
    }
    geometry.scale(scale.x, scale.y, scale.z);
    geometry.computeVertexNormals();
    mesh(`${id}-surface`, node, geometry, materials.atrial);
    return node;
  }
  for (const part of layout.atria) {
    ellipsoid(part.id, part.label, new THREE.Vector3().fromArray(part.center),
      new THREE.Vector3().fromArray(part.scale), part.rotation, part.appendageOf);
  }

  const assemblies: Record<string, THREE.Group> = {
    'aortic-system': group('aortic-system', '主动脉系统'),
    'pulmonary-arterial-system': group('pulmonary-arterial-system', '肺动脉系统'),
    'vena-cava-system': group('vena-cava-system', '上下腔静脉'),
    'pulmonary-return-system': group('pulmonary-return-system', '肺静脉回流'),
  };
  for (const vessel of layout.greatVessels) {
    const points = vessel.points.map(([x, y, z]) => pixel(x, y, z));
    const radii = [...vessel.radii];
    const node = group(vessel.id, vessel.label, assemblies[vessel.parent]);
    const origin = points[0].clone();
    node.position.copy(origin);
    node.userData.anatomy = { kind: vessel.vesselKind, origin: vessel.origin,
      drainsTo: vessel.vesselKind === 'vein' ? vessel.origin : undefined,
      distalCut: vessel.open, internalConnection: 'external embedding only; lumen not modeled' };
    const curve = new THREE.CatmullRomCurve3(points.map((p) => p.sub(origin)), false, 'centripetal');
    const material = materials[vessel.color as MaterialId];
    mesh(`${vessel.id}-wall`, node, tubeGeometry(curve, radii, 60, 24), material);
    if (vessel.open) {
      const radius = vessel.radii.at(-1)!;
      const tip = curve.getPoint(1);
      const tangent = curve.getTangent(1).normalize();
      const rim = mesh(`${vessel.id}-rim`, node, new THREE.RingGeometry(radius * 0.80, radius, 48), material);
      rim.position.copy(tip);
      rim.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
      const dark = new THREE.MeshStandardMaterial({ name: `${vessel.color}-lumen`,
        color: vessel.color === 'venous' ? 0x102a50 : 0x551611, roughness: 0.65, side: THREE.DoubleSide });
      // A recessed bore with actual walls; the end floor sits inside the vessel.
      const boreLength = radius * 1.65;
      const inner = mesh(`${vessel.id}-inner-wall`, node,
        new THREE.CylinderGeometry(radius * 0.80, radius * 0.76, boreLength, 48, 1, true), dark);
      inner.position.copy(tip).addScaledVector(tangent, -boreLength / 2);
      inner.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
      const lumen = mesh(`${vessel.id}-lumen`, node, new THREE.CircleGeometry(radius * 0.78, 48), dark);
      lumen.position.copy(tip).addScaledVector(tangent, -boreLength);
      lumen.quaternion.copy(rim.quaternion);
    }
    const socket = new THREE.Object3D();
    socket.name = `${vessel.id}-root-socket`;
    node.add(socket);
    runtime.sockets[vessel.id] = socket;
  }

  buildCoronaryAnatomy({ group, mesh, materials, tubeGeometry, surfaceAt, anteriorAngle, posteriorAngle });

  root.updateMatrixWorld(true);
  for (const [id, node] of Object.entries(runtime.nodes)) {
    const size = new THREE.Box3().setFromObject(node).getSize(new THREE.Vector3()).multiplyScalar(0.5);
    runtime.colliders[id] = { type: 'box', halfExtents: size.toArray() };
    runtime.destructionGroups[id] = node.children.filter((c) => c instanceof THREE.Mesh).map((c) => c.name);
  }
  root.userData.sculptRuntime = runtime;
  root.userData.buildPass = BUILD_PASS;
  root.userData.source = 'reference-sheet.png — four user-supplied illustrated views; uncalibrated depth and fine vessels approximate';
  root.userData.anatomySources = ['OpenStax 19.1 Heart Anatomy', 'NCBI NBK547680', 'NCBI NBK549786'];
  root.userData.anatomyScope = 'Adult external heart; right-dominant coronary schematic; valves/septa/lumens not modeled';
  root.userData.actionReadiness = { clickable: true, explodable: true, mode: 'static external visualization' };
  return root;
}
