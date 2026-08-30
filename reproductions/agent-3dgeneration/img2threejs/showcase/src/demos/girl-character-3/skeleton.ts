import * as THREE from 'three';

/**
 * A real skeleton for the dual-sword warrior, authored here.
 *
 * WHY IT IS AUTHORED AND NOT IMPORTED. The reference GLB has no rig at all — probing both files
 * reports `skins: 0`, `animations: 0`, zero joint nodes, and no `JOINTS_n` or `WEIGHTS_n` vertex
 * attributes on any of its 31 primitives. There is nothing to copy, so the only way to have a rig is
 * to build one. Joint positions come from the measured tables (`measuredRings.ts`), which is the
 * same evidence the geometry is lofted from, so the bones land inside the masses they drive.
 *
 * WEIGHTS ARE COMPUTED, NOT PAINTED. Each vertex is bound to the nearest bone SEGMENTS — a bone is a
 * capsule from its head to its tail, not a point — with an inverse-distance falloff, then normalised
 * over at most four influences, which is the limit `THREE.Skeleton` and glTF both assume. Binding to
 * the nearest joint POSITION instead is the classic mistake: it snaps a mid-forearm vertex to the
 * wrist and the sleeve collapses when the elbow bends.
 */

/** three and glTF both cap skinning at four influences per vertex. */
export const MAX_INFLUENCES = 4;

export interface BoneSpec {
  name: string;
  /** parent bone name, or null for the root */
  parent: string | null;
  /** world-space joint position, in the same frame as the measured tables */
  head: [number, number, number];
  /** world-space tip; the bone's capsule runs head -> tail and is what vertices bind against */
  tail: [number, number, number];
  /** how far past the capsule this bone still claims vertices, in metres */
  falloff: number;
}

/**
 * The rig.
 *
 * Heights are the measured ones: hip at the yoke's base (0.756), waist where the corset narrows
 * (1.09), chest at the widest measured torso band (1.28), neck base at the shoulder line (1.402),
 * head base at 1.472 and crown at 1.710. Shoulders sit at the deltoid centres (+/-0.104, 1.408) and
 * the arm chain follows the measured arm centreline from 1.360 down to 0.915.
 */
