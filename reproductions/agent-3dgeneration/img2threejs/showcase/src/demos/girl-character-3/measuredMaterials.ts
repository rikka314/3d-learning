/**
 * Every parameter the reference GLB actually declares, measured and transcribed.
 *
 * WHAT THE ASSET DECLARES: almost nothing. All 31 of its materials omit `baseColorFactor`,
 * `metallicFactor` and `roughnessFactor` entirely, so each one sits on the glTF defaults -- white,
 * metallic 1.0, roughness 1.0 -- multiplied by a texture. All 32 of its nodes carry an identity
 * transform. There is no scalar to copy: the parameters ARE the texture pixels.
 *
 * So they were measured. For each mesh, the UVs its own vertices occupy were looked up in the
 * diffuse and metallic-roughness images, and reduced per region below, vertex-count weighted.
 * No image is copied and nothing is imported -- this is a reading taken OF the reference, like the
 * cross-section rings.
 *
 * WHY MOST OF IT IS NOT APPLIED, stated so the omission is a decision and not an oversight:
 *
 *  - `metalness` is not a metalness map. A real one is near-binary; this one is 88% mid-grey
 *    (only 6% of pixels below 0.1 and 6% above 0.9), which is the signature of an ambient-
 *    occlusion or cavity pass packed into the blue channel by the exporter. Applying it makes
 *    leather, cloth and skin all 65% metal, which is exactly why an earlier build of this demo
 *    rendered crushed to black and had to be rescued with fill light.
 *  - `roughness` is 0.99-1.00 for every region including the polished blades, which is the same
 *    channel problem seen from the other side.
 *  - `albedo` is near-black everywhere. Measured against the reference PLATE, the corset reads
 *    #908D8D (luminance 142) in the photograph but #070708 (luminance 7) in the texture -- a
 *    factor of 20. The visible colour of this asset does not come from its diffuse map.
 *
 * WHAT IS APPLIED: the skin albedo, which is the one region whose measurement is both
 * physically sensible and tightly clustered (p10-p90 of 93-138 / 71-108 / 66-92); the two
 * distinct leather HUES, cool for skirt and glove versus warm for the pouches; `doubleSided`,
 * which every material declares; and the sampler filters.
 *
 * Extracted by scripts/extract-measured-materials.py -- regenerate rather than hand-edit.
 */

export interface MeasuredRegionSpec {
  /** reference node indices this region was aggregated from */
  nodes: number[];
  /** vertices the aggregate is weighted by -- a thin sample is visible rather than trusted */
  verts: number;
  /** median diffuse-texture colour over the region's own UV footprint, sRGB 0-255 */
  albedoSRGB: [number, number, number];
  albedoHex: string;
  /** G channel of the packed map. Not applied: see the file header. */
  roughness: number;
  /** B channel of the packed map. NOT a metalness map: see the file header. */
  metalness: number;
}

export const MEASURED_REGIONS: Record<string, MeasuredRegionSpec> = {
  belts: {
    nodes: [4, 7],
    verts: 111197,
    albedoSRGB: [20.9, 18.8, 19.5],
    albedoHex: '#151314',
    roughness: 0.99,
    metalness: 0.707,
  },
  boots: {
    nodes: [13, 15],
    verts: 84628,
    albedoSRGB: [2.0, 3.0, 3.0],
    albedoHex: '#020303',
    roughness: 1.0,
    metalness: 0.653,
  },
  corset: {
    nodes: [2, 3, 8],
    verts: 160269,
    albedoSRGB: [6.8, 7.0, 7.9],
    albedoHex: '#070708',
    roughness: 0.9965,
    metalness: 0.6297,
  },
  gloves: {
    nodes: [12, 14, 21, 22, 28, 30],
    verts: 118640,
    albedoSRGB: [13.1, 13.4, 13.6],
    albedoHex: '#0D0D0E',
    roughness: 0.9895,
    metalness: 0.6494,
  },
  hair: {
    nodes: [26],
    verts: 29716,
    albedoSRGB: [6.0, 7.0, 8.0],
    albedoHex: '#060708',
    roughness: 1.0,
    metalness: 0.6863,
  },
  hardware: {
    nodes: [9, 10],
    verts: 29602,
    albedoSRGB: [14.6, 15.6, 15.0],
    albedoHex: '#0F100F',
    roughness: 0.998,
    metalness: 0.7808,
  },
  pouches: {
    nodes: [16, 17],
    verts: 40029,
    albedoSRGB: [21.4, 9.4, 6.5],
    albedoHex: '#150906',
    roughness: 1.0,
    metalness: 0.0,
  },
  scabbards: {
    nodes: [23, 24],
    verts: 49839,
    albedoSRGB: [21.5, 23.5, 22.0],
    albedoHex: '#161816',
    roughness: 0.9626,
    metalness: 0.8435,
  },
  skin: {
    nodes: [1, 18, 19, 20],
    verts: 177727,
    albedoSRGB: [92.2, 79.0, 69.4],
    albedoHex: '#5C4F45',
    roughness: 0.974,
    metalness: 0.3481,
  },
  skirt: {
    nodes: [0, 5, 6, 11, 29],
    verts: 323442,
    albedoSRGB: [9.1, 9.7, 10.9],
    albedoHex: '#090A0B',
    roughness: 0.9904,
    metalness: 0.6994,
  },
  weapons: {
    nodes: [25, 27],
    verts: 76829,
    albedoSRGB: [24.0, 26.5, 26.0],
    albedoHex: '#181A1A',
    roughness: 0.9529,
    metalness: 0.8118,
  },
};

/**
 * Appearance measured off reference plate `ed-pantera-11`, for the regions whose GLB albedo is
 * unusable. These are PHOTOGRAPHED luminances, so they carry that plate's lighting and are used
 * only for their relative ordering -- corset brighter than skin brighter than skirt brighter than
 * glove -- never as albedo directly, which would double-count the light.
 */
export const PLATE_APPEARANCE: Record<string, { hex: string; luminance: number }> = {
  corset: { hex: '#908D8D', luminance: 141.6 },
  skin: { hex: '#736F6C', luminance: 111.6 },
  skirt: { hex: '#3E3D3F', luminance: 61.4 },
  gloves: { hex: '#20201E', luminance: 31.9 },
};

/** Every material in the reference declares `doubleSided: true`. */
export const REFERENCE_DOUBLE_SIDED = true;

/** The reference ships one sampler: magFilter LINEAR (9729), minFilter LINEAR_MIPMAP_LINEAR
 *  (9987). Applied to the canvas textures this demo generates. */
export const REFERENCE_SAMPLER = { magFilter: 9729, minFilter: 9987 } as const;
