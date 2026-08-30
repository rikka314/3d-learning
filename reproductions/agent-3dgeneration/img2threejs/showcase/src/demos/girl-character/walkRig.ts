/**
 * A procedural skeleton and walk cycle for the girl-character demo.
 *
 * THIS PART IS GENUINELY CODE, and unusually for this demo there was no alternative. The baseline GLB
 * declares `animations: 0`, `skins: 0`, and carries no JOINTS_0 or WEIGHTS_0 on any primitive -- there
 * is no rig in the asset to copy, so every joint position, every skin weight and every pose below is
 * computed here.
 *
 * JOINTS COME FROM THE MODEL'S OWN BOUNDS, not from typed-in numbers. The factory's parts are named
 * anatomically, so a knee is placed where the shin mesh actually ends rather than at a guessed fraction
 * of figure height. Measured off the built model:
 *
 *     boots        y -0.001..0.167     ankle sits at the boot top
 *     shins        y  0.158..0.433     knee at the shin top
 *     trousers     y  0.522..1.154     hip below the belt
 *     torso+arms   y  0.974..1.602     shoulder below the neck
 *     head         y  1.525..1.749
 *
 * SKINNING RATHER THAN RIGID PARTS, because node 1 is a single mesh holding the torso AND both arms.
 * Rotating it as a rigid body cannot swing an arm. Linear blend skinning also keeps the surface
 * continuous at the hip and shoulder, where rigid parts would open a visible gap.
 */
import * as THREE from 'three';

type JointSpec = {
  name: string;
  parent: string | null;
  /** World position at bind time, in metres. */
  head: readonly [number, number, number];
  /**
   * Influence radius as a fraction of figure height -- the bone's capsule, not a point.
   *
   * WITHOUT THIS THE TORSO FOLLOWS THE ARMS. Weighting by raw distance to the bone segment reads the
   * body inside out: the torso SURFACE sits ~0.15 m from the spine axis, while the arms hang against
   * the ribs, so an arm segment passes closer to a chest vertex than the spine does. Measured on the
   * first build, the torso mesh's dominant bone was shoulder.L at 25.2% -- ahead of spine at 21.8% --
   * and the torso duly swung with the arm instead of rotating.
   *
   * Radii come from the measured part widths: torso x-extent ~0.26 m without the arms, shins ~0.11,
   * boots ~0.14. A vertex inside the capsule is treated as distance zero, so a thick bone owns its own
   * volume and a thin one cannot reach across the body.
   */
  radius: number;
};

/**
 * Derived from the measured bounds above. `left` and `right` are the CHARACTER's, which is why left is
 * at positive x: the figure faces +z.
 */
