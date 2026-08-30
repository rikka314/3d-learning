import * as THREE from 'three';

export type HeartModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureAnisotropy?: number;
};

type HeartRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  pivots: Record<string, THREE.Object3D>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, { type: string; radius?: number; halfExtents?: number[] } | number> & { length?: number };
  adjacency: Array<[string, string]>;
  destructionGroups: Record<string, string[]>;
  materials: Record<string, THREE.Material>;
  actionAnchors: Record<string, string>;
  attachmentGate: { passed: boolean; auditedNodes: number };
  attachmentAudit: {
    floatingRoots: string[];
    orphanSockets: string[];
    unresolvedActionAnchors: string[];
    unresolvedLogicalComponents: string[];
    invalidAdjacency: Array<[string, string]>;
    socketCount: number;
    adjacencyCount: number;
  };
  logicalComponents: Record<string, { kind: string; binding: string; boundMeshes: string[] }>;
};

type MaterialId = 'myocardium' | 'arterial' | 'venous' | 'coronary-artery' | 'coronary-vein' | 'epicardial-fat' | 'lumen';

const ASSET_ROOT = '/references/heart-multiview/material-evidence';
const UP = new THREE.Vector3(0, 0, 1);

function prepareGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const uv = geometry.getAttribute('uv');
  if (uv && !geometry.getAttribute('uv1')) geometry.setAttribute('uv1', uv.clone());
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function loadTissueTexture(
  loader: THREE.TextureLoader,
  id: Exclude<MaterialId, 'lumen'>,
  channel: 'roughness' | 'normal' | 'ao',
  anisotropy: number,
): THREE.Texture {
  const texture = loader.load(`${ASSET_ROOT}/${id}/${id}_${channel}.png`);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(id === 'coronary-artery' || id === 'coronary-vein' ? 2.5 : 1.35, 1.35);
  texture.anisotropy = anisotropy;
  return texture;
}

function makeMaterials(options: HeartModelOptions): Record<MaterialId, THREE.MeshPhysicalMaterial> {
  const loader = new THREE.TextureLoader();
  const anisotropy = options.textureAnisotropy ?? 8;
  const make = (
    id: Exclude<MaterialId, 'lumen'>,
    tint: number,
    roughness: number,
    clearcoat: number,
    normalScale: number,
  ): THREE.MeshPhysicalMaterial => {
    const referenceMaps = {
      albedoEvidenceUrl: `${ASSET_ROOT}/${id}/${id}_albedo.png`,
      roughness: loadTissueTexture(loader, id, 'roughness', anisotropy),
      normal: loadTissueTexture(loader, id, 'normal', anisotropy),
      ao: loadTissueTexture(loader, id, 'ao', anisotropy),
    };
    const material = new THREE.MeshPhysicalMaterial({
      name: id,
      color: tint,
      roughnessMap: referenceMaps.roughness,
      normalMap: referenceMaps.normal,
      aoMap: referenceMaps.ao,
      aoMapIntensity: 0.16,
      normalScale: new THREE.Vector2(normalScale * 0.25, normalScale * 0.25),
      roughness,
      metalness: 0,
      clearcoat,
      clearcoatRoughness: Math.min(0.7, roughness + 0.08),
      envMapIntensity: 0.72,
      wireframe: options.wireframe ?? false,
    });
    material.userData.referencePbrEvidence = {
      source: 'ReferenceSet material-region extraction',
      maps: referenceMaps,
      albedoUsage: 'Reference-derived palette tint; the low-resolution crop is retained as evidence but not tiled over the whole organ.',
    };
    return material;
  };

  return {
    myocardium: make('myocardium', 0xb94b55, 0.5, 0.18, 0.18),
    arterial: make('arterial', 0xd85b55, 0.34, 0.28, 0.14),
    venous: make('venous', 0x8a405f, 0.4, 0.2, 0.12),
    'coronary-artery': make('coronary-artery', 0xc8424b, 0.32, 0.22, 0.1),
    'coronary-vein': make('coronary-vein', 0x592342, 0.38, 0.18, 0.1),
    'epicardial-fat': make('epicardial-fat', 0xeaa08f, 0.43, 0.24, 0.16),
    lumen: new THREE.MeshPhysicalMaterial({
      name: 'lumen', color: 0x230711, roughness: 0.8, metalness: 0, side: THREE.DoubleSide,
    }),
  };
}

