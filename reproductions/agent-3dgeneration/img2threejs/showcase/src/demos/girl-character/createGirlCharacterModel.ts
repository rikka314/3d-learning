import * as THREE from 'three';

import { decodeSurfaces, type DecodedSurface, type EncodedNode } from './surfaceCodec';
import { buildWalkRig, captureRest, poseAttachments, poseIdle, poseWalk, type RestPose, type WalkRig }
  from './walkRig';
import { FIGURE_BOUNDS } from './measuredAnchors';
import {
 BOOTS_SECTIONS, CANISTER_SECTIONS, GLOVES_SECTIONS, HAIR_SECTIONS,
  KATANA_SECTIONS, KNEE_PADS_SECTIONS, OVERALLS_SECTIONS, POUCHES_SECTIONS, SKIN_SECTIONS,
 type CrossSections, type Ring,
} from './crossSections';
import { STUDS, type Stud } from './hardware';

/** Region id to its stacked cross-sections. Keys are render-profile region ids. */
const CROSS_SECTIONS: Record<string, CrossSections> = {
  'boots': BOOTS_SECTIONS,
  'canister': CANISTER_SECTIONS,
  'gloves': GLOVES_SECTIONS,
  'hair': HAIR_SECTIONS,
  'katana': KATANA_SECTIONS,
  'knee-pads': KNEE_PADS_SECTIONS,
  'overalls': OVERALLS_SECTIONS,
  'pouches': POUCHES_SECTIONS,
  'skin': SKIN_SECTIONS,
};

/**
 * All 8 pipeline passes complete. No longer a blockout: nothing here is a box.
 *
 * DIMENSIONS ARE FROZEN. Proportions were accepted at 9/10; nothing here may be resized or moved.
 * Detail work adds geometry on top of the existing forms. That also freezes the per-region IoU figures,
 * which are bounded by GLB-versus-photograph part offsets rather than by anything this code does.
 *
 * Each region is lofted from cross-sections read out of its baseline node's own point cloud, so the
 * solid is correct from every direction rather than from the one the reference was shot from. Colours
 * Material parameters come from the GLB itself -- see `GLB_MATERIAL` -- rather than from material
 * families chosen by hand, which is what this file used to do.
 *
 * Mesh names are render-profile region ids, so the semantic-ID pass and the review regions share one
 * vocabulary instead of needing a translation table that can drift.
 */

export type GirlCharacterOptions = {
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Render each mass as wireframe. Useful when reviewing placement rather than volume. */
  wireframe?: boolean;
};


/**
 * A procedural grain normal map, generated in code as a DataTexture.
 *
 * WHY. Colour is now measurably right -- median gains ~1.00 and matching hue -- and the knee pad still
 * reads as smooth grey plastic rather than leather. The reason is measurable too: local luma variation
 * in a 5x5 window is 1.75 in the render against 4.71 in the reference, a ratio of 0.37. That missing
 * variation is leather grain, and grain is millimetre-scale, far below what 40 slices x 32 spokes can
 * carry as geometry.
 *
 * This is AUTHORED, not copied. The baseline's own normal maps are off limits ("its topology/materials
 * are never copied into the factory", SKILL.md); a noise field generated here is code-only procedural
 * output like every other value in this file.
 *
 * Value noise over a few octaves, differenced into a tangent-space normal. Deterministic from `seed`,
 * so a rebuild produces the same surface and a review of one render stays valid for the next.
 */
/**
 * Part labels for the viewer's picker, keyed by the baseline node each strand came from.
 *
 * The scored REGION lives in `userData.region`; this is what a person reads when they click. One region
 * can hold several parts -- `knee-pads` is two pads, `boots` is two boots and two cuffs -- and naming
 * them all "knee-pads" left the picker listing identical entries it could not tell apart.
 */
const PART_LABEL: Record<number, string> = {
  0: 'trousers', 1: 'torso and arms', 2: 'boot cuff, character right',
  3: 'shin, character left', 4: 'boot cuff, character left', 5: 'belt pouch, character right',
  6: 'cage canister', 7: 'belt pouch, character left', 8: 'katana and sheath',
  9: 'head and hair', 10: 'knee pad, character right', 11: 'boot, character right',
  12: 'knee pad, character left', 13: 'boot, character left', 14: 'gloved hand, character left',
  15: 'shin, character right',
};

/** Module each baseline node belongs to, for the viewer's part list. */
const NODE_MODULE: Record<number, string> = {
  0: 'garment', 1: 'body', 2: 'footwear', 3: 'body', 4: 'footwear', 5: 'kit', 6: 'kit',
  7: 'kit', 8: 'weapon', 9: 'body', 10: 'armour', 11: 'footwear', 12: 'armour',
  13: 'footwear', 14: 'kit', 15: 'body',
};


/** Grain per family: repeat count and normal strength, both fitted against measured local variation. */
/**
 * Grain, cut back to almost nothing -- and the measurement that forced it reversed a whole day's
 * assumption.
 *
 * The premise behind this table was that the model looked too smooth and needed authored surface
 * detail. Measuring HIGH-FREQUENCY ENERGY -- mean |Laplacian| of luma inside each region's own mask --
 * says the opposite: against the shaded baseline this model runs 1.7x to 6.3x too NOISY, not too
 * smooth. The eye reads that noise as mush, which is why eighteen recorded runs of colour fitting
 * changed nothing anybody could see: medians were already close, and medians cannot see grain.
 *
 * Switching the normal maps off in the browser splits the excess cleanly. Grain is 45-74% of it on
 * every leather and fabric region (pouches 74%, overalls 66%, knee-pads 60%, boots 58%). Without it
 * those regions sit at 1.3-2.1x, and solving strength * (with - without) = baseline - without gives
 * ZERO for leather, skin and hair -- their geometry alone already exceeds the baseline's texture --
 * and about 0.19 for fabric against the 0.55 it had.
 *
 * `katana` and `canister` take 0% from grain because `metal` never had any. Their 3.4-3.5x is pure
 * geometric faceting from the loft, and no material setting touches it.
 */

/**
 * Per-region saturation boost, measured against the GLB baseline rendered through the same profile.
 *
 * Both references agree the procedural model is undersaturated -- the baseline's own render and the
 * photograph -- so this is the one correction that does not depend on which of them is the brightness
 * target. Measured ratios of baseline saturation over procedural: hair 2.27, canister 1.92, katana
 * 1.70, knee-pads 1.63, pouches 1.47, gloves 1.28, skin 1.26, overalls 1.12, boots 1.02.
 *
 * Applied to ALBEDO at constant luma, so the colour gains already fitted do not move: a median that
 * matched at 1.00 still matches, and only the distance from grey changes. A matched median is exactly
 * what cannot see desaturation, because it moves all three channels together.
 */


/**
 * THE BASELINE'S OWN MAPS, APPLIED DIRECTLY. OPT-IN, via `?atlas=1`.
 *
 * It was the default for a while and should not have been: sampling a foreign atlas through borrowed
 * UVs measures 10.14 mean detail energy against the baseline's 4.48, because 40.59% of ring-wise edges
 * jump islands and 21.2% of triangles straddle a cut in someone else's layout. The authored path --
 * the same GLB-declared albedo/roughness/metalness as flat scalars -- measures 4.76. It stays
 * reachable because the user authorised the comparison and it is the evidence for the colour fit.
 *
 * `SKILL.md` forbids putting the asset's textures into the factory, and every earlier pass respected
 * that -- the maps were measured for evidence and never used. The user lifted the rule explicitly, to
 * see what the result looks like when the asset's own base colour, metallic-roughness and normal maps
 * are applied, and to decide from that whether the rule should stand. Both paths remain switchable so
 * the two can be compared rather than argued about.
 *
 * The model's own UVs cannot address this atlas -- they are cylindrical, the atlas is a packed layout
 * of many islands -- so every ring point carries the baseline's TEXCOORD_0, transferred from its
 * nearest vertex by scripts/bake_atlas_uvs.py at a median distance of 1.0-2.6 mm.
 */
const USE_ATLAS = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('atlas') === '1';

/**
 * BAKED textures, addressed by this model's OWN continuous UVs. `?atlas=baked` selects them.
 *
 * Sampling the baseline's atlas through borrowed UVs puts a seam INSIDE a triangle whenever its
 * corners come from different islands, and that atlas is a fine patchwork: 40.59% of ring-wise edges
 * jump, 21.2% of triangles straddle, and four different repairs moved the result by under 3%. The
 * seam is not a bug in the repair, it is a cut in someone else's layout crossing this mesh.
 *
 * Baking moves the crossing to where it can be handled. scripts/bake_region_textures.py walks every
 * texel of a per-region map laid out for THIS mesh -- u is the spoke fraction, v packs the strands
 * into bands -- converts it to a world position, finds the nearest baseline vertex and reads its
 * atlas colour. The UVs below must reproduce that layout exactly; if the strand order or the band
 * arithmetic differs by one, every texture lands on the wrong part of the model.
 */
const USE_BAKED = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('atlas') === 'baked';

const BAKED_CACHE = new Map<string, THREE.MeshPhysicalMaterial>();
function bakedMaterial(region: string, wireframe: boolean): THREE.MeshPhysicalMaterial {
  const key = `${region}:${wireframe}`;
  const cached = BAKED_CACHE.get(key);
  if (cached) return cached;
  const loader = new THREE.TextureLoader();
  const stem = `${import.meta.env.BASE_URL}baked/${region.replace('-', '_')}`;
  const load = (suffix: string, srgb: boolean): THREE.Texture => {
    const texture = loader.load(`${stem}-${suffix}.png`);
    texture.flipY = false;
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.anisotropy = 8;
    return texture;
  };
  const mr = load('mr', false);
  const material = new THREE.MeshPhysicalMaterial({
    map: load('diffuse', true),
    roughnessMap: mr,
    metalnessMap: mr,
    normalMap: load('normal', false),
    color: 0xffffff,
    roughness: 1,
    metalness: 1,
    side: THREE.DoubleSide,
    wireframe,
  });
  BAKED_CACHE.set(key, material);
  return material;
}

let atlasMaterialCache: THREE.MeshPhysicalMaterial | null = null;
function atlasMaterial(wireframe: boolean): THREE.MeshPhysicalMaterial {
  if (atlasMaterialCache) return atlasMaterialCache;
  const loader = new THREE.TextureLoader();
  const base = `${import.meta.env.BASE_URL}baseline-textures/`;
  const load = (file: string, srgb: boolean): THREE.Texture => {
    const texture = loader.load(base + file);
    // glTF puts the UV origin at the top left; three flips textures vertically unless told not to.
    texture.flipY = false;
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.anisotropy = 8;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  };
  const mr = load('02-texture_metallic-texture_roughness.png', false);
  atlasMaterialCache = new THREE.MeshPhysicalMaterial({
    map: load('01-texture_diffuse.png', true),
    // glTF packs roughness in G and metalness in B, which is exactly how three reads a shared map.
    roughnessMap: mr,
    metalnessMap: mr,
    normalMap: load('00-texture_normal.png', false),
    // White at full roughness and metalness so the maps carry everything and nothing is scaled twice.
    color: 0xffffff,
    roughness: 1,
    metalness: 1,
    side: THREE.DoubleSide,
    wireframe,
  });
  return atlasMaterialCache;
}

const MATERIAL_CACHE = new Map<string, THREE.MeshPhysicalMaterial>();

function materialFor(region: string, wireframe: boolean): THREE.MeshPhysicalMaterial {
  const cacheKey = `${region}:${wireframe}`;
  const cached = MATERIAL_CACHE.get(cacheKey);
  if (cached) return cached;
  const material = buildMaterial(region, wireframe);
  MATERIAL_CACHE.set(cacheKey, material);
  return material;
}

/**
 * Every material parameter comes from the GLB, per REGION, because the GLB declares them all.
 *
 * WHAT THIS REPLACES, and why it was wrong. Roughness, metalness, sheen and clearcoat were chosen by
 * material FAMILY, by hand, and the albedos were fitted through a render loop -- while
 * `metallicRoughnessTexture` and `baseColorTexture` carried the real values the whole time and were
 * never opened. Measured per region from the asset's own maps (scripts/glb_material_params.py):
 *
 *   region      albedo    roughness  metalness      what was used before
 *   boots       0x190802      1.000      0.043      leather 0.88 / 0
 *   canister    0x160906      0.953      0.122      metal   0.42 / 0.55
 *   gloves      0x240e08      0.980      0.078      leather 0.88 / 0
 *   hair        0x67494d      0.922      0.000      hair    0.78 / 0
 *   katana      0x220d07      0.980      0.063      metal   0.42 / 0.55
 *   knee-pads   0x210a08      0.974      0.049      leather 0.88 / 0
 *   overalls    0x4b0d08      0.988      0.000      fabric  0.95 / 0
 *   pouches     0x630e0a      0.997      0.000      leather 0.88 / 0
 *   skin        0x855646      0.938      0.000      skin    0.82 / 0
 *
 * The whole character is almost fully rough (0.92-1.00) and almost entirely dielectric (0.00-0.12).
 * The katana and canister were being drawn at roughness 0.42 and metalness 0.55 -- twice as glossy and
 * nine times as metallic as the asset says -- and that explains a measurement that had no explanation:
 * those two regions carry 3.4-3.5x the baseline's high-frequency energy with 0% coming from grain,
 * because a metallic surface turns every fold of the loft into a specular glint.
 *
 * SHEEN AND CLEARCOAT ARE GONE. The GLB declares neither -- its materials hold exactly doubleSided,
 * normalTexture and pbrMetallicRoughness -- so both were inventions, and so was the saturation boost
 * that existed to correct for them.
 *
 * `doubleSided: true` on all 16 materials, which was also never checked; the meshes are FrontSide here
 * and a lofted shell shows its interior wherever a cap is missing.
 *
 * ROUGHNESS AND METALNESS BELOW ARE THE DECLARED VALUES. ALBEDO IS NOT -- it is FITTED, and saying so
 * matters because the point of this table was to stop inventing values.
 *
 * The declared baseColorFactor is only half of what the baseline draws: it renders factor MULTIPLIED
 * by baseColorTexture, and this path applies no texture. Using the bare factor left every region off
 * the baseline's rendered median -- skin by 1.13/1.33/1.36 per channel, overalls by 1.28 on red.
 *
 * The obvious correction, factor x the region's mean texel, WAS TESTED AND IS WRONG: it fails on 8/8
 * regions and fails in the opposite direction, since skin's measured gain rises across r,g,b
 * (1.13, 1.33, 1.36) while its texture mean falls (0.47, 0.32, 0.27). So there is no derivation here
 * to hide behind. Each albedo is fitted so this flat-scalar path RENDERS to the baseline's median,
 * measured through identical ID masks under an identical camera and rig, with the declared factor kept
 * in the trailing comment so the size of the fit stays visible.
 *
 * It is a fit, and a fit is weaker evidence than a copied parameter. It is used because it costs
 * nothing in surface noise -- a scalar cannot add high-frequency energy -- while `?atlas=1` and
 * `?atlas=baked` apply the asset's literal texels for anyone who wants them instead.
 */
const GLB_MATERIAL: Record<string, { albedo: number; roughness: number; metalness: number }> = {
  // albedo is FITTED, not declared -- see the note above. Declared factor in the trailing comment.
  boots: { albedo: 0x150702, roughness: 1.000, metalness: 0.043 },      // declared 0x190802
  canister: { albedo: 0x150907, roughness: 0.953, metalness: 0.122 },   // declared 0x160906
  gloves: { albedo: 0x27110a, roughness: 0.980, metalness: 0.078 },     // declared 0x240e08
  hair: { albedo: 0x70515a, roughness: 0.922, metalness: 0.000 },       // declared 0x67494d
  katana: { albedo: 0x210e08, roughness: 0.980, metalness: 0.063 },     // declared 0x220d07
  'knee-pads': { albedo: 0x170a08, roughness: 0.974, metalness: 0.049 },// declared 0x210a08
  overalls: { albedo: 0x600d09, roughness: 0.988, metalness: 0.000 },   // declared 0x4b0d08
  pouches: { albedo: 0x5b0e0a, roughness: 0.997, metalness: 0.000 },    // declared 0x630e0a
  skin: { albedo: 0x97725f, roughness: 0.938, metalness: 0.000 },       // declared 0x855646
};

/**
 * Sub-region materials: painted detail that lives INSIDE a region rather than beside it.
 *
 * These have no entry of their own in the GLB because they are not separate meshes -- the face, the
 * bra and the belt are texture on the head, the torso and the trousers. Their colours stay as measured
 * off the baseline render; their roughness and metalness are inherited from the region they sit on,
 * so nothing here is invented either.
 */
const SUB_REGION: Record<string, { albedo: number; host: string }> = {
  face: { albedo: 0xb08268, host: 'skin' },
  brow: { albedo: 0x5a4038, host: 'hair' },
  eye: { albedo: 0x2a2422, host: 'skin' },
  lip: { albedo: 0x8e4038, host: 'skin' },
  nose: { albedo: 0x8e6350, host: 'skin' },
  'sports-bra': { albedo: 0x131111, host: 'skin' },
  belt: { albedo: 0x230907, host: 'overalls' },
  'hardware-brass': { albedo: 0x462e26, host: 'knee-pads' },
  'hardware-iron': { albedo: 0x2d2725, host: 'knee-pads' },
};

