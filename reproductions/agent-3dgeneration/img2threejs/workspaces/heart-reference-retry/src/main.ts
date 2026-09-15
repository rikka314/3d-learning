import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createHeartModel } from './createHeartModel';
import './style.css';

type SculptComponent = { id?: string; name?: string; nameZh?: string; label?: string };
type SculptRuntime = {
  nodes?: Record<string, THREE.Object3D>;
  meshes?: Record<string, THREE.Mesh>;
};

const chinesePartNames: Array<[RegExp, string]> = [
  [/superior.*vena|vena.*superior|上腔/, '上腔静脉'],
  [/inferior.*vena|vena.*inferior|下腔/, '下腔静脉'],
  [/pulmonary.*trunk|肺动脉干/, '肺动脉干'],
  [/pulmonary.*arter|肺动脉/, '肺动脉'],
  [/pulmonary.*vein|肺静脉/, '肺静脉'],
  [/aorta|主动脉/, '主动脉'],
  [/left.*atri|左心房|左心耳/, '左心房与左心耳'],
  [/right.*atri|右心房|右心耳/, '右心房与右心耳'],
  [/left.*ventric|左心室/, '左心室'],
  [/right.*ventric|右心室/, '右心室'],
  [/coronary|冠状/, '冠状血管'],
  [/fat|adipose|脂肪/, '心外膜脂肪'],
  [/myocard|heart[-_ ]?body|heart[-_ ]?mass|心肌|心脏主体/, '心肌主体'],
];

function partName(id: string, node: THREE.Object3D, component?: SculptComponent): string {
  if (component?.nameZh) return component.nameZh;
  const supplied = component?.name ?? component?.label ?? node.name;
  if (supplied && /[\u3400-\u9fff]/.test(supplied)) return supplied;
  const semantic = `${id} ${supplied ?? ''}`.toLowerCase();
  return chinesePartNames.find(([pattern]) => pattern.test(semantic))?.[1] ?? `心脏部件 · ${supplied || id}`;
}