function heartBodyGeometry(): THREE.BufferGeometry {
  const radialSegments = 88;
  const verticalSegments = 44;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let iy = 0; iy <= verticalSegments; iy += 1) {
    const v = iy / verticalSegments;
    const smooth = v * v * (3 - 2 * v);
    const y = -1.55 + 2.33 * v;
    const sineTaper = Math.sin(v * Math.PI * 0.5);
    const apexT = Math.min(1, v / 0.12);
    const apexGate = 0.22 + 0.78 * apexT * apexT * (3 - 2 * apexT);
    const taper = Math.pow(sineTaper, 0.44) * apexGate;
    const shoulder = 0.88 + 0.16 * smooth;
    const lowerBelly = v < 0.65 ? 1 + 0.22 * Math.sin(Math.PI * v / 0.65) : 1;
    const midBelly = 1 + 0.12 * Math.exp(-Math.pow((v - 0.58) / 0.14, 2));
    const rx = (0.025 + 0.99 * taper) * shoulder * lowerBelly * midBelly;
    const rz = (0.025 + 0.73 * taper) * (0.92 + 0.1 * Math.sin(v * Math.PI));
    const apexShiftT = Math.min(1, v / 0.2);
    const apexShift = 0.15 * (1 - apexShiftT * apexShiftT * (3 - 2 * apexShiftT));
    const xOffset = 0.42 * Math.pow(1 - v, 1.7) + 0.01 * Math.sin(v * Math.PI) + apexShift;
    const zOffset = -0.04 + 0.11 * Math.sin(v * Math.PI);

    for (let ix = 0; ix <= radialSegments; ix += 1) {
      const u = ix / radialSegments;
      const angle = u * Math.PI * 2;
      const anteriorBulge = Math.max(0, Math.sin(angle)) * 0.1 * Math.sin(v * Math.PI);
      const rightWrap = Math.max(0, -Math.cos(angle)) * 0.07 * Math.sin(v * Math.PI);
      const organic = 1 + 0.022 * Math.sin(angle * 3 + v * 7) + 0.012 * Math.sin(angle * 7 - v * 5);
      positions.push(
        xOffset + Math.cos(angle) * rx * organic + rightWrap,
        y + 0.025 * Math.sin(angle * 2) * Math.sin(v * Math.PI),
        zOffset + Math.sin(angle) * rz * organic + anteriorBulge,
      );
      uvs.push(u, v);
    }
  }

  for (let iy = 0; iy < verticalSegments; iy += 1) {
    for (let ix = 0; ix < radialSegments; ix += 1) {
      const a = iy * (radialSegments + 1) + ix;
      const b = a + radialSegments + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

function ellipsoidGeometry(scale: THREE.Vector3, segments = 48): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(1, segments, Math.max(24, Math.floor(segments * 0.65)));
  geometry.scale(scale.x, scale.y, scale.z);
  return geometry;
}

function makeNode(
  root: THREE.Group,
  runtime: HeartRuntime,
  id: string,
  role: string,
  parentId?: string,
): THREE.Group {
  const node = new THREE.Group();
  node.name = id;
  node.userData.sculptComponent = { id, role, semantic: true };
  node.userData.actionProfile = {
    animationRole: id === 'ventricular-body' ? 'root' : 'semantic-part',
    transformChannels: { rotate: true, scale: true, visibility: true, detach: id !== 'ventricular-body' },
  };
  (parentId ? runtime.nodes[parentId] ?? root : root).add(node);
  runtime.nodes[id] = node;
  runtime.pivots[id] = node;
  if (parentId) runtime.adjacency.push([parentId, id]);
  runtime.destructionGroups[id] = [id];
  return node;
}

function registerMesh(
  node: THREE.Group,
  runtime: HeartRuntime,
  id: string,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  options: HeartModelOptions,
): THREE.Mesh {
  const mesh = new THREE.Mesh(prepareGeometry(geometry), material);
  mesh.name = id;
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  mesh.userData.sculptComponent = { id, semantic: true };
  mesh.userData.selectionOwner = node;
  node.userData.selectablePart = true;
  node.add(mesh);
  runtime.meshes[id] = mesh;
  return mesh;
}

function addEllipsoid(
  root: THREE.Group,
  runtime: HeartRuntime,
  id: string,
  role: string,
  position: THREE.Vector3,
  scale: THREE.Vector3,
  rotation: THREE.Euler,
  material: THREE.Material,
  options: HeartModelOptions,
  parentId?: string,
): THREE.Group {
  const node = makeNode(root, runtime, id, role, parentId);
  node.position.copy(position);
  node.rotation.copy(rotation);
  registerMesh(node, runtime, id, ellipsoidGeometry(scale), material, options);
  runtime.colliders[id] = { type: 'ellipsoid', halfExtents: scale.toArray() };
  return node;
}

function orientDisc(object: THREE.Object3D, outward: THREE.Vector3): void {
  object.quaternion.setFromUnitVectors(UP, outward.clone().normalize());
}

function addMouth(
  vessel: THREE.Object3D,
  point: THREE.Vector3,
  outward: THREE.Vector3,
  radius: number,
  wallMaterial: THREE.Material,
  lumenMaterial: THREE.Material,
  options: HeartModelOptions,
): void {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(radius * 0.67, radius * 1.06, 40),
    wallMaterial,
  );
  ring.name = `${vessel.name}-mouth-wall`;
  ring.userData.explodeWithParent = true;
  ring.position.copy(point).addScaledVector(outward, 0.006);
  orientDisc(ring, outward);
  ring.castShadow = options.castShadow ?? true;
  vessel.add(ring);

  const lumen = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.68, 40), lumenMaterial);
  lumen.name = `${vessel.name}-lumen`;
  lumen.userData.explodeWithParent = true;
  lumen.position.copy(point).addScaledVector(outward, -0.01);
  orientDisc(lumen, outward);
  vessel.add(lumen);
}

