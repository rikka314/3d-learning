import * as THREE from 'three';
import { MEASURED_REGIONS, REFERENCE_SAMPLER } from './measuredMaterials';

/**
 * Material library — generated entirely in code.
 *
 * No image is loaded and no asset is imported. Every map below is drawn into a canvas at build
 * time from a seeded generator, so the whole surface is diffable TypeScript and a rebuild is
 * byte-identical.
 *
 * The engine constraints are transcribed from `grimoire/build/threejs_skin_and_cloth_materials.md`,
 * which cites `three@0.169.0` source rather than the docs site, and are encoded as executable
 * helpers rather than left as comments — a comment cannot stop the next edit from authoring a value
 * the renderer ignores.
 */

/** `clearcoatRoughness` is clamped up to this in `lights_physical_fragment.glsl.js:72`. Authoring
 *  anything below it renders identically to authoring the clamp, so a smaller value is not a finer
 *  setting — it is a value that does not exist. */
export const CLEARCOAT_ROUGHNESS_FLOOR = 0.0525;

/** `meshphysical.glsl.js:205` scales the diffuse base by `1 - 0.157 * max3(sheenColor)` before the
 *  sheen lobe is added back, so switching sheen on darkens a garment by a predictable amount. */
export const SHEEN_ENERGY_COMP_COEFF = 0.157;

export function usableClearcoatRoughness(requested: number): number {
  return Math.max(requested, CLEARCOAT_ROUGHNESS_FLOOR);
}

/**
 * Compensate a base colour for the darkening sheen is about to apply.
 *
 * A garment colour matched to the reference and THEN given sheen renders darker at every
 * non-grazing angle. The coefficient is fixed, so the correction is arithmetic rather than taste,
 * and a region still dark by roughly `0.157 x strength` afterwards is a different fault.
 */
export function compensateForSheen(hex: number, sheen: number, sheenColor: number): THREE.Color {
  const tint = new THREE.Color(sheenColor);
  const darkening = SHEEN_ENERGY_COMP_COEFF * sheen * Math.max(tint.r, tint.g, tint.b);
  const base = new THREE.Color(hex);
  base.convertSRGBToLinear();
  base.multiplyScalar(1 / (1 - darkening));
  base.convertLinearToSRGB();
  return base;
}

/**
 * Take a region's MEASURED hue from the reference and re-light it to a usable value.
 *
 * The reference's diffuse map is near-black in every region except skin -- its corset measures
 * luminance 7 where the plate photographs 142 -- so the value cannot be used, but the HUE can: the
 * skirt leather is measurably cool (blue above red) and the pouch leather measurably warm, and that
 * difference is real evidence rather than a styling choice.
 *
 * `targetLuminance` is UNCALIBRATED and declared as such. It is set from the relative ordering the
 * reference plate shows -- corset above skin above skirt above glove -- not from a solve, because
 * the plate records photographed radiance and using it as albedo would double-count the light.
 */
function measuredHueAtLuminance(region: string, targetLuminance: number): THREE.Color {
  const spec = MEASURED_REGIONS[region];
  const color = new THREE.Color();
  if (!spec) {
    return color.setRGB(
      targetLuminance / 255, targetLuminance / 255, targetLuminance / 255, THREE.SRGBColorSpace,
    );
  }
  const [r, g, b] = spec.albedoSRGB;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Below this the measured channels are within PNG quantisation of each other and the "hue" is
  // noise, so fall back to neutral rather than amplify a rounding error into a colour cast.
  if (luminance < 3) {
    return color.setRGB(
      targetLuminance / 255, targetLuminance / 255, targetLuminance / 255, THREE.SRGBColorSpace,
    );
  }
  const scale = targetLuminance / luminance;

  // CHROMA IS TRUSTED IN PROPORTION TO SIGNAL.
  //
  // Scaling a near-black measurement preserves its channel RATIO, and at these levels that ratio is
  // mostly quantisation. The pouch leather measures (21, 9, 6): the 12- and 3-level gaps between
  // channels are within PNG rounding, but multiplying by 6.9 to reach a usable value turns them
  // into 83- and 21-level gaps and the pouch renders vivid orange. So chroma is faded toward
  // neutral by how little signal the source had. The 5..35 window is UNCALIBRATED and declared:
  // below 5 the channels are indistinguishable, by 35 the hue is carrying real information.
  const chromaTrust = Math.max(0, Math.min(1, (luminance - 5) / 30));
  const grey = (r + g + b) / 3;
  const cr = grey + (r - grey) * chromaTrust;
  const cg = grey + (g - grey) * chromaTrust;
  const cb = grey + (b - grey) * chromaTrust;

  // THREE.SRGBColorSpace is REQUIRED here. `Color.setRGB` interprets its arguments in the working
  // colour space, which is linear-sRGB by default, so handing it sRGB values silently treats them
  // as linear and the result renders far too bright — it turned the black skirt leather nearly
  // white. `new THREE.Color(0xRRGGBB)` does the conversion; setRGB does not unless told.
  return color.setRGB(
    Math.min(1, (cr * scale) / 255),
    Math.min(1, (cg * scale) / 255),
    Math.min(1, (cb * scale) / 255),
    THREE.SRGBColorSpace,
  );
}

/** Apply the reference's own sampler settings to a generated texture. Generic so it hands back the
 *  concrete texture type it was given rather than widening it to Texture. */