export const BONE_SPECS: BoneSpec[] = [
  { name: 'hips', parent: null, head: [0, 0.900, 0], tail: [0, 1.090, 0], falloff: 0.16 },
  { name: 'spine', parent: 'hips', head: [0, 1.090, 0], tail: [0, 1.230, 0], falloff: 0.15 },
  { name: 'chest', parent: 'spine', head: [0, 1.230, 0], tail: [0, 1.402, 0], falloff: 0.17 },
  { name: 'neck', parent: 'chest', head: [0, 1.402, -0.010], tail: [0, 1.480, -0.006], falloff: 0.075 },
  { name: 'head', parent: 'neck', head: [0, 1.480, -0.006], tail: [0, 1.710, -0.020], falloff: 0.130 },

  // Ponytail and eyelids are bones because their meshes are MERGED into the hair and head parts to
  // match the reference's 31-mesh structure. A merged part cannot be moved by a parent Group, so the
  // motion has to come from the rig.
  { name: 'ponytail', parent: 'head', head: [0, 1.686, -0.118], tail: [0, 1.500, -0.240], falloff: 0.10 },
  { name: 'eyelid.L', parent: 'head', head: [0.026, 1.596, 0.040], tail: [0.026, 1.596, 0.060], falloff: 0.02 },
  { name: 'eyelid.R', parent: 'head', head: [-0.026, 1.596, 0.040], tail: [-0.026, 1.596, 0.060], falloff: 0.02 },

  { name: 'shoulder.L', parent: 'chest', head: [0.030, 1.395, -0.005], tail: [0.104, 1.408, -0.004], falloff: 0.085 },
  { name: 'upperArm.L', parent: 'shoulder.L', head: [0.104, 1.408, -0.004], tail: [0.250, 1.180, -0.037], falloff: 0.080 },
  { name: 'foreArm.L', parent: 'upperArm.L', head: [0.250, 1.180, -0.037], tail: [0.283, 0.985, -0.037], falloff: 0.070 },
  { name: 'hand.L', parent: 'foreArm.L', head: [0.283, 0.985, -0.037], tail: [0.290, 0.915, -0.037], falloff: 0.060 },
  // TWIST BONES, which every human rig has and this one did not.
  //
  // A forearm is two bones that cross: turning the palm over rotates the wrist end while the elbow end
  // stays put. With a single `foreArm` segment there is nowhere for that to happen, so the whole rotation
  // lands on one joint and the skin shears there -- the "break" at the forearm. The same is true at the
  // shoulder, where the upper arm's roll otherwise twists the deltoid at the joint itself.
  //
  // Each takes HALF the roll of the joint it serves, and each covers the half of the limb nearest that
  // joint, so distance-based binding produces the gradient a real arm has: none at the far end, all of it
  // at the near one. See `applyArmTwist`.
  { name: 'upperArmTwist.L', parent: 'upperArm.L', head: [0.104, 1.408, -0.004], tail: [0.177, 1.294, -0.021], falloff: 0.075 },
  { name: 'foreArmTwist.L', parent: 'foreArm.L', head: [0.267, 1.083, -0.037], tail: [0.283, 0.985, -0.037], falloff: 0.065 },

  { name: 'shoulder.R', parent: 'chest', head: [-0.030, 1.395, -0.005], tail: [-0.104, 1.408, -0.004], falloff: 0.085 },
  { name: 'upperArm.R', parent: 'shoulder.R', head: [-0.104, 1.408, -0.004], tail: [-0.273, 1.180, -0.037], falloff: 0.080 },
  { name: 'foreArm.R', parent: 'upperArm.R', head: [-0.273, 1.180, -0.037], tail: [-0.305, 0.985, -0.037], falloff: 0.070 },
  { name: 'hand.R', parent: 'foreArm.R', head: [-0.305, 0.985, -0.037], tail: [-0.315, 0.915, -0.037], falloff: 0.060 },
  { name: 'upperArmTwist.R', parent: 'upperArm.R', head: [-0.104, 1.408, -0.004], tail: [-0.189, 1.294, -0.021], falloff: 0.075 },
  { name: 'foreArmTwist.R', parent: 'foreArm.R', head: [-0.289, 1.083, -0.037], tail: [-0.305, 0.985, -0.037], falloff: 0.065 },

  // THE FACE RIG. The head is one merged mesh, so a mouth cannot be a separate object -- it has to be
  // bones the head's own vertices bind to. Positions are measured, not guessed: taking the head's
  // front-facing vertices and reading the diffuse at their UVs, redness peaks at y=1.535-1.540, which is
  // the lip line, and the chin reaches y=1.500 at z=0.056. The jaw pivot sits back at the condyle so the
  // chin swings on an arc, which is what a jaw does; a pivot at the chin itself would slide the mouth
  // down the face instead of opening it.
  { name: 'jaw', parent: 'head', head: [0, 1.575, -0.022], tail: [0, 1.501, 0.058], falloff: 0.042 },
  // The corners of the mouth, for a smile. Small falloff: a smile is 10 mm of movement in a 40 mm mouth,
  // and anything wider drags the cheek with it.
  { name: 'lipCorner.L', parent: 'jaw', head: [0.019, 1.536, 0.062], tail: [0.027, 1.541, 0.056], falloff: 0.013 },
  { name: 'lipCorner.R', parent: 'jaw', head: [-0.019, 1.536, 0.062], tail: [-0.027, 1.541, 0.056], falloff: 0.013 },

  { name: 'thigh.L', parent: 'hips', head: [0.085, 0.900, -0.010], tail: [0.115, 0.500, -0.020], falloff: 0.115 },
  { name: 'shin.L', parent: 'thigh.L', head: [0.115, 0.500, -0.020], tail: [0.150, 0.140, -0.030], falloff: 0.100 },
  { name: 'foot.L', parent: 'shin.L', head: [0.150, 0.140, -0.030], tail: [0.170, 0.010, 0.040], falloff: 0.090 },

  { name: 'thigh.R', parent: 'hips', head: [-0.095, 0.900, -0.010], tail: [-0.135, 0.500, -0.020], falloff: 0.115 },
  { name: 'shin.R', parent: 'thigh.R', head: [-0.135, 0.500, -0.020], tail: [-0.175, 0.140, -0.030], falloff: 0.100 },
  { name: 'foot.R', parent: 'shin.R', head: [-0.175, 0.140, -0.030], tail: [-0.193, 0.010, 0.040], falloff: 0.090 },

  // THE TOE JOINT, which this rig did not have.
  //
  // Every retargetable humanoid rig has one -- Mixamo's auto-rigger calls it ToeBase -- and without it the
  // foot is a single rigid plank from ankle to toe. That is visible: the forefoot rocker has to be faked by
  // rotating the whole boot about its front edge, so the sole lifts as a board instead of bending at the
  // ball, and a foot that cannot bend is one of the plainest reads of stiffness there is.
  //
  // Placed at 79% of the sole's length from the heel, which is where the metatarsal heads are: the sole was
  // measured at 111 mm long, from z=-53 mm at the heel to z=+58 mm at the toe, so the joint goes at
  // z=+25 mm. Its head sits ON the foot bone's own axis at that depth, so the two capsules stay flush and
  // the binding does not open a seam across the instep.
  { name: 'toe.L', parent: 'foot.L', head: [0.166, 0.038, 0.025], tail: [0.170, 0.012, 0.058], falloff: 0.045 },
  { name: 'toe.R', parent: 'foot.R', head: [-0.190, 0.038, 0.025], tail: [-0.194, 0.012, 0.058], falloff: 0.045 },
];