function addTube(
  root: THREE.Group,
  runtime: HeartRuntime,
  id: string,
  role: string,
  rawPoints: readonly (readonly [number, number, number])[],
  radius: number,
  material: THREE.Material,
  lumenMaterial: THREE.Material,
  options: HeartModelOptions,
  mouths: 'none' | 'start' | 'end' | 'both' = 'none',
  parentId?: string,
): THREE.Group {
  const node = makeNode(root, runtime, id, role, parentId);
  const origin = new THREE.Vector3(...rawPoints[0]);
  const points = rawPoints.map(([x, y, z]) => new THREE.Vector3(x, y, z).sub(origin));
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.45);
  node.position.copy(origin);
  const geometry = new THREE.TubeGeometry(curve, Math.max(36, points.length * 18), radius, radius < 0.035 ? 10 : 20, false);
  const mesh = registerMesh(node, runtime, id, geometry, material, options);
  if (mouths === 'start' || mouths === 'both') addMouth(mesh, points[0], curve.getTangent(0).negate(), radius, material, lumenMaterial, options);
  if (mouths === 'end' || mouths === 'both') addMouth(mesh, points[points.length - 1], curve.getTangent(1), radius, material, lumenMaterial, options);
  runtime.colliders[id] = { type: 'tube', radius };
  return node;
}

function addFatCluster(
  root: THREE.Group,
  runtime: HeartRuntime,
  id: string,
  center: THREE.Vector3,
  width: number,
  depth: number,
  count: number,
  material: THREE.Material,
  options: HeartModelOptions,
  parentId: string,
  phase: number,
  sizeScale = 1,
): THREE.Group {
  const node = makeNode(root, runtime, id, 'fat-pad', parentId);
  node.position.copy(center);
  const shared = new THREE.SphereGeometry(1, 24, 16);
  const lobes = new THREE.InstancedMesh(shared, material, count);
  const transform = new THREE.Object3D();
  for (let index = 0; index < count; index += 1) {
    const t = count === 1 ? 0.5 : index / (count - 1);
    const row = index % 3;
    const angle = phase + t * Math.PI * 1.15;
    const size = (0.11 + 0.035 * (0.5 + 0.5 * Math.sin(index * 2.37 + phase))) * sizeScale;
    transform.position.set(
      Math.cos(angle) * width * (0.55 + row * 0.08),
      (row - 1) * 0.09 + 0.05 * Math.sin(index * 1.7),
      Math.sin(angle) * depth * (0.52 + row * 0.08),
    );
    transform.scale.set(size * (1.15 + 0.1 * row), size * 0.75, size * (0.88 + 0.08 * row));
    transform.rotation.set(index * 0.19, angle, index * 0.13);
    transform.updateMatrix();
    lobes.setMatrixAt(index, transform.matrix);
  }
  lobes.name = id;
  lobes.userData.sculptComponent = { id, semantic: true, repeatedInstances: count };
  lobes.castShadow = options.castShadow ?? true;
  lobes.receiveShadow = options.receiveShadow ?? true;
  lobes.instanceMatrix.needsUpdate = true;
  lobes.userData.selectionOwner = node;
  node.userData.selectablePart = true;
  node.add(lobes);
  runtime.meshes[id] = lobes;
  runtime.colliders[id] = { type: 'cluster', halfExtents: [width, 0.35, depth] };
  return node;
}

function addSocket(runtime: HeartRuntime, parentId: string, socketId: string, position: THREE.Vector3): void {
  const socket = new THREE.Object3D();
  socket.name = socketId;
  socket.position.copy(position);
  socket.userData.socket = { id: socketId };
  runtime.pivots[parentId].add(socket);
  runtime.sockets[`${parentId}:${socketId}`] = socket;
}