function buildMaterial(region: string, wireframe: boolean): THREE.MeshPhysicalMaterial {
  const sub = SUB_REGION[region];
  const declared = GLB_MATERIAL[sub ? sub.host : region] ?? GLB_MATERIAL.skin;
  const albedo = sub ? sub.albedo : declared.albedo;

  const material = new THREE.MeshPhysicalMaterial({
    color: albedo,
    roughness: declared.roughness,
    metalness: declared.metalness,
    // Declared by all 16 materials in the asset, and never honoured here until now.
    side: THREE.DoubleSide,
    wireframe,
  });

  // NO PROCEDURAL GRAIN. It was applied to `fabric` at strength 0.19 and is now gone, on two grounds.
  //
  // MEASURED: switching every normal map off in the browser moves exactly one region -- overalls,
  // 3.18 -> 2.63, a 17% cut -- and every other region by 0.00. So the grain was buying nothing
  // anywhere else, and on overalls it was buying excess high-frequency energy against a baseline that
  // already sits lower at 3.53.
  //
  // DECLARED: the GLB carries a real normalTexture at scale 1.0 on all 16 materials and declares no
  // procedural anything -- extensionsUsed is empty. Inventing a noise field to stand in for it adds
  // detail the asset does not have, at a spatial frequency chosen by us rather than measured.
  return material;
}


/**
 * Loft a region's cross-sections into closed solids.
 *
 * Rings are chained into STRANDS by centroid proximity within a node, not by slice index, because a
 * slice can yield more than one ring: node 8's slices at hand height hold the gripping fist and the
 * scabbard as separate clusters, node 0's lower slices hold two trouser legs, node 1's hold each arm
 * apart from the torso. Chaining by index would connect a left leg to a right one; chaining by
 * proximity keeps each piece its own tube and is what stopped the katana blob covering 18611 pixels of
 * the belt pouches.
 *
 * Ends are closed with a fan to the ring's own centroid: `Material.side` is FrontSide, so an open end
 * renders as a hole straight through the part.
 */
/** Baseline node index carrying the head. Its region id stays `hair`; see the split in the loft. */
const HEAD_NODE = 9;

/**
 * The sports bra, as a band of the torso's own surface.
 *
 * MEASURED, NOT PLACED BY EYE. The GLB has no bra mesh -- `sports-bra` returns under 200 px in the
 * BASELINE's own semantic-ID pass, so there is nothing to loft. It is painted onto node 1's texture,
 * which shows up as dark desaturated pixels INSIDE the baseline's skin mask. Profiling that per row
 * gives an unambiguous band: 2% of skin pixels at pixel row 350, rising to 71% at 470-490, back to 2%
 * by row 570. Calibrating pixels to world off the head strand (1050 px per world unit, from its known
 * 1.5272..1.7472 extent) puts the band at world y 1.268..1.400. Median colour 0x110f0f at saturation
 * 0.000 -- black fabric, not shadow, which is what the desaturation test separates.
 *
 * A full ring is correct here rather than a front patch: it is a sports bra, a band right around the
 * chest. The straps above it are thin diagonals that a height band cannot express, and are omitted.
 */
// Lowered 14 mm from [1.268, 1.400] by measurement, not by eye: with the ID mask restricting the
// search to the figure, the bra's bottom edge at the centre column read world y 1.2772 on this model
// against 1.2632 on the baseline, and its top read 1.4451 against 1.4025.
const BRA_BAND: readonly [number, number] = [1.254, 1.386];
/**
 * The bra's measured half-width, APPLIED AS AN AZIMUTH rather than as a cut on world x.
 *
 * There used to be BRA_HALF_WIDTH 0.1381 about BRA_CENTRE_X 0.0709, derived by converting the
 * baseline's bra pixels to world through the head's known scale. The measurement was sound; the way it
 * was applied was not. Cutting on world x against a near-cylindrical torso runs the boundary almost
 * TANGENT to the surface at the sides, so one spoke of travel changes x by almost nothing and the edge
 * jumps many spokes at once -- the 15-20 px blocks down both sides of the garment.
 *
 * And 0.1381 m is close to the full half-circumference at that height anyway, so the test was only ever
 * clipping the two side extremes -- precisely where an x-cut is worst behaved. The strand it rides
 * carries the torso alone, the arms being separate strands, so the band can simply wrap.
 *
 * Dropping the limit entirely was tried and is wrong in the other direction: the band then wrapped up
 * over the shoulders, because the torso strand reaches that high. The measurement stays; only its
 * frame changes. Converted against the band's own mean radius it covers the same arc it always did,
 * and its edge now follows the lattice at about 1 px instead of jumping 15-20 px at the sides.
 *
 * The straps get the same treatment, so they hold the width they were measured at.
 */
const BRA_HALF_WIDTH = 0.1381;
/**
 * The shoulder straps, which is the whole of the bra's missing height.
 *
 * Measured against the baseline the band's WIDTH was already exact (-0.0019 world) while its height
 * was 0.0581 short, and running the baseline's bra mask row by row says where that went: from world y
 * 1.444 down to about 1.359 it is not one shape but TWO narrow runs, 10-25 px wide, which widen and
 * merge into the band at 1.349. Their centres sit at world x -0.042 and +0.173, i.e. +-0.107 either
 * side of the bra's own centre, and they hold that x while widening downward.
 *
 * A height band cannot produce them -- they are vertical, not horizontal -- so they are their own
 * test. They stop at the band's top; below that the band already covers the chest.
 */
const STRAP_OFFSET_X = 0.107;
const STRAP_HALF_WIDTH = 0.017;
const STRAP_TOP_Y = 1.462;
/**
 * How far the neckline dips at the FRONT, as a fraction of the band's height.
 *
 * A single height band is a tube top. The baseline's bra scoops: it rides high at the sides, where the
 * straps come over the shoulders, and drops at the centre front. Lowering the top edge for spokes
 * facing forward reproduces that without needing a second patch, and the sides keep the full height.
 */
// 0.24, and it was right all along. Four instruments were needed to establish that.
//
// The neckline could not be measured because the sports bra had no semantic id of its own: it is an
// index GROUP on the torso mesh, and the ID capture keys on userData.region, so it was painted with
// `skin`'s id and was invisible to every mask. `sports-bra` had an id colour in the render profile the
// whole time; the geometry never carried it. Meshes now declare `groupRegions` and the capture paints
// per group.
//
// Even with a real mask the first reading was wrong: taking the topmost bra pixel finds the STRAP,
// which rises to STRAP_TOP_Y 1.462 and does not depend on this constant at all. That is why three
// earlier probes returned a figure that never moved. Restricting to rows wider than half the garment's
// widest row excludes the straps and measures the band:
//
//     BRA_SCOOP   band top      error vs baseline
//     0.24         1.3839            +2.8 mm
//     0.423        1.3848            +3.7 mm
//
// A 76% change in the constant moves the band top by 0.9 mm, because the band begins below the scoop's
// deepest point. The original value is the better of the two and the quantity was never far off; what
// was broken was the ability to see it.
const BRA_SCOOP = 0.24;
/** Half-angle of the forward arc the scoop applies to. */
const BRA_SCOOP_ARC = 0.62;

/**
 * The belt, as a darker band of the trousers' own surface.
 *
 * The GLB has no belt mesh -- `belt` returns under 200 px in the BASELINE's own semantic-ID pass --
 * and it is not the `pouches` region either. Isolating nodes 5 and 7 settled that: they are the
 * trousers' hanging RED FLAPS, matching this model at 36520 vs 37531 px and 0x521013 vs 0x540f13.
 * They matched perfectly all along, which is exactly why a missing belt never showed up in any score.
 *
 * The belt is painted on the trousers, and it has to be separated from them by HUE, not brightness.
 * A luma profile looks convincing and is wrong: shadowed red cloth and brown leather sit at the same
 * value, so the trough it reports runs 0.854..1.025 -- half again too tall -- and painting that band
 * dark swallowed the whole hip. Red trousers run r/g about 4.4-7.4; the leather runs 1.6-2.0. By that
 * test the belt is unambiguous: the leather share is 0-30% above y800, then 67%, 98%, 100%, 97%, 90%,
 * 67%, 65% across y820-940, then back to 24% and 8%. That is world y 0.897..1.011.
 *
 * Colour, measured on the leather pixels alone rather than the whole band: 0x211311 at saturation
 * 0.480, against 0x1d1413 here -- already within 14%, which is why the band's HEIGHT was the defect
 * and its colour never was.
 */
const BELT_BAND: readonly [number, number] = [0.897, 1.011];
const TORSO_NODE = 1;

/**
 * The face, painted onto the head's own surface as material groups rather than built as props.
 *
 * WHY NOT GEOMETRY. The first attempt hung spheres and boxes off the head for eyes, brows, nose and
 * lips. Every one of them intersected the surface it was supposed to sit on: the head is convex, so a
 * wide ellipsoid placed at the front-most point and sunk by a constant buries its middle and leaves
 * its two ends poking out -- the mouth rendered as two separate red blobs. Sizing around that means
 * fighting the curvature at every feature.
 *
 * A material group cannot have that problem. The triangles are already exactly on the surface, so a
 * feature is just a decision about which ones to paint. It also costs no geometry at all: the head
 * stays one mesh with one vertex buffer, the part list does not gain nine entries for one face, and
 * the scored region stays `hair` so IoU, area and centroid are untouched.
 *
 * WHAT IS BEING APPROXIMATED, stated plainly: the baseline draws its face with a base-colour and a
 * normal map, and `SKILL.md` puts those off limits. Flat painted patches recover the placement and
 * the colour of a face, not its relief. It reads as a face at figure scale and as paint up close.
 *
 * Extents are in (depth-from-crown, azimuth). CENTRES are measured off the baseline's own head at
 * 271 x 231 px -- eyes 0.501, mouth 0.664-0.704, brows 0.383-0.392, nose 0.537 -- and the rendered
 * result agrees with the baseline's to 0.003 and 0.009. The HALF-EXTENTS are deliberately smaller
 * than the blob measurement reported, because those blobs swallowed the socket and lip shadow around
 * each feature: taken literally they drew eyes and a mouth half the face across.
 */
type FacePatch = {
  readonly material: string;
  /** Centre and half-extent as a fraction of head height, measured down from the crown. */
  readonly fromTop: readonly [number, number];
  /** Centre and half-extent in radians about the head's forward axis; mirrored when `pair`. */
  readonly azimuth: readonly [number, number];
  readonly pair?: boolean;
};

const FACE_PATCHES: readonly FacePatch[] = [
  { material: 'face', fromTop: [0.700, 0.360], azimuth: [0, 0.840] },
  // Order matters: later patches win, so the nose is laid before the eyes and the eyes before the
  // mouth, and nothing overwrites a feature that sits inside another.
  //
  // The nose is a SHADOW, not a shape. It cannot be relief here -- the head is a smooth loft and the
  // baseline keeps its nose in a normal map -- so what is reproduced is the darker column the
  // baseline renders down the centre of the face: measured at fromTop 0.537 +-0.078, luma about 12
  // below the cheek's 118.
  { material: 'nose', fromTop: [0.560, 0.055], azimuth: [0, 0.075] },
  // Brow height is measured (0.383 and 0.392 either side); its azimuth is NOT. The dark-pixel test
  // that found the height also caught the hair beside the face and reported +-0.637 and +0.845, which
  // is outside the face oval's own +-0.651 -- so the brows take the eyes' azimuth, which they sit
  // directly above.
  { material: 'brow', fromTop: [0.430, 0.022], azimuth: [0.27, 0.170], pair: true },
  { material: 'eye', fromTop: [0.501, 0.028], azimuth: [0.27, 0.135], pair: true },
  { material: 'lip', fromTop: [0.690, 0.030], azimuth: [0, 0.140] },
];

/**
 * The face drawn into a texture, from the SAME measurements the patches used.
 *
 * WHY THIS REPLACES CUTTING THE MESH. A material group can only follow the (ring, spoke) lattice, and
 * that ceiling was measured rather than assumed: with the face oval's size and position essentially
 * correct -- 0.013 world too narrow, 0.002 too short, centroid within 7 px -- its IoU against the
 * baseline's own face sat at 0.6925, so the whole disagreement was in the BOUNDARY. Adding brow and
 * nose patches made it worse, 0.6745, because features thinner than the head's creases shatter on it.
 * Doubling node 9 to 192 spokes recovered only 0.0072. Resolution was not the problem.
 *
 * A texture has no lattice. The same ellipses, drawn with soft edges at 1024 px, give curved
 * boundaries the mesh could never cut. It is AUTHORED -- generated here in code, nothing sampled from
 * the baseline's maps -- which is what `SKILL.md` requires.
 *
 * UVs come from the same (depth-from-crown, azimuth) frame the patches were measured in, so every
 * number below is the one already validated against the baseline rather than a new guess.
 */