// ---- cloth bones ----------------------------------------------------------------------------------
//
// FOUR PANELS, THREE SEGMENTS EACH, for the long coat. Without them the coat is welded to the pelvis and
// the legs simply pass through it: measured, up to 33% of the sampled leg vertices ended up OUTSIDE the
// cloth during the swing, by as much as 294 mm. That is what "the skirt shows skin when she moves" is.
//
// WHY NOT SKIN THE COAT TO THE THIGHS. It is already allowed to, and distance decides, so the hem does
// pick some thigh weight up -- which is worse than nothing: a hem that follows a thigh rigidly reads as a
// trouser leg, and the two panels tear apart at the split. A garment needs its own bones, driven by its
// own dynamics, which is how every game rig does this.
//
// WHY THREE SEGMENTS. The coat spans 800 mm, from the waist at y=0.95 to the hem at y=0.15, flaring from
// a 160 mm radius to 360 mm (measured by scripts/measure-cloth.mjs). One segment can only swing it as a
// rigid cone; three let it bend, which is what makes a pushed panel fall back in a curve.
//
// The radial offsets follow the measured flare, so distance-based binding claims the right band, and each
// chain hangs in the panel it is named for. Falloff is deliberately wide -- a quarter of the hem's
// circumference is 470 mm -- so adjacent panels blend instead of seaming.
const CLOTH_PANELS: ReadonlyArray<{ tag: string; dx: number; dz: number }> = [
  { tag: 'F', dx: 0, dz: 1 },
  { tag: 'B', dx: 0, dz: -1 },
  { tag: 'L', dx: 1, dz: 0 },
  { tag: 'R', dx: -1, dz: 0 },
];
/** Height and radius at each ring, from the measured profile. */
const CLOTH_RINGS = [
  { y: 0.900, r: 0.150 },
  { y: 0.650, r: 0.210 },
  { y: 0.400, r: 0.290 },
  { y: 0.150, r: 0.350 },
];

