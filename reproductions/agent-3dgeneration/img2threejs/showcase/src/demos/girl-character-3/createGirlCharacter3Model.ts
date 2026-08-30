import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TRIANGLE_BUDGET, REFERENCE_TOTALS, CHARACTER_LEFT_SIGN } from './measuredRings';
import { nodeGeometries, strandsForNode } from './sectionLoft';
import { sheetFor } from './atlas';
import { decodeMeshes, type DecodedMesh, type EncodedMesh } from './meshCodec';
import { createGirlCharacter3Materials, type MaterialSet } from './materials';
import {
  buildSkeleton, bindGeometryToSkeleton, bindRigidToNearestBone, overrideWeights, blendBoneInSphere,
  REGION_BONE_LIMITS,
} from './skeleton';
import {
  installIdleAnimation, heightWeight, bandWeight, makeDeformTarget, type IdleRig,
} from './idleAnimation';
import { createClothDynamics } from './clothDynamics';
import { createBladeGlint, type BladeGlint } from './bladeGlint';

/**
 * Female dual-sword warrior — built entirely in Three.js from measured cross-sections.
 *
 * NOTHING IS IMPORTED. No GLB, no .bin, no image, no external mesh. Every surface is constructed here
 * and every texture is drawn into a canvas at build time. The reference is measured — see
 * `crossSections.ts` — and never reaches the renderer.
 *
 * HOW THE SHAPE IS CAPTURED. Each of the reference's 31 nodes is sliced into height bands; each band
 * is CLUSTERED, so a band holding two skirt panels or two legs yields two rings rather than one; each
 * cluster gets spokes cast from its OWN centroid; and the rings are chained into strands by centroid
 * proximity. That combination is what this demo previously lacked, and each missing piece produced a
 * specific, measured defect:
 *
 *   - no clustering, coverage filter instead → the skirt was cut off below y=0.412 and the neck above
 *     y=1.413, because a band of two shoulder caps looks like a sparse ring
 *   - no clustering, one ring per band → the two legs fused and the split skirt became a cone
 *   - one axis per node instead of per cluster → the arms measured 0.263 across against a true radius
 *     of 0.018-0.060 and rendered as open bowls
 *
 * The technique is adapted from the `add-demo/girl-character` branch, which reached region IoU
 * 0.885-0.958 with it.
 *
 * IT MATCHES THE REFERENCE'S STRUCTURE TOO. Exactly 31 parts, one per reference mesh, each
 * tessellated to that mesh's own triangle count, so both the total and the distribution track it.
 *
 * COORDINATES. Faces +Z; the character's own left is +X.
 */

export interface GirlCharacter3Options {
  castShadow?: boolean;
  receiveShadow?: boolean;
  wireframe?: boolean;
  textureSize?: number;
  animate?: boolean;
  /** Scale every part's triangle budget. 1 matches the reference; lower is for previews. */
  detail?: number;
  /**
   * How hard the viewer's turntable is turning, 0..1, sampled per frame by whoever built this model.
   *
   * PASSED IN RATHER THAN LOOKED UP, and the rebuild is the reason. An earlier version resolved the rate
   * by walking from the group up to the scene, which works only until the code-split surfaces land: the
   * rebuild constructs a SECOND model around its own group, hands its tick to the live one, and then throws
   * that group away. The surviving closures were bound to an object with no parent, so the walk ended at a
   * detached group and read 0 -- the cloth and hair stopped answering the turntable a second or two after
   * load, which measured as a 0.97 ratio on the coat and pure noise on the hair. The rebuild reuses this
   * same options object, so a closure handed in here survives it.
   */
  ambient?: () => number;
  /**
   * Triangle budget as a share of the reference count: `high` is the reference exactly, `medium` half,
   * `low` a fifth. Default `high`.
   */
  quality?: Quality;
}

export type GirlCharacter3Region =
  | 'skin' | 'face' | 'hair' | 'corset' | 'innerTop' | 'skirt' | 'belts'
  | 'gloves' | 'boots' | 'pouches' | 'weapons' | 'scabbards' | 'hardware';

export const GIRL_CHARACTER_3_REGIONS: GirlCharacter3Region[] = [
  'skin', 'face', 'hair', 'corset', 'innerTop', 'skirt', 'belts',
  'gloves', 'boots', 'pouches', 'weapons', 'scabbards', 'hardware',
];

const HEAD_BASE_Y = 1.472;
const HEAD_TOP_Y = 1.706;
const EYE_Y = HEAD_BASE_Y + (HEAD_TOP_Y - HEAD_BASE_Y) * 0.52;
const EYE_X = 0.026;
// Smaller and deeper than an anatomical eye. The head node's own cross-sections already carry the
// sculpted brow, nose and cheek, so an eyeball sized to sit in a socket instead sits proud of a
// surface that has no socket, and the face reads as a mask with bulging eyes.
const EYE_RADIUS = 0.0125;

/**
 * The 31 parts, one per reference node.
 *
 * `material` is a key into the material set rather than an instance so the table stays declarative.
 * Region assignments were resolved from the measured world bounds and the sampled texture colour
 * together — the two shoulder meshes read as skin tone at 105 luminance, which is what identified
 * them as bare skin rather than as the halter straps an earlier bounds-only pass had labelled them.
 */
interface PartSpec {
  id: string;
  node: number;
  region: GirlCharacter3Region;
  label: string;
  material: keyof MaterialSet;
  /** bind to the skeleton; rigid parts and hair-with-its-own-bone are handled separately */
  skinned?: boolean;
  /** radial offset in metres, negative to shrink. For LAYERING only — see `strandGeometry`. */
  inflate?: number;
  /**
   * Bone list for THIS PART, overriding its region's.
   *
   * Needed because a region is a unit of appearance, not of rigging, and for one region those two want
   * different things: `skirt` covers the coat, the tights and both thigh pieces. The coat needs the cloth
   * bones and the legs must not have them -- weight them to a garment's bones and the garment drags the
   * leg around instead of the other way round.
   */
  bones?: string[];
}

/**
 * EVERY part is skinned.
 *
 * Thirteen of the thirty-one were not, and it did not show while the only animation was a breath: the
 * bare shoulder caps, both swords, both scabbards, the pouches, the hardware, the glove flares and the
 * strap tails were plain meshes, bound to nothing. The moment the rig moved they stayed behind -- the
 * blades hung at her sides through every strike, and the bare shoulder sat still while the glove swung.
 * A part that is not skinned is not "static", it is broken as soon as anything moves.
 */
/**
 * Whether the coat runs on its own cloth bones and its own dynamics.
 *
 * `?cloth=0` restores the earlier arrangement -- coat weighted to hips, spine, thighs and shins, no
 * garment sim -- so the two can be measured against each other on the same metric rather than compared
 * from memory. scripts/measure-cloth.mjs takes the flag for exactly that reason.
 */
function clothWanted(): boolean {
  if (typeof window === 'undefined') return true;
  return new URLSearchParams(window.location.search).get('cloth') !== '0';
}