function applyReferenceSampler<T extends THREE.Texture>(texture: T): T {
  texture.magFilter = REFERENCE_SAMPLER.magFilter === 9729 ? THREE.LinearFilter : THREE.NearestFilter;
  texture.minFilter = REFERENCE_SAMPLER.minFilter === 9987
    ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
}

/** Seeded LCG. Deterministic, so two builds produce identical textures and a render diff is a
 *  model diff rather than a noise diff. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function newCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return { canvas, ctx: canvas.getContext('2d')! };
}

/** Convert a height field to a tangent-space normal map. Wraps at the edges so the result tiles. */
function heightToNormalTexture(
  height: Float32Array,
  size: number,
  strength: number,
  repeat: number,
): THREE.CanvasTexture {
  const { canvas, ctx } = newCanvas(size);
  const image = ctx.createImageData(size, size);
  const px = image.data;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const xp = height[y * size + ((x + 1) % size)];
      const xm = height[y * size + ((x - 1 + size) % size)];
      const yp = height[((y + 1) % size) * size + x];
      const ym = height[((y - 1 + size) % size) * size + x];
      const nx = (xm - xp) * strength;
      const ny = (ym - yp) * strength;
      const len = Math.hypot(nx, ny, 1);
      const o = (y * size + x) * 4;
      px[o] = ((nx / len) * 0.5 + 0.5) * 255;
      px[o + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      px[o + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      px[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // A normal map is data, not colour — tagging it sRGB would gamma-decode the vectors.
  texture.colorSpace = THREE.NoColorSpace;
  texture.repeat.set(repeat, repeat);
  return applyReferenceSampler(texture);
}

function makeLeatherNormal(
  size: number, cells: number, seed: number, repeat: number,
): THREE.CanvasTexture {
  return heightToNormalTexture(leatherField(size, cells, seed), size, 2.2, repeat);
}

function makeSkinNormal(size: number, seed: number, repeat: number): THREE.CanvasTexture {
  return heightToNormalTexture(skinField(size, seed), size, 0.9, repeat);
}

/**
 * A matched trio of maps from ONE detail field.
 *
 * WHY MATCHED. The reference drives every one of its 31 materials with a colour map, a
 * metallic-roughness map AND a normal map; this model had a normal map on 21 parts, a colour map on
 * one, and a roughness map on NONE. That is most of the gap between "reads as a real material" and
 * "reads as smooth plastic", and none of it is geometry -- which is the point, because the geometry
 * is already at the limit of what its representation can express.
 *
 * They come from a single field because a real surface's properties are not independent: a raised
 * thread catches more light AND scuffs differently from the valley beside it. Generating three
 * unrelated noises would read as three unrelated grains laid over each other.
 *
 * TWO ENGINE FACTS THIS HAS TO RESPECT, both of which silently ruin the measured look otherwise:
 *
 *   `map` MULTIPLIES `color`, and it is decoded from sRGB. A map averaging 0.8 linear darkens the
 *   part by 20%, which would throw away the albedo work that took the corset from luminance 7 to a
 *   measured 142. So the linear mean is computed here and the base colour is divided by it.
 *
 *   `roughnessMap` MULTIPLIES `roughness`, and only its GREEN channel is read. Same compensation:
 *   the green mean is measured and the base roughness divided by it, so the average stays where it
 *   was fitted and only the variation is new.
 */
interface SurfaceDetail {
  readonly roughnessMap: THREE.CanvasTexture;
  readonly map: THREE.CanvasTexture;
  readonly normalMap: THREE.CanvasTexture;
  /** Mean of the colour map in LINEAR space, for compensating `color`. */
  readonly albedoMean: number;
  /** Mean of the roughness map's green channel, for compensating `roughness`. */
  readonly roughnessMean: number;
}

/** sRGB transfer function. The colour map is sampled as sRGB, so it must be written encoded. */
function encodeSRGB(linear: number): number {
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
}

function makeSurfaceDetail(
  field: Float32Array, size: number, repeat: number,
  options: { normalStrength: number; roughSpread: number; albedoContrast: number },
): SurfaceDetail {
  const { normalStrength, roughSpread, albedoContrast } = options;

  const roughCanvas = newCanvas(size);
  const albedoCanvas = newCanvas(size);
  const roughImage = roughCanvas.ctx.createImageData(size, size);
  const albedoImage = albedoCanvas.ctx.createImageData(size, size);
  let albedoSum = 0;
  let roughSum = 0;

  for (let i = 0; i < size * size; i += 1) {
    const h = field[i];
    // Roughness rides the field: crests polish, valleys hold dust. Kept off zero because a perfectly
    // smooth microfacet term produces a mirror highlight no fabric has.
    const rough = Math.min(1, Math.max(0.06, 1 - roughSpread * (h - 0.5) * 2));
    roughSum += rough;
    const o = i * 4;
    const r8 = Math.round(rough * 255);
    roughImage.data[o] = r8;
    roughImage.data[o + 1] = r8;
    roughImage.data[o + 2] = r8;
    roughImage.data[o + 3] = 255;

    // Albedo only ever darkens — a multiply map cannot brighten — so the variation hangs below 1 and
    // the base colour is scaled back up by the mean.
    const linear = 1 - albedoContrast * (1 - h);
    albedoSum += linear;
    const encoded = Math.round(encodeSRGB(linear) * 255);
    albedoImage.data[o] = encoded;
    albedoImage.data[o + 1] = encoded;
    albedoImage.data[o + 2] = encoded;
    albedoImage.data[o + 3] = 255;
  }
  roughCanvas.ctx.putImageData(roughImage, 0, 0);
  albedoCanvas.ctx.putImageData(albedoImage, 0, 0);

  const finish = <T extends THREE.Texture>(texture: T, colorSpace: string): T => {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = colorSpace as THREE.ColorSpace;
    texture.repeat.set(repeat, repeat);
    return applyReferenceSampler(texture);
  };

  return {
    roughnessMap: finish(new THREE.CanvasTexture(roughCanvas.canvas), THREE.NoColorSpace),
    map: finish(new THREE.CanvasTexture(albedoCanvas.canvas), THREE.SRGBColorSpace),
    normalMap: heightToNormalTexture(field, size, normalStrength, repeat),
    albedoMean: albedoSum / (size * size),
    roughnessMean: roughSum / (size * size),
  };
}

/**
 * Attach a detail trio to a material and undo the two multiplications it introduces.
 *
 * Done in one call rather than three assignments at each call site, because forgetting either
 * compensation is invisible in code review and obvious only as a part that has quietly gone dark or
 * gone matte.
 */
/**
 * Linear mean of a material's colour map, remembered when it was attached.
 *
 * Needed because setting a NEW base colour later has to divide by the same mean `dress` divided by,
 * or the map's darkening is applied twice and the part lands below the albedo that was measured.
 */
const ALBEDO_MEANS = new WeakMap<THREE.Material, number>();
function albedoMeanOf(material: THREE.Material): number {
  return ALBEDO_MEANS.get(material) ?? 1;
}

function dress(
  material: THREE.MeshPhysicalMaterial, detail: SurfaceDetail, normalScale: number,
): THREE.MeshPhysicalMaterial {
  material.map = detail.map;
  material.roughnessMap = detail.roughnessMap;
  material.normalMap = detail.normalMap;
  material.normalScale = new THREE.Vector2(normalScale, normalScale);
  material.color.multiplyScalar(1 / detail.albedoMean);
  material.roughness = Math.min(1, material.roughness / detail.roughnessMean);
  ALBEDO_MEANS.set(material, detail.albedoMean);
  material.needsUpdate = true;
  return material;
}

/**
 * Woven cloth.
 *
 * The corset's weave is legible at a 100% crop of the reference, so it is evidence rather than
 * decoration — and it is a REPEATING structure, exactly the class a formula reproduces well.
 *
 * `repeat` is the whole difference between cloth and a chessboard: the corset's UV runs 0..1 over
 * roughly 0.94 m of circumference, so at repeat 1 each drawn thread is ~10 mm and the interlace
 * reads as tiling squares.
 */
function makeWeaveTexture(
  size: number, warp: string, weft: string, seed: number, repeat: number,
): THREE.CanvasTexture {
  const { canvas, ctx } = newCanvas(size);
  const rng = makeRng(seed);
  ctx.fillStyle = warp;
  ctx.fillRect(0, 0, size, size);

  const pitch = Math.max(2, Math.round(size / 90));
  ctx.fillStyle = weft;
  for (let y = 0; y < size; y += pitch * 2) {
    for (let x = 0; x < size; x += pitch * 2) {
      // Offset alternate rows so the interlace reads as a weave rather than a grid.
      const shift = ((y / (pitch * 2)) % 2) * pitch;
      ctx.fillRect((x + shift) % size, y, pitch, pitch);
      ctx.fillRect((x + shift + pitch) % size, y + pitch, pitch, pitch);
    }
  }

  // Per-thread luminance jitter. A perfectly regular weave reads as printed fabric, and without it
  // the surface moires against the pixel grid.
  const image = ctx.getImageData(0, 0, size, size);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const jitter = (rng() - 0.5) * 26;
    px[i] = Math.max(0, Math.min(255, px[i] + jitter));
    px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + jitter));
    px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + jitter));
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.repeat.set(repeat, repeat * 0.75);
  return applyReferenceSampler(texture);
}