/** The coat's bones, and the names of them, so the dynamics and the binding cannot disagree. */
export const CLOTH_BONES: string[] = [];
const clothSpecs: BoneSpec[] = [];
for (const panel of CLOTH_PANELS) {
  for (let i = 0; i < CLOTH_RINGS.length - 1; i += 1) {
    const a = CLOTH_RINGS[i];
    const b = CLOTH_RINGS[i + 1];
    const name = `cloth.${panel.tag}.${i + 1}`;
    CLOTH_BONES.push(name);
    clothSpecs.push({
      name,
      parent: i === 0 ? 'hips' : `cloth.${panel.tag}.${i}`,
      head: [panel.dx * a.r, a.y, panel.dz * a.r],
      tail: [panel.dx * b.r, b.y, panel.dz * b.r],
      falloff: 0.200,
    });
  }
}
BONE_SPECS.push(...clothSpecs);

export interface BuiltSkeleton {
  skeleton: THREE.Skeleton;
  /** the root bone, which must be added to the scene graph for the skeleton to update */
  root: THREE.Bone;
  byName: Record<string, THREE.Bone>;
  /** world-space capsules, kept for weight binding after the bones start moving */
  segments: Array<{ name: string; head: THREE.Vector3; tail: THREE.Vector3; falloff: number }>;
}

export function buildSkeleton(): BuiltSkeleton {
  const byName: Record<string, THREE.Bone> = {};
  const bones: THREE.Bone[] = [];
  const segments: BuiltSkeleton['segments'] = [];

  for (const spec of BONE_SPECS) {
    const bone = new THREE.Bone();
    bone.name = spec.name;
    // Bone positions are PARENT-RELATIVE. Writing world coordinates here is the other classic rig
    // mistake: the chain compounds and the hand ends up metres away from the shoulder.
    const parentHead = spec.parent
      ? BONE_SPECS.find((b) => b.name === spec.parent)!.head
      : [0, 0, 0];
    bone.position.set(
      spec.head[0] - parentHead[0],
      spec.head[1] - parentHead[1],
      spec.head[2] - parentHead[2],
    );
    byName[spec.name] = bone;
    bones.push(bone);
    segments.push({
      name: spec.name,
      head: new THREE.Vector3(...spec.head),
      tail: new THREE.Vector3(...spec.tail),
      falloff: spec.falloff,
    });
  }

  for (const spec of BONE_SPECS) {
    if (spec.parent) byName[spec.parent].add(byName[spec.name]);
  }

  const root = byName[BONE_SPECS[0].name];
  root.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton(bones);
  return { skeleton, root, byName, segments };
}

/** Squared distance from a point to a segment, plus where along the segment it landed. */
function distanceToSegment(
  point: THREE.Vector3, head: THREE.Vector3, tail: THREE.Vector3,
): number {
  const ab = tail.clone().sub(head);
  const lengthSq = ab.lengthSq();
  if (lengthSq < 1e-12) return point.distanceTo(head);
  let t = point.clone().sub(head).dot(ab) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return point.distanceTo(head.clone().addScaledVector(ab, t));
}

/**
 * Bind a geometry to the skeleton, writing `skinIndex` and `skinWeight`.
 *
 * `restrictTo` limits which bones may claim this geometry. Without it a skirt panel picks up chest
 * weight through sheer proximity and the hem lifts when the character breathes — the constraint is
 * anatomical, not numeric, so it is declared per part rather than tuned.
 */
