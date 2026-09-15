import * as THREE from 'three';

export type MaterialId = 'myocardium' | 'arterial' | 'venous' | 'atrial' | 'fat' | 'coronaryRed' | 'coronaryBlue';

/** Repeated, reference-derived tissue patches; these are appearance estimates, not measured PBR. */
export function createHeartMaterials(): {
  materials: Record<MaterialId, THREE.MeshPhysicalMaterial>;
  ready: Promise<void>;
} {
  const palette: Record<MaterialId, number> = {
    myocardium: 0xbfb3b0, arterial: 0xb9afa9, venous: 0xaab7cf, atrial: 0xbfb2b0,
    fat: 0xe2cbb5, coronaryRed: 0xc82417, coronaryBlue: 0x24539a,
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
      const texture = await loader.loadAsync(url);
      texture.name = `${name}-${channel}-reference-derived`;
      texture.colorSpace = channel === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(...repeat);
      texture.anisotropy = 4;
      texture.needsUpdate = true;
      return texture;
    }));
    [material.map, material.normalMap, material.roughnessMap, material.aoMap] = textures;
    material.aoMapIntensity = 0.16;
    material.normalScale.setScalar(name === 'fat' ? 0.30 : 0.65);
    material.needsUpdate = true;
  })).then(() => undefined);
  return { materials, ready };
}
