import * as THREE from 'three';
import layout from '../anatomy-layout.json';

type MaterialId = 'myocardium' | 'arterial' | 'venous' | 'atrial' | 'fat' | 'coronaryRed' | 'coronaryBlue';
type Runtime = {
  nodes: Record<string, THREE.Group>;
  meshes: Record<string, THREE.Mesh>;
  pivots: Record<string, THREE.Object3D>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, { type: string; halfExtents: number[] }>;
  destructionGroups: Record<string, string[]>;
};

const BUILD_PASS = 'structural-pass';
const Y_MIN = layout.bodyStations[0][0];
const Y_MAX = layout.bodyStations.at(-1)![0];
const TAU = Math.PI * 2;
const pixel = (x: number, y: number, z: number) => new THREE.Vector3((x - 560) / 280, (700 - y) / 280, z);

function cubic(a: number, b: number, c: number, d: number, t: number): number {
  return b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
}

function bodyStation(y: number): number[] {
  const stations = layout.bodyStations;
  if (y <= Y_MIN) return [...stations[0]];
  if (y >= Y_MAX) return [...stations.at(-1)!];
  let index = 0;
  while (stations[index + 1][0] < y) index++;
  const t = (y - stations[index][0]) / (stations[index + 1][0] - stations[index][0]);
  const result = [y];
  for (let field = 1; field < 5; field++) {
    result.push(cubic(stations[Math.max(0, index - 1)][field], stations[index][field],
      stations[index + 1][field], stations[Math.min(stations.length - 1, index + 2)][field], t));
  }
  result[2] = Math.max(0.001, result[2]);
  result[3] = Math.max(0.001, result[3]);
  return result;
}

function surfaceDepth(x: number, y: number, front = true): number {
  const [, cx, rx, rz, cz] = bodyStation(y);
  const nx = THREE.MathUtils.clamp((x - cx) / rx, -1, 1);
  const arc = Math.sqrt(Math.max(0, 1 - nx * nx));
  return cz + (front ? 1 : -1) * rz * arc;
}

function bodyGeometry(): THREE.BufferGeometry {
  const rows = 92;
  const sides = 112;
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

function makeMaterials(): Record<MaterialId, THREE.MeshPhysicalMaterial> {
  const palette: Record<MaterialId, number> = {
    myocardium: 0xc24b39, arterial: 0xc52c1d, venous: 0x386ccc, atrial: 0xb94f49,
    fat: 0xe19b50, coronaryRed: 0xd82917, coronaryBlue: 0x1d57a4,
  };
  return Object.fromEntries(Object.entries(palette).map(([id, color]) => [id,
    new THREE.MeshPhysicalMaterial({ name: id, color, roughness: 0.4, metalness: 0, clearcoat: 0.17,
      clearcoatRoughness: 0.36 }),
  ])) as Record<MaterialId, THREE.MeshPhysicalMaterial>;
}

export function createHeartModel(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'heart-reference-retry';
  const materials = makeMaterials();
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
    const geometry = new THREE.SphereGeometry(1, 56, 36);
    geometry.scale(scale.x, scale.y, scale.z);
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
    const node = group(vessel.id, vessel.label, assemblies[vessel.parent]);
    const origin = points[0].clone();
    node.position.copy(origin);
    const curve = new THREE.CatmullRomCurve3(points.map((p) => p.sub(origin)), false, 'centripetal');
    const material = materials[vessel.color as MaterialId];
    mesh(`${vessel.id}-wall`, node, tubeGeometry(curve, vessel.radii, 80, 32), material);
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
    const path = new SurfaceCurve(item.path, item.front ? 0.073 : 0.008, item.front);
    mesh(`${item.id}-artery`, node, tubeGeometry(path, [0.030, 0.024, 0.018, 0.005], 120, 12), materials.coronaryRed);
    const shifted = item.path.map(([x, y]) => [x + 12, y + 2]);
    const vein = new SurfaceCurve(shifted, item.front ? 0.07 : 0.007, item.front);
    mesh(`${item.id}-vein`, node, tubeGeometry(vein, [0.023, 0.022, 0.014, 0.004], 120, 12), materials.coronaryBlue);
  }
  const fatPaths = [
    { id: 'interventricular-fat-band', label: '前室间沟脂肪带', path: pathData.anterior, radius: 0.106 },
    { id: 'right-coronary-fat-band', label: '右冠状沟脂肪带', path: pathData.right, radius: 0.11 },
    { id: 'atrioventricular-fat-band', label: '房室沟脂肪带', path: pathData.circumflex, radius: 0.085 },
  ];
  for (const item of fatPaths) {
    const node = group(item.id, item.label, fat);
    const curve = new SurfaceCurve(item.path, -0.024);
    mesh(`${item.id}-bed`, node, tubeGeometry(curve, [item.radius, item.radius * 0.96, item.radius * 0.5], 130, 18), materials.fat);
  }

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
