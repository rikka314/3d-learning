import * as THREE from 'three';

export type MitochondrionCutawayModelOptions = {
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
};

const MODEL_PASS = 'optimization-pass';

function seededRandom(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function createSurfaceTexture(
  colors: [THREE.ColorRepresentation, THREE.ColorRepresentation, THREE.ColorRepresentation],
  seed: number,
  size: number,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  const resolution = Math.max(256, Math.min(size, 1024));
  canvas.width = resolution;
  canvas.height = resolution;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas is unavailable.');
  const image = context.createImageData(resolution, resolution);
  const palette = colors.map((color) => new THREE.Color(color));
  const hash = (x: number, y: number): number => {
    const value = Math.sin(x * 127.1 + y * 311.7 + seed * 0.013) * 43758.5453123;
    return value - Math.floor(value);
  };
  const valueNoise = (x: number, y: number, scale: number): number => {
    const px = x / scale;
    const py = y / scale;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const fx = px - ix;
    const fy = py - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const top = THREE.MathUtils.lerp(hash(ix, iy), hash(ix + 1, iy), sx);
    const bottom = THREE.MathUtils.lerp(hash(ix, iy + 1), hash(ix + 1, iy + 1), sx);
    return THREE.MathUtils.lerp(top, bottom, sy);
  };
  for (let y = 0; y < resolution; y += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const index = (y * resolution + x) * 4;
      const broad = valueNoise(x, y, 110);
      const meso = valueNoise(x + 29, y - 17, 34);
      const grain = valueNoise(x - 53, y + 41, 7);
      const value = THREE.MathUtils.clamp(broad * 0.58 + meso * 0.27 + grain * 0.15, 0, 1) * 2;
      const lower = Math.floor(value);
      const upper = Math.min(2, lower + 1);
      const color = palette[lower].clone().lerp(palette[upper], value - lower);
      image.data[index] = Math.round(color.r * 255);
      image.data[index + 1] = Math.round(color.g * 255);
      image.data[index + 2] = Math.round(color.b * 255);
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2.2, 3.3);
  texture.anisotropy = 8;
  return texture;
}

function createScalarTexture(
  seed: number,
  size: number,
  base: number,
  variation: number,
  repeat: [number, number],
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  const resolution = Math.max(256, Math.min(size, 1024));
  canvas.width = resolution;
  canvas.height = resolution;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas is unavailable.');
  const image = context.createImageData(resolution, resolution);
  const hash = (x: number, y: number): number => {
    const value = Math.sin(x * 173.3 + y * 269.5 + seed * 0.019) * 15731.743;
    return value - Math.floor(value);
  };
  const noise = (x: number, y: number, scale: number): number => {
    const px = x / scale;
    const py = y / scale;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const fx = px - ix;
    const fy = py - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const top = THREE.MathUtils.lerp(hash(ix, iy), hash(ix + 1, iy), sx);
    const bottom = THREE.MathUtils.lerp(hash(ix, iy + 1), hash(ix + 1, iy + 1), sx);
    return THREE.MathUtils.lerp(top, bottom, sy);
  };
  for (let y = 0; y < resolution; y += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const index = (y * resolution + x) * 4;
      const field = noise(x, y, 86) * 0.5 + noise(x + 37, y - 59, 23) * 0.32 + noise(x - 11, y + 83, 6) * 0.18;
      const value = Math.round(THREE.MathUtils.clamp(base + (field - 0.5) * variation, 0, 1) * 255);
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(...repeat);
  texture.anisotropy = 8;
  texture.userData = { generatedChannel: true, resolution, seed };
  return texture;
}

function createOrganicShellGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(0.5, 96, 64);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  for (let index = 0; index < position.count; index += 1) {
    const sx = position.getX(index);
    const sy = position.getY(index);
    const sz = position.getZ(index);
    const ny = sy / 0.5;
    const lowerSwelling = 1 + 0.13 * Math.exp(-Math.pow((ny + 0.42) / 0.42, 2));
    const upperTaper = 1 - 0.09 * Math.max(0, ny - 0.45);
    const noise = Math.sin((sx + sy) * 28 + sz * 9) * 0.012 + Math.sin(sy * 43 - sx * 17) * 0.006;
    const radial = 1 + noise;
    const bend = 0.17 * (1 - ny * ny) + 0.055 * ny;
    position.setXYZ(
      index,
      sx * 2.05 * lowerSwelling * upperTaper * radial + bend,
      sy * 3.4 * (1 + 0.025 * Math.sin(ny * Math.PI * 2)),
      sz * 1.3 * radial,
    );
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createMatrixGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-0.67, 1.18);
  shape.bezierCurveTo(-0.46, 1.45, 0.05, 1.49, 0.39, 1.20);
  shape.bezierCurveTo(0.62, 0.98, 0.56, 0.55, 0.48, 0.25);
  shape.bezierCurveTo(0.43, -0.16, 0.50, -0.63, 0.29, -1.04);
  shape.bezierCurveTo(0.10, -1.40, -0.33, -1.47, -0.61, -1.16);
  shape.bezierCurveTo(-0.82, -0.91, -0.76, -0.50, -0.69, -0.18);
  shape.bezierCurveTo(-0.63, 0.18, -0.82, 0.83, -0.67, 1.18);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.13,
    bevelEnabled: true,
    bevelSegments: 8,
    bevelSize: 0.075,
    bevelThickness: 0.055,
    curveSegments: 48,
    steps: 2,
  });
  geometry.translate(-0.15, 0.03, 0.67);
  geometry.computeVertexNormals();
  return geometry;
}