function jointSpecs(bounds: THREE.Box3, centreX: number): JointSpec[] {
  const cx = centreX;
  const top = bounds.max.y;
  const h = top - bounds.min.y;
  const at = (x: number, y: number, z = 0): readonly [number, number, number] =>
    [cx + x * h, bounds.min.y + y * h, z];
  // Fractions of figure height, read off the part bounds rather than chosen: ankle 0.09 is the boot
  // top, knee 0.25 the shin top, hip 0.52 below the belt, shoulder 0.84 below the neck, head 0.93.
  return [
    // A FOUR-LINK SPINE, not one. With a single `spine` bone the whole trunk turned as a slab; the
    // waist, the ribcage and the shoulder girdle each need their own share of the counter-rotation for
    // the torso to read as a body rather than a board.
    { name: 'hips', parent: null, head: at(0, 0.52) , radius: 0.078 },
    { name: 'spine.01', parent: 'hips', head: at(0, 0.595) , radius: 0.074 },
    { name: 'spine.02', parent: 'spine.01', head: at(0, 0.665) , radius: 0.076 },
    { name: 'chest', parent: 'spine.02', head: at(0, 0.745) , radius: 0.082 },
    { name: 'shoulders', parent: 'chest', head: at(0, 0.815) , radius: 0.080 },
    { name: 'neck', parent: 'shoulders', head: at(0, 0.875) , radius: 0.036 },
    { name: 'head', parent: 'neck', head: at(0, 0.94) , radius: 0.058 },

    { name: 'shoulder.L', parent: 'shoulders', head: at(0.095, 0.84) , radius: 0.032 },
    { name: 'elbow.L', parent: 'shoulder.L', head: at(0.130, 0.685) , radius: 0.028 },
    { name: 'wrist.L', parent: 'elbow.L', head: at(0.145, 0.545) , radius: 0.026 },

    { name: 'shoulder.R', parent: 'shoulders', head: at(-0.095, 0.84) , radius: 0.032 },
    { name: 'elbow.R', parent: 'shoulder.R', head: at(-0.135, 0.685) , radius: 0.028 },
    { name: 'wrist.R', parent: 'elbow.R', head: at(-0.165, 0.560) , radius: 0.026 },

    { name: 'hip.L', parent: 'hips', head: at(0.072, 0.505) , radius: 0.048 },
    { name: 'knee.L', parent: 'hip.L', head: at(0.072, 0.253) , radius: 0.044 },
    { name: 'ankle.L', parent: 'knee.L', head: at(0.080, 0.092) , radius: 0.042 },
    { name: 'toe.L', parent: 'ankle.L', head: at(0.080, 0.010, 0.09) , radius: 0.04 },

    { name: 'hip.R', parent: 'hips', head: at(-0.072, 0.505) , radius: 0.048 },
    { name: 'knee.R', parent: 'hip.R', head: at(-0.075, 0.253) , radius: 0.044 },
    { name: 'ankle.R', parent: 'knee.R', head: at(-0.080, 0.092) , radius: 0.042 },
    { name: 'toe.R', parent: 'ankle.R', head: at(-0.080, 0.010, 0.09) , radius: 0.04 },
  ];
}

/**
 * Which bones a region's vertices may bind to, keyed by the part's own semantic region.
 *
 * A capsule radius fixes "the torso follows the arm", but it cannot fix "the belt pouch follows the
 * left leg" -- a pouch hanging at hip height genuinely IS closest to the thigh bone, and no radius
 * makes that false. What makes it wrong is knowledge the geometry does not carry and the part list
 * does: a pouch is worn on the BELT, so it rides the pelvis however the leg swings.
 *
 * Measured before this table existed, and every line below is one of those readings:
 *     cage canister      hip.L 66%, hips 34%     -> would swing with the left leg
 *     belt pouch, left   hip.L 100%              -> same
 *     head and hair      chest 58%, head 39%     -> skull owned by the chest capsule, would not turn
 *
 * Regions absent from this table are unconstrained: `skin` and `overalls` span the whole figure and
 * have to reach every bone.
 */
const REGION_BONES: Record<string, readonly string[]> = {
  pouches: ['hips', 'spine.01'],
  canister: ['hips', 'spine.01'],
  'knee-pads': ['hips', 'hip.L', 'knee.L', 'ankle.L', 'hip.R', 'knee.R', 'ankle.R'],
  boots: ['knee.L', 'ankle.L', 'toe.L', 'knee.R', 'ankle.R', 'toe.R'],
  gloves: ['shoulder.L', 'elbow.L', 'wrist.L', 'shoulder.R', 'elbow.R', 'wrist.R'],
  hair: ['neck', 'head'],
  /**
   * ONE bone, because a sword is RIGID. Allowing the arm chain and the pelvis both meant the katana was
   * 44.7% arm-bound and 55% hip-bound -- a single solid object split between the hand holding it and
   * the body it hangs beside -- so every arm movement stretched it and the scabbard tore away from the
   * hilt. A rigid prop wants a rigid attachment, and this one is held in the right hand.
   */
  katana: ['wrist.R'],
  /**
   * The trousers reach hip to knee and nothing above the waist, so no arm bone has any business in
   * them -- but the left arm hangs against them, and 13.8% of the garment was arm-DOMINATED before
   * this line existed. That is the "the arm swings and the trousers go with it" the eye picks up.
   */
  overalls: ['hips', 'spine.01', 'hip.L', 'knee.L', 'hip.R', 'knee.R'],
};