declare global {
  interface Window {
    __MODEL_ROOT__?: THREE.Group;
    __MODEL_READY__?: boolean;
    __CAPTURE_VIEW__?: (view: 'front' | 'right' | 'rear' | 'left' | 'threeQuarter') => void;
    __RENDER_INFO__?: () => unknown;
    __PART_MANIFEST__?: () => unknown;
    __SET_EXPLODE__?: (value: boolean) => void;
    __SELECT_PART__?: (id: string) => boolean;
  }
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Viewer DOM is missing ${selector}.`);
  return element;
}

const canvas = requireElement<HTMLCanvasElement>('#scene');
const viewport = requireElement<HTMLElement>('.viewport');
const status = requireElement<HTMLElement>('#status');
const partLabel = requireElement<HTMLElement>('#part-label');
const explodeButton = document.querySelector<HTMLButtonElement>('#explode');
const turntableButton = document.querySelector<HTMLButtonElement>('#turntable');

const params = new URLSearchParams(location.search);
const captureMode = params.get('capture') === '1';
if (captureMode) document.body.classList.add('capture');

const scene = new THREE.Scene();
scene.background = new THREE.Color(captureMode ? 0xffffff : 0xf6f3ef);

const referenceVerticalExtent = 1402 / 280;
const camera = new THREE.OrthographicCamera(-1, 1, referenceVerticalExtent / 2, -referenceVerticalExtent / 2, 0.1, 100);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.enablePan = true;
controls.screenSpacePanning = true;
controls.minZoom = 0.55;
controls.maxZoom = 3.2;
controls.target.set(0, 0, 0);
controls.autoRotateSpeed = 0.75;

const requestedLight = params.get('light');
const lightMode = requestedLight === 'neutral' || requestedLight === 'grazing' ? requestedLight : 'reference';
const lightSettings = {
  reference: {
    hemi: [0xfff3ea, 0xa78d82, 2] as const,
    key: [0xffe8dc, 3, [-3, 5, 6]] as const,
    fill: [0xdde8ff, 1.6, [3, -2, 5]] as const,
  },
  neutral: {
    hemi: [0xfffdf8, 0x625b59, 1.65] as const,
    key: [0xffffff, 2.45, [-3.5, 4.5, 6]] as const,
    fill: [0xe8efff, 1.05, [4, 2, 4.5]] as const,
  },
  grazing: {
    hemi: [0xffeee7, 0x423438, 0.85] as const,
    key: [0xffded0, 3.8, [-6, 1.2, 2.4]] as const,
    fill: [0xcddcff, 0.65, [4.5, 0.5, 3]] as const,
  },
} as const;
const installedLights = lightSettings[lightMode];
const hemi = new THREE.HemisphereLight(...installedLights.hemi);
hemi.name = `${lightMode}-hemi-${installedLights.hemi[2]}`;
const key = new THREE.DirectionalLight(installedLights.key[0], installedLights.key[1]);
key.name = `${lightMode}-key-${installedLights.key[1]}`;
key.position.set(installedLights.key[2][0], installedLights.key[2][1], installedLights.key[2][2]);
const fill = new THREE.DirectionalLight(installedLights.fill[0], installedLights.fill[1]);
fill.name = `${lightMode}-fill-${installedLights.fill[1]}`;
fill.position.set(installedLights.fill[2][0], installedLights.fill[2][1], installedLights.fill[2][2]);
scene.add(hemi, key, fill);

const root = createHeartModel();
root.name ||= 'heart-reference-model';
scene.add(root);
window.__MODEL_ROOT__ = root;

const runtime = (root.userData.sculptRuntime ?? {}) as SculptRuntime;
const runtimeNodes = runtime.nodes ?? {};
const partNodes = new Map<string, THREE.Object3D>();
for (const [id, node] of Object.entries(runtimeNodes)) partNodes.set(id, node);
for (const [id, mesh] of Object.entries(runtime.meshes ?? {})) {
  if (!partNodes.has(id)) partNodes.set(id, mesh);
}
root.traverse((object: THREE.Object3D) => {
  const component = object.userData.sculptComponent as SculptComponent | undefined;
  if (component?.id && !partNodes.has(component.id)) partNodes.set(component.id, object);
});

const rootBounds = new THREE.Box3().setFromObject(root);
const rootCenter = rootBounds.getCenter(new THREE.Vector3());
type ExplodeTarget = { id: string; node: THREE.Object3D; base: THREE.Vector3; offset: THREE.Vector3 };
const explodeTargets: ExplodeTarget[] = [];
let centralTargetIndex = 0;
for (const [id, node] of partNodes) {
  if (node === root || node.parent !== root) continue;
  const semantic = `${id} ${node.name}`.toLowerCase();
  if (/body|myocard|heart[-_ ]?mass|心肌|心脏主体/.test(semantic)) continue;
  const center = new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3());
  const offset = center.sub(rootCenter).multiplyScalar(0.6);
  if (/coronary|fat|adipose|冠状|脂肪/.test(semantic)) {
    offset.x *= 0.25;
    offset.y *= 0.25;
    offset.z = Math.max(offset.z, 0.72);
  } else if (offset.lengthSq() < 0.035) {
    const side = centralTargetIndex++ % 2 === 0 ? -1 : 1;
    offset.set(side * 0.28, 0.12 + centralTargetIndex * 0.04, 0.36);
  }
  explodeTargets.push({ id, node, base: node.position.clone(), offset });
}

let exploded = params.get('explode') === '1';
function setExploded(value: boolean): void {
  exploded = value;
  for (const target of explodeTargets) {
    target.node.position.copy(target.base).addScaledVector(target.offset, value ? 1 : 0);
  }
  camera.zoom = value ? 0.76 : 1;
  camera.updateProjectionMatrix();
  if (explodeButton) {
    explodeButton.textContent = value ? '恢复装配' : '分解部件';
    explodeButton.setAttribute('aria-pressed', String(value));
  }
}
window.__SET_EXPLODE__ = setExploded;
setExploded(exploded);

const viewPositions: Record<string, THREE.Vector3> = {
  front: new THREE.Vector3(0, 0, 9),
  right: new THREE.Vector3(9, 0, 0),
  rear: new THREE.Vector3(0, 0, -9),
  left: new THREE.Vector3(-9, 0, 0),
  threeQuarter: new THREE.Vector3(6.1, 1.15, 7.2),
};

function setView(name: string): void {
  const position = viewPositions[name] ?? viewPositions.front;
  controls.autoRotate = false;
  turntableButton?.setAttribute('aria-pressed', 'false');
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  camera.position.copy(position);
  camera.up.set(0, 1, 0);
  controls.target.set(0, 0, 0);
  camera.zoom = exploded ? 0.76 : 1;
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  controls.update();
  controls.enableDamping = damping;
}
window.__CAPTURE_VIEW__ = (view) => setView(view);
setView(params.get('view') ?? 'front');

explodeButton?.addEventListener('click', () => setExploded(!exploded));
document.querySelector<HTMLButtonElement>('#reset')?.addEventListener('click', () => setView('front'));
turntableButton?.addEventListener('click', () => {
  controls.autoRotate = !controls.autoRotate;
  turntableButton.setAttribute('aria-pressed', String(controls.autoRotate));
});

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerStart: { x: number; y: number; id: number } | null = null;
const restoredMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();

function componentFor(object: THREE.Object3D): { object: THREE.Object3D; component: SculptComponent } | null {
  let current: THREE.Object3D | null = object;
  while (current && current !== root.parent) {
    const component = current.userData.sculptComponent as SculptComponent | undefined;
    if (component?.id) return { object: current, component };
    current = current.parent;
  }
  for (const [id, node] of partNodes) {
    let ancestor: THREE.Object3D | null = object;
    while (ancestor) {
      if (ancestor === node) {
        const component = node.userData.sculptComponent as SculptComponent | undefined;
        return { object: node, component: component ?? { id, name: node.name || id } };
      }
      ancestor = ancestor.parent;
    }
  }
  return null;
}

function clearSelection(): void {
  for (const [mesh, material] of restoredMaterials) {
    const highlighted = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const clone of highlighted) clone.dispose();
    mesh.material = material;
  }
  restoredMaterials.clear();
}

function highlightPart(part: THREE.Object3D, label: string): void {
  clearSelection();
  part.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    restoredMaterials.set(object, object.material);
    const originals = Array.isArray(object.material) ? object.material : [object.material];
    const highlighted = originals.map((material) => {
      const clone = material.clone() as THREE.MeshStandardMaterial;
      if ('emissive' in clone && clone.emissive instanceof THREE.Color) {
        clone.emissive.set(0xff785f);
        clone.emissiveIntensity = 0.34;
      }
      return clone;
    });
    object.material = Array.isArray(object.material) ? highlighted : highlighted[0];
  });
  partLabel.textContent = label;
}

function selectPart(id: string): boolean {
  if (!window.__MODEL_READY__) return false;
  const node = partNodes.get(id);
  if (!node) return false;
  const component = node.userData.sculptComponent as SculptComponent | undefined;
  highlightPart(node, partName(id, node, component));
  return true;
}
window.__SELECT_PART__ = selectPart;

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
});
canvas.addEventListener('pointercancel', () => { pointerStart = null; });
canvas.addEventListener('pointerup', (event) => {
  const start = pointerStart;
  pointerStart = null;
  if (!window.__MODEL_READY__ || event.button !== 0 || !start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
  const rect = canvas.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(root, true)[0];
  const part = hit ? componentFor(hit.object) : null;
  if (!part) {
    clearSelection();
    partLabel.textContent = '单击部件查看名称';
    return;
  }
  const id = (part.component.id ?? part.object.name) || 'unknown';
  const name = partName(id, part.object, part.component);
  highlightPart(part.object, name);
});

function resize(): void {
  const width = Math.max(viewport.clientWidth, 1);
  const height = Math.max(viewport.clientHeight, 1);
  const aspect = width / height;
  const minimumNormalWidth = 3.5;
  const verticalExtent = captureMode
    ? referenceVerticalExtent
    : Math.max(referenceVerticalExtent, minimumNormalWidth / aspect);
  camera.left = -(verticalExtent * aspect) / 2;
  camera.right = (verticalExtent * aspect) / 2;
  camera.top = verticalExtent / 2;
  camera.bottom = -verticalExtent / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}
new ResizeObserver(resize).observe(viewport);
resize();

window.__PART_MANIFEST__ = () => ({
  schemaVersion: 1,
  rootId: root.name,
  parts: [...partNodes.entries()].map(([id, node]) => {
    const meshNames: string[] = [];
    node.traverse((object) => { if (object instanceof THREE.Mesh) meshNames.push(object.name || `${id}-mesh`); });
    const component = node.userData.sculptComponent as SculptComponent | undefined;
    return { id, name: partName(id, node, component), meshNames };
  }),
});

let fps = 0;
let frames = 0;
let fpsStart = performance.now();
let previousFrame = fpsStart;
window.__RENDER_INFO__ = () => ({
  fps,
  drawCalls: renderer.info.render.calls,
  triangles: renderer.info.render.triangles,
  lines: renderer.info.render.lines,
  points: renderer.info.render.points,
  geometries: renderer.info.memory.geometries,
  textures: renderer.info.memory.textures,
  programs: renderer.info.programs?.length ?? 0,
});

function render(now: number): void {
  const delta = Math.min((now - previousFrame) / 1000, 0.05);
  previousFrame = now;
  frames += 1;
  if (now - fpsStart >= 1000) {
    fps = (frames * 1000) / (now - fpsStart);
    frames = 0;
    fpsStart = now;
  }
  controls.update(delta);
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}

status.textContent = '正在载入组织材质…';
Promise.resolve(root.userData.materialReady).then(() => {
  status.textContent = '程序化近似模型已就绪';
  window.__MODEL_READY__ = true;
}).catch((error: unknown) => {
  status.textContent = '材质加载失败，请刷新页面重试';
  console.error('Heart material loading failed:', error);
});
requestAnimationFrame(render);