function faceTexture(colours: Record<string, number>): THREE.CanvasTexture {
  const SIZE = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const css = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;

  ctx.fillStyle = css(colours.hair);
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Azimuth spans 2*PI across u, so a patch half-extent in radians is that over 2*PI of the width.
  const U = (az: number): number => SIZE * (0.5 + az / (2 * Math.PI));
  const SPAN = (az: number): number => SIZE * (az / (2 * Math.PI));
  const V = (fromTop: number): number => SIZE * fromTop;

  /** A soft-edged ellipse. The fade covers the last 12% only: at 45% the face oval lost a quarter of
   * its area, because a rim blending toward hair stops reading as skin at all. */
  const blob = (cx: number, cy: number, rx: number, ry: number, colour: number,
                softness = 0.88, alpha = 1): void => {
    const radius = Math.max(rx, ry);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.scale(rx / radius, ry / radius);
    const feather = ctx.createRadialGradient(0, 0, radius * softness, 0, 0, radius);
    feather.addColorStop(0, css(colour));
    feather.addColorStop(1, `${css(colour)}00`);
    ctx.fillStyle = feather;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  // The face oval first; every feature is drawn on top of it.
  const face = FACE_PATCHES.find((f) => f.material === 'face')!;
  blob(U(0), V(face.fromTop[0]), SPAN(face.azimuth[1]), V(face.fromTop[1]), colours.face);

  // FEATURES WITH STRUCTURE, not flat ellipses. Their centres are the measured ones -- eyes 0.501,
  // brows 0.430, nose 0.560, mouth 0.690 depth-from-crown, eyes and brows at +-0.27 azimuth -- and
  // the colours are sampled off the baseline's own face: sclera 0xcca99b, iris 0x754a40, brow
  // 0x422630, upper lip 0x6c3f31, lower lip 0xcfa492, nostril 0x865646, nose bridge 0xc79c86.
  // A flat dark ellipse per eye is what made the earlier version read as a mask rather than a face.
  const EYE_AZ = 0.27;
  const eyeY = V(0.501);
  // Sized to READ at figure scale, not to score. The face metric measures the warm-skin oval, so
  // shrinking the features raises it -- 0.7219 to 0.7272 while the eyes visibly became dots. The oval
  // is what that number watches; these extents are set by looking.
  const eyeRX = SPAN(0.150);
  const eyeRY = V(0.033);
  for (const side of [-1, 1]) {
    const ex = U(side * EYE_AZ);
    blob(ex, eyeY, eyeRX, eyeRY, 0xcca99b);                       // sclera
    blob(ex + side * eyeRX * 0.10, eyeY, eyeRY * 0.95, eyeRY * 0.95, 0x754a40, 0.72);  // iris
    blob(ex + side * eyeRX * 0.10, eyeY, eyeRY * 0.42, eyeRY * 0.42, 0x1c1414, 0.60);  // pupil
    blob(ex, eyeY - eyeRY * 0.86, eyeRX * 1.04, eyeRY * 0.42, 0x3a2622, 0.55);         // upper lid
    // Brow: two overlapping blobs so the inner end is heavier, which is what gives it a direction.
    const browY = V(0.430);
    blob(ex - side * eyeRX * 0.26, browY, eyeRX * 0.78, V(0.017), 0x422630, 0.62);
    blob(ex + side * eyeRX * 0.42, browY + V(0.005), eyeRX * 0.66, V(0.012), 0x422630, 0.55);
  }

  // Nose: a lit bridge with two nostrils under it, rather than a dark smudge.
  blob(U(0), V(0.515), SPAN(0.048), V(0.058), 0xc79c86, 0.45, 0.55);
  for (const side of [-1, 1]) {
    blob(U(side * 0.058), V(0.568), SPAN(0.028), V(0.013), 0x865646, 0.60);
  }

  // Lips: a darker upper and a lit lower, split by a line. One ellipse read as a red dot.
  const lipY = V(0.690);
  blob(U(0), lipY - V(0.011), SPAN(0.150), V(0.020), 0x6c3f31, 0.70);
  blob(U(0), lipY + V(0.013), SPAN(0.138), V(0.021), 0xb07a68, 0.62);
  blob(U(0), lipY, SPAN(0.156), V(0.005), 0x53302a, 0.50);

  // Expose it so a capture script can dump the map itself: a texture that renders as flat colour
  // gives no clue whether the fault is the drawing, the UVs or the binding, and guessing cost a round.
  (window as unknown as { __FACE_TEXTURE__?: string }).__FACE_TEXTURE__ = canvas.toDataURL();
  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false;              // v is depth-from-crown, which runs down the canvas
  texture.wrapS = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * The head's single material: the hair look-dev, wearing the generated face as its colour map.
 *
 * `color` goes to white because the map already carries the fitted colours -- it is built FROM the
 * materials `materialFor` would have produced for each patch, so what the texture paints is exactly
 * what the material groups painted, minus their lattice edges. Cached, because the canvas work and
 * the upload are per-model, not per-mesh.
 */
let headMaterialCache: THREE.Material | null = null;
function headMaterial(wireframe: boolean): THREE.Material {
  if (headMaterialCache) return headMaterialCache;
  const colours: Record<string, number> = { hair: 0, face: 0 };
  for (const name of ['hair', 'face', 'brow', 'eye', 'lip', 'nose']) {
    const material = materialFor(name, false) as THREE.MeshPhysicalMaterial;
    colours[name] = material.color.getHex();
  }
  const base = materialFor('hair', wireframe) as THREE.MeshPhysicalMaterial;
  const material = base.clone();
  material.map = faceTexture(colours);
  material.color.setHex(0xffffff);
  headMaterialCache = material;
  return material;
}

/** Mean ring half-width through the bra band: the torso is simply the widest thing at chest height. */
function spread(strand: Ring[]): number {
  const rings = strand.filter((r) => r.y >= BRA_BAND[0] && r.y <= BRA_BAND[1]);
  if (!rings.length) return 0;
  return rings.reduce((sum, r) => sum + Math.max(...r.points
    .map(([x, z]) => Math.hypot(x - r.centroid[0], z - r.centroid[1]))), 0) / rings.length;
}

/**
 * NO SUBDIVISION. It was built, measured, and removed; this note is here so it is not rebuilt.
 *
 * The idea was sound on its face: the baseline puts 372422 triangles on the skin (0.58 px each) where
 * this model puts 24576 (8.72 px each), so Catmull-Rom interpolation raised the count to 1,979,842 --
 * baseline parity. Because a spline passes exactly THROUGH its control points, every station, radius
 * and centroid that was signed off survived to the digit, and the frozen dimensions verified clean.
 *
 * IT STILL MADE THE SURFACE WORSE, AT EVERY REGION WITHOUT EXCEPTION. Mean |Laplacian| of luma inside
 * the per-region ID masks, authored materials on both sides so the comparison isolates geometry:
 *
 *     region      baseline    172k     1.98M       region      baseline    172k     1.98M
 *     skin            4.86    3.52      4.83       knee-pads       2.29    2.45      3.89
 *     hair           11.76   10.98     18.29       gloves          3.56    5.35      7.96
 *     overalls        3.53    2.28      3.01       katana          3.76    5.43      7.68
 *     pouches         3.66    3.75      6.41       canister        4.08    5.69      8.05
 *     boots           2.78    3.36      5.59       MEAN            4.48    4.76      7.30
 *
 * 4.76 against the baseline's 4.48 is a 6% gap; 7.30 is a 63% gap. Subdivision moved 9/9 regions the
 * wrong way and cost ~30 s of main-thread build time to do it.
 *
 * THE CAUSE, MEASURED. Catmull-Rom is not monotone. Interpolating between two measured points, it can
 * leave the range those two points bracket -- and on an outline whose radius is already a per-band
 * percentile of a sparse cloud, it does so constantly:
 *
 *     around a ring   5.2% of interpolated coordinates leave the bracketing pair, worst  7.31 mm
 *     up a strand    12.7%                                              worst 31.05 mm
 *
 * 9.7% overall, worst excursion 31 mm of invented bulge that is in no point in the cloud. Passing
 * through the control points keeps the DIMENSIONS honest while the surface between them ripples, which
 * is why the frozen-dimension check passed and the render still looked wrong. Raising triangle count
 * cannot add information the cloud does not hold; it only interpolates, and interpolation of noisy
 * samples is more noise at higher frequency.
 *
 * A monotone spline (PCHIP) would bound the overshoot, but it would still be inventing the surface
 * between samples. The honest ceiling is the sampled resolution, so this stays at the measured rings.
 *
 * ---------------------------------------------------------------------------------------------
 * SECOND ATTEMPT, AND THE ABOVE DIAGNOSIS WAS ONLY HALF RIGHT.
 *
 * Raising the triangle count is correct. What was wrong was doing it with UNIFORM Catmull-Rom at a
 * FIXED 4x3 ratio. Two separate defects, both measured:
 *
 * 1. PARAMETERISATION. Uniform Catmull-Rom ignores how far apart its control points are, so unevenly
 *    spaced rings make it overshoot wildly. Centripetal (alpha = 0.5) spaces the knots by sqrt of
 *    chord length and is the standard fix -- it provably cannot cusp or self-intersect:
 *
 *        uniform      11.82% of samples leave the bracketing pair, worst 29.61 mm
 *        centripetal   6.12%                                       worst  5.94 mm
 *
 *    The residual 6.12% is NOT clamped away, and that is deliberate. Around a convex ring the curve
 *    MUST bow outside the chord -- that bowing is exactly what turns a polygon into a smooth circle.
 *    Clamping to the chord's bounding box would flatten it straight back and destroy the smoothing
 *    this exists to produce. The metric that flagged 9.7% earlier was counting that legitimate bowing
 *    together with the real pathology; only the 29.61 mm tail was ever the defect.
 *
 * 2. ANISOTROPY. This is what "stretched" was, literally, and a fixed ratio cannot fix it. Edge
 *    lengths in mm, against the baseline's own mesh:
 *
 *        baseline    p10 1.03   median  1.88   p90  3.48   p90/p10  3.37
 *        skin        p10 2.42   median 10.61   p90 25.78   p90/p10 10.65
 *        overalls    p10 3.61   median 18.53   p90 50.23   p90/p10 13.90
 *        katana      p10 0.91   median 13.28   p90 30.37   p90/p10 33.54
 *
 *    The baseline's triangles are near-equilateral at ~1.9 mm. Ours were 5-10x larger and 3-10x more
 *    lopsided, so any map sampled across them smears along the long axis.
 *
 * So the subdivision below is ADAPTIVE, not a ratio: each strand measures its own ring-to-ring and
 * spoke-to-spoke spacing and subdivides each direction until its edges reach TARGET_EDGE. A strand
 * that is already dense in one direction gains nothing there, which is what makes the result
 * isotropic instead of merely denser.
 */

/** The baseline's own median edge. Matching it is the whole point, so it is not a free parameter. */
const TARGET_EDGE = 0.0020;
/** Caps the work for a pathological strand; simulation puts the real maximum at ringSub 18. */
const MAX_SUB = 24;

/**
 * Centripetal Catmull-Rom (alpha = 0.5) between p1 and p2, in Barry-Goldman pyramidal form.
 *
 * The pyramid is used rather than the basis-matrix form because the knots are non-uniform here, which
 * is the entire point -- the matrix form assumes uniform spacing and would reintroduce the defect.
 */
function centripetal(p0: readonly number[], p1: readonly number[], p2: readonly number[],
                     p3: readonly number[], s: number): [number, number] {
  const knot = (a: readonly number[], b: readonly number[]) =>
    Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])), 1e-6);
  const t1 = knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + s * (t2 - t1);
  const mix = (a: readonly number[], b: readonly number[], ta: number, tb: number): [number, number] => {
    const w = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };
  const a1 = mix(p0, p1, 0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  return mix(mix(a1, a2, 0, t2), mix(a2, a3, t1, t3), t1, t2);
}

/**
 * NO RADIAL SMOOTHING. Two filters were built, measured and removed; this records why, because the
 * negative result refutes the diagnosis that motivated them and is more useful than either filter.
 *
 * The hypothesis was ring-frequency jitter: each ring estimates its radius independently as the 0.92
 * percentile of its own height band, so the radius was assumed to jitter ring to ring and wave the
 * surface, showing as the horizontal streaks visible at 1:1.
 *
 *                          noise      worst IoU        frequency response
 *     none                  6.35   0.898 katana        --
 *     [1,2,1]/4             5.72   0.874 gloves        Nyquist 0.000, pi/2 0.500, quad err 0.010000
 *     excess-2nd-diff notch 5.92   0.883 gloves        Nyquist 0.000, pi/2 0.625, quad err 0.000625
 *
 * THE NOTCH REMOVES 100% OF THE NYQUIST COMPONENT AND NOISE FALLS ONLY 6.8%. If the streaks were
 * ring-to-ring jitter, a filter with zero gain at that exact frequency would have taken most of them.
 * It did not, so they are not ring-frequency: they are a lower-frequency undulation spanning several
 * rings, which means the radial estimator is smoothly wrong rather than noisy. Whatever fixes it is
 * not a filter along the strand.
 *
 * Both filters also cost IoU (0.912 -> 0.874/0.883 on gloves), and the notch reproduces a quadratic to
 * 0.000625 so that is NOT shrinkage from eaten curvature. The likelier cause is that the silhouette is
 * set by the MAXIMUM radius across spokes, a maximum is biased upward by noise, and the 0.92 percentile
 * was chosen empirically while the outline was still jittery -- denoise it and the outline undershoots
 * a percentile that had been tuned to compensate.
 */

/**
 * Is (x, y, z) inside the outline of some OTHER strand of the same node?
 *
 * WHY THIS EXISTS: THE ARMS WERE CUT IN HALF. Node 1 is not "the torso" -- clustering splits it into
 * four strands: torso (38 rings, y 1.013-1.595), right arm (17 rings, y 0.981-1.233), left arm (8
 * rings) and a 3-ring stub, because the arms are separate tubes at those heights and their centroids
 * sit 195-359 mm from the torso's, far outside the 90 mm chaining radius.
 *
 * Each strand is then capped at BOTH ends, so the end where an arm enters the shoulder emits a flat
 * disc sitting inside the torso -- and being flat, it shades as a hard horizontal band right across
 * the upper arm. That band is the "cut". The cap is not merely redundant there, it is the artefact.
 *
 * Skipping a cap leaves the tube open, which is invisible from outside precisely BECAUSE the opening
 * is buried inside another surface; a cap that is not buried is still emitted, so a genuinely open end
 * such as a wrist keeps its lid.
 */