/**
 * Leather grain.
 *
 * Leather's identity at this distance is its crease network, not its colour. Creases form an
 * irregular cellular pattern — polygonal cells separated by darker valleys — so a plain noise field
 * reads as sandpaper. This builds the cell structure explicitly with a two-nearest-site distance,
 * whose difference is small exactly along a cell boundary.
 */
/** Worley cell field — the grain under leather, and the ridge pattern under a scabbard's lacquer. */
function leatherField(size: number, cells: number, seed: number): Float32Array {
  const rng = makeRng(seed);
  const sites: Array<[number, number]> = [];
  for (let i = 0; i < cells; i += 1) sites.push([rng() * size, rng() * size]);

  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let d1 = Infinity;
      let d2 = Infinity;
      for (const [sx, sy] of sites) {
        // Wrap the distance so the texture tiles without a visible seam.
        let dx = Math.abs(x - sx);
        let dy = Math.abs(y - sy);
        if (dx > size / 2) dx = size - dx;
        if (dy > size / 2) dy = size - dy;
        const d = dx * dx + dy * dy;
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
      }
      height[y * size + x] = Math.min(1, ((Math.sqrt(d2) - Math.sqrt(d1)) / (size / cells)) * 1.6);
    }
  }
  return height;
}

/**
 * Skin micro-detail: a fine pore field over a slower dermal undulation.
 *
 * Two octaves, because one gives either pores without form or form without pores. The reference
 * shows both — a fine pore texture, and a broader variation across the deltoid and clavicle.
 */