function loopPoints(z: number, inset = 0): THREE.Vector3[] {
  return [
    [-0.78 + inset, 1.20 - inset, z], [-0.52, 1.44 - inset, z], [-0.10, 1.52 - inset, z],
    [0.31 - inset, 1.31 - inset, z], [0.52 - inset, 0.83, z], [0.45 - inset, 0.20, z],
    [0.44 - inset, -0.50, z], [0.20, -1.18 + inset, z], [-0.18, -1.42 + inset, z],
    [-0.60 + inset, -1.16 + inset, z], [-0.74 + inset, -0.45, z], [-0.72 + inset, 0.45, z],
  ].map(([x, y, depth]) => new THREE.Vector3(x, y, depth));
}

function createTube(points: THREE.Vector3[], radius: number, closed = false, segments = 128): THREE.TubeGeometry {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, closed, 'centripetal', 0.5), segments, radius, 14, closed);
}

function componentNode(id: string, name: string, level: string, role: string): THREE.Group {
  const node = new THREE.Group();
  node.name = name;
  node.userData.sculptComponent = {
    id,
    name,
    level,
    role,
    actionProfile: {
      pivot: { mode: 'center', localPosition: [0, 0, 0], axis: [0, 1, 0] },
      transformChannels: { translate: true, rotate: true, visibility: true, materialState: true },
      destruction: { breakable: false, fractureGroup: role, breakImpulse: 0 },
    },
  };
  return node;
}