export function bindGeometryToSkeleton(
  geometry: THREE.BufferGeometry,
  built: BuiltSkeleton,
  restrictTo?: string[],
): void {
  const position = geometry.getAttribute('position');
  if (!position) return;

  const allowed = restrictTo
    ? built.segments.filter((s) => restrictTo.includes(s.name))
    : built.segments;
  if (allowed.length === 0) return;

  const boneOrder = built.skeleton.bones.map((b) => b.name);
  /**
   * WHICH SIDE EACH PAIRED BONE BELONGS TO, so a left hip does not drive a right buttock.
   *
   * Weight here is a function of distance to a bone's capsule, and near the pelvis that cannot tell the two
   * hips apart: the thigh heads are 180 mm apart and a buttock sits above and between them, so both claim it
   * almost equally. Measured on the tights: `thigh.L 25% / thigh.R 25%`. The two legs turn opposite ways, so
   * half of each contribution cancels the other, and the buttock moves 16 mm fore-aft relative to the pelvis
   * where its own hip alone would carry it roughly twice that.
   *
   * The gate is anatomy, not a tuning knob: a point on the left of the centre line is moved by the LEFT hip.
   * It is smooth across a 90 mm band so the midline itself still blends, and it changes nothing anywhere the
   * pair is already far apart -- a glove vertex 300 mm out was never getting weight from the other arm.
   */
  const SIDE_BAND = 0.090;
  const sideOf = allowed.map((seg) => (seg.name.endsWith('.L') ? 1 : seg.name.endsWith('.R') ? -1 : 0));
  // Resolve each allowed segment to its bone index ONCE, outside the vertex loop. indexOf inside
  // the loop is a linear scan per influence per vertex.
  const allowedIndex = allowed.map((s) => boneOrder.indexOf(s.name));
  const indices = new Uint16Array(position.count * MAX_INFLUENCES);
  const weights = new Float32Array(position.count * MAX_INFLUENCES);
  const point = new THREE.Vector3();
  const bestWeight = new Float64Array(MAX_INFLUENCES);
  const bestBone = new Int32Array(MAX_INFLUENCES);

  for (let i = 0; i < position.count; i += 1) {
    point.set(position.getX(i), position.getY(i), position.getZ(i));

    // Top-4 by insertion into fixed scratch arrays. The obvious version — map to objects, sort,
    // slice — allocates two arrays per vertex, and at this vertex count that allocation dominates
    // the whole bind. Nothing is allocated in this loop.
    for (let k = 0; k < MAX_INFLUENCES; k += 1) {
      bestWeight[k] = 0;
      bestBone[k] = 0;
    }
    for (let a = 0; a < allowed.length; a += 1) {
      const segment = allowed[a];
      const distance = distanceToSegment(point, segment.head, segment.tail);
      // Inverse-square falloff past the bone's own radius. Squared rather than linear because a
      // linear falloff leaves distant bones with enough weight to drag a limb sideways.
      const reach = distance > segment.falloff ? distance - segment.falloff : 0;
      const ratio = reach / segment.falloff;
      let weight = 1 / (1 + ratio * ratio * 8);
      const side = sideOf[a];
      if (side !== 0) {
        const t = Math.min(1, Math.max(0, (point.x * side) / SIDE_BAND + 0.5));
        weight *= t * t * (3 - 2 * t);
      }
      if (weight <= bestWeight[MAX_INFLUENCES - 1]) continue;
      let slot = MAX_INFLUENCES - 1;
      while (slot > 0 && bestWeight[slot - 1] < weight) {
        bestWeight[slot] = bestWeight[slot - 1];
        bestBone[slot] = bestBone[slot - 1];
        slot -= 1;
      }
      bestWeight[slot] = weight;
      bestBone[slot] = allowedIndex[a];
    }

    let total = 0;
    for (let k = 0; k < MAX_INFLUENCES; k += 1) total += bestWeight[k];
    if (total === 0) total = 1;
    for (let k = 0; k < MAX_INFLUENCES; k += 1) {
      indices[i * MAX_INFLUENCES + k] = bestBone[k];
      weights[i * MAX_INFLUENCES + k] = bestWeight[k] / total;
    }
  }

  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, MAX_INFLUENCES));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, MAX_INFLUENCES));
}

/**
 * Bind a whole geometry rigidly to ONE bone: the allowed bone whose capsule the part sits closest to.
 *
 * A held sword is not soft. Skinned by distance like flesh, a 1.2 m blade gets its hilt from the hand and
 * its tip from whatever else is in range, and the blade bends like a ribbon when the arm moves -- which
 * is exactly what the first render of the crossed guard showed. The same is true of a scabbard strapped
 * to a hip and of a buckle: they are carried, and a carried thing keeps its shape.
 *
 * The bone is chosen by the MEAN distance over the part's own vertices, not by the nearest single vertex,
 * so a long blade cannot be captured by whichever bone its tip happens to swing past.
 */