function auditRuntimeAttachments(root: THREE.Group, runtime: HeartRuntime): void {
  const semanticNodes = new Set(Object.values(runtime.nodes));
  const actionPivots = new Set(Object.values(runtime.pivots));
  const floatingRoots = Object.entries(runtime.nodes)
    .filter(([, node]) => node.parent !== root && (!node.parent || !semanticNodes.has(node.parent)))
    .map(([id]) => id);
  const orphanSockets = Object.entries(runtime.sockets)
    .filter(([, socket]) => !socket.parent || (!semanticNodes.has(socket.parent) && !actionPivots.has(socket.parent)))
    .map(([id]) => id);
  const unresolvedActionAnchors = Object.entries(runtime.actionAnchors)
    .filter(([, socketKey]) => !runtime.sockets[socketKey])
    .map(([id]) => id);
  const unresolvedLogicalComponents = Object.entries(runtime.logicalComponents)
    .filter(([id, component]) => {
      if (component.kind === 'logical-alias') return false;
      const pivot = runtime.pivots[id];
      if (!pivot) return true;
      return component.boundMeshes.some((meshId) => {
        if (!runtime.meshes[meshId]) return true;
        let node: THREE.Object3D | null = runtime.nodes[meshId] ?? null;
        while (node && node !== root) {
          if (node === pivot) return false;
          node = node.parent;
        }
        return true;
      });
    })
    .map(([id]) => id);
  const invalidAdjacency = runtime.adjacency.filter(
    ([parentId, childId]) => !runtime.nodes[parentId] || !runtime.nodes[childId] || runtime.nodes[childId].parent !== runtime.nodes[parentId],
  );

  runtime.attachmentAudit = {
    floatingRoots,
    orphanSockets,
    unresolvedActionAnchors,
    unresolvedLogicalComponents,
    invalidAdjacency,
    socketCount: Object.keys(runtime.sockets).length,
    adjacencyCount: runtime.adjacency.length,
  };
  runtime.attachmentGate = {
    passed: floatingRoots.length === 0
      && orphanSockets.length === 0
      && unresolvedActionAnchors.length === 0
      && unresolvedLogicalComponents.length === 0
      && invalidAdjacency.length === 0,
    auditedNodes: Object.keys(runtime.nodes).length,
  };
}