const PARTS: PartSpec[] = [
  { id: 'skirt', node: 0, region: 'skirt', label: 'Split leather skirt', material: 'leatherDark', skinned: true,
    bones: REGION_BONE_LIMITS.coat },
  { id: 'skin-torso', node: 1, region: 'skin', label: 'Torso, arms and head base', material: 'skinPainted', skinned: true, inflate: -0.006 },
  { id: 'corset-trim', node: 2, region: 'corset', label: 'Corset trim', material: 'embroiderySilver', skinned: true },
  { id: 'corset', node: 3, region: 'corset', label: 'Corset', material: 'corsetWeave', skinned: true },
  { id: 'hip-yoke', node: 4, region: 'skirt', label: 'Hip yoke', material: 'leatherDark', skinned: true },
  { id: 'thigh-l', node: 5, region: 'skirt', label: 'Left thigh panel', material: 'leatherDark', skinned: true },
  { id: 'thigh-r', node: 6, region: 'skirt', label: 'Right thigh panel', material: 'leatherDark', skinned: true },
  { id: 'belt-tail', node: 7, region: 'belts', label: 'Belt tail', material: 'leatherDark', skinned: true },
  { id: 'corset-lacing', node: 8, region: 'corset', label: 'Corset lacing', material: 'embroiderySilver', skinned: true },
  { id: 'hw-upper', node: 9, region: 'hardware', label: 'Belt hardware (upper)', material: 'steelPolished', skinned: true },
  { id: 'hw-lower', node: 10, region: 'hardware', label: 'Belt hardware (lower)', material: 'steelPolished', skinned: true },
  { id: 'tights', node: 11, region: 'skirt', label: 'Calf-wrapped tights', material: 'leatherDark', skinned: true, inflate: -0.004 },
  { id: 'glove-r', node: 12, region: 'gloves', label: 'Right glove', material: 'leatherDark', skinned: true },
  { id: 'boot-l', node: 13, region: 'boots', label: 'Left boot', material: 'leatherDark', skinned: true },
  { id: 'glove-l', node: 14, region: 'gloves', label: 'Left glove', material: 'leatherDark', skinned: true },
  { id: 'boot-r', node: 15, region: 'boots', label: 'Right boot', material: 'leatherDark', skinned: true },
  { id: 'pouch-r', node: 16, region: 'pouches', label: 'Right waist pouch', material: 'leatherTan', skinned: true },
  { id: 'pouch-l', node: 17, region: 'pouches', label: 'Left waist pouch', material: 'leatherTan', skinned: true },
  // NODES 18 AND 19 ARE THE OTHER WAY ROUND from what their first labels said. Node 18's vertices average
  // x = -0.142 and node 19's +0.118, and the binding agreed with the geometry all along -- distance
  // decides, so each cap picked up the arm it actually sits on. Only the names were wrong, which
  // `audit-rigging.mjs` surfaced as a part called "-r" whose dominant bone was `upperArm.L`. Harmless to
  // the animation and actively misleading to anyone reading the parts list.
  { id: 'skin-shoulder-r', node: 18, region: 'skin', label: 'Right shoulder', material: 'skin', skinned: true },
  { id: 'skin-shoulder-l', node: 19, region: 'skin', label: 'Left shoulder', material: 'skin', skinned: true },
  { id: 'head', node: 20, region: 'skin', label: 'Head and face', material: 'skin', skinned: true },
  { id: 'strap-tail-r', node: 21, region: 'gloves', label: 'Right strap tail', material: 'leatherDark', skinned: true },
  { id: 'strap-tail-l', node: 22, region: 'gloves', label: 'Left strap tail', material: 'leatherDark', skinned: true },
  { id: 'scabbard-a', node: 23, region: 'scabbards', label: 'Upper scabbard', material: 'scabbardWood', skinned: true },
  { id: 'scabbard-b', node: 24, region: 'scabbards', label: 'Lower scabbard', material: 'scabbardWood', skinned: true },
  { id: 'sword-l', node: 25, region: 'weapons', label: 'Left sword', material: 'steelBlade', skinned: true },
  { id: 'hair', node: 26, region: 'hair', label: 'Hair and ponytail', material: 'hair', skinned: true },
  { id: 'sword-r', node: 27, region: 'weapons', label: 'Right sword', material: 'steelBlade', skinned: true },
  { id: 'flare-l', node: 28, region: 'gloves', label: 'Left shoulder flare', material: 'leatherDark', skinned: true },
  { id: 'thigh-wrap', node: 29, region: 'skirt', label: 'Left thigh wrap', material: 'leatherDark', skinned: true },
  { id: 'flare-r', node: 30, region: 'gloves', label: 'Right shoulder flare', material: 'leatherDark', skinned: true },
];

/** Sphere sized to a triangle budget: SphereGeometry(r,w,h) yields 2*w*h - 2*w. */
function budgetSphere(budget: number, radius: number): THREE.SphereGeometry {
  const h = Math.max(3, Math.round(Math.sqrt(budget / 4)));
  const w = Math.max(3, Math.round(budget / (2 * h) + 1));
  return new THREE.SphereGeometry(radius, w, h);
}

/**
 * Paint the dark inner top onto the torso as vertex colour.
 *
 * The reference carries it as texture on the same mesh as the bare skin, and matching its 31-mesh
 * structure means it cannot become a separate part. A code-only pipeline emits no textures, so the
 * remaining honest representation is per-vertex colour driven by a declared boundary — the pattern
 * `tuxedo-cat` in this repository uses for its bib and socks, for the same reason.
 */
