import * as THREE from 'three';

export type MaterialId = 'myocardium' | 'arterial' | 'venous' | 'atrial' | 'fat' | 'coronaryRed' | 'coronaryBlue';

// Retain the observed fine structure without repeating the crop's broad highlight/shadow.
function normalizedDetail(source: THREE.Texture): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1024;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const low = document.createElement('canvas');
  low.width = low.height = 1024;
  const lowContext = low.getContext('2d', { willReadFrequently: true });
  if (!context || !lowContext) throw new Error('Cannot prepare tissue texture canvases');
  context.drawImage(source.image, 0, 0, 1024, 1024);
  lowContext.filter = 'blur(70px)';
  lowContext.drawImage(canvas, 0, 0);
  const detail = context.getImageData(0, 0, 1024, 1024);
  const broad = lowContext.getImageData(0, 0, 1024, 1024).data;
  for (let i = 0; i < detail.data.length; i += 4) {
    const value = (detail.data[i] + detail.data[i + 1] + detail.data[i + 2]) / 3;
    const baseline = (broad[i] + broad[i + 1] + broad[i + 2]) / 3;
    const ratio = THREE.MathUtils.clamp(value / Math.max(1, baseline), 0.68, 1.32);
    const shade = Math.round(232 * (1 + (ratio - 1) * 0.45));
    detail.data[i] = detail.data[i + 1] = detail.data[i + 2] = shade;
  }
  context.putImageData(detail, 0, 0);
  source.dispose();
  return new THREE.CanvasTexture(canvas);
}

/** Repeated, reference-derived tissue patches; these are appearance estimates, not measured PBR. */
export function createHeartMaterials(): {
  materials: Record<MaterialId, THREE.MeshPhysicalMaterial>;
  ready: Promise<void>;
} {
  const palette: Record<MaterialId, number> = {
    myocardium: 0xc66356, arterial: 0xd14637, venous: 0x5e82cb, atrial: 0xcd7871,
    fat: 0xebad80, coronaryRed: 0xc82417, coronaryBlue: 0x24539a,
  };
  const materials = Object.fromEntries(Object.entries(palette).map(([id, color]) => [id,
    new THREE.MeshPhysicalMaterial({ name: id, color, roughness: 0.65, metalness: 0,
      clearcoat: 0.20, clearcoatRoughness: 0.32 }),
  ])) as Record<MaterialId, THREE.MeshPhysicalMaterial>;
  materials.coronaryRed.roughness = 0.36;
  materials.coronaryBlue.roughness = 0.40;
  const loader = new THREE.TextureLoader();
  const repeats: Record<string, [number, number]> = {
    myocardium: [20, 9], arterial: [6, 2], venous: [6, 2], atrial: [4, 2], fat: [5, 2],
  };
  const ready = Promise.all(Object.entries(repeats).map(async ([name, repeat]) => {
    const material = materials[name as MaterialId];
    const textures = await Promise.all(['albedo', 'normal', 'roughness', 'ao'].map(async (channel) => {
      const url = new URL(`textures/${name}-${channel}.png`, document.baseURI).href;
      const loaded = await loader.loadAsync(url);
      const texture = channel === 'albedo' ? normalizedDetail(loaded) : loaded;
      texture.name = `${name}-${channel}-reference-derived`;
      texture.colorSpace = channel === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.wrapS = texture.wrapT = THREE.MirroredRepeatWrapping;
      texture.repeat.set(...repeat);
      texture.anisotropy = 4;
      texture.needsUpdate = true;
      return texture;
    }));
    [material.map, material.normalMap, material.roughnessMap, material.aoMap] = textures;
    material.aoMapIntensity = 0.16;
    material.normalScale.setScalar(name === 'fat' ? 0.15 : name === 'myocardium' ? 0.17 : 0.24);
    material.needsUpdate = true;
  })).then(() => undefined);
  return { materials, ready };
}