export function bindRigidToNearestBone(
  geometry: THREE.BufferGeometry,
  built: BuiltSkeleton,
  restrictTo?: string[],
): void {
  const position = geometry.getAttribute('position');
  if (!position) return;
  const allowed = restrictTo
    ? built.segments.filter((s) => restrictTo.includes(s.name))
    : built.segments;
  if (allowed.length === 0) return;

  const point = new THREE.Vector3();
  const stride = Math.max(1, Math.floor(position.count / 4000));
  let best = { name: allowed[0].name, mean: Infinity };
  for (const segment of allowed) {
    let total = 0;
    let counted = 0;
    for (let i = 0; i < position.count; i += stride) {
      point.set(position.getX(i), position.getY(i), position.getZ(i));
      total += distanceToSegment(point, segment.head, segment.tail);
      counted += 1;
    }
    const mean = total / Math.max(counted, 1);
    if (mean < best.mean) best = { name: segment.name, mean };
  }
  const index = built.skeleton.bones.map((b) => b.name).indexOf(best.name);
  const indices = new Uint16Array(position.count * MAX_INFLUENCES);
  const weights = new Float32Array(position.count * MAX_INFLUENCES);
  for (let i = 0; i < position.count; i += 1) {
    indices[i * MAX_INFLUENCES] = index < 0 ? 0 : index;
    weights[i * MAX_INFLUENCES] = 1;
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, MAX_INFLUENCES));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, MAX_INFLUENCES));
}

/**
 * Which bones each region is allowed to be driven by.
 *
 * Hair is deliberately absent: it is rigidly parented, never smooth-skinned. The geodesic field runs
 * through the skull, so a skinned crown vertex picks up measurable neck weight and shears against
 * the skull the moment the head turns.
 */
/**
 * Force an explicit weight on a vertex range, overriding the distance solve.
 *
 * Needed where geometry is merged: an eyelid shell sits about a millimetre outside the eyeball it
 * covers, so no distance-based binder can tell them apart — but the merge KNOWS which vertices came
 * from which sub-geometry, and that is exact information the solver does not have.
 */
/**
 * Blend a bone into whatever already claims the vertices inside a sphere.
 *
 * WHY THIS EXISTS. The eyelid bones drove nothing at all. Their weights were assigned from a vertex RANGE
 * -- which works on the lofted head, where the lids are separate pieces with known ranges, and does not
 * exist on the decoded surface, where the head is one mesh and the lids are part of it. So the blink
 * rotated two bones that no vertex was bound to, and the idle gate passed it for months because the gate
 * measured the BONE's rotation rather than whether any surface moved.
 *
 * Geometry is the only handle left once the ranges are gone, so this takes a sphere and a falloff and
 * blends the bone in over it, displacing the existing weights proportionally rather than replacing them:
 * an eyelid that detaches from the face at its edge is worse than one that does not move.
 */
export function blendBoneInSphere(
  geometry: THREE.BufferGeometry,
  built: BuiltSkeleton,
  boneName: string,
  centre: [number, number, number],
  radius: number,
  accept: (x: number, y: number, z: number) => boolean,
): number {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const indices = geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
  const weights = geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
  if (!pos || !indices || !weights) return 0;
  const boneIndex = built.skeleton.bones.findIndex((b) => b.name === boneName);
  if (boneIndex < 0) return 0;
  let touched = 0;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (!accept(x, y, z)) continue;
    const d = Math.hypot(x - centre[0], y - centre[1], z - centre[2]);
    if (d >= radius) continue;
    // Smooth to zero at the rim, so the lid's edge stays welded to the face.
    const t = 1 - d / radius;
    const w = t * t * (3 - 2 * t);
    if (w < 0.01) continue;
    touched += 1;
    // Scale down whatever is there, then put this bone in the weakest slot.
    let weakest = 0;
    let weakestW = Infinity;
    for (let k = 0; k < 4; k += 1) {
      const existing = weights.getComponent(i, k) * (1 - w);
      weights.setComponent(i, k, existing);
      if (existing < weakestW) { weakestW = existing; weakest = k; }
    }
    indices.setComponent(i, weakest, boneIndex);
    weights.setComponent(i, weakest, weakestW + w);
    // Renormalise: the displaced weight plus the new one need not sum to exactly one.
    let sum = 0;
    for (let k = 0; k < 4; k += 1) sum += weights.getComponent(i, k);
    if (sum > 1e-6) for (let k = 0; k < 4; k += 1) weights.setComponent(i, k, weights.getComponent(i, k) / sum);
  }
  indices.needsUpdate = true;
  weights.needsUpdate = true;
  return touched;
}