/**
 * Fasteners ride a bone RIGIDLY rather than being skinned.
 *
 * The 104 studs are drawn as InstancedMesh, which cannot be skinned, and the first version simply
 * skipped them -- so all eight fastener meshes stayed frozen in mid-air while the trousers, knee pads
 * and boots they belong to moved away underneath. A bolt is rigid anyway: the honest model is to fix
 * each instance to the bone nearest it and carry it along.
 */
type InstanceAttachment = {
  mesh: THREE.InstancedMesh;
  /** Bone index per instance, into `skeleton.bones`. */
  bone: Int32Array;
  /** Instance transform expressed in that bone's bind space. */
  local: THREE.Matrix4[];
};

export type WalkRig = {
  skeleton: THREE.Skeleton;
  bones: Map<string, THREE.Bone>;
  root: THREE.Bone;
  /** Bind every skinnable mesh under `model`, converting each into a SkinnedMesh in place. */
  boundMeshes: THREE.SkinnedMesh[];
  attachments: InstanceAttachment[];
};

/** Squared distance from a point to a finite segment, plus where along it the foot lands. */
function distanceToSegment(px: number, py: number, pz: number,
                           ax: number, ay: number, az: number,
                           bx: number, by: number, bz: number): number {
  const dx = bx - ax; const dy = by - ay; const dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = len2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + dx * t; const qy = ay + dy * t; const qz = az + dz * t;
  return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
}

/**
 * Build the skeleton and skin every region mesh to it.
 *
 * Weights are the two nearest bone SEGMENTS with an inverse-square falloff, which is the cheapest
 * scheme that still blends across a joint instead of stepping at it. Two influences is enough here: a
 * walk bends knees, hips, shoulders and elbows, and none of those is a place where three bones meet.
 */