function addCristaFold(
  parent: THREE.Group,
  nodes: Record<string, THREE.Object3D>,
  meshes: Record<string, THREE.Mesh>,
  id: string,
  name: string,
  points: Array<[number, number]>,
  membraneMaterial: THREE.Material,
  shadowMaterial: THREE.Material,
  radius: number,
): void {
  const node = componentNode(id, name, 'meso', 'membrane-fold');
  node.userData.sculptComponent.parent = 'inner-boundary';
  node.userData.sculptComponent.attachment = {
    parentId: 'inner-boundary',
    parentSocket: 'membrane-contact',
    localStart: [...points[0], 0],
    localEnd: [...points[points.length - 1], 0],
    contactType: 'overlap',
    overlap: 0.04,
    gapTolerance: 0.012,
  };
  const path = points.map(([x, y]) => new THREE.Vector3(x, y, 0.985));
  const contact = new THREE.Mesh(createTube(path, radius * 1.2, false, 72), shadowMaterial);
  contact.name = `${name} contact shadow`;
  contact.position.z = -0.027;
  const fold = new THREE.Mesh(createTube(path, radius, false, 72), membraneMaterial);
  fold.name = name;
  const capGeometry = new THREE.SphereGeometry(radius, 18, 12);
  const startCap = new THREE.Mesh(capGeometry, membraneMaterial);
  const endCap = new THREE.Mesh(capGeometry, membraneMaterial);
  startCap.position.copy(path[0]);
  endCap.position.copy(path[path.length - 1]);
  startCap.name = `${name} start cap`;
  endCap.name = `${name} end cap`;
  node.add(contact, fold, startCap, endCap);
  parent.add(node);
  nodes[id] = node;
  meshes[id] = fold;
}

function applyMeshOptions(object: THREE.Object3D, options: MitochondrionCutawayModelOptions): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const tinySurfaceDetail = /granule|speck|pore/i.test(child.name);
    child.castShadow = tinySurfaceDetail ? false : (options.castShadow ?? true);
    child.receiveShadow = options.receiveShadow ?? true;
  });
}

function addMatrixDetails(
  matrixNode: THREE.Group,
  nodes: Record<string, THREE.Object3D>,
  meshes: Record<string, THREE.Mesh>,
): void {
  const random = seededRandom(58321);
  const bands = [0.83, 0.34, -0.12, -0.55, -0.94, -1.12];
  const choosePoint = (): [number, number] => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const x = -0.15 + (random() - 0.5) * 1.16;
      const y = (random() - 0.5) * 2.42;
      const inside = Math.pow((x + 0.12) / 0.66, 2) + Math.pow(y / 1.30, 2) < 0.83;
      const clearOfFold = bands.every((band) => Math.abs(y - band) > 0.105);
      if (inside && clearOfFold) return [x, y];
    }
    return [-0.15, 0];
  };

  const granuleNode = componentNode('granule-anchor', 'Matrix granule field', 'micro', 'detail');
  granuleNode.userData.sculptComponent.parent = 'matrix-volume';
  const granuleMaterial = new THREE.MeshStandardMaterial({ color: 0x967158, roughness: 0.68, vertexColors: true });
  const granules = new THREE.InstancedMesh(new THREE.SphereGeometry(0.017, 14, 10), granuleMaterial, 38);
  granules.name = 'Irregular matrix granules';
  const transform = new THREE.Object3D();
  for (let index = 0; index < granules.count; index += 1) {
    const [x, y] = choosePoint();
    const scale = 0.65 + random() * 0.7;
    transform.position.set(x, y, 1.035 + random() * 0.012);
    transform.rotation.set(random() * 0.6, random() * 0.6, random() * Math.PI);
    transform.scale.set(scale * (0.72 + random() * 0.48), scale, scale * 0.55);
    transform.updateMatrix();
    granules.setMatrixAt(index, transform.matrix);
    granules.setColorAt(index, new THREE.Color(random() > 0.32 ? 0x9d7658 : 0x765d50));
  }
  granules.instanceMatrix.needsUpdate = true;
  if (granules.instanceColor) granules.instanceColor.needsUpdate = true;
  granuleNode.add(granules);
  matrixNode.add(granuleNode);
  nodes['granule-anchor'] = granuleNode;
  meshes['granule-anchor'] = granules;

  const speckNode = componentNode('matrix-speck-anchor', 'Fine matrix speck field', 'micro', 'detail');
  speckNode.userData.sculptComponent.parent = 'matrix-volume';
  const speckMaterial = new THREE.MeshStandardMaterial({ color: 0x705846, roughness: 0.74 });
  const specks = new THREE.InstancedMesh(new THREE.SphereGeometry(0.009, 8, 6), speckMaterial, 120);
  specks.name = 'Fine matrix speckles';
  for (let index = 0; index < specks.count; index += 1) {
    const [x, y] = choosePoint();
    const scale = 0.65 + random() * 1.25;
    transform.position.set(x, y, 1.026 + random() * 0.008);
    transform.scale.setScalar(scale);
    transform.updateMatrix();
    specks.setMatrixAt(index, transform.matrix);
  }
  specks.instanceMatrix.needsUpdate = true;
  speckNode.add(specks);
  matrixNode.add(speckNode);
  nodes['matrix-speck-anchor'] = speckNode;
  meshes['matrix-speck-anchor'] = specks;
}