export function overrideWeights(
  geometry: THREE.BufferGeometry,
  built: BuiltSkeleton,
  range: { start: number; count: number },
  boneName: string,
): void {
  const indices = geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
  const weights = geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
  if (!indices || !weights) return;
  const boneIndex = built.skeleton.bones.findIndex((b) => b.name === boneName);
  if (boneIndex < 0) return;
  for (let i = range.start; i < range.start + range.count; i += 1) {
    indices.setXYZW(i, boneIndex, 0, 0, 0);
    weights.setXYZW(i, 1, 0, 0, 0);
  }
  indices.needsUpdate = true;
  weights.needsUpdate = true;
}

export const REGION_BONE_LIMITS: Record<string, string[]> = {
  // PARTS THAT MEET MUST BE ALLOWED THE SAME BONES, and that is not a nicety. The weight of a vertex
  // depends on which bones its part may use, so the same physical point on the arm was getting one
  // transform as bare skin and a different one as glove -- and at a raised-arm pose the two surfaces came
  // apart, with daylight at the shoulder and the elbow. The arm chain therefore appears in full on every
  // region that touches the arm. Distance still decides: the head is nowhere near `hand.L`, so listing
  // it costs nothing.
  skin: ['hips', 'spine', 'chest', 'neck', 'head', 'jaw', 'lipCorner.L', 'lipCorner.R',
    'shoulder.L', 'upperArm.L', 'upperArmTwist.L', 'foreArm.L', 'foreArmTwist.L', 'hand.L',
    'shoulder.R', 'upperArm.R', 'upperArmTwist.R', 'foreArm.R', 'foreArmTwist.R', 'hand.R'],
  face: ['head', 'jaw', 'lipCorner.L', 'lipCorner.R'],
  hair: ['head', 'ponytail'],
  innerTop: ['spine', 'chest'],
  corset: ['hips', 'spine', 'chest'],
  skirt: ['hips', 'spine', 'thigh.L', 'thigh.R', 'shin.L', 'shin.R'],
  // The coat only. `skirt` is the REGION of the tights and both thigh pieces as well as the coat, and
  // letting those bind to cloth bones would drag the legs around with the garment -- backwards.
  coat: ['hips', 'spine', ...CLOTH_BONES],
  belts: ['hips', 'spine'],
  pouches: ['hips'],
  gloves: ['shoulder.L', 'upperArm.L', 'upperArmTwist.L', 'foreArm.L', 'foreArmTwist.L', 'hand.L',
    'shoulder.R', 'upperArm.R', 'upperArmTwist.R', 'foreArm.R', 'foreArmTwist.R', 'hand.R'],
  boots: ['shin.L', 'foot.L', 'toe.L', 'shin.R', 'foot.R', 'toe.R'],
  // THE BLADES ARE HELD, so they follow the hand. Left unlisted they fell through to every bone and bound
  // to whatever was nearest -- the hips -- so the swords stayed hanging at her sides through every strike
  // while the hands swung without them. Distance sorts left from right: each blade is next to its own
  // hand. The forearm is included so a blade cannot pivot independently of the wrist holding it.
  weapons: ['hand.L', 'foreArm.L', 'hand.R', 'foreArm.R'],
  // The scabbards are strapped to the body, not carried.
  scabbards: ['hips', 'spine', 'thigh.L', 'thigh.R'],
  hardware: ['hips', 'spine', 'chest'],
};
