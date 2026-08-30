import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  configureMitochondrionCutawayRenderer,
  createMitochondrionCutawayLookDevLights,
  createMitochondrionCutawayModel,
} from './createObjectModel';
import './style.css';

declare global {
  interface Window {
    __MODEL_READY__?: boolean;
    __MODEL_ROOT__?: THREE.Group;
    __CAPTURE_VIEW__?: (view: string) => void;
    __PART_MANIFEST__?: () => unknown;
    __RENDER_INFO__?: () => unknown;
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
const viewport = document.querySelector<HTMLElement>('.viewport');
const status = document.querySelector<HTMLElement>('#status');
const partLabel = document.querySelector<HTMLElement>('#part-label');
if (!canvas || !viewport || !status || !partLabel) throw new Error('Viewer DOM is incomplete.');

const params = new URLSearchParams(location.search);
if (params.get('capture') === '1') document.body.classList.add('capture');
const captureMode = params.get('capture') === '1';

const scene = new THREE.Scene();
scene.background = new THREE.Color(captureMode ? 0xffffff : 0xf4f1ec);
scene.fog = new THREE.Fog(captureMode ? 0xffffff : 0xf4f1ec, 10, 18);

const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 50);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
configureMitochondrionCutawayRenderer(renderer);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.minDistance = 4.4;
controls.maxDistance = 11;
controls.target.set(-0.1, 0.05, 0);
controls.autoRotateSpeed = 0.8;

const requestedLight = params.get('light');
const lightMode = requestedLight === 'neutral' || requestedLight === 'grazing' ? requestedLight : 'reference';
const lights = createMitochondrionCutawayLookDevLights(lightMode);
scene.add(lights);

const root = createMitochondrionCutawayModel({ castShadow: true, receiveShadow: true, textureSize: 1024 });
root.name = 'mitochondrion-cutaway';
root.rotation.y = -0.08;
root.scale.set(0.91, 1.06, 1.06);
if (params.get('clay') === '1') {
  const clay = new THREE.MeshStandardMaterial({ color: 0xb8afa4, roughness: 0.78, metalness: 0 });
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) child.material = clay;
  });
}
scene.add(root);
window.__MODEL_ROOT__ = root;

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(3.2, 96),
  new THREE.ShadowMaterial({ color: 0x4f2f22, opacity: 0.18 }),
);
ground.name = 'ground-shadow';
ground.rotation.x = -Math.PI / 2;
ground.position.y = -1.82;
ground.position.z = -0.25;
ground.receiveShadow = true;
ground.visible = !captureMode;
scene.add(ground);

const views: Record<string, [number, number, number]> = {
  front: [0.15, 0.1, 7.2],
  threeQuarter: [4.6, 0.25, 5.7],
  right: [7.2, 0.05, 0.1],
  rear: [0.05, 0.1, -7.2],
  left: [-7.2, 0.05, 0.1],
  top: [0.05, 7.2, 0.1],
  close: [0.12, 0.12, 5.4],
};

function setView(name: string): void {
  const position = views[name] ?? views.front;
  camera.position.set(...position);
  controls.target.set(-0.1, 0.05, 0);
  camera.lookAt(controls.target);
  controls.update();
}
setView(params.get('view') ?? 'front');
window.__CAPTURE_VIEW__ = setView;

const runtime = (root.userData.sculptRuntime ?? {}) as {
  nodes?: Record<string, THREE.Object3D>;
  meshes?: Record<string, THREE.Mesh>;
};
const nodes = runtime.nodes ?? {};
const assembledPositions = new Map<string, THREE.Vector3>();
for (const [id, node] of Object.entries(nodes)) assembledPositions.set(id, node.position.clone());

let exploded = params.get('explode') === '1';
function applyExplode(value: number): void {
  const offsets: Record<string, THREE.Vector3> = {
    'matrix-volume': new THREE.Vector3(-0.55, 0, 0.75),
    'inner-boundary': new THREE.Vector3(-1.05, 0.05, 1.25),
    'cutaway-rim': new THREE.Vector3(-1.45, 0.05, 1.55),
  };
  for (const [id, node] of Object.entries(nodes)) {
    const base = assembledPositions.get(id);
    if (!base) continue;
    node.position.copy(base).addScaledVector(offsets[id] ?? new THREE.Vector3(), value);
  }
}
applyExplode(exploded ? 1 : 0);