export function createStylizedAnatomicalHeartModelV2(options: HeartModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'Stylized Anatomical Heart';
  root.rotation.y = -0.06;
  root.scale.x = 1.28;

  const materials = makeMaterials(options);
  const runtime: HeartRuntime = {
    nodes: {}, meshes: {}, pivots: {}, sockets: {}, colliders: {}, adjacency: [],
    destructionGroups: {}, materials, actionAnchors: {},
    attachmentGate: { passed: false, auditedNodes: 0 },
    attachmentAudit: {
      floatingRoots: [], orphanSockets: [], unresolvedActionAnchors: [], unresolvedLogicalComponents: [], invalidAdjacency: [],
      socketCount: 0, adjacencyCount: 0,
    },
    logicalComponents: {},
  };

  const ventricular = makeNode(root, runtime, 'ventricular-body', 'body');
  registerMesh(ventricular, runtime, 'ventricular-body', heartBodyGeometry(), materials.myocardium, options);
  runtime.colliders['ventricular-body'] = { type: 'ellipsoid', halfExtents: [1.02, 1.55, 0.82] };

  addEllipsoid(root, runtime, 'right-ventricular-wrap', 'body', new THREE.Vector3(-0.25, -0.12, 0.2), new THREE.Vector3(0.56, 0.78, 0.43), new THREE.Euler(0.05, -0.12, -0.16), materials.myocardium, options, 'ventricular-body');
  addEllipsoid(root, runtime, 'left-ventricular-mass', 'body', new THREE.Vector3(0.24, -0.31, -0.01), new THREE.Vector3(0.61, 0.9, 0.54), new THREE.Euler(-0.03, 0.08, 0.11), materials.myocardium, options, 'ventricular-body');

  makeNode(root, runtime, 'atrial-complex', 'body', 'ventricular-body');
  addEllipsoid(root, runtime, 'right-atrium', 'body', new THREE.Vector3(-0.52, 0.66, -0.03), new THREE.Vector3(0.54, 0.46, 0.52), new THREE.Euler(-0.1, 0.08, 0.12), materials.myocardium, options, 'atrial-complex');
  addEllipsoid(root, runtime, 'left-atrium', 'body', new THREE.Vector3(0.45, 0.7, -0.18), new THREE.Vector3(0.48, 0.4, 0.5), new THREE.Euler(0.08, -0.12, -0.08), materials.myocardium, options, 'atrial-complex');
  addEllipsoid(root, runtime, 'right-auricle', 'auricle', new THREE.Vector3(-0.52, 0.72, 0.34), new THREE.Vector3(0.31, 0.27, 0.31), new THREE.Euler(0, 0.18, -0.22), materials.myocardium, options, 'atrial-complex');
  addEllipsoid(root, runtime, 'left-auricle', 'auricle', new THREE.Vector3(0.62, 0.7, 0.31), new THREE.Vector3(0.34, 0.27, 0.31), new THREE.Euler(0, -0.2, 0.2), materials.myocardium, options, 'atrial-complex');

  const aorticSystem = makeNode(root, runtime, 'aortic-system', 'vessel', 'ventricular-body');
  aorticSystem.position.x = 0.38;
  addTube(root, runtime, 'aortic-root', 'vessel', [[0.06, 0.5, 0.02], [0.1, 0.82, 0.04], [0.13, 1.1, 0]], 0.235, materials.arterial, materials.lumen, options, 'none', 'aortic-system');
  addTube(root, runtime, 'ascending-aorta', 'vessel', [[0.13, 0.92, 0], [0.18, 1.28, -0.03], [0.08, 1.58, -0.14]], 0.235, materials.arterial, materials.lumen, options, 'none', 'aortic-system');
  addTube(root, runtime, 'aortic-arch', 'vessel', [[0.08, 1.5, -0.14], [-0.06, 1.78, -0.24], [-0.35, 1.89, -0.38], [-0.64, 1.68, -0.53], [-0.7, 1.26, -0.58]], 0.23, materials.arterial, materials.lumen, options, 'end', 'aortic-system');
  addTube(root, runtime, 'brachiocephalic-branch', 'vessel', [[-0.08, 1.72, -0.2], [-0.13, 2.08, -0.2]], 0.12, materials.arterial, materials.lumen, options, 'end', 'aortic-system');
  addTube(root, runtime, 'left-carotid-branch', 'vessel', [[-0.31, 1.82, -0.3], [-0.34, 2.12, -0.31]], 0.105, materials.arterial, materials.lumen, options, 'end', 'aortic-system');
  addTube(root, runtime, 'left-subclavian-branch', 'vessel', [[-0.5, 1.76, -0.42], [-0.57, 2.02, -0.44], [-0.64, 2.12, -0.4]], 0.11, materials.arterial, materials.lumen, options, 'end', 'aortic-system');

  const pulmonaryVenousSystem = makeNode(root, runtime, 'pulmonary-venous-system', 'vessel', 'ventricular-body');
  pulmonaryVenousSystem.position.x = 0.14;
  addTube(root, runtime, 'pulmonary-trunk', 'vessel', [[0.12, 0.58, 0.42], [0.18, 0.96, 0.55], [0.3, 1.23, 0.52]], 0.21, materials.venous, materials.lumen, options, 'none', 'pulmonary-venous-system');
  addTube(root, runtime, 'left-pulmonary-branch', 'vessel', [[0.29, 1.2, 0.5], [0.68, 1.22, 0.42], [1.08, 1.15, 0.34]], 0.155, materials.venous, materials.lumen, options, 'end', 'pulmonary-venous-system');
  addTube(root, runtime, 'right-pulmonary-branch', 'vessel', [[0.28, 1.18, 0.48], [-0.06, 1.23, 0.32], [-0.54, 1.18, 0.22], [-0.78, 1.11, 0.22]], 0.145, materials.venous, materials.lumen, options, 'end', 'pulmonary-venous-system');
  addTube(root, runtime, 'superior-vena-cava', 'vessel', [[-0.5, 0.67, 0.03], [-0.53, 1.2, 0.05], [-0.6, 1.72, 0.05], [-0.7, 2.05, 0.03]], 0.18, materials.venous, materials.lumen, options, 'end', 'pulmonary-venous-system');
  addTube(root, runtime, 'caval-side-branch', 'vessel', [[-0.55, 1.5, 0.04], [-0.78, 1.52, 0.08], [-1.02, 1.48, 0.12]], 0.13, materials.venous, materials.lumen, options, 'end', 'pulmonary-venous-system');
  addTube(root, runtime, 'inferior-vena-cava', 'vessel', [[-0.47, 0.58, -0.22], [-0.55, 0.96, -0.45], [-0.54, 1.32, -0.58]], 0.17, materials.venous, materials.lumen, options, 'end', 'pulmonary-venous-system');
  addTube(root, runtime, 'right-superior-pulmonary-vein', 'vessel', [[0.3, 0.76, -0.42], [0.68, 0.92, -0.55], [1.02, 0.97, -0.54]], 0.105, materials.venous, materials.lumen, options, 'end', 'pulmonary-venous-system');
  addTube(root, runtime, 'right-inferior-pulmonary-vein', 'vessel', [[0.27, 0.62, -0.46], [0.68, 0.7, -0.61], [0.96, 0.67, -0.62]], 0.1, materials.venous, materials.lumen, options, 'end', 'pulmonary-venous-system');
  addTube(root, runtime, 'left-superior-pulmonary-vein', 'vessel', [[-0.27, 0.76, -0.44], [-0.65, 0.92, -0.57], [-0.94, 0.94, -0.58]], 0.105, materials.venous, materials.lumen, options, 'end', 'pulmonary-venous-system');
  addTube(root, runtime, 'left-inferior-pulmonary-vein', 'vessel', [[-0.24, 0.61, -0.46], [-0.62, 0.67, -0.62], [-0.91, 0.64, -0.63]], 0.1, materials.venous, materials.lumen, options, 'end', 'pulmonary-venous-system');

  makeNode(root, runtime, 'epicardial-fat', 'fat-pad', 'atrial-complex');
  addEllipsoid(root, runtime, 'left-fat-pad-base', 'fat-pad', new THREE.Vector3(-0.3, 0.61, 0.34), new THREE.Vector3(0.42, 0.37, 0.44), new THREE.Euler(0.04, 0.08, -0.12), materials['epicardial-fat'], options, 'epicardial-fat');
  addEllipsoid(root, runtime, 'right-fat-pad-base', 'fat-pad', new THREE.Vector3(0.52, 0.61, 0.35), new THREE.Vector3(0.47, 0.35, 0.39), new THREE.Euler(0.02, -0.1, 0.14), materials['epicardial-fat'], options, 'epicardial-fat');
  addEllipsoid(root, runtime, 'posterior-fat-cap-base', 'fat-pad', new THREE.Vector3(0, 0.7, -0.47), new THREE.Vector3(0.9, 0.42, 0.43), new THREE.Euler(-0.04, 0, 0), materials['epicardial-fat'], options, 'epicardial-fat');
  addFatCluster(root, runtime, 'left-fat-pad', new THREE.Vector3(-0.31, 0.62, 0.4), 0.46, 0.44, 21, materials['epicardial-fat'], options, 'epicardial-fat', -0.1, 1.18);
  addFatCluster(root, runtime, 'right-fat-pad', new THREE.Vector3(0.54, 0.62, 0.39), 0.51, 0.4, 19, materials['epicardial-fat'], options, 'epicardial-fat', 0.2, 1.28);
  addFatCluster(root, runtime, 'posterior-fat-cap', new THREE.Vector3(0, 0.72, -0.51), 0.94, 0.5, 37, materials['epicardial-fat'], options, 'epicardial-fat', Math.PI, 1.38);

  makeNode(root, runtime, 'coronary-network', 'vessel', 'ventricular-body');
  addTube(root, runtime, 'anterior-interventricular-vein', 'coronary-vein', [[0.02, 0.62, 0.78], [0.08, 0.2, 0.82], [0.12, -0.35, 0.75], [0.12, -0.9, 0.55], [0.08, -1.38, 0.18]], 0.043, materials['coronary-vein'], materials.lumen, options, 'none', 'coronary-network');
  addTube(root, runtime, 'anterior-interventricular-artery', 'coronary-artery', [[-0.03, 0.64, 0.79], [-0.03, 0.2, 0.84], [0.0, -0.32, 0.78], [-0.02, -0.83, 0.57], [-0.02, -1.3, 0.2]], 0.025, materials['coronary-artery'], materials.lumen, options, 'none', 'coronary-network');
  addTube(root, runtime, 'left-circumflex-vein', 'coronary-vein', [[0.08, 0.55, 0.78], [0.46, 0.48, 0.7], [0.78, 0.38, 0.43], [0.91, 0.22, 0.02], [0.76, 0.12, -0.43]], 0.036, materials['coronary-vein'], materials.lumen, options, 'none', 'coronary-network');
  addTube(root, runtime, 'right-circumflex-artery', 'coronary-artery', [[-0.08, 0.55, 0.78], [-0.42, 0.49, 0.72], [-0.72, 0.35, 0.48], [-0.88, 0.18, 0.08], [-0.74, 0.03, -0.4]], 0.026, materials['coronary-artery'], materials.lumen, options, 'none', 'coronary-network');
  addTube(root, runtime, 'posterior-coronary-vein', 'coronary-vein', [[0.18, 0.33, -0.72], [0.12, -0.15, -0.76], [0.08, -0.72, -0.61], [0.05, -1.12, -0.32]], 0.032, materials['coronary-vein'], materials.lumen, options, 'none', 'coronary-network');
  addTube(root, runtime, 'posterior-coronary-left', 'coronary-vein', [[0.13, 0.08, -0.76], [-0.2, -0.08, -0.72], [-0.48, -0.34, -0.57]], 0.019, materials['coronary-vein'], materials.lumen, options, 'none', 'coronary-network');
  addTube(root, runtime, 'posterior-coronary-right', 'coronary-artery', [[0.12, -0.2, -0.74], [0.42, -0.38, -0.65], [0.64, -0.7, -0.4]], 0.016, materials['coronary-artery'], materials.lumen, options, 'none', 'coronary-network');
  addTube(root, runtime, 'posterior-coronary-inferior-left', 'coronary-artery', [[0.08, -0.64, -0.62], [-0.22, -0.82, -0.52], [-0.42, -1.03, -0.3]], 0.014, materials['coronary-artery'], materials.lumen, options, 'none', 'coronary-network');
  addTube(root, runtime, 'posterior-coronary-inferior-right', 'coronary-vein', [[0.08, -0.56, -0.65], [0.34, -0.72, -0.55], [0.52, -0.94, -0.34]], 0.017, materials['coronary-vein'], materials.lumen, options, 'none', 'coronary-network');

  const branches: Array<{ id: string; points: [number, number, number][]; arterial: boolean; radius: number }> = [
    { id: 'coronary-branch-a', points: [[0.08, 0.18, 0.82], [0.38, 0.02, 0.78], [0.62, -0.18, 0.62]], arterial: true, radius: 0.017 },
    { id: 'coronary-branch-b', points: [[0.11, -0.16, 0.79], [0.43, -0.34, 0.71], [0.67, -0.6, 0.48]], arterial: false, radius: 0.021 },
    { id: 'coronary-branch-c', points: [[0.1, -0.53, 0.7], [-0.2, -0.66, 0.72], [-0.47, -0.82, 0.55]], arterial: true, radius: 0.014 },
    { id: 'coronary-branch-d', points: [[-0.01, 0.22, 0.83], [-0.32, 0.06, 0.78], [-0.61, -0.13, 0.56]], arterial: false, radius: 0.019 },
    { id: 'coronary-branch-e', points: [[0.03, -0.72, 0.6], [0.3, -0.88, 0.5], [0.48, -1.08, 0.31]], arterial: true, radius: 0.013 },
    { id: 'coronary-branch-f', points: [[0.09, -0.42, 0.75], [-0.22, -0.45, 0.73], [-0.52, -0.55, 0.57]], arterial: false, radius: 0.017 },
  ];
  for (const branch of branches) addTube(root, runtime, branch.id, 'coronary-branch', branch.points, branch.radius, branch.arterial ? materials['coronary-artery'] : materials['coronary-vein'], materials.lumen, options, 'none', 'coronary-network');

  addSocket(runtime, 'ventricular-body', 'apex', new THREE.Vector3(0.57, -1.74, -0.03));
  addSocket(runtime, 'aortic-root', 'root', new THREE.Vector3(0, 0, 0));
  addSocket(runtime, 'pulmonary-trunk', 'root', new THREE.Vector3(0, 0, 0));

  runtime.actionAnchors = {
    apex: 'ventricular-body:apex',
    aorticRoot: 'aortic-root:root',
    pulmonaryRoot: 'pulmonary-trunk:root',
  };
  runtime.logicalComponents = {
    'atrial-complex': { kind: 'action-group', binding: 'atrial-complex', boundMeshes: ['left-atrium', 'right-atrium', 'left-auricle', 'right-auricle'] },
    'aortic-system': { kind: 'action-group', binding: 'aortic-system', boundMeshes: ['aortic-root', 'ascending-aorta', 'aortic-arch', 'brachiocephalic-branch', 'left-carotid-branch', 'left-subclavian-branch'] },
    'pulmonary-venous-system': { kind: 'action-group', binding: 'pulmonary-venous-system', boundMeshes: ['pulmonary-trunk', 'left-pulmonary-branch', 'right-pulmonary-branch'] },
    'coronary-network': { kind: 'action-group', binding: 'coronary-network', boundMeshes: ['anterior-interventricular-vein', 'anterior-interventricular-artery'] },
    'epicardial-fat': { kind: 'action-group', binding: 'epicardial-fat', boundMeshes: ['left-fat-pad-base', 'right-fat-pad-base', 'posterior-fat-cap-base', 'left-fat-pad', 'right-fat-pad', 'posterior-fat-cap'] },
    'apex-volume': { kind: 'logical-alias', binding: 'ventricular-body', boundMeshes: ['ventricular-body'] },
    'atrioventricular-groove': { kind: 'logical-alias', binding: 'coronary-network', boundMeshes: ['left-circumflex-vein', 'right-circumflex-artery'] },
    'anterior-interventricular-groove': { kind: 'logical-alias', binding: 'coronary-network', boundMeshes: ['anterior-interventricular-vein', 'anterior-interventricular-artery'] },
    'vena-cava-system': { kind: 'action-group', binding: 'pulmonary-venous-system', boundMeshes: ['superior-vena-cava', 'inferior-vena-cava', 'caval-side-branch'] },
    'pulmonary-return-system': { kind: 'action-group', binding: 'pulmonary-venous-system', boundMeshes: ['right-superior-pulmonary-vein', 'right-inferior-pulmonary-vein', 'left-superior-pulmonary-vein', 'left-inferior-pulmonary-vein'] },
    'anterior-coronary-trunks': { kind: 'action-group', binding: 'coronary-network', boundMeshes: ['anterior-interventricular-vein', 'anterior-interventricular-artery'] },
    'left-lateral-coronary-wrap': { kind: 'action-group', binding: 'coronary-network', boundMeshes: ['left-circumflex-vein'] },
    'right-lateral-coronary-wrap': { kind: 'action-group', binding: 'coronary-network', boundMeshes: ['right-circumflex-artery'] },
    'posterior-coronary-trunks': { kind: 'action-group', binding: 'coronary-network', boundMeshes: ['posterior-coronary-vein', 'posterior-coronary-left', 'posterior-coronary-right', 'posterior-coronary-inferior-left', 'posterior-coronary-inferior-right'] },
  };
  const logicalParents: Record<string, string> = {
    'vena-cava-system': 'pulmonary-venous-system',
    'pulmonary-return-system': 'pulmonary-venous-system',
    'anterior-coronary-trunks': 'coronary-network',
    'left-lateral-coronary-wrap': 'coronary-network',
    'right-lateral-coronary-wrap': 'coronary-network',
    'posterior-coronary-trunks': 'coronary-network',
  };
  const logicalPivotPositions: Record<string, THREE.Vector3> = {
    'vena-cava-system': new THREE.Vector3(-0.54, 1.15, -0.18),
    'pulmonary-return-system': new THREE.Vector3(0, 0.75, -0.5),
    'anterior-coronary-trunks': new THREE.Vector3(0.03, -0.25, 0.78),
    'left-lateral-coronary-wrap': new THREE.Vector3(0.62, 0.3, 0.35),
    'right-lateral-coronary-wrap': new THREE.Vector3(-0.62, 0.3, 0.35),
    'posterior-coronary-trunks': new THREE.Vector3(0.08, -0.35, -0.7),
  };
  for (const [id, component] of Object.entries(runtime.logicalComponents)) {
    if (component.kind === 'logical-alias') {
      runtime.destructionGroups[id] = [];
      continue;
    }
    const pivot = runtime.nodes[id] ?? makeNode(root, runtime, id, 'logical-action-pivot', logicalParents[id]);
    pivot.position.copy(logicalPivotPositions[id] ?? pivot.position);
    pivot.userData.logicalComponent = { id, boundMeshes: [...component.boundMeshes] };
    root.updateWorldMatrix(true, true);
    for (const meshId of component.boundMeshes) {
      const boundNode = runtime.nodes[meshId];
      if (boundNode && boundNode !== pivot && boundNode.parent !== pivot) pivot.attach(boundNode);
    }
    runtime.destructionGroups[id] = [...component.boundMeshes];
  }
  const semanticIdByNode = new Map(Object.entries(runtime.nodes).map(([id, node]) => [node, id]));
  runtime.adjacency.length = 0;
  for (const [childId, node] of Object.entries(runtime.nodes)) {
    const parentId = node.parent ? semanticIdByNode.get(node.parent) : undefined;
    if (parentId) runtime.adjacency.push([parentId, childId]);
  }
  Object.defineProperty(runtime.colliders, 'length', {
    value: Object.keys(runtime.colliders).length,
    enumerable: false,
  });
  auditRuntimeAttachments(root, runtime);

  root.userData.sculptRuntime = runtime;
  root.userData.actionReadiness = {
    explodable: true,
    clickable: true,
    stableSemanticNodes: Object.keys(runtime.nodes),
    note: 'External teaching-model anatomy only; no clinical diagnostic claim.',
  };
  root.userData.referenceSet = ['anterior', 'left-oblique', 'posterior', 'right-oblique', 'superior'];
  root.userData.excludedReferenceElements = ['colored hotspot rings', 'background', 'pedestal', 'top-right UI', 'text'];
  return root;
}