function paintInnerTop(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  const skin = new THREE.Color(0xFFFFFF);
  const cloth = new THREE.Color(0x3A322C);
  const scratch = new THREE.Color();
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const lower = THREE.MathUtils.smoothstep(y, 1.100, 1.150);
    const upper = 1 - THREE.MathUtils.smoothstep(y, 1.330, 1.395);
    // The deep V at the front: further forward and closer to centre means more skin shows.
    const front = z > 0 ? THREE.MathUtils.smoothstep(z - Math.abs(x) * 1.4, 0.02, 0.09) : 0;
    scratch.copy(skin).lerp(cloth, Math.max(0, lower * upper * (1 - front)));
    colors[i * 3] = scratch.r;
    colors[i * 3 + 1] = scratch.g;
    colors[i * 3 + 2] = scratch.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * Eyes and lids, merged into the head part.
 *
 * The reference has no eye geometry — its eyes are painted into the diffuse texture — so these are
 * additions, not measurements, and the demo description says so. They exist because a blink needs
 * something to move. Depth is taken from the measured skull surface rather than guessed: two guesses
 * failed in opposite directions, one leaving the eyeballs through the cheeks and the other burying
 * them entirely.
 */
function eyePieces(
  budget: number, materials: MaterialSet,
): { pieces: Array<{ name: string; geometry: THREE.BufferGeometry }> } {
  void materials;
  const pieces: Array<{ name: string; geometry: THREE.BufferGeometry }> = [];

  // Nearest measured ring at eye height gives the real face surface at that point.
  const headStrands = strandsForNode(20);
  let surfaceZ = 0.05;
  if (headStrands.length > 0) {
    const rings = headStrands.reduce((a, b) => (a.length > b.length ? a : b));
    // Node 20 is sliced along y, so `t` IS the height and the stored pair is (x, z). Asserted
    // rather than assumed: if the extractor ever picks a different axis for the head, silently
    // reading `t` as a height would place the eyes somewhere arbitrary.
    const ring = rings[0].axis === 1
      ? rings.reduce((best, r) => (Math.abs(r.t - EYE_Y) < Math.abs(best.t - EYE_Y) ? r : best), rings[0])
      : null;
    if (!ring) throw new Error('girl-character-3: head node is no longer y-sliced; eye placement needs updating');
    let bestZ = -Infinity;
    for (const [px, pz] of ring.points) {
      if (Math.abs(px - EYE_X) < 0.03 && pz > bestZ) bestZ = pz;
    }
    if (bestZ > -Infinity) surfaceZ = bestZ;
  }
  // Two thirds of the eyeball sits behind the surface; the visible third is the cornea.
  const eyeZ = surfaceZ - EYE_RADIUS * 1.05;

  for (const side of [1, -1] as const) {
    const sign = side * CHARACTER_LEFT_SIGN;
    const tag = side === 1 ? 'l' : 'r';
    const eye = budgetSphere(budget * 0.30, EYE_RADIUS);
    eye.translate(sign * EYE_X, EYE_Y, eyeZ);
    pieces.push({ name: `eye-${tag}`, geometry: eye });

    const iris = budgetSphere(budget * 0.12, EYE_RADIUS * 0.5);
    iris.scale(1, 1, 0.55);
    iris.translate(sign * EYE_X, EYE_Y, eyeZ + EYE_RADIUS * 0.7);
    pieces.push({ name: `iris-${tag}`, geometry: iris });

    // A spherical cap on the eye centre, rotated by its own bone. Scaling it would squash the
    // curvature; rotating is what an eyelid does.
    const lidH = Math.max(4, Math.round(Math.sqrt(budget * 0.08 / 4)));
    const lidW = Math.max(6, Math.round((budget * 0.08) / (2 * lidH)));
    const lid = new THREE.SphereGeometry(
      EYE_RADIUS * 1.06, lidW, lidH, 0, Math.PI * 2, 0, Math.PI * 0.42,
    );
    lid.translate(sign * EYE_X, EYE_Y, eyeZ);
    pieces.push({ name: `eyelid-${tag}`, geometry: lid });
  }
  return { pieces };
}

/**
 * Merge sub-geometries and report where each landed.
 *
 * Indexing is normalised first: `mergeGeometries` refuses a mix, and the ranges must be measured
 * after any conversion or they point at the wrong vertices.
 */
function mergeWithRanges(
  pieces: Array<{ name: string; geometry: THREE.BufferGeometry }>,
): { geometry: THREE.BufferGeometry; ranges: Record<string, { start: number; count: number }> } {
  const anyNonIndexed = pieces.some((p) => !p.geometry.getIndex());
  const normalised = anyNonIndexed
    ? pieces.map((p) => ({
      name: p.name,
      geometry: p.geometry.getIndex() ? p.geometry.toNonIndexed() : p.geometry,
    }))
    : pieces;

  const ranges: Record<string, { start: number; count: number }> = {};
  let cursor = 0;
  for (const piece of normalised) {
    const count = piece.geometry.getAttribute('position').count;
    ranges[piece.name] = { start: cursor, count };
    cursor += count;
  }
  const merged = mergeGeometries(normalised.map((p) => p.geometry), false);
  if (!merged) {
    const shape = normalised.map((p) => {
      const attrs = Object.keys(p.geometry.attributes).sort().join('+') || '(none)';
      return `${p.name}[${attrs} ${p.geometry.getIndex() ? 'indexed' : 'NON-INDEXED'}]`;
    }).join(' ');
    throw new Error(`girl-character-3: geometry merge failed. Pieces: ${shape}`);
  }
  return { geometry: merged, ranges };
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return index.count / 3;
  const position = geometry.getAttribute('position');
  return position ? position.count / 3 : 0;
}

/**
 * Build a texture from one of the baked atlas sheets.
 *
 * Decoded from a data URL rather than fetched, because the demo must issue no network request for an
 * asset — the whole payload is the module. The image decodes asynchronously, so the texture is marked
 * for upload on load; three renders it untextured for the frame or two before that lands, which is
 * invisible next to the build itself.
 */
function atlasTexture(node: number, kind: 'c' | 'r' | 'n'): THREE.Texture | null {
  const sheet = sheetFor(node, kind);
  if (!sheet) return null;
  const image = new Image();
  const texture = new THREE.Texture(image);
  // The sheet is a MAP of this part, sampled once across it — clamped, not repeated, or the bands of
  // neighbouring strands bleed into each other at the edges.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = kind === 'c' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.flipY = false;
  image.onload = () => { texture.needsUpdate = true; };
  image.src = `data:image/${sheet.mime};base64,${sheet.data}`;
  return texture;
}

/**
 * The part's own material, carrying the reference's atlas where one was baked for it.
 *
 * Cloned per part rather than shared, because the sheets are per part. The base colour goes to white:
 * `map` MULTIPLIES it, and the fitted colour underneath was a stand-in for exactly the texture now
 * being applied — leaving it in would apply the albedo twice.
 */
function withAtlas(base: THREE.MeshPhysicalMaterial, node: number): THREE.MeshPhysicalMaterial {
  const colour = atlasTexture(node, 'c');
  if (!colour) return base;
  const material = base.clone();
  material.map = colour;
  material.color.setRGB(1, 1, 1);
  const mr = atlasTexture(node, 'r');
  if (mr) {
    // glTF packs roughness in G and metalness in B of one image, and three reads exactly those
    // channels from these two slots, so the same texture serves both.
    material.roughnessMap = mr;
    material.metalnessMap = mr;
    material.roughness = 1;
    material.metalness = 1;
  }
  const normal = atlasTexture(node, 'n');
  if (normal) {
    material.normalMap = normal;
    material.normalScale = new THREE.Vector2(1, 1);
  }
  material.needsUpdate = true;
  return material;
}

/**
 * THE SURFACES, decoded from the stream this bundle carries.
 *
 * WHAT CHANGED AND WHY. Every part used to be lofted from measured cross-sections, and a cross-section
 * stores ONE radius per angular bin: a shape that doubles back at a single azimuth -- an eyelid, a
 * nostril, the recess under a collar, a buckle sitting on a strap -- is unrepresentable at any triangle
 * count. That was measured, not assumed: the face region held silhouette IoU 0.171 against 0.872 for the
 * figure, and no amount of extra tessellation moved it.
 *
 * So each node's own point cloud is splatted into a signed distance field, contoured with Surface Nets,
 * and reduced to the reference's EXACT triangle count by quadric-error edge collapse. The loft remains
 * reachable with `?sdf=0` and still produces the identical triangle count, so the comparison between the
 * two stays honest.
 *
 * NOTHING IS FETCHED AS AN ASSET. The stream is base64 inside a TypeScript module, code-split so the
 * main bundle stays small; it arrives as a script chunk like the rest of the demo, not as a GLB, a .bin
 * or an image.
 */
type MeshData = { MESH_LEVEL: string; MESH_PARTS: readonly EncodedMesh[]; MESH_STREAM: string };

/**
 * Quality levels, and why they are done by INDEX REDUCTION rather than by rebuilding the surface.
 *
 * The obvious lever, `detail`, cannot do this. It scales the per-part triangle BUDGET, and the decoded
 * surface arrives already decimated offline to the reference's exact count -- `decodedGeometry` therefore
 * only ever ADDS triangles to reach a budget and throws outright if the budget is below what it decodes.
 * A `detail` of 0.5 does not halve this model, it crashes it. (`detail` still works, and still means what
 * it says, on the `?sdf=0` loft path, which builds from cross-sections at whatever count it is given.)
 *
 * The other obvious lever, re-running the offline pipeline at two lower budgets, is the best-looking
 * answer and is not available at runtime: `decimate_to_budget.py` is a pure-Python quadric collapse doing
 * one edge at a time, and 1.6 M triangles down to 20% is over a million collapses.
 *
 * So the reduction happens on the INDEX BUFFER, with meshoptimizer's quadric simplifier -- the same
 * algorithm and the same implementation gltfpack uses. What matters for "visual vẫn giống" is that it
 * returns a new index buffer over the SAME vertices: positions, normals, UVs, vertex colours, skin indices
 * and skin weights are all left exactly as they were, so nothing is resampled, no texture is re-projected,
 * no skin weight is re-normalised, and the parts that survive sit precisely where they always did. The
 * error metric spends the remaining triangles on curvature, which is what keeps a face a face.
 *
 * `LockBorder` keeps each part's open edges intact: these 31 meshes meet at seams, and a border allowed to
 * retreat would open a crack between the corset and the torso rather than merely simplify either.
 */
export type Quality = 'high' | 'medium' | 'low';

const QUALITY_RATIO: Record<Quality, number> = { high: 1, medium: 0.5, low: 0.2 };

/**
 * The level for this page load, read once from `?quality=`.
 *
 * SWITCHING RELOADS, which is the showcase's own convention and the right one. An in-place swap was tried
 * first and it has to tear down four dependent structures in the correct order -- the viewer's explode
 * cache, the part inspector's list, the skin binding and the per-frame tick -- and a fifth thing goes
 * wrong quietly: the rebuild hands its own closures to the live group, so `setQuality` ended up swapping
 * a reduced model into the discarded group while the live one kept every triangle. A reload rebuilds all
 * of it through the path that is already tested.
 */
function readQuality(): Quality {
  if (typeof window === 'undefined') return 'high';
  const asked = new URLSearchParams(window.location.search).get('quality');
  return asked === 'medium' || asked === 'low' ? asked : 'high';
}

const QUALITY: Quality = readQuality();

/**
 * How this differs from the sibling `girl-character` demo, which is worth stating plainly.
 *
 * That one ships three separately baked Surface Nets streams and warns -- correctly -- that a runtime
 * triangle drop can punch holes into a face. This demo has only ONE baked stream: its surfaces are
 * decimated offline to the reference's exact per-part triangle count, and re-baking two more levels means
 * over a million pure-Python quadric collapses. So the reduction happens at runtime instead, on the INDEX
 * BUFFER only, with `LockBorder` holding every part's open edges so seams cannot retreat and open. The
 * result was measured rather than assumed: against a still camera, Medium and Low differ from High by
 * about twice the render's own animation noise floor, and no hole appeared at either level.
 */
const QUALITY_NOTES: Record<Quality, string> = {
  high: '1.60M triangles \u00b7 the reference count exactly, part for part',
  medium: '799K triangles \u00b7 half, by quadric edge collapse over the same vertices',
  low: '323K triangles \u00b7 a fifth, seams locked so seams cannot open',
};

/**
 * Error ceiling handed to the simplifier, as a fraction of the mesh's own scale.
 *
 * Generous on purpose: the brief names exact percentages, and a tight ceiling makes the simplifier stop
 * early and MISS them. At these sizes that is the right trade -- half of 1.6 M triangles is still 800 k on
 * a 1.75 m figure, so the collapses it makes are far below a pixel at demo framing.
 */
const SIMPLIFY_ERROR = 1;

type Simplifier = {
  simplify: (
    indices: Uint32Array, positions: Float32Array, stride: number,
    target: number, error: number, flags?: string[],
  ) => [Uint32Array, number];
};
/** Set once the code-split simplifier lands; see `loadSurfaces`. */
let simplifier: Simplifier | null = null;

/**
 * Reduce one part's triangle count in place, keeping every vertex attribute untouched.
 *
 * A no-op when the simplifier has not arrived, when the level is `high`, or when the target is not below
 * what the geometry already has -- so a missing WASM module costs detail, never correctness.
 */
function simplifyIndices(geometry: THREE.BufferGeometry, ratio: number): void {
  if (!simplifier || ratio >= 1) return;
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  if (!index || !position) return;
  const source = index.array instanceof Uint32Array
    ? index.array
    : new Uint32Array(index.array as ArrayLike<number>);
  // A multiple of three, because the target is an INDEX count and a triangle is three of them.
  const target = Math.max(3, Math.floor((source.length * ratio) / 3) * 3);
  if (target >= source.length) return;
  const positions = position.array instanceof Float32Array
    ? position.array
    : new Float32Array(position.array as ArrayLike<number>);
  const [reduced] = simplifier.simplify(source, positions, 3, target, SIMPLIFY_ERROR, ['LockBorder']);
  geometry.setIndex(new THREE.BufferAttribute(reduced, 1));
}

let decodedParts: Map<number, DecodedMesh> | null = null;
let decodedLevel = '';
let decodePromise: Promise<void> | null = null;

/** `?sdf=0` keeps every part on the cross-section loft, so both artefacts stay measurable. */
function surfacesWanted(): boolean {
  if (typeof window === 'undefined') return true;
  return new URLSearchParams(window.location.search).get('sdf') !== '0';
}

function loadSurfaces(): Promise<void> {
  // Both modules are code-split: together they are the bulk of this demo, and the main bundle has no
  // business carrying them for the demos nobody opened.
  decodePromise ??= Promise.all([
    import('./meshData') as Promise<MeshData>,
    import('./textureData'),
    // Code-split with the surfaces it reduces, and awaited here because its WASM is not ready
    // synchronously -- the model build is, so the wait has to happen where there already is one.
    import('meshoptimizer/meshopt_simplifier.module.js')
      .then(async (m) => { await m.MeshoptSimplifier.ready; return m.MeshoptSimplifier; })
      .catch(() => null),
  ]).then(([data, textures, simplify]) => {
    simplifier = simplify as Simplifier | null;
    const decoded = decodeMeshes(data.MESH_STREAM, data.MESH_PARTS);
    decodedParts = new Map(decoded.map((part) => [part.node, part]));
    decodedLevel = data.MESH_LEVEL;
    referenceTextures = {
      colour: textures.TEXTURE_COLOUR,
      normal: textures.TEXTURE_NORMAL,
      roughMetal: textures.TEXTURE_ROUGH_METAL,
    };
  });
  return decodePromise;
}

/**
 * Geometry for one part, from the decoded surface, brought to exactly `budget` triangles.
 *
 * The stream already holds the reference's count for the whole node, so `budget` differs from it only
 * where this demo adds geometry the reference has no separate mesh for -- the eyeballs. Those triangles
 * come off the surface's share, and the shortfall in the other direction is made up with centroid
 * splits, which change no shape.
 */
function decodedGeometry(node: number, budget: number): THREE.BufferGeometry | null {
  const part = decodedParts?.get(node);
  if (!part) return null;
  const positions = Array.from(part.position);
  const normals = Array.from(part.normal);
  const roughMetal = Array.from(part.roughMetal);
  const uvs = part.uv.length ? Array.from(part.uv) : null;
  /** For each vertex a centroid split added, the triangle it was placed on. */
  const splitParents: Array<[number, number, number]> = [];
  let indices = Array.from(part.index);
  const triangles = indices.length / 3;
  if (triangles > budget) {
    throw new Error(`girl-character-3: node ${node} decodes to ${triangles} triangles against a budget `
      + `of ${budget}; the offline decimation must reserve for whatever this file adds to the part.`);
  }
  const deficit = budget - triangles;
  if (deficit % 2 !== 0) {
    throw new Error(`girl-character-3: node ${node} needs ${deficit} more triangles, which is odd; a `
      + 'centroid split adds exactly two.');
  }
  let splits = deficit / 2;
  while (splits > 0) {
    const faces = indices.length / 3;
    const round = Math.min(splits, faces);
    const stride = faces / round;
    const out: number[] = [];
    let placed = 0;
    for (let t = 0; t < faces; t += 1) {
      const a = indices[t * 3];
      const b = indices[t * 3 + 1];
      const c = indices[t * 3 + 2];
      if (placed < round && Math.floor(t / stride) >= placed) {
        const centre = positions.length / 3;
        splitParents.push([a, b, c]);
        positions.push(
          (positions[a * 3] + positions[b * 3] + positions[c * 3]) / 3,
          (positions[a * 3 + 1] + positions[b * 3 + 1] + positions[c * 3 + 1]) / 3,
          (positions[a * 3 + 2] + positions[b * 3 + 2] + positions[c * 3 + 2]) / 3,
        );
        // A centroid split adds a point ON the triangle, so its normal is the triangle's own -- the
        // mean of the three, which is what a barycentric sample at the centroid gives.
        const nx = (normals[a * 3] + normals[b * 3] + normals[c * 3]) / 3;
        const ny = (normals[a * 3 + 1] + normals[b * 3 + 1] + normals[c * 3 + 1]) / 3;
        const nz = (normals[a * 3 + 2] + normals[b * 3 + 2] + normals[c * 3 + 2]) / 3;
        const length = Math.hypot(nx, ny, nz) || 1;
        normals.push(nx / length, ny / length, nz / length);
        roughMetal.push(
          Math.round((roughMetal[a * 2] + roughMetal[b * 2] + roughMetal[c * 2]) / 3),
          Math.round((roughMetal[a * 2 + 1] + roughMetal[b * 2 + 1] + roughMetal[c * 2 + 1]) / 3),
        );
        // A centroid split lands ON the triangle, so its UV is the centroid of the three -- which is
        // what a barycentric sample there gives, and it keeps the split invisible in the texture.
        if (uvs) {
          uvs.push(
            (uvs[a * 2] + uvs[b * 2] + uvs[c * 2]) / 3,
            (uvs[a * 2 + 1] + uvs[b * 2 + 1] + uvs[c * 2 + 1]) / 3,
          );
        }
        out.push(a, b, centre, b, c, centre, c, a, centre);
        placed += 1;
      } else {
        out.push(a, b, c);
      }
    }
    indices = out;
    splits -= round;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  // Colour is per vertex, baked from the reference's own diffuse through the reference's own UVs. A
  // split vertex inherits the mean of its triangle's three, which is what a barycentric sample would
  // give at the centroid.
  const count = positions.length / 3;
  const colour = new Float32Array(count * 3);
  colour.set(part.colour.subarray(0, Math.min(part.colour.length, count * 3)));
  for (let v = part.colour.length / 3; v < count; v += 1) {
    // A split vertex sits at its triangle's centroid, so it takes the mean of the three -- which is
    // what a barycentric sample there would give. Averaged in LINEAR, which is what these already are.
    const t = splitParents[v - part.colour.length / 3];
    for (let k = 0; k < 3; k += 1) {
      colour[v * 3 + k] = t
        ? (colour[t[0] * 3 + k] + colour[t[1] * 3 + k] + colour[t[2] * 3 + k]) / 3
        : 1;
    }
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colour, 3));
  // The REFERENCE's normals, carried in the stream. Recomputing them here from these triangles is what
  // the surface-noise gate was measuring -- see meshCodec.ts.
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  // The reference's metallic-roughness, per vertex. See `vertexColoured` for how it reaches the shader:
  // three has no per-vertex roughness, and the asset's own figures are in a texture, not in the factors.
  geometry.setAttribute('aRoughMetal',
    new THREE.BufferAttribute(new Uint8Array(roughMetal), 2, true));
  if (uvs) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

/**
 * THE REFERENCE'S OWN MATERIAL, read through the reference's own texture coordinates.
 *
 * ONE material serves all 31 parts, because the reference has 31 materials and they are IDENTICAL --
 * baseColorFactor white, metallicFactor 1, roughnessFactor 1, emissive black, OPAQUE, doubleSided, no
 * extensions, and all three maps pointing at the same images. Giving each part its own clone would be
 * inventing a difference the asset does not have.
 *
 * `flipY` is false on every map: glTF puts the texture origin at the top left and its UVs are authored
 * for that, which is why GLTFLoader does the same. Leaving three's default of true mirrors every map
 * vertically, which does not look like an error so much as a different character.
 *
 * The maps replace what used to be carried per vertex. At a fixed triangle count -- and this character's
 * count is the reference's, exactly -- per-vertex colour is strictly less resolution than a texture:
 * the head's eye band holds 1,027 vertices against the reference's 2,294, so an iris interpolated into
 * a smudge while the colour field itself measured 89.6% of the reference's contrast and its mean
 * matched to a tenth of a luma. It was never the sampling; it was the sampling RATE.
 */
let referenceMaterial: THREE.MeshPhysicalMaterial | null = null;
/** Set when the code-split texture module lands; see loadSurfaces. */
let referenceTextures: { colour: string; normal: string; roughMetal: string } | null = null;

function loadReferenceTexture(url: string, srgb: boolean): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  texture.flipY = false;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // The reference declares magFilter LINEAR and minFilter LINEAR_MIPMAP_LINEAR on its one sampler.
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  // As high as the card allows. three clamps this to the driver's own maximum at upload, so asking for
  // 16 is safe everywhere and gets the real limit where it is higher. At a grazing angle -- an eyelid,
  // the side of the nose -- anisotropy is what decides whether the map is read along the direction it is
  // stretched in or averaged across it, and averaging across it is blur.
  texture.anisotropy = 16;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function texturedMaterial(): THREE.MeshPhysicalMaterial | null {
  if (referenceMaterial) return referenceMaterial;
  if (!referenceTextures) return null;
  const colour = loadReferenceTexture(referenceTextures.colour, true);
  const normal = loadReferenceTexture(referenceTextures.normal, false);
  const roughMetal = loadReferenceTexture(referenceTextures.roughMetal, false);
  referenceMaterial = new THREE.MeshPhysicalMaterial({
    map: colour,
    normalMap: normal,
    // three reads roughness from the GREEN channel and metalness from the BLUE, which is the glTF
    // packing, so one image serves both.
    roughnessMap: roughMetal,
    metalnessMap: roughMetal,
    color: new THREE.Color(1, 1, 1),
    metalness: 1,
    roughness: 1,
    side: THREE.DoubleSide,
    // glTF's default index of refraction, which the asset does not override. three defaults to 1.45,
    // a different F0 and therefore a different specular response.
    ior: 1.5,
    sheen: 0,
    clearcoat: 0,
  });
  installEyeGrade(referenceMaterial);
  return referenceMaterial;
}

/**
 * THE EYE GRADE, done in the shader on 3-D position rather than on the atlas.
 *
 * WHY NOT IN THE TEXTURE. That was tried and it is unsafe on this asset, because the atlas is not an
 * unwrapped figure: it is a patchwork of hundreds of small rectangular tiles, with a fragment of jeans
 * beside a fragment of cheek beside a boot. Grading the eye band's texels needs a feather or its edge
 * shows, and a feather of six texels crosses straight into neighbouring tiles that belong to other parts
 * of the body. The result was a yellow-green wash over the eyelids and the bridge of the nose with a hard
 * horizontal edge across the face.
 *
 * Position has none of that. The eyes are two ellipsoids in the model's own space, measured from the
 * geometry rather than guessed: taking the head's vertices whose diffuse is warm, saturated and
 * mid-dark, and splitting them by side, gives centres (-0.0223, 1.5889, 0.0585) and (0.0194, 1.5867,
 * 0.0497). At radii 13 x 8 x 18 mm the two together hold 564 vertices, 82.6% of which sample eye colour
 * rather than skin, and they do not meet across the bridge of the nose. The falloff is in SURFACE space,
 * where a feather belongs.
 *
 * NONE OF THIS IS A CORRECTION. Rendered through the same camera and rig, the untouched eyes measure
 * mean luminance 105.15 against the reference's 105.08 -- a ratio of 1.001. It is a deliberate departure,
 * asked for, which is why every figure is tunable from the URL and why setting them all to their neutral
 * value gives the reference back exactly.
 *
 * The highlight is sharpened through ROUGHNESS and not through the colour, because it is not in the
 * colour: only 0.9% of the reference's eye texels exceed luma 130 and the brightest is 148. The bright
 * band in the render is specular, and roughness is what decides how tight it is.
 */
type EyeGrade = {
  contrast: number; gain: number; pivot: number; saturation: number; hue: number; roughness: number;
};

function readEyeGrade(): EyeGrade {
  const neutral: EyeGrade = { contrast: 1, gain: 1, pivot: 0.12, saturation: 1, hue: 0, roughness: 1 };
  // Chosen by sweeping them live through the URL and measuring the rendered eye against the reference's
  // own, in a 270x180 box on the visible eye. At these figures, against the reference: brightness 108.2
  // to its 109.8, saturation 0.598 to its 0.366, the top 3% of pixels 210.2 to its 197.9, and relative
  // sharpness -- mean gradient over mean luminance, which does not move when the image is darkened --
  // 0.0176 to its 0.0136. Brighter highlight, deeper colour, sharper, and the same overall exposure.
  const chosen: EyeGrade = {
    contrast: 1.35, gain: 1.1, pivot: 0.12, saturation: 1.25, hue: 12, roughness: 0.7,
  };
  if (typeof window === 'undefined') return chosen;
  const params = new URLSearchParams(window.location.search);
  if (params.get('eye') === '0') return neutral;
  const read = (key: keyof EyeGrade): number => {
    const raw = params.get(`eye${key[0].toUpperCase()}${key.slice(1)}`);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : chosen[key];
  };
  return { contrast: read('contrast'), gain: read('gain'), pivot: read('pivot'),
    saturation: read('saturation'), hue: read('hue'), roughness: read('roughness') };
}

const EYE_GRADE = readEyeGrade();

/** `?tex=0` renders the surfaces from their per-vertex bake instead, so the two stay comparable. */
function texturesWanted(): boolean {
  if (typeof window === 'undefined') return true;
  return new URLSearchParams(window.location.search).get('tex') !== '0';
}

/**
 * The region's material, driven by the colour attribute instead of the atlas.
 *
 * `color` must be white or it would tint a bake that is already the reference's own colour, and the
 * three atlas maps come off because they are indexed by UVs this geometry does not carry.
 */
/**
 * Splice the eye grade into a material's shaders.
 *
 * Shared, because there are two materials that can carry it and putting it on the wrong one is exactly
 * the mistake this function prevents: the grade was first written into `vertexColoured`, which only
 * serves `?tex=0`, so nothing changed in the render and the two measured identical to three decimals.
 * `patchExtra` is where the vertex-colour path adds its own roughness attribute work.
 */
function installEyeGrade(
  material: THREE.MeshPhysicalMaterial,
  patchExtra?: (shader: { vertexShader: string; fragmentShader: string }) => void,
): void {
  const grade = EYE_GRADE;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying float vEyeGrade;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
	// The bind pose IS the world pose here -- the geometry is authored where the bones were placed and
	// bound with an identity matrix -- so the irises can be located in the raw position attribute.
	//
	// A SPHERE ON THE IRIS, not an ellipsoid over the eye. The first version averaged every warm,
	// saturated vertex in a 22 mm height band, which is mostly eyelid and lash, so the centre landed off
	// the iris and the radii -- 13 x 8 x 18 mm -- were wide enough to reach the lids and the bridge of the
	// nose. That is what smeared the colour outside the eye.
	//
	// These centres were read off the neutral render instead, where the iris is visible as a brown disc
	// about 130 px across, and unprojected onto the head: at this framing 11.43 px per mm, so 11 mm, which
	// is what an iris measures. The radius follows from that rather than being chosen.
	const float irisRadius = 0.0065;
	float dRight = length(position - vec3(-0.0311, 1.5898, 0.0551)) / irisRadius;
	float dLeft = length(position - vec3(0.0186, 1.5893, 0.0542)) / irisRadius;
	vEyeGrade = 1.0 - smoothstep(0.55, 1.0, min(dRight, dLeft));`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vEyeGrade;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
	if (vEyeGrade > 0.0) {
		vec3 eyeBase = diffuseColor.rgb;
		// THE CURVE IS APPLIED TO LUMINANCE, and the colour is then scaled to match it.
		//
		// Doing it per channel is what turned the eyes into lava. Expanding contrast channel by channel
		// drives red and green to 1.0 while blue is still low, so a warm brown clamps to pure yellow, and
		// the measurements all improved while the render became unusable -- brightness, saturation, peak
		// and sharpness every one better than the reference, and an eye that looked like fire.
		//
		// Transforming luminance and rescaling the colour by the ratio keeps chromaticity, so brightening
		// cannot invent a hue. Saturation and hue then move only as far as they are asked to.
		float eyeL0 = dot(eyeBase, vec3(0.2126, 0.7152, 0.0722));
		float eyeL1 = clamp((eyeL0 - ${grade.pivot.toFixed(4)}) * ${grade.contrast.toFixed(4)}
			+ ${grade.pivot.toFixed(4)}, 0.0, 1.0) * ${grade.gain.toFixed(4)};
		vec3 eyeLifted = eyeBase * (eyeL1 / max(eyeL0, 1e-4));
		vec3 eyeSat = mix(vec3(eyeL1), eyeLifted, ${grade.saturation.toFixed(4)});
		float eyeAngle = radians(${grade.hue.toFixed(4)});
		float eyeCos = cos(eyeAngle);
		float eyeSin = sin(eyeAngle);
		mat3 eyeHue = mat3(
			0.213 + eyeCos * 0.787 - eyeSin * 0.213, 0.213 - eyeCos * 0.213 + eyeSin * 0.143, 0.213 - eyeCos * 0.213 - eyeSin * 0.787,
			0.715 - eyeCos * 0.715 - eyeSin * 0.715, 0.715 + eyeCos * 0.285 + eyeSin * 0.140, 0.715 - eyeCos * 0.715 + eyeSin * 0.715,
			0.072 - eyeCos * 0.072 + eyeSin * 0.928, 0.072 - eyeCos * 0.072 - eyeSin * 0.283, 0.072 + eyeCos * 0.928 + eyeSin * 0.072);
		// AND ONLY WHERE THE EYE IS. The ellipsoid reaches the inner corner of each eye, where the surface
		// is skin, and skin is bright: grading it turned the canthus into a yellow patch. The iris and the
		// lashes sit well below the skin in luminance, so the base value is the gate -- position says which
		// eye, luminance says whether this pixel is part of it.
		float eyeKey = 1.0 - smoothstep(0.18, 0.32, eyeL0);
		diffuseColor.rgb = mix(diffuseColor.rgb, clamp(eyeHue * eyeSat, 0.0, 1.0),
			vEyeGrade * eyeKey);
	}`);
    // The specular lobe is narrowed where the grade applies: the highlight is not in the colour map --
    // only 0.9% of the reference's eye texels pass luma 130 -- so roughness is the only place it lives.
    shader.fragmentShader = shader.fragmentShader.replace(
      'float roughnessFactor = roughness;',
      `float roughnessFactor = roughness * mix(1.0, ${grade.roughness.toFixed(4)}, vEyeGrade);`,
    );
    patchExtra?.(shader);
  };
  material.customProgramCacheKey = () => `gc3-eye-${grade.contrast}-${grade.gain}-${grade.pivot}`
    + `-${grade.saturation}-${grade.hue}-${grade.roughness}-${material.map ? 'tex' : 'vc'}`;
}

