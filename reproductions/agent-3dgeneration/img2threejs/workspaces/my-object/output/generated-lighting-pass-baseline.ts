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

function buildTubeGeometry(
  path: { points: [number, number, number][]; radius?: number; radialSegments?: number; closed?: boolean },
): THREE.TubeGeometry {
  const vectors = path.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, path.closed ?? false);
  const tubularSegments = Math.max(8, path.points.length * 6);
  return new THREE.TubeGeometry(curve, tubularSegments, path.radius ?? 0.05, path.radialSegments ?? 8, path.closed ?? false);
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

// Generated from ObjectSculptSpec target: Mitochondrion Cutaway
// Sculpt build pass: lighting-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createMitochondrionCutawayModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Mitochondrion Cutaway";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 32.0, "aspect": 0.7194244604, "orientation": {"yaw": -12.0, "pitch": 3.0, "roll": 0.0}, "positionHint": [0.0, 0.05, 7.2], "note": "Approximate orthographic-like three-quarter framing estimated from the single illustration; pixel projection is intentionally not used."}, "approximationNotes": []};
  root.userData.materialPipeline = {"schemaVersion": 1, "status": "proceed", "registry": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\docs\\materials\\material-reference.json", "analysisArtifact": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-analysis.json", "targetThreshold": 0.7, "unresolvedNotObservedMaterials": [], "regions": [{"componentId": "root", "regionId": "outer-shell-right-flank", "specMaterialId": "shell-material", "profileId": "plastic.matte", "status": "proceed"}, {"componentId": "inner-boundary", "regionId": "gold-inner-membrane", "specMaterialId": "membrane-material", "profileId": "plastic.glossy", "status": "proceed"}, {"componentId": "matrix-volume", "regionId": "pale-matrix", "specMaterialId": "matrix-material", "profileId": "plastic.matte", "status": "proceed"}], "controlledViewsRequired": ["albedo-unlit", "environment-reflection", "grazing", "neutral-studio", "reference-beauty"]};
  root.userData.materialReferenceRegistry = "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\docs\\materials\\material-reference.json";

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["shell-material"] = createSculptMaterial(
    "shell-material",
    {"id": "shell-material", "name": "Warm brown rough outer membrane", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#98583B", "color": "#98583B", "albedo": {"dominant": "#98583B", "secondary": ["#633A2C", "#BC7651"], "samplingNotes": "Use image-observed local color zones, not a single averaged color."}, "colorVariation": {"palette": ["#98583B", "#633A2C", "#BC7651"], "pattern": "mottled", "amplitude": 0.18, "heightCorrelation": 0.35}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.68, "variation": 0.18, "map": "independent-procedural-field", "localResponse": "higher roughness in cavities, lower roughness on worn edges"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.42, "scale": 42.0, "space": "tangent"}, "bump": {"pattern": "independent-cellular-height-field", "amplitude": 0.028, "scale": 38.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.08, "cavityBias": 0.65, "color": "#2F2A22"}, "localOverrides": [{"id": "cutaway-seam-darkening", "region": "cutaway inner seam", "baseColor": "#5B3024", "roughness": 0.78, "cavityBias": 0.9, "evidenceRefs": ["full-object"]}, {"id": "meso-pitting", "region": "right flank and lower lobe", "roughness": 0.76, "normalStrength": 0.35, "scale": 18, "evidenceRefs": ["full-object"]}, {"id": "micro-grain", "region": "whole shell", "roughness": 0.72, "normalStrength": 0.18, "scale": 58, "evidenceRefs": ["full-object"]}, {"id": "crown-highlight", "region": "upper-left crown", "roughness": 0.48, "clearcoat": 0.08, "clearcoatRoughness": 0.44, "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Procedural multi-frequency shell response matched statistically from the low-resolution reference; no pixel projection.", "referenceMaterialId": "plastic.matte", "materialFamily": "plastic", "materialSubtype": "generic-polymer", "materialFinish": "matte", "materialReference": {"registry": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\docs\\materials\\material-reference.json", "profileId": "plastic.matte", "method": "family-subtype-finish", "confidence": 0.845, "sourceRefs": ["three.mesh-standard", "adobe.pbr-guide-1", "google.filament-pbr", "mit.material-recognition"], "requiredMaps": ["map", "roughnessMap"], "optionalMaps": ["normalMap", "aoMap"], "validationViews": ["albedo-unlit", "neutral-studio", "grazing"]}, "ior": {"base": 1.5, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\00-outer-shell-right-flank.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.845, "estimatedFidelity": 0.845, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\pbr-00-outer-shell-right-flank\\shell-material_albedo.png", "url": "shell-material_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\pbr-00-outer-shell-right-flank\\shell-material_roughness.png", "url": "shell-material_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\pbr-00-outer-shell-right-flank\\shell-material_height.png", "url": "shell-material_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\pbr-00-outer-shell-right-flank\\shell-material_normal.png", "url": "shell-material_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\pbr-00-outer-shell-right-flank\\shell-material_ao.png", "url": "shell-material_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 50, "sourceHeight": 188, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 50, "height": 188}, "mask": {"backgroundColor": "#FDFDFD", "backgroundNoise": 183.079, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.8264}, "mapStats": {"valueRange": 0.3478, "heightP90Gradient": 0.06056, "roughnessBase": 0.733, "roughnessVariation": 0.124, "normalStrength": 0.227, "blurRadius": 10}, "palette": ["#85583E", "#98694D", "#734932", "#B17D5F", "#CA987A"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#BB8768", "#A9765A", "#8E5E43", "#987663", "#E8E3E1"], "paletteHueRisk": [], "gradientAxis": "horizontal", "stats": {"meanLum": 134.2, "meanSaturation": 0.43, "gradientStrength": 0.496, "mottle": 0.023, "streakRatio": 0.68, "hueSpread": 0.0, "specularFraction": 0.122}}, "materialEvidence": {"componentId": "root", "regionId": "outer-shell-right-flank", "crop": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\00-outer-shell-right-flank.png", "bbox": {"x": 124, "y": 44, "width": 50, "height": 188}, "sourceWidth": 200, "sourceHeight": 278, "loaderWarnings": [], "coverage": 0.1691}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "root", "regionId": "outer-shell-right-flank", "materialId": null, "family": "plastic", "subtype": "generic-polymer", "finish": "matte", "aliases": [], "confidence": 0.845, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["membrane-material"] = createSculptMaterial(
    "membrane-material",
    {"id": "membrane-material", "name": "Satin gold inner membrane", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#E4B346", "color": "#E4B346", "albedo": {"dominant": "#E4B346", "secondary": ["#9B621C", "#FFE38A"], "samplingNotes": "Gold-yellow crest with ochre contact line and pale highlight."}, "colorVariation": {"palette": ["#E4B346", "#9B621C", "#FFE38A"], "pattern": "crest-to-cavity", "amplitude": 0.12, "heightCorrelation": 0.7}, "textureResolution": 1024, "textureProjection": {"mode": "curve-generated", "repeat": [3, 1], "anisotropy": 8, "texelDensityIntent": "Stable along membrane curves."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.08, "role": "broad crest shading"}, {"id": "meso", "frequency": 14, "amplitude": 0.035, "role": "subtle membrane waviness"}, {"id": "micro", "frequency": 64, "amplitude": 0.012, "role": "highlight breakup"}], "roughness": {"base": 0.28, "variation": 0.09, "map": "independent-procedural-field", "localResponse": "lower roughness on convex crests"}, "metalness": {"base": 0.0, "variation": 0}, "normal": {"pattern": "independent-fine-noise", "strength": 0.1, "scale": 54, "space": "tangent"}, "bump": {"pattern": "fine-membrane-grain", "amplitude": 0.008, "scale": 52}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.34, "contactShadowBias": 0.45, "notes": "Dark ochre at fold-to-boundary contacts."}, "wear": {"edgeWear": 0, "scratches": [], "chips": []}, "dirt": {"amount": 0.02, "cavityBias": 0.6, "color": "#714414"}, "localOverrides": [{"id": "crest-gloss", "region": "convex membrane crest", "roughness": 0.16, "clearcoat": 0.18, "clearcoatRoughness": 0.2, "evidenceRefs": ["full-object"]}, {"id": "contact-ochre", "region": "fold bases and inner boundary recess", "baseColor": "#9B621C", "roughness": 0.38, "cavityBias": 0.8, "evidenceRefs": ["full-object"]}], "shaderNotes": ["Dielectric gold-yellow biological membrane; metalness remains zero.", "Use independent albedo, roughness, normal, and AO fields."], "notes": "Smoothest material in the scene, with restrained clearcoat only on crest highlights.", "referenceMaterialId": "plastic.glossy", "materialFamily": "plastic", "materialSubtype": "generic-polymer", "materialFinish": "glossy", "materialReference": {"registry": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\docs\\materials\\material-reference.json", "profileId": "plastic.glossy", "method": "family-subtype-finish", "confidence": 0.86, "sourceRefs": ["three.mesh-physical", "three.mesh-standard", "adobe.pbr-guide-1", "google.filament-pbr", "mit.material-recognition"], "requiredMaps": ["map", "roughnessMap"], "optionalMaps": ["normalMap", "clearcoatMap"], "validationViews": ["neutral-studio", "grazing", "environment-reflection", "reference-beauty"]}, "clearcoat": {"base": 0.2, "variation": 0.0}, "clearcoatRoughness": {"base": 0.18, "variation": 0.0}, "ior": {"base": 1.5, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\01-gold-inner-membrane.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\pbr-01-gold-inner-membrane\\membrane-material_albedo.png", "url": "membrane-material_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\pbr-01-gold-inner-membrane\\membrane-material_roughness.png", "url": "membrane-material_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\pbr-01-gold-inner-membrane\\membrane-material_height.png", "url": "membrane-material_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\pbr-01-gold-inner-membrane\\membrane-material_normal.png", "url": "membrane-material_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\pbr-01-gold-inner-membrane\\membrane-material_ao.png", "url": "membrane-material_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 82, "sourceHeight": 184, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 82, "height": 184}, "mask": {"backgroundColor": "#BD6B4B", "backgroundNoise": 198.884, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.8938}, "mapStats": {"valueRange": 0.5712, "heightP90Gradient": 0.19508, "roughnessBase": 0.806, "roughnessVariation": 0.205, "normalStrength": 0.385, "blurRadius": 10}, "palette": ["#B8875A", "#D9A973", "#9B6C3D", "#EDCE99", "#673F1E"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "gem-metal", "recipe": {"metalness": 0.75, "roughness": 0.14, "clearcoat": 0.6, "clearcoatRoughness": 0.06, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.3, "anisotropy": 0.0, "procedural": "gradient-smoke"}, "palette": ["#E3D3C7", "#A37447", "#BE9765", "#BE976B", "#BA815C"], "paletteHueRisk": [], "gradientAxis": "horizontal", "stats": {"meanLum": 160.8, "meanSaturation": 0.456, "gradientStrength": 0.427, "mottle": 0.077, "streakRatio": 0.62, "hueSpread": 0.009, "specularFraction": 0.106}}, "materialEvidence": {"componentId": "inner-boundary", "regionId": "gold-inner-membrane", "crop": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\01-gold-inner-membrane.png", "bbox": {"x": 35, "y": 39, "width": 82, "height": 184}, "sourceWidth": 200, "sourceHeight": 278, "loaderWarnings": [], "coverage": 0.2714}, "observations": ["chromatic base-colour response", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "inner-boundary", "regionId": "gold-inner-membrane", "materialId": null, "family": "plastic", "subtype": "generic-polymer", "finish": "glossy", "aliases": [], "confidence": 0.86, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["matrix-material"] = createSculptMaterial(
    "matrix-material",
    {"id": "matrix-material", "name": "Pale granular matrix", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#D8BE84", "color": "#D8BE84", "albedo": {"dominant": "#D8BE84", "secondary": ["#B49360", "#EAD7A2"], "samplingNotes": "Low-saturation beige field behind gold membrane."}, "colorVariation": {"palette": ["#D8BE84", "#B49360", "#EAD7A2"], "pattern": "fine-speckled", "amplitude": 0.08, "heightCorrelation": 0.15}, "textureResolution": 1024, "textureProjection": {"mode": "planar-front", "repeat": [2.5, 4], "anisotropy": 4, "texelDensityIntent": "Fine speckles visible only inside aperture."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.04, "role": "recess value falloff"}, {"id": "meso", "frequency": 18, "amplitude": 0.05, "role": "granular patches"}, {"id": "micro", "frequency": 72, "amplitude": 0.025, "role": "fine speckle"}], "roughness": {"base": 0.68, "variation": 0.1, "map": "independent-procedural-field", "localResponse": "matte field with slightly rougher speckles"}, "metalness": {"base": 0.0, "variation": 0}, "normal": {"pattern": "independent-speckle-height", "strength": 0.18, "scale": 68, "space": "tangent"}, "bump": {"pattern": "fine-granular", "amplitude": 0.014, "scale": 68}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.32, "contactShadowBias": 0.42, "notes": "Darken behind gold folds and granules."}, "wear": {"edgeWear": 0, "scratches": [], "chips": []}, "dirt": {"amount": 0.04, "cavityBias": 0.35, "color": "#806647"}, "localOverrides": [{"id": "fine-speckles", "region": "exposed matrix only", "baseColor": "#947652", "roughness": 0.82, "normalStrength": 0.16, "scale": 74, "evidenceRefs": ["full-object"]}, {"id": "fold-contact-shadow", "region": "within 0.04 units of membrane folds", "baseColor": "#B28F5B", "roughness": 0.78, "cavityBias": 0.85, "evidenceRefs": ["full-object"]}], "shaderNotes": ["Keep micro contrast below the granules and gold membrane."], "notes": "Matte recessed field; visual depth depends on occlusion and directional key light.", "referenceMaterialId": "plastic.matte", "materialFamily": "plastic", "materialSubtype": "generic-polymer", "materialFinish": "matte", "materialReference": {"registry": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\upstream\\docs\\materials\\material-reference.json", "profileId": "plastic.matte", "method": "family-subtype-finish", "confidence": 0.829, "sourceRefs": ["three.mesh-standard", "adobe.pbr-guide-1", "google.filament-pbr", "mit.material-recognition"], "requiredMaps": ["map", "roughnessMap"], "optionalMaps": ["normalMap", "aoMap"], "validationViews": ["albedo-unlit", "neutral-studio", "grazing"]}, "ior": {"base": 1.5, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\02-pale-matrix.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\pbr-02-pale-matrix\\matrix-material_albedo.png", "url": "matrix-material_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\pbr-02-pale-matrix\\matrix-material_roughness.png", "url": "matrix-material_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\pbr-02-pale-matrix\\matrix-material_height.png", "url": "matrix-material_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\pbr-02-pale-matrix\\matrix-material_normal.png", "url": "matrix-material_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\pbr-02-pale-matrix\\matrix-material_ao.png", "url": "matrix-material_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 48, "sourceHeight": 120, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 48, "height": 120}, "mask": {"backgroundColor": "#DBAA7D", "backgroundNoise": 82.03, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9936}, "mapStats": {"valueRange": 0.6194, "heightP90Gradient": 0.15734, "roughnessBase": 0.796, "roughnessVariation": 0.196, "normalStrength": 0.341, "blurRadius": 10}, "palette": ["#DEB77B", "#BD935C", "#996F3D", "#EDD09E", "#623A1C"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "candy-coat", "recipe": {"metalness": 0.35, "roughness": 0.18, "clearcoat": 0.6, "clearcoatRoughness": 0.15, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.7, "anisotropy": 0.0, "procedural": "gradient-smoke"}, "palette": ["#D0AA7A", "#C2A072", "#B08A60", "#C69F63", "#C19F6E"], "paletteHueRisk": [], "gradientAxis": "vertical", "stats": {"meanLum": 155.2, "meanSaturation": 0.502, "gradientStrength": 0.317, "mottle": 0.052, "streakRatio": 0.37, "hueSpread": 0.007, "specularFraction": 0.007}}, "materialEvidence": {"componentId": "matrix-volume", "regionId": "pale-matrix", "crop": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\02-pale-matrix.png", "bbox": {"x": 50, "y": 55, "width": 48, "height": 120}, "sourceWidth": 200, "sourceHeight": 278, "loaderWarnings": [], "coverage": 0.1036}, "observations": ["chromatic base-colour response", "directional surface frequency", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "matrix-volume", "regionId": "pale-matrix", "materialId": null, "family": "plastic", "subtype": "generic-polymer", "finish": "matte", "aliases": [], "confidence": 0.829, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["granule-material"] = createSculptMaterial(
    "granule-material",
    {"id": "granule-material", "name": "Brown matrix granules and specks", "qualityTier": "utility", "type": "standard", "shaderModel": "MeshStandardMaterial", "baseColor": "#966C3F", "color": "#966C3F", "albedo": {"dominant": "#966C3F", "secondary": ["#5D4936", "#B58C55"], "samplingNotes": "Two brown value bands distributed irregularly."}, "colorVariation": {"palette": ["#966C3F", "#5D4936", "#B58C55"], "pattern": "per-instance deterministic", "amplitude": 0.2, "heightCorrelation": 0}, "textureResolution": 1024, "textureProjection": {"mode": "generated", "repeat": [1, 1], "anisotropy": 2, "texelDensityIntent": "Per-instance solid colors plus independent highlight response."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1, "amplitude": 0.08, "role": "per-instance value family"}, {"id": "meso", "frequency": 10, "amplitude": 0.025, "role": "ellipsoid form breakup"}, {"id": "micro", "frequency": 48, "amplitude": 0.01, "role": "highlight breakup"}], "roughness": {"base": 0.58, "variation": 0.1, "map": "independent-procedural-field", "localResponse": "slightly smoother crowns"}, "metalness": {"base": 0, "variation": 0}, "normal": {"pattern": "independent-fine-noise", "strength": 0.08, "scale": 45, "space": "tangent"}, "bump": {"pattern": "fine-grain", "amplitude": 0.004, "scale": 45}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.2, "contactShadowBias": 0.25, "notes": "Contact darkening where granules embed into matrix."}, "wear": {"edgeWear": 0, "scratches": [], "chips": []}, "dirt": {"amount": 0, "cavityBias": 0, "color": "#5D4936"}, "localOverrides": [{"id": "dark-granule-mix", "region": "deterministic 35 percent of instances", "baseColor": "#5D4936", "roughness": 0.64, "evidenceRefs": ["full-object"]}], "shaderNotes": ["Use deterministic instance colors; do not form a grid."], "notes": "Small raised elements remain subordinate to the cristae folds."},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Outer membrane shell__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Outer membrane shell", "level": "macro", "role": "outer-shell", "importance": 1.0, "confidence": 0.86, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "The visible outer surface is one continuously rounded bean-shaped volume with no hard faces or construction seams.", "geometryDescriptor": {"topologyIntent": "organic deformed ellipsoid with deterministic low-amplitude surface displacement", "edgeTreatment": {"type": "rounded-continuous", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [{"type": "bend", "axis": "y", "amount": 0.14}, {"type": "local-swelling", "region": "lower-lobe", "amount": 0.1}, {"type": "noise-displacement", "frequency": 9.0, "amplitude": 0.025, "seed": 4137}], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 2.05, "height": 3.4, "depth": 1.3, "units": "relative", "confidence": 0.78}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "ellipsoid", "offset": [0, 0, 0], "scale": [2.05, 3.4, 1.3], "isTrigger": false, "notes": "Closed ellipsoid proxy; the visible cutaway is shallow relief and does not open the rear collider."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shell-material"}}, "material": "shell-material", "materialLayers": ["shell-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "macro-undulation", "type": "local-deformation", "amplitude": 0.025, "frequency": 3.0}, {"id": "shell-meso-relief", "type": "displacement", "amplitude": 0.014, "frequency": 15.0}, {"id": "shell-clean-silhouette", "type": "normal-only", "silhouetteAffects": false}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.14, "bumpAmplitude": 0.035, "normalPattern": "deterministic cellular grain at frequency 42", "displacementPattern": "low-amplitude domain-warped noise on broad shell faces", "occlusionPattern": "darken micro-cavities without shifting silhouette", "edgeWearPattern": "none; biological shell has no chipped hard edge", "notes": "Three frequency bands remain subtle enough to preserve the rounded silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(151, 82, 52, 1)", "secondaryAlbedo": "rgba(102, 55, 39, 1)", "materialClass": "skin", "materialClassConfidence": 0.72, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(102, 55, 39, 1)"}, {"position": 0.55, "color": "rgba(151, 82, 52, 1)"}, {"position": 1.0, "color": "rgba(188, 111, 72, 1)"}]}}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "hero", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "shell-material"}, "materialRegions": [{"regionId": "outer-shell-right-flank", "materialId": "shell-material", "profileId": "plastic.matte", "crop": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\00-outer-shell-right-flank.png", "bbox": {"x": 124, "y": 44, "width": 50, "height": 188}, "sourceWidth": 200, "sourceHeight": 278, "loaderWarnings": [], "coverage": 0.1691}}]};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "ellipsoid", "offset": [0, 0, 0], "scale": [2.05, 3.4, 1.3], "isTrigger": false, "notes": "Closed ellipsoid proxy; the visible cutaway is shallow relief and does not open the rear collider."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shell-material"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["shell-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Outer membrane shell";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Outer membrane shell", "level": "macro", "role": "outer-shell", "importance": 1.0, "confidence": 0.86, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "The visible outer surface is one continuously rounded bean-shaped volume with no hard faces or construction seams.", "geometryDescriptor": {"topologyIntent": "organic deformed ellipsoid with deterministic low-amplitude surface displacement", "edgeTreatment": {"type": "rounded-continuous", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [{"type": "bend", "axis": "y", "amount": 0.14}, {"type": "local-swelling", "region": "lower-lobe", "amount": 0.1}, {"type": "noise-displacement", "frequency": 9.0, "amplitude": 0.025, "seed": 4137}], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 2.05, "height": 3.4, "depth": 1.3, "units": "relative", "confidence": 0.78}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.95}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "ellipsoid", "offset": [0, 0, 0], "scale": [2.05, 3.4, 1.3], "isTrigger": false, "notes": "Closed ellipsoid proxy; the visible cutaway is shallow relief and does not open the rear collider."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shell-material"}}, "material": "shell-material", "materialLayers": ["shell-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "macro-undulation", "type": "local-deformation", "amplitude": 0.025, "frequency": 3.0}, {"id": "shell-meso-relief", "type": "displacement", "amplitude": 0.014, "frequency": 15.0}, {"id": "shell-clean-silhouette", "type": "normal-only", "silhouetteAffects": false}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.14, "bumpAmplitude": 0.035, "normalPattern": "deterministic cellular grain at frequency 42", "displacementPattern": "low-amplitude domain-warped noise on broad shell faces", "occlusionPattern": "darken micro-cavities without shifting silhouette", "edgeWearPattern": "none; biological shell has no chipped hard edge", "notes": "Three frequency bands remain subtle enough to preserve the rounded silhouette."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(151, 82, 52, 1)", "secondaryAlbedo": "rgba(102, 55, 39, 1)", "materialClass": "skin", "materialClassConfidence": 0.72, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(102, 55, 39, 1)"}, {"position": 0.55, "color": "rgba(151, 82, 52, 1)"}, {"position": 1.0, "color": "rgba(188, 111, 72, 1)"}]}}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "hero", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "shell-material"}, "materialRegions": [{"regionId": "outer-shell-right-flank", "materialId": "shell-material", "profileId": "plastic.matte", "crop": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\00-outer-shell-right-flank.png", "bbox": {"x": 124, "y": 44, "width": 50, "height": 188}, "sourceWidth": 200, "sourceHeight": 278, "loaderWarnings": [], "coverage": 0.1691}}]};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "ellipsoid", "offset": [0, 0, 0], "scale": [2.05, 3.4, 1.3], "isTrigger": false, "notes": "Closed ellipsoid proxy; the visible cutaway is shallow relief and does not open the rear collider."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const endpoint_matrix_volume_1 = makeAttachmentEndpoint(null);
  const node_matrix_volume_1 = new THREE.Group();
  node_matrix_volume_1.name = "Inset matrix surface__pivot";
  node_matrix_volume_1.scale.set(1, 1, 1);
  if (endpoint_matrix_volume_1) {
    node_matrix_volume_1.position.copy(endpoint_matrix_volume_1.start);
    node_matrix_volume_1.rotation.set(0.0, 0.0, -0.035);
  } else {
    node_matrix_volume_1.position.set(-0.23, 0.08, 0.68);
    node_matrix_volume_1.rotation.set(0.0, 0.0, -0.035);
  }
  node_matrix_volume_1.userData.sculptComponent = {"id": "matrix-volume", "name": "Inset matrix surface", "level": "macro", "role": "interior-layer", "importance": 0.9, "confidence": 0.82, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "The exposed matrix is one softly rounded recessed field bounded by the cutaway rim.", "geometryDescriptor": {"topologyIntent": "shallow organic volume", "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.28, "height": 2.5, "depth": 0.18, "units": "world", "confidence": 0.76}, "transform": {"position": [-0.23, 0.08, 0.68], "rotation": [0, 0, -0.035], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-layer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "collider": {"type": "ellipsoid", "offset": [0, 0, 0], "scale": [1.28, 2.5, 0.18], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "matrix-layer", "seamRefs": ["cutaway-seam"], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "matrix-material"}}, "material": "matrix-material", "materialLayers": ["matrix-material"], "deformations": [], "joints": [], "seams": ["cutaway-seam"], "localFeatures": [{"id": "granule-field", "type": "instanced-cluster", "minimumCount": 24}, {"id": "matrix-speckle-field", "type": "material-locality", "frequency": 48}], "surfaceDetail": {"macroRoughness": 0.03, "microRoughness": 0.1, "bumpAmplitude": 0.012, "normalPattern": "fine irregular speckles", "displacementPattern": "none", "occlusionPattern": "darkened fold contacts", "edgeWearPattern": "none", "notes": "Keep matrix quieter than the shell and membrane."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(218, 190, 132, 1)", "secondaryAlbedo": "rgba(177, 144, 92, 1)", "materialClass": "skin", "materialClassConfidence": 0.62}, "evidenceRefs": ["full-object"], "fidelityTier": "hero", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "matrix-material"}, "materialRegions": [{"regionId": "pale-matrix", "materialId": "matrix-material", "profileId": "plastic.matte", "crop": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\02-pale-matrix.png", "bbox": {"x": 50, "y": 55, "width": 48, "height": 120}, "sourceWidth": 200, "sourceHeight": 278, "loaderWarnings": [], "coverage": 0.1036}}]};
  node_matrix_volume_1.userData.actionProfile = {"animationRole": "detachable-layer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "collider": {"type": "ellipsoid", "offset": [0, 0, 0], "scale": [1.28, 2.5, 0.18], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "matrix-layer", "seamRefs": ["cutaway-seam"], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "matrix-material"}};
  (nodes["root"] ?? root).add(node_matrix_volume_1);
  nodes["matrix-volume"] = node_matrix_volume_1;
  const mesh_matrix_volume_1Geometry = endpoint_matrix_volume_1
    ? new THREE.CylinderGeometry(endpoint_matrix_volume_1.endRadius, endpoint_matrix_volume_1.baseRadius, endpoint_matrix_volume_1.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_matrix_volume_1) {
    mesh_matrix_volume_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_matrix_volume_1 = new THREE.Mesh(
    mesh_matrix_volume_1Geometry,
    materialMap["matrix-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_matrix_volume_1.name = "Inset matrix surface";
  if (endpoint_matrix_volume_1) {
    mesh_matrix_volume_1.position.copy(endpoint_matrix_volume_1.midpoint);
    mesh_matrix_volume_1.quaternion.copy(endpoint_matrix_volume_1.quaternion);
  }
  mesh_matrix_volume_1.castShadow = options.castShadow ?? true;
  mesh_matrix_volume_1.receiveShadow = options.receiveShadow ?? true;
  mesh_matrix_volume_1.userData.sculptComponent = {"id": "matrix-volume", "name": "Inset matrix surface", "level": "macro", "role": "interior-layer", "importance": 0.9, "confidence": 0.82, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "The exposed matrix is one softly rounded recessed field bounded by the cutaway rim.", "geometryDescriptor": {"topologyIntent": "shallow organic volume", "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.28, "height": 2.5, "depth": 0.18, "units": "world", "confidence": 0.76}, "transform": {"position": [-0.23, 0.08, 0.68], "rotation": [0, 0, -0.035], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-layer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "collider": {"type": "ellipsoid", "offset": [0, 0, 0], "scale": [1.28, 2.5, 0.18], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "matrix-layer", "seamRefs": ["cutaway-seam"], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "matrix-material"}}, "material": "matrix-material", "materialLayers": ["matrix-material"], "deformations": [], "joints": [], "seams": ["cutaway-seam"], "localFeatures": [{"id": "granule-field", "type": "instanced-cluster", "minimumCount": 24}, {"id": "matrix-speckle-field", "type": "material-locality", "frequency": 48}], "surfaceDetail": {"macroRoughness": 0.03, "microRoughness": 0.1, "bumpAmplitude": 0.012, "normalPattern": "fine irregular speckles", "displacementPattern": "none", "occlusionPattern": "darkened fold contacts", "edgeWearPattern": "none", "notes": "Keep matrix quieter than the shell and membrane."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(218, 190, 132, 1)", "secondaryAlbedo": "rgba(177, 144, 92, 1)", "materialClass": "skin", "materialClassConfidence": 0.62}, "evidenceRefs": ["full-object"], "fidelityTier": "hero", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "matrix-material"}, "materialRegions": [{"regionId": "pale-matrix", "materialId": "matrix-material", "profileId": "plastic.matte", "crop": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\02-pale-matrix.png", "bbox": {"x": 50, "y": 55, "width": 48, "height": 120}, "sourceWidth": 200, "sourceHeight": 278, "loaderWarnings": [], "coverage": 0.1036}}]};
  node_matrix_volume_1.add(mesh_matrix_volume_1);
  meshes["matrix-volume"] = mesh_matrix_volume_1;
  colliders["matrix-volume"] = {"type": "ellipsoid", "offset": [0, 0, 0], "scale": [1.28, 2.5, 0.18], "isTrigger": true};
  destructionGroups["matrix-layer"] ??= [];
  destructionGroups["matrix-layer"].push(node_matrix_volume_1);

  const attachment_inner_boundary_2 = {"parentId": "root", "parentSocket": "front-cutaway", "localStart": [-0.56, 1.24, 0], "localEnd": [-0.22, 1.42, 0], "contactType": "embed", "embedDepth": 0.045, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]};
  const endpoint_inner_boundary_2 = makeAttachmentEndpoint(attachment_inner_boundary_2);
  const node_inner_boundary_2 = new THREE.Group();
  node_inner_boundary_2.name = "Continuous inner membrane boundary__pivot";
  node_inner_boundary_2.scale.set(1, 1, 1);
  if (endpoint_inner_boundary_2) {
    node_inner_boundary_2.position.copy(endpoint_inner_boundary_2.start);
    node_inner_boundary_2.rotation.set(0.0, 0.0, -0.035);
  } else {
    node_inner_boundary_2.position.set(-0.2, 0.06, 0.82);
    node_inner_boundary_2.rotation.set(0.0, 0.0, -0.035);
  }
  node_inner_boundary_2.userData.sculptComponent = {"id": "inner-boundary", "name": "Continuous inner membrane boundary", "level": "macro", "role": "membrane", "importance": 1.0, "confidence": 0.94, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "The visible membrane is a thin continuous rounded band following a closed organic path around the matrix.", "geometryDescriptor": {"topologyIntent": "closed organic tube loop", "uvStrategy": "generated along curve", "normalStrategy": "smooth Frenet-frame normals", "tubePath": {"points": [[-0.56, 1.24, 0], [-0.22, 1.42, 0], [0.36, 1.28, 0], [0.55, 0.75, 0], [0.52, 0.05, 0], [0.46, -0.72, 0], [0.16, -1.2, 0], [-0.36, -1.12, 0], [-0.62, -0.76, 0], [-0.62, 0.05, 0], [-0.56, 1.24, 0]], "radius": 0.065, "closed": true}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "front-cutaway", "localStart": [-0.56, 1.24, 0], "localEnd": [-0.22, 1.42, 0], "contactType": "embed", "embedDepth": 0.045, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.86}, "transform": {"position": [-0.2, 0.06, 0.82], "rotation": [0, 0, -0.035], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-membrane", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "membrane-contact", "localPosition": [0, 0, 0], "localRotation": [0, 0, 0]}], "collider": {"type": "tube-loop", "offset": [0, 0, 0], "scale": [1.25, 2.65, 0.12], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "inner-membrane", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}}, "material": "membrane-material", "materialLayers": ["membrane-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "boundary-ridge", "type": "raised-ridge", "width": 0.13}, {"id": "inner-dark-outline", "type": "material-locality", "offset": -0.018}], "surfaceDetail": {"macroRoughness": 0.02, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "subtle membrane grain", "displacementPattern": "none", "occlusionPattern": "ochre contact line", "edgeWearPattern": "none", "notes": "Smooth satin membrane remains brighter than the matrix."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(229, 171, 57, 1)", "secondaryAlbedo": "rgba(150, 92, 23, 1)", "materialClass": "skin", "materialClassConfidence": 0.7}, "evidenceRefs": ["full-object"], "fidelityTier": "hero", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "membrane-material"}, "materialRegions": [{"regionId": "gold-inner-membrane", "materialId": "membrane-material", "profileId": "plastic.glossy", "crop": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\01-gold-inner-membrane.png", "bbox": {"x": 35, "y": 39, "width": 82, "height": 184}, "sourceWidth": 200, "sourceHeight": 278, "loaderWarnings": [], "coverage": 0.2714}}]};
  node_inner_boundary_2.userData.actionProfile = {"animationRole": "detachable-membrane", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "membrane-contact", "localPosition": [0, 0, 0], "localRotation": [0, 0, 0]}], "collider": {"type": "tube-loop", "offset": [0, 0, 0], "scale": [1.25, 2.65, 0.12], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "inner-membrane", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}};
  (nodes["root"] ?? root).add(node_inner_boundary_2);
  nodes["inner-boundary"] = node_inner_boundary_2;
  const mesh_inner_boundary_2Geometry = endpoint_inner_boundary_2
    ? new THREE.CylinderGeometry(endpoint_inner_boundary_2.endRadius, endpoint_inner_boundary_2.baseRadius, endpoint_inner_boundary_2.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.56, 1.24, 0], [-0.22, 1.42, 0], [0.36, 1.28, 0], [0.55, 0.75, 0], [0.52, 0.05, 0], [0.46, -0.72, 0], [0.16, -1.2, 0], [-0.36, -1.12, 0], [-0.62, -0.76, 0], [-0.62, 0.05, 0], [-0.56, 1.24, 0]], "radius": 0.065, "closed": true});
  if (!endpoint_inner_boundary_2) {
    mesh_inner_boundary_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_inner_boundary_2 = new THREE.Mesh(
    mesh_inner_boundary_2Geometry,
    materialMap["membrane-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_inner_boundary_2.name = "Continuous inner membrane boundary";
  if (endpoint_inner_boundary_2) {
    mesh_inner_boundary_2.position.copy(endpoint_inner_boundary_2.midpoint);
    mesh_inner_boundary_2.quaternion.copy(endpoint_inner_boundary_2.quaternion);
  }
  mesh_inner_boundary_2.castShadow = options.castShadow ?? true;
  mesh_inner_boundary_2.receiveShadow = options.receiveShadow ?? true;
  mesh_inner_boundary_2.userData.sculptComponent = {"id": "inner-boundary", "name": "Continuous inner membrane boundary", "level": "macro", "role": "membrane", "importance": 1.0, "confidence": 0.94, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "The visible membrane is a thin continuous rounded band following a closed organic path around the matrix.", "geometryDescriptor": {"topologyIntent": "closed organic tube loop", "uvStrategy": "generated along curve", "normalStrategy": "smooth Frenet-frame normals", "tubePath": {"points": [[-0.56, 1.24, 0], [-0.22, 1.42, 0], [0.36, 1.28, 0], [0.55, 0.75, 0], [0.52, 0.05, 0], [0.46, -0.72, 0], [0.16, -1.2, 0], [-0.36, -1.12, 0], [-0.62, -0.76, 0], [-0.62, 0.05, 0], [-0.56, 1.24, 0]], "radius": 0.065, "closed": true}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "front-cutaway", "localStart": [-0.56, 1.24, 0], "localEnd": [-0.22, 1.42, 0], "contactType": "embed", "embedDepth": 0.045, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.86}, "transform": {"position": [-0.2, 0.06, 0.82], "rotation": [0, 0, -0.035], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-membrane", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "membrane-contact", "localPosition": [0, 0, 0], "localRotation": [0, 0, 0]}], "collider": {"type": "tube-loop", "offset": [0, 0, 0], "scale": [1.25, 2.65, 0.12], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "inner-membrane", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}}, "material": "membrane-material", "materialLayers": ["membrane-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "boundary-ridge", "type": "raised-ridge", "width": 0.13}, {"id": "inner-dark-outline", "type": "material-locality", "offset": -0.018}], "surfaceDetail": {"macroRoughness": 0.02, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "subtle membrane grain", "displacementPattern": "none", "occlusionPattern": "ochre contact line", "edgeWearPattern": "none", "notes": "Smooth satin membrane remains brighter than the matrix."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(229, 171, 57, 1)", "secondaryAlbedo": "rgba(150, 92, 23, 1)", "materialClass": "skin", "materialClassConfidence": 0.7}, "evidenceRefs": ["full-object"], "fidelityTier": "hero", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "membrane-material"}, "materialRegions": [{"regionId": "gold-inner-membrane", "materialId": "membrane-material", "profileId": "plastic.glossy", "crop": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\my-object\\material-evidence\\01-gold-inner-membrane.png", "bbox": {"x": 35, "y": 39, "width": 82, "height": 184}, "sourceWidth": 200, "sourceHeight": 278, "loaderWarnings": [], "coverage": 0.2714}}]};
  node_inner_boundary_2.add(mesh_inner_boundary_2);
  meshes["inner-boundary"] = mesh_inner_boundary_2;
  colliders["inner-boundary"] = {"type": "tube-loop", "offset": [0, 0, 0], "scale": [1.25, 2.65, 0.12], "isTrigger": true};
  destructionGroups["inner-membrane"] ??= [];
  destructionGroups["inner-membrane"].push(node_inner_boundary_2);
  const socket_inner_boundary_membrane_contact_0 = new THREE.Object3D();
  socket_inner_boundary_membrane_contact_0.name = "membrane-contact";
  socket_inner_boundary_membrane_contact_0.position.set(0.0, 0.0, 0.0);
  socket_inner_boundary_membrane_contact_0.rotation.set(0.0, 0.0, 0.0);
  socket_inner_boundary_membrane_contact_0.userData.socket = {"id": "membrane-contact", "localPosition": [0, 0, 0], "localRotation": [0, 0, 0]};
  node_inner_boundary_2.add(socket_inner_boundary_membrane_contact_0);
  sockets["inner-boundary:membrane-contact"] = socket_inner_boundary_membrane_contact_0;

  const attachment_cutaway_rim_3 = {"parentId": "root", "parentSocket": "front-cutaway", "localStart": [-0.66, 1.34, 0], "localEnd": [-0.24, 1.56, 0], "contactType": "overlap", "overlap": 0.055, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_cutaway_rim_3 = makeAttachmentEndpoint(attachment_cutaway_rim_3);
  const node_cutaway_rim_3 = new THREE.Group();
  node_cutaway_rim_3.name = "Thick cutaway rim__pivot";
  node_cutaway_rim_3.scale.set(1, 1, 1);
  if (endpoint_cutaway_rim_3) {
    node_cutaway_rim_3.position.copy(endpoint_cutaway_rim_3.start);
    node_cutaway_rim_3.rotation.set(0.0, 0.0, -0.035);
  } else {
    node_cutaway_rim_3.position.set(-0.2, 0.06, 0.77);
    node_cutaway_rim_3.rotation.set(0.0, 0.0, -0.035);
  }
  node_cutaway_rim_3.userData.sculptComponent = {"id": "cutaway-rim", "name": "Thick cutaway rim", "level": "meso", "role": "seam", "importance": 0.95, "confidence": 0.92, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "A real rounded raised edge defines the cut plane and changes the aperture silhouette under grazing light.", "geometryDescriptor": {"topologyIntent": "closed rounded relief loop", "uvStrategy": "generated along curve", "normalStrategy": "smooth Frenet-frame normals", "tubePath": {"points": [[-0.66, 1.34, 0], [-0.24, 1.56, 0], [0.46, 1.38, 0], [0.67, 0.78, 0], [0.64, 0.0, 0], [0.57, -0.84, 0], [0.2, -1.34, 0], [-0.47, -1.26, 0], [-0.76, -0.82, 0], [-0.75, 0.12, 0], [-0.66, 1.34, 0]], "radius": 0.085, "closed": true}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "front-cutaway", "localStart": [-0.66, 1.34, 0], "localEnd": [-0.24, 1.56, 0], "contactType": "overlap", "overlap": 0.055, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.2, 0.06, 0.77], "rotation": [0, 0, -0.035], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-rim", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "collider": {"type": "tube-loop", "offset": [0, 0, 0], "scale": [1.5, 2.9, 0.18], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cutaway-rim", "seamRefs": ["cutaway-seam"], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "shell-material"}}, "material": "shell-material", "materialLayers": ["shell-material", "membrane-material"], "deformations": [], "joints": [], "seams": ["cutaway-seam"], "localFeatures": [{"id": "rim-bevel", "type": "rounded-bevel", "bevelRadius": 0.085, "segments": 8}, {"id": "rim-shadow-seam", "type": "ao-seam", "width": 0.025}], "surfaceDetail": {"macroRoughness": 0.05, "microRoughness": 0.1, "bumpAmplitude": 0.02, "normalPattern": "shell grain", "displacementPattern": "none", "occlusionPattern": "dark inner seam", "edgeWearPattern": "none", "notes": "Rim carries both brown shell and a thin gold inner lip."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(174, 91, 56, 1)", "secondaryAlbedo": "rgba(111, 55, 37, 1)", "materialClass": "skin", "materialClassConfidence": 0.7}, "evidenceRefs": ["full-object"], "fidelityTier": "hero"};
  node_cutaway_rim_3.userData.actionProfile = {"animationRole": "detachable-rim", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "collider": {"type": "tube-loop", "offset": [0, 0, 0], "scale": [1.5, 2.9, 0.18], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cutaway-rim", "seamRefs": ["cutaway-seam"], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "shell-material"}};
  (nodes["root"] ?? root).add(node_cutaway_rim_3);
  nodes["cutaway-rim"] = node_cutaway_rim_3;
  const mesh_cutaway_rim_3Geometry = endpoint_cutaway_rim_3
    ? new THREE.CylinderGeometry(endpoint_cutaway_rim_3.endRadius, endpoint_cutaway_rim_3.baseRadius, endpoint_cutaway_rim_3.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.66, 1.34, 0], [-0.24, 1.56, 0], [0.46, 1.38, 0], [0.67, 0.78, 0], [0.64, 0.0, 0], [0.57, -0.84, 0], [0.2, -1.34, 0], [-0.47, -1.26, 0], [-0.76, -0.82, 0], [-0.75, 0.12, 0], [-0.66, 1.34, 0]], "radius": 0.085, "closed": true});
  if (!endpoint_cutaway_rim_3) {
    mesh_cutaway_rim_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cutaway_rim_3 = new THREE.Mesh(
    mesh_cutaway_rim_3Geometry,
    materialMap["shell-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cutaway_rim_3.name = "Thick cutaway rim";
  if (endpoint_cutaway_rim_3) {
    mesh_cutaway_rim_3.position.copy(endpoint_cutaway_rim_3.midpoint);
    mesh_cutaway_rim_3.quaternion.copy(endpoint_cutaway_rim_3.quaternion);
  }
  mesh_cutaway_rim_3.castShadow = options.castShadow ?? true;
  mesh_cutaway_rim_3.receiveShadow = options.receiveShadow ?? true;
  mesh_cutaway_rim_3.userData.sculptComponent = {"id": "cutaway-rim", "name": "Thick cutaway rim", "level": "meso", "role": "seam", "importance": 0.95, "confidence": 0.92, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "A real rounded raised edge defines the cut plane and changes the aperture silhouette under grazing light.", "geometryDescriptor": {"topologyIntent": "closed rounded relief loop", "uvStrategy": "generated along curve", "normalStrategy": "smooth Frenet-frame normals", "tubePath": {"points": [[-0.66, 1.34, 0], [-0.24, 1.56, 0], [0.46, 1.38, 0], [0.67, 0.78, 0], [0.64, 0.0, 0], [0.57, -0.84, 0], [0.2, -1.34, 0], [-0.47, -1.26, 0], [-0.76, -0.82, 0], [-0.75, 0.12, 0], [-0.66, 1.34, 0]], "radius": 0.085, "closed": true}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "front-cutaway", "localStart": [-0.66, 1.34, 0], "localEnd": [-0.24, 1.56, 0], "contactType": "overlap", "overlap": 0.055, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.2, 0.06, 0.77], "rotation": [0, 0, -0.035], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "detachable-rim", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.86}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "collider": {"type": "tube-loop", "offset": [0, 0, 0], "scale": [1.5, 2.9, 0.18], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cutaway-rim", "seamRefs": ["cutaway-seam"], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "shell-material"}}, "material": "shell-material", "materialLayers": ["shell-material", "membrane-material"], "deformations": [], "joints": [], "seams": ["cutaway-seam"], "localFeatures": [{"id": "rim-bevel", "type": "rounded-bevel", "bevelRadius": 0.085, "segments": 8}, {"id": "rim-shadow-seam", "type": "ao-seam", "width": 0.025}], "surfaceDetail": {"macroRoughness": 0.05, "microRoughness": 0.1, "bumpAmplitude": 0.02, "normalPattern": "shell grain", "displacementPattern": "none", "occlusionPattern": "dark inner seam", "edgeWearPattern": "none", "notes": "Rim carries both brown shell and a thin gold inner lip."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(174, 91, 56, 1)", "secondaryAlbedo": "rgba(111, 55, 37, 1)", "materialClass": "skin", "materialClassConfidence": 0.7}, "evidenceRefs": ["full-object"], "fidelityTier": "hero"};
  node_cutaway_rim_3.add(mesh_cutaway_rim_3);
  meshes["cutaway-rim"] = mesh_cutaway_rim_3;
  colliders["cutaway-rim"] = {"type": "tube-loop", "offset": [0, 0, 0], "scale": [1.5, 2.9, 0.18], "isTrigger": true};
  destructionGroups["cutaway-rim"] ??= [];
  destructionGroups["cutaway-rim"].push(node_cutaway_rim_3);

  const attachment_crista_01_4 = {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [-0.5, 1.02, 0], "localEnd": [0.12, 0.78, 0], "contactType": "overlap", "overlap": 0.045, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_crista_01_4 = makeAttachmentEndpoint(attachment_crista_01_4);
  const node_crista_01_4 = new THREE.Group();
  node_crista_01_4.name = "Upper left-to-right crista fold__pivot";
  node_crista_01_4.scale.set(1, 1, 1);
  if (endpoint_crista_01_4) {
    node_crista_01_4.position.copy(endpoint_crista_01_4.start);
    node_crista_01_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_crista_01_4.position.set(0.0, 0.0, 0.04);
    node_crista_01_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_crista_01_4.userData.sculptComponent = {"id": "crista-01", "name": "Upper left-to-right crista fold", "level": "meso", "role": "membrane-fold", "importance": 0.9, "confidence": 0.91, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "A continuous rounded fold follows an S-shaped path across the matrix.", "geometryDescriptor": {"topologyIntent": "rounded serpentine tube", "uvStrategy": "generated along curve", "normalStrategy": "smooth Frenet-frame normals", "tubePath": {"points": [[-0.5, 1.02, 0], [-0.22, 1.14, 0], [0.26, 1.08, 0], [0.39, 0.88, 0], [0.12, 0.78, 0]], "radius": 0.072, "closed": false}}, "parent": "inner-boundary", "attachment": {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [-0.5, 1.02, 0], "localEnd": [0.12, 0.78, 0], "contactType": "overlap", "overlap": 0.045, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.86}, "transform": {"position": [0, 0, 0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [-0.5, 1.02, 0], "axis": [0, 0, 1], "confidence": 0.86}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.9, 0.42, 0.14], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}}, "material": "membrane-material", "materialLayers": ["membrane-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serpentine-fold", "type": "curve-sweep"}, {"id": "rounded-termini", "type": "hemispherical-cap"}, {"id": "fold-width-variation", "type": "radius-variation", "amount": 0.15}], "surfaceDetail": {"macroRoughness": 0.01, "microRoughness": 0.03, "bumpAmplitude": 0.004, "normalPattern": "subtle membrane grain", "notes": "Rounded cap and broad turn remain legible."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 180, 68, 1)", "secondaryAlbedo": "rgba(156, 98, 24, 1)", "materialClass": "skin", "materialClassConfidence": 0.7}, "evidenceRefs": ["full-object"], "fidelityTier": "hero"};
  node_crista_01_4.userData.actionProfile = {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [-0.5, 1.02, 0], "axis": [0, 0, 1], "confidence": 0.86}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.9, 0.42, 0.14], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}};
  (nodes["inner-boundary"] ?? root).add(node_crista_01_4);
  nodes["crista-01"] = node_crista_01_4;
  const mesh_crista_01_4Geometry = endpoint_crista_01_4
    ? new THREE.CylinderGeometry(endpoint_crista_01_4.endRadius, endpoint_crista_01_4.baseRadius, endpoint_crista_01_4.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.5, 1.02, 0], [-0.22, 1.14, 0], [0.26, 1.08, 0], [0.39, 0.88, 0], [0.12, 0.78, 0]], "radius": 0.072, "closed": false});
  if (!endpoint_crista_01_4) {
    mesh_crista_01_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_crista_01_4 = new THREE.Mesh(
    mesh_crista_01_4Geometry,
    materialMap["membrane-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_crista_01_4.name = "Upper left-to-right crista fold";
  if (endpoint_crista_01_4) {
    mesh_crista_01_4.position.copy(endpoint_crista_01_4.midpoint);
    mesh_crista_01_4.quaternion.copy(endpoint_crista_01_4.quaternion);
  }
  mesh_crista_01_4.castShadow = options.castShadow ?? true;
  mesh_crista_01_4.receiveShadow = options.receiveShadow ?? true;
  mesh_crista_01_4.userData.sculptComponent = {"id": "crista-01", "name": "Upper left-to-right crista fold", "level": "meso", "role": "membrane-fold", "importance": 0.9, "confidence": 0.91, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "A continuous rounded fold follows an S-shaped path across the matrix.", "geometryDescriptor": {"topologyIntent": "rounded serpentine tube", "uvStrategy": "generated along curve", "normalStrategy": "smooth Frenet-frame normals", "tubePath": {"points": [[-0.5, 1.02, 0], [-0.22, 1.14, 0], [0.26, 1.08, 0], [0.39, 0.88, 0], [0.12, 0.78, 0]], "radius": 0.072, "closed": false}}, "parent": "inner-boundary", "attachment": {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [-0.5, 1.02, 0], "localEnd": [0.12, 0.78, 0], "contactType": "overlap", "overlap": 0.045, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.86}, "transform": {"position": [0, 0, 0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [-0.5, 1.02, 0], "axis": [0, 0, 1], "confidence": 0.86}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.9, 0.42, 0.14], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}}, "material": "membrane-material", "materialLayers": ["membrane-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serpentine-fold", "type": "curve-sweep"}, {"id": "rounded-termini", "type": "hemispherical-cap"}, {"id": "fold-width-variation", "type": "radius-variation", "amount": 0.15}], "surfaceDetail": {"macroRoughness": 0.01, "microRoughness": 0.03, "bumpAmplitude": 0.004, "normalPattern": "subtle membrane grain", "notes": "Rounded cap and broad turn remain legible."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 180, 68, 1)", "secondaryAlbedo": "rgba(156, 98, 24, 1)", "materialClass": "skin", "materialClassConfidence": 0.7}, "evidenceRefs": ["full-object"], "fidelityTier": "hero"};
  node_crista_01_4.add(mesh_crista_01_4);
  meshes["crista-01"] = mesh_crista_01_4;
  colliders["crista-01"] = {"type": "tube", "offset": [0, 0, 0], "scale": [0.9, 0.42, 0.14], "isTrigger": true};
  destructionGroups["cristae"] ??= [];
  destructionGroups["cristae"].push(node_crista_01_4);

  const attachment_crista_02_5 = {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [0.45, 0.62, 0], "localEnd": [-0.12, 0.31, 0], "contactType": "overlap", "overlap": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_crista_02_5 = makeAttachmentEndpoint(attachment_crista_02_5);
  const node_crista_02_5 = new THREE.Group();
  node_crista_02_5.name = "Upper right-to-left crista fold__pivot";
  node_crista_02_5.scale.set(1, 1, 1);
  if (endpoint_crista_02_5) {
    node_crista_02_5.position.copy(endpoint_crista_02_5.start);
    node_crista_02_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_crista_02_5.position.set(0.0, 0.0, 0.04);
    node_crista_02_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_crista_02_5.userData.sculptComponent = {"id": "crista-02", "name": "Upper right-to-left crista fold", "level": "meso", "role": "membrane-fold", "importance": 0.88, "confidence": 0.9, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "A rounded membrane fold reverses the preceding crista direction and creates the alternating pattern.", "geometryDescriptor": {"topologyIntent": "rounded serpentine tube", "uvStrategy": "generated along curve", "normalStrategy": "smooth Frenet-frame normals", "tubePath": {"points": [[0.45, 0.62, 0], [0.18, 0.72, 0], [-0.34, 0.62, 0], [-0.44, 0.4, 0], [-0.12, 0.31, 0]], "radius": 0.068, "closed": false}}, "parent": "inner-boundary", "attachment": {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [0.45, 0.62, 0], "localEnd": [-0.12, 0.31, 0], "contactType": "overlap", "overlap": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [0.45, 0.62, 0], "axis": [0, 0, 1], "confidence": 0.84}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.9, 0.42, 0.14], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}}, "material": "membrane-material", "materialLayers": ["membrane-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "alternating-direction-02", "type": "curve-sweep"}], "surfaceDetail": {"macroRoughness": 0.01, "microRoughness": 0.03, "bumpAmplitude": 0.004, "normalPattern": "subtle membrane grain"}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 180, 68, 1)", "secondaryAlbedo": "rgba(156, 98, 24, 1)", "materialClass": "skin", "materialClassConfidence": 0.7}, "evidenceRefs": ["full-object"], "fidelityTier": "hero"};
  node_crista_02_5.userData.actionProfile = {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [0.45, 0.62, 0], "axis": [0, 0, 1], "confidence": 0.84}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.9, 0.42, 0.14], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}};
  (nodes["inner-boundary"] ?? root).add(node_crista_02_5);
  nodes["crista-02"] = node_crista_02_5;
  const mesh_crista_02_5Geometry = endpoint_crista_02_5
    ? new THREE.CylinderGeometry(endpoint_crista_02_5.endRadius, endpoint_crista_02_5.baseRadius, endpoint_crista_02_5.length, 32, 12)
    : buildTubeGeometry({"points": [[0.45, 0.62, 0], [0.18, 0.72, 0], [-0.34, 0.62, 0], [-0.44, 0.4, 0], [-0.12, 0.31, 0]], "radius": 0.068, "closed": false});
  if (!endpoint_crista_02_5) {
    mesh_crista_02_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_crista_02_5 = new THREE.Mesh(
    mesh_crista_02_5Geometry,
    materialMap["membrane-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_crista_02_5.name = "Upper right-to-left crista fold";
  if (endpoint_crista_02_5) {
    mesh_crista_02_5.position.copy(endpoint_crista_02_5.midpoint);
    mesh_crista_02_5.quaternion.copy(endpoint_crista_02_5.quaternion);
  }
  mesh_crista_02_5.castShadow = options.castShadow ?? true;
  mesh_crista_02_5.receiveShadow = options.receiveShadow ?? true;
  mesh_crista_02_5.userData.sculptComponent = {"id": "crista-02", "name": "Upper right-to-left crista fold", "level": "meso", "role": "membrane-fold", "importance": 0.88, "confidence": 0.9, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "A rounded membrane fold reverses the preceding crista direction and creates the alternating pattern.", "geometryDescriptor": {"topologyIntent": "rounded serpentine tube", "uvStrategy": "generated along curve", "normalStrategy": "smooth Frenet-frame normals", "tubePath": {"points": [[0.45, 0.62, 0], [0.18, 0.72, 0], [-0.34, 0.62, 0], [-0.44, 0.4, 0], [-0.12, 0.31, 0]], "radius": 0.068, "closed": false}}, "parent": "inner-boundary", "attachment": {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [0.45, 0.62, 0], "localEnd": [-0.12, 0.31, 0], "contactType": "overlap", "overlap": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [0.45, 0.62, 0], "axis": [0, 0, 1], "confidence": 0.84}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.9, 0.42, 0.14], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}}, "material": "membrane-material", "materialLayers": ["membrane-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "alternating-direction-02", "type": "curve-sweep"}], "surfaceDetail": {"macroRoughness": 0.01, "microRoughness": 0.03, "bumpAmplitude": 0.004, "normalPattern": "subtle membrane grain"}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 180, 68, 1)", "secondaryAlbedo": "rgba(156, 98, 24, 1)", "materialClass": "skin", "materialClassConfidence": 0.7}, "evidenceRefs": ["full-object"], "fidelityTier": "hero"};
  node_crista_02_5.add(mesh_crista_02_5);
  meshes["crista-02"] = mesh_crista_02_5;
  colliders["crista-02"] = {"type": "tube", "offset": [0, 0, 0], "scale": [0.9, 0.42, 0.14], "isTrigger": true};
  destructionGroups["cristae"] ??= [];
  destructionGroups["cristae"].push(node_crista_02_5);

  const attachment_crista_03_6 = {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [-0.5, 0.14, 0], "localEnd": [0.08, -0.14, 0], "contactType": "overlap", "overlap": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_crista_03_6 = makeAttachmentEndpoint(attachment_crista_03_6);
  const node_crista_03_6 = new THREE.Group();
  node_crista_03_6.name = "Middle left-to-right crista fold__pivot";
  node_crista_03_6.scale.set(1, 1, 1);
  if (endpoint_crista_03_6) {
    node_crista_03_6.position.copy(endpoint_crista_03_6.start);
    node_crista_03_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_crista_03_6.position.set(0.0, 0.0, 0.04);
    node_crista_03_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_crista_03_6.userData.sculptComponent = {"id": "crista-03", "name": "Middle left-to-right crista fold", "level": "meso", "role": "membrane-fold", "importance": 0.9, "confidence": 0.92, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "A central rounded fold crosses the widest visible matrix gap and anchors the characteristic alternating rhythm.", "geometryDescriptor": {"topologyIntent": "rounded serpentine tube", "uvStrategy": "generated along curve", "normalStrategy": "smooth Frenet-frame normals", "tubePath": {"points": [[-0.5, 0.14, 0], [-0.2, 0.23, 0], [0.3, 0.16, 0], [0.4, -0.06, 0], [0.08, -0.14, 0]], "radius": 0.073, "closed": false}}, "parent": "inner-boundary", "attachment": {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [-0.5, 0.14, 0], "localEnd": [0.08, -0.14, 0], "contactType": "overlap", "overlap": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.86}, "transform": {"position": [0, 0, 0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [-0.5, 0.14, 0], "axis": [0, 0, 1], "confidence": 0.85}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.95, 0.42, 0.14], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}}, "material": "membrane-material", "materialLayers": ["membrane-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "alternating-direction-03", "type": "curve-sweep"}], "surfaceDetail": {"macroRoughness": 0.01, "microRoughness": 0.03, "bumpAmplitude": 0.004, "normalPattern": "subtle membrane grain"}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 180, 68, 1)", "secondaryAlbedo": "rgba(156, 98, 24, 1)", "materialClass": "skin", "materialClassConfidence": 0.7}, "evidenceRefs": ["full-object"], "fidelityTier": "hero"};
  node_crista_03_6.userData.actionProfile = {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [-0.5, 0.14, 0], "axis": [0, 0, 1], "confidence": 0.85}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.95, 0.42, 0.14], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}};
  (nodes["inner-boundary"] ?? root).add(node_crista_03_6);
  nodes["crista-03"] = node_crista_03_6;
  const mesh_crista_03_6Geometry = endpoint_crista_03_6
    ? new THREE.CylinderGeometry(endpoint_crista_03_6.endRadius, endpoint_crista_03_6.baseRadius, endpoint_crista_03_6.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.5, 0.14, 0], [-0.2, 0.23, 0], [0.3, 0.16, 0], [0.4, -0.06, 0], [0.08, -0.14, 0]], "radius": 0.073, "closed": false});
  if (!endpoint_crista_03_6) {
    mesh_crista_03_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_crista_03_6 = new THREE.Mesh(
    mesh_crista_03_6Geometry,
    materialMap["membrane-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_crista_03_6.name = "Middle left-to-right crista fold";
  if (endpoint_crista_03_6) {
    mesh_crista_03_6.position.copy(endpoint_crista_03_6.midpoint);
    mesh_crista_03_6.quaternion.copy(endpoint_crista_03_6.quaternion);
  }
  mesh_crista_03_6.castShadow = options.castShadow ?? true;
  mesh_crista_03_6.receiveShadow = options.receiveShadow ?? true;
  mesh_crista_03_6.userData.sculptComponent = {"id": "crista-03", "name": "Middle left-to-right crista fold", "level": "meso", "role": "membrane-fold", "importance": 0.9, "confidence": 0.92, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "A central rounded fold crosses the widest visible matrix gap and anchors the characteristic alternating rhythm.", "geometryDescriptor": {"topologyIntent": "rounded serpentine tube", "uvStrategy": "generated along curve", "normalStrategy": "smooth Frenet-frame normals", "tubePath": {"points": [[-0.5, 0.14, 0], [-0.2, 0.23, 0], [0.3, 0.16, 0], [0.4, -0.06, 0], [0.08, -0.14, 0]], "radius": 0.073, "closed": false}}, "parent": "inner-boundary", "attachment": {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [-0.5, 0.14, 0], "localEnd": [0.08, -0.14, 0], "contactType": "overlap", "overlap": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.86}, "transform": {"position": [0, 0, 0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [-0.5, 0.14, 0], "axis": [0, 0, 1], "confidence": 0.85}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.95, 0.42, 0.14], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}}, "material": "membrane-material", "materialLayers": ["membrane-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "alternating-direction-03", "type": "curve-sweep"}], "surfaceDetail": {"macroRoughness": 0.01, "microRoughness": 0.03, "bumpAmplitude": 0.004, "normalPattern": "subtle membrane grain"}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 180, 68, 1)", "secondaryAlbedo": "rgba(156, 98, 24, 1)", "materialClass": "skin", "materialClassConfidence": 0.7}, "evidenceRefs": ["full-object"], "fidelityTier": "hero"};
  node_crista_03_6.add(mesh_crista_03_6);
  meshes["crista-03"] = mesh_crista_03_6;
  colliders["crista-03"] = {"type": "tube", "offset": [0, 0, 0], "scale": [0.95, 0.42, 0.14], "isTrigger": true};
  destructionGroups["cristae"] ??= [];
  destructionGroups["cristae"].push(node_crista_03_6);

  const attachment_crista_04_7 = {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [0.43, -0.34, 0], "localEnd": [-0.08, -0.62, 0], "contactType": "overlap", "overlap": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_crista_04_7 = makeAttachmentEndpoint(attachment_crista_04_7);
  const node_crista_04_7 = new THREE.Group();
  node_crista_04_7.name = "Lower right-to-left crista fold__pivot";
  node_crista_04_7.scale.set(1, 1, 1);
  if (endpoint_crista_04_7) {
    node_crista_04_7.position.copy(endpoint_crista_04_7.start);
    node_crista_04_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_crista_04_7.position.set(0.0, 0.0, 0.04);
    node_crista_04_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_crista_04_7.userData.sculptComponent = {"id": "crista-04", "name": "Lower right-to-left crista fold", "level": "meso", "role": "membrane-fold", "importance": 0.86, "confidence": 0.89, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "A lower fold reverses direction and maintains the alternating connected membrane motif.", "geometryDescriptor": {"topologyIntent": "rounded serpentine tube", "uvStrategy": "generated along curve", "normalStrategy": "smooth Frenet-frame normals", "tubePath": {"points": [[0.43, -0.34, 0], [0.16, -0.24, 0], [-0.34, -0.33, 0], [-0.42, -0.55, 0], [-0.08, -0.62, 0]], "radius": 0.068, "closed": false}}, "parent": "inner-boundary", "attachment": {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [0.43, -0.34, 0], "localEnd": [-0.08, -0.62, 0], "contactType": "overlap", "overlap": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.84}, "transform": {"position": [0, 0, 0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [0.43, -0.34, 0], "axis": [0, 0, 1], "confidence": 0.84}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.9, 0.4, 0.14], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}}, "material": "membrane-material", "materialLayers": ["membrane-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "alternating-direction-04", "type": "curve-sweep"}], "surfaceDetail": {"macroRoughness": 0.01, "microRoughness": 0.03, "bumpAmplitude": 0.004, "normalPattern": "subtle membrane grain"}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 180, 68, 1)", "secondaryAlbedo": "rgba(156, 98, 24, 1)", "materialClass": "skin", "materialClassConfidence": 0.7}, "evidenceRefs": ["full-object"], "fidelityTier": "hero"};
  node_crista_04_7.userData.actionProfile = {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [0.43, -0.34, 0], "axis": [0, 0, 1], "confidence": 0.84}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.9, 0.4, 0.14], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}};
  (nodes["inner-boundary"] ?? root).add(node_crista_04_7);
  nodes["crista-04"] = node_crista_04_7;
  const mesh_crista_04_7Geometry = endpoint_crista_04_7
    ? new THREE.CylinderGeometry(endpoint_crista_04_7.endRadius, endpoint_crista_04_7.baseRadius, endpoint_crista_04_7.length, 32, 12)
    : buildTubeGeometry({"points": [[0.43, -0.34, 0], [0.16, -0.24, 0], [-0.34, -0.33, 0], [-0.42, -0.55, 0], [-0.08, -0.62, 0]], "radius": 0.068, "closed": false});
  if (!endpoint_crista_04_7) {
    mesh_crista_04_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_crista_04_7 = new THREE.Mesh(
    mesh_crista_04_7Geometry,
    materialMap["membrane-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_crista_04_7.name = "Lower right-to-left crista fold";
  if (endpoint_crista_04_7) {
    mesh_crista_04_7.position.copy(endpoint_crista_04_7.midpoint);
    mesh_crista_04_7.quaternion.copy(endpoint_crista_04_7.quaternion);
  }
  mesh_crista_04_7.castShadow = options.castShadow ?? true;
  mesh_crista_04_7.receiveShadow = options.receiveShadow ?? true;
  mesh_crista_04_7.userData.sculptComponent = {"id": "crista-04", "name": "Lower right-to-left crista fold", "level": "meso", "role": "membrane-fold", "importance": 0.86, "confidence": 0.89, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "A lower fold reverses direction and maintains the alternating connected membrane motif.", "geometryDescriptor": {"topologyIntent": "rounded serpentine tube", "uvStrategy": "generated along curve", "normalStrategy": "smooth Frenet-frame normals", "tubePath": {"points": [[0.43, -0.34, 0], [0.16, -0.24, 0], [-0.34, -0.33, 0], [-0.42, -0.55, 0], [-0.08, -0.62, 0]], "radius": 0.068, "closed": false}}, "parent": "inner-boundary", "attachment": {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [0.43, -0.34, 0], "localEnd": [-0.08, -0.62, 0], "contactType": "overlap", "overlap": 0.04, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.84}, "transform": {"position": [0, 0, 0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [0.43, -0.34, 0], "axis": [0, 0, 1], "confidence": 0.84}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.9, 0.4, 0.14], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}}, "material": "membrane-material", "materialLayers": ["membrane-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "alternating-direction-04", "type": "curve-sweep"}], "surfaceDetail": {"macroRoughness": 0.01, "microRoughness": 0.03, "bumpAmplitude": 0.004, "normalPattern": "subtle membrane grain"}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 180, 68, 1)", "secondaryAlbedo": "rgba(156, 98, 24, 1)", "materialClass": "skin", "materialClassConfidence": 0.7}, "evidenceRefs": ["full-object"], "fidelityTier": "hero"};
  node_crista_04_7.add(mesh_crista_04_7);
  meshes["crista-04"] = mesh_crista_04_7;
  colliders["crista-04"] = {"type": "tube", "offset": [0, 0, 0], "scale": [0.9, 0.4, 0.14], "isTrigger": true};
  destructionGroups["cristae"] ??= [];
  destructionGroups["cristae"].push(node_crista_04_7);

  const attachment_crista_05_8 = {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [-0.48, -0.76, 0], "localEnd": [0.02, -0.96, 0], "contactType": "overlap", "overlap": 0.038, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_crista_05_8 = makeAttachmentEndpoint(attachment_crista_05_8);
  const node_crista_05_8 = new THREE.Group();
  node_crista_05_8.name = "Lowest left-to-right crista fold__pivot";
  node_crista_05_8.scale.set(1, 1, 1);
  if (endpoint_crista_05_8) {
    node_crista_05_8.position.copy(endpoint_crista_05_8.start);
    node_crista_05_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_crista_05_8.position.set(0.0, 0.0, 0.04);
    node_crista_05_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_crista_05_8.userData.sculptComponent = {"id": "crista-05", "name": "Lowest left-to-right crista fold", "level": "meso", "role": "membrane-fold", "importance": 0.84, "confidence": 0.86, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "The lowest transverse fold completes the alternating sequence before the distinct lower spiral.", "geometryDescriptor": {"topologyIntent": "rounded serpentine tube", "uvStrategy": "generated along curve", "normalStrategy": "smooth Frenet-frame normals", "tubePath": {"points": [[-0.48, -0.76, 0], [-0.22, -0.66, 0], [0.26, -0.74, 0], [0.34, -0.9, 0], [0.02, -0.96, 0]], "radius": 0.064, "closed": false}}, "parent": "inner-boundary", "attachment": {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [-0.48, -0.76, 0], "localEnd": [0.02, -0.96, 0], "contactType": "overlap", "overlap": 0.038, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0, 0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [-0.48, -0.76, 0], "axis": [0, 0, 1], "confidence": 0.82}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.82, 0.34, 0.13], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}}, "material": "membrane-material", "materialLayers": ["membrane-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "alternating-direction-05", "type": "curve-sweep"}], "surfaceDetail": {"macroRoughness": 0.01, "microRoughness": 0.03, "bumpAmplitude": 0.004, "normalPattern": "subtle membrane grain"}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 180, 68, 1)", "secondaryAlbedo": "rgba(156, 98, 24, 1)", "materialClass": "skin", "materialClassConfidence": 0.7}, "evidenceRefs": ["full-object"], "fidelityTier": "hero"};
  node_crista_05_8.userData.actionProfile = {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [-0.48, -0.76, 0], "axis": [0, 0, 1], "confidence": 0.82}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.82, 0.34, 0.13], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}};
  (nodes["inner-boundary"] ?? root).add(node_crista_05_8);
  nodes["crista-05"] = node_crista_05_8;
  const mesh_crista_05_8Geometry = endpoint_crista_05_8
    ? new THREE.CylinderGeometry(endpoint_crista_05_8.endRadius, endpoint_crista_05_8.baseRadius, endpoint_crista_05_8.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.48, -0.76, 0], [-0.22, -0.66, 0], [0.26, -0.74, 0], [0.34, -0.9, 0], [0.02, -0.96, 0]], "radius": 0.064, "closed": false});
  if (!endpoint_crista_05_8) {
    mesh_crista_05_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_crista_05_8 = new THREE.Mesh(
    mesh_crista_05_8Geometry,
    materialMap["membrane-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_crista_05_8.name = "Lowest left-to-right crista fold";
  if (endpoint_crista_05_8) {
    mesh_crista_05_8.position.copy(endpoint_crista_05_8.midpoint);
    mesh_crista_05_8.quaternion.copy(endpoint_crista_05_8.quaternion);
  }
  mesh_crista_05_8.castShadow = options.castShadow ?? true;
  mesh_crista_05_8.receiveShadow = options.receiveShadow ?? true;
  mesh_crista_05_8.userData.sculptComponent = {"id": "crista-05", "name": "Lowest left-to-right crista fold", "level": "meso", "role": "membrane-fold", "importance": 0.84, "confidence": 0.86, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "The lowest transverse fold completes the alternating sequence before the distinct lower spiral.", "geometryDescriptor": {"topologyIntent": "rounded serpentine tube", "uvStrategy": "generated along curve", "normalStrategy": "smooth Frenet-frame normals", "tubePath": {"points": [[-0.48, -0.76, 0], [-0.22, -0.66, 0], [0.26, -0.74, 0], [0.34, -0.9, 0], [0.02, -0.96, 0]], "radius": 0.064, "closed": false}}, "parent": "inner-boundary", "attachment": {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [-0.48, -0.76, 0], "localEnd": [0.02, -0.96, 0], "contactType": "overlap", "overlap": 0.038, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0, 0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [-0.48, -0.76, 0], "axis": [0, 0, 1], "confidence": 0.82}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.82, 0.34, 0.13], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}}, "material": "membrane-material", "materialLayers": ["membrane-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "alternating-direction-05", "type": "curve-sweep"}], "surfaceDetail": {"macroRoughness": 0.01, "microRoughness": 0.03, "bumpAmplitude": 0.004, "normalPattern": "subtle membrane grain"}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 180, 68, 1)", "secondaryAlbedo": "rgba(156, 98, 24, 1)", "materialClass": "skin", "materialClassConfidence": 0.7}, "evidenceRefs": ["full-object"], "fidelityTier": "hero"};
  node_crista_05_8.add(mesh_crista_05_8);
  meshes["crista-05"] = mesh_crista_05_8;
  colliders["crista-05"] = {"type": "tube", "offset": [0, 0, 0], "scale": [0.82, 0.34, 0.13], "isTrigger": true};
  destructionGroups["cristae"] ??= [];
  destructionGroups["cristae"].push(node_crista_05_8);

  const attachment_lower_spiral_9 = {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [-0.5, -1.03, 0], "localEnd": [-0.06, -1.09, 0], "contactType": "overlap", "overlap": 0.035, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_lower_spiral_9 = makeAttachmentEndpoint(attachment_lower_spiral_9);
  const node_lower_spiral_9 = new THREE.Group();
  node_lower_spiral_9.name = "Lower looped crista fold__pivot";
  node_lower_spiral_9.scale.set(1, 1, 1);
  if (endpoint_lower_spiral_9) {
    node_lower_spiral_9.position.copy(endpoint_lower_spiral_9.start);
    node_lower_spiral_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_lower_spiral_9.position.set(0.0, 0.0, 0.045);
    node_lower_spiral_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_lower_spiral_9.userData.sculptComponent = {"id": "lower-spiral", "name": "Lower looped crista fold", "level": "meso", "role": "membrane-fold", "importance": 0.88, "confidence": 0.91, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "The lower identity feature is a compact rounded looped path distinct from the transverse folds.", "geometryDescriptor": {"topologyIntent": "open spiral tube", "uvStrategy": "generated along curve", "normalStrategy": "smooth Frenet-frame normals", "tubePath": {"points": [[-0.5, -1.03, 0], [-0.32, -1.16, 0], [0.14, -1.17, 0], [0.34, -1.04, 0], [0.16, -0.94, 0], [-0.18, -0.98, 0], [-0.26, -1.06, 0], [-0.06, -1.09, 0]], "radius": 0.058, "closed": false}}, "parent": "inner-boundary", "attachment": {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [-0.5, -1.03, 0], "localEnd": [-0.06, -1.09, 0], "contactType": "overlap", "overlap": 0.035, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.84}, "transform": {"position": [0, 0, 0.045], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [-0.5, -1.03, 0], "axis": [0, 0, 1], "confidence": 0.84}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.85, 0.25, 0.12], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}}, "material": "membrane-material", "materialLayers": ["membrane-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "lower-spiral-curve", "type": "curve-sweep"}], "surfaceDetail": {"macroRoughness": 0.01, "microRoughness": 0.03, "bumpAmplitude": 0.004, "normalPattern": "subtle membrane grain"}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 180, 68, 1)", "secondaryAlbedo": "rgba(156, 98, 24, 1)", "materialClass": "skin", "materialClassConfidence": 0.7}, "evidenceRefs": ["full-object"], "fidelityTier": "hero"};
  node_lower_spiral_9.userData.actionProfile = {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [-0.5, -1.03, 0], "axis": [0, 0, 1], "confidence": 0.84}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.85, 0.25, 0.12], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}};
  (nodes["inner-boundary"] ?? root).add(node_lower_spiral_9);
  nodes["lower-spiral"] = node_lower_spiral_9;
  const mesh_lower_spiral_9Geometry = endpoint_lower_spiral_9
    ? new THREE.CylinderGeometry(endpoint_lower_spiral_9.endRadius, endpoint_lower_spiral_9.baseRadius, endpoint_lower_spiral_9.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.5, -1.03, 0], [-0.32, -1.16, 0], [0.14, -1.17, 0], [0.34, -1.04, 0], [0.16, -0.94, 0], [-0.18, -0.98, 0], [-0.26, -1.06, 0], [-0.06, -1.09, 0]], "radius": 0.058, "closed": false});
  if (!endpoint_lower_spiral_9) {
    mesh_lower_spiral_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lower_spiral_9 = new THREE.Mesh(
    mesh_lower_spiral_9Geometry,
    materialMap["membrane-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lower_spiral_9.name = "Lower looped crista fold";
  if (endpoint_lower_spiral_9) {
    mesh_lower_spiral_9.position.copy(endpoint_lower_spiral_9.midpoint);
    mesh_lower_spiral_9.quaternion.copy(endpoint_lower_spiral_9.quaternion);
  }
  mesh_lower_spiral_9.castShadow = options.castShadow ?? true;
  mesh_lower_spiral_9.receiveShadow = options.receiveShadow ?? true;
  mesh_lower_spiral_9.userData.sculptComponent = {"id": "lower-spiral", "name": "Lower looped crista fold", "level": "meso", "role": "membrane-fold", "importance": 0.88, "confidence": 0.91, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "The lower identity feature is a compact rounded looped path distinct from the transverse folds.", "geometryDescriptor": {"topologyIntent": "open spiral tube", "uvStrategy": "generated along curve", "normalStrategy": "smooth Frenet-frame normals", "tubePath": {"points": [[-0.5, -1.03, 0], [-0.32, -1.16, 0], [0.14, -1.17, 0], [0.34, -1.04, 0], [0.16, -0.94, 0], [-0.18, -0.98, 0], [-0.26, -1.06, 0], [-0.06, -1.09, 0]], "radius": 0.058, "closed": false}}, "parent": "inner-boundary", "attachment": {"parentId": "inner-boundary", "parentSocket": "membrane-contact", "localStart": [-0.5, -1.03, 0], "localEnd": [-0.06, -1.09, 0], "contactType": "overlap", "overlap": 0.035, "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.84}, "transform": {"position": [0, 0, 0.045], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "membrane-fold", "pivot": {"mode": "root", "localPosition": [-0.5, -1.03, 0], "axis": [0, 0, 1], "confidence": 0.84}, "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [0.85, 0.25, 0.12], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "cristae", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "membrane-material"}}, "material": "membrane-material", "materialLayers": ["membrane-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "lower-spiral-curve", "type": "curve-sweep"}], "surfaceDetail": {"macroRoughness": 0.01, "microRoughness": 0.03, "bumpAmplitude": 0.004, "normalPattern": "subtle membrane grain"}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 180, 68, 1)", "secondaryAlbedo": "rgba(156, 98, 24, 1)", "materialClass": "skin", "materialClassConfidence": 0.7}, "evidenceRefs": ["full-object"], "fidelityTier": "hero"};
  node_lower_spiral_9.add(mesh_lower_spiral_9);
  meshes["lower-spiral"] = mesh_lower_spiral_9;
  colliders["lower-spiral"] = {"type": "tube", "offset": [0, 0, 0], "scale": [0.85, 0.25, 0.12], "isTrigger": true};
  destructionGroups["cristae"] ??= [];
  destructionGroups["cristae"].push(node_lower_spiral_9);

  const endpoint_granule_anchor_10 = makeAttachmentEndpoint(null);
  const node_granule_anchor_10 = new THREE.Group();
  node_granule_anchor_10.name = "Matrix granule prototype__pivot";
  node_granule_anchor_10.scale.set(1, 1, 1);
  if (endpoint_granule_anchor_10) {
    node_granule_anchor_10.position.copy(endpoint_granule_anchor_10.start);
    node_granule_anchor_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_granule_anchor_10.position.set(0.22, 0.96, 0.14);
    node_granule_anchor_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_granule_anchor_10.userData.sculptComponent = {"id": "granule-anchor", "name": "Matrix granule prototype", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.9, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Each visible granule is a discrete tiny rounded body embedded in the matrix.", "geometryDescriptor": {"topologyIntent": "instanced ellipsoidal granule", "uvStrategy": "generated", "normalStrategy": "smooth vertex normals"}, "parent": "matrix-volume", "attachment": null, "dimensions": {"width": 0.045, "height": 0.04, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0.22, 0.96, 0.14], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-detail", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.045, 0.04, 0.03], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "matrix-granules", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "granule-material"}}, "material": "granule-material", "materialLayers": ["granule-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "granule-scale-variation", "type": "instance-variation"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0.05, "bumpAmplitude": 0.002, "normalPattern": "smooth"}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(137, 94, 52, 1)", "secondaryAlbedo": "rgba(89, 64, 43, 1)", "materialClass": "skin", "materialClassConfidence": 0.55}, "evidenceRefs": ["full-object"], "fidelityTier": "near"};
  node_granule_anchor_10.userData.actionProfile = {"animationRole": "static-detail", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.045, 0.04, 0.03], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "matrix-granules", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "granule-material"}};
  (nodes["matrix-volume"] ?? root).add(node_granule_anchor_10);
  nodes["granule-anchor"] = node_granule_anchor_10;
  const mesh_granule_anchor_10Geometry = endpoint_granule_anchor_10
    ? new THREE.CylinderGeometry(endpoint_granule_anchor_10.endRadius, endpoint_granule_anchor_10.baseRadius, endpoint_granule_anchor_10.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_granule_anchor_10) {
    mesh_granule_anchor_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_granule_anchor_10 = new THREE.Mesh(
    mesh_granule_anchor_10Geometry,
    materialMap["granule-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_granule_anchor_10.name = "Matrix granule prototype";
  if (endpoint_granule_anchor_10) {
    mesh_granule_anchor_10.position.copy(endpoint_granule_anchor_10.midpoint);
    mesh_granule_anchor_10.quaternion.copy(endpoint_granule_anchor_10.quaternion);
  }
  mesh_granule_anchor_10.castShadow = options.castShadow ?? true;
  mesh_granule_anchor_10.receiveShadow = options.receiveShadow ?? true;
  mesh_granule_anchor_10.userData.sculptComponent = {"id": "granule-anchor", "name": "Matrix granule prototype", "level": "micro", "role": "detail", "importance": 0.55, "confidence": 0.9, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Each visible granule is a discrete tiny rounded body embedded in the matrix.", "geometryDescriptor": {"topologyIntent": "instanced ellipsoidal granule", "uvStrategy": "generated", "normalStrategy": "smooth vertex normals"}, "parent": "matrix-volume", "attachment": null, "dimensions": {"width": 0.045, "height": 0.04, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0.22, 0.96, 0.14], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-detail", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [0.045, 0.04, 0.03], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "matrix-granules", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "granule-material"}}, "material": "granule-material", "materialLayers": ["granule-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "granule-scale-variation", "type": "instance-variation"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0.05, "bumpAmplitude": 0.002, "normalPattern": "smooth"}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(137, 94, 52, 1)", "secondaryAlbedo": "rgba(89, 64, 43, 1)", "materialClass": "skin", "materialClassConfidence": 0.55}, "evidenceRefs": ["full-object"], "fidelityTier": "near"};
  node_granule_anchor_10.add(mesh_granule_anchor_10);
  meshes["granule-anchor"] = mesh_granule_anchor_10;
  colliders["granule-anchor"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [0.045, 0.04, 0.03], "isTrigger": true};
  destructionGroups["matrix-granules"] ??= [];
  destructionGroups["matrix-granules"].push(node_granule_anchor_10);

  const endpoint_shell_pore_anchor_11 = makeAttachmentEndpoint(null);
  const node_shell_pore_anchor_11 = new THREE.Group();
  node_shell_pore_anchor_11.name = "Shell relief prototype__pivot";
  node_shell_pore_anchor_11.scale.set(1, 1, 1);
  if (endpoint_shell_pore_anchor_11) {
    node_shell_pore_anchor_11.position.copy(endpoint_shell_pore_anchor_11.start);
    node_shell_pore_anchor_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shell_pore_anchor_11.position.set(0.55, 0.4, 0.63);
    node_shell_pore_anchor_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_shell_pore_anchor_11.userData.sculptComponent = {"id": "shell-pore-anchor", "name": "Shell relief prototype", "level": "micro", "role": "detail", "importance": 0.35, "confidence": 0.78, "primitive": "sphere", "topologyClass": "surface-relief", "topologyRationale": "Meso shell dimples are shallow relief marks, not independent large volumes.", "geometryDescriptor": {"topologyIntent": "shallow relief prototype", "uvStrategy": "generated", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.018, "depth": 0.008, "units": "world", "confidence": 0.65}, "transform": {"position": [0.55, 0.4, 0.63], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-detail", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "collider": {"type": "none", "offset": [0, 0, 0], "scale": [0, 0, 0], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "shell-surface", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "shell-material"}}, "material": "shell-material", "materialLayers": ["shell-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "meso-pit-prototype", "type": "normal-relief"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0.12, "bumpAmplitude": 0.008, "normalPattern": "cellular pit"}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(117, 64, 43, 1)", "secondaryAlbedo": "rgba(85, 47, 35, 1)", "materialClass": "skin", "materialClassConfidence": 0.68}, "evidenceRefs": ["full-object"], "fidelityTier": "near"};
  node_shell_pore_anchor_11.userData.actionProfile = {"animationRole": "static-detail", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "collider": {"type": "none", "offset": [0, 0, 0], "scale": [0, 0, 0], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "shell-surface", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "shell-material"}};
  (nodes["root"] ?? root).add(node_shell_pore_anchor_11);
  nodes["shell-pore-anchor"] = node_shell_pore_anchor_11;
  const mesh_shell_pore_anchor_11Geometry = endpoint_shell_pore_anchor_11
    ? new THREE.CylinderGeometry(endpoint_shell_pore_anchor_11.endRadius, endpoint_shell_pore_anchor_11.baseRadius, endpoint_shell_pore_anchor_11.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_shell_pore_anchor_11) {
    mesh_shell_pore_anchor_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_shell_pore_anchor_11 = new THREE.Mesh(
    mesh_shell_pore_anchor_11Geometry,
    materialMap["shell-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shell_pore_anchor_11.name = "Shell relief prototype";
  if (endpoint_shell_pore_anchor_11) {
    mesh_shell_pore_anchor_11.position.copy(endpoint_shell_pore_anchor_11.midpoint);
    mesh_shell_pore_anchor_11.quaternion.copy(endpoint_shell_pore_anchor_11.quaternion);
  }
  mesh_shell_pore_anchor_11.castShadow = options.castShadow ?? true;
  mesh_shell_pore_anchor_11.receiveShadow = options.receiveShadow ?? true;
  mesh_shell_pore_anchor_11.userData.sculptComponent = {"id": "shell-pore-anchor", "name": "Shell relief prototype", "level": "micro", "role": "detail", "importance": 0.35, "confidence": 0.78, "primitive": "sphere", "topologyClass": "surface-relief", "topologyRationale": "Meso shell dimples are shallow relief marks, not independent large volumes.", "geometryDescriptor": {"topologyIntent": "shallow relief prototype", "uvStrategy": "generated", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.018, "depth": 0.008, "units": "world", "confidence": 0.65}, "transform": {"position": [0.55, 0.4, 0.63], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-detail", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "collider": {"type": "none", "offset": [0, 0, 0], "scale": [0, 0, 0], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "shell-surface", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "shell-material"}}, "material": "shell-material", "materialLayers": ["shell-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "meso-pit-prototype", "type": "normal-relief"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0.12, "bumpAmplitude": 0.008, "normalPattern": "cellular pit"}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(117, 64, 43, 1)", "secondaryAlbedo": "rgba(85, 47, 35, 1)", "materialClass": "skin", "materialClassConfidence": 0.68}, "evidenceRefs": ["full-object"], "fidelityTier": "near"};
  node_shell_pore_anchor_11.add(mesh_shell_pore_anchor_11);
  meshes["shell-pore-anchor"] = mesh_shell_pore_anchor_11;
  colliders["shell-pore-anchor"] = {"type": "none", "offset": [0, 0, 0], "scale": [0, 0, 0], "isTrigger": true};
  destructionGroups["shell-surface"] ??= [];
  destructionGroups["shell-surface"].push(node_shell_pore_anchor_11);

  const endpoint_matrix_speck_anchor_12 = makeAttachmentEndpoint(null);
  const node_matrix_speck_anchor_12 = new THREE.Group();
  node_matrix_speck_anchor_12.name = "Matrix speck prototype__pivot";
  node_matrix_speck_anchor_12.scale.set(1, 1, 1);
  if (endpoint_matrix_speck_anchor_12) {
    node_matrix_speck_anchor_12.position.copy(endpoint_matrix_speck_anchor_12.start);
    node_matrix_speck_anchor_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_matrix_speck_anchor_12.position.set(-0.18, 0.73, 0.13);
    node_matrix_speck_anchor_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_matrix_speck_anchor_12.userData.sculptComponent = {"id": "matrix-speck-anchor", "name": "Matrix speck prototype", "level": "micro", "role": "detail", "importance": 0.3, "confidence": 0.83, "primitive": "sphere", "topologyClass": "surface-relief", "topologyRationale": "Fine matrix speckles produce small visible relief/highlight changes without altering the macro silhouette.", "geometryDescriptor": {"topologyIntent": "fine speck prototype", "uvStrategy": "generated", "normalStrategy": "smooth vertex normals"}, "parent": "matrix-volume", "attachment": null, "dimensions": {"width": 0.012, "height": 0.012, "depth": 0.006, "units": "world", "confidence": 0.7}, "transform": {"position": [-0.18, 0.73, 0.13], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-detail", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.72}, "collider": {"type": "none", "offset": [0, 0, 0], "scale": [0, 0, 0], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "matrix-speckles", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "matrix-material"}}, "material": "granule-material", "materialLayers": ["granule-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "speck-value-variation", "type": "instance-color"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine speck"}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(142, 105, 66, 1)", "secondaryAlbedo": "rgba(91, 75, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.55}, "evidenceRefs": ["full-object"], "fidelityTier": "near"};
  node_matrix_speck_anchor_12.userData.actionProfile = {"animationRole": "static-detail", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.72}, "collider": {"type": "none", "offset": [0, 0, 0], "scale": [0, 0, 0], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "matrix-speckles", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "matrix-material"}};
  (nodes["matrix-volume"] ?? root).add(node_matrix_speck_anchor_12);
  nodes["matrix-speck-anchor"] = node_matrix_speck_anchor_12;
  const mesh_matrix_speck_anchor_12Geometry = endpoint_matrix_speck_anchor_12
    ? new THREE.CylinderGeometry(endpoint_matrix_speck_anchor_12.endRadius, endpoint_matrix_speck_anchor_12.baseRadius, endpoint_matrix_speck_anchor_12.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_matrix_speck_anchor_12) {
    mesh_matrix_speck_anchor_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_matrix_speck_anchor_12 = new THREE.Mesh(
    mesh_matrix_speck_anchor_12Geometry,
    materialMap["granule-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_matrix_speck_anchor_12.name = "Matrix speck prototype";
  if (endpoint_matrix_speck_anchor_12) {
    mesh_matrix_speck_anchor_12.position.copy(endpoint_matrix_speck_anchor_12.midpoint);
    mesh_matrix_speck_anchor_12.quaternion.copy(endpoint_matrix_speck_anchor_12.quaternion);
  }
  mesh_matrix_speck_anchor_12.castShadow = options.castShadow ?? true;
  mesh_matrix_speck_anchor_12.receiveShadow = options.receiveShadow ?? true;
  mesh_matrix_speck_anchor_12.userData.sculptComponent = {"id": "matrix-speck-anchor", "name": "Matrix speck prototype", "level": "micro", "role": "detail", "importance": 0.3, "confidence": 0.83, "primitive": "sphere", "topologyClass": "surface-relief", "topologyRationale": "Fine matrix speckles produce small visible relief/highlight changes without altering the macro silhouette.", "geometryDescriptor": {"topologyIntent": "fine speck prototype", "uvStrategy": "generated", "normalStrategy": "smooth vertex normals"}, "parent": "matrix-volume", "attachment": null, "dimensions": {"width": 0.012, "height": 0.012, "depth": 0.006, "units": "world", "confidence": 0.7}, "transform": {"position": [-0.18, 0.73, 0.13], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-detail", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.72}, "collider": {"type": "none", "offset": [0, 0, 0], "scale": [0, 0, 0], "isTrigger": true}, "destruction": {"breakable": false, "fractureGroup": "matrix-speckles", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "matrix-material"}}, "material": "granule-material", "materialLayers": ["granule-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "speck-value-variation", "type": "instance-color"}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine speck"}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(142, 105, 66, 1)", "secondaryAlbedo": "rgba(91, 75, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.55}, "evidenceRefs": ["full-object"], "fidelityTier": "near"};
  node_matrix_speck_anchor_12.add(mesh_matrix_speck_anchor_12);
  meshes["matrix-speck-anchor"] = mesh_matrix_speck_anchor_12;
  colliders["matrix-speck-anchor"] = {"type": "none", "offset": [0, 0, 0], "scale": [0, 0, 0], "isTrigger": true};
  destructionGroups["matrix-speckles"] ??= [];
  destructionGroups["matrix-speckles"].push(node_matrix_speck_anchor_12);
  // repetition system "cristae-fold-sequence" describes 5 parts that are already built individually; not instanced.

  // repetition system: matrix-granules (InstancedMesh, bounded-poisson, count=32, level=micro)
  {
    const parent = nodes["matrix-volume"] ?? root;
    const geo = new THREE.SphereGeometry(0.5, 64, 40);
    const mat = materialMap["granule-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.04, 0.035, 0.025];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.95;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 32);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 32; i++) {
      const ang = ((17.0) + (i * 360) / 32) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "matrix-granules";
    parent.add(cluster);
  }

  // repetition system: shell-micro-relief (InstancedMesh, surface-blue-noise, count=48, level=micro)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.SphereGeometry(0.5, 64, 40);
    const mat = materialMap["shell-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.015, 0.015, 0.006];
    const axis = new THREE.Vector3(0.0, 1.0, 0.0).normalize();
    const radius = 1.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 48);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 48; i++) {
      const ang = ((31.0) + (i * 360) / 48) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "shell-micro-relief";
    parent.add(cluster);
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createMitochondrionCutawayLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Mitochondrion Cutaway look-dev lights";
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
  lights.userData.lightingFromPhoto = [{"role": "key light", "type": "directional", "direction": [-0.55, 0.72, 0.42], "color": "#FFF0D6", "intensity": 2.4, "shadowSoftness": 0.65, "evidence": "upper-left crown highlight and lower-right value falloff"}, {"role": "fill light", "type": "hemisphere", "direction": [0.45, 0.25, 0.5], "color": "#D7E4FF", "intensity": 0.48, "evidence": "interior matrix remains readable inside the aperture"}, {"role": "rim light", "type": "directional", "direction": [0.7, 0.35, -0.55], "color": "#FFD8A8", "intensity": 0.75, "evidence": "thin warm edge along the right shell contour"}, {"role": "contact shadow and render transform", "exposure": 1.05, "toneMapping": "ACESFilmicToneMapping", "background": "#F4F1EC", "contactShadow": "soft oval receiver shadow below the lower lobe"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createMitochondrionCutawayEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameMitochondrionCutawayCamera(
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
export function createMitochondrionCutawayPresentationComposer(
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

export function configureMitochondrionCutawayRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createMitochondrionCutawayInspectControls(
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