/** Two octaves of value noise: pores over the coarser dermal undulation beneath them. */
function skinField(size: number, seed: number): Float32Array {
  const rng = makeRng(seed);
  const octave = (cells: number): Float32Array => {
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i += 1) grid[i] = rng();
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const fx = (x / size) * cells;
        const fy = (y / size) * cells;
        const x0 = Math.floor(fx) % cells;
        const y0 = Math.floor(fy) % cells;
        const x1 = (x0 + 1) % cells;
        const y1 = (y0 + 1) % cells;
        const tx = fx - Math.floor(fx);
        const ty = fy - Math.floor(fy);
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const a = grid[y0 * cells + x0] * (1 - sx) + grid[y0 * cells + x1] * sx;
        const b = grid[y1 * cells + x0] * (1 - sx) + grid[y1 * cells + x1] * sx;
        out[y * size + x] = a * (1 - sy) + b * sy;
      }
    }
    return out;
  };
  const pores = octave(Math.max(4, Math.round(size / 4)));
  const dermal = octave(12);
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i += 1) height[i] = pores[i] * 0.7 + dermal[i] * 0.3;
  return height;
}

/**
 * Anisotropic field: fine lines running in one direction over a slower cross-modulation.
 *
 * Hair strands, brushed steel and a blade's polish all read as directional, and a directionless
 * noise cannot produce that however it is tuned.
 */
function strandField(size: number, seed: number, frequency: number, waviness: number): Float32Array {
  const rng = makeRng(seed);
  const phases = new Float32Array(size);
  for (let i = 0; i < size; i += 1) phases[i] = rng();
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const drift = Math.sin((y / size) * Math.PI * 2 * waviness) * size * 0.03;
      const u = (x + drift + size) % size;
      const strand = Math.sin((u / size) * Math.PI * 2 * frequency) * 0.5 + 0.5;
      // Per-line jitter so the strands are not a perfect comb.
      const jitter = phases[Math.floor(u) % size];
      height[y * size + x] = Math.min(1, strand * 0.75 + jitter * 0.25);
    }
  }
  return height;
}

export interface SubsurfaceOptions {
  wrap: number;
  scatterColor: THREE.Color;
  curvatureBoost: number;
}

/**
 * Wrap a material's diffuse response with a subsurface scattering approximation.
 *
 * Lambert drives diffuse to zero the moment a surface turns from the light. Skin does not: light
 * entering near the terminator scatters under the surface and leaves further around, so the
 * terminator is soft and reddens. This shifts the response by a wrap factor and tints ONLY the part
 * the wrap added, leaving the lit side's own albedo alone. The curvature term reads screen-space
 * normal derivatives, so convex detail — deltoid cap, nose bridge, clavicle head — scatters more.
 *
 * It is NOT multilayer subsurface scattering and NOT a diffusion profile. The brief offered
 * `transmission + thickness + attenuationColor` as an alternative; that is ruled out by the material
 * reference section 3 — `transmission` is a screen-space refraction model, so on a closed opaque
 * body it renders a glassy figure rather than flesh.
 */
export function applySubsurfaceScattering(
  material: THREE.MeshPhysicalMaterial,
  options: SubsurfaceOptions,
): void {
  material.userData.subsurface = options;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSssWrap = { value: options.wrap };
    shader.uniforms.uSssColor = { value: options.scatterColor };
    shader.uniforms.uSssCurvature = { value: options.curvatureBoost };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uSssWrap;
uniform vec3 uSssColor;
uniform float uSssCurvature;`)
      .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
{
  vec3 sssDNx = dFdx( normal );
  vec3 sssDNy = dFdy( normal );
  float sssCurvature = clamp( ( length( sssDNx ) + length( sssDNy ) ) * 12.0, 0.0, 1.0 );
  float sssAmount = uSssWrap * ( 1.0 + sssCurvature * uSssCurvature );
  #if ( NUM_DIR_LIGHTS > 0 )
    // Declared ONCE, outside the loop, and only assigned inside it. three's unroll_loop_start
    // pragma emits the body N times WITHOUT wrapping each copy in its own scope, so declaring
    // inside the loop compiles as N declarations of one name: 'sssL : redefinition'.
    vec3 sssL;
    float sssNdl;
    float sssWrapped;
    float sssAdded;
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
      sssL = normalize( directionalLights[ i ].direction );
      sssNdl = dot( normal, sssL );
      sssWrapped = max( 0.0, ( sssNdl + sssAmount ) / ( 1.0 + sssAmount ) );
      sssAdded = max( 0.0, sssWrapped - max( 0.0, sssNdl ) );
      reflectedLight.directDiffuse += sssAdded * directionalLights[ i ].color * uSssColor
        * BRDF_Lambert( material.diffuseColor );
    }
    #pragma unroll_loop_end
  #endif
}`);
  };
  // Without a distinct key three shares one compiled program with any other physical material
  // carrying the same defines, and whichever compiled first wins.
  material.customProgramCacheKey = () => `gc3-sss-${options.wrap}-${options.curvatureBoost}`;
}