export function buildWalkRig(model: THREE.Object3D): WalkRig | null {
  const meshes: THREE.Mesh[] = [];
  const rigid: THREE.Mesh[] = [];
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as unknown as THREE.InstancedMesh).isInstancedMesh
        || !mesh.userData?.region || !mesh.geometry?.attributes?.position) return;
    // A mesh that names a bone is RIGID and rides it -- an eyeball is a ball, not skin, and skinning
    // one would squash it with the eyelid it sits behind.
    if (typeof mesh.userData.rigTo === 'string') rigid.push(mesh);
    else meshes.push(mesh);
  });
  if (!meshes.length) return null;

  const bounds = new THREE.Box3();
  for (const mesh of meshes) bounds.expandByObject(mesh);
  if (!Number.isFinite(bounds.min.y) || bounds.isEmpty()) return null;

  /**
   * THE SPINE AXIS COMES FROM THE LEGS, NOT FROM THE MODEL'S BOUNDS, and getting this wrong displaced
   * the entire skeleton by 9 cm.
   *
   * `(bounds.min.x + bounds.max.x) / 2` looks like the body centre and is not: the bounds include both
   * arms, and this figure holds one out to x -0.378 while the other hangs at +0.335. The midpoint lands
   * at -0.02 instead of the true centre 0.074, so every capsule sat 9 cm to the character's right. The
   * left side of the torso then fell OUTSIDE the trunk guard and bound to arm bones -- 41% of the band
   * x 0.14..0.20, which is torso, not shoulder. That is the "the side of the body moves with the arm"
   * that survived two earlier rounds of fixes.
   *
   * The legs are symmetric and never raised, so their combined extent gives the axis honestly. Falls
   * back to the bounds midpoint only if no leg part is present.
   */
  const legX: number[] = [];
  for (const mesh of meshes) {
    const region = mesh.userData.region as string;
    if (region !== 'boots' && region !== 'knee-pads') continue;
    const box = new THREE.Box3().setFromObject(mesh);
    legX.push(box.min.x, box.max.x);
  }
  const centreX = legX.length
    ? (Math.min(...legX) + Math.max(...legX)) / 2
    : (bounds.min.x + bounds.max.x) / 2;
  const specs = jointSpecs(bounds, centreX);
  const bones = new Map<string, THREE.Bone>();
  for (const spec of specs) {
    const bone = new THREE.Bone();
    bone.name = spec.name;
    bones.set(spec.name, bone);
  }
  // Positions are LOCAL to the parent, which is what a Bone expects.
  for (const spec of specs) {
    const bone = bones.get(spec.name)!;
    const parent = spec.parent ? bones.get(spec.parent)! : null;
    const parentSpec = spec.parent ? specs.find((s) => s.name === spec.parent)! : null;
    bone.position.set(
      spec.head[0] - (parentSpec?.head[0] ?? 0),
      spec.head[1] - (parentSpec?.head[1] ?? 0),
      spec.head[2] - (parentSpec?.head[2] ?? 0),
    );
    if (parent) parent.add(bone);
  }
  const root = bones.get('hips')!;
  root.updateMatrixWorld(true);

  const order = specs.map((s) => s.name);
  const boneList = order.map((n) => bones.get(n)!);
  const skeleton = new THREE.Skeleton(boneList);

  // Segment table in WORLD space, matching the bind pose. A bone's segment runs from its own head to
  // its first child's head; a leaf borrows its parent's direction so wrists and toes still attract the
  // vertices around them.
  const segments = specs.map((spec, i) => {
    const child = specs.find((s) => s.parent === spec.name);
    const a = spec.head;
    const b = child
      ? child.head
      : ([a[0] + (a[0] - (specs.find((s) => s.name === spec.parent)?.head[0] ?? a[0])) * 0.6,
          a[1] + (a[1] - (specs.find((s) => s.name === spec.parent)?.head[1] ?? a[1])) * 0.6,
          a[2] + (a[2] - (specs.find((s) => s.name === spec.parent)?.head[2] ?? a[2])) * 0.6,
         ] as const);
    return { index: i, a, b, radius: spec.radius * (bounds.max.y - bounds.min.y) };
  });

  const boundMeshes: THREE.SkinnedMesh[] = [];
  for (const mesh of meshes) {
    mesh.updateMatrixWorld(true);
    /**
     * A shin is the lower-leg surface, not a continuation of the thigh. The generic `skin` region
     * used to let its upper vertices blend between hip and knee; when the hip counter-swung behind the
     * body, that split the shin across the rear camera even though the knee itself was only slightly
     * flexed. Keep the lower-leg surface on its own knee-to-ankle chain and let the trouser cuff hide
     * the transition above the knee.
     */
    const shinAllowed = mesh.name === 'shin, character left'
      ? (['knee.L', 'ankle.L'] as const)
      : mesh.name === 'shin, character right'
        ? (['knee.R', 'ankle.R'] as const)
        : undefined;
    const allowed = shinAllowed ?? REGION_BONES[mesh.userData.region as string];
    const candidates = allowed
      ? segments.filter((seg) => allowed.includes(specs[seg.index].name))
      : segments;
    /**
     * ARM BONES ARE BANNED INSIDE THE TRUNK, and this is the fix for "the arm swings and the whole
     * torso goes with it". The arms hang against the ribs, so an arm segment is genuinely nearer to a
     * chest vertex than the spine axis is -- 19% of the torso mesh bound to shoulder.L. A capsule
     * radius alone cannot separate them because the two volumes overlap in space.
     *
     * The rule is anatomical rather than numeric: a vertex INSIDE the trunk capsule belongs to the
     * trunk, whatever else happens to be close. Outside it the ordinary blend runs, so the shoulder
     * still deforms smoothly instead of creasing at a hard boundary.
     */
    const armBones = new Set(['shoulder.L', 'elbow.L', 'wrist.L', 'shoulder.R', 'elbow.R', 'wrist.R']);
    const trunk = segments.filter((seg) => !armBones.has(specs[seg.index].name)
      && ['hips', 'spine.01', 'spine.02', 'chest', 'shoulders'].includes(specs[seg.index].name));
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    const count = position.count;
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i += 1) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      /**
       * A SMOOTH trunk shield, not a hard ban -- and the hard ban is what tore the arm off.
       *
       * Removing arm bones outright inside the trunk capsule leaves a vertex a hair inside carrying 0%
       * arm weight next to one a hair outside carrying nearly all of it. Linear blend skinning sends
       * those two neighbours to completely different places the moment the shoulder rotates, and the
       * surface splits along that line. The binding share ran 0% -> 56% -> 100% across 12 cm, which is
       * a seam waiting to open.
       *
       * `depth` ramps from 0 at the guard boundary to 1 well inside it, and arm influence is scaled by
       * `1 - depth`. At the spine that is still exactly zero, so the protection is unchanged; at the
       * shoulder it becomes a gradient the deformation can blend over.
       */
      let depth = 0;
      for (const seg of trunk) {
        // 1.35x the binding radius, because a capsule sized to the body puts the body's own SKIN on the
        // boundary and half of it falls outside the shield.
        const guard = seg.radius * 1.35;
        const d = Math.sqrt(distanceToSegment(v.x, v.y, v.z, seg.a[0], seg.a[1], seg.a[2],
                                              seg.b[0], seg.b[1], seg.b[2]));
        depth = Math.max(depth, Math.min(1, Math.max(0, (guard - d) / (guard * 0.55))));
      }

      /**
       * FOUR influences, not two. Two is enough at a knee, where one bone meets one bone. A shoulder
       * has the upper arm, the shoulder girdle and the ribcage all meeting at once, and two slots force
       * the ribcage out entirely -- which is the other half of why the arm separated.
       */
      const scored: Array<{ index: number; w: number }> = [];
      for (const seg of (candidates.length ? candidates : segments)) {
        // Distance to the CAPSULE, not the axis: inside the bone's own radius counts as zero.
        const d = Math.max(0, Math.sqrt(distanceToSegment(
          v.x, v.y, v.z, seg.a[0], seg.a[1], seg.a[2], seg.b[0], seg.b[1], seg.b[2])) - seg.radius);
        // INVERSE-LINEAR, not inverse-square. 1/d^2 is so steep that the moment a vertex clears the
        // trunk the arm bone takes essentially all of it -- the ramp measured a 47% step between two
        // 2 cm slices, which is still a crease. 1/d spreads the same transition over several
        // centimetres, which is what lets the shoulder deform instead of hinge.
        let w = 1 / (d + 3e-3);
        if (armBones.has(specs[seg.index].name)) w *= 1 - depth;
        if (w > 0) scored.push({ index: seg.index, w });
      }
      scored.sort((a, b) => b.w - a.w);
      const take = scored.slice(0, 4);
      const sum = take.reduce((acc, x) => acc + x.w, 0) || 1;
      for (let k = 0; k < 4; k += 1) {
        // Pad unused slots with the DOMINANT bone, not with index 0. The weight is zero either way, so
        // the deformation is identical -- but index 0 is `hips`, and any tool that reads skinIndex
        // without checking the weight then reports every rigid prop as partly hip-bound. That is
        // exactly what made a katana pinned to one bone look like it was bound to two.
        skinIndex[i * 4 + k] = take[k]?.index ?? take[0]?.index ?? 0;
        skinWeight[i * 4 + k] = take[k] ? take[k].w / sum : 0;
      }
    }
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));

    const skinned = new THREE.SkinnedMesh(geometry, mesh.material as THREE.Material);
    skinned.name = mesh.name;
    skinned.userData = mesh.userData;
    skinned.castShadow = mesh.castShadow;
    skinned.receiveShadow = mesh.receiveShadow;
    skinned.position.copy(mesh.position);
    skinned.quaternion.copy(mesh.quaternion);
    skinned.scale.copy(mesh.scale);
    const parent = mesh.parent!;
    parent.add(skinned);
    parent.remove(mesh);
    // Geometry is authored in world space, so the bind matrix is the identity the bones already use.
    skinned.bind(skeleton, new THREE.Matrix4());
    boundMeshes.push(skinned);
  }
  /**
   * Fasteners LAST, and pinned to the bone of the nearest SURFACE VERTEX rather than the nearest bone.
   *
   * Nearest-bone was the first version and it pulled the studs off the knee pads. The knee-pad mesh
   * binds 97% to hip.L -- the pad is armour over the thigh -- while a stud sitting on its lower edge is
   * physically closest to knee.L. Bind the two by different rules and they separate the moment the knee
   * folds, which is exactly what showed: pale discs lifting off the pad.
   *
   * Taking the bone from the host surface guarantees a bolt goes wherever the plate it is screwed
   * through goes, whatever the skeleton thinks is nearby.
   */
  const attachments: InstanceAttachment[] = [];
  model.traverse((o) => {
    const inst = o as THREE.InstancedMesh;
    if (!inst.isInstancedMesh || !inst.userData?.region) return;
    inst.updateMatrixWorld(true);
    const hosts = boundMeshes.filter((m) => m.userData.region === inst.userData.region);
    if (!hosts.length) return;
    const bone = new Int32Array(inst.count);
    const local: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4();
    const world = new THREE.Matrix4();
    const at = new THREE.Vector3();
    const vert = new THREE.Vector3();
    for (let i = 0; i < inst.count; i += 1) {
      inst.getMatrixAt(i, m);
      world.multiplyMatrices(inst.matrixWorld, m);
      at.setFromMatrixPosition(world);
      let bestBone = 0;
      let bestD = Infinity;
      for (const host of hosts) {
        const pos = host.geometry.attributes.position;
        const si = host.geometry.attributes.skinIndex;
        const stride = Math.max(1, Math.floor(pos.count / 4000));
        for (let k = 0; k < pos.count; k += stride) {
          vert.fromBufferAttribute(pos, k).applyMatrix4(host.matrixWorld);
          const d = vert.distanceToSquared(at);
          if (d < bestD) { bestD = d; bestBone = si.getX(k); }
        }
      }
      bone[i] = bestBone;
      local.push(new THREE.Matrix4().multiplyMatrices(skeleton.boneInverses[bestBone], world));
    }
    inst.frustumCulled = false;
    attachments.push({ mesh: inst, bone, local });
  });

  // Rigid riders: re-parent to their bone so the transform comes for free, keeping world placement.
  for (const mesh of rigid) {
    const bone = bones.get(mesh.userData.rigTo as string);
    if (!bone) continue;
    bone.updateMatrixWorld(true);
    mesh.updateMatrixWorld(true);
    const local = new THREE.Matrix4()
      .copy(bone.matrixWorld).invert().multiply(mesh.matrixWorld);
    mesh.parent?.remove(mesh);
    bone.add(mesh);
    local.decompose(mesh.position, mesh.quaternion, mesh.scale);
  }

  model.add(root);
  return { skeleton, bones, root, boundMeshes, attachments };
}