function addShellPores(
  shellNode: THREE.Group,
  nodes: Record<string, THREE.Object3D>,
  meshes: Record<string, THREE.Mesh>,
): void {
  const poreNode = componentNode('shell-pore-anchor', 'Shell pore relief', 'micro', 'detail');
  poreNode.userData.sculptComponent.parent = 'root';
  const poreMaterial = new THREE.MeshStandardMaterial({ color: 0x865a48, roughness: 0.86 });
  const pores = new THREE.InstancedMesh(new THREE.SphereGeometry(0.012, 9, 7), poreMaterial, 68);
  pores.name = 'Subtle shell pore relief';
  const random = seededRandom(9347);
  const transform = new THREE.Object3D();
  for (let index = 0; index < pores.count; index += 1) {
    const ny = random() * 1.72 - 0.86;
    const theta = 0.12 + random() * 1.22;
    const ring = Math.sqrt(Math.max(0.02, 1 - ny * ny));
    const lowerSwelling = 1 + 0.13 * Math.exp(-Math.pow((ny + 0.42) / 0.42, 2));
    const bend = 0.17 * (1 - ny * ny) + 0.055 * ny;
    transform.position.set(
      Math.cos(theta) * ring * 1.025 * lowerSwelling + bend,
      ny * 1.7,
      Math.sin(theta) * ring * 0.654,
    );
    const scale = 0.55 + random() * 1.05;
    transform.scale.set(scale, scale, scale * 0.28);
    transform.rotation.set(0, theta, random() * Math.PI);
    transform.updateMatrix();
    pores.setMatrixAt(index, transform.matrix);
  }
  pores.instanceMatrix.needsUpdate = true;
  poreNode.add(pores);
  shellNode.add(poreNode);
  nodes['shell-pore-anchor'] = poreNode;
  meshes['shell-pore-anchor'] = pores;
}