export interface MaterialSet {
  skin: THREE.MeshPhysicalMaterial;
  /** the skin material with vertexColors enabled, for the torso's painted inner top */
  skinPainted: THREE.MeshPhysicalMaterial;
  eyeWhite: THREE.MeshPhysicalMaterial;
  eyeIris: THREE.MeshPhysicalMaterial;
  lips: THREE.MeshPhysicalMaterial;
  brow: THREE.MeshPhysicalMaterial;
  corsetWeave: THREE.MeshPhysicalMaterial;
  innerTop: THREE.MeshPhysicalMaterial;
  leatherDark: THREE.MeshPhysicalMaterial;
  leatherTan: THREE.MeshPhysicalMaterial;
  steelPolished: THREE.MeshPhysicalMaterial;
  steelBlade: THREE.MeshPhysicalMaterial;
  hair: THREE.MeshPhysicalMaterial;
  scabbardWood: THREE.MeshPhysicalMaterial;
  embroiderySilver: THREE.MeshPhysicalMaterial;
  dispose(): void;
}

export function createGirlCharacter3Materials(options: { textureSize?: number } = {}): MaterialSet {
  const size = options.textureSize ?? 512;
  const owned: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    owned.push(item);
    return item;
  };

  // ---- skin ---------------------------------------------------------------------------------
  // Pores are sub-millimetre and the torso's UV spans most of a metre, so the pore field needs a
  // high repeat or it reads as a lumpy dermal wobble rather than as skin.
  // 0x877465 is MEASURED, not chosen: it is the median of the reference's diffuse texture sampled
  // over the UV footprint of its bare-skin meshes (nodes 1, 18, 19), whose p10-p90 spread is a tight
  // 93-138 / 71-108 / 66-92. The reference's roughness and metalness channels were NOT adopted —
  // its packed map reports 88% mid-grey metalness, which no real metalness map looks like, so that
  // channel is an AO or cavity pass mislabelled by the exporter rather than a parameter.
  const skin = track(new THREE.MeshPhysicalMaterial({
    // The one region whose measurement is directly usable: physically sensible and tightly
    // clustered (p10-p90 of 93-138 / 71-108 / 66-92). Read from the data, not transcribed.
    color: new THREE.Color().setRGB(
      MEASURED_REGIONS.skin.albedoSRGB[0] / 255,
      MEASURED_REGIONS.skin.albedoSRGB[1] / 255,
      MEASURED_REGIONS.skin.albedoSRGB[2] / 255,
      THREE.SRGBColorSpace,
    ),
    roughness: 0.5,
    metalness: 0,
    clearcoat: 0.2,
    clearcoatRoughness: usableClearcoatRoughness(0.38),
    ior: 1.4,
    normalMap: track(makeSkinNormal(size, 0x5C13, 14)),
    normalScale: new THREE.Vector2(0.26, 0.26),
  }));
  applySubsurfaceScattering(skin, {
    wrap: 0.4,
    scatterColor: new THREE.Color(0x8C2B1E),
    curvatureBoost: 0.85,
  });

  const eyeWhite = track(new THREE.MeshPhysicalMaterial({
    color: 0xF2EDE9, roughness: 0.24, metalness: 0, clearcoat: 0.7,
    clearcoatRoughness: usableClearcoatRoughness(0.08), ior: 1.38,
  }));
  const eyeIris = track(new THREE.MeshPhysicalMaterial({
    color: 0x3A2416, roughness: 0.16, metalness: 0, clearcoat: 0.9,
    clearcoatRoughness: usableClearcoatRoughness(0.06), ior: 1.42,
  }));
  const lips = track(new THREE.MeshPhysicalMaterial({
    color: 0xB4685E, roughness: 0.36, metalness: 0, clearcoat: 0.3,
    clearcoatRoughness: usableClearcoatRoughness(0.25), ior: 1.4,
  }));
  const brow = track(new THREE.MeshPhysicalMaterial({
    color: 0x2A1B14, roughness: 0.7, metalness: 0,
  }));

  // ---- cloth --------------------------------------------------------------------------------
  // Sheen carries the woven cue, so sheenColor MUST be set: three defaults it to black and the term
  // is a multiply, which would make the sheen strength contribute exactly nothing. The base colour
  // is then compensated for the darkening that same sheen applies.
  const corsetSheen = 0.55;
  const corsetSheenColor = 0xFFF6E8;
  const corsetWeave = track(new THREE.MeshPhysicalMaterial({
    color: compensateForSheen(0xE9E6DE, corsetSheen, corsetSheenColor),
    map: track(makeWeaveTexture(size, '#E9E6DE', '#D8D3C7', 0x51CB, 8)),
    roughness: 0.86,
    metalness: 0,
    sheen: corsetSheen,
    sheenColor: new THREE.Color(corsetSheenColor),
    // Cotton and linen sit at the broad end of the Charlie width. A narrow rim on a garment this
    // size concentrates onto a few facets and reads as plastic.
    sheenRoughness: 0.82,
    ior: 1.5,
    side: THREE.DoubleSide,
    shadowSide: THREE.FrontSide,
  }));

  const innerSheen = 0.35;
  const innerSheenColor = 0x6B5F58;
  const innerTop = track(new THREE.MeshPhysicalMaterial({
    color: compensateForSheen(0x2E2723, innerSheen, innerSheenColor),
    roughness: 0.92,
    metalness: 0,
    sheen: innerSheen,
    sheenColor: new THREE.Color(innerSheenColor),
    sheenRoughness: 0.9,
    ior: 1.5,
    // The neckline is an open boundary; culled backfaces would show a hole there.
    side: THREE.DoubleSide,
    shadowSide: THREE.FrontSide,
  }));

  // ---- leather ------------------------------------------------------------------------------
  // Two identities, measured rather than tinted: the skirt and glove leather is a cold near-black,
  // the pouches are distinctly warmer and lighter. Treating the second as a tint of the first is
  // what makes a pouch read as part of the skirt.
  const leatherDark = track(new THREE.MeshPhysicalMaterial({
    color: measuredHueAtLuminance('skirt', 32),
    roughness: 0.6,
    metalness: 0,
    clearcoat: 0.3,
    clearcoatRoughness: usableClearcoatRoughness(0.42),
    normalMap: track(makeLeatherNormal(size, 220, 0x1EA7, 7)),
    normalScale: new THREE.Vector2(0.7, 0.7),
    ior: 1.45,
    side: THREE.DoubleSide,
    shadowSide: THREE.FrontSide,
  }));

  const leatherTan = track(new THREE.MeshPhysicalMaterial({
    color: measuredHueAtLuminance('pouches', 62),
    roughness: 0.66,
    metalness: 0,
    clearcoat: 0.22,
    clearcoatRoughness: usableClearcoatRoughness(0.45),
    normalMap: track(makeLeatherNormal(size, 150, 0x2FB8, 3)),
    normalScale: new THREE.Vector2(0.6, 0.6),
    ior: 1.45,
  }));

  // ---- metal --------------------------------------------------------------------------------
  const steelPolished = track(new THREE.MeshPhysicalMaterial({
    color: 0xBFC3C7, roughness: 0.22, metalness: 1, envMapIntensity: 1.25,
  }));
  // The blade shows lengthwise streaking, which is anisotropy along the blade axis rather than a
  // lower roughness.
  const steelBlade = track(new THREE.MeshPhysicalMaterial({
    color: 0xC9CDD2, roughness: 0.18, metalness: 1,
    anisotropy: 0.65, anisotropyRotation: Math.PI / 2, envMapIntensity: 1.4,
  }));
  const embroiderySilver = track(new THREE.MeshPhysicalMaterial({
    color: 0xB9B4A6, roughness: 0.38, metalness: 0.85, envMapIntensity: 1.1,
  }));

  // ---- hair ---------------------------------------------------------------------------------
  // The `hair.human.code-only` profile: no maps, sheen plus anisotropy plus a root-to-tip gradient
  // carried on vertex colour. Vertex colours are off by default and materials are shared by id, so
  // the flag is set on a material this demo owns outright.
  // sheenRoughness 0.72, NOT the 0.28 a satin would take.
  //
  // 0.28 is the narrow-rim end of the Charlie distribution, and on a faceted low-poly shell a narrow
  // rim lands on a handful of facets and reads as white plastic plates rather than as hair — which
  // is exactly the failure the material reference warns about. The strand impression on a shell has
  // to come from the broad sheen band plus the root-to-tip gradient, not from a tight highlight.
  const hairSheen = 0.45;
  const hairSheenColor = 0x6A4A38;
  const hair = track(new THREE.MeshPhysicalMaterial({
    color: compensateForSheen(0x2B1D16, hairSheen, hairSheenColor),
    roughness: 0.42,
    metalness: 0,
    sheen: hairSheen,
    sheenColor: new THREE.Color(hairSheenColor),
    sheenRoughness: 0.72,
    anisotropy: 0.35,
    envMapIntensity: 0.45,
    vertexColors: true,
    ior: 1.55,
    side: THREE.DoubleSide,
    shadowSide: THREE.FrontSide,
  }));

  const scabbardWood = track(new THREE.MeshPhysicalMaterial({
    color: 0x3A3128, roughness: 0.74, metalness: 0,
    clearcoat: 0.12, clearcoatRoughness: usableClearcoatRoughness(0.5), ior: 1.5,
  }));

  // A clone, not the same material with the flag flipped: materials are shared by id here, and
  // enabling vertexColors on the shared skin would tint the head and shoulders too.
  // ---- surface detail on EVERY material ------------------------------------------------------
  //
  // The reference drives all 31 of its materials with colour, metallic-roughness AND normal maps.
  // This model had a normal map on 21 parts, a colour map on one, and a roughness map on none, so
  // every surface reflected uniformly and read as smooth plastic no matter what the geometry did.
  // Uniform roughness is the giveaway: a real surface's highlight breaks up because its microfacet
  // distribution varies across it, and nothing in a constant term can produce that.
  //
  // `dress` compensates the two multiplications three.js applies, so the albedo and roughness that
  // were fitted against the reference survive and only the VARIATION is added.
  const detailSize = Math.max(128, Math.round(size / 2));
  const detail = (
    field: Float32Array, repeat: number,
    normalStrength: number, roughSpread: number, albedoContrast: number,
  ): SurfaceDetail => {
    const made = makeSurfaceDetail(field, detailSize, repeat,
      { normalStrength, roughSpread, albedoContrast });
    track(made.map);
    track(made.roughnessMap);
    track(made.normalMap);
    return made;
  };

  // Skin: pores are shallow and barely tint, but their roughness break is what stops a face reading
  // as a mannequin. Contrast stays low because subsurface scattering already supplies the colour
  // variation and doubling it turns the skin blotchy.
  dress(skin, detail(skinField(detailSize, 0x5C13), 14, 0.9, 0.30, 0.06), 0.26);

  // Cloth: the weave is a repeating structure, so the field is the weave itself rather than noise.
  dress(corsetWeave, detail(leatherField(detailSize, 520, 0x51CB), 9, 1.4, 0.34, 0.10), 0.42);
  dress(innerTop, detail(leatherField(detailSize, 400, 0x7A31), 7, 1.2, 0.30, 0.09), 0.35);

  // Leather: the deepest roughness break of anything here — a scuffed hide is matte in the valleys
  // and burnished on the ridges, and that contrast is most of what says "leather" rather than
  // "dark plastic".
  dress(leatherDark, detail(leatherField(detailSize, 220, 0x1EA7), 7, 2.2, 0.46, 0.16), 0.70);
  dress(leatherTan, detail(leatherField(detailSize, 150, 0x2FB8), 3, 2.2, 0.44, 0.18), 0.60);
  dress(scabbardWood, detail(strandField(detailSize, 0x3C0D, 26, 1.4), 4, 1.6, 0.36, 0.20), 0.45);

  // Metal: anisotropic, because a blade is ground along its length and a buckle is brushed. The
  // albedo contrast is near zero — metal's colour does not vary, its REFLECTION does, which is the
  // roughness map's job.
  dress(steelPolished, detail(strandField(detailSize, 0x5EE1, 40, 0.6), 6, 0.7, 0.26, 0.03), 0.22);
  dress(steelBlade, detail(strandField(detailSize, 0x81AD, 64, 0.35), 10, 0.5, 0.20, 0.02), 0.16);
  dress(embroiderySilver, detail(strandField(detailSize, 0x9C4B, 30, 0.9), 8, 0.9, 0.30, 0.05), 0.30);

  // Hair: strands along the fall of the ponytail. The reference's striation comes from its normal
  // map too — on a surface this dark, roughness variation alone is invisible, because there is
  // almost no diffuse energy left for it to modulate.
  dress(hair, detail(strandField(detailSize, 0x4A17, 54, 1.1), 5, 1.5, 0.34, 0.12), 0.55);

  // ---- match what the GLB DECLARES ------------------------------------------------------------
  //
  // Three flags were chosen by eye here and the reference states all three. Measured against it:
  // doubleSided 17/31 against its 31/31, clearcoat on 23 parts against its 0, sheen on 2 against
  // its 0. The clearcoat and sheen are inventions — a lacquer and a fabric bloom this asset does not
  // have — and they cost more than they look: sheen darkens the base by 0.157 x strength and
  // clearcoat adds a second specular lobe over everything, so every colour fitted underneath them
  // was fitted to compensate for a layer that should not be there.
  //
  // The girl-character build made exactly this change and recorded the same reasoning: "ALL declared
  // GLB material params applied; sheen/clearcoat/saturation-boost removed."
  // ---- roughness, as the reference MEASURES it ------------------------------------------------
  //
  // Every region of the reference sits between 0.95 and 1.0, sampled from its own
  // metallic-roughness texture over each region's UV footprint. This model had chosen 0.16 to 0.92 by
  // material family — a polished blade at 0.18, an iris at 0.16 — which is a reasonable set of
  // guesses about what those materials would be and simply not what this asset is. A near-fully-rough
  // figure has almost no mirror lobe anywhere, and the specular highlights that were standing in for
  // "metal" and "lacquer" here belong to neither the reference nor, now, to this.
  //
  // Metalness is deliberately NOT copied with it. The same texture reports 0.63-0.84 on leather,
  // cloth and hair, which no dielectric has; that channel in this asset is carrying an occlusion or
  // cavity pass rather than metalness, and applying it would paint the coat as painted steel. It is
  // measured and rejected rather than ignored — see MEASURED_ROUGHNESS below.
  const MEASURED_ROUGHNESS: Record<string, number> = {
    skin: 0.974, corset: 0.997, skirt: 0.990, belts: 0.990, gloves: 0.990,
    boots: 1.0, pouches: 1.0, hair: 1.0, hardware: 0.998, scabbards: 0.963, weapons: 0.953,
  };
  const roughnessOf = (region: string): number => MEASURED_ROUGHNESS[region] ?? 0.99;
  for (const [material, region] of [
    [skin, 'skin'], [lips, 'skin'], [brow, 'skin'], [eyeWhite, 'skin'], [eyeIris, 'skin'],
    [corsetWeave, 'corset'], [innerTop, 'corset'],
    [leatherDark, 'skirt'], [leatherTan, 'pouches'],
    [steelPolished, 'hardware'], [embroiderySilver, 'hardware'], [steelBlade, 'weapons'],
    [hair, 'hair'], [scabbardWood, 'scabbards'],
  ] as ReadonlyArray<readonly [THREE.MeshPhysicalMaterial, string]>) {
    material.roughness = roughnessOf(region);
  }

  // ---- albedo, as the reference MEASURES it ---------------------------------------------------
  //
  // THIS REVERSES AN EARLIER DECISION, ON THE USER'S INSTRUCTION. The colours here were fitted to the
  // PHOTOGRAPH because the reference's own diffuse texture is close to black — corset albedo
  // luminance 7 against the photograph's 142 — and matching it looked like copying a rendering
  // artefact. Measured against the baseline render, that left this model 7x too bright on the corset
  // and 23x on the hardware.
  //
  // The instruction is to copy the asset, and the asset is dark. The girl-character build reached its
  // best scores at exactly this step. So the measured albedo is applied, and the reason the model now
  // looks much darker than its own reference photograph is that the GLB is much darker than the
  // photograph.
  const MEASURED_ALBEDO: Record<string, number> = {
    skin: 0x5C4F45, corset: 0x070708, skirt: 0x090A0B, belts: 0x151314, gloves: 0x0D0D0E,
    boots: 0x020303, pouches: 0x150906, hair: 0x060708, hardware: 0x0F100F,
    scabbards: 0x161816, weapons: 0x181A1A,
  };
  // METALNESS COMES WITH THE ALBEDO OR NOT AT ALL, for the metals.
  //
  // A metal has no diffuse term: its albedo IS its specular colour. Setting the reference's near-black
  // albedo on a material still at metalness 1 does not darken it, it EXTINGUISHES it — measured, the
  // hardware went to luminance 0.4 against the reference's 8.9, and the swords to 5.5 against 16.8.
  // The reference's own metallic-roughness texture reads 0.78 and 0.81 there, so those parts are not
  // full metal in this asset either, and taking its albedo without its metalness copies half a
  // measurement.
  //
  // Elsewhere that channel reports 0.63-0.84 on leather, cloth and hair, which no dielectric has — it
  // is carrying an occlusion pass, not metalness — so it is applied ONLY where the material is
  // actually a metal and rejected everywhere else.
  // APPLIED EVERYWHERE, not just to the metals, and the reasoning changed on measurement.
  //
  // The first read was that 0.63-0.84 on leather, cloth and hair is physically impossible and that the
  // channel must be carrying an occlusion pass, so it was rejected outside the metals. That is
  // probably still true about what the channel MEANS — but it is what the reference RENDERS with, and
  // it is most of why the reference is so dark: a near-black albedo at metalness 0.7 has almost no
  // diffuse left. Measured with it applied only to metals, the skirt sat 7.6x brighter than the
  // baseline, the boots 6.3x and the hair 5.6x.
  //
  // The instruction is to copy the asset, so the asset's numbers are used rather than the ones that
  // would be correct for real leather.
  const MEASURED_METALNESS: Record<string, number> = {
    skin: 0.348, corset: 0.630, skirt: 0.699, belts: 0.707, gloves: 0.649,
    boots: 0.653, pouches: 0.0, hair: 0.686, hardware: 0.781, scabbards: 0.844, weapons: 0.812,
  };

  for (const [material, region] of [
    [skin, 'skin'], [lips, 'skin'], [brow, 'skin'],
    [corsetWeave, 'corset'], [innerTop, 'corset'],
    // leatherDark dresses the gloves and boots as well as the coat. Their measured albedos are
    // 0x0D0D0E, 0x020303 and 0x090A0B — within a few units of each other on a near-black asset — so
    // one material carrying the coat's figure is a fair reading of all three rather than a
    // compromise, and splitting it would add two materials to express a difference of six units.
    [leatherDark, 'skirt'], [leatherTan, 'pouches'],
    [steelPolished, 'hardware'], [embroiderySilver, 'hardware'], [steelBlade, 'weapons'],
    [hair, 'hair'], [scabbardWood, 'scabbards'],
  ] as ReadonlyArray<readonly [THREE.MeshPhysicalMaterial, string]>) {
    const hex = MEASURED_ALBEDO[region];
    if (hex === undefined) continue;
    const metal = MEASURED_METALNESS[region];
    if (metal !== undefined) material.metalness = metal;
    // The detail maps multiply this, and their mean was divided out of the old colour when they were
    // attached; setting a fresh colour has to re-apply that or the part lands darker than measured.
    const compensation = material.map ? 1 / albedoMeanOf(material) : 1;
    material.color.setHex(hex).multiplyScalar(compensation);
  }

  // `owned` holds textures as well as materials — everything disposable — so this filters rather
  // than assuming.
  for (const item of owned) {
    const material = item as Partial<THREE.MeshPhysicalMaterial>;
    if (!(material as THREE.Material).isMaterial) continue;
    material.side = THREE.DoubleSide;
    material.clearcoat = 0;
    material.sheen = 0;
    (material as THREE.Material).needsUpdate = true;
  }

  const skinPainted = track(skin.clone());
  skinPainted.vertexColors = true;
  applySubsurfaceScattering(skinPainted, {
    wrap: 0.4, scatterColor: new THREE.Color(0x8C2B1E), curvatureBoost: 0.85,
  });

  return {
    skin, skinPainted, eyeWhite, eyeIris, lips, brow,
    corsetWeave, innerTop, leatherDark, leatherTan,
    steelPolished, steelBlade, hair, scabbardWood, embroiderySilver,
    dispose() {
      for (const item of owned) item.dispose();
    },
  };
}