document.querySelector<HTMLButtonElement>('#explode')?.addEventListener('click', (event) => {
  exploded = !exploded;
  (event.currentTarget as HTMLButtonElement).textContent = exploded ? '装配视图' : '爆炸视图';
  applyExplode(exploded ? 1 : 0);
});
document.querySelector<HTMLButtonElement>('#reset')?.addEventListener('click', () => setView('front'));
document.querySelector<HTMLButtonElement>('#turntable')?.addEventListener('click', (event) => {
  controls.autoRotate = !controls.autoRotate;
  (event.currentTarget as HTMLButtonElement).setAttribute('aria-pressed', String(controls.autoRotate));
});

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let selected: THREE.Object3D | null = null;
const selectedMaterials = new Map<THREE.Material, { emissive: THREE.Color; intensity: number }>();

function clearSelection(): void {
  for (const [material, previous] of selectedMaterials) {
    const candidate = material as THREE.MeshStandardMaterial;
    candidate.emissive.copy(previous.emissive);
    candidate.emissiveIntensity = previous.intensity;
  }
  selectedMaterials.clear();
  selected = null;
}

canvas.addEventListener('pointerdown', (event) => {
  const rect = canvas.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(root, true)[0];
  clearSelection();
  if (!hit) {
    partLabel.textContent = '单击部件查看名称';
    return;
  }
  selected = hit.object;
  const hitMaterial = (hit.object as THREE.Mesh).material;
  const materialList: THREE.Material[] = Array.isArray(hitMaterial) ? hitMaterial : [hitMaterial];
  for (const material of materialList) {
    const candidate = material as THREE.MeshStandardMaterial;
    if (!candidate?.emissive) continue;
    selectedMaterials.set(material, { emissive: candidate.emissive.clone(), intensity: candidate.emissiveIntensity });
    candidate.emissive.set(0xffb64a);
    candidate.emissiveIntensity = 0.34;
  }
  let owner: THREE.Object3D | null = hit.object;
  while (owner && !owner.userData.sculptComponent) owner = owner.parent;
  const component = owner?.userData.sculptComponent as { name?: string; id?: string } | undefined;
  partLabel.textContent = component?.name ?? component?.id ?? hit.object.name ?? '未命名部件';
});

function resize(): void {
  const width = viewport!.clientWidth;
  const height = viewport!.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();

window.__PART_MANIFEST__ = () => {
  const parts: Array<{ id: string; name: string; meshNames: string[]; childIds: string[] }> = [];
  for (const [id, node] of Object.entries(nodes)) {
    const meshNames: string[] = [];
    node.traverse((child) => { if ((child as THREE.Mesh).isMesh) meshNames.push(child.name || `${id}-mesh`); });
    const childIds = node.children.map((child) => child.userData?.sculptComponent?.id).filter(Boolean);
    parts.push({ id, name: node.name || id, meshNames, childIds });
  }
  return { schemaVersion: 1, rootId: 'root', parts };
};

let last = performance.now();
let fpsWindowStart = last;
let fpsFrames = 0;
let measuredFps = 0;
window.__RENDER_INFO__ = () => ({
  fps: measuredFps,
  render: { ...renderer.info.render },
  memory: { ...renderer.info.memory },
  programs: renderer.info.programs?.length ?? 0,
  performanceBudget: root.userData.performanceBudget,
});
function render(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  fpsFrames += 1;
  if (now - fpsWindowStart >= 1000) {
    measuredFps = (fpsFrames * 1000) / (now - fpsWindowStart);
    fpsFrames = 0;
    fpsWindowStart = now;
  }
  controls.update(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}

status.textContent = '程序化模型已就绪';
window.__MODEL_READY__ = true;
requestAnimationFrame(render);