const ATTACH_WORLD = new THREE.Matrix4();
const ATTACH_LOCAL = new THREE.Matrix4();

/** Carry every fastener instance along on the bone it was pinned to. Call after the bones are posed. */
export function poseAttachments(rig: WalkRig): void {
  for (const attachment of rig.attachments) {
    const { mesh, bone, local } = attachment;
    // Instance matrices are relative to the mesh, so undo the mesh's own world transform.
    ATTACH_LOCAL.copy(mesh.matrixWorld).invert();
    for (let i = 0; i < mesh.count; i += 1) {
      ATTACH_WORLD.multiplyMatrices(rig.skeleton.bones[bone[i]].matrixWorld, local[i]);
      ATTACH_WORLD.premultiply(ATTACH_LOCAL);
      mesh.setMatrixAt(i, ATTACH_WORLD);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Rest pose, captured once so `stop()` can return to exactly where the model was built. */
export type RestPose = Map<string, THREE.Quaternion>;

export function captureRest(rig: WalkRig): RestPose {
  const rest: RestPose = new Map();
  for (const [name, bone] of rig.bones) rest.set(name, bone.quaternion.clone());
  return rest;
}

export function applyRest(rig: WalkRig, rest: RestPose): void {
  for (const [name, bone] of rig.bones) {
    const q = rest.get(name);
    if (q) bone.quaternion.copy(q);
  }
  rig.root.position.y = rig.root.userData.restY ?? rig.root.position.y;
  rig.root.updateMatrixWorld(true);
}

const EULER = new THREE.Euler();

/**
 * Keep the swinging arm inside the deformation envelope of the authored torso-and-arm surface.
 *
 * The shoulder is a continuous surface, not a separate upper-arm shell. Beyond this small sagittal
 * arc the low-resolution shoulder triangles fold over themselves under linear blend skinning and become
 * back-facing slits. IDLE stays below that envelope; WALK is the only action that needs an explicit
 * guard. The limits preserve a visible counter-swing while preventing the arm from crossing its own
 * skin at the far end of the orbit.
 */
const WALK_ARM_LIMITS = {
  freeShoulder: { gain: 0.14, max: 0.05 },
  freeElbow: { gain: 0.10, max: 0.025 },
  armedShoulder: { gain: 0.04, max: 0.02 },
  armedElbow: { gain: 0.025, max: 0.012 },
} as const;

/** Smoothly saturate instead of introducing a hard kink into the periodic gait. */
const limitAngle = (value: number, limit: number): number =>
  limit * Math.tanh(value / limit);

/**
 * A walk cycle written as joint angles over phase, which is how a walk is actually described.
 *
 * The right arm is deliberately quieter than the left: this figure carries a katana in it, and a full
 * counter-swing on an armed hand reads as flailing rather than walking.
 */
/**
 * REAL GAIT CURVES, as a Fourier series, because a walk is not a sine wave and a clamp is not a joint.
 *
 * The knee flexes TWICE per stride, and that is the whole difference between a walk and a limp: a small
 * stance flexion of about 18 degrees just after heel strike, absorbing the load, and a large swing
 * flexion of about 60 degrees while the foot clears the ground. Every version before this one had a
 * single peak, which is why the leg read as disjointed no matter how the amplitudes were tuned.
 *
 * Coefficients are fitted to standard sagittal joint angles for adult level walking, sampled every 5%
 * of the cycle from heel strike. Four harmonics reproduce them to:
 *
 *     hip    0.27 deg      knee   0.89 deg      ankle  1.44 deg
 *
 * A truncated Fourier series is smooth by CONSTRUCTION -- infinitely differentiable and periodic -- so
 * unlike a clamped sine it cannot introduce a kink anywhere, at any amplitude, and the cycle joins
 * itself seamlessly at the wrap.
 */
type Harmonic = readonly [number, number];
type GaitCurve = { readonly dc: number; readonly h: readonly Harmonic[] };

const GAIT_HIP: GaitCurve = {
  dc: +0.20420,
  h: [[+0.33309, +0.02366], [-0.01022, -0.06826], [-0.00988, +0.01655], [+0.00457, +0.00000]],
};
const GAIT_KNEE: GaitCurve = {
  dc: +0.38572,
  h: [[-0.07829, -0.35537], [-0.20773, +0.18267], [+0.01966, +0.07181], [-0.01740, +0.00474]],
};
const GAIT_ANKLE: GaitCurve = {
  dc: -0.01571,
  h: [[-0.00172, +0.10605], [-0.02703, -0.13819], [+0.00560, +0.03738], [+0.02708, -0.02915]],
};

/** Evaluate a gait curve at a phase in [0,1). Radians. */
function gait(curve: GaitCurve, phase: number): number {
  let v = curve.dc;
  for (let i = 0; i < curve.h.length; i += 1) {
    const w = 2 * Math.PI * (i + 1) * phase;
    v += curve.h[i][0] * Math.cos(w) + curve.h[i][1] * Math.sin(w);
  }
  return v;
}

/**
 * One stride of a human walk.
 *
 * SIGNS, and the first set was backwards -- the figure walked in reverse.
 *
 * In this rig a bone's local axes are world-aligned, so a POSITIVE x rotation swings a downward limb to
 * -Z, i.e. BACKWARD. Hip flexion is therefore -x, knee flexion +x, ankle dorsiflexion -x. Getting the
 * hip and knee the wrong way round plays the whole gait in reverse, which is not obvious by eye because
 * the pose is still symmetric -- it just reads as moonwalking.
 *
 * Confirmed by forward kinematics on the ankle rather than by looking: a real walk swings the foot
 * FORWARD fast over a short swing phase and drifts it back slowly through a long stance.
 *
 *     hip +, knee -    66% of the cycle moving forward, peak +2.49 / -4.02   fast BACKWARD
 *     hip -, knee +    34%                              peak +4.02 / -2.49   fast forward, 40% swing
 *
 * The second matches the human 40% swing / 60% stance split.
 *
 * `scale` trims every joint together, so the walk can be made gentler without changing its shape --
 * which is what tuning individual amplitudes used to do, and what broke the coordination between them.
 */
export function poseWalk(rig: WalkRig, rest: RestPose, phase: number): void {
  const set = (name: string, x: number, y = 0, z = 0): void => {
    const bone = rig.bones.get(name);
    if (!bone) return;
    EULER.set(x, y, z, 'XYZ');
    bone.quaternion.copy(rest.get(name)!).multiply(new THREE.Quaternion().setFromEuler(EULER));
  };
  const SCALE = 0.78;
  const L = phase % 1;
  const R = (phase + 0.5) % 1;              // the other leg is exactly half a cycle behind

  for (const [side, p] of [['L', L], ['R', R]] as const) {
    set(`hip.${side}`, -gait(GAIT_HIP, p) * SCALE);
    set(`knee.${side}`, gait(GAIT_KNEE, p) * SCALE);
    set(`ankle.${side}`, -gait(GAIT_ANKLE, p) * SCALE);
  }

  // Arms counter-swing the legs: the left arm goes with the RIGHT leg. Amplitude is a fraction of the
  // hip's, and the armed side keeps a third of that -- a hand holding a katana does not swing freely.
  const armL = gait(GAIT_HIP, R) - GAIT_HIP.dc;
  const armR = gait(GAIT_HIP, L) - GAIT_HIP.dc;
  set('shoulder.L', limitAngle(-armL * WALK_ARM_LIMITS.freeShoulder.gain, WALK_ARM_LIMITS.freeShoulder.max));
  set('elbow.L', limitAngle(Math.max(0, -armL) * WALK_ARM_LIMITS.freeElbow.gain, WALK_ARM_LIMITS.freeElbow.max));
  set('shoulder.R', limitAngle(-armR * WALK_ARM_LIMITS.armedShoulder.gain, WALK_ARM_LIMITS.armedShoulder.max));
  set('elbow.R', limitAngle(Math.max(0, -armR) * WALK_ARM_LIMITS.armedElbow.gain, WALK_ARM_LIMITS.armedElbow.max));

  // Pelvis and shoulder girdle turn opposite ways, spread along the spine so no joint shears.
  const twist = Math.sin(2 * Math.PI * L);
  set('hips', 0, -twist * 0.09);
  set('spine.01', 0, twist * 0.035);
  set('spine.02', 0, twist * 0.045);
  set('chest', 0, twist * 0.050);
  set('shoulders', 0, twist * 0.045);
  set('head', 0, -twist * 0.035);

  // The pelvis drops twice per stride, once under each leg's load.
  const restY = rig.root.userData.restY as number | undefined;
  if (restY === undefined) rig.root.userData.restY = rig.root.position.y;
  rig.root.position.y = (rig.root.userData.restY as number)
    - (0.5 - 0.5 * Math.cos(4 * Math.PI * L)) * 0.016;
  rig.root.updateMatrixWorld(true);
  poseAttachments(rig);
}

/** A slow idle so the demo is not motionless when nothing is selected. */
export function poseIdle(rig: WalkRig, rest: RestPose, phase: number): void {
  const t = phase * Math.PI * 2;
  const breathe = Math.sin(t);
  const set = (name: string, x: number, y = 0, z = 0): void => {
    const bone = rig.bones.get(name);
    if (!bone) return;
    EULER.set(x, y, z, 'XYZ');
    bone.quaternion.copy(rest.get(name)!).multiply(new THREE.Quaternion().setFromEuler(EULER));
  };
  set('spine.01', breathe * 0.010);
  set('spine.02', breathe * 0.010);
  set('chest', breathe * 0.014);
  set('shoulders', breathe * 0.008);
  set('head', breathe * -0.014, Math.sin(t * 0.5) * 0.05);
  set('shoulder.L', breathe * 0.02);
  set('shoulder.R', breathe * 0.016);
  const restY = rig.root.userData.restY as number | undefined;
  if (restY === undefined) rig.root.userData.restY = rig.root.position.y;
  rig.root.position.y = (rig.root.userData.restY as number) + breathe * 0.004;
  rig.root.updateMatrixWorld(true);
  poseAttachments(rig);
}
