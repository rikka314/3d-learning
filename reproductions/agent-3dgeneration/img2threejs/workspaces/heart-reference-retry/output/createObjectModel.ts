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

type TaperedStation = { position: [number, number, number]; rx: number; rz: number; twist?: number };

// Frames come from PARALLEL TRANSPORT, not from a Frenet frame. A Frenet frame is defined by
// the curve's normal, which flips sign wherever the path has an inflection or straightens out,
// and every flip twists the surface 180 degrees within one segment. Carrying the previous frame
// forward and removing only its along-path component keeps the twist continuous. THREE's own
// extrudePath and TubeGeometry do not expose this, which is why this is hand-built.
function buildTaperedSweepGeometry(
  sweep: { stations: TaperedStation[]; radialSegments?: number; capEnds?: boolean },
): THREE.BufferGeometry {
  const stations = sweep.stations;
  if (stations.length < 2) throw new Error('tapered-sweep needs at least two stations');
  const radial = Math.max(3, sweep.radialSegments ?? 10);
  const centres = stations.map((s) => new THREE.Vector3(...s.position));

  const tangents = centres.map((_, i) => {
    const prev = centres[Math.max(0, i - 1)];
    const next = centres[Math.min(centres.length - 1, i + 1)];
    const t = next.clone().sub(prev);
    // Coincident neighbours would normalise to NaN and poison every downstream vertex.
    return t.lengthSq() < 1e-12 ? new THREE.Vector3(0, 1, 0) : t.normalize();
  });

  // Seed a reference axis that is not parallel to the first tangent, or the first cross
  // product is degenerate and the whole sweep collapses to a line.
  let ref = new THREE.Vector3(0, 0, 1);
  if (Math.abs(tangents[0].dot(ref)) > 0.9) ref = new THREE.Vector3(1, 0, 0);

  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  let carried = ref.clone().sub(tangents[0].clone().multiplyScalar(ref.dot(tangents[0]))).normalize();
  for (let i = 0; i < tangents.length; i += 1) {
    const t = tangents[i];
    // Project the carried frame back onto the plane perpendicular to this tangent.
    const n = carried.clone().sub(t.clone().multiplyScalar(carried.dot(t)));
    if (n.lengthSq() < 1e-12) {
      const fallback = Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      n.copy(fallback.sub(t.clone().multiplyScalar(fallback.dot(t))));
    }
    n.normalize();
    normals.push(n);
    binormals.push(new THREE.Vector3().crossVectors(t, n).normalize());
    carried = n;
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ringStart: number[] = [];
  const isPoint: boolean[] = [];

  for (let i = 0; i < stations.length; i += 1) {
    const st = stations[i];
    const v = i / (stations.length - 1);
    ringStart.push(positions.length / 3);
    // A station whose section has collapsed emits ONE vertex, not a ring of radius zero.
    // A degenerate ring still carries `radial` coincident vertices and `radial` zero-area
    // triangles, so the lock ends in a blunt cap the width of the floating-point noise
    // rather than at a point -- and a hair lock, a horn or a blade tip has to reach a point.
    if (st.rx <= 1e-6 && st.rz <= 1e-6) {
      isPoint.push(true);
      positions.push(centres[i].x, centres[i].y, centres[i].z);
      uvs.push(0.5, v);
      continue;
    }
    isPoint.push(false);
    const twist = ((st.twist ?? 0) * Math.PI) / 180;
    for (let j = 0; j <= radial; j += 1) {
      const theta = (j / radial) * Math.PI * 2 + twist;
      const offset = normals[i].clone().multiplyScalar(Math.cos(theta) * st.rx)
        .add(binormals[i].clone().multiplyScalar(Math.sin(theta) * st.rz));
      const p = centres[i].clone().add(offset);
      positions.push(p.x, p.y, p.z);
      uvs.push(j / radial, v);
    }
  }

  for (let i = 0; i < stations.length - 1; i += 1) {
    const a0 = ringStart[i];
    const b0 = ringStart[i + 1];
    if (isPoint[i] && isPoint[i + 1]) continue;   // two collapsed stations bound nothing
    for (let j = 0; j < radial; j += 1) {
      // Wound so the face normal points radially OUTWARD.
      //
      // Ring vertices advance from `normal` toward `binormal`, and binormal is
      // tangent x normal, so increasing theta runs counter-clockwise seen from the
      // far end of the segment. Taking the ring-to-ring edge first therefore puts
      // the cross product on the inside. Measured as signed volume on the built
      // mesh: every tapered-sweep came out negative -- a torso at -0.0674 and a
      // tail at -0.0044 against a positive ellipsoid head -- so every sweep this
      // generator has ever emitted rendered its back faces, with normals pointing
      // into the solid and every lighting judgement made on the wrong surface.
      if (isPoint[i]) indices.push(a0, b0 + j + 1, b0 + j);
      else if (isPoint[i + 1]) indices.push(a0 + j, a0 + j + 1, b0);
      else indices.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
    }
  }

  if (sweep.capEnds ?? true) {
    for (const end of [0, stations.length - 1]) {
      if (isPoint[end]) continue;   // a point end is already closed
      const centreIndex = positions.length / 3;
      positions.push(centres[end].x, centres[end].y, centres[end].z);
      uvs.push(0.5, end === 0 ? 0 : 1);
      const base = ringStart[end];
      for (let j = 0; j < radial; j += 1) {
        if (end === 0) indices.push(centreIndex, base + j + 1, base + j);
        else indices.push(centreIndex, base + j, base + j + 1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
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

// Generated from ObjectSculptSpec target: Heart Reference Retry
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createHeartReferenceRetryModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Heart Reference Retry";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 28.0, "aspect": 0.8002853067047075, "orientation": {"yaw": -0.08, "pitch": -0.02, "roll": 0.0}, "positionHint": [0.0, 0.05, 7.2], "note": "Approximate anterior three-quarter review camera; single source is uncalibrated."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["myocardium"] = createSculptMaterial(
    "myocardium",
    {"id": "myocardium", "name": "Salmon ventricular myocardium", "type": "physical", "qualityTier": "hero", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#D9665A", "color": "#D9665A", "albedo": {"dominant": "#D9665A", "secondary": ["#B84642", "#EE8A78"], "samplingNotes": "Sample only the named tissue footprint; exclude hotspot rings, background, pedestal and UI."}, "colorVariation": {"palette": ["#D9665A", "#B84642", "#EE8A78"], "pattern": "low-frequency tissue mottling", "amplitude": 0.08, "heightCorrelation": 0.15}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-like generated object coordinates", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Object-scale stable relief; no source-photo projection."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.4, "amplitude": 0.09, "role": "broad tissue value and volume variation"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.035, "role": "shallow lobes, creases and vessel-wall variation"}, {"id": "micro", "frequency": 38.0, "amplitude": 0.012, "role": "restrained highlight breakup"}], "roughness": {"base": 0.43, "variation": 0.07, "map": "independent-procedural-myocardium-roughness", "localResponse": "slightly lower on exposed crests and higher in grooves"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "independent-procedural-myocardium-height-normal", "strength": 0.18, "scale": 18.0, "space": "tangent"}, "bump": {"pattern": "bounded organic relief", "amplitude": 0.025, "scale": 12.0}, "displacement": {"pattern": "macro-only", "amplitude": 0.015, "scale": 2.0, "silhouetteAffects": false}, "ambientOcclusion": {"map": "independent-procedural-myocardium-ao", "cavityStrength": 0.22, "contactShadowBias": 0.35, "notes": "Only contact/groove cavities; do not paint global dark gradients."}, "clearcoat": 0.2, "clearcoatRoughness": 0.53, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2A0B16"}, "localOverrides": [{"id": "fiber-relief", "region": "ventricular body", "roughness": 0.49, "normalStrength": 0.18, "evidenceRefs": ["reference"]}], "shaderNotes": ["Use broad semi-gloss highlights; avoid a single global toy-plastic response.", "Keep albedo, roughness, normal/height and AO independent."], "notes": "Single-reference PBR estimate; not measured tissue data. Rear response is inferred.", "referencePbr": {"version": "1", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\reference.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "reference-pixel-extraction", "verdict": "pass", "usable": true, "confidence": 0.83, "estimatedFidelity": 0.83, "targetThreshold": 0.7, "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\myocardium\\myocardium_albedo.png", "url": "myocardium_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\myocardium\\myocardium_roughness.png", "url": "myocardium_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\myocardium\\myocardium_height.png", "url": "myocardium_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\myocardium\\myocardium_normal.png", "url": "myocardium_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\myocardium\\myocardium_ao.png", "url": "myocardium_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "hardLimit": "Single lit crop is an estimate, not physical inverse rendering."}},
    options
  );
  materialMap["atrial-tissue"] = createSculptMaterial(
    "atrial-tissue",
    {"id": "atrial-tissue", "name": "Deep salmon atrial tissue", "type": "physical", "qualityTier": "hero", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#C85B62", "color": "#C85B62", "albedo": {"dominant": "#C85B62", "secondary": ["#A84350", "#E38282"], "samplingNotes": "Sample only the named tissue footprint; exclude hotspot rings, background, pedestal and UI."}, "colorVariation": {"palette": ["#C85B62", "#A84350", "#E38282"], "pattern": "low-frequency tissue mottling", "amplitude": 0.08, "heightCorrelation": 0.15}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-like generated object coordinates", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Object-scale stable relief; no source-photo projection."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.4, "amplitude": 0.09, "role": "broad tissue value and volume variation"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.035, "role": "shallow lobes, creases and vessel-wall variation"}, {"id": "micro", "frequency": 38.0, "amplitude": 0.012, "role": "restrained highlight breakup"}], "roughness": {"base": 0.4, "variation": 0.07, "map": "independent-procedural-atrial-tissue-roughness", "localResponse": "slightly lower on exposed crests and higher in grooves"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "independent-procedural-atrial-tissue-height-normal", "strength": 0.18, "scale": 18.0, "space": "tangent"}, "bump": {"pattern": "bounded organic relief", "amplitude": 0.025, "scale": 12.0}, "displacement": {"pattern": "macro-only", "amplitude": 0.015, "scale": 2.0, "silhouetteAffects": false}, "ambientOcclusion": {"map": "independent-procedural-atrial-tissue-ao", "cavityStrength": 0.22, "contactShadowBias": 0.35, "notes": "Only contact/groove cavities; do not paint global dark gradients."}, "clearcoat": 0.22, "clearcoatRoughness": 0.5, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2A0B16"}, "localOverrides": [{"id": "auricle-fold-response", "region": "auricles", "roughness": 0.46, "normalStrength": 0.22, "evidenceRefs": ["reference"]}], "shaderNotes": ["Use broad semi-gloss highlights; avoid a single global toy-plastic response.", "Keep albedo, roughness, normal/height and AO independent."], "notes": "Single-reference PBR estimate; not measured tissue data. Rear response is inferred.", "referencePbr": {"version": "1", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\reference.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "reference-pixel-extraction", "verdict": "pass", "usable": true, "confidence": 0.83, "estimatedFidelity": 0.83, "targetThreshold": 0.7, "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\atrial-tissue\\atrial-tissue_albedo.png", "url": "atrial-tissue_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\atrial-tissue\\atrial-tissue_roughness.png", "url": "atrial-tissue_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\atrial-tissue\\atrial-tissue_height.png", "url": "atrial-tissue_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\atrial-tissue\\atrial-tissue_normal.png", "url": "atrial-tissue_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\atrial-tissue\\atrial-tissue_ao.png", "url": "atrial-tissue_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "hardLimit": "Single lit crop is an estimate, not physical inverse rendering."}},
    options
  );
  materialMap["arterial"] = createSculptMaterial(
    "arterial",
    {"id": "arterial", "name": "Warm red arterial tissue", "type": "physical", "qualityTier": "hero", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#D83A2E", "color": "#D83A2E", "albedo": {"dominant": "#D83A2E", "secondary": ["#A92525", "#F06A55"], "samplingNotes": "Sample only the named tissue footprint; exclude hotspot rings, background, pedestal and UI."}, "colorVariation": {"palette": ["#D83A2E", "#A92525", "#F06A55"], "pattern": "low-frequency tissue mottling", "amplitude": 0.08, "heightCorrelation": 0.15}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-like generated object coordinates", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Object-scale stable relief; no source-photo projection."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.4, "amplitude": 0.09, "role": "broad tissue value and volume variation"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.035, "role": "shallow lobes, creases and vessel-wall variation"}, {"id": "micro", "frequency": 38.0, "amplitude": 0.012, "role": "restrained highlight breakup"}], "roughness": {"base": 0.31, "variation": 0.07, "map": "independent-procedural-arterial-roughness", "localResponse": "slightly lower on exposed crests and higher in grooves"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "independent-procedural-arterial-height-normal", "strength": 0.18, "scale": 18.0, "space": "tangent"}, "bump": {"pattern": "bounded organic relief", "amplitude": 0.025, "scale": 12.0}, "displacement": {"pattern": "macro-only", "amplitude": 0.015, "scale": 2.0, "silhouetteAffects": false}, "ambientOcclusion": {"map": "independent-procedural-arterial-ao", "cavityStrength": 0.22, "contactShadowBias": 0.35, "notes": "Only contact/groove cavities; do not paint global dark gradients."}, "clearcoat": 0.25, "clearcoatRoughness": 0.41000000000000003, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2A0B16"}, "localOverrides": [{"id": "arterial-highlight", "region": "aortic crest and pulmonary-vein stubs", "roughness": 0.27, "evidenceRefs": ["reference"]}], "shaderNotes": ["Use broad semi-gloss highlights; avoid a single global toy-plastic response.", "Keep albedo, roughness, normal/height and AO independent."], "notes": "Single-reference PBR estimate; not measured tissue data. Rear response is inferred.", "referencePbr": {"version": "1", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\reference.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "reference-pixel-extraction", "verdict": "pass", "usable": true, "confidence": 0.83, "estimatedFidelity": 0.83, "targetThreshold": 0.7, "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\arterial\\arterial_albedo.png", "url": "arterial_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\arterial\\arterial_roughness.png", "url": "arterial_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\arterial\\arterial_height.png", "url": "arterial_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\arterial\\arterial_normal.png", "url": "arterial_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\arterial\\arterial_ao.png", "url": "arterial_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "hardLimit": "Single lit crop is an estimate, not physical inverse rendering."}},
    options
  );
  materialMap["venous"] = createSculptMaterial(
    "venous",
    {"id": "venous", "name": "Blue venous and pulmonary arterial tissue", "type": "physical", "qualityTier": "hero", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#477EC5", "color": "#477EC5", "albedo": {"dominant": "#477EC5", "secondary": ["#24599D", "#73A5E0"], "samplingNotes": "Sample only the named tissue footprint; exclude hotspot rings, background, pedestal and UI."}, "colorVariation": {"palette": ["#477EC5", "#24599D", "#73A5E0"], "pattern": "low-frequency tissue mottling", "amplitude": 0.08, "heightCorrelation": 0.15}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-like generated object coordinates", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Object-scale stable relief; no source-photo projection."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.4, "amplitude": 0.09, "role": "broad tissue value and volume variation"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.035, "role": "shallow lobes, creases and vessel-wall variation"}, {"id": "micro", "frequency": 38.0, "amplitude": 0.012, "role": "restrained highlight breakup"}], "roughness": {"base": 0.3, "variation": 0.07, "map": "independent-procedural-venous-roughness", "localResponse": "slightly lower on exposed crests and higher in grooves"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "independent-procedural-venous-height-normal", "strength": 0.18, "scale": 18.0, "space": "tangent"}, "bump": {"pattern": "bounded organic relief", "amplitude": 0.025, "scale": 12.0}, "displacement": {"pattern": "macro-only", "amplitude": 0.015, "scale": 2.0, "silhouetteAffects": false}, "ambientOcclusion": {"map": "independent-procedural-venous-ao", "cavityStrength": 0.22, "contactShadowBias": 0.35, "notes": "Only contact/groove cavities; do not paint global dark gradients."}, "clearcoat": 0.24, "clearcoatRoughness": 0.4, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2A0B16"}, "localOverrides": [{"id": "blue-vessel-highlight", "region": "SVC, IVC and pulmonary trunk", "roughness": 0.27, "evidenceRefs": ["reference"]}], "shaderNotes": ["Use broad semi-gloss highlights; avoid a single global toy-plastic response.", "Keep albedo, roughness, normal/height and AO independent."], "notes": "Single-reference PBR estimate; not measured tissue data. Rear response is inferred.", "referencePbr": {"version": "1", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\reference.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "reference-pixel-extraction", "verdict": "pass", "usable": true, "confidence": 0.83, "estimatedFidelity": 0.83, "targetThreshold": 0.7, "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\venous\\venous_albedo.png", "url": "venous_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\venous\\venous_roughness.png", "url": "venous_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\venous\\venous_height.png", "url": "venous_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\venous\\venous_normal.png", "url": "venous_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\venous\\venous_ao.png", "url": "venous_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "hardLimit": "Single lit crop is an estimate, not physical inverse rendering."}},
    options
  );
  materialMap["coronary-artery"] = createSculptMaterial(
    "coronary-artery",
    {"id": "coronary-artery", "name": "Red coronary arteries", "type": "physical", "qualityTier": "hero", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#D72826", "color": "#D72826", "albedo": {"dominant": "#D72826", "secondary": ["#A7131B", "#F05447"], "samplingNotes": "Sample only the named tissue footprint; exclude hotspot rings, background, pedestal and UI."}, "colorVariation": {"palette": ["#D72826", "#A7131B", "#F05447"], "pattern": "low-frequency tissue mottling", "amplitude": 0.08, "heightCorrelation": 0.15}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-like generated object coordinates", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Object-scale stable relief; no source-photo projection."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.4, "amplitude": 0.09, "role": "broad tissue value and volume variation"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.035, "role": "shallow lobes, creases and vessel-wall variation"}, {"id": "micro", "frequency": 38.0, "amplitude": 0.012, "role": "restrained highlight breakup"}], "roughness": {"base": 0.28, "variation": 0.07, "map": "independent-procedural-coronary-artery-roughness", "localResponse": "slightly lower on exposed crests and higher in grooves"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "independent-procedural-coronary-artery-height-normal", "strength": 0.18, "scale": 18.0, "space": "tangent"}, "bump": {"pattern": "bounded organic relief", "amplitude": 0.025, "scale": 12.0}, "displacement": {"pattern": "macro-only", "amplitude": 0.015, "scale": 2.0, "silhouetteAffects": false}, "ambientOcclusion": {"map": "independent-procedural-coronary-artery-ao", "cavityStrength": 0.22, "contactShadowBias": 0.35, "notes": "Only contact/groove cavities; do not paint global dark gradients."}, "clearcoat": 0.2, "clearcoatRoughness": 0.38, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2A0B16"}, "localOverrides": [{"id": "artery-taper-response", "region": "primary and tapering branches", "roughness": 0.31, "evidenceRefs": ["reference"]}], "shaderNotes": ["Use broad semi-gloss highlights; avoid a single global toy-plastic response.", "Keep albedo, roughness, normal/height and AO independent."], "notes": "Single-reference PBR estimate; not measured tissue data. Rear response is inferred.", "referencePbr": {"version": "1", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\reference.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "reference-pixel-extraction", "verdict": "pass", "usable": true, "confidence": 0.83, "estimatedFidelity": 0.83, "targetThreshold": 0.7, "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\coronary-artery\\coronary-artery_albedo.png", "url": "coronary-artery_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\coronary-artery\\coronary-artery_roughness.png", "url": "coronary-artery_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\coronary-artery\\coronary-artery_height.png", "url": "coronary-artery_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\coronary-artery\\coronary-artery_normal.png", "url": "coronary-artery_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\coronary-artery\\coronary-artery_ao.png", "url": "coronary-artery_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "hardLimit": "Single lit crop is an estimate, not physical inverse rendering."}},
    options
  );
  materialMap["coronary-vein"] = createSculptMaterial(
    "coronary-vein",
    {"id": "coronary-vein", "name": "Blue coronary veins", "type": "physical", "qualityTier": "hero", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#1764AE", "color": "#1764AE", "albedo": {"dominant": "#1764AE", "secondary": ["#0E407C", "#3C8CD0"], "samplingNotes": "Sample only the named tissue footprint; exclude hotspot rings, background, pedestal and UI."}, "colorVariation": {"palette": ["#1764AE", "#0E407C", "#3C8CD0"], "pattern": "low-frequency tissue mottling", "amplitude": 0.08, "heightCorrelation": 0.15}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-like generated object coordinates", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Object-scale stable relief; no source-photo projection."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.4, "amplitude": 0.09, "role": "broad tissue value and volume variation"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.035, "role": "shallow lobes, creases and vessel-wall variation"}, {"id": "micro", "frequency": 38.0, "amplitude": 0.012, "role": "restrained highlight breakup"}], "roughness": {"base": 0.29, "variation": 0.07, "map": "independent-procedural-coronary-vein-roughness", "localResponse": "slightly lower on exposed crests and higher in grooves"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "independent-procedural-coronary-vein-height-normal", "strength": 0.18, "scale": 18.0, "space": "tangent"}, "bump": {"pattern": "bounded organic relief", "amplitude": 0.025, "scale": 12.0}, "displacement": {"pattern": "macro-only", "amplitude": 0.015, "scale": 2.0, "silhouetteAffects": false}, "ambientOcclusion": {"map": "independent-procedural-coronary-vein-ao", "cavityStrength": 0.22, "contactShadowBias": 0.35, "notes": "Only contact/groove cavities; do not paint global dark gradients."}, "clearcoat": 0.2, "clearcoatRoughness": 0.39, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2A0B16"}, "localOverrides": [{"id": "vein-taper-response", "region": "primary and tapering branches", "roughness": 0.32, "evidenceRefs": ["reference"]}], "shaderNotes": ["Use broad semi-gloss highlights; avoid a single global toy-plastic response.", "Keep albedo, roughness, normal/height and AO independent."], "notes": "Single-reference PBR estimate; not measured tissue data. Rear response is inferred.", "referencePbr": {"version": "1", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\reference.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "reference-pixel-extraction", "verdict": "pass", "usable": true, "confidence": 0.83, "estimatedFidelity": 0.83, "targetThreshold": 0.7, "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\coronary-vein\\coronary-vein_albedo.png", "url": "coronary-vein_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\coronary-vein\\coronary-vein_roughness.png", "url": "coronary-vein_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\coronary-vein\\coronary-vein_height.png", "url": "coronary-vein_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\coronary-vein\\coronary-vein_normal.png", "url": "coronary-vein_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\coronary-vein\\coronary-vein_ao.png", "url": "coronary-vein_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "hardLimit": "Single lit crop is an estimate, not physical inverse rendering."}},
    options
  );
  materialMap["epicardial-fat"] = createSculptMaterial(
    "epicardial-fat",
    {"id": "epicardial-fat", "name": "Gold epicardial fat", "type": "physical", "qualityTier": "hero", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#E9A15A", "color": "#E9A15A", "albedo": {"dominant": "#E9A15A", "secondary": ["#D47B36", "#F5C47B"], "samplingNotes": "Sample only the named tissue footprint; exclude hotspot rings, background, pedestal and UI."}, "colorVariation": {"palette": ["#E9A15A", "#D47B36", "#F5C47B"], "pattern": "low-frequency tissue mottling", "amplitude": 0.08, "heightCorrelation": 0.15}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-like generated object coordinates", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Object-scale stable relief; no source-photo projection."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.4, "amplitude": 0.09, "role": "broad tissue value and volume variation"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.035, "role": "shallow lobes, creases and vessel-wall variation"}, {"id": "micro", "frequency": 38.0, "amplitude": 0.012, "role": "restrained highlight breakup"}], "roughness": {"base": 0.39, "variation": 0.07, "map": "independent-procedural-epicardial-fat-roughness", "localResponse": "slightly lower on exposed crests and higher in grooves"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "independent-procedural-epicardial-fat-height-normal", "strength": 0.18, "scale": 18.0, "space": "tangent"}, "bump": {"pattern": "bounded organic relief", "amplitude": 0.025, "scale": 12.0}, "displacement": {"pattern": "macro-only", "amplitude": 0.015, "scale": 2.0, "silhouetteAffects": false}, "ambientOcclusion": {"map": "independent-procedural-epicardial-fat-ao", "cavityStrength": 0.22, "contactShadowBias": 0.35, "notes": "Only contact/groove cavities; do not paint global dark gradients."}, "clearcoat": 0.22, "clearcoatRoughness": 0.49, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2A0B16"}, "localOverrides": [{"id": "lobule-crest-gloss", "region": "fat along coronary grooves", "roughness": 0.33, "evidenceRefs": ["reference"]}], "shaderNotes": ["Use broad semi-gloss highlights; avoid a single global toy-plastic response.", "Keep albedo, roughness, normal/height and AO independent."], "notes": "Single-reference PBR estimate; not measured tissue data. Rear response is inferred.", "referencePbr": {"version": "1", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\reference.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "reference-pixel-extraction", "verdict": "pass", "usable": true, "confidence": 0.83, "estimatedFidelity": 0.83, "targetThreshold": 0.7, "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\epicardial-fat\\epicardial-fat_albedo.png", "url": "epicardial-fat_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\epicardial-fat\\epicardial-fat_roughness.png", "url": "epicardial-fat_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\epicardial-fat\\epicardial-fat_height.png", "url": "epicardial-fat_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\epicardial-fat\\epicardial-fat_normal.png", "url": "epicardial-fat_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\epicardial-fat\\epicardial-fat_ao.png", "url": "epicardial-fat_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "hardLimit": "Single lit crop is an estimate, not physical inverse rendering."}},
    options
  );
  materialMap["lumen"] = createSculptMaterial(
    "lumen",
    {"id": "lumen", "name": "Recessed vessel lumens", "type": "physical", "qualityTier": "utility", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#35131A", "color": "#35131A", "albedo": {"dominant": "#35131A", "secondary": ["#101A2A"], "samplingNotes": "Sample only the named tissue footprint; exclude hotspot rings, background, pedestal and UI."}, "colorVariation": {"palette": ["#35131A", "#101A2A"], "pattern": "low-frequency tissue mottling", "amplitude": 0.08, "heightCorrelation": 0.15}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-like generated object coordinates", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Object-scale stable relief; no source-photo projection."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.4, "amplitude": 0.09, "role": "broad tissue value and volume variation"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.035, "role": "shallow lobes, creases and vessel-wall variation"}, {"id": "micro", "frequency": 38.0, "amplitude": 0.012, "role": "restrained highlight breakup"}], "roughness": {"base": 0.68, "variation": 0.07, "map": "independent-procedural-lumen-roughness", "localResponse": "slightly lower on exposed crests and higher in grooves"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "independent-procedural-lumen-height-normal", "strength": 0.18, "scale": 18.0, "space": "tangent"}, "bump": {"pattern": "bounded organic relief", "amplitude": 0.025, "scale": 12.0}, "displacement": {"pattern": "macro-only", "amplitude": 0.015, "scale": 2.0, "silhouetteAffects": false}, "ambientOcclusion": {"map": "independent-procedural-lumen-ao", "cavityStrength": 0.22, "contactShadowBias": 0.35, "notes": "Only contact/groove cavities; do not paint global dark gradients."}, "clearcoat": 0.0, "clearcoatRoughness": 0.78, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2A0B16"}, "localOverrides": [{"id": "lumen-depth", "region": "all open vessel mouths", "roughness": 0.76, "evidenceRefs": ["reference"]}], "shaderNotes": ["Use broad semi-gloss highlights; avoid a single global toy-plastic response.", "Keep albedo, roughness, normal/height and AO independent."], "notes": "Single-reference PBR estimate; not measured tissue data. Rear response is inferred.", "referencePbr": {"version": "1", "sourceImage": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\reference.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "reference-pixel-extraction", "verdict": "pass", "usable": true, "confidence": 0.83, "estimatedFidelity": 0.83, "targetThreshold": 0.7, "maps": {"albedo": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\lumen\\lumen_albedo.png", "url": "lumen_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\lumen\\lumen_roughness.png", "url": "lumen_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\lumen\\lumen_height.png", "url": "lumen_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\lumen\\lumen_normal.png", "url": "lumen_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "D:\\Learn\\20_Projects\\3dresearch\\3d-learning\\reproductions\\agent-3dgeneration\\img2threejs\\workspaces\\heart-reference-retry\\material-evidence\\lumen\\lumen_ao.png", "url": "lumen_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "hardLimit": "Single lit crop is an estimate, not physical inverse rendering."}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_ventricular_body_0 = makeAttachmentEndpoint(null);
  const node_ventricular_body_0 = new THREE.Group();
  node_ventricular_body_0.name = "Closed asymmetric ventricular loft__pivot";
  node_ventricular_body_0.scale.set(1, 1, 1);
  if (endpoint_ventricular_body_0) {
    node_ventricular_body_0.position.copy(endpoint_ventricular_body_0.start);
    node_ventricular_body_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ventricular_body_0.position.set(0.1, -0.52, 0.0);
    node_ventricular_body_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_ventricular_body_0.userData.sculptComponent = {"id": "ventricular-body", "name": "Closed asymmetric ventricular loft", "level": "macro", "role": "body", "importance": 0.8, "confidence": 0.97, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "The single reference requires closed asymmetric ventricular loft as a distinct, reviewable 3D structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.94, -2.06, -0.03], "rx": 0.001, "rz": 0.001}, {"position": [0.88, -2.0, -0.01], "rx": 0.26, "rz": 0.14}, {"position": [0.72, -1.85, 0.0], "rx": 0.55, "rz": 0.34}, {"position": [0.5, -1.55, 0.0], "rx": 0.88, "rz": 0.54}, {"position": [0.32, -1.15, 0.0], "rx": 1.15, "rz": 0.71}, {"position": [0.2, -0.65, 0.0], "rx": 1.28, "rz": 0.84}, {"position": [0.1, -0.12, 0.0], "rx": 1.28, "rz": 0.89}, {"position": [0.02, 0.32, 0.0], "rx": 1.04, "rz": 0.77}, {"position": [-0.12, 0.62, 0.0], "rx": 0.67, "rz": 0.53}, {"position": [-0.12, 0.84, -0.05], "rx": 0.34, "rz": 0.3}, {"position": [-0.1, 0.97, -0.1], "rx": 0.001, "rz": 0.001}], "radialSegments": 48, "capEnds": true, "source": "anatomy-layout.json#/bodyStations"}}, "parent": null, "attachment": null, "dimensions": {"width": 2.66, "height": 3.03, "depth": 1.78, "units": "relative-heart-height", "confidence": 0.97}, "transform": {"position": [0.1, -0.52, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "ventricular-body-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ventricular-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "closed-loft-stations", "kind": "contour", "description": "Closed tapered loft uses anatomy-layout.json bodyStations; apex at x≈0.88, y≈-2.0 and broad shoulder at y≈0.95.", "evidenceRefs": ["reference"]}, {"id": "left-ventricular-mass", "kind": "contour", "description": "Image-right dominant ventricular mass is integrated into the single closed loft.", "evidenceRefs": ["reference"]}, {"id": "right-ventricular-wrap", "kind": "contour", "description": "Image-left anterior ventricular wrap is an integrated loft region, not a duplicate ellipsoid mesh.", "evidenceRefs": ["reference"]}, {"id": "anterior-fiber-relief", "kind": "ridge", "description": "Restrained diagonal myocardial fiber ridges break highlights without altering the locked silhouette.", "evidenceRefs": ["reference"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Reference-observed front surface; rear/depth continuation is inferred where occluded."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["reference"], "note": "Visible region sampled conceptually from reference.png; highlights remain lighting response."}, "evidenceRefs": ["reference"], "details": [], "fidelityTier": "hero"};
  node_ventricular_body_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "ventricular-body-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ventricular-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["root"] ?? root).add(node_ventricular_body_0);
  nodes["ventricular-body"] = node_ventricular_body_0;
  const mesh_ventricular_body_0Geometry = endpoint_ventricular_body_0
    ? new THREE.CylinderGeometry(endpoint_ventricular_body_0.endRadius, endpoint_ventricular_body_0.baseRadius, endpoint_ventricular_body_0.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.94, -2.06, -0.03], "rx": 0.001, "rz": 0.001}, {"position": [0.88, -2.0, -0.01], "rx": 0.26, "rz": 0.14}, {"position": [0.72, -1.85, 0.0], "rx": 0.55, "rz": 0.34}, {"position": [0.5, -1.55, 0.0], "rx": 0.88, "rz": 0.54}, {"position": [0.32, -1.15, 0.0], "rx": 1.15, "rz": 0.71}, {"position": [0.2, -0.65, 0.0], "rx": 1.28, "rz": 0.84}, {"position": [0.1, -0.12, 0.0], "rx": 1.28, "rz": 0.89}, {"position": [0.02, 0.32, 0.0], "rx": 1.04, "rz": 0.77}, {"position": [-0.12, 0.62, 0.0], "rx": 0.67, "rz": 0.53}, {"position": [-0.12, 0.84, -0.05], "rx": 0.34, "rz": 0.3}, {"position": [-0.1, 0.97, -0.1], "rx": 0.001, "rz": 0.001}], "radialSegments": 48, "capEnds": true, "source": "anatomy-layout.json#/bodyStations"});
  if (!endpoint_ventricular_body_0) {
    mesh_ventricular_body_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_ventricular_body_0 = new THREE.Mesh(
    mesh_ventricular_body_0Geometry,
    materialMap["myocardium"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ventricular_body_0.name = "Closed asymmetric ventricular loft";
  if (endpoint_ventricular_body_0) {
    mesh_ventricular_body_0.position.copy(endpoint_ventricular_body_0.midpoint);
    mesh_ventricular_body_0.quaternion.copy(endpoint_ventricular_body_0.quaternion);
  }
  mesh_ventricular_body_0.castShadow = options.castShadow ?? true;
  mesh_ventricular_body_0.receiveShadow = options.receiveShadow ?? true;
  mesh_ventricular_body_0.userData.sculptComponent = {"id": "ventricular-body", "name": "Closed asymmetric ventricular loft", "level": "macro", "role": "body", "importance": 0.8, "confidence": 0.97, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "The single reference requires closed asymmetric ventricular loft as a distinct, reviewable 3D structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.94, -2.06, -0.03], "rx": 0.001, "rz": 0.001}, {"position": [0.88, -2.0, -0.01], "rx": 0.26, "rz": 0.14}, {"position": [0.72, -1.85, 0.0], "rx": 0.55, "rz": 0.34}, {"position": [0.5, -1.55, 0.0], "rx": 0.88, "rz": 0.54}, {"position": [0.32, -1.15, 0.0], "rx": 1.15, "rz": 0.71}, {"position": [0.2, -0.65, 0.0], "rx": 1.28, "rz": 0.84}, {"position": [0.1, -0.12, 0.0], "rx": 1.28, "rz": 0.89}, {"position": [0.02, 0.32, 0.0], "rx": 1.04, "rz": 0.77}, {"position": [-0.12, 0.62, 0.0], "rx": 0.67, "rz": 0.53}, {"position": [-0.12, 0.84, -0.05], "rx": 0.34, "rz": 0.3}, {"position": [-0.1, 0.97, -0.1], "rx": 0.001, "rz": 0.001}], "radialSegments": 48, "capEnds": true, "source": "anatomy-layout.json#/bodyStations"}}, "parent": null, "attachment": null, "dimensions": {"width": 2.66, "height": 3.03, "depth": 1.78, "units": "relative-heart-height", "confidence": 0.97}, "transform": {"position": [0.1, -0.52, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "ventricular-body-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ventricular-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "myocardium", "materialLayers": ["myocardium"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "closed-loft-stations", "kind": "contour", "description": "Closed tapered loft uses anatomy-layout.json bodyStations; apex at x≈0.88, y≈-2.0 and broad shoulder at y≈0.95.", "evidenceRefs": ["reference"]}, {"id": "left-ventricular-mass", "kind": "contour", "description": "Image-right dominant ventricular mass is integrated into the single closed loft.", "evidenceRefs": ["reference"]}, {"id": "right-ventricular-wrap", "kind": "contour", "description": "Image-left anterior ventricular wrap is an integrated loft region, not a duplicate ellipsoid mesh.", "evidenceRefs": ["reference"]}, {"id": "anterior-fiber-relief", "kind": "ridge", "description": "Restrained diagonal myocardial fiber ridges break highlights without altering the locked silhouette.", "evidenceRefs": ["reference"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.015, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Reference-observed front surface; rear/depth continuation is inferred where occluded."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(183, 55, 66, 1.0)", "secondaryAlbedo": "rgba(111, 24, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(111, 24, 45, 1.0)"}, {"position": 1.0, "color": "rgba(183, 55, 66, 1.0)"}]}, "evidenceRefs": ["reference"], "note": "Visible region sampled conceptually from reference.png; highlights remain lighting response."}, "evidenceRefs": ["reference"], "details": [], "fidelityTier": "hero"};
  node_ventricular_body_0.add(mesh_ventricular_body_0);
  meshes["ventricular-body"] = mesh_ventricular_body_0;
  colliders["ventricular-body"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["ventricular-body"] ??= [];
  destructionGroups["ventricular-body"].push(node_ventricular_body_0);
  const socket_ventricular_body_ventricular_body_surface_0 = new THREE.Object3D();
  socket_ventricular_body_ventricular_body_surface_0.name = "ventricular-body-surface";
  socket_ventricular_body_ventricular_body_surface_0.position.set(0.0, 0.0, 0.0);
  socket_ventricular_body_ventricular_body_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_ventricular_body_ventricular_body_surface_0.userData.socket = {"id": "ventricular-body-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_ventricular_body_0.add(socket_ventricular_body_ventricular_body_surface_0);
  sockets["ventricular-body:ventricular-body-surface"] = socket_ventricular_body_ventricular_body_surface_0;

  const endpoint_atrial_complex_1 = makeAttachmentEndpoint(null);
  const node_atrial_complex_1 = new THREE.Group();
  node_atrial_complex_1.name = "Asymmetric atrial and auricular complex__pivot";
  node_atrial_complex_1.scale.set(1, 1, 1);
  if (endpoint_atrial_complex_1) {
    node_atrial_complex_1.position.copy(endpoint_atrial_complex_1.start);
    node_atrial_complex_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_atrial_complex_1.position.set(-0.05, 0.55, 0.05);
    node_atrial_complex_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_atrial_complex_1.userData.sculptComponent = {"id": "atrial-complex", "name": "Asymmetric atrial and auricular complex", "level": "macro", "role": "body", "importance": 0.8, "confidence": 0.9, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "The single reference requires asymmetric atrial and auricular complex as a distinct, reviewable 3D structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [-0.05, 0.55, 0.05], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]}, "dimensions": {"width": 2.25, "height": 1.25, "depth": 1.25, "units": "relative-heart-height", "confidence": 0.9}, "transform": {"position": [-0.05, 0.55, 0.05], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "atrial-complex-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "atrial-complex", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "atrial-tissue", "materialLayers": ["atrial-tissue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "deep-salmon-overlap", "kind": "contour", "description": "Unequal atrial masses overlap the superior ventricular shoulder.", "evidenceRefs": ["reference"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Reference-observed front surface; rear/depth continuation is inferred where occluded."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 91, 98, 1.0)", "secondaryAlbedo": "rgba(168, 67, 80, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(168, 67, 80, 1.0)"}, {"position": 1.0, "color": "rgba(200, 91, 98, 1.0)"}]}, "evidenceRefs": ["reference"], "note": "Visible region sampled conceptually from reference.png; highlights remain lighting response."}, "evidenceRefs": ["reference"], "details": [], "fidelityTier": "hero"};
  node_atrial_complex_1.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "atrial-complex-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "atrial-complex", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["ventricular-body"] ?? root).add(node_atrial_complex_1);
  nodes["atrial-complex"] = node_atrial_complex_1;
  const mesh_atrial_complex_1Geometry = endpoint_atrial_complex_1
    ? new THREE.CylinderGeometry(endpoint_atrial_complex_1.endRadius, endpoint_atrial_complex_1.baseRadius, endpoint_atrial_complex_1.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_atrial_complex_1) {
    mesh_atrial_complex_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_atrial_complex_1 = new THREE.Mesh(
    mesh_atrial_complex_1Geometry,
    materialMap["atrial-tissue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_atrial_complex_1.name = "Asymmetric atrial and auricular complex";
  if (endpoint_atrial_complex_1) {
    mesh_atrial_complex_1.position.copy(endpoint_atrial_complex_1.midpoint);
    mesh_atrial_complex_1.quaternion.copy(endpoint_atrial_complex_1.quaternion);
  }
  mesh_atrial_complex_1.castShadow = options.castShadow ?? true;
  mesh_atrial_complex_1.receiveShadow = options.receiveShadow ?? true;
  mesh_atrial_complex_1.userData.sculptComponent = {"id": "atrial-complex", "name": "Asymmetric atrial and auricular complex", "level": "macro", "role": "body", "importance": 0.8, "confidence": 0.9, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "The single reference requires asymmetric atrial and auricular complex as a distinct, reviewable 3D structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals"}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [-0.05, 0.55, 0.05], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]}, "dimensions": {"width": 2.25, "height": 1.25, "depth": 1.25, "units": "relative-heart-height", "confidence": 0.9}, "transform": {"position": [-0.05, 0.55, 0.05], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "atrial-complex-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "atrial-complex", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "atrial-tissue", "materialLayers": ["atrial-tissue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "deep-salmon-overlap", "kind": "contour", "description": "Unequal atrial masses overlap the superior ventricular shoulder.", "evidenceRefs": ["reference"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Reference-observed front surface; rear/depth continuation is inferred where occluded."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 91, 98, 1.0)", "secondaryAlbedo": "rgba(168, 67, 80, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(168, 67, 80, 1.0)"}, {"position": 1.0, "color": "rgba(200, 91, 98, 1.0)"}]}, "evidenceRefs": ["reference"], "note": "Visible region sampled conceptually from reference.png; highlights remain lighting response."}, "evidenceRefs": ["reference"], "details": [], "fidelityTier": "hero"};
  node_atrial_complex_1.add(mesh_atrial_complex_1);
  meshes["atrial-complex"] = mesh_atrial_complex_1;
  colliders["atrial-complex"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["atrial-complex"] ??= [];
  destructionGroups["atrial-complex"].push(node_atrial_complex_1);
  const socket_atrial_complex_atrial_complex_surface_0 = new THREE.Object3D();
  socket_atrial_complex_atrial_complex_surface_0.name = "atrial-complex-surface";
  socket_atrial_complex_atrial_complex_surface_0.position.set(0.0, 0.0, 0.0);
  socket_atrial_complex_atrial_complex_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_atrial_complex_atrial_complex_surface_0.userData.socket = {"id": "atrial-complex-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_atrial_complex_1.add(socket_atrial_complex_atrial_complex_surface_0);
  sockets["atrial-complex:atrial-complex-surface"] = socket_atrial_complex_atrial_complex_surface_0;

  const attachment_aortic_system_2 = {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [-0.4286, 0.8214, 0.05], "localEnd": [0.2321, 0.8857, -0.5], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]};
  const endpoint_aortic_system_2 = makeAttachmentEndpoint(attachment_aortic_system_2);
  const node_aortic_system_2 = new THREE.Group();
  node_aortic_system_2.name = "Continuous ascending aorta and arch__pivot";
  node_aortic_system_2.scale.set(1, 1, 1);
  if (endpoint_aortic_system_2) {
    node_aortic_system_2.position.copy(endpoint_aortic_system_2.start);
    node_aortic_system_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_aortic_system_2.position.set(-0.25, 1.35, -0.2);
    node_aortic_system_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_aortic_system_2.userData.sculptComponent = {"id": "aortic-system", "name": "Continuous ascending aorta and arch", "level": "macro", "role": "vessel", "importance": 0.8, "confidence": 0.97, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "The single reference requires continuous ascending aorta and arch as a distinct, reviewable 3D structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.4286, 0.8214, 0.05], [-0.4929, 1.1607, 0.08], [-0.3964, 1.5536, 0.0], [-0.1464, 1.8036, -0.08], [0.0964, 1.7571, -0.17], [0.2393, 1.4179, -0.4], [0.2321, 0.8857, -0.5]], "radius": 0.24, "radialSegments": 12, "closed": false}}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [-0.4286, 0.8214, 0.05], "localEnd": [0.2321, 0.8857, -0.5], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]}, "dimensions": {"width": 1.3, "height": 2.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.97}, "transform": {"position": [-0.25, 1.35, -0.2], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "aortic-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "continuous-root-ascending-arch", "kind": "contour", "description": "One continuous arterial tube follows the measured aortic-arch path; root and ascending segments are local regions, not disjoint meshes.", "evidenceRefs": ["reference"]}, {"id": "three-hollow-branch-mouths", "kind": "hole", "description": "Exactly three superior branch outlets have wall thickness and recessed lumens.", "evidenceRefs": ["reference"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Reference-observed front surface; rear/depth continuation is inferred where occluded."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 70, 69, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["reference"], "note": "Visible region sampled conceptually from reference.png; highlights remain lighting response."}, "evidenceRefs": ["reference"], "details": [], "fidelityTier": "hero"};
  node_aortic_system_2.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "aortic-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["ventricular-body"] ?? root).add(node_aortic_system_2);
  nodes["aortic-system"] = node_aortic_system_2;
  const mesh_aortic_system_2Geometry = endpoint_aortic_system_2
    ? new THREE.CylinderGeometry(endpoint_aortic_system_2.endRadius, endpoint_aortic_system_2.baseRadius, endpoint_aortic_system_2.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.4286, 0.8214, 0.05], [-0.4929, 1.1607, 0.08], [-0.3964, 1.5536, 0.0], [-0.1464, 1.8036, -0.08], [0.0964, 1.7571, -0.17], [0.2393, 1.4179, -0.4], [0.2321, 0.8857, -0.5]], "radius": 0.24, "radialSegments": 12, "closed": false});
  if (!endpoint_aortic_system_2) {
    mesh_aortic_system_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_aortic_system_2 = new THREE.Mesh(
    mesh_aortic_system_2Geometry,
    materialMap["arterial"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_aortic_system_2.name = "Continuous ascending aorta and arch";
  if (endpoint_aortic_system_2) {
    mesh_aortic_system_2.position.copy(endpoint_aortic_system_2.midpoint);
    mesh_aortic_system_2.quaternion.copy(endpoint_aortic_system_2.quaternion);
  }
  mesh_aortic_system_2.castShadow = options.castShadow ?? true;
  mesh_aortic_system_2.receiveShadow = options.receiveShadow ?? true;
  mesh_aortic_system_2.userData.sculptComponent = {"id": "aortic-system", "name": "Continuous ascending aorta and arch", "level": "macro", "role": "vessel", "importance": 0.8, "confidence": 0.97, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "The single reference requires continuous ascending aorta and arch as a distinct, reviewable 3D structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.4286, 0.8214, 0.05], [-0.4929, 1.1607, 0.08], [-0.3964, 1.5536, 0.0], [-0.1464, 1.8036, -0.08], [0.0964, 1.7571, -0.17], [0.2393, 1.4179, -0.4], [0.2321, 0.8857, -0.5]], "radius": 0.24, "radialSegments": 12, "closed": false}}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [-0.4286, 0.8214, 0.05], "localEnd": [0.2321, 0.8857, -0.5], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]}, "dimensions": {"width": 1.3, "height": 2.0, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.97}, "transform": {"position": [-0.25, 1.35, -0.2], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "aortic-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "aortic-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "continuous-root-ascending-arch", "kind": "contour", "description": "One continuous arterial tube follows the measured aortic-arch path; root and ascending segments are local regions, not disjoint meshes.", "evidenceRefs": ["reference"]}, {"id": "three-hollow-branch-mouths", "kind": "hole", "description": "Exactly three superior branch outlets have wall thickness and recessed lumens.", "evidenceRefs": ["reference"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Reference-observed front surface; rear/depth continuation is inferred where occluded."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 70, 69, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["reference"], "note": "Visible region sampled conceptually from reference.png; highlights remain lighting response."}, "evidenceRefs": ["reference"], "details": [], "fidelityTier": "hero"};
  node_aortic_system_2.add(mesh_aortic_system_2);
  meshes["aortic-system"] = mesh_aortic_system_2;
  colliders["aortic-system"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["aortic-system"] ??= [];
  destructionGroups["aortic-system"].push(node_aortic_system_2);
  const socket_aortic_system_aortic_system_surface_0 = new THREE.Object3D();
  socket_aortic_system_aortic_system_surface_0.name = "aortic-system-surface";
  socket_aortic_system_aortic_system_surface_0.position.set(0.0, 0.0, 0.0);
  socket_aortic_system_aortic_system_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_aortic_system_aortic_system_surface_0.userData.socket = {"id": "aortic-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_aortic_system_2.add(socket_aortic_system_aortic_system_surface_0);
  sockets["aortic-system:aortic-system-surface"] = socket_aortic_system_aortic_system_surface_0;

  const attachment_pulmonary_arterial_system_3 = {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [-0.1571, 0.6, 0.62], "localEnd": [0.85, 1.4786, 0.83], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]};
  const endpoint_pulmonary_arterial_system_3 = makeAttachmentEndpoint(attachment_pulmonary_arterial_system_3);
  const node_pulmonary_arterial_system_3 = new THREE.Group();
  node_pulmonary_arterial_system_3.name = "Pulmonary trunk and branches__pivot";
  node_pulmonary_arterial_system_3.scale.set(1, 1, 1);
  if (endpoint_pulmonary_arterial_system_3) {
    node_pulmonary_arterial_system_3.position.copy(endpoint_pulmonary_arterial_system_3.start);
    node_pulmonary_arterial_system_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pulmonary_arterial_system_3.position.set(0.2, 1.0, 0.62);
    node_pulmonary_arterial_system_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_pulmonary_arterial_system_3.userData.sculptComponent = {"id": "pulmonary-arterial-system", "name": "Pulmonary trunk and branches", "level": "macro", "role": "vessel", "importance": 0.8, "confidence": 0.95, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "The single reference requires pulmonary trunk and branches as a distinct, reviewable 3D structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.1571, 0.6, 0.62], [-0.0857, 0.9643, 0.66], [0.0786, 1.3143, 0.68], [0.4143, 1.4679, 0.68], [0.85, 1.4786, 0.83]], "radius": 0.23, "radialSegments": 12, "closed": false}}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [-0.1571, 0.6, 0.62], "localEnd": [0.85, 1.4786, 0.83], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]}, "dimensions": {"width": 1.5, "height": 1.2, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.95}, "transform": {"position": [0.2, 1.0, 0.62], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "pulmonary-arterial-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-arterial-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "venous", "materialLayers": ["venous"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "anterior-aorta-crossing", "kind": "contour", "description": "Blue pulmonary trunk stays anterior to the red ascending aorta and turns toward image right.", "evidenceRefs": ["reference"]}, {"id": "left-mouth", "kind": "hole", "description": "The visible image-right pulmonary outlet is an open thick-walled tube mouth.", "evidenceRefs": ["reference"]}, {"id": "hidden-right-branch-inference", "kind": "contour", "description": "Opposite pulmonary branch is conservative inferred geometry behind the aorta.", "evidenceRefs": ["reference"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Reference-observed front surface; rear/depth continuation is inferred where occluded."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(70, 23, 51, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(70, 23, 51, 1.0)"}, {"position": 1.0, "color": "rgba(116, 43, 75, 1.0)"}]}, "evidenceRefs": ["reference"], "note": "Visible region sampled conceptually from reference.png; highlights remain lighting response."}, "evidenceRefs": ["reference"], "details": [], "fidelityTier": "hero"};
  node_pulmonary_arterial_system_3.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "pulmonary-arterial-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-arterial-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["ventricular-body"] ?? root).add(node_pulmonary_arterial_system_3);
  nodes["pulmonary-arterial-system"] = node_pulmonary_arterial_system_3;
  const mesh_pulmonary_arterial_system_3Geometry = endpoint_pulmonary_arterial_system_3
    ? new THREE.CylinderGeometry(endpoint_pulmonary_arterial_system_3.endRadius, endpoint_pulmonary_arterial_system_3.baseRadius, endpoint_pulmonary_arterial_system_3.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.1571, 0.6, 0.62], [-0.0857, 0.9643, 0.66], [0.0786, 1.3143, 0.68], [0.4143, 1.4679, 0.68], [0.85, 1.4786, 0.83]], "radius": 0.23, "radialSegments": 12, "closed": false});
  if (!endpoint_pulmonary_arterial_system_3) {
    mesh_pulmonary_arterial_system_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pulmonary_arterial_system_3 = new THREE.Mesh(
    mesh_pulmonary_arterial_system_3Geometry,
    materialMap["venous"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pulmonary_arterial_system_3.name = "Pulmonary trunk and branches";
  if (endpoint_pulmonary_arterial_system_3) {
    mesh_pulmonary_arterial_system_3.position.copy(endpoint_pulmonary_arterial_system_3.midpoint);
    mesh_pulmonary_arterial_system_3.quaternion.copy(endpoint_pulmonary_arterial_system_3.quaternion);
  }
  mesh_pulmonary_arterial_system_3.castShadow = options.castShadow ?? true;
  mesh_pulmonary_arterial_system_3.receiveShadow = options.receiveShadow ?? true;
  mesh_pulmonary_arterial_system_3.userData.sculptComponent = {"id": "pulmonary-arterial-system", "name": "Pulmonary trunk and branches", "level": "macro", "role": "vessel", "importance": 0.8, "confidence": 0.95, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "The single reference requires pulmonary trunk and branches as a distinct, reviewable 3D structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.1571, 0.6, 0.62], [-0.0857, 0.9643, 0.66], [0.0786, 1.3143, 0.68], [0.4143, 1.4679, 0.68], [0.85, 1.4786, 0.83]], "radius": 0.23, "radialSegments": 12, "closed": false}}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [-0.1571, 0.6, 0.62], "localEnd": [0.85, 1.4786, 0.83], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]}, "dimensions": {"width": 1.5, "height": 1.2, "depth": 1.0, "units": "relative-heart-height", "confidence": 0.95}, "transform": {"position": [0.2, 1.0, 0.62], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "pulmonary-arterial-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-arterial-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "venous", "materialLayers": ["venous"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "anterior-aorta-crossing", "kind": "contour", "description": "Blue pulmonary trunk stays anterior to the red ascending aorta and turns toward image right.", "evidenceRefs": ["reference"]}, {"id": "left-mouth", "kind": "hole", "description": "The visible image-right pulmonary outlet is an open thick-walled tube mouth.", "evidenceRefs": ["reference"]}, {"id": "hidden-right-branch-inference", "kind": "contour", "description": "Opposite pulmonary branch is conservative inferred geometry behind the aorta.", "evidenceRefs": ["reference"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Reference-observed front surface; rear/depth continuation is inferred where occluded."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(70, 23, 51, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(70, 23, 51, 1.0)"}, {"position": 1.0, "color": "rgba(116, 43, 75, 1.0)"}]}, "evidenceRefs": ["reference"], "note": "Visible region sampled conceptually from reference.png; highlights remain lighting response."}, "evidenceRefs": ["reference"], "details": [], "fidelityTier": "hero"};
  node_pulmonary_arterial_system_3.add(mesh_pulmonary_arterial_system_3);
  meshes["pulmonary-arterial-system"] = mesh_pulmonary_arterial_system_3;
  colliders["pulmonary-arterial-system"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["pulmonary-arterial-system"] ??= [];
  destructionGroups["pulmonary-arterial-system"].push(node_pulmonary_arterial_system_3);
  const socket_pulmonary_arterial_system_pulmonary_arterial_system_surface_0 = new THREE.Object3D();
  socket_pulmonary_arterial_system_pulmonary_arterial_system_surface_0.name = "pulmonary-arterial-system-surface";
  socket_pulmonary_arterial_system_pulmonary_arterial_system_surface_0.position.set(0.0, 0.0, 0.0);
  socket_pulmonary_arterial_system_pulmonary_arterial_system_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_pulmonary_arterial_system_pulmonary_arterial_system_surface_0.userData.socket = {"id": "pulmonary-arterial-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_pulmonary_arterial_system_3.add(socket_pulmonary_arterial_system_pulmonary_arterial_system_surface_0);
  sockets["pulmonary-arterial-system:pulmonary-arterial-system-surface"] = socket_pulmonary_arterial_system_pulmonary_arterial_system_surface_0;

  const attachment_vena_cava_system_4 = {"parentId": "atrial-complex", "parentSocket": "atrial-complex-surface", "localStart": [-1.0107, 0.8036, -0.26], "localEnd": [-0.9786, 1.9036, 0.02], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]};
  const endpoint_vena_cava_system_4 = makeAttachmentEndpoint(attachment_vena_cava_system_4);
  const node_vena_cava_system_4 = new THREE.Group();
  node_vena_cava_system_4.name = "Superior and inferior vena cava__pivot";
  node_vena_cava_system_4.scale.set(1, 1, 1);
  if (endpoint_vena_cava_system_4) {
    node_vena_cava_system_4.position.copy(endpoint_vena_cava_system_4.start);
    node_vena_cava_system_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vena_cava_system_4.position.set(-0.95, 0.1, -0.28);
    node_vena_cava_system_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_vena_cava_system_4.userData.sculptComponent = {"id": "vena-cava-system", "name": "Superior and inferior vena cava", "level": "macro", "role": "vessel", "importance": 0.8, "confidence": 0.94, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "The single reference requires superior and inferior vena cava as a distinct, reviewable 3D structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-1.0107, 0.8036, -0.26], [-0.9357, 1.2571, -0.25], [-0.9714, 1.6536, -0.2], [-0.9786, 1.9036, 0.02]], "radius": 0.22, "radialSegments": 12, "closed": false}}, "parent": "atrial-complex", "attachment": {"parentId": "atrial-complex", "parentSocket": "atrial-complex-surface", "localStart": [-1.0107, 0.8036, -0.26], "localEnd": [-0.9786, 1.9036, 0.02], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]}, "dimensions": {"width": 0.5, "height": 3.0, "depth": 0.5, "units": "relative-heart-height", "confidence": 0.94}, "transform": {"position": [-0.95, 0.1, -0.28], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "vena-cava-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "vena-cava-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "venous", "materialLayers": ["venous"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "superior-inferior-continuity", "kind": "contour", "description": "SVC and IVC align as one vertical blue system on image left with the atrium interrupting the visible middle.", "evidenceRefs": ["reference"]}, {"id": "caval-openings", "kind": "hole", "description": "Visible superior and inferior ends have recessed blue-walled lumens.", "evidenceRefs": ["reference"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Reference-observed front surface; rear/depth continuation is inferred where occluded."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(70, 23, 51, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(70, 23, 51, 1.0)"}, {"position": 1.0, "color": "rgba(116, 43, 75, 1.0)"}]}, "evidenceRefs": ["reference"], "note": "Visible region sampled conceptually from reference.png; highlights remain lighting response."}, "evidenceRefs": ["reference"], "details": [], "fidelityTier": "hero"};
  node_vena_cava_system_4.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "vena-cava-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "vena-cava-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["atrial-complex"] ?? root).add(node_vena_cava_system_4);
  nodes["vena-cava-system"] = node_vena_cava_system_4;
  const mesh_vena_cava_system_4Geometry = endpoint_vena_cava_system_4
    ? new THREE.CylinderGeometry(endpoint_vena_cava_system_4.endRadius, endpoint_vena_cava_system_4.baseRadius, endpoint_vena_cava_system_4.length, 32, 12)
    : buildTubeGeometry({"points": [[-1.0107, 0.8036, -0.26], [-0.9357, 1.2571, -0.25], [-0.9714, 1.6536, -0.2], [-0.9786, 1.9036, 0.02]], "radius": 0.22, "radialSegments": 12, "closed": false});
  if (!endpoint_vena_cava_system_4) {
    mesh_vena_cava_system_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_vena_cava_system_4 = new THREE.Mesh(
    mesh_vena_cava_system_4Geometry,
    materialMap["venous"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vena_cava_system_4.name = "Superior and inferior vena cava";
  if (endpoint_vena_cava_system_4) {
    mesh_vena_cava_system_4.position.copy(endpoint_vena_cava_system_4.midpoint);
    mesh_vena_cava_system_4.quaternion.copy(endpoint_vena_cava_system_4.quaternion);
  }
  mesh_vena_cava_system_4.castShadow = options.castShadow ?? true;
  mesh_vena_cava_system_4.receiveShadow = options.receiveShadow ?? true;
  mesh_vena_cava_system_4.userData.sculptComponent = {"id": "vena-cava-system", "name": "Superior and inferior vena cava", "level": "macro", "role": "vessel", "importance": 0.8, "confidence": 0.94, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "The single reference requires superior and inferior vena cava as a distinct, reviewable 3D structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-1.0107, 0.8036, -0.26], [-0.9357, 1.2571, -0.25], [-0.9714, 1.6536, -0.2], [-0.9786, 1.9036, 0.02]], "radius": 0.22, "radialSegments": 12, "closed": false}}, "parent": "atrial-complex", "attachment": {"parentId": "atrial-complex", "parentSocket": "atrial-complex-surface", "localStart": [-1.0107, 0.8036, -0.26], "localEnd": [-0.9786, 1.9036, 0.02], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]}, "dimensions": {"width": 0.5, "height": 3.0, "depth": 0.5, "units": "relative-heart-height", "confidence": 0.94}, "transform": {"position": [-0.95, 0.1, -0.28], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "vena-cava-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "vena-cava-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "venous", "materialLayers": ["venous"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "superior-inferior-continuity", "kind": "contour", "description": "SVC and IVC align as one vertical blue system on image left with the atrium interrupting the visible middle.", "evidenceRefs": ["reference"]}, {"id": "caval-openings", "kind": "hole", "description": "Visible superior and inferior ends have recessed blue-walled lumens.", "evidenceRefs": ["reference"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Reference-observed front surface; rear/depth continuation is inferred where occluded."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(116, 43, 75, 1.0)", "secondaryAlbedo": "rgba(70, 23, 51, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(70, 23, 51, 1.0)"}, {"position": 1.0, "color": "rgba(116, 43, 75, 1.0)"}]}, "evidenceRefs": ["reference"], "note": "Visible region sampled conceptually from reference.png; highlights remain lighting response."}, "evidenceRefs": ["reference"], "details": [], "fidelityTier": "hero"};
  node_vena_cava_system_4.add(mesh_vena_cava_system_4);
  meshes["vena-cava-system"] = mesh_vena_cava_system_4;
  colliders["vena-cava-system"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["vena-cava-system"] ??= [];
  destructionGroups["vena-cava-system"].push(node_vena_cava_system_4);
  const socket_vena_cava_system_vena_cava_system_surface_0 = new THREE.Object3D();
  socket_vena_cava_system_vena_cava_system_surface_0.name = "vena-cava-system-surface";
  socket_vena_cava_system_vena_cava_system_surface_0.position.set(0.0, 0.0, 0.0);
  socket_vena_cava_system_vena_cava_system_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_vena_cava_system_vena_cava_system_surface_0.userData.socket = {"id": "vena-cava-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_vena_cava_system_4.add(socket_vena_cava_system_vena_cava_system_surface_0);
  sockets["vena-cava-system:vena-cava-system-surface"] = socket_vena_cava_system_vena_cava_system_surface_0;

  const attachment_pulmonary_return_system_5 = {"parentId": "atrial-complex", "parentSocket": "atrial-complex-surface", "localStart": [-0.4179, 0.8429, -0.55], "localEnd": [-1.3357, 0.9286, -0.02], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]};
  const endpoint_pulmonary_return_system_5 = makeAttachmentEndpoint(attachment_pulmonary_return_system_5);
  const node_pulmonary_return_system_5 = new THREE.Group();
  node_pulmonary_return_system_5.name = "Four pulmonary vein returns__pivot";
  node_pulmonary_return_system_5.scale.set(1, 1, 1);
  if (endpoint_pulmonary_return_system_5) {
    node_pulmonary_return_system_5.position.copy(endpoint_pulmonary_return_system_5.start);
    node_pulmonary_return_system_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pulmonary_return_system_5.position.set(0.0, 0.75, -0.45);
    node_pulmonary_return_system_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_pulmonary_return_system_5.userData.sculptComponent = {"id": "pulmonary-return-system", "name": "Four pulmonary vein returns", "level": "macro", "role": "vessel", "importance": 0.8, "confidence": 0.88, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "The single reference requires four pulmonary vein returns as a distinct, reviewable 3D structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.4179, 0.8429, -0.55], [-1.0679, 0.8571, -0.3], [-1.3357, 0.9286, -0.02]], "radius": 0.1, "radialSegments": 12, "closed": false}}, "parent": "atrial-complex", "attachment": {"parentId": "atrial-complex", "parentSocket": "atrial-complex-surface", "localStart": [-0.4179, 0.8429, -0.55], "localEnd": [-1.3357, 0.9286, -0.02], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]}, "dimensions": {"width": 2.5, "height": 0.8, "depth": 0.7, "units": "relative-heart-height", "confidence": 0.88}, "transform": {"position": [0.0, 0.75, -0.45], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "pulmonary-return-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-return-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "four-return-mouths", "kind": "hole", "description": "Four red pulmonary-vein stubs are visible, two per side, rooted behind the atria.", "evidenceRefs": ["reference"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Reference-observed front surface; rear/depth continuation is inferred where occluded."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 70, 69, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["reference"], "note": "Visible region sampled conceptually from reference.png; highlights remain lighting response."}, "evidenceRefs": ["reference"], "details": [], "fidelityTier": "hero"};
  node_pulmonary_return_system_5.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "pulmonary-return-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-return-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["atrial-complex"] ?? root).add(node_pulmonary_return_system_5);
  nodes["pulmonary-return-system"] = node_pulmonary_return_system_5;
  const mesh_pulmonary_return_system_5Geometry = endpoint_pulmonary_return_system_5
    ? new THREE.CylinderGeometry(endpoint_pulmonary_return_system_5.endRadius, endpoint_pulmonary_return_system_5.baseRadius, endpoint_pulmonary_return_system_5.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.4179, 0.8429, -0.55], [-1.0679, 0.8571, -0.3], [-1.3357, 0.9286, -0.02]], "radius": 0.1, "radialSegments": 12, "closed": false});
  if (!endpoint_pulmonary_return_system_5) {
    mesh_pulmonary_return_system_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pulmonary_return_system_5 = new THREE.Mesh(
    mesh_pulmonary_return_system_5Geometry,
    materialMap["arterial"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pulmonary_return_system_5.name = "Four pulmonary vein returns";
  if (endpoint_pulmonary_return_system_5) {
    mesh_pulmonary_return_system_5.position.copy(endpoint_pulmonary_return_system_5.midpoint);
    mesh_pulmonary_return_system_5.quaternion.copy(endpoint_pulmonary_return_system_5.quaternion);
  }
  mesh_pulmonary_return_system_5.castShadow = options.castShadow ?? true;
  mesh_pulmonary_return_system_5.receiveShadow = options.receiveShadow ?? true;
  mesh_pulmonary_return_system_5.userData.sculptComponent = {"id": "pulmonary-return-system", "name": "Four pulmonary vein returns", "level": "macro", "role": "vessel", "importance": 0.8, "confidence": 0.88, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "The single reference requires four pulmonary vein returns as a distinct, reviewable 3D structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[-0.4179, 0.8429, -0.55], [-1.0679, 0.8571, -0.3], [-1.3357, 0.9286, -0.02]], "radius": 0.1, "radialSegments": 12, "closed": false}}, "parent": "atrial-complex", "attachment": {"parentId": "atrial-complex", "parentSocket": "atrial-complex-surface", "localStart": [-0.4179, 0.8429, -0.55], "localEnd": [-1.3357, 0.9286, -0.02], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]}, "dimensions": {"width": 2.5, "height": 0.8, "depth": 0.7, "units": "relative-heart-height", "confidence": 0.88}, "transform": {"position": [0.0, 0.75, -0.45], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "pulmonary-return-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pulmonary-return-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "arterial", "materialLayers": ["arterial"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "four-return-mouths", "kind": "hole", "description": "Four red pulmonary-vein stubs are visible, two per side, rooted behind the atria.", "evidenceRefs": ["reference"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Reference-observed front surface; rear/depth continuation is inferred where occluded."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 70, 69, 1.0)", "secondaryAlbedo": "rgba(151, 38, 49, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(151, 38, 49, 1.0)"}, {"position": 1.0, "color": "rgba(211, 70, 69, 1.0)"}]}, "evidenceRefs": ["reference"], "note": "Visible region sampled conceptually from reference.png; highlights remain lighting response."}, "evidenceRefs": ["reference"], "details": [], "fidelityTier": "hero"};
  node_pulmonary_return_system_5.add(mesh_pulmonary_return_system_5);
  meshes["pulmonary-return-system"] = mesh_pulmonary_return_system_5;
  colliders["pulmonary-return-system"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["pulmonary-return-system"] ??= [];
  destructionGroups["pulmonary-return-system"].push(node_pulmonary_return_system_5);
  const socket_pulmonary_return_system_pulmonary_return_system_surface_0 = new THREE.Object3D();
  socket_pulmonary_return_system_pulmonary_return_system_surface_0.name = "pulmonary-return-system-surface";
  socket_pulmonary_return_system_pulmonary_return_system_surface_0.position.set(0.0, 0.0, 0.0);
  socket_pulmonary_return_system_pulmonary_return_system_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_pulmonary_return_system_pulmonary_return_system_surface_0.userData.socket = {"id": "pulmonary-return-system-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_pulmonary_return_system_5.add(socket_pulmonary_return_system_pulmonary_return_system_surface_0);
  sockets["pulmonary-return-system:pulmonary-return-system-surface"] = socket_pulmonary_return_system_pulmonary_return_system_surface_0;

  const attachment_coronary_network_6 = {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.29, 0.65, 0.87], "localEnd": [0.71, -1.89, 0.28], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]};
  const endpoint_coronary_network_6 = makeAttachmentEndpoint(attachment_coronary_network_6);
  const node_coronary_network_6 = new THREE.Group();
  node_coronary_network_6.name = "Surface-attached coronary network__pivot";
  node_coronary_network_6.scale.set(1, 1, 1);
  if (endpoint_coronary_network_6) {
    node_coronary_network_6.position.copy(endpoint_coronary_network_6.start);
    node_coronary_network_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_coronary_network_6.position.set(0.1, -0.3, 0.8);
    node_coronary_network_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_coronary_network_6.userData.sculptComponent = {"id": "coronary-network", "name": "Surface-attached coronary network", "level": "macro", "role": "vessel", "importance": 0.8, "confidence": 0.91, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "The single reference requires surface-attached coronary network as a distinct, reviewable 3D structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.29, 0.65, 0.87], [0.43, 0.0, 0.93], [0.38, -0.72, 0.78], [0.71, -1.89, 0.28]], "radius": 0.035, "radialSegments": 8, "closed": false}}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.29, 0.65, 0.87], "localEnd": [0.71, -1.89, 0.28], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]}, "dimensions": {"width": 2.3, "height": 2.5, "depth": 1.5, "units": "relative-heart-height", "confidence": 0.91}, "transform": {"position": [0.1, -0.3, 0.8], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "coronary-network-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coronary-network", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "coronary-vein", "materialLayers": ["coronary-vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "surface-attachment", "kind": "ridge", "description": "All primary and tapering coronary paths remain embedded against myocardium/fat grooves.", "evidenceRefs": ["reference"]}, {"id": "tapered-terminations", "kind": "contour", "description": "Every branch tapers into the surface or joins a trunk; no hard cut-off tips.", "evidenceRefs": ["reference"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Reference-observed front surface; rear/depth continuation is inferred where occluded."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 28, 68, 1.0)", "secondaryAlbedo": "rgba(47, 15, 44, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(47, 15, 44, 1.0)"}, {"position": 1.0, "color": "rgba(84, 28, 68, 1.0)"}]}, "evidenceRefs": ["reference"], "note": "Visible region sampled conceptually from reference.png; highlights remain lighting response."}, "evidenceRefs": ["reference"], "details": [], "fidelityTier": "hero"};
  node_coronary_network_6.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "coronary-network-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coronary-network", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["ventricular-body"] ?? root).add(node_coronary_network_6);
  nodes["coronary-network"] = node_coronary_network_6;
  const mesh_coronary_network_6Geometry = endpoint_coronary_network_6
    ? new THREE.CylinderGeometry(endpoint_coronary_network_6.endRadius, endpoint_coronary_network_6.baseRadius, endpoint_coronary_network_6.length, 32, 12)
    : buildTubeGeometry({"points": [[0.29, 0.65, 0.87], [0.43, 0.0, 0.93], [0.38, -0.72, 0.78], [0.71, -1.89, 0.28]], "radius": 0.035, "radialSegments": 8, "closed": false});
  if (!endpoint_coronary_network_6) {
    mesh_coronary_network_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_coronary_network_6 = new THREE.Mesh(
    mesh_coronary_network_6Geometry,
    materialMap["coronary-vein"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coronary_network_6.name = "Surface-attached coronary network";
  if (endpoint_coronary_network_6) {
    mesh_coronary_network_6.position.copy(endpoint_coronary_network_6.midpoint);
    mesh_coronary_network_6.quaternion.copy(endpoint_coronary_network_6.quaternion);
  }
  mesh_coronary_network_6.castShadow = options.castShadow ?? true;
  mesh_coronary_network_6.receiveShadow = options.receiveShadow ?? true;
  mesh_coronary_network_6.userData.sculptComponent = {"id": "coronary-network", "name": "Surface-attached coronary network", "level": "macro", "role": "vessel", "importance": 0.8, "confidence": 0.91, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "The single reference requires surface-attached coronary network as a distinct, reviewable 3D structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "tubePath": {"points": [[0.29, 0.65, 0.87], [0.43, 0.0, 0.93], [0.38, -0.72, 0.78], [0.71, -1.89, 0.28]], "radius": 0.035, "radialSegments": 8, "closed": false}}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.29, 0.65, 0.87], "localEnd": [0.71, -1.89, 0.28], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]}, "dimensions": {"width": 2.3, "height": 2.5, "depth": 1.5, "units": "relative-heart-height", "confidence": 0.91}, "transform": {"position": [0.1, -0.3, 0.8], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "coronary-network-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coronary-network", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "coronary-vein", "materialLayers": ["coronary-vein"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "surface-attachment", "kind": "ridge", "description": "All primary and tapering coronary paths remain embedded against myocardium/fat grooves.", "evidenceRefs": ["reference"]}, {"id": "tapered-terminations", "kind": "contour", "description": "Every branch tapers into the surface or joins a trunk; no hard cut-off tips.", "evidenceRefs": ["reference"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Reference-observed front surface; rear/depth continuation is inferred where occluded."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 28, 68, 1.0)", "secondaryAlbedo": "rgba(47, 15, 44, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(47, 15, 44, 1.0)"}, {"position": 1.0, "color": "rgba(84, 28, 68, 1.0)"}]}, "evidenceRefs": ["reference"], "note": "Visible region sampled conceptually from reference.png; highlights remain lighting response."}, "evidenceRefs": ["reference"], "details": [], "fidelityTier": "hero"};
  node_coronary_network_6.add(mesh_coronary_network_6);
  meshes["coronary-network"] = mesh_coronary_network_6;
  colliders["coronary-network"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["coronary-network"] ??= [];
  destructionGroups["coronary-network"].push(node_coronary_network_6);
  const socket_coronary_network_coronary_network_surface_0 = new THREE.Object3D();
  socket_coronary_network_coronary_network_surface_0.name = "coronary-network-surface";
  socket_coronary_network_coronary_network_surface_0.position.set(0.0, 0.0, 0.0);
  socket_coronary_network_coronary_network_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_coronary_network_coronary_network_surface_0.userData.socket = {"id": "coronary-network-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_coronary_network_6.add(socket_coronary_network_coronary_network_surface_0);
  sockets["coronary-network:coronary-network-surface"] = socket_coronary_network_coronary_network_surface_0;

  const endpoint_epicardial_fat_7 = makeAttachmentEndpoint(null);
  const node_epicardial_fat_7 = new THREE.Group();
  node_epicardial_fat_7.name = "Groove-following epicardial fat__pivot";
  node_epicardial_fat_7.scale.set(1, 1, 1);
  if (endpoint_epicardial_fat_7) {
    node_epicardial_fat_7.position.copy(endpoint_epicardial_fat_7.start);
    node_epicardial_fat_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_epicardial_fat_7.position.set(0.1, -0.15, 0.7);
    node_epicardial_fat_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_epicardial_fat_7.userData.sculptComponent = {"id": "epicardial-fat", "name": "Groove-following epicardial fat", "level": "macro", "role": "fat-pad", "importance": 0.8, "confidence": 0.94, "primitive": "instanced-cluster", "topologyClass": "continuous-sculpt", "topologyRationale": "The single reference requires groove-following epicardial fat as a distinct, reviewable 3D structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "baseGeometry": "ellipsoid"}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.1, -0.15, 0.7], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]}, "dimensions": {"width": 2.0, "height": 2.3, "depth": 1.4, "units": "relative-heart-height", "confidence": 0.94}, "transform": {"position": [0.1, -0.15, 0.7], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "epicardial-fat-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "epicardial-fat", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "epicardial-fat", "materialLayers": ["epicardial-fat"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "groove-following-lobules", "kind": "ridge", "description": "Gold fat forms irregular attached lobules along AV, anterior interventricular, and right-coronary grooves; no upper cap.", "evidenceRefs": ["reference"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Reference-observed front surface; rear/depth continuation is inferred where occluded."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 159, 144, 1.0)", "secondaryAlbedo": "rgba(220, 124, 120, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(220, 124, 120, 1.0)"}, {"position": 1.0, "color": "rgba(238, 159, 144, 1.0)"}]}, "evidenceRefs": ["reference"], "note": "Visible region sampled conceptually from reference.png; highlights remain lighting response."}, "evidenceRefs": ["reference"], "details": [], "fidelityTier": "hero"};
  node_epicardial_fat_7.userData.actionProfile = {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "epicardial-fat-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "epicardial-fat", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}};
  (nodes["ventricular-body"] ?? root).add(node_epicardial_fat_7);
  nodes["epicardial-fat"] = node_epicardial_fat_7;
  const mesh_epicardial_fat_7Geometry = endpoint_epicardial_fat_7
    ? new THREE.CylinderGeometry(endpoint_epicardial_fat_7.endRadius, endpoint_epicardial_fat_7.baseRadius, endpoint_epicardial_fat_7.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_epicardial_fat_7) {
    mesh_epicardial_fat_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_epicardial_fat_7 = new THREE.Mesh(
    mesh_epicardial_fat_7Geometry,
    materialMap["epicardial-fat"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_epicardial_fat_7.name = "Groove-following epicardial fat";
  if (endpoint_epicardial_fat_7) {
    mesh_epicardial_fat_7.position.copy(endpoint_epicardial_fat_7.midpoint);
    mesh_epicardial_fat_7.quaternion.copy(endpoint_epicardial_fat_7.quaternion);
  }
  mesh_epicardial_fat_7.castShadow = options.castShadow ?? true;
  mesh_epicardial_fat_7.receiveShadow = options.receiveShadow ?? true;
  mesh_epicardial_fat_7.userData.sculptComponent = {"id": "epicardial-fat", "name": "Groove-following epicardial fat", "level": "macro", "role": "fat-pad", "importance": 0.8, "confidence": 0.94, "primitive": "instanced-cluster", "topologyClass": "continuous-sculpt", "topologyRationale": "The single reference requires groove-following epicardial fat as a distinct, reviewable 3D structure.", "geometryDescriptor": {"topologyIntent": "continuous reference-shaped procedural surface", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "recomputed smooth vertex normals", "baseGeometry": "ellipsoid"}, "parent": "ventricular-body", "attachment": {"parentId": "ventricular-body", "parentSocket": "ventricular-body-surface", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.1, -0.15, 0.7], "contactType": "embed-overlap", "embedDepth": 0.045, "overlap": 0.03, "gapTolerance": 0.012, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["reference"]}, "dimensions": {"width": 2.0, "height": 2.3, "depth": 1.4, "units": "relative-heart-height", "confidence": 0.94}, "transform": {"position": [0.1, -0.15, 0.7], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "semantic-part", "pivot": {"mode": "component-root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "epicardial-fat-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "epicardial-fat", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "myocardium"}}, "material": "epicardial-fat", "materialLayers": ["epicardial-fat"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "groove-following-lobules", "kind": "ridge", "description": "Gold fat forms irregular attached lobules along AV, anterior interventricular, and right-coronary grooves; no upper cap.", "evidenceRefs": ["reference"]}], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.006, "normalPattern": "bounded low-frequency organic tissue relief", "displacementPattern": "macro volume only; no high-frequency noise", "occlusionPattern": "contact and groove cavities", "edgeWearPattern": "none; living-tissue teaching model", "notes": "Reference-observed front surface; rear/depth continuation is inferred where occluded."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 159, 144, 1.0)", "secondaryAlbedo": "rgba(220, 124, 120, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "axis": "y", "stops": [{"position": 0.0, "color": "rgba(220, 124, 120, 1.0)"}, {"position": 1.0, "color": "rgba(238, 159, 144, 1.0)"}]}, "evidenceRefs": ["reference"], "note": "Visible region sampled conceptually from reference.png; highlights remain lighting response."}, "evidenceRefs": ["reference"], "details": [], "fidelityTier": "hero"};
  node_epicardial_fat_7.add(mesh_epicardial_fat_7);
  meshes["epicardial-fat"] = mesh_epicardial_fat_7;
  colliders["epicardial-fat"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["epicardial-fat"] ??= [];
  destructionGroups["epicardial-fat"].push(node_epicardial_fat_7);
  const socket_epicardial_fat_epicardial_fat_surface_0 = new THREE.Object3D();
  socket_epicardial_fat_epicardial_fat_surface_0.name = "epicardial-fat-surface";
  socket_epicardial_fat_epicardial_fat_surface_0.position.set(0.0, 0.0, 0.0);
  socket_epicardial_fat_epicardial_fat_surface_0.rotation.set(0.0, 0.0, 0.0);
  socket_epicardial_fat_epicardial_fat_surface_0.userData.socket = {"id": "epicardial-fat-surface", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_epicardial_fat_7.add(socket_epicardial_fat_epicardial_fat_surface_0);
  sockets["epicardial-fat:epicardial-fat-surface"] = socket_epicardial_fat_epicardial_fat_surface_0;

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createHeartReferenceRetryLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Heart Reference Retry look-dev lights";
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
  lights.userData.lightingFromPhoto = ["large soft neutral key from upper-left/front", "weak neutral frontal fill", "white viewer background", "soft broad highlights with ACES tone mapping", "subtle contact shadow beneath overlapping vessels and fat; no cast-ground geometry in returned group"];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createHeartReferenceRetryEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameHeartReferenceRetryCamera(
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
export function createHeartReferenceRetryPresentationComposer(
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

export function configureHeartReferenceRetryRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createHeartReferenceRetryInspectControls(
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