export function createMitochondrionCutawayModel(options: MitochondrionCutawayModelOptions = {}): THREE.Group {
  const textureSize = options.textureSize ?? 1024;
  const shellMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: createSurfaceTexture([0x9d644b, 0xca8f6e, 0xe0b697], 4137, textureSize),
    roughnessMap: createScalarTexture(4238, textureSize, 0.69, 0.22, [2.2, 3.3]),
    bumpMap: createScalarTexture(4339, textureSize, 0.5, 0.42, [2.2, 3.3]),
    roughness: 0.9,
    bumpScale: 0.024,
    clearcoat: 0.08,
    clearcoatRoughness: 0.58,
  });
  const matrixMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: createSurfaceTexture([0xd0b67c, 0xe8d29e, 0xf6e6bf], 7721, textureSize),
    roughnessMap: createScalarTexture(7822, textureSize, 0.8, 0.16, [1.6, 2.2]),
    bumpMap: createScalarTexture(7923, textureSize, 0.5, 0.3, [1.6, 2.2]),
    roughness: 0.9,
    bumpScale: 0.014,
  });
  const membraneMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: createSurfaceTexture([0xb77b25, 0xf0c34f, 0xffe08a], 991, textureSize),
    roughnessMap: createScalarTexture(1092, textureSize, 0.46, 0.14, [2.8, 4.0]),
    bumpMap: createScalarTexture(1193, textureSize, 0.5, 0.2, [2.8, 4.0]),
    roughness: 0.75,
    bumpScale: 0.006,
    clearcoat: 0.42,
    clearcoatRoughness: 0.24,
  });
  const shadowMaterial = new THREE.MeshStandardMaterial({ color: 0x865018, roughness: 0.6 });

  const model = new THREE.Group();
  model.name = 'Mitochondrion cutaway procedural model';
  const nodes: Record<string, THREE.Object3D> = {};
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};

  const shellNode = componentNode('root', 'Outer membrane shell', 'macro', 'outer-shell');
  shellNode.userData.sculptComponent.actionProfile.sockets = [
    { id: 'front-cutaway', localPosition: [-0.15, 0.03, 0.72], localRotation: [0, 0, 0] },
  ];
  shellNode.userData.sculptComponent.actionProfile.collider = {
    type: 'ellipsoid', offset: [0, 0, 0], scale: [2.05, 3.4, 1.3], isTrigger: false,
  };
  const shell = new THREE.Mesh(createOrganicShellGeometry(), shellMaterial);
  shell.name = 'Outer membrane shell surface';
  shellNode.add(shell);
  model.add(shellNode);
  nodes.root = shellNode;
  meshes.root = shell;

  const frontSocket = new THREE.Object3D();
  frontSocket.name = 'socket:front-cutaway';
  frontSocket.position.set(-0.15, 0.03, 0.72);
  shellNode.add(frontSocket);
  sockets['front-cutaway'] = frontSocket;

  const matrixNode = componentNode('matrix-volume', 'Inset matrix surface', 'macro', 'interior-layer');
  matrixNode.userData.sculptComponent.parent = 'root';
  const matrix = new THREE.Mesh(createMatrixGeometry(), matrixMaterial);
  matrix.name = 'Pale granular matrix';
  matrixNode.add(matrix);
  shellNode.add(matrixNode);
  nodes['matrix-volume'] = matrixNode;
  meshes['matrix-volume'] = matrix;

  const boundaryNode = componentNode('inner-boundary', 'Continuous inner membrane boundary', 'macro', 'membrane');
  boundaryNode.userData.sculptComponent.parent = 'root';
  boundaryNode.userData.sculptComponent.attachment = {
    parentId: 'root', parentSocket: 'front-cutaway', contactType: 'embed', embedDepth: 0.045, gapTolerance: 0.015,
  };
  boundaryNode.userData.sculptComponent.actionProfile.sockets = [
    { id: 'membrane-contact', localPosition: [-0.62, 1.08, 0.94], localRotation: [0, 0, 0] },
  ];
  const membraneSocket = new THREE.Object3D();
  membraneSocket.name = 'socket:membrane-contact';
  membraneSocket.position.set(-0.62, 1.08, 0.94);
  boundaryNode.add(membraneSocket);
  sockets['membrane-contact'] = membraneSocket;
  const shadowLoop = loopPoints(0.91);
  const membraneLoop = loopPoints(0.955, 0.018);
  const boundaryShadow = new THREE.Mesh(createTube(shadowLoop.slice(0, 10), 0.071, false), shadowMaterial);
  boundaryShadow.name = 'Inner membrane U contact shadow';
  const boundaryShadowUpper = new THREE.Mesh(createTube([shadowLoop[11], shadowLoop[0]], 0.071, false, 30), shadowMaterial);
  boundaryShadowUpper.name = 'Upper-left membrane contact shadow';
  const boundaryShadowLower = new THREE.Mesh(createTube([shadowLoop[9], shadowLoop[10]], 0.071, false, 30), shadowMaterial);
  boundaryShadowLower.name = 'Lower-left membrane contact shadow';
  const boundary = new THREE.Mesh(createTube(membraneLoop.slice(0, 10), 0.052, false), membraneMaterial);
  boundary.name = 'Continuous gold inner membrane';
  const boundaryUpper = new THREE.Mesh(createTube([membraneLoop[11], membraneLoop[0]], 0.052, false, 30), membraneMaterial);
  boundaryUpper.name = 'Upper-left gold membrane segment';
  const boundaryLower = new THREE.Mesh(createTube([membraneLoop[9], membraneLoop[10]], 0.052, false, 30), membraneMaterial);
  boundaryLower.name = 'Lower-left gold membrane segment';
  boundaryNode.add(boundaryShadow, boundaryShadowUpper, boundaryShadowLower, boundary, boundaryUpper, boundaryLower);
  shellNode.add(boundaryNode);
  nodes['inner-boundary'] = boundaryNode;
  meshes['inner-boundary'] = boundary;

  const rimNode = componentNode('cutaway-rim', 'Thick cutaway rim', 'meso', 'seam');
  rimNode.userData.sculptComponent.parent = 'root';
  rimNode.userData.sculptComponent.attachment = {
    parentId: 'root', parentSocket: 'front-cutaway', contactType: 'overlap', overlap: 0.055, gapTolerance: 0.012,
  };
  const rimMainPoints = [
    [-0.66, 1.31, 0.875], [-0.34, 1.53, 0.875], [0.12, 1.48, 0.875], [0.43, 1.18, 0.875],
    [0.55, 0.65, 0.875], [0.48, 0.02, 0.875], [0.45, -0.62, 0.875], [0.14, -1.26, 0.875],
    [-0.23, -1.45, 0.875], [-0.60, -1.12, 0.875], [-0.73, -0.48, 0.875],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const rimUpperLeftPoints = [
    [-0.73, 0.48, 0.875], [-0.76, 0.88, 0.875], [-0.66, 1.31, 0.875],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const rim = new THREE.Mesh(createTube(rimMainPoints, 0.092, false, 132), shellMaterial);
  rim.name = 'Open U-shaped cutaway rim';
  const rimUpperLeft = new THREE.Mesh(createTube(rimUpperLeftPoints, 0.092, false, 44), shellMaterial);
  rimUpperLeft.name = 'Upper-left cutaway rim segment';
  rimNode.add(rim, rimUpperLeft);
  shellNode.add(rimNode);
  nodes['cutaway-rim'] = rimNode;
  meshes['cutaway-rim'] = rim;

  addCristaFold(boundaryNode, nodes, meshes, 'crista-01', 'Upper left-to-right crista fold', [
    [-0.66, 1.02], [-0.48, 0.96], [-0.28, 0.78], [-0.02, 0.74], [0.48, 0.73],
  ], membraneMaterial, shadowMaterial, 0.048);
  addCristaFold(boundaryNode, nodes, meshes, 'crista-02', 'Upper right-to-left crista fold', [
    [0.49, 0.51], [0.22, 0.50], [0.05, 0.34], [-0.18, 0.30], [-0.69, 0.33],
  ], membraneMaterial, shadowMaterial, 0.047);
  addCristaFold(boundaryNode, nodes, meshes, 'crista-03', 'Middle left-to-right crista fold', [
    [-0.69, 0.10], [-0.39, 0.07], [-0.18, -0.10], [0.04, -0.15], [0.48, -0.13],
  ], membraneMaterial, shadowMaterial, 0.048);
  addCristaFold(boundaryNode, nodes, meshes, 'crista-04', 'Lower right-to-left crista fold', [
    [0.48, -0.37], [0.17, -0.38], [-0.03, -0.55], [-0.25, -0.61], [-0.69, -0.57],
  ], membraneMaterial, shadowMaterial, 0.046);
  addCristaFold(boundaryNode, nodes, meshes, 'crista-05', 'Lowest left-to-right crista fold', [
    [-0.66, -0.80], [-0.36, -0.82], [-0.18, -0.97], [0.02, -1.01], [0.34, -0.95],
  ], membraneMaterial, shadowMaterial, 0.044);
  addCristaFold(boundaryNode, nodes, meshes, 'lower-spiral', 'Lower looped crista fold', [
    [-0.57, -1.06], [-0.42, -1.19], [-0.20, -1.21], [-0.02, -1.12], [-0.07, -1.01],
    [-0.22, -0.98], [-0.33, -1.07], [-0.21, -1.14],
  ], membraneMaterial, shadowMaterial, 0.041);

  addMatrixDetails(matrixNode, nodes, meshes);
  addShellPores(shellNode, nodes, meshes);

  applyMeshOptions(model, options);
  model.userData.sculptRuntime = {
    schemaVersion: 1,
    passId: MODEL_PASS,
    nodes,
    meshes,
    sockets,
    colliders: {
      root: { type: 'ellipsoid', scale: [2.05, 3.4, 1.3] },
      'matrix-volume': { type: 'ellipsoid', scale: [1.28, 2.5, 0.18], isTrigger: true },
      'inner-boundary': { type: 'tube-loop', scale: [1.25, 2.65, 0.12], isTrigger: true },
      'cutaway-rim': { type: 'tube-loop', scale: [1.5, 2.9, 0.18], isTrigger: true },
      'crista-01': { type: 'tube', scale: [1.2, 0.3, 0.12], isTrigger: true },
      'crista-02': { type: 'tube', scale: [1.2, 0.3, 0.12], isTrigger: true },
      'crista-03': { type: 'tube', scale: [1.2, 0.3, 0.12], isTrigger: true },
      'crista-04': { type: 'tube', scale: [1.2, 0.3, 0.12], isTrigger: true },
      'crista-05': { type: 'tube', scale: [1.1, 0.28, 0.11], isTrigger: true },
      'lower-spiral': { type: 'tube', scale: [0.7, 0.32, 0.1], isTrigger: true },
    },
    destructionGroups: {
      root: [shellNode],
      'matrix-layer': [matrixNode],
      'inner-membrane': [boundaryNode],
      'cutaway-rim': [rimNode],
      cristae: [
        nodes['crista-01'], nodes['crista-02'], nodes['crista-03'],
        nodes['crista-04'], nodes['crista-05'], nodes['lower-spiral'],
      ],
    },
  };
  model.userData.performanceBudget = {
    targetTriangles: 250000,
    maxDrawCalls: 160,
    fpsTarget: 30,
    textureResolution: options.textureSize ?? 1024,
    instancedGroups: {
      granules: 38,
      matrixSpecks: 120,
      shellPores: 68,
    },
    lod: [
      { tier: 'near', distance: 0, strategy: 'full component hierarchy and material maps' },
      { tier: 'far', distance: 30, strategy: 'hide micro instance groups and reduce texture sampling' },
    ],
  };
  return model;
}

export function createMitochondrionCutawayLookDevLights(mode: 'reference' | 'neutral' | 'grazing' = 'reference'): THREE.Group {
  const lights = new THREE.Group();
  lights.name = `Mitochondrion ${mode} lighting`;
  const hemisphere = new THREE.HemisphereLight(0xfff1da, 0x6d493a, mode === 'neutral' ? 1.25 : 1.05);
  const key = new THREE.DirectionalLight(0xffd8ad, mode === 'grazing' ? 3.7 : 3.0);
  key.position.set(-3.8, 5.4, 5.6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -3;
  key.shadow.camera.right = 3;
  key.shadow.camera.top = 4;
  key.shadow.camera.bottom = -4;
  key.shadow.bias = -0.00025;
  const fill = new THREE.DirectionalLight(0xcbdcff, mode === 'grazing' ? 0.35 : 1.15);
  fill.position.set(4.2, 1.0, 3.0);
  const rim = new THREE.DirectionalLight(0xffbd78, 1.1);
  rim.position.set(2.2, 2.8, -4.3);
  lights.add(hemisphere, key, fill, rim);
  return lights;
}

export function configureMitochondrionCutawayRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
}