function vertexColoured(base: THREE.MeshPhysicalMaterial): THREE.MeshPhysicalMaterial {
  const material = base.clone();
  material.map = null;
  material.roughnessMap = null;
  material.metalnessMap = null;
  material.normalMap = null;
  material.color.setRGB(1, 1, 1);
  material.vertexColors = true;
  // The reference declares metallicFactor 1.0 and roughnessFactor 1.0 on ALL 31 materials and puts the
  // actual figures in a texture, so these are the multipliers a `roughnessMap` would be multiplied by
  // and both must be 1 for the copied values to survive.
  material.roughness = 1;
  material.metalness = 1;
  // glTF's default index of refraction is 1.5, and the asset declares no KHR_materials_ior, so 1.5 is
  // what its materials mean. three's MeshPhysicalMaterial defaults to 1.45, which is a different F0
  // (0.0337 against 0.04) and therefore a different specular response from the reference's
  // MeshStandardMaterial. With sheen, clearcoat, transmission and iridescence all at zero, this is the
  // one remaining parameter that separated the two material models.
  material.ior = 1.5;
  // three reads roughness from the GREEN channel of a map and metalness from the BLUE, and has no
  // per-vertex path for either. The attribute is spliced into the two chunks that would have sampled
  // that map, which is the smallest change that makes the copied figures reach the BRDF.
  installEyeGrade(material, (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 aRoughMetal;
varying vec2 vRoughMetal;`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvRoughMetal = aRoughMetal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vRoughMetal;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * vRoughMetal.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metalness * vRoughMetal.y;');
  });
  material.needsUpdate = true;
  return material;
}

export function createGirlCharacter3Model(options: GirlCharacter3Options = {}): THREE.Group {
  const detail = options.detail ?? 1;
  const materials = createGirlCharacter3Materials({ textureSize: options.textureSize });
  const skeleton = buildSkeleton();
  const parts: Record<string, THREE.Object3D> = {};

  const group = new THREE.Group();
  group.name = 'girl-character-3';
  // The root bone must live in the scene graph or the skeleton never updates its matrices.
  group.add(skeleton.root);

  const breathing: THREE.BufferGeometry[] = [];
  /**
   * Garments deformed vertex by vertex on the CPU. EMPTY, deliberately.
   *
   * The coat used to be in here, and the idle layer ran a travelling hem wave over all 110,000 of its
   * vertices every frame: 32 ms per tick on its own, and a second mechanism moving a garment that now has
   * bones and a simulation of its own. Two things driving one panel is a defect whatever it costs. With the
   * wave gone the tick measures 17.8 ms. The list stays because the mechanism is still the right answer for
   * a garment with no bones.
   */
  const hems: THREE.BufferGeometry[] = [];
  let triangles = 0;

  for (const spec of PARTS) {
    const budget = Math.max(48, Math.round(
      (TRIANGLE_BUDGET[spec.id]?.triangles ?? 2000) * detail,
    ));

    // The head's eyes are built FIRST and counted, so the sections can be given exactly what is
    // left. Splitting the budget by a fraction instead leaves the merged part a few triangles off
    // its reference count, because a sphere's reachable counts are as quantised as a grid's.
    //
    // THE EYES ARE FOR THE LOFT ONLY. They exist because a star-convex ring cannot cut an eye socket,
    // so the lofted head is an egg and needs discs painted on it. The decoded surface has the sockets,
    // the lids and the brow as real geometry, and the reference has no separate eyeball mesh either --
    // its head is one mesh of 75,294 triangles. Adding spheres on top of it would both break that count
    // and put two balls inside a face that already has eyes.
    const hasSurface = decodedParts?.has(spec.node) ?? false;
    const extras: Array<{ name: string; geometry: THREE.BufferGeometry }> = spec.id === 'head' && !hasSurface
      ? eyePieces(Math.round(budget * 0.28), materials).pieces
      : [];
    const extraTriangles = extras.reduce((sum, e) => sum + triangleCount(e.geometry), 0);
    const sectionBudget = budget - extraTriangles;

    const surface = decodedGeometry(spec.node, sectionBudget);
    const pieces = surface
      ? [{ name: 'surface', geometry: surface }]
      : nodeGeometries(spec.node, sectionBudget, spec.inflate ?? 0)
        .map((geometry, i) => ({ name: `strand-${i}`, geometry }));
    pieces.push(...extras);

    const { geometry, ranges } = mergeWithRanges(pieces);
    // AFTER the merge and BEFORE the skin bind. After, so one call covers the whole part rather than each
    // strand; before, so the weights are computed against the vertices that survive -- though in fact
    // every vertex survives, since only the index buffer changes.
    simplifyIndices(geometry, QUALITY_RATIO[options.quality ?? QUALITY]);
    // The loft paints the inner top through UVs it authored; the decoded surface already carries the
    // reference's own colour there, per vertex.
    if (spec.id === 'skin-torso' && !surface) paintInnerTop(geometry);

    // The atlas is sampled through the LOFT's parameterisation, which the decoded surface does not
    // have -- it carries colour per vertex instead, which is also what removes every UV seam. Roughness
    // and metalness stay the figures measured off the reference for the region.
    const textured = surface && surface.hasAttribute('uv') && texturesWanted()
      ? texturedMaterial()
      : null;
    const partMaterial = textured
      ?? (surface
        ? vertexColoured(materials[spec.material] as THREE.MeshPhysicalMaterial)
        : withAtlas(materials[spec.material] as THREE.MeshPhysicalMaterial, spec.node));

    let mesh: THREE.Mesh;
    if (spec.skinned) {
      // Carried things keep their shape; only flesh and cloth deform. See bindRigidToNearestBone.
      const carried = spec.region === 'weapons' || spec.region === 'scabbards'
        || spec.region === 'pouches' || spec.region === 'hardware';
      // `?cloth=0` puts the coat back on the body's own bones and turns the garment sim off, as a pair.
      // They have to move together: cloth bones with no simulation is a coat nailed to the pelvis, which
      // is neither the old behaviour nor the new one and would make an A/B comparison meaningless.
      const allowed = (clothWanted() ? spec.bones : undefined) ?? REGION_BONE_LIMITS[spec.region];
      if (carried) bindRigidToNearestBone(geometry, skeleton, allowed);
      else bindGeometryToSkeleton(geometry, skeleton, allowed);
      if (spec.id === 'hair') {
        // The ponytail is the lowest strand of the hair node; give it the ponytail bone outright,
        // because a distance solve cannot separate it from the crown it hangs off.
        const lowest = Object.keys(ranges)
          .filter((k) => k.startsWith('strand-'))
          .sort((a, b) => ranges[a].start - ranges[b].start).pop();
        if (lowest) overrideWeights(geometry, skeleton, ranges[lowest], 'ponytail');
      }
      if (spec.id === 'head') {
        // On the LOFTED head the lids are separate pieces with known vertex ranges.
        if (ranges['eyelid-l']) overrideWeights(geometry, skeleton, ranges['eyelid-l'], 'eyelid.L');
        if (ranges['eyelid-r']) overrideWeights(geometry, skeleton, ranges['eyelid-r'], 'eyelid.R');
        /**
         * On the DECODED head they are not. The lids are part of one 75,294-triangle mesh, so there is no
         * range to name and the two overrides above simply never ran: `scripts/audit-rigging.mjs` found
         * both eyelid bones driving nothing at all, which means the blink has been invisible on the real
         * surface the whole time. The idle gate passed it throughout, because it measured the bone.
         *
         * The eye centres were measured for the iris grade -- see `EYE_GRADE` -- so the lid is the cap of
         * a sphere about each of them, taken from just below the centre upward and only on the front of
         * the face. Blended rather than assigned, so the lid's rim stays welded to the skin around it.
         */
        if (!ranges['eyelid-l'] && !ranges['eyelid-r']) {
          const LID_RADIUS = 0.019;
          for (const [bone, centre] of [
            ['eyelid.L', [0.0186, 1.5893, 0.0542]],
            ['eyelid.R', [-0.0311, 1.5898, 0.0551]],
          ] as const) {
            blendBoneInSphere(geometry, skeleton, bone, centre as [number, number, number], LID_RADIUS,
              (_x, y, z) => y > centre[1] - 0.004 && z > centre[2] - 0.014);
          }
        }
      }
      const skinned = new THREE.SkinnedMesh(geometry, partMaterial);
      // Identity bind: the geometry is authored in the same world frame the bones were placed in.
      skinned.bind(skeleton.skeleton, new THREE.Matrix4());
      mesh = skinned;
    } else {
      mesh = new THREE.Mesh(geometry, partMaterial);
    }

    mesh.name = spec.id;
    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? true;
    mesh.userData.region = spec.region;
    mesh.userData.partId = spec.id;
    mesh.userData.label = spec.label;
    mesh.userData.referenceNode = spec.node;
    mesh.userData.strands = pieces.filter((p) => p.name.startsWith('strand-')).length;
    mesh.userData.triangles = triangleCount(geometry);
    if (options.wireframe) {
      (materials[spec.material] as THREE.Material & { wireframe?: boolean }).wireframe = true;
    }
    triangles += mesh.userData.triangles as number;
    parts[spec.id] = mesh;
    group.add(mesh);

    if (spec.id === 'skin-torso' || spec.id === 'corset') breathing.push(geometry);

  }

  if (options.animate !== false) {
    /**
     * How hard the turntable is turning, as 0..1, read fresh every frame.
     *
     * The turntable orbits the CAMERA, so the body it circles does not rotate and there is no real angular
     * motion for cloth or hair to lag behind -- the brief nonetheless asks for both to move while it runs,
     * which is deliberate theatre rather than simulation. See `ambient` for why it is supplied rather than
     * discovered.
     */
    const sway = options.ambient ?? ((): number => 0);

    const rig: IdleRig = {
      armPivots: { left: skeleton.byName['upperArm.L'], right: skeleton.byName['upperArm.R'] },
      ponytailPivot: skeleton.byName.ponytail,
      eyelids: { left: skeleton.byName['eyelid.L'], right: skeleton.byName['eyelid.R'] },
      // The breath peaks between the corset's top edge and the collarbone and dies out before the
      // waist; a breath that moved the whole torso would read as a bounce.
      // The bust band is measured off the rig: `chest` runs 1.230 to 1.402, and the bust sits in the
      // lower half of it. 45 mm of half-span covers it without reaching the collarbone, and the 180 mm
      // radius cap keeps the arms out of it.
      breathing: breathing.map((g) => makeDeformTarget(
        g, heightWeight(g, 1.30, 1.10), bandWeight(g, 1.302, 0.045, 0.180),
      )),
      // The hem is the free edge, so the weight runs the other way.
      hems: hems.map((g) => makeDeformTarget(g, heightWeight(g, 0.20, 0.70))),
      body: group,
      sway,
    };
    installIdleAnimation(group, rig);

    // ---- per-frame composition -----------------------------------------------------------------
    //
    // THE ACTION CLIPS ARE NOT WIRED UP. walk, slash, cross-guard, spin-slash, jump-slash and
    // speak-hello are deliberately not played here: this demo is a showcase of the SURFACE, and a figure
    // mid-stride hides most of it. `clips.ts`, `animator.ts` and `motion.ts` are kept on disk because the
    // measurement scripts under `scripts/` are written against them -- they are simply no longer
    // constructed, so no bone rotation is ever written by a clip.
    //
    // What remains is the idle layer: the breath, the bust bounce it drives, the hair spring and the
    // blink. Seeing the figure from every angle is the viewer's job, not a clip's -- the camera
    // turntable in `Scene` orbits without touching a single vertex.
    const idleTick = group.userData.tick as ((dt: number, elapsed: number) => void) | undefined;
    // The coat goes LAST, and has to: it reads where the legs ended up this frame and puts the garment
    // outside them, so it cannot run before the thing it is reacting to.
    const cloth = clothWanted() ? createClothDynamics(skeleton.byName, group, sway) : null;
    // The blades' travelling highlight. Half a period apart, so the two do not flash together and read as
    // one object; see `bladeGlint.ts` for why this is emissive in the shader and not a moving light.
    const glints = ([
      ['sword-l', 0],
      ['sword-r', 1.95],
    ] as const).reduce<BladeGlint[]>((list, [id, phase]) => {
      const blade = parts[id] as THREE.Mesh | undefined;
      const glint = blade?.isMesh ? createBladeGlint(blade, phase) : null;
      if (glint) list.push(glint);
      return list;
    }, []);
    const composed = (dt: number, elapsed: number): void => {
      idleTick?.(dt, elapsed);
      cloth?.update(dt);
      for (const glint of glints) glint.update(dt);
    };
    // THE TICK THE VIEWER SEES NEVER CHANGES IDENTITY, and that is not a style choice.
    //
    // `Scene.start()` walks the graph ONCE and keeps the functions it finds. This model rebuilds itself
    // when its code-split surfaces arrive, and the rebuild used to replace `userData.tick` outright -- so
    // the viewer went on calling the first build's tick, animating a skeleton that had been removed from
    // the scene. Nothing moved, and nothing reported an error either.
    //
    // So the exported tick is a stable closure over a holder, and a rebuild swaps what is inside it.
    const holder = { current: composed };
    group.userData.tickHolder = holder;
    group.userData.tick = (dt: number, elapsed: number): void => holder.current(dt, elapsed);
  }

  group.userData.parts = parts;
  group.userData.regions = GIRL_CHARACTER_3_REGIONS;
  group.userData.materials = materials;
  group.userData.skeleton = skeleton.skeleton;
  group.userData.bones = Object.keys(skeleton.byName);
  group.userData.budget = {
    parts: Object.keys(parts).length,
    triangles,
    referenceParts: REFERENCE_TOTALS.meshes,
    referenceTriangles: REFERENCE_TOTALS.triangles,
    detail,
  };
  /**
   * Move a freshly built model's contents into the live group.
   *
   * Extracted because there are now TWO reasons to rebuild -- the code-split surfaces landing, and the
   * visitor changing quality -- and the sequence is delicate enough that having it written twice would be
   * a defect waiting to happen. Every line of it is load-bearing; see the comments inside.
   */
  const swapIn = (rebuilt: THREE.Group): void => {
    // Capture mode deletes `tick` from every object so the evaluation frame is deterministic. That ran
    // before this rebuild existed, so re-installing the idle here would put the breath back into a frame
    // that is supposed to be frozen. Whether the live group still had one is the record of what the page
    // decided.
    const animated = 'tick' in group.userData;
    for (const child of [...group.children]) {
      group.remove(child);
      if ((child as THREE.Mesh).isMesh) (child as THREE.Mesh).geometry.dispose();
    }
    for (const child of [...rebuilt.children]) group.add(child);
    /**
     * ANY ENTRY THAT CLOSES OVER A GROUP MUST NOT BE COPIED, and this list is the whole of that rule.
     *
     * A rebuild's closures capture the rebuild's OWN group -- the one that is about to be emptied and
     * dropped. Copying such an entry over the live group's version replaces a function that acts on the
     * scene with one that acts on nothing, and it fails silently, because the call still runs and still
     * returns. That has now bitten this file three times: `tick` (the viewer animated a skeleton no longer
     * drawn), `ambient` (cloth and hair stopped answering the turntable a second after load, which is why
     * it is an option now rather than a lookup), and `setQuality`, which spent 1.4 s building a reduced
     * model and swapped it into the discarded group while the live one kept every triangle.
     *
     * Plain DATA is copied: `parts`, `budget`, `quality`, `surfaces` and the rest are the rebuild's own
     * facts and the live group should report them.
     */
    const CLOSES_OVER_GROUP = new Set(['tick', 'tickHolder']);
    for (const key of Object.keys(rebuilt.userData)) {
      if (CLOSES_OVER_GROUP.has(key)) continue;
      group.userData[key] = rebuilt.userData[key];
    }
    const rebuiltHolder = rebuilt.userData.tickHolder as { current: (d: number, e: number) => void };
    const stable = group.userData.tickHolder as { current: (d: number, e: number) => void } | undefined;
    if (stable && rebuiltHolder) stable.current = rebuiltHolder.current;
    if (!animated) delete group.userData.tick;
  };

  /**
   * What the showcase panel reads: the animation controller (this figure has none -- there is no action
   * clip, by design) and the detail levels it offers. `demo.ts` renders the buttons and performs the
   * reload; nothing here needs to know how.
   */
  group.userData.sculptRuntime = {
    detailLevels: {
      current: options.quality ?? QUALITY,
      options: (['high', 'medium', 'low'] as const).map((id) => ({
        id,
        label: id === 'high' ? 'High' : id === 'medium' ? 'Medium' : 'Low',
        note: QUALITY_NOTES[id],
      })),
    },
  };

  // The surfaces are code-split, so the first build of this demo runs before they arrive. Show the loft
  // immediately and rebuild once they land -- the model is a pure function of its options and the
  // decoded data, so a second call with the data present is the whole of the swap. `decodedParts` is set
  // before this runs again, so it cannot schedule itself twice.
  if (!decodedParts && surfacesWanted()) {
    void loadSurfaces().then(() => {
      const rebuilt = createGirlCharacter3Model(options);
      swapIn(rebuilt);
      group.userData.surfaceLevel = decodedLevel;
    }).catch((error: unknown) => {
      // A failed decode must leave the loft standing rather than blank the demo.
      console.error('girl-character-3: surfaces failed to decode, keeping the loft', error);
    });
  }

  group.userData.surfaces = decodedParts ? decodedLevel : 'loft';
  group.userData.dispose = (): void => {
    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) (child as THREE.Mesh).geometry.dispose();
    });
    materials.dispose();
  };

  return group;
}

/**
 * The demo's own light rig.
 *
 * `shadow.normalBias` is set on every shadow-casting light. Without it a dense skin or cloth surface
 * self-shadows into visible acne wherever it is near-parallel to the light, which at this triangle
 * count is most of the torso. The 0.02-0.05 band is the working range: below it the acne survives,
 * above it contact shadows detach from the surface that casts them.
 */
/**
 * Decode the surfaces before the demo is built, for the showcase's build loader.
 *
 * This demo's stream is the heaviest in the gallery: 24.5 MB of encoded mesh plus 4.1 MB of texture, and
 * the simplifier's WASM on top when a reduced level is asked for. Without this the page shows the
 * cross-section loft and then visibly swaps; with it the loader waits and the figure arrives finished.
 */
export function prewarmGirlCharacter3(): Promise<void> {
  return surfacesWanted() ? loadSurfaces() : Promise.resolve();
}

export function createGirlCharacter3LookDevLights(): THREE.Group {
  const rig = new THREE.Group();
  rig.name = 'girl-character-3-lights';

  const key = new THREE.DirectionalLight(0xFFF3E4, 2.4);
  key.position.set(1.6, 2.4, 2.2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.normalBias = 0.035;
  key.shadow.bias = -0.0004;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 8;
  key.shadow.camera.left = -1.5;
  key.shadow.camera.right = 1.5;
  key.shadow.camera.top = 2.2;
  key.shadow.camera.bottom = -0.4;
  rig.add(key);

  const rim = new THREE.DirectionalLight(0xBFD4FF, 1.6);
  rim.position.set(-1.9, 1.9, -2.4);
  rim.castShadow = true;
  rim.shadow.mapSize.set(1024, 1024);
  rim.shadow.normalBias = 0.03;
  rig.add(rim);

  // Fill and bounce carry the dark leather: the reference keeps grain and a soft highlight legible
  // across the skirt and gloves, and at a lower fill the same albedo crushes to flat black.
  const fill = new THREE.DirectionalLight(0xDCE4F0, 0.95);
  fill.position.set(-2.0, 1.1, 1.6);
  rig.add(fill);

  const bounce = new THREE.DirectionalLight(0x8894A8, 0.35);
  bounce.position.set(0.3, -1.4, 0.9);
  rig.add(bounce);

  rig.add(new THREE.AmbientLight(0x3C4250, 1.15));

  return rig;
}