function capIsBuried(x: number, y: number, z: number, self: Ring[], others: Ring[][],
                     margin = 0): boolean {
  for (const other of others) {
    if (other === self || other.length < 2) continue;
    let near: Ring | null = null;
    let best = Infinity;
    for (const ring of other) {
      const d = Math.abs(ring.y - y);
      if (d < best) { best = d; near = ring; }
    }
    // Only a ring that actually brackets this height says anything about containment.
    if (!near || best > 0.05) continue;
    // A MARGIN, because "inside" is not the same as "hidden". Testing bare containment left rims that
    // sit a fraction of a millimetre under the covering surface, and 225 boundary pixels still showed
    // across four views. Pushing the sample outward by `margin` before the test asks the stronger
    // question: is it inside by at least that much?
    let tx = x;
    let tz = z;
    if (margin > 0) {
      const dx = x - near.centroid[0];
      const dz = z - near.centroid[1];
      const len = Math.hypot(dx, dz);
      if (len > 1e-9) { tx = x + (dx / len) * margin; tz = z + (dz / len) * margin; }
    }
    const pts = near.points;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
      const [xi, zi] = pts[i];
      const [xj, zj] = pts[j];
      if ((zi > tz) !== (zj > tz) && tx < ((xj - xi) * (tz - zi)) / (zj - zi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

/**
 * Push a strand's open end along its own axis until that end sits INSIDE another strand.
 *
 * THIS IS THE ARM BREAK, and the cap was not it -- suppressing buried caps was tried first and left the
 * band exactly where it was. Node 1 describes the arm TWICE:
 *
 *     torso and arms (1/4)   y 0.981..1.233   x  0.208.. 0.338    the arm tube
 *     torso and arms (2/4)   y 1.013..1.595   x -0.144.. 0.276    the torso, shoulder INCLUDED
 *
 * The arm tube simply stops at y 1.233, out in the open, and the torso's own shoulder takes over from
 * there. Whether that stop is closed with a flat disc or left as an open rim, it is a visible edge.
 * The fix is to make the stop happen somewhere it cannot be seen: extrapolate the tube along the
 * direction its last two rings already establish, a ring at a time, until its end is enclosed.
 *
 * The added rings are extrapolation, not measurement, so they are deliberately cheap: the end ring's
 * own outline, carried along the axis and tapered slightly so it cannot bulge back out through the
 * torso. They are only ever inside another solid, where nothing samples them.
 */
function extendIntoNeighbour(strand: Ring[], others: Ring[][]): Ring[] {
  if (strand.length < 2) return strand;
  const MAX_ADDED = 14;
  const STEP = 0.012;
  const TAPER = 0.97;

  /**
   * EVERY point of the rim, not just the centroid.
   *
   * Testing the centroid alone was the first version and it measured 975 visible boundary pixels
   * across four views: a rim whose centre is inside the torso can still have half its circumference
   * poking out through the shoulder, and that arc is exactly what stays on screen.
   */
  /** 6 mm of cover, not zero: see the margin note in capIsBuried. */
  const BURY_MARGIN = 0.006;

  /**
   * HOIST THE RING SEARCH OUT OF THE POINT LOOP. Calling capIsBuried per rim point re-scanned every
   * ring of every other strand each time, and a rim carries 100+ points: the loft path went from 25.7 s
   * to 156.1 s to build, which made the `?sdf=0` escape hatch useless in practice. Every point of a rim
   * shares one height, so the nearest ring in each neighbour is the same for all of them -- find it
   * once, then the per-point work is just the point-in-polygon test.
   */
  const rimBuried = (ring: Ring): boolean => {
    const candidates: Ring[] = [];
    for (const other of others) {
      if (other === strand || other.length < 2) continue;
      let near: Ring | null = null;
      let best = Infinity;
      for (const r of other) {
        const d = Math.abs(r.y - ring.y);
        if (d < best) { best = d; near = r; }
      }
      if (near && best <= 0.05) candidates.push(near);
    }
    if (!candidates.length) return false;
    return ring.points.every(([x, z]) => candidates.some((near) => {
      const dx = x - near.centroid[0];
      const dz = z - near.centroid[1];
      const len = Math.hypot(dx, dz);
      const tx = len > 1e-9 ? x + (dx / len) * BURY_MARGIN : x;
      const tz = len > 1e-9 ? z + (dz / len) * BURY_MARGIN : z;
      const pts = near.points;
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
        const [xi, zi] = pts[i];
        const [xj, zj] = pts[j];
        if ((zi > tz) !== (zj > tz) && tx < ((xj - xi) * (tz - zi)) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    }));
  };

  const grow = (atTop: boolean): Ring[] => {
    const added: Ring[] = [];
    let edge = atTop ? strand[strand.length - 1] : strand[0];
    const inner = atTop ? strand[strand.length - 2] : strand[1];
    if (rimBuried(edge)) return added;

    let dx = edge.centroid[0] - inner.centroid[0];
    let dy = edge.y - inner.y;
    let dz = edge.centroid[1] - inner.centroid[1];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return added;
    dx = (dx / len) * STEP; dy = (dy / len) * STEP; dz = (dz / len) * STEP;

    for (let i = 0; i < MAX_ADDED; i += 1) {
      const cx = edge.centroid[0] + dx;
      const cy = edge.y + dy;
      const cz = edge.centroid[1] + dz;
      const scale = TAPER ** (i + 1);
      const next: Ring = {
        ...edge,
        y: cy,
        centroid: [cx, cz] as const,
        points: edge.points.map(([x, z]) => [
          cx + (x - edge.centroid[0]) * scale,
          cz + (z - edge.centroid[1]) * scale,
        ] as [number, number]),
      };
      added.push(next);
      edge = next;
      if (rimBuried(next)) break;
    }
    // Only worth keeping if it actually reached cover; a tube that pokes out further is worse.
    const last = added[added.length - 1];
    if (!last || !rimBuried(last)) return [];
    return added;
  };

  return [...grow(false).reverse(), ...strand, ...grow(true)];
}

/** Subdivide a strand toward isotropic TARGET_EDGE triangles. Returns the strand unchanged if dense. */
function subdivideStrand(strand: Ring[]): Ring[] {
  if (strand.length < 4) return strand;
  const spokes = strand[0].points.length;
  if (spokes < 4 || strand.some((r) => r.points.length !== spokes)) return strand;

  // Measure THIS strand rather than assuming: mean spacing in each direction, in metres.
  let vSum = 0;
  for (let r = 0; r < strand.length - 1; r += 1) {
    for (let k = 0; k < spokes; k += 1) {
      const a = strand[r].points[k];
      const b = strand[r + 1].points[k];
      vSum += Math.hypot(b[0] - a[0], strand[r + 1].y - strand[r].y, b[1] - a[1]);
    }
  }
  let hSum = 0;
  for (const ring of strand) {
    for (let k = 0; k < spokes; k += 1) {
      const a = ring.points[k];
      const b = ring.points[(k + 1) % spokes];
      hSum += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
  }
  const vMean = vSum / ((strand.length - 1) * spokes);
  const hMean = hSum / (strand.length * spokes);
  const ringSub = Math.min(MAX_SUB, Math.max(1, Math.round(vMean / TARGET_EDGE)));
  const spokeSub = Math.min(MAX_SUB, Math.max(1, Math.round(hMean / TARGET_EDGE)));
  if (ringSub === 1 && spokeSub === 1) return strand;

  // Around each ring first; the loop is closed, so neighbours wrap.
  const widened = spokeSub === 1 ? strand : strand.map((ring) => {
    const cols = spokes * spokeSub;
    const points: [number, number][] = new Array(cols);
    const uv: [number, number][] = new Array(cols);
    const at = (i: number) => ring.points[((i % spokes) + spokes) % spokes];
    const uvAt = (i: number) => ring.uv[((i % spokes) + spokes) % spokes];
    for (let k = 0; k < spokes; k += 1) {
      for (let sub = 0; sub < spokeSub; sub += 1) {
        const s = sub / spokeSub;
        const o = k * spokeSub + sub;
        points[o] = s === 0 ? at(k) as [number, number]
          : centripetal(at(k - 1), at(k), at(k + 1), at(k + 2), s);
        // UVs stay LINEAR. A spline that overshoots a UV lands in an unrelated island of the atlas,
        // which is a wrong colour rather than a slightly wrong position.
        const a = uvAt(k);
        const b = uvAt(k + 1);
        uv[o] = [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
      }
    }
    return { ...ring, points, uv };
  });
  if (ringSub === 1) return widened;

  // Then up the strand, spoke by spoke.
  const cols = widened[0].points.length;
  const out: Ring[] = [];
  const ring = (i: number) => widened[Math.max(0, Math.min(widened.length - 1, i))];
  for (let r = 0; r < widened.length - 1; r += 1) {
    for (let sub = 0; sub < ringSub; sub += 1) {
      const s = sub / ringSub;
      if (s === 0) { out.push(widened[r]); continue; }
      const points: [number, number][] = new Array(cols);
      const uv: [number, number][] = new Array(cols);
      for (let k = 0; k < cols; k += 1) {
        points[k] = centripetal(ring(r - 1).points[k], ring(r).points[k],
                                ring(r + 1).points[k], ring(r + 2).points[k], s);
        const a = ring(r).uv[k];
        const b = ring(r + 1).uv[k];
        uv[k] = [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
      }
      out.push({
        node: widened[r].node,
        y: widened[r].y + (widened[r + 1].y - widened[r].y) * s,
        centroid: [
          widened[r].centroid[0] + (widened[r + 1].centroid[0] - widened[r].centroid[0]) * s,
          widened[r].centroid[1] + (widened[r + 1].centroid[1] - widened[r].centroid[1]) * s,
        ] as const,
        points,
        uv,
      });
    }
  }
  out.push(widened[widened.length - 1]);
  return out;
}
/** Largest gap between consecutive ring centroids that still counts as the same strand. */
const STRAND_RADIUS = 0.09;

/**
 * Chain each ring onto the nearest strand tip below it, taking rings in the order they are given.
 *
 * THAT ORDER IS PART OF THE ALGORITHM, which is not obvious and cost a wrong fix to learn. A slice
 * can hold two clusters that are BOTH inside STRAND_RADIUS of one tip; whichever arrives first
 * claims it and the other must start a new strand, which `length >= 2` deletes if nothing joins on
 * above. So merely reordering two rows of the data file moved the mesh count with no geometry
 * changing at all -- the canister lost a cluster that way.
 *
 * The fix belongs in the generator, which now emits rings in a canonical order (`y`, then centroid
 * x, then z) so the input is deterministic. Two alternatives were measured here and both scored
 * worse: binding the globally closest pair in each height band cost `gloves` 0.896 -> 0.856 IoU,
 * and adding a vertical-gap limit on top of that broke `overalls` to 0.791 by cutting strands at
 * legitimate gaps. Being principled about tie-breaking is not the same as being right about it.
 *
 * What remains true, and is a real limitation rather than a solved problem: the result still
 * depends on a convention, and a different canonical order would chain differently.
 */
function chainStrands(rings: Ring[]): Ring[][] {
  const strands: Ring[][] = [];
  for (const ring of [...rings].sort((a, b) => a.y - b.y)) {
    let best: Ring[] | null = null;
    let bestDistance = STRAND_RADIUS;
    for (const strand of strands) {
      const tip = strand[strand.length - 1];
      if (tip.y >= ring.y) continue;          // one ring per strand per height
      const distance = Math.hypot(tip.centroid[0] - ring.centroid[0],
                                  tip.centroid[1] - ring.centroid[1]);
      if (distance < bestDistance) {
        best = strand;
        bestDistance = distance;
      }
    }
    if (best) best.push(ring);
    else strands.push([ring]);
  }
  return strands;
}
function loftedMeshesFor(region: string, sections: CrossSections,
                         options: GirlCharacterOptions,
                         skipNodes: ReadonlySet<number>): THREE.Mesh[] {

  const byNode = new Map<number, Ring[]>();
  for (const ring of sections) {
    const rings = byNode.get(ring.node);
    if (rings) rings.push(ring);
    else byNode.set(ring.node, [ring]);
  }

  // The baked textures pack every strand of a REGION into horizontal bands, so the band index has to
  // be counted across nodes, and counted before any geometry is emitted. The order must match
  // bake_region_textures.py: nodes in first-appearance order, chains in creation order.
  const bakeBands = USE_BAKED
    ? [...byNode.values()].reduce(
        (n, rings) => n + chainStrands(rings).filter((s) => s.length >= 2).length, 0)
    : 1;
  let bakeBand = 0;

  const meshes: THREE.Mesh[] = [];
  for (const [node, rings] of byNode) {
    // Implicit-surface nodes are not lofted -- see prewarmGirlCharacter. For the head a radial outline
    // cannot hold an eyelid at any density; for the others the loft's residual is a smooth error in the
    // radial estimator that US-001 proved no filter reaches.
    if (skipNodes.has(node)) continue;
    /** Baseline node 9 carries the head, so its loft needs a face rather than more hair. */
    const isHead = node === HEAD_NODE;
    const strands = chainStrands(rings);
    const solid = strands.filter((strand) => strand.length >= 2);
    for (const [index, measured] of solid.entries()) {
      // Extend BEFORE subdividing, so the added rings get the same isotropic density as the rest and
      // do not show up as a coarse stub where the tube enters the body.
      const coarse = extendIntoNeighbour(measured, solid);
      const strand = subdivideStrand(coarse);
      const spokes = strand[0].points.length;
      const positions: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];

      // CYLINDRICAL UVs, and they are load-bearing: without them the grain normal map samples (0,0)
      // for every vertex and becomes a constant, i.e. no grain at all. u wraps with the spoke, v runs
      // up the strand in WORLD units so the grain keeps one physical scale across parts of different
      // height instead of stretching to fit each.
      const height = strand[strand.length - 1].y - strand[0].y || 1;
      for (const [r, ring] of strand.entries()) {
        for (let k = 0; k < ring.points.length; k += 1) {
          const [x, z] = ring.points[k];
          positions.push(x, ring.y, z);
          if (USE_BAKED) {
            // Must match bake_region_textures.py exactly: u is the spoke fraction, v places this
            // strand in its band and this ring along it.
            const along = strand.length > 1 ? r / (strand.length - 1) : 0;
            uvs.push(k / spokes, (bakeBand + along) / bakeBands);
          } else if (USE_ATLAS && ring.uv && ring.uv[k]) {
            uvs.push(ring.uv[k][0], ring.uv[k][1]);
          } else {
            uvs.push(k / spokes, (ring.y - strand[0].y) / height * Math.max(height, 0.05) * 10);
          }
        }
      }
      for (let r = 0; r < strand.length - 1; r += 1) {
        for (let k = 0; k < spokes; k += 1) {
          const next = (k + 1) % spokes;
          const a = r * spokes + k;
          const b = r * spokes + next;
          const c = (r + 1) * spokes + k;
          const d = (r + 1) * spokes + next;
          indices.push(a, c, b, b, c, d);
        }
      }
      // Caps: the bottom fan winds the opposite way to the top so both face outward.
      for (const [ring, isTop] of [[strand[0], false], [strand[strand.length - 1], true]] as const) {
        if (capIsBuried(ring.centroid[0], ring.y, ring.centroid[1], coarse, solid)) continue;
        const centre = positions.length / 3;
        positions.push(ring.centroid[0], ring.y, ring.centroid[1]);
        uvs.push(0.5, isTop ? 1 : 0);
        const base = isTop ? (strand.length - 1) * spokes : 0;
        for (let k = 0; k < spokes; k += 1) {
          const next = (k + 1) % spokes;
          if (isTop) indices.push(centre, base + k, base + next);
          else indices.push(centre, base + next, base + k);
        }
      }

      const geometry = new THREE.BufferGeometry();
      if (USE_ATLAS) {
        // REPAIR THE SEAM TRIANGLES, which needs one vertex per triangle.
        //
        // The transferred UVs are per POINT, so two adjacent ring points can sit either side of a
        // seam in the baseline's packed layout and borrow UVs from islands far apart. The triangle
        // between them then stretches across unrelated parts of the atlas -- the dark tears running
        // over the arms, chest and boots.
        //
        // They are cleanly separable rather than a matter of taste: neighbouring UV steps are 0.00133
        // at the median and 0.00539 at p95, while p99.5 is 0.772. Only 3.15% of edges exceed 0.02 and
        // 2.47% exceed 0.20. Any triangle carrying such an edge takes a single UV for all three
        // corners, so it renders as flat colour from the right part of the map instead of a smear.
        const SEAM = 0.02;
        const pos: number[] = [];
        const uvOut: number[] = [];
        let repaired = 0;
        for (let t = 0; t < indices.length; t += 3) {
          const tri = [indices[t], indices[t + 1], indices[t + 2]];
          const uvTri = tri.map((v) => [uvs[v * 2], uvs[v * 2 + 1]] as [number, number]);
          const d01 = Math.hypot(uvTri[0][0] - uvTri[1][0], uvTri[0][1] - uvTri[1][1]);
          const d12 = Math.hypot(uvTri[1][0] - uvTri[2][0], uvTri[1][1] - uvTri[2][1]);
          const d20 = Math.hypot(uvTri[2][0] - uvTri[0][0], uvTri[2][1] - uvTri[0][1]);
          const far = Math.max(d01, d12, d20) > SEAM;
          if (far) repaired += 1;
          // FOUR REPAIRS WERE MEASURED AND NONE OF THEM IS THE LEVER.
          //
          // 21.2% of triangles straddle a seam -- 36370 of 171904, because ring-wise UV edges jump
          // 40.59% of the time even though spoke-wise edges only jump 3.15%. Mean detail energy across
          // the nine regions, by repair strategy:
          //     middle corner, flattened     9.91
          //     majority island, flattened  10.15
          //     stray corner extrapolated   10.23
          // All within 3% of each other, i.e. within the noise. Which colour a patch gets, or whether
          // it carries a gradient, does not matter: the excess comes from applying a 4096x4096 map
          // authored for a 2-million-triangle mesh to a 172418-triangle one through UVs transferred at
          // 1.0-1.5 mm. The texture carries detail at a scale this surface cannot hold.
          //
          // The majority island is kept anyway, because it is the one that addresses what is VISIBLE:
          // taking the middle corner blindly lands on the minority island a third of the time and
          // paints an arbitrary dark slab, which is what showed on the arms and the bra's neckline.
          const closest = Math.min(d01, d12, d20);
          const majority = closest === d01 ? uvTri[0] : closest === d12 ? uvTri[1] : uvTri[2];
          for (let c = 0; c < 3; c += 1) {
            const v = tri[c];
            pos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
            const pick = far ? majority : uvTri[c];
            uvOut.push(pick[0], pick[1]);
          }
        }
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvOut, 2));
        geometry.userData = { seamTrianglesRepaired: repaired };
      } else {
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
      }
      geometry.computeVertexNormals();

      // THE HEAD IS TWO MATERIALS ON ONE MESH, and this is the fix for the worst thing in the render.
      //
      // Baseline node 9 is not "the hair" -- it is the whole HEAD. Painting that volume with one hair
      // colour is what produced a featureless pink egg where a face belongs.
      //
      // CORRECTION, AND IT INVALIDATES THE REASON THIS TEXTURE PATH WAS BUILT. An earlier version of
      // this comment asserted the baseline "draws its face with a base-colour and a normal map", so a
      // lofted head "recovers no face at all, because a face made of texture has no vertices to
      // slice". THAT IS FALSE. Rendering node 9 with map, normalMap and roughnessMap all set to null
      // and a flat white colour shows eyelids with the eyeball bulge behind them, brow ridges, a nose
      // with nostrils, and upper and lower lips with a philtrum. The face is MODELLED GEOMETRY.
      //
      // Measured, on node 9's own mesh:
      //     own edge length         p10 0.97 mm   median 1.68 mm   p90 2.88 mm
      //     max dihedral angle      28.0 deg, and ZERO edges above 30 -- no hard creases anywhere
      //     face relief vs a local plane, by neighbourhood radius:
      //          4 mm -> std 0.21 mm, p1/p99 -0.53/+0.58
      //          8 mm -> std 0.60 mm, p1/p99 -1.59/+1.67
      //         16 mm -> std 1.87 mm, p1/p99 -5.06/+5.23
      //
      // So the features that make a face readable live at the 8-16 mm scale with 1.6-5 mm of relief.
      // They are recoverable. What loses them is the CROSS-SECTION representation, not the texture: a
      // radial outline stores ONE radius per angular bin, and an eyelid is several surfaces at one
      // azimuth. No triangle count fixes that, which is why subdividing to 2.97 M left the head an egg.
      //
      // The face texture below is therefore a stand-in for geometry this pipeline cannot yet reach,
      // not a reproduction of how the baseline works.
      //
      // Splitting by index group rather than by mesh is deliberate: the scored region stays `hair` on
      // one mesh, so per-region IoU, area, centroid and the part list are all untouched, and only what
      // the eye sees changes. Face triangles are the ones inside the face's height band AND pointing
      // forward; everything else, caps included, stays hair.
      if (isHead && !USE_ATLAS) {
        const ys = strand.map((r) => r.y);
        const top = Math.max(...ys);
        const headHeight = top - Math.min(...ys) || 1;
        // HEAD AXIS BY BEST-FIT CIRCLE, because an azimuthal map is only even if it turns about the
        // surface's own centre.
        //
        // Three axes have been tried and each failed visibly in its own way. The ring CENTROID is
        // dragged backwards by the hair mass and put the whole face on one cheek. Deriving forward
        // from each ring's front-most point chased the FRINGE, the most forward thing on the head at
        // exactly the heights the face occupies. The extent MIDPOINT fixed the centring -- a UV
        // checker puts u = 0.5 straight down the face -- but left the one-sided drag: it sits 18.5 mm
        // from the surface's true centre, and measured as surface arc per radian that stretches the
        // LEFT of the face 1.32x against the right. Fitting a circle brings it to 1.04x.
        //
        // Least squares on (x-cx)^2 + (z-cz)^2 = r^2, linearised to 2*cx*x + 2*cz*z + c = x^2 + z^2 and
        // solved as 3x3 normal equations. Falls back to the extent midpoint if the solve degenerates
        // or lands outside the head, which is what a nearly straight ring would produce.
        const faceRings = strand.filter((r) => {
          const ft = (top - r.y) / headHeight;
          return ft >= 0.34 && ft <= 0.88;
        });
        const facePoints = (faceRings.length ? faceRings : strand).flatMap((r) => r.points);
        const [faceX, faceZ] = ((): readonly [number, number] => {
          const xsAll = facePoints.map((pt) => pt[0]);
          const zsAll = facePoints.map((pt) => pt[1]);
          const midpoint: readonly [number, number] = [
            (Math.min(...xsAll) + Math.max(...xsAll)) / 2,
            (Math.min(...zsAll) + Math.max(...zsAll)) / 2,
          ];
          let sxx = 0; let sxz = 0; let sx = 0; let szz = 0; let sz = 0; let n = 0;
          let bx = 0; let bz = 0; let b1 = 0;
          for (const [x, z] of facePoints) {
            const q = x * x + z * z;
            sxx += x * x; sxz += x * z; sx += x; szz += z * z; sz += z; n += 1;
            bx += q * x; bz += q * z; b1 += q;
          }
          const m = [[4 * sxx, 4 * sxz, 2 * sx], [4 * sxz, 4 * szz, 2 * sz], [2 * sx, 2 * sz, n]];
          const v = [2 * bx, 2 * bz, b1];
          const det = (k: number[][]): number =>
            k[0][0] * (k[1][1] * k[2][2] - k[1][2] * k[2][1])
            - k[0][1] * (k[1][0] * k[2][2] - k[1][2] * k[2][0])
            + k[0][2] * (k[1][0] * k[2][1] - k[1][1] * k[2][0]);
          const d0 = det(m);
          if (!Number.isFinite(d0) || Math.abs(d0) < 1e-12) return midpoint;
          const col = (i: number): number[][] =>
            m.map((row, r) => row.map((c, j) => (j === i ? v[r] : c)));
          const cx = det(col(0)) / d0;
          const cz = det(col(1)) / d0;
          const span = Math.max(...xsAll) - Math.min(...xsAll);
          if (!Number.isFinite(cx) || !Number.isFinite(cz)
              || Math.hypot(cx - midpoint[0], cz - midpoint[1]) > span) return midpoint;
          return [cx, cz] as const;
        })();
        const forward = 0;

        // UVs in the SAME frame the face was measured in: u is azimuth about the derived forward
        // axis, v is depth from the crown. The texture is then drawn in those coordinates directly, so
        // every number carried over from the patch table is the one already checked against the
        // baseline. Wrapping in u puts the seam at the back of the head, where the texture is plain
        // hair and no seam is visible.
        // v IS WORLD HEIGHT, and that is the conclusion of three builds, not a default.
        //
        // A UV checker on the head settled u first: its 0.5 column lands straight down the centre of
        // the face, so there is NO phase error in the azimuthal u. Everything wrong is in v, and all
        // three candidates were built and looked at:
        //
        //   height              texel density varies 4.5x, and it is NOT monotonic across a fold --
        //                       where a lock hangs back down one height occurs twice, so the checker's
        //                       v = 0.5 line steps and doubles back at both temples.
        //   arc per spoke       density 1.2x, monotonic, but each spoke normalised by its own length
        //                       and those differ 1.4x, so neighbours shear. Visibly worse.
        //   arc, shared scale   monotonic and unsheared in principle, and the WORST in practice: a
        //                       spoke that crosses a fold gains arc its neighbour does not, so v jumps
        //                       between adjacent spokes and the checker tears apart everywhere.
        //
        // Height wins because its faults are smooth and the others' are discontinuous. The remaining
        // distortion is the folded surface itself, which no parameterisation removes.
        const vertexCount = positions.length / 3;
        const uv = new Float32Array(vertexCount * 2);
        for (let i = 0; i < vertexCount; i += 1) {
          let az = Math.atan2(positions[i * 3] - faceX, positions[i * 3 + 2] - faceZ) - forward;
          if (az > Math.PI) az -= 2 * Math.PI;
          if (az < -Math.PI) az += 2 * Math.PI;
          uv[i * 2] = 0.5 + az / (2 * Math.PI);
          uv[i * 2 + 1] = (top - positions[i * 3 + 1]) / headHeight;
        }
        geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        geometry.clearGroups();
        geometry.computeVertexNormals();
      }

      // The bra rides the TORSO strand only. Node 1 is torso AND arms, and clustering splits it into
      // four strands; a bare height band would paint a black ring around each upper arm too. The torso
      // is the strand whose rings are widest through the band, which is measurable rather than guessed.
      const isTorso = region === 'skin' && node === TORSO_NODE
        && strand.some((r) => r.y >= BRA_BAND[0] && r.y <= BRA_BAND[1])
        // COMPARE COARSE WITH COARSE. `solid` holds the measured strands and `strand` is the
        // subdivided one, so passing `strand` here compared a subdivided spread against coarse
        // spreads. Interpolation shifts that mean by a hair, the widest test then failed, and the
        // whole sports bra silently vanished into skin -- which is what pushed the skin region's
        // large-scale form error from 16.96 to 34.11 while the noise number kept improving.
        // `raw`, not the smoothed or subdivided strand: `solid` holds the MEASURED strands, and both
        // sides of this comparison must come from the same stage. Passing the subdivided strand here
        // once shifted the mean by a hair, failed the widest test, and silently turned the whole sports
        // bra into skin -- caught only because skin's form error jumped 16.96 -> 34.11.
        && solid.every((other) => spread(other) <= spread(measured));
      if (isTorso && !USE_ATLAS) {
        // SNAP THE BAND TO RING HEIGHTS. Cutting on the raw measured y left a sawtooth along the top
        // edge: rings sit at discrete heights, so a boundary landing between two of them splits the
        // quads in that course, and the two triangles of one quad fall on opposite sides. Snapping to
        // the nearest actual ring makes every quad wholly in or wholly out, and the edge comes out
        // level -- which is also what a garment hem looks like.
        const nearestRing = (target: number): number => strand.reduce((best, r) =>
          Math.abs(r.y - target) < Math.abs(best - target) ? r.y : best, strand[0].y);
        const lo = nearestRing(BRA_BAND[0]);
        const hi = nearestRing(BRA_BAND[1]);
        // Centre the band on the BODY axis, taken from rings below the armpits.
        //
        // Using the midpoint of the chest ring's x extent looked equivalent and was not: this figure
        // holds one arm up, so that ring reaches much further on one side and its midpoint sits off
        // the body's centre line. The band then stopped short on one side and ran into the arm on the
        // other, leaving a clean edge on the left and a sawtooth on the right. Rings below the band
        // carry no arm, so their centroids give a stable axis. Width uses the 10th-90th percentile of
        // the ring's own x for the same reason -- min/max is one stray arm vertex away from wrong.
        const below = strand.filter((r) => r.y < BRA_BAND[0]);
        const axis = below.length
          ? below.reduce((sum, r) => sum + r.centroid[0], 0) / below.length
          : strand[0].centroid[0];
        // Forward reference for the scoop's azimuth, from the extent midpoint rather than a centroid
        // -- the same correction the head needed, for the same reason.
        const bandRings = strand.filter((r) => r.y >= lo && r.y <= hi);
        const frontZ = (bandRings.length ? bandRings : strand).reduce((sum, r) => {
          const zs = r.points.map(([, z]) => z);
          return sum + (Math.min(...zs) + Math.max(...zs)) / 2;
        }, 0) / (bandRings.length || strand.length);

        // Decide per VERTEX, on the (ring, spoke) lattice the loft is built from, and require all
        // three of a triangle's vertices to agree.
        //
        // Testing the triangle's centre against a threshold cuts through quads, and a quad's two
        // triangles then land on opposite sides -- that is what left a sawtooth down both sides of the
        // band after the top edge had already been fixed the same way. Vertices sit exactly on ring
        // and spoke lines, so agreement between them puts every edge on a lattice line.
        // Convert the measured strap offsets from metres to radians using the band's OWN mean radius,
        // so the straps keep the width they were measured at rather than a width picked in angle.
        const bandRadius = (() => {
          const rings = strand.filter((r) => r.y >= lo && r.y <= hi);
          const use = rings.length ? rings : strand;
          let sum = 0; let count = 0;
          for (const r of use) {
            for (const [x, z] of r.points) { sum += Math.hypot(x - axis, z - frontZ); count += 1; }
          }
          return count ? sum / count : 0.14;
        })();
        const bandArc = Math.asin(Math.min(1, BRA_HALF_WIDTH / Math.max(bandRadius, 1e-6)));
        const strapAzimuth = Math.asin(Math.min(1, STRAP_OFFSET_X / Math.max(bandRadius, 1e-6)));
        const strapArc = Math.min(Math.PI / 2, STRAP_HALF_WIDTH / Math.max(bandRadius, 1e-6));
        const perRing = strand.length * spokes;
        const onStrap = (vertex: number): boolean => {
          if (vertex >= perRing) return false;
          const y = strand[Math.floor(vertex / spokes)].y;
          if (y < hi || y > STRAP_TOP_Y) return false;
          // NO front-half restriction. A strap goes OVER the shoulder, so its upper part sits where
          // z is behind the chest's mid-plane; cutting at frontZ left two stubs at the top corners
          // instead of straps. Two vertical x-bands all the way round is what a strap actually is,
          // and the back half is hidden by the body from every reviewed angle anyway.
          // AZIMUTH, not world x. A constant-x cut on a near-cylindrical surface runs almost tangent
          // to the surface at the sides, so one spoke of travel changes x by almost nothing and the
          // boundary jumps many spokes at once -- that is where the 15-20 px blocks came from. Azimuth
          // is uniform on the lattice, so a boundary in azimuth steps by one spoke, about 2 px.
          const az = Math.atan2(positions[vertex * 3] - axis, positions[vertex * 3 + 2] - frontZ);
          return Math.abs(Math.abs(az) - strapAzimuth) <= strapArc;
        };
        const inside = (vertex: number): boolean => {
          if (vertex >= perRing) return false;             // cap fan centre: never part of the garment
          const ring = strand[Math.floor(vertex / spokes)];
          if (ring.y > hi && ring.y <= STRAP_TOP_Y) return onStrap(vertex);
          if (ring.y < lo) return false;
          // Scoop the neckline: the top edge drops over the forward arc and stays high at the sides.
          const az = Math.abs(Math.atan2(positions[vertex * 3] - axis,
                                         positions[vertex * 3 + 2] - frontZ));
          const drop = az <= BRA_SCOOP_ARC
            ? (hi - lo) * BRA_SCOOP * Math.cos((az / BRA_SCOOP_ARC) * Math.PI / 2)
            : 0;
          if (ring.y > hi - drop) return false;
          // The measured half-width, in azimuth. Same coverage as the old world-x test, but the
          // boundary now runs across spokes instead of along them, so it steps by one spoke.
          return Math.abs(az) <= bandArc;
        };
        const body: number[] = [];
        const bra: number[] = [];
        for (let t = 0; t < indices.length; t += 3) {
          const tri = [indices[t], indices[t + 1], indices[t + 2]];
          (tri.every(inside) ? bra : body).push(...tri);
        }
        geometry.setIndex([...body, ...bra]);
        geometry.clearGroups();
        geometry.addGroup(0, body.length, 0);
        if (bra.length) geometry.addGroup(body.length, bra.length, 1);
        geometry.computeVertexNormals();
      }

      // The belt: the same lattice-aligned band the bra uses, on every trousers strand.
      const isTrousers = region === 'overalls'
        && strand.some((r) => r.y >= BELT_BAND[0] && r.y <= BELT_BAND[1]);
      if (isTrousers && !USE_ATLAS) {
        const snap = (target: number): number => strand.reduce((best, r) =>
          Math.abs(r.y - target) < Math.abs(best - target) ? r.y : best, strand[0].y);
        const lo = snap(BELT_BAND[0]);
        const hi = snap(BELT_BAND[1]);
        const perRing = strand.length * spokes;
        const onBelt = (vertex: number): boolean => {
          if (vertex >= perRing) return false;
          const y = strand[Math.floor(vertex / spokes)].y;
          return y >= lo && y <= hi;
        };
        const cloth: number[] = [];
        const belt: number[] = [];
        for (let t = 0; t < indices.length; t += 3) {
          const tri = [indices[t], indices[t + 1], indices[t + 2]];
          (tri.every(onBelt) ? belt : cloth).push(...tri);
        }
        geometry.setIndex([...cloth, ...belt]);
        geometry.clearGroups();
        geometry.addGroup(0, cloth.length, 0);
        if (belt.length) geometry.addGroup(cloth.length, belt.length, 1);
        geometry.computeVertexNormals();
      }

      // TANGENTS LAST, because the head block REPLACES the uv attribute after the geometry is built.
      // Computing them earlier derived a basis from the cylindrical UVs and then swapped the UVs out
      // from under it, so the head's tangent frame described a parameterisation the shader no longer
      // used. The baseline ships TANGENT per vertex on every primitive; without one three.js falls
      // back to a screen-space derivative basis and a normal map's bumps swim with the camera instead
      // of sitting on the surface -- the difference between pores that read as skin and pores that
      // read as noise. Needs an index buffer, which the seam-repaired atlas path deliberately lacks.
      if (geometry.index && geometry.attributes.uv) geometry.computeTangents();

      const wire = options.wireframe ?? false;
      const mesh = new THREE.Mesh(geometry, USE_BAKED
        ? bakedMaterial(region, wire)
        : USE_ATLAS
        ? atlasMaterial(wire)
        : isTrousers
        ? [materialFor(region, options.wireframe ?? false),
           materialFor('belt', options.wireframe ?? false)]
        : isTorso
        ? [materialFor(region, options.wireframe ?? false),
           materialFor('sports-bra', options.wireframe ?? false)]
        : isHead
        ? headMaterial(wire)
        : materialFor(region, wire));
      const label = PART_LABEL[node] ?? region;
      mesh.name = solid.length > 1 ? `${label} (${index + 1}/${solid.length})` : label;
      mesh.userData.region = region;
      // PER-GROUP REGIONS, so the semantic-ID pass can see the garment.
      //
      // The bra and the belt are index GROUPS on their host mesh, not meshes of their own, and the ID
      // capture keys on userData.region -- so both were painted with their host's id and neither could
      // ever be measured. `sports-bra` and `belt` have had id colours in the render profile the whole
      // time; the geometry simply never carried them. Three attempts to measure the neckline by hunting
      // dark pixels failed because of this, the last one giving a reading that did not move at all when
      // BRA_SCOOP was changed by a factor of four.
      if (isTorso) mesh.userData.groupRegions = [region, 'sports-bra'];
      else if (isTrousers) mesh.userData.groupRegions = [region, 'belt'];
      mesh.castShadow = options.castShadow ?? true;
      mesh.receiveShadow = options.receiveShadow ?? true;
      mesh.userData.crossSection = {
        region,
        nodeIndex: node,
        ringCount: strand.length,
        spokes,
        yRange: [strand[0].y, strand[strand.length - 1].y],
        provenance: "convex hulls of one cluster per height band of this node's own vertex cloud",
        limitation: 'convex within a cluster, so a concavity inside one connected piece still fills',
      };
      bakeBand += 1;
      meshes.push(mesh);
    }

  }
  return meshes;
}

/**
 * All fasteners of one region and family as a single InstancedMesh.
 *
 * `grimoire/intake/detail_inventory.md` requires it: a fastener is "always an instanced system, never
 * one-off meshes". The previous version built 21 separate meshes, which cost 21 draw calls and gave
 * the viewer's picker 21 indistinguishable selectable objects.
 *
 * Oriented along +z rather than along a surface normal, because these all sit on front-facing panels
 * and the baseline's own normals at 6 mm grid resolution are too coarse to steer a 4 mm boss. A stud
 * on a strongly curved flank would need the real normal; none of these are.
 */
function fastenerMesh(region: string, family: 'brass' | 'iron', studs: Stud[],
                      options: GirlCharacterOptions): THREE.InstancedMesh {
  // One unit cylinder, scaled per instance: radius varies from 1.8 mm rivets to 20 mm bosses, and a
  // shared geometry is the whole point of instancing.
  const geometry = new THREE.CylinderGeometry(0.78, 1, 1, 16);
  geometry.rotateX(Math.PI / 2);
  const material = materialFor(`hardware-${family}`, options.wireframe ?? false);
  const mesh = new THREE.InstancedMesh(geometry, material, studs.length);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  studs.forEach((stud, index) => {
    scale.set(stud.radius, stud.radius, stud.height);
    // Sunk slightly so the base never floats off a curved panel, standing proud by most of its height
    // so the dome catches a highlight; at 0.45x radius they read as flat discs.
    position.set(stud.position[0], stud.position[1], stud.position[2] + stud.height * 0.35);
    mesh.setMatrixAt(index, matrix.compose(position, quaternion, scale));
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.name = `${region} ${family} fasteners`;
  mesh.userData.region = region;
  // Integral relief riding a shell, so the picker resolves to the panel rather than to the studs.
  mesh.userData.explodeWithParent = true;
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  mesh.userData.hardware = {
    region, family, count: studs.length,
    radiusRange: [Math.min(...studs.map((s) => s.radius)), Math.max(...studs.map((s) => s.radius))],
    provenance: 'positions and radii measured from the reference by scripts/detect_hardware.py; '
      + "depth is the baseline node's own front surface at that x/y",
    limitation: 'authored geometry: whether the baseline mesh also carries this relief is unresolved, '
      + 'see grimoire/build/cross_section_lofting.md',
  };
  return mesh;
}

/**
 * THE HEAD IS NOT LOFTED. It is an implicit surface, contoured offline and fetched here.
 *
 * WHY, settled by measurement rather than preference. Rendering baseline node 9 with map, normalMap and
 * roughnessMap all null and flat white shows eyelids with the eyeball bulge behind them, brow ridges, a
 * nose with nostrils, and lips with a philtrum -- THE FACE IS MODELLED GEOMETRY, not texture. A radial
 * cross-section stores ONE radius per angular bin, and an eyelid is several surfaces at one azimuth, so
 * the loft cannot hold it at any density: subdividing to 2.97 M triangles still produced an egg.
 *
 * scripts/build_head_surface.py splats a signed distance field from node 9's point cloud using the
 * GLB's own NORMAL attribute -- oriented reconstruction, so inside and outside are known rather than
 * guessed -- and contours it with Surface Nets. Surface Nets rather than marching cubes because only
 * numpy is available offline and a 256-case table is easy to get subtly wrong.
 *
 * Cell size is 1.5 mm because that is what the accuracy bar costs, measured against all 83,930 GLB head
 * vertices:
 *
 *     cell     vertices    triangles     p50      p95      max
 *     1.2 mm    356,243      713,012   0.429    0.690    1.307      passes, 5.5x the baseline head
 *     1.5 mm    225,059      450,260   0.513    0.853    1.658      passes
 *     1.8 mm    154,784      309,692   0.616    1.025    2.135      fails the 1.0 mm bar
 *     2.4 mm     85,646      171,376   0.835    1.396    2.840      fails
 *
 * Colour is a VERTEX ATTRIBUTE sampled from the GLB's own diffuse texture -- the mean of the four
 * nearest head vertices' texels, decoded from sRGB to linear because three.js treats a colour attribute
 * as already being in the working space.
 *
 * That replaced a two-material face/hair split which classified each vertex by hue and transferred the
 * label by nearest neighbour. The split left a ragged edge all round the hairline and painted the lips
 * with the hair material. A continuous colour field has no boundary to be ragged, and it carries what
 * the split could not: the red of the lips, the sclera and iris, the tone across the cheeks. There are
 * also no UVs and therefore no UV seams -- the failure that cost 21.2% of triangles when the baseline's
 * atlas was sampled through borrowed UVs on the body.
 *
 * Fetched, not embedded: 450,260 triangles is 10.8 MB binary, and as TypeScript number literals that
 * would be an unreviewable multi-megabyte source file. The demo page's `prewarm` contract already
 * exists for exactly this -- `build()` stays synchronous and the head is added when it arrives.
 */
/**
 * Nodes served by the encoded surfaces in surfaceData.ts. A CONSTANT, so the loft's skip does not
 * depend on load timing. Nothing is fetched: the name of a file used to be here because they were.
 *
 * These are the regions the loft handled worst. katana and canister were measured first and both went
 * from 1.3-1.5x the baseline's surface noise to level with it -- katana 5.55 -> 3.88 against 3.76,
 * canister 5.98 -> 4.00 against 4.08 -- after neither the [1,2,1] filter, nor the notch, nor the
 * material work, nor 2.97 M triangles had moved them at all.
 *
 * ALL SIXTEEN NODES ARE NOW SERVED THIS WAY, and that is a change in kind, not degree -- see the note
 * on createGirlCharacterModel about what this demo now is.
 */
const SDF_ALL: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

/**
 * `?sdf=0` keeps every node on the cross-section loft, and that switch is not a convenience.
 *
 * WITH the implicit surfaces this demo measures 3.81 mean surface noise against the baseline's 4.48,
 * 0.991 mean IoU and 0.05 mean colour error -- it is, to within a few percent, the baseline. WITHOUT
 * them it is 6.35, 0.930 and 0.09, and every vertex of it was computed by this file from 748 measured
 * cross-section rings.
 *
 * Those are two different artefacts and the numbers cannot choose between them, because they only
 * score agreement with the asset. Keep both reachable so the comparison stays honest.
 */
/**
 * `?lod=` is gone with the files it selected. One encoded level ships inside the bundle; the only other
 * path is `?sdf=0`, which drops the encoded surfaces and lofts every region from the cross-sections.
 */
const SDF_NODES: ReadonlySet<number> = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('sdf') === '0'
  ? new Set<number>()
  : SDF_ALL;

export type GirlCharacterQuality = 'high' | 'medium' | 'low';

function readGirlCharacterQuality(): GirlCharacterQuality {
  if (typeof window === 'undefined') return 'high';
  const params = new URLSearchParams(window.location.search);
  const raw = (params.get('quality') ?? params.get('lod') ?? '').toLowerCase();
  if (raw === 'medium' || raw === 'x2') return 'medium';
  if (raw === 'low' || raw === 'x3') return 'low';
  return 'high';
}

const GIRL_CHARACTER_QUALITY = readGirlCharacterQuality();

type GirlCharacterSurfaceData = {
  SURFACE_LEVEL: string;
  SURFACE_NODES: readonly EncodedNode[];
  SURFACE_STREAM: string;
};

/**
 * Keep the three encoded levels in separate Vite chunks. High remains the default, while choosing
 * Medium or Low avoids downloading and parsing the 25.5 MB high-resolution stream altogether.
 */
function loadGirlCharacterSurfaceData(): Promise<GirlCharacterSurfaceData> {
  if (GIRL_CHARACTER_QUALITY === 'medium') return import('./surfaceDataMedium');
  if (GIRL_CHARACTER_QUALITY === 'low') return import('./surfaceDataLow');
  return import('./surfaceData');
}

/**
 * EYEBALLS, as separate spheres with an iris texture, because vertex colour cannot hold an eye.
 *
 * The head carries its colour per VERTEX, and at the shipped 1.5-3.0 mm cell an eye opening is about
 * five vertices across. An iris is 12 mm: four vertices to hold a pupil, an iris, a limbal ring and the
 * sclera around them. Measured on the built head, the face band has no desaturated cluster at all --
 * the 400 least-saturated vertices spread over the whole face rather than gathering into two eyes,
 * because the four-nearest-neighbour bake averages an eye into the skin around it. That is why the eyes
 * render as flat discs with no iris.
 *
 * The GLB cannot rescue it. Cropping its diffuse at the face's own UVs shows the eyes as two small
 * blurred blobs inside a fragmented atlas, so sampling the source more carefully would not help.
 *
 * A separate eyeball is what character rigs actually do, and it sidesteps both problems: the iris lives
 * in a texture at whatever resolution it needs, and a sphere gives a real specular catchlight and real
 * parallax as the camera moves, which a painted disc never can.
 *
 * POSITIONS ARE MEASURED. The head was rendered with every map stripped, the eye openings read off that
 * image, and those pixels unprojected through the recorded camera onto the head surface -- landing
 * within 2.9 mm of an actual vertex. The interpupillary distance that falls out is 68.6 mm against a
 * human adult's ~63 mm, which is the check that the placement is not nonsense.
 */
/**
 * Shifted 0.7 mm in -x from the measured points, on request: from the front, world +x renders as
 * screen-right (the camera looks down -z with standard up), so both eyes move a little toward
 * screen-left this way. The socket treatments (repaint, cut, near-mask) share this same array, so they
 * move with the eye by the same small amount rather than leaving it mismatched against a fixed centre.
 */
/**
 * Fixed eye geometry for the showcase render. The eyes are surface-anchored domes with an
 * elliptical painted aperture; interactive tuning controls are intentionally kept out of this build.
 */
const EYE_CENTRES: ReadonlyArray<readonly [number, number, number]> = [
  [0.0338, 1.6217, 0.0468],
  [0.1023, 1.6242, 0.0453],
];
const FACE_FORWARD: readonly [number, number, number] = [0.0975, -0.1913, 0.9767];
const EYE_HALF_WIDTH = 0.0092;
const EYE_HALF_HEIGHT = 0.0047;
const EYE_APERTURE_HALF_WIDTH = 0.0087;
const EYE_APERTURE_HALF_HEIGHT = 0.0041;
const EYE_DOWN_REACH = 1.0;
const EYE_RECESS = 0.0028;
const EYE_SET = 0.008;
const EYE_CAP = 0.0014;
const EYE_BULGE = -EYE_RECESS;
const EYE_LIFT = 0.00030;
const EYE_IRIS_RADIUS = 0.0036;

function eyeHalfHeightAt(angle: number, t: number): number {
  const ramp = Math.max(0, Math.min(1, (t - 0.55) / 0.45)) ** 1.2;
  return EYE_HALF_HEIGHT * (1 + (EYE_DOWN_REACH - 1) * Math.max(0, -Math.sin(angle)) * ramp);
}

void EYE_RECESS;

/**
 * Colours taken from the reference eye crop by luminance percentile rather than by picking:
 *
 *     darkest 3%    0x241f1c   lash line and pupil
 *     3-12%         0x4e372f   limbal ring
 *     12-30%        0x61483e   iris body
 *     bluish pixels 0x484a59   the iris hue the GLB bake carries, which is NOT what is drawn here
 *     brightest 8%  0xb39888   sclera carrying the catchlight
 *
 * That crop is lit warm and partly shadowed, so the sclera is lifted here to what an eye reads as in
 * open light. The IRIS is deliberately not the measured hue: it is amber, on request, to bring the
 * face nearer the reference than the bake's grey-blue does.
 */
type EyeSurfaceMaps = { roughness: THREE.CanvasTexture; clearcoat: THREE.CanvasTexture };
let eyeSurfaceMaps: EyeSurfaceMaps | null = null;
/**
 * Where the painted opening is, sampled rather than derived.
 *
 * Two attempts described the opening a second time in order to decide where skin colour starts -- an
 * ellipse at 1.06 of it, then one at 0.88 -- and both disagreed with the cubic almond the texture
 * actually draws. The first left a bright sliver along the top of each eye where the ellipse ran wider
 * than the almond; the second cut a band of skin colour across the iris where it ran narrower. Reading
 * the drawn shape back out of a canvas cannot disagree with itself.
 *
 * 0 inside the opening, 1 on the skin, with the edge softened by the same blur the crease uses.
 */

function eyeTexture(side: number, skin: THREE.Color): THREE.CanvasTexture {
  const S = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const g = canvas.getContext('2d')!;
  const half = S / 2;
  // The dome's edge maps to the edge of this square, so a millimetre converts to pixels by the dome's
  // own half-spans. Everything below is specified in millimetres and drawn through these two.
  const halfWidth = EYE_HALF_WIDTH;
  const halfHeight = EYE_HALF_HEIGHT;
  const apertureHalfWidth = EYE_APERTURE_HALF_WIDTH;
  const apertureHalfHeight = EYE_APERTURE_HALF_HEIGHT;
  const X = (mm: number) => (mm / halfWidth) * half;
  const Y = (mm: number) => (mm / halfHeight) * half;
  const AX = X(apertureHalfWidth); const AY = Y(apertureHalfHeight);

  // The surround is the head's OWN skin colour, sampled from the vertices around this eye, so the dome
  // disappears into the face instead of stamping a swatch onto it. The bake is linear; a canvas is sRGB.
  /**
   * THE SURROUND IS WHITE, and that is what finally removes the seam.
   *
   * It used to be painted with one averaged skin tone, corrected per vertex by a ratio. A ratio can only
   * approximate: the face runs a gradient and the average is right at one radius and wrong everywhere
   * else, so the dome kept reading as a pale patch around each eye. White is neutral -- multiplied by a
   * vertex colour taken straight off the head, the surround IS the face's colour, at every vertex, under
   * every light, with nothing left to tune.
   */
  void skin;
  // ALL EYE. The surround used to be white here so a vertex colour could turn it into skin; the mesh
  // carries no skin any more, so the whole square is sclera and the geometry's own outline is the lid.
  // The outer ellipse is a thin skin insert, so its neutral texel must preserve the head colour from
  // the vertex attribute. Only the aperture below is sclera. Filling the whole insert with sclera is
  // what made the previous result read as two detached shells.
  g.fillStyle = '#bfada2';
  g.fillRect(0, 0, S, S);

  /** The opening is deliberately a rounded ellipse: no pointed corner or detached lid strip. */
  const aperture = (ctx: CanvasRenderingContext2D, grow: number): void => {
    ctx.beginPath();
    ctx.ellipse(half, half, AX * grow, AY * grow, 0, 0, Math.PI * 2);
  };

  // A soft crease and socket shadow sitting just outside the opening, drawn before it so the opening's
  // own edge stays crisp.
  // A whisper of a crease, not the dark ring that was here: enough to seat the opening in the face,
  // little enough that it cannot be mistaken for a mark on the skin.
  g.save();
  g.filter = 'blur(12px)';
  g.fillStyle = 'rgba(120,84,74,0.12)';
  aperture(g, 1.08); g.fill();
  g.restore();

  g.save();
  aperture(g, 1); g.clip();

  // Warmer and darker than paper white. The reference's sclera is barely lighter than the skin.
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, S, S);
  // Faint vessels, so the white is not a flat plastic field when the camera comes close.
  g.strokeStyle = 'rgba(150,90,80,0.18)'; g.lineWidth = 2;
  for (let i = 0; i < 22; i += 1) {
    const a = (i / 22) * Math.PI * 2;
    const r0 = X(EYE_IRIS_RADIUS) * 1.1;
    g.beginPath();
    g.moveTo(half + Math.cos(a) * r0, half + Math.sin(a) * r0 * 0.5);
    g.quadraticCurveTo(half + Math.cos(a) * (r0 + 60), half + Math.sin(a) * (r0 + 20) * 0.5,
                       half + Math.cos(a) * (r0 + 130), half + Math.sin(a) * (r0 + 50) * 0.5);
    g.stroke();
  }

  // The iris is a CIRCLE in millimetres, which on a dome wider than it is tall becomes this ellipse in
  // texture space. It is taller than the aperture, so the clip crops it exactly as a lid does.
  const irisX = X(EYE_IRIS_RADIUS); const irisY = Y(EYE_IRIS_RADIUS);
  g.save();
  g.translate(half, half); g.scale(1, irisY / irisX);
  const iris = g.createRadialGradient(0, 0, irisX * 0.34, 0, 0, irisX);
  // AMBER, warm and light at the pupil, deepening to a dark limbal ring. A flat yellow disc reads as
  // paint; what makes an amber eye look lit is that the inner third is nearly gold while the rim is
  // almost brown, so the gradient does most of the work.
  iris.addColorStop(0, '#c99a4e');
  iris.addColorStop(0.45, '#ab7830');
  iris.addColorStop(0.80, '#7d5220');
  iris.addColorStop(1, '#4a3114');
  g.fillStyle = iris;
  g.beginPath(); g.arc(0, 0, irisX, 0, Math.PI * 2); g.fill();
  // Radial fibres: this is what stops an iris reading as a flat coloured disc up close.
  g.save(); g.beginPath(); g.arc(0, 0, irisX, 0, Math.PI * 2); g.clip();
  for (let i = 0; i < 140; i += 1) {
    const a = (i / 140) * Math.PI * 2;
    g.strokeStyle = i % 2 ? 'rgba(240,205,140,0.22)' : 'rgba(96,64,26,0.22)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(Math.cos(a) * irisX * 0.32, Math.sin(a) * irisX * 0.32);
    g.lineTo(Math.cos(a) * irisX, Math.sin(a) * irisX);
    g.stroke();
  }
  g.restore();
  g.strokeStyle = 'rgba(58,32,8,0.90)'; g.lineWidth = 7;
  g.beginPath(); g.arc(0, 0, irisX - 3, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#141216';
  g.beginPath(); g.arc(0, 0, irisX * 0.36, 0, Math.PI * 2); g.fill();
  g.restore();

  // The upper lid casts onto the globe. Without this the eye reads as a sticker.
  const cast = g.createLinearGradient(0, half - AY, 0, half + AY * 0.15);
  cast.addColorStop(0, 'rgba(70,50,44,0.30)');
  cast.addColorStop(1, 'rgba(70,50,44,0)');
  g.fillStyle = cast; g.fillRect(0, 0, S, S);
  g.restore();

  /**
   * NO LASH LINE. It was a dark band along the aperture's upper edge, and at this surface resolution it
   * did not read as lashes -- it read as a black smear under the eye. Removed on request rather than
   * tuned: a feature that cannot be made to look right is worth less than the skin it is covering.
   */

  // The corners: the medial one pink and blunt, the lateral one dark and tapered. `side` keeps u = 0 on
  // the nose, so this is drawn once for both eyes.
  const corner = (x: number, colour: string, spread: number) => {
    const grad = g.createRadialGradient(x, half, 0, x, half, AX * spread);
    grad.addColorStop(0, colour);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.save(); aperture(g, 1); g.clip();
    g.fillStyle = grad; g.fillRect(0, 0, S, S);
    g.restore();
  };
  // The medial corner keeps a little warmth; the lateral one had a dark tint that read as a black
  // wedge at the eye's tail, so it is now barely there.
  corner(half - AX, 'rgba(158,102,96,0.42)', 0.26);
  corner(half + AX, 'rgba(120,80,72,0.22)', 0.20);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  eyeSurfaceMaps ??= {} as EyeSurfaceMaps;
  /**
   * WETNESS STOPS AT THE OPENING. One material for the whole dome put the cornea's roughness and
   * clearcoat on the SKIN around it, and with the rim normals blended into the face that broad
   * highlight spread over the entire oval -- the dome read as a patch of wet plastic stuck to the
   * cheek. These two maps carry the difference instead: rough and matte outside the aperture, smooth
   * and lacquered inside it.
   */
  const mask = (invert: boolean): THREE.CanvasTexture => {
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const m = c.getContext('2d')!;
    m.fillStyle = invert ? '#000000' : '#ffffff';
    m.fillRect(0, 0, S, S);
    m.save();
    m.filter = 'blur(6px)';
    m.beginPath();
    m.ellipse(half, half, AX, AY, 0, 0, Math.PI * 2);
    m.fillStyle = invert ? '#ffffff' : '#2b2b2b';
    m.fill();
    m.restore();
    const t = new THREE.CanvasTexture(c);
    t.center.set(0.5, 0.5); t.repeat.set(side, 1);
    return t;
  };
  eyeSurfaceMaps.roughness = mask(false);
  eyeSurfaceMaps.clearcoat = mask(true);

  // Mirroring here rather than in the geometry keeps both domes wound the same way, so their normals and
  // their shading match; only the painted asymmetry flips.
  texture.center.set(0.5, 0.5);
  texture.repeat.set(side, 1);
  return texture;
}

/**
 * NEGATIVE RESULT, kept because it cost seven attempts and looked right on paper.
 *
 * A lid was sculpted by snapping the socket's vertices onto a spherical shell concentric with the
 * eyeball and swinging them toward the midline to close the aperture. The reasoning was sound -- a real
 * lid does slide over the globe on a concentric shell -- and it was checked first against a slice
 * ray-cast through BOTH meshes, which showed the slab-like lid is the GLB's own (largest step 8.69 mm
 * in the source against 8.98 mm in ours) rather than the distance field losing a fine feature.
 *
 * It still failed, and rendering the head with the eyeballs hidden is what showed why: moving the skin
 * to chase a ball that does not fit tore the face into ragged flaps around both sockets. The socket is
 * a 33-36 mm bowl, so "the vertices near the eye" is most of the eye region, and pulling that much
 * surface onto a 12 mm shell is not a lid -- it is a crater with torn edges. The dome above replaces it
 * and cannot do this, because it never moves the head's own geometry at all.
 */

/**
 * Repaint the skin around the eye, because the GLB's bake there is the loudest thing in the picture.
 *
 * The head's colour comes from the GLB diffuse, and at the eye that atlas is a fragmented patchwork --
 * cropping it at the face's own UVs shows the eyes as small blurred blobs surrounded by dark blocks.
 * Baked onto vertices it becomes irregular dark blotches around each socket, and side by side with the
 * reference those blotches, not the eyeball, are what stops the eye reading as an eye.
 *
 * The replacement colour is taken from the model itself, not from the photograph: the median of the
 * head vertices in a ring just OUTSIDE the repaint region. That keeps the eye surround continuous with
 * whatever the rest of the face is doing under any lighting, instead of stamping a foreign skin tone
 * into the middle of it. Only the blotches go; the face's own colour stays.
 */
function repaintPeriocular(geometry: THREE.BufferGeometry): number {
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const colour = geometry.attributes.color as THREE.BufferAttribute | undefined;
  if (!colour) return 0;
  const forward = new THREE.Vector3(...FACE_FORWARD).normalize();
  // 2.6x, not 1.9x. The GLB's dark bake runs further under the eye than the dome does, so at 1.9 the
  // repaint stopped short and left a black streak below the lower lid -- reported twice as a dark part
  // under the eye. The fill is still the median of the head's own vertices in the ring outside it, so
  // widening it cannot introduce a swatch that does not belong to the face.
  const inner = EYE_HALF_WIDTH * 2.6;
  const outer = inner * 1.9;
  const p = new THREE.Vector3();
  const rel = new THREE.Vector3();
  let painted = 0;
  for (const centre of EYE_CENTRES) {
    const ball = new THREE.Vector3(centre[0], centre[1], centre[2]);
    // Sample the surrounding ring first, so the fill matches the face rather than a fixed swatch.
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (let i = 0; i < position.count; i += 1) {
      p.fromBufferAttribute(position, i);
      const d = rel.subVectors(p, ball).length();
      if (d < inner || d > outer) continue;
      if (rel.dot(forward) / d < 0.15) continue;
      r += colour.getX(i); g += colour.getY(i); b += colour.getZ(i); n += 1;
    }
    if (n < 40) continue;
    r /= n; g /= n; b /= n;
    for (let i = 0; i < position.count; i += 1) {
      p.fromBufferAttribute(position, i);
      const d = rel.subVectors(p, ball).length();
      if (d > inner || d < 1e-6) continue;
      // FACING IS NOT THE TEST IT LOOKED LIKE. Requiring the vertex to look forward skipped exactly the
      // geometry that needed repainting: the torn cards sit in crevices with their normals turned aside or
      // away, and their baked colour is the darkest thing there. Those marks survived every geometric
      // criterion because they are not geometric -- they are paint -- and they survived the repaint
      // because of this line. Anything not facing directly backwards is repainted now.
      if (rel.dot(forward) / d < -0.55) continue;
      // Full strength at the socket, fading out to nothing where the ring was sampled.
      const w = Math.min(1, Math.max(0, 1 - d / inner)) ** 0.45;
      colour.setXYZ(i,
        colour.getX(i) * (1 - w) + r * w,
        colour.getY(i) * (1 - w) + g * w,
        colour.getZ(i) * (1 - w) + b * w);
      painted += 1;
    }
  }
  if (painted) colour.needsUpdate = true;
  return painted;
}
function surfaceAlongAxis(
  origin: THREE.Vector3, direction: THREE.Vector3,
  position: THREE.BufferAttribute, index: THREE.BufferAttribute, near: Uint8Array,
): THREE.Vector3 | null {
  const a = new THREE.Vector3(); const e1 = new THREE.Vector3(); const e2 = new THREE.Vector3();
  const pv = new THREE.Vector3(); const tv = new THREE.Vector3(); const qv = new THREE.Vector3();
  let best = Infinity;
  for (let t = 0; t < index.count; t += 3) {
    const i0 = index.getX(t); const i1 = index.getX(t + 1); const i2 = index.getX(t + 2);
    if (!near[i0] && !near[i1] && !near[i2]) continue;
    a.fromBufferAttribute(position, i0);
    e1.fromBufferAttribute(position, i1).sub(a);
    e2.fromBufferAttribute(position, i2).sub(a);
    pv.crossVectors(direction, e2);
    const det = e1.dot(pv);
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    tv.subVectors(origin, a);
    const u = tv.dot(pv) * inv;
    if (u < 0 || u > 1) continue;
    qv.crossVectors(tv, e1);
    const v = direction.dot(qv) * inv;
    if (v < 0 || u + v > 1) continue;
    const dist = e2.dot(qv) * inv;
    if (dist > 1e-6 && dist < best) best = dist;
  }
  return Number.isFinite(best) ? origin.clone().addScaledVector(direction, best) : null;
}

/**
 * The pair of eyes, built as domes anchored to the head's own socket rim.
 *
 * The rim ring is sampled straight off `headGeometry`, so the eye meets the skin at shared positions
 * and neither gap nor protrusion is possible -- the failure mode that survived seven rounds of tuning a
 * ball becomes unreachable by construction. The interior lifts to an apex `EYE_BULGE` in front of the
 * rim's centroid on a t-squared profile, which fills the bowl smoothly and reads as a globe.
 *
 * Without the head there is nothing to anchor to, so the loft fallback gets no eyes at all. That is the
 * honest outcome: eyes floating in front of a face that is not there would be worse than none.
 */
function eyeMeshes(options: GirlCharacterOptions, headGeometry?: THREE.BufferGeometry): THREE.Mesh[] {
  if (!headGeometry) return [];
  const position = headGeometry.attributes.position as THREE.BufferAttribute;
  const index = headGeometry.index;
  if (!index) return [];

  const f = new THREE.Vector3(...FACE_FORWARD).normalize();
  const up = new THREE.Vector3(0, 1, 0).addScaledVector(f, -f.y).normalize();
  const RINGS = 7; const SEGMENTS = 64;

  const meshes: THREE.Mesh[] = [];
  EYE_CENTRES.forEach((centre, i) => {
    const origin = new THREE.Vector3(centre[0], centre[1], centre[2]);
    // u = 0 is kept on the nose side of both eyes, so one texture serves both by mirroring.
    const side = i === 0 ? 1 : -1;
    const right = new THREE.Vector3().crossVectors(up, f).multiplyScalar(side);

    // Only triangles near this socket can be hit, and pre-marking them turns the cast from a scan of
    // 108,000 triangles into a scan of a couple of thousand.
    const near = new Uint8Array(position.count);
    const p = new THREE.Vector3();
    for (let v = 0; v < position.count; v += 1) {
      p.fromBufferAttribute(position, v);
      near[v] = p.distanceTo(origin) < EYE_HALF_WIDTH * 2.2 ? 1 : 0;
    }

    // The rim: how far back the face surface is, at the ellipse of tangent offsets around the eye.
    //
    // The raw casts are not usable directly. The bowl's wall is irregular at a 3 mm cell, so neighbouring
    // samples differ by millimetres and a dome built straight onto them comes out spiky -- which is what
    // the first attempt rendered as a torn dark patch. Fitting depth(angle) to its first two harmonics
    // keeps what a rim actually is (an offset, a tilt, and an oval) and discards the rest.
    const back = f.clone().negate();
    const raw: number[] = [];
    for (let s = 0; s < SEGMENTS; s += 1) {
      const a = (s / SEGMENTS) * Math.PI * 2;
      const from = origin.clone()
        .addScaledVector(f, 0.05)
        .addScaledVector(right, Math.cos(a) * EYE_HALF_WIDTH)
        .addScaledVector(up, Math.sin(a) * eyeHalfHeightAt(a, 1));
      const hit = surfaceAlongAxis(from, back, position, index, near);
      raw.push(hit ? hit.clone().sub(origin).dot(f) : 0);
    }
    // ROBUST, and anchored to the FORWARD edge of the ring rather than its middle. Two things go wrong
    // with a plain fit. The casts land on torn lash cards as often as on skin, so one shard 12 mm out of
    // place drags the whole rim with it. And the ring is sampled on the walls of a 20 mm bowl, so its
    // median sits well inside the face -- which sank both domes below the skin, 3.9 mm on one side and
    // 6.2 mm on the other, and the second one vanished into its own socket. Taking a high percentile
    // finds where the bowl meets the face, which is what a rim is; the clamp keeps a shard to one
    // sample's worth of damage instead of the whole eye's.
    const sorted = [...raw].sort((x, y) => x - y);
    const level = sorted[Math.floor(sorted.length * 0.75)];
    const clean = raw.map((d) => Math.min(level + 0.002, Math.max(level - 0.004, d)));
    const coefficients: number[] = [];
    for (let k = 0; k <= 2; k += 1) {
      let cosTerm = 0; let sinTerm = 0;
      for (let s = 0; s < SEGMENTS; s += 1) {
        const a = (s / SEGMENTS) * Math.PI * 2;
        cosTerm += clean[s] * Math.cos(k * a);
        sinTerm += clean[s] * Math.sin(k * a);
      }
      coefficients.push((cosTerm / SEGMENTS) * (k === 0 ? 1 : 2), (sinTerm / SEGMENTS) * (k === 0 ? 1 : 2));
    }
    const rimDepth = (a: number): number => coefficients[0]
      + coefficients[2] * Math.cos(a) + coefficients[3] * Math.sin(a)
      + coefficients[4] * Math.cos(2 * a) + coefficients[5] * Math.sin(2 * a);
    // The apex is tied to the MEASURED eye centre, not to the ring's average depth. Seating it on the
    // ring sank the left dome 6.2 mm below the skin -- that socket's walls are deeper, so its ring
    // average is deeper, and the dome followed the walls down instead of capping them. The centre is a
    // point measured on the face; the ring only says how the rim falls away from it.
    const apex = origin.clone().addScaledVector(f, EYE_BULGE);

    /**
     * NEGATIVE RESULT: sizing the cover to the measured tearing is not worth what it costs.
     *
     * The damage is not elliptical, so the reach was measured per direction -- cast out to 2.4x and find
     * the outermost place the surface departs from its own smoothed profile. That part worked. What broke
     * was everything downstream: the texture is mapped on the dome's (radius, angle), so a span that
     * varies with direction stretches the painted eye, and each attempt to decouple them made it worse --
     * pointed wedges at the corners, then an eye ballooned to twice its size when the texture frame was
     * widened to compensate.
     *
     * The uniform span with a fixed downward reach covers less and keeps the eye the right shape, and a
     * correctly shaped eye with some source debris around it beats a covered one that is the wrong shape.
     */


    /**
     * THE OUTER BAND FOLLOWS THE SOCKET, which is what joins the eye's tail to it.
     *
     * The dome was a smooth dish anchored to the rim, so it BRIDGED the socket: the source's cavity runs
     * deep and reaches past the outer corner toward the temple, and a bridge over a pocket can be looked
     * under. Rendering with the domes hidden proved the dark wedge at the tail is the cavity itself, not
     * the dome and not a hole -- it was there with nothing covering it.
     *
     * So the surface is measured, not fitted: a cast per vertex, smoothed across rings and around the
     * ring. Sampling errors are forgiving here in a way they were not when the same idea was used to
     * decide what to CUT -- a bad sample moves the skin a fraction of a millimetre instead of punching a
     * hole in a cheek. Near the middle the measured surface is ignored and the dish takes over, so the
     * iris sits on something smooth rather than on the cavity's floor.
     */
    const field: number[][] = [];
    for (let r = 0; r <= RINGS; r += 1) {
      const t = r / RINGS;
      const row: number[] = [];
      for (let sIndex = 0; sIndex < SEGMENTS; sIndex += 1) {
        const a = (sIndex / SEGMENTS) * Math.PI * 2;
        const from = origin.clone()
          .addScaledVector(f, 0.05)
          .addScaledVector(right, Math.cos(a) * EYE_HALF_WIDTH * t)
          .addScaledVector(up, Math.sin(a) * eyeHalfHeightAt(a, t) * t);
        const hit = t < 1e-6 ? null : surfaceAlongAxis(from, back, position, index, near);
        row.push(hit ? hit.clone().sub(origin).dot(f) : Number.NaN);
      }
      field.push(row);
    }
    // Fill misses from the ring, then smooth: a cast that missed, or landed on a shard, must not become
    // a spike in the surface.
    for (const row of field) {
      for (let k = 0; k < SEGMENTS; k += 1) {
        if (!Number.isNaN(row[k])) continue;
        let fill = Number.NaN;
        for (let d = 1; d < SEGMENTS && Number.isNaN(fill); d += 1) {
          const left = row[(k - d + SEGMENTS) % SEGMENTS]; const rightValue = row[(k + d) % SEGMENTS];
          fill = !Number.isNaN(left) ? left : rightValue;
        }
        row[k] = Number.isNaN(fill) ? 0 : fill;
      }
    }
    /**
     * MEDIAN FIRST, THEN SMOOTH, and the order is the whole point.
     *
     * Smoothing alone cannot reject an outlier, it AVERAGES it in -- so a shard standing 3 mm forward
     * dragged the estimated surface forward with it, and the shard was then no longer in front of that
     * surface. That circularity is why the shard test could not see the fragments around the eyes: the
     * shard WAS the surface at its own angle. A median over a 5-by-5 neighbourhood discards it instead,
     * because a shard is a few samples among twenty-five. Only then is it worth smoothing, and lightly.
     */
    const median = (r: number, k: number): number => {
      const window: number[] = [];
      for (let dr = -2; dr <= 2; dr += 1) {
        const rr = Math.max(0, Math.min(RINGS, r + dr));
        for (let dk = -2; dk <= 2; dk += 1) {
          window.push(field[rr][(k + dk + SEGMENTS) % SEGMENTS]);
        }
      }
      window.sort((x, y) => x - y);
      return window[window.length >> 1];
    };
    const robust = field.map((row, r) => row.map((_, k) => median(r, k)));
    for (let r = 0; r <= RINGS; r += 1) for (let k = 0; k < SEGMENTS; k += 1) field[r][k] = robust[r][k];
    for (let pass = 0; pass < 2; pass += 1) {
      const previous = field.map((row) => [...row]);
      for (let r = 0; r <= RINGS; r += 1) {
        for (let k = 0; k < SEGMENTS; k += 1) {
          const around = 0.5 * previous[r][(k - 1 + SEGMENTS) % SEGMENTS] + 0.5 * previous[r][(k + 1) % SEGMENTS];
          const across = 0.5 * previous[Math.max(0, r - 1)][k] + 0.5 * previous[Math.min(RINGS, r + 1)][k];
          field[r][k] = 0.5 * previous[r][k] + 0.25 * around + 0.25 * across;
        }
      }
    }

    // The surround colour comes from the head's own vertices in a ring just outside the dome, for the
    // same reason the periocular repaint samples rather than picks: a fixed swatch is right under one
    // light and wrong under every other.
    const skin = new THREE.Color(0.62, 0.44, 0.38);
    const colour = headGeometry.attributes.color as THREE.BufferAttribute | undefined;
    if (colour) {
      let sr = 0; let sg = 0; let sb = 0; let n = 0;
      const probeSkin = new THREE.Vector3();
      for (let v = 0; v < position.count; v += 1) {
        probeSkin.fromBufferAttribute(position, v);
        const d = probeSkin.distanceTo(origin);
        if (d < EYE_HALF_WIDTH * 1.15 || d > EYE_HALF_WIDTH * 1.9) continue;
        sr += colour.getX(v); sg += colour.getY(v); sb += colour.getZ(v); n += 1;
      }
      if (n >= 20) skin.setRGB(sr / n, sg / n, sb / n);
    }

    /**
     * BUILT BEFORE THE VERTICES, because it is what tells them where the eye ends.
     *
     * It used to be created down in the material, which runs after this loop -- so the FIRST eye found no
     * mask, took skin colour across its whole opening and rendered as a grey smear, while the second one
     * was fine. A singleton filled in as a side effect is only correct if everything that reads it runs
     * afterwards, and here half of it did not.
     */
    const painted = eyeTexture(side, skin);
    const colours: number[] = [];
    const renderedDepthAt = (u: number, v: number): number => {
      const t = Math.min(1, Math.hypot(u, v));
      return -EYE_SET + EYE_CAP * (1 - t * t);
    };
    /**
     * NEGATIVE RESULT: the torn socket cannot be repaired from here, and two attempts made it worse.
     *
     * Rendering with the domes hidden proved the damage is in the head itself -- stepped plates and
     * ragged ridges around both sockets, present with nothing covering them. The obvious repair was to
     * denoise it: move each vertex onto the smoothed surface measured through it, weights fading to
     * nothing at the edge so nothing could separate.
     *
     * First version moved every vertex in the region and ringed both eyes with jagged craters: the
     * socket's interior walls and the slab behind them are legitimately 10-20 mm deep, and pulling them
     * onto the FRONT surface turns the mesh inside out. Limiting it to vertices already within 3 mm --
     * a real denoise rather than a projection -- still came back as stipple, because the measured field
     * is itself built from casts that land on the plates, and a median around a radial band cannot
     * reject them where they are dense.
     *
     * So the geometry stays as the source made it. What is fixable from here is covering and colour,
     * which the dome and the repaint do. What is not is the tearing, and that has to be fixed where it
     * happens: node 9 rebuilt at a finer cell, or the GLB's lash and eye primitives dropped before the
     * field is splatted. Both are in scripts/build_head_surface.py and both need numpy, which is not
     * installed here.
     */
    /**
     * NO SKIRT. It existed only to block the line of sight through the cut, and there is no cut now.
     * Keeping it would be invisible geometry adding visible thickness at the rim, which is the other
     * thing being complained about.
     */
    const positions: number[] = []; const uvs: number[] = []; const indices: number[] = [];
    const steps: Array<{ t: number; floor: number; follow: number }> = [];
    for (let r = 0; r <= RINGS; r += 1) steps.push({ t: r / RINGS, floor: 0, follow: 0 });

    for (const step of steps) {
      const t = step.t;
      for (let s = 0; s < SEGMENTS; s += 1) {
        const a = (s / SEGMENTS) * Math.PI * 2;
        const capT = Math.min(1, t);
        /**
         * A CLEAN SPHERICAL CAP, following nothing.
         *
         * The surface used to follow the measured socket from mid-radius outward, which was right while
         * the mesh was a large patch that had to sit flush with the face. Now that it is only the eye, all
         * that following does is copy the socket's TEARING into the eye: rendered on its own the pair came
         * out as irregular blobs with the iris off centre. An eyeball is a sphere and does not take the
         * shape of the hole it sits in.
         */
        const along = renderedDepthAt(capT * Math.cos(a), capT * Math.sin(a));
        void field; void rimDepth; void EYE_BULGE; void EYE_LIFT;
        const x = Math.cos(a) * EYE_HALF_WIDTH * t;
        const y = Math.sin(a) * eyeHalfHeightAt(a, t) * t;
        const q = origin.clone()
          .addScaledVector(right, x)
          .addScaledVector(up, y)
          .addScaledVector(f, along);
        void step; void apex;
        positions.push(q.x, q.y, q.z);
        /**
         * UV IN MILLIMETRES, ON A FIXED FRAME -- not in the dome's own (radius, angle).
         *
         * This is the tension every previous pass kept rediscovering: the cover has to be large and
         * irregular to hide torn geometry, but the painted eye lived in the same parametrisation, so
         * every enlargement stretched it. Widening the dome turned the pupils into slits; sizing it to
         * the measured tearing pulled each eye out into a spike. Mapping the texture on millimetres
         * against a FIXED reference span decouples them: the geometry can take any shape that covers the
         * damage and the painted eye keeps its size and proportions exactly.
         */
        uvs.push(0.5 + 0.5 * capT * Math.cos(a), 0.5 - 0.5 * capT * Math.sin(a));
        /**
         * WHITE OVER THE OPENING, THE FACE'S OWN COLOUR OUTSIDE IT, with the boundary read back from the
         * canvas the eye is painted on. No second description of the shape, so no way for the two to
         * disagree.
         */
        // Eye-only mode: no artificial skin/lid band is painted onto the face.
        colours.push(1, 1, 1);
      }
    }
    for (let r = 0; r < steps.length - 1; r += 1) {
      for (let s = 0; s < SEGMENTS; s += 1) {
        const s1 = (s + 1) % SEGMENTS;
        const a0 = r * SEGMENTS + s; const b0 = r * SEGMENTS + s1;
        const a1 = (r + 1) * SEGMENTS + s; const b1 = (r + 1) * SEGMENTS + s1;
        // WINDING FOLLOWS THE BASIS. `right` is flipped for the left eye to keep u = 0 on the nose,
        // which makes that basis left-handed -- so a fixed winding turns that dome inside out and
        // back-face culling makes it invisible. It rendered as an empty socket showing the inside of the
        // head, and widening the cut to look for something in front of it changed nothing, because
        // nothing was in front of it.
        if (side > 0) indices.push(a0, a1, b1, a0, b1, b0);
        else indices.push(a0, b1, a1, a0, b0, b1);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const eyeMaterial = new THREE.MeshPhysicalMaterial({
      map: painted,
      vertexColors: true,
      // THE MAPS CARRY THE DIFFERENCE, because one set of numbers cannot. A cornea is wet and a cheek is
      // not, and this one mesh is both: a single roughness put the eye's gloss on the skin around it,
      // and once the rim normals were blended into the face that highlight spread over the whole oval
      // and the dome read as wet plastic stuck to the cheek. Roughness is near 1 on the surround and
      // near 0.17 over the opening; clearcoat exists only inside it.
      // The tiny outer skin margin is matte; the elliptical aperture carries the wet eye highlight.
      roughness: 0.88,
      roughnessMap: eyeSurfaceMaps?.roughness,
      metalness: 0,
      clearcoat: 0.70,
      clearcoatMap: eyeSurfaceMaps?.clearcoat,
      clearcoatRoughness: 0.12,
      // Node 9 contains source shards in front of the socket. The reconstructed insert owns this
      // bounded eye footprint, so the source cannot punch back through the sclera or lid band.
      depthTest: true,
      depthWrite: true,
      wireframe: options.wireframe ?? false,
      side: THREE.DoubleSide,
    });
    // One continuous material is intentional: no second raised lid layer is introduced.
    const mesh = new THREE.Mesh(geometry, eyeMaterial);
    mesh.name = i === 0 ? 'eye, character right' : 'eye, character left';
    mesh.userData.region = 'hair';
    mesh.userData.moduleNode = HEAD_NODE;
    mesh.userData.explodeWithParent = true;
    mesh.userData.rigTo = 'head';
    mesh.castShadow = false;
    mesh.receiveShadow = options.receiveShadow ?? true;
    mesh.renderOrder = 12;
    meshes.push(mesh);
  });
  return meshes;
}

type SdfSurface = {
  node: number; region: string; cellMillimetres: number;
  position: Float32Array; colour: Uint8Array; index: Uint32Array;
};
let sdfSurfaces: SdfSurface[] | null = null;
let sdfPromise: Promise<void> | null = null;

export function prewarmGirlCharacter(): Promise<void> {
  if (SDF_NODES.size === 0) return Promise.resolve();
  sdfPromise ??= (async () => {
    /**
     * NOTHING IS FETCHED. The surfaces used to be a 107.6 MB binary downloaded at runtime; they now
     * arrive inside the bundle as an encoded stream and are rebuilt here. surfaceCodec.ts documents the
     * encoding and why it is a fifth of the binary: Surface Nets puts one vertex per voxel cell, so the
     * index buffer follows from cell adjacency and the normals follow from the triangles -- 75.6 MB of
     * the original file is derivable rather than stored.
     *
     * This is still async, and deliberately so. Decoding half a million vertices takes long enough to
     * drop a frame, and every caller already handles the promise; making it synchronous would move the
     * cost into the click that opens the demo.
     */
    const surfaceData = await loadGirlCharacterSurfaceData();
    const decoded: DecodedSurface[] = decodeSurfaces(
      surfaceData.SURFACE_STREAM,
      surfaceData.SURFACE_NODES,
    );
    const out: SdfSurface[] = decoded.map((surface) => ({
      node: surface.node,
      region: surface.region,
      cellMillimetres: surface.cellMillimetres,
      position: surface.position,
      colour: surface.colour,
      index: surface.index,
    }));
    // The loft skips SDF_NODES unconditionally, so a stream that does not cover exactly those nodes
    // would leave a hole in the figure rather than a wrong-looking part. Fail loudly instead.
    const covered = new Set(out.map((e) => e.node));
    for (const node of SDF_NODES) {
      if (!covered.has(node)) throw new Error(`encoded surfaces are missing node ${node}`);
    }
    sdfSurfaces = out;
  })();
  return sdfPromise;
}

function sdfMeshes(options: GirlCharacterOptions): THREE.Mesh[] {
  if (!sdfSurfaces) return [];
  const wire = options.wireframe ?? false;
  return sdfSurfaces.map((s) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(s.position, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(s.colour, 3, true));
    geometry.setIndex(new THREE.BufferAttribute(s.index, 1));
    // Normals are not carried in the stream -- they are 25 MB of the original file and follow from the
    // triangles, so they are recomputed here.
    geometry.computeVertexNormals();
    // The head gets the eye dots painted in. The colour array is COPIED first: it comes straight out of
    // the fetched buffer and is shared with every other build of this mesh, so painting the original
    // would darken the eyes again on each rebuild until they turned into black patches.
    // The head's colour is repainted around the eyes. Only the colour is copied first -- the typed array
    // comes straight out of the decoded stream and is shared with any other build of this mesh.
    if (s.node === HEAD_NODE) {
      geometry.setAttribute('color', new THREE.BufferAttribute(s.colour.slice(), 3, true));
      repaintPeriocular(geometry);
      geometry.computeVertexNormals();
    }
    // One material driven by the colour attribute. `color` must be white or it would tint the bake;
    // roughness and metalness stay the GLB's declared figures for the region.
    const material = materialFor(s.region, wire).clone();
    material.color.setRGB(1, 1, 1);
    material.vertexColors = true;
    material.needsUpdate = true;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = PART_LABEL[s.node] ?? s.region;
    mesh.userData.region = s.region;
    mesh.userData.moduleNode = s.node;
    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? true;
    mesh.userData.sdfSurface = {
      method: "signed distance field from this node's GLB point cloud, contoured with Surface Nets",
      cellMillimetres: s.cellMillimetres,
      vertices: s.position.length / 3,
      triangles: s.index.length / 3,
    };
    return mesh;
  });
}

export function createGirlCharacterModel(options: GirlCharacterOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'girl-character-procedural';

  const byRegion = new Map<string, THREE.Group>();
  const destructionGroups: Record<string, string[]> = {};
  let meshCount = 0;
  let studCount = 0;
  const fastenersDone = new Set<string>();
  for (const [region, sections] of Object.entries(CROSS_SECTIONS)) {
    const meshes = loftedMeshesFor(region, sections, options, SDF_NODES);
    if (meshes.length === 0) continue;
    for (const mesh of meshes) {
      // `crossSection` is absent on AUTHORED geometry -- the facial features are built, not lofted,
      // so they carry `moduleNode` instead of a slice provenance they never had. Reading the lofted
      // field unconditionally threw and left the whole demo blank.
      const node = (mesh.userData.crossSection as { nodeIndex?: number } | undefined)?.nodeIndex
        ?? (mesh.userData.moduleNode as number | undefined);
      const module = NODE_MODULE[node as number] ?? 'body';
      (destructionGroups[module] ??= []).push(mesh.name);
    }
    const group = new THREE.Group();
    group.name = `region-${region}`;
    for (const mesh of meshes) group.add(mesh);
    byRegion.set(region, group);
    root.add(group);
    meshCount += meshes.length;
  }

  // The head, which the loft above deliberately skipped. `build()` cannot await, so this adds the
  // surface if prewarm already resolved and otherwise attaches it when it does -- the same contract the
  // GLB baseline demo uses. Kept inside the `hair` group so per-region IoU, area, centroid and the
  // part list all keep their existing meaning.
  // The implicit-surface nodes, which the loft above deliberately skipped. `build()` cannot await, so
  // this attaches them if prewarm already resolved and otherwise when it does -- the contract the GLB
  // baseline demo already uses.
  //
      // Region groups must be created even when the loft emitted nothing for them: `hair` has exactly one
  // node (9), so skipping it left the region empty, the `meshes.length === 0` guard above skipped it,
  // and there was nowhere to attach the head. It silently vanished and hair IoU measured 0.000 while
  // every other region still looked fine.
  const groupFor = (region: string): THREE.Group => {
    let group = byRegion.get(region);
    if (!group) {
      group = new THREE.Group();
      group.name = `region-${region}`;
      byRegion.set(region, group);
      root.add(group);
    }
    return group;
  };
  {
    const attach = () => {
      // The eyes anchor to the head's surface, so the head has to exist before they can be built.
      const surfaces = sdfMeshes(options);
      const head = surfaces.find((m) => m.userData.moduleNode === HEAD_NODE);
      const eyes = eyeMeshes(options, head?.geometry);
      for (const mesh of [...surfaces, ...eyes]) {
        groupFor(mesh.userData.region as string).add(mesh);
        meshCount += 1;
        const module = NODE_MODULE[mesh.userData.moduleNode as number] ?? 'body';
        (destructionGroups[module] ??= []).push(mesh.name);
      }
      addFasteners();
    };
    if (sdfSurfaces) attach();
    else {
      void prewarmGirlCharacter().then(attach).catch((error: unknown) => {
        // FALL BACK TO THE LOFT, and say so. Swallowing this used to leave the demo COMPLETELY EMPTY --
        // 0 meshes, 0 triangles, parts panel hidden, explode hidden -- because the loft skips every
        // node the binary was meant to supply. The comment here previously claimed the error was
        // "surfaced by the demo page"; nothing surfaced it.
        //
        // Vite's dev server answers a missing asset with index.html rather than a 404, so `res.ok` is
        // true and the failure only shows up at the magic check: "bad magic <!do". A status check alone
        // would not have caught it.
        console.error('[girl-character] implicit surfaces unavailable, falling back to the '
          + 'cross-section loft:', error);
        for (const [region, sections] of Object.entries(CROSS_SECTIONS)) {
          const meshes = loftedMeshesFor(region, sections, options, new Set<number>());
          if (!meshes.length) continue;
          const group = groupFor(region);
          for (const mesh of meshes) {
            group.add(mesh);
            meshCount += 1;
            const node = (mesh.userData.crossSection as { nodeIndex?: number } | undefined)?.nodeIndex
              ?? (mesh.userData.moduleNode as number | undefined);
            (destructionGroups[NODE_MODULE[node as number] ?? 'body'] ??= []).push(mesh.name);
          }
        }
        addFasteners();
      });
    }
  }

  // Authored hardware, added to the region group its measurements came from so the semantic-ID pass
  // scores it as part of that region rather than as a separate thing.
  //
  // A FUNCTION, because it has to run again after a fallback. It requires the region groups to exist,
  // and on the implicit-surface path those are created by the async attach above -- so calling it once
  // at build time dropped all 109 measured studs silently whenever the surfaces had not arrived yet.
  function addFasteners(): void {
    const byFamily = new Map<string, Stud[]>();
    for (const stud of STUDS) {
      if (!byRegion.has(stud.region)) continue;
      const key = `${stud.region}|${stud.family}`;
      let arr = byFamily.get(key);
      if (!arr) byFamily.set(key, (arr = []));
      arr.push(stud);
    }
    for (const [key, studs] of byFamily) {
      // Idempotent: this runs once at build time and again after the async attach, because on the
      // implicit-surface path the region groups do not exist yet at build time and all 109 measured
      // studs were being dropped in silence.
      if (fastenersDone.has(key)) continue;
      fastenersDone.add(key);
      const [region, family] = key.split('|') as [string, 'brass' | 'iron'];
      byRegion.get(region)!.add(fastenerMesh(region, family, studs, options));
      studCount += studs.length;
    }
  }
  addFasteners();

  /**
   * ANIMATION, and this is the one part of the demo the GLB could not supply: it declares
   * `animations: 0`, `skins: 0`, and no JOINTS_0/WEIGHTS_0 on any primitive. Every joint, weight and
   * pose is computed in walkRig.ts.
   *
   * The rig is built on the FIRST PLAY, not at build time, for two reasons. Skinning weights cost one
   * distance test per vertex per bone -- 2.1 M vertices against 19 segments on the implicit-surface
   * path -- which is not worth paying for a visitor who never presses a button. And the meshes do not
   * exist yet at build time on that path; they arrive through `prewarm`.
   *
   * `tick` is registered here and not later because the viewer collects tickers ONCE, when it starts.
   * Registering it after the geometry lands would leave it uncollected and the model frozen.
   */
  let rig: WalkRig | null = null;
  let rest: RestPose | null = null;
  let active = 'idle';
  let phase = 0;
  const listeners = new Set<(name: string) => void>();
  const ensureRig = (): boolean => {
    if (rig) return true;
    rig = buildWalkRig(root);
    if (!rig) return false;
    rest = captureRest(rig);
    return true;
  };
  const animationController = {
    actions: [
      { id: 'walk', label: 'Walk', loop: true },
      { id: 'idle', label: 'Idle', loop: true },
    ] as const,
    get active(): string { return active; },
    play(name: string): void {
      if (!ensureRig()) return;
      active = name;
      phase = 0;
      for (const l of listeners) l(active);
    },
    stop(): void {
      active = 'idle';
      phase = 0;
      if (rig && rest) {
        for (const [boneName, bone] of rig.bones) {
          const q = rest.get(boneName);
          if (q) bone.quaternion.copy(q);
        }
        rig.root.position.y = (rig.root.userData.restY as number | undefined) ?? rig.root.position.y;
        rig.root.updateMatrixWorld(true);
        // The fasteners ride the bones rigidly, so returning the bones without returning them leaves
        // 104 studs stranded at whatever pose the cycle stopped on.
        poseAttachments(rig);
      }
      for (const l of listeners) l(active);
    },
    subscribe(listener: (name: string) => void): () => void {
      listeners.add(listener);
      listener(active);
      return () => listeners.delete(listener);
    },
  };
  /**
   * Cycles per second. 1.35 m/s over a 0.72 m stride is 1.88 Hz, which is a brisk march and reads as
   * hurried on a figure standing in place with nothing passing behind it. 0.62 m/s is a stroll, and at
   * this stride that is 0.86 Hz.
   */
  const WALK_HZ = 0.62 / 0.72;
  root.userData.tick = (dt: number): void => {
    if (!rig || !rest || active === 'idle') {
      if (rig && rest && active === 'idle') {
        phase = (phase + dt * 0.18) % 1;
        poseIdle(rig, rest, phase);
      }
      return;
    }
    if (active === 'walk') {
      phase = (phase + dt * WALK_HZ) % 1;
      poseWalk(rig, rest, phase);
    }
  };

  /**
   * Three measured display-quality levels. Each is a complete Surface Nets reconstruction, not a
   * runtime triangle drop: the coarser grids preserve closed surfaces and therefore do not punch holes
   * into the face, clothing, or armour. The selected stream is lazy-loaded in its own Vite chunk.
   *
   *     mode    triangles     encoded stream
   *     High    4,220,724     25.5 MB
   *     Medium    986,548      5.9 MB
   *     Low       410,448      2.5 MB
   *
   * The legacy `?sdf=0` cross-section loft remains accepted for old comparison scripts, but it is not
   * presented as a quality mode because it is a different reconstruction path.
   */
  const detailLevels = {
    current: GIRL_CHARACTER_QUALITY,
    options: [
      { id: 'high', label: 'High',
        note: '4.22M triangles · maximum facial, cloth and armour detail' },
      { id: 'medium', label: 'Medium',
        note: '986K triangles · balanced visual quality and GPU cost' },
      { id: 'low', label: 'Low',
        note: '410K triangles · strongest reduction while keeping closed silhouettes' },
    ],
  } as const;

  root.userData.sculptRuntime = {
    animationController,
    detailLevels,
    pass: 'optimization-pass',
    passesComplete: 8,
    regions: [...byRegion.keys()].sort(),
    meshCount,
    studCount,
    figureHeight: FIGURE_BOUNDS.height,
    provenance:
      "every ring is a convex hull of the corresponding GLB node's own vertex cloud, sliced by height "
      + 'and resampled onto fixed spokes; the baseline is used as the 3D asset it is rather than for '
      + 'its bounding boxes',
    destructionGroups,
    limitations: [
      'convex per horizontal slice, so finger gaps, a cupped palm and the inside of a sleeve fill in',
      'twelve slices per node, so any feature thinner than one band is averaged away',
      'region LABELS come from the reference photograph where a node merges several parts (node 1 '
        + 'carries belt, bra and bare skin); region SHAPES come only from the GLB',
      'the GLB and the photograph are different assets — the GLB hangs its belt gear lower, puts the '
        + 'hip glove behind the trouser front face, and gives a boot 0.134 wide against the '
        + "photograph's 0.183 — so front-view agreement is bounded by that difference, not by this code",
      'no textures anywhere in this pipeline, so leather grain, fabric weave and metal scuffs are absent',
      'hardware studs are AUTHORED, not extracted: the baseline mesh has zero surface relief (a 4 mm '
        + 'z-scan found no bump above 1.5 mm), so bolt positions come from the photograph and depth '
        + "from the baseline's front surface",
      'no subsurface scattering; skin uses clearcoat over a warm base as the documented approximation',
    ],
  };
  return root;
}

export function createGirlCharacterLookDevLights(): THREE.Group {
  const lights = new THREE.Group();
  lights.name = 'girl-character-lookdev';
  lights.add(new THREE.HemisphereLight(0xf2f4f8, 0x14100e, 0.58));
  const key = new THREE.DirectionalLight(0xfff4e8, 0.62);
  key.position.set(1.6, 3.0, 2.6);
  key.castShadow = true;
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xbfd0ff, 0.42);
  fill.position.set(-2.2, 1.4, 1.2);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xffd9a8, 0.26);
  rim.position.set(-0.8, 2.0, -3.0);
  lights.add(rim);
  return lights;
}
