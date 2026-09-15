import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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

const BUILD_PASS = 'optimization-pass';
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

function randomSeed(seed: number): () => number {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
}

function surfaceDepth(x: number, y: number, front = true): number {
  const [, cx, rx, rz, cz] = bodyStation(y);
  const nx = THREE.MathUtils.clamp((x - cx) / rx, -1, 1);
  const arc = Math.sqrt(Math.max(0, 1 - nx * nx));
  return cz + (front ? 1 : -1) * rz * arc;
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
    const [, cx, rx, rz, cz] = bodyStation(y);
    for (let side = 0; side <= sides; side++) {
      const theta = side / sides * TAU;
      positions.push(cx + rx * Math.cos(theta), y, cz + rz * Math.sin(theta));
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

class SurfaceCurve extends THREE.Curve<THREE.Vector3> {
  private readonly path: THREE.CatmullRomCurve3;
  constructor(points: number[][], private readonly offset: number, private readonly front = true) {
    super();
    this.path = new THREE.CatmullRomCurve3(points.map(([x, y]) => pixel(x, y, 0)), false, 'centripetal');
  }
  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    this.path.getPoint(t, target);
    target.y = THREE.MathUtils.clamp(target.y, Y_MIN + 0.025, Y_MAX - 0.03);
    const [, cx, rx] = bodyStation(target.y);
    target.x = THREE.MathUtils.clamp(target.x, cx - rx * 0.97, cx + rx * 0.97);
    target.z = surfaceDepth(target.x, target.y, this.front) + this.offset * (this.front ? 1 : -1);
    return target;
  }
}

export function createHeartModel(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'heart-reference-retry';
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
  mesh('ventricular-body-surface', body, bodyGeometry(), materials.myocardium);

  const atria = group('atrial-complex', '心房与心耳');
  function ellipsoid(id: string, label: string, center: THREE.Vector3, scale: THREE.Vector3, rotation: number): THREE.Group {
    const node = group(id, label, atria);
    node.position.copy(center);
    node.rotation.z = rotation;
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
  ellipsoid('right-atrium', '右心房', pixel(275, 599, -0.05), new THREE.Vector3(0.37, 0.73, 0.38), -0.12);
  ellipsoid('left-atrium', '左心房（后方部分推断）', pixel(678, 449, -0.28), new THREE.Vector3(0.37, 0.38, 0.40), 0.1);
  ellipsoid('right-auricle', '右心耳', pixel(320, 543, 0.34), new THREE.Vector3(0.40, 0.43, 0.27), -0.43);
  ellipsoid('left-auricle', '左心耳', pixel(752, 486, 0.58), new THREE.Vector3(0.46, 0.27, 0.24), -0.72);

  const assemblies: Record<string, THREE.Group> = {
    'aortic-system': group('aortic-system', '主动脉系统'),
    'pulmonary-arterial-system': group('pulmonary-arterial-system', '肺动脉系统'),
    'vena-cava-system': group('vena-cava-system', '上下腔静脉'),
    'pulmonary-return-system': group('pulmonary-return-system', '肺静脉回流'),
  };
  for (const vessel of layout.greatVessels) {
    const points = vessel.points.map(([x, y, z]) => pixel(x, y, z));
    const radii = [...vessel.radii];
    // Bury the roots inside the ventricular envelope, keeping the measured visible path intact.
    if (vessel.id === 'pulmonary-trunk') { points.unshift(pixel(516, 564, 0.20)); radii.unshift(0.14); }
    if (vessel.id === 'aortic-arch') { points.unshift(pixel(456, 540, -0.20)); radii.unshift(0.15); }
    const node = group(vessel.id, vessel.label, assemblies[vessel.parent]);
    const origin = points[0].clone();
    node.position.copy(origin);
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

  const coronaries = group('coronary-network', '冠状动静脉');
  const fat = group('epicardial-fat', '心外膜脂肪');
  const pathData = layout.coronaryPathsPixels;
  const coronaryPaths = [
    { id: 'anterior-coronary-trunk', label: '前室间沟冠状血管', path: pathData.anterior, front: true },
    { id: 'right-coronary-wrap', label: '右冠状血管', path: pathData.right, front: true },
    { id: 'circumflex-coronary-wrap', label: '回旋支冠状血管', path: pathData.circumflex, front: true },
    { id: 'posterior-coronary-inference', label: '后方冠脉（推断）', path: pathData.posterior, front: false },
  ];
  for (const item of coronaryPaths) {
    const node = group(item.id, item.label, coronaries);
    const path = new SurfaceCurve(item.path, item.front ? 0.060 : 0.008, item.front);
    mesh(`${item.id}-artery`, node, tubeGeometry(path, [0.030, 0.024, 0.018, 0.005], 88, 9), materials.coronaryRed);
    const shifted = item.path.map(([x, y]) => [x + 12, y + 2]);
    const vein = new SurfaceCurve(shifted, item.front ? 0.058 : 0.007, item.front);
    mesh(`${item.id}-vein`, node, tubeGeometry(vein, [0.023, 0.022, 0.014, 0.004], 88, 9), materials.coronaryBlue);

    const rng = randomSeed(714 + item.id.length * 87);
    const branches: THREE.BufferGeometry[][] = [[], []];
    const major = new THREE.CatmullRomCurve3(item.path.map(([x, y]) => new THREE.Vector3(x, y, 0)));
    const count = item.front ? 22 : 12;
    for (let i = 0; i < count; i++) {
      const t = 0.12 + (i / count) * 0.76;
      const start = major.getPoint(t);
      const direction = i % 2 ? 1 : -1;
      const span = 48 + rng() * 117;
      const drop = 25 + rng() * 104;
      const artery = i % 3 !== 0;
      const startX = start.x + (artery ? 0 : 12);
      const branchPoints = [[startX, start.y], [startX + direction * span * 0.30, start.y + drop * 0.17],
        [startX + direction * span * 0.73, start.y + drop * 0.54], [startX + direction * span, start.y + drop]];
      const branch = new SurfaceCurve(branchPoints, 0.009, item.front);
      // The short root collar rises to the parent vessel, then settles into the myocardium.
      const getPoint = branch.getPoint.bind(branch);
      branch.getPoint = (u, target) => {
        const p = getPoint(u, target);
        p.z += (item.front ? 1 : -1) * (item.front ? 0.051 : 0) * Math.exp(-u * 22);
        return p;
      };
      const radius = artery ? 0.0105 : 0.008;
      branches[artery ? 0 : 1].push(tubeGeometry(branch, [radius, radius * 0.80, 0.002], 30, 6));
      if (i % 2 === 0) {
        const middle = branchPoints[2];
        const twig = new SurfaceCurve([middle, [middle[0] + direction * span * 0.17, middle[1] + 31],
          [middle[0] + direction * span * 0.21, middle[1] + 67]], 0.004, item.front);
        branches[artery ? 0 : 1].push(tubeGeometry(twig, [radius * 0.5, 0.001], 18, 6));
      }
    }
    branches.forEach((items, index) => {
      const merged = mergeGeometries(items);
      if (!merged) throw new Error(`Cannot merge coronary branches: ${item.id}`);
      mesh(`${item.id}-${index ? 'venous' : 'arterial'}-branches`, node, merged,
        index ? materials.coronaryBlue : materials.coronaryRed);
      items.forEach((geometry) => geometry.dispose());
    });
  }
  const fatPaths = [
    { id: 'interventricular-fat-band', label: '前室间沟脂肪带', path: pathData.anterior, radius: 0.106 },
    { id: 'right-coronary-fat-band', label: '右冠状沟脂肪带', path: pathData.right, radius: 0.11 },
    { id: 'atrioventricular-fat-band', label: '房室沟脂肪带', path: pathData.circumflex, radius: 0.085 },
  ];
  for (const item of fatPaths) {
    const node = group(item.id, item.label, fat);
    const curve = new SurfaceCurve(item.path, -0.024);
    const bedSegments = 90, bedSides = 12;
    const bed = tubeGeometry(curve, [item.radius, item.radius * 0.96, item.radius * 0.5], bedSegments, bedSides);
    const bedPosition = bed.getAttribute('position');
    for (let row = 0; row <= bedSegments; row++) {
      const center = curve.getPointAt(row / bedSegments);
      for (let side = 0; side <= bedSides; side++) {
        const vertex = row * (bedSides + 1) + side;
        bedPosition.setZ(vertex, center.z + (bedPosition.getZ(vertex) - center.z) * 0.45);
      }
    }
    bed.computeVertexNormals();
    mesh(`${item.id}-bed`, node, bed, materials.fat);
    const rng = randomSeed(item.id.length * 397);
    const count = item.id === 'atrioventricular-fat-band' ? 130 : 370;
    const lobules = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 5), materials.fat, count);
    const transform = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const t = (i + rng()) / count;
      const center = curve.getPoint(t);
      const width = item.radius * (1 - 0.36 * t);
      const x = center.x + (rng() - 0.5) * width * 2.7;
      const y = center.y + (rng() - 0.5) * 0.075;
      transform.position.set(x, y, surfaceDepth(x, y) + 0.025);
      transform.scale.set(0.027 + rng() * 0.024, 0.043 + rng() * 0.030, 0.018 + rng() * 0.015);
      transform.rotation.set((rng() - 0.5) * 0.5, (rng() - 0.5) * 0.5, (rng() - 0.5) * 1.5);
      transform.updateMatrix();
      lobules.setMatrixAt(i, transform.matrix);
      lobules.setColorAt(i, new THREE.Color().setHSL(0.07 + rng() * 0.025, 0.12 + rng() * 0.12, 0.82 + rng() * 0.15));
    }
    lobules.name = `${item.id}-lobules`;
    lobules.userData.explodeWithParent = true;
    node.add(lobules);
    runtime.meshes[lobules.name] = lobules;
  }

  const upperFat = runtime.nodes['atrioventricular-fat-band'];
  const collarPath = new SurfaceCurve([[449, 591], [478, 554], [528, 534], [588, 551], [663, 593], [736, 616]], -0.01);
  const collar = tubeGeometry(collarPath, [0.06, 0.085, 0.085, 0.045], 100, 14);
  const collarPositions = collar.getAttribute('position');
  for (let i = 0; i < collarPositions.count; i++) {
    const x = collarPositions.getX(i), y = collarPositions.getY(i);
    collarPositions.setZ(i, surfaceDepth(x, y) + (collarPositions.getZ(i) - surfaceDepth(x, y)) * 0.42);
  }
  collar.computeVertexNormals();
  mesh('superior-fat-collar', upperFat, collar, materials.fat);

  root.updateMatrixWorld(true);
  for (const [id, node] of Object.entries(runtime.nodes)) {
    const size = new THREE.Box3().setFromObject(node).getSize(new THREE.Vector3()).multiplyScalar(0.5);
    runtime.colliders[id] = { type: 'box', halfExtents: size.toArray() };
    runtime.destructionGroups[id] = node.children.filter((c) => c instanceof THREE.Mesh).map((c) => c.name);
  }
  root.userData.sculptRuntime = runtime;
  root.userData.buildPass = BUILD_PASS;
  root.userData.source = 'reference.png — single supplied image; unseen depth and posterior anatomy inferred';
  root.userData.actionReadiness = { clickable: true, explodable: true, mode: 'static external visualization' };
  return root;
}
