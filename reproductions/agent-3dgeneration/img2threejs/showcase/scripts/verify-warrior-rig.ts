import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  installWarriorRig,
  WARRIOR_ARTICULATED_CHAINS,
  WARRIOR_EYE_GLOW,
  WARRIOR_NODE_JOINT_BINDINGS,
  WARRIOR_STAFF_ACTION,
  WARRIOR_TRIPO_MOTION_4_HIDE,
  WARRIOR_VICTORY_DANCE_RIGID_BINDINGS,
} from '../src/demos/warrior/warriorRig';

const SYNTHETIC_NODES = Object.keys(WARRIOR_NODE_JOINT_BINDINGS).map(Number);

function createRigFixture() {
  const root = new THREE.Group();
  root.name = 'warrior-rig-test';
  // Node 53 deliberately shares node 54's source material. The runtime must
  // isolate the weapon material before changing opacity for Tripo Motion 4.
  const sharedWeaponMaterial = new THREE.MeshBasicMaterial();
  for (const node of SYNTHETIC_NODES) {
    const geometry = new THREE.BufferGeometry();
    if (node === 48) {
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        -0.04, 0.03, 0.04,
        -0.03, 0.03, 0.062,
        -0.02, 0.01, 0.09,
      ], 3));
    } else if ([45, 46, 47, 50, 51, 52, 56, 58, 62, 68].includes(node)) {
      const articulatedPoints: Record<number, number[]> = {
        45: [-0.0668, 0.1848, 0.0793, -0.0301, 0.1012, 0.0276, 0.0066, 0.0176, -0.0240],
        46: [0.1509, 0.1742, 0.1126, 0.1794, 0.1069, 0.0881, 0.2079, 0.0396, 0.0636],
        47: [-0.0467, 0.5168, 0.1160, -0.0729, 0.4826, 0.0930, -0.0991, 0.4485, 0.0701],
        50: [0.1222, 0.5341, 0.1277, 0.1486, 0.4897, 0.1006, 0.1751, 0.4453, 0.0735],
        51: [-0.0991, 0.4485, 0.0701, -0.1339, 0.3752, 0.0991, -0.1688, 0.3019, 0.1281],
        52: [0.0385, 0.3879, 0.1338, 0.0413, 0.4222, 0.1300, 0.0440, 0.4565, 0.1262],
        56: [0.1222, 0.5341, 0.1277, 0.1486, 0.4897, 0.1006, 0.1751, 0.4453, 0.0735],
        58: [-0.0467, 0.5168, 0.1160, -0.0729, 0.4826, 0.0930, -0.0991, 0.4485, 0.0701],
        62: [0.1751, 0.4453, 0.0735, 0.2101, 0.4041, 0.0885, 0.2450, 0.3630, 0.1034],
        68: [0.1509, 0.1742, 0.1126, 0.1794, 0.1069, 0.0881, 0.2079, 0.0396, 0.0636],
      };
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(articulatedPoints[node], 3));
    } else if (node === 55) {
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        0.03, 0.34, 0.20,
        0.03, 0.29, 0.20,
        0.03, 0.266, 0.20,
        0.03, 0.23, 0.20,
        0.03, 0.19, 0.20,
      ], 3));
    } else if (node === 75) {
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        0.22, 0.20, -0.02,
        0.28, 0.19, -0.025,
        0.339, 0.18, -0.03,
        0.40, 0.17, -0.035,
        0.46, 0.16, -0.04,
      ], 3));
    } else if (node === 73 || node === 76) {
      const interval = node === 73 ? [0.10, 0.13, 0.16] : [0.09, 0.14, 0.18];
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        interval[0], 0.59, 0.22,
        interval[1], 0.59, 0.23,
        interval[2], 0.59, 0.24,
      ], 3));
    } else if (node === 74 || node === 77) {
      const interval = node === 74 ? [-0.02, -0.05, -0.08] : [-0.01, -0.06, -0.10];
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        interval[0], 0.59, 0.22,
        interval[1], 0.59, 0.23,
        interval[2], 0.59, 0.24,
      ], 3));
    } else if (node === 66) {
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        0.044, 0.329, 0.010,
        0.121, 0.294, -0.155,
        0.237, 0.331, -0.357,
      ], 3));
    } else if (node === 85 || node === 86) {
      const x = node === 85 ? 0.14 : -0.06;
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        x, 0.77, 0.117,
        x, 0.848, 0.130,
        x, 0.94, 0.120,
      ], 3));
    } else {
      const [x, y, z] = node === 54
        ? [-0.18, 0.43, 0.10]
      : node === 59
        ? [0.228, 0.454, -0.148]
        : [node % 2 ? -0.06 : 0.07, 0.34, 0.10];
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        x, y, z,
        x + 0.01, y, z,
        x, y + 0.01, z,
      ], 3));
    }
    geometry.setIndex(geometry.getAttribute('position').count === 5 ? [0, 1, 2, 2, 3, 4] : [0, 1, 2]);
    const mesh = new THREE.Mesh(
      geometry,
      node === 81
        ? new THREE.MeshStandardMaterial({ color: 0xffffff })
        : node === 53 || node === 54
          ? sharedWeaponMaterial
          : new THREE.MeshBasicMaterial(),
    );
    mesh.name = `fixture-node-${node}`;
    mesh.userData.moduleNode = node;
    root.add(mesh);
  }
  return { root, rig: installWarriorRig(root) };
}

function assertArticulatedBlend(
  root: THREE.Group,
  rig: ReturnType<typeof installWarriorRig>,
  node: number,
  chain: readonly string[],
): void {
  const mesh = root.getObjectByName(`fixture-node-${node}`) as THREE.SkinnedMesh;
  const indices = mesh.geometry.getAttribute('skinIndex');
  const weights = mesh.geometry.getAttribute('skinWeight');
  const expected = new Set(chain.map((joint) => boneIndex(rig, joint)));
  let blendedVertexCount = 0;
  for (let vertex = 0; vertex < weights.count; vertex += 1) {
    const sum = weights.getX(vertex) + weights.getY(vertex) + weights.getZ(vertex) + weights.getW(vertex);
    assert.ok(Math.abs(sum - 1) < 1e-6, `node ${node} articulated weights must normalize at vertex ${vertex}`);
    assert.ok(expected.has(indices.getX(vertex)), `node ${node} primary influence must belong to its measured chain`);
    assert.ok(expected.has(indices.getY(vertex)), `node ${node} secondary influence must belong to its measured chain`);
    assert.equal(weights.getZ(vertex) + weights.getW(vertex), 0, `node ${node} must use at most two adjacent joints`);
    if (weights.getX(vertex) > 0 && weights.getY(vertex) > 0) blendedVertexCount += 1;
  }
  assert.ok(blendedVertexCount > 0, `node ${node} must deform continuously across a measured bone segment`);
}

function assertThinClothBlend(
  root: THREE.Group,
  rig: ReturnType<typeof installWarriorRig>,
  node: 55 | 75,
  baseJoint: string,
  midJoint: string,
  tipJoint: string,
): void {
  const mesh = root.getObjectByName(`fixture-node-${node}`) as THREE.SkinnedMesh;
  const indices = mesh.geometry.getAttribute('skinIndex');
  const weights = mesh.geometry.getAttribute('skinWeight');
  const base = boneIndex(rig, baseJoint);
  const mid = boneIndex(rig, midJoint);
  const tip = boneIndex(rig, tipJoint);
  assert.equal(indices.getX(0), base);
  assert.equal(weights.getX(0), 1, `node ${node} attachment vertex must remain base-bound`);
  assert.ok(weights.getX(1) > 0 && weights.getY(1) > 0, `node ${node} must blend base to mid`);
  assert.equal(indices.getY(1), mid);
  assert.ok(weights.getY(2) > 0.99, `node ${node} centre must follow the middle cloth bone`);
  assert.ok(weights.getY(3) > 0 && weights.getZ(3) > 0, `node ${node} must blend mid to tip`);
  assert.equal(indices.getZ(3), tip);
  assert.ok(weights.getZ(4) > 0.99, `node ${node} free edge must follow its tip bone`);
  for (let vertex = 0; vertex < weights.count; vertex += 1) {
    const sum = weights.getX(vertex) + weights.getY(vertex) + weights.getZ(vertex) + weights.getW(vertex);
    assert.ok(Math.abs(sum - 1) < 1e-6, `node ${node} cloth weights must normalize at vertex ${vertex}`);
  }
}

function assertWhiskerBlend(
  root: THREE.Group,
  rig: ReturnType<typeof installWarriorRig>,
  node: 73 | 74 | 76 | 77,
): void {
  const mesh = root.getObjectByName(`fixture-node-${node}`) as THREE.SkinnedMesh;
  const indices = mesh.geometry.getAttribute('skinIndex');
  const weights = mesh.geometry.getAttribute('skinWeight');
  const base = boneIndex(rig, `whisker-${node}-base`);
  const tip = boneIndex(rig, `whisker-${node}-tip`);
  assert.equal(indices.getX(0), base);
  assert.equal(weights.getX(0), 1, `whisker ${node} root must stay attached to the head-side base`);
  assert.ok(weights.getX(1) > 0 && weights.getY(1) > 0, `whisker ${node} must have a soft transition`);
  assert.equal(indices.getY(1), tip);
  assert.equal(weights.getY(2), 1, `whisker ${node} free end must follow its tip bone`);
}

function assertFlexibleSurfaceBlend(
  root: THREE.Group,
  rig: ReturnType<typeof installWarriorRig>,
  node: 66 | 85 | 86,
  chain: readonly string[],
): void {
  const mesh = root.getObjectByName(`fixture-node-${node}`) as THREE.SkinnedMesh;
  const indices = mesh.geometry.getAttribute('skinIndex');
  const weights = mesh.geometry.getAttribute('skinWeight');
  assert.equal(indices.getX(0), boneIndex(rig, chain[0]));
  assert.ok(weights.getX(0) > 0.99, `node ${node} attachment must remain on ${chain[0]}`);
  assert.ok(weights.getX(1) > 0 && weights.getY(1) > 0, `node ${node} must bend continuously at mid-span`);
  const lastInfluence = chain.length === 3 ? 2 : 1;
  const freeIndex = lastInfluence === 2 ? indices.getZ(2) : indices.getY(2);
  const freeWeight = lastInfluence === 2 ? weights.getZ(2) : weights.getY(2);
  assert.equal(freeIndex, boneIndex(rig, chain[chain.length - 1]));
  assert.ok(freeWeight > 0.99, `node ${node} free end must follow ${chain[chain.length - 1]}`);
  for (let vertex = 0; vertex < weights.count; vertex += 1) {
    const sum = weights.getX(vertex) + weights.getY(vertex) + weights.getZ(vertex) + weights.getW(vertex);
    assert.ok(Math.abs(sum - 1) < 1e-6, `node ${node} flexible weights must normalize at vertex ${vertex}`);
  }
}

function maxTrackQuaternionAngle(clip: THREE.AnimationClip, joint: string): number {
  const track = clip.tracks.find((candidate) => candidate.name === `${joint}.quaternion`);
  assert.ok(track, `${clip.name} must animate ${joint}`);
  let maximum = 0;
  for (let offset = 0; offset < track.values.length; offset += 4) {
    const quaternion = new THREE.Quaternion(
      track.values[offset],
      track.values[offset + 1],
      track.values[offset + 2],
      track.values[offset + 3],
    );
    maximum = Math.max(maximum, quaternion.angleTo(new THREE.Quaternion()));
  }
  return maximum;
}

function boneIndex(rig: ReturnType<typeof installWarriorRig>, name: string): number {
  const index = rig.skeleton.skeleton.bones.findIndex((bone) => bone.name === name);
  assert.notEqual(index, -1, `missing bone ${name}`);
  return index;
}

function assertNodeBinding(
  root: THREE.Group,
  rig: ReturnType<typeof installWarriorRig>,
  node: number,
  joint: string,
): void {
  const mesh = root.getObjectByName(`fixture-node-${node}`) as THREE.SkinnedMesh | undefined;
  assert.ok(mesh?.isSkinnedMesh, `node ${node} was not converted to SkinnedMesh`);
  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  const skinWeight = mesh.geometry.getAttribute('skinWeight');
  const expected = boneIndex(rig, joint);
  for (let vertex = 0; vertex < skinIndex.count; vertex += 1) {
    assert.equal(skinIndex.getX(vertex), expected, `node ${node} must bind to ${joint}`);
    assert.equal(skinWeight.getX(vertex), 1, `node ${node} must have 100% ${joint} influence`);
    assert.equal(skinWeight.getY(vertex) + skinWeight.getZ(vertex) + skinWeight.getW(vertex), 0, `node ${node} must have no secondary bone influence`);
  }
}

function skinnedVertexWorld(root: THREE.Group, node: number, vertex = 0): THREE.Vector3 {
  root.updateMatrixWorld(true);
  const mesh = root.getObjectByName(`fixture-node-${node}`) as THREE.SkinnedMesh;
  mesh.skeleton.update();
  const point = new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'), vertex);
  mesh.applyBoneTransform(vertex, point);
  return point.applyMatrix4(mesh.matrixWorld);
}

function relativeMatrix(parent: THREE.Object3D, child: THREE.Object3D): THREE.Matrix4 {
  return new THREE.Matrix4().copy(parent.matrixWorld).invert().multiply(child.matrixWorld);
}

function matrixDelta(a: THREE.Matrix4, b: THREE.Matrix4): number {
  return Math.max(...a.elements.map((value, index) => Math.abs(value - b.elements[index])));
}

function advanceRig(rig: ReturnType<typeof installWarriorRig>, seconds: number): void {
  let remaining = seconds;
  while (remaining > 1e-9) {
    const step = Math.min(0.05, remaining);
    rig.update(step);
    remaining -= step;
  }
}

const tripo4Fixture = createRigFixture();
const tripo4Staff = tripo4Fixture.root.getObjectByName('fixture-node-54') as THREE.SkinnedMesh;
const tripo4Cheese = tripo4Fixture.root.getObjectByName('fixture-node-59') as THREE.SkinnedMesh;
const sharedMaterialPeer = tripo4Fixture.root.getObjectByName('fixture-node-53') as THREE.SkinnedMesh;
const tripo4StaffMaterial = tripo4Staff.material as THREE.MeshBasicMaterial;
const tripo4CheeseMaterial = tripo4Cheese.material as THREE.MeshBasicMaterial;
const sharedPeerMaterial = sharedMaterialPeer.material as THREE.MeshBasicMaterial;
const tripo4RootBone = tripo4Fixture.rig.skeleton.bones.get('root')!;
const preludeRootPosition = tripo4RootBone.position.clone();
const victoryDanceRestEdgeLengths = new Map<number, number>();
for (const node of Object.keys(WARRIOR_VICTORY_DANCE_RIGID_BINDINGS).map(Number)) {
  victoryDanceRestEdgeLengths.set(
    node,
    skinnedVertexWorld(tripo4Fixture.root, node, 0)
      .distanceTo(skinnedVertexWorld(tripo4Fixture.root, node, 1)),
  );
}
const originalFadeState = [tripo4StaffMaterial, tripo4CheeseMaterial].map((material) => ({
  opacity: material.opacity,
  transparent: material.transparent,
  depthWrite: material.depthWrite,
}));
assert.notEqual(tripo4StaffMaterial, sharedPeerMaterial, 'node 54 must clone a shared material before its opacity changes');
tripo4Fixture.rig.animationController.play(WARRIOR_TRIPO_MOTION_4_HIDE.actionId);
assert.equal(tripo4Fixture.rig.animationController.active, WARRIOR_TRIPO_MOTION_4_HIDE.actionId);
for (const [node, joint] of Object.entries(WARRIOR_VICTORY_DANCE_RIGID_BINDINGS)) {
  assertNodeBinding(tripo4Fixture.root, tripo4Fixture.rig, Number(node), joint);
}
advanceRig(tripo4Fixture.rig, WARRIOR_TRIPO_MOTION_4_HIDE.fadeSeconds * 0.5);
const halfFadeOpacity = [tripo4StaffMaterial.opacity, tripo4CheeseMaterial.opacity];
assert.ok(halfFadeOpacity.every((opacity) => Math.abs(opacity - 0.5) < 1e-7), 'nodes 54 and 59 must use a smooth half-opacity midpoint');
assert.equal(tripo4Staff.visible, true, 'node 54 must remain rendered while partially faded');
assert.equal(tripo4Cheese.visible, true, 'node 59 must remain rendered while partially faded');
assert.equal(sharedPeerMaterial.opacity, 1, 'fading node 54 must not mutate a material shared by another body part');
assert.ok(tripo4RootBone.position.distanceTo(preludeRootPosition) < 1e-9, 'Tripo Motion 4 skeleton must remain paused during the fade prelude');
advanceRig(tripo4Fixture.rig, WARRIOR_TRIPO_MOTION_4_HIDE.fadeSeconds * 0.5);
assert.equal(tripo4Staff.visible, false, 'node 54 must leave the render only after reaching zero opacity');
assert.equal(tripo4Cheese.visible, false, 'node 59 must leave the render only after reaching zero opacity');
assert.equal(tripo4StaffMaterial.opacity, 0);
assert.equal(tripo4CheeseMaterial.opacity, 0);
assert.ok(tripo4RootBone.position.distanceTo(preludeRootPosition) < 1e-9, 'Tripo Motion 4 must not advance in the tick that completes hiding');
advanceRig(tripo4Fixture.rig, 0.2);
const tripo4MotionAfterPrelude = tripo4RootBone.position.distanceTo(preludeRootPosition);
assert.ok(tripo4MotionAfterPrelude > 1e-5, 'Tripo Motion 4 must begin advancing after nodes 54 and 59 are fully hidden');
for (const node of Object.keys(WARRIOR_VICTORY_DANCE_RIGID_BINDINGS).map(Number)) {
  const animatedEdgeLength = skinnedVertexWorld(tripo4Fixture.root, node, 0)
    .distanceTo(skinnedVertexWorld(tripo4Fixture.root, node, 1));
  assert.ok(
    Math.abs(animatedEdgeLength - victoryDanceRestEdgeLengths.get(node)!) < 1e-7,
    `Victory Dance must preserve implicit-node-${node} as one rigid surface`,
  );
}
assert.equal(tripo4Staff.visible, false, 'node 54 must remain hidden while Tripo Motion 4 runs');
assert.equal(tripo4Cheese.visible, false, 'node 59 must remain hidden while Tripo Motion 4 runs');
tripo4Fixture.rig.animationController.play('staff-attack');
assert.equal(tripo4Staff.visible, true, 'switching action must restore node 54 immediately');
assert.equal(tripo4Cheese.visible, true, 'switching action must restore node 59 immediately');
[tripo4StaffMaterial, tripo4CheeseMaterial].forEach((material, index) => {
  assert.equal(material.opacity, originalFadeState[index].opacity, 'switching action must restore original opacity');
  assert.equal(material.transparent, originalFadeState[index].transparent, 'switching action must restore original transparency mode');
  assert.equal(material.depthWrite, originalFadeState[index].depthWrite, 'switching action must restore original depth-write mode');
});
// The character compiler's configured default cross-fades actions over 0.14 s. Sample
// four existing 50 ms rig steps so Victory Dance reaches zero mixer weight before expecting the
// articulated attributes back; restoring them at transition start caused the reported end-frame tear.
advanceRig(tripo4Fixture.rig, 0.2);
for (const node of Object.keys(WARRIOR_VICTORY_DANCE_RIGID_BINDINGS).map(Number)) {
  assertArticulatedBlend(
    tripo4Fixture.root,
    tripo4Fixture.rig,
    node,
    WARRIOR_ARTICULATED_CHAINS[node],
  );
}

const tripo4ResetFixture = createRigFixture();
const tripo4Clip = tripo4ResetFixture.root.animations.find((clip) => clip.name === WARRIOR_TRIPO_MOTION_4_HIDE.actionId);
assert.ok(tripo4Clip, 'Tripo Motion 4 clip must be compiled');
const tripo4WhiskerTrack = tripo4Clip.tracks.find((track) => track.name === 'whisker-73-tip.quaternion');
assert.ok(tripo4WhiskerTrack, 'Tripo Motion 4 must include flexible whisker motion');
assert.equal(
  tripo4WhiskerTrack.times.length,
  Math.round(tripo4Clip.duration * WARRIOR_TRIPO_MOTION_4_HIDE.sourceSampleRateHz) + 1,
  'imported secondary motion must use the measured 24 Hz source cadence',
);
tripo4ResetFixture.rig.animationController.play(WARRIOR_TRIPO_MOTION_4_HIDE.actionId);
advanceRig(tripo4ResetFixture.rig, WARRIOR_TRIPO_MOTION_4_HIDE.fadeSeconds);
advanceRig(tripo4ResetFixture.rig, tripo4Clip.duration + 0.3);
assert.equal(tripo4ResetFixture.rig.animationController.active, 'idle', 'Tripo Motion 4 must return to Idle after its one-shot');
assert.ok(
  tripo4ResetFixture.rig.skeleton.bones.get('right-hip')!.quaternion.angleTo(new THREE.Quaternion()) < 1e-6,
  'right leg must not retain or spin from the final Tripo Motion 4 pose',
);
assert.ok(
  tripo4ResetFixture.rig.skeleton.bones.get('left-hip')!.quaternion.angleTo(new THREE.Quaternion()) < 1e-6,
  'left leg must not retain or spin from the final Tripo Motion 4 pose',
);
assert.equal((tripo4ResetFixture.root.getObjectByName('fixture-node-54') as THREE.SkinnedMesh).visible, true);
assert.equal((tripo4ResetFixture.root.getObjectByName('fixture-node-59') as THREE.SkinnedMesh).visible, true);

const attackFixture = createRigFixture();
const attackBones = attackFixture.rig.skeleton.bones;
const rightHand = attackBones.get('right-hand')!;
const staffGrip = attackBones.get('staff-grip')!;
assert.equal(rightHand.parent?.name, 'right-wrist');
assert.equal(staffGrip.parent, rightHand);
assert.equal(attackBones.get('right-wrist')?.parent?.name, 'right-elbow');
assert.equal(attackBones.get('right-elbow')?.parent?.name, 'right-shoulder');
assert.equal(attackBones.get('right-shoulder')?.parent?.name, 'right-clavicle');
assert.equal(attackBones.get('cheese-pendulum')?.parent, staffGrip);
assert.equal(attackBones.get('cape-right')?.parent, attackBones.get('chest'));
assert.equal(attackBones.get('ear-left')?.parent, attackBones.get('head'));
assert.equal(attackBones.get('ear-left-tip')?.parent, attackBones.get('ear-left'));
assert.equal(attackBones.get('ear-right')?.parent, attackBones.get('head'));
assert.equal(attackBones.get('ear-right-tip')?.parent, attackBones.get('ear-right'));
assert.equal(attackBones.get('right-toes')?.parent, attackBones.get('right-foot'));
assert.equal(attackBones.get('left-toes')?.parent, attackBones.get('left-foot'));
assert.equal(attackBones.get('hat-back')?.parent, attackBones.get('head'));
assert.equal(attackBones.get('coat-front-mid')?.parent, attackBones.get('coat-front'));
assert.equal(attackBones.get('coat-front-tip')?.parent, attackBones.get('coat-front-mid'));
assert.equal(attackBones.get('sash-tail-mid')?.parent, attackBones.get('sash-tail'));
assert.equal(attackBones.get('sash-tail-tip')?.parent, attackBones.get('sash-tail-mid'));
assert.equal(attackBones.get('mouse-tail-mid')?.parent, attackBones.get('mouse-tail'));
assert.equal(attackBones.get('mouse-tail-tip')?.parent, attackBones.get('mouse-tail-mid'));
for (const node of [73, 74, 76, 77] as const) {
  assert.equal(attackBones.get(`whisker-${node}-base`)?.parent, attackBones.get('head'));
  assert.equal(attackBones.get(`whisker-${node}-tip`)?.parent, attackBones.get(`whisker-${node}-base`));
}

for (const [node, joint] of Object.entries(WARRIOR_NODE_JOINT_BINDINGS)) {
  if (WARRIOR_ARTICULATED_CHAINS[Number(node)] || [55, 66, 73, 74, 75, 76, 77, 85, 86].includes(Number(node))) continue;
  assertNodeBinding(attackFixture.root, attackFixture.rig, Number(node), joint);
}
for (const [node, chain] of Object.entries(WARRIOR_ARTICULATED_CHAINS)) {
  assertArticulatedBlend(attackFixture.root, attackFixture.rig, Number(node), chain);
}
assertThinClothBlend(attackFixture.root, attackFixture.rig, 55, 'coat-front', 'coat-front-mid', 'coat-front-tip');
assertThinClothBlend(attackFixture.root, attackFixture.rig, 75, 'sash-tail', 'sash-tail-mid', 'sash-tail-tip');
for (const node of [73, 74, 76, 77] as const) assertWhiskerBlend(attackFixture.root, attackFixture.rig, node);
assertFlexibleSurfaceBlend(attackFixture.root, attackFixture.rig, 66, ['mouse-tail', 'mouse-tail-mid', 'mouse-tail-tip']);
assertFlexibleSurfaceBlend(attackFixture.root, attackFixture.rig, 85, ['ear-left', 'ear-left-tip']);
assertFlexibleSurfaceBlend(attackFixture.root, attackFixture.rig, 86, ['ear-right', 'ear-right-tip']);

const earMotionByAction = Object.fromEntries(attackFixture.root.animations.map((clip) => {
  const left = maxTrackQuaternionAngle(clip, 'ear-left');
  const leftTip = maxTrackQuaternionAngle(clip, 'ear-left-tip');
  const right = maxTrackQuaternionAngle(clip, 'ear-right');
  const rightTip = maxTrackQuaternionAngle(clip, 'ear-right-tip');
  assert.ok(left > 0.005 && right > 0.005, `${clip.name} must include visible but gentle ear motion`);
  assert.ok(leftTip > 0.005 && rightTip > 0.005, `${clip.name} must distribute ear motion into each flexible tip`);
  assert.ok(left < 0.04 && right < 0.04 && leftTip < 0.04 && rightTip < 0.04, `${clip.name} ear segment motion must stay below the distributed gentle-motion cap`);
  return [clip.name, { left, leftTip, right, rightTip }];
}));
const clothTipMotionByAction = Object.fromEntries(attackFixture.root.animations.map((clip) => {
  if (clip.name === 'staff-attack') {
    const forbidden = clip.tracks.filter((track) =>
      /^(cape-right|coat-right|coat-left|coat-front|coat-front-mid|coat-front-tip|sash-tail|sash-tail-mid|sash-tail-tip)\./.test(track.name));
    assert.deepEqual(forbidden.map((track) => track.name), [], 'staff attack must not animate or split garment layers');
    return [clip.name, { coatFrontMid: 0, coatFrontTip: 0, sashTailMid: 0, sashTailTip: 0 }];
  }
  const coatFrontMid = maxTrackQuaternionAngle(clip, 'coat-front-mid');
  const coatFrontTip = maxTrackQuaternionAngle(clip, 'coat-front-tip');
  const sashTailMid = maxTrackQuaternionAngle(clip, 'sash-tail-mid');
  const sashTailTip = maxTrackQuaternionAngle(clip, 'sash-tail-tip');
  assert.ok(coatFrontMid > 0.01 && sashTailMid > 0.01, `${clip.name} must animate both thin-cloth middles`);
  assert.ok(coatFrontTip > coatFrontMid && sashTailTip > sashTailMid, `${clip.name} cloth motion must increase toward each free edge`);
  assert.ok(coatFrontTip < 0.22 && sashTailTip < 0.26, `${clip.name} cloth flutter must remain bounded`);
  return [clip.name, { coatFrontMid, coatFrontTip, sashTailMid, sashTailTip }];
}));
const hatMotionByAction = Object.fromEntries(attackFixture.root.animations.map((clip) => {
  const maximum = maxTrackQuaternionAngle(clip, 'hat-back');
  assert.ok(maximum > 0.005 && maximum < 0.04, `${clip.name} hat motion must remain light`);
  return [clip.name, maximum];
}));
const whiskerMotionByAction = Object.fromEntries(attackFixture.root.animations.map((clip) => {
  const measured = Object.fromEntries(([73, 74, 76, 77] as const).map((node) => {
    const base = maxTrackQuaternionAngle(clip, `whisker-${node}-base`);
    const tip = maxTrackQuaternionAngle(clip, `whisker-${node}-tip`);
    assert.ok(base > 0.003 && tip > base, `${clip.name} whisker ${node} must bend more at its free end`);
    assert.ok(tip < 0.11, `${clip.name} whisker ${node} motion must remain bounded`);
    return [node, { base, tip }];
  }));
  return [clip.name, measured];
}));

const eyeMesh = attackFixture.root.getObjectByName('fixture-node-81') as THREE.SkinnedMesh;
const eyeMaterial = eyeMesh.material as THREE.MeshStandardMaterial;
assert.ok(eyeMaterial.isMeshStandardMaterial, 'node 81 glow requires MeshStandardMaterial');
const measuredEyeGlowColour = new THREE.Color().setRGB(...WARRIOR_EYE_GLOW.colorLinear);
assert.ok(Math.max(
  Math.abs(eyeMaterial.emissive.r - measuredEyeGlowColour.r),
  Math.abs(eyeMaterial.emissive.g - measuredEyeGlowColour.g),
  Math.abs(eyeMaterial.emissive.b - measuredEyeGlowColour.b),
) < 1e-7, 'node 81 emissive colour must use its measured mean linear vertex colour');
const initialEyeGlowIntensity = eyeMaterial.emissiveIntensity;
for (let frame = 0; frame < 16; frame += 1) attackFixture.rig.update(0.05);
const peakEyeGlowIntensity = eyeMaterial.emissiveIntensity;
assert.ok(Math.abs(initialEyeGlowIntensity - WARRIOR_EYE_GLOW.minIntensity) < 1e-7, 'eye pulse must start at the authored low intensity');
assert.ok(Math.abs(peakEyeGlowIntensity - WARRIOR_EYE_GLOW.maxIntensity) < 1e-6, 'eye pulse must reach its slow authored peak after one quarter period');

attackFixture.root.updateMatrixWorld(true);
const restHandWorld = rightHand.matrixWorld.clone();
const restHandToGrip = relativeMatrix(rightHand, staffGrip);
const restWeaponSpan = skinnedVertexWorld(attackFixture.root, 54, 0).distanceTo(skinnedVertexWorld(attackFixture.root, 54, 1));
const restRightSleevePoint = skinnedVertexWorld(attackFixture.root, 58);
const restRightHandPoint = skinnedVertexWorld(attackFixture.root, 51);
const restHatSpan41To60 = skinnedVertexWorld(attackFixture.root, 41).distanceTo(skinnedVertexWorld(attackFixture.root, 60));
const restHatSpan41To71 = skinnedVertexWorld(attackFixture.root, 41).distanceTo(skinnedVertexWorld(attackFixture.root, 71));
const attackHead = attackBones.get('head')!;
const restEyeInHead = skinnedVertexWorld(attackFixture.root, 81).applyMatrix4(attackHead.matrixWorld.clone().invert());
attackFixture.rig.animationController.play('staff-attack');
for (let frame = 0; frame < 12; frame += 1) attackFixture.rig.update(0.025);
attackFixture.root.updateMatrixWorld(true);
const attackHandToGrip = relativeMatrix(rightHand, staffGrip);
const attackWeaponSpan = skinnedVertexWorld(attackFixture.root, 54, 0).distanceTo(skinnedVertexWorld(attackFixture.root, 54, 1));
const rigidWeaponSpanError = Math.abs(restWeaponSpan - attackWeaponSpan);
const rightSleeveSurfaceMotion = restRightSleevePoint.distanceTo(skinnedVertexWorld(attackFixture.root, 58));
const rightHandSurfaceMotion = restRightHandPoint.distanceTo(skinnedVertexWorld(attackFixture.root, 51));
const hatSpanError = Math.max(
  Math.abs(restHatSpan41To60 - skinnedVertexWorld(attackFixture.root, 41).distanceTo(skinnedVertexWorld(attackFixture.root, 60))),
  Math.abs(restHatSpan41To71 - skinnedVertexWorld(attackFixture.root, 41).distanceTo(skinnedVertexWorld(attackFixture.root, 71))),
);
const attackEyeInHead = skinnedVertexWorld(attackFixture.root, 81).applyMatrix4(attackHead.matrixWorld.clone().invert());
const eyeFrameLockError = restEyeInHead.distanceTo(attackEyeInHead);
assert.ok(matrixDelta(restHandWorld, rightHand.matrixWorld) > 0.001, 'staff attack must move the hand chain');
assert.ok(matrixDelta(restHandToGrip, attackHandToGrip) < 1e-6, 'staff grip must remain rigid under the hand');
assert.ok(rigidWeaponSpanError < 1e-6, 'weapon shaft and hardware must preserve their rigid span');
assert.ok(rightSleeveSurfaceMotion > 0, 'right sleeve surface must follow the elbow chain');
assert.ok(rightHandSurfaceMotion > 0, 'right hand surface must follow the wrist chain');
assert.ok(staffGrip.quaternion.angleTo(new THREE.Quaternion()) < 1e-7, 'staff grip must not animate independently');
assert.ok(hatSpanError < 1e-6, 'nodes 41, 60 and 71 must remain a rigid hat assembly');
assert.ok(eyeFrameLockError < 1e-6, 'node 81 must stay locked to the head and eye frame during animation');

const attackClip = attackFixture.root.animations.find((clip) => clip.name === 'staff-attack')!;
const rotatingStaffAncestors = new Set([
  'root', 'pelvis', 'spine', 'chest', 'right-clavicle',
  'right-shoulder', 'right-elbow', 'right-wrist', 'right-hand', 'staff-grip',
]);
const attackWeaponRotationTracks = attackClip.tracks.filter((track) =>
  track.name.endsWith('.quaternion') && rotatingStaffAncestors.has(track.name.slice(0, -'.quaternion'.length)));
assert.deepEqual(attackWeaponRotationTracks.map((track) => track.name), [
  'right-shoulder.quaternion',
  'right-elbow.quaternion',
  'right-wrist.quaternion',
], 'staff attack must use only the measured two-bone IK chain plus inverse wrist compensation');
assert.equal(attackClip.tracks.some((track) => track.name === 'right-clavicle.position'), false, 'staff attack must never translate the shoulder seam');
const protectedStaffAttackTracks = attackClip.tracks.filter((track) =>
  /^(left-clavicle|left-shoulder|left-elbow|left-wrist|left-hand|cape-right|coat-right|coat-left|coat-front|coat-front-mid|coat-front-tip|sash-tail|sash-tail-mid|sash-tail-tip|right-knee|left-knee)\./.test(track.name));
assert.deepEqual(protectedStaffAttackTracks.map((track) => track.name), [], 'staff attack must not affect the left arm, legs or garment joints');
const measuredStaffAxis = new THREE.Vector3().fromArray(WARRIOR_STAFF_ACTION.axis).normalize();
const measuredClearanceShift = new THREE.Vector3()
  .fromArray(WARRIOR_STAFF_ACTION.clearanceDirection)
  .multiplyScalar(WARRIOR_STAFF_ACTION.clearanceOffsetMetres);
const ikFixture = createRigFixture();
const ikHand = ikFixture.rig.skeleton.bones.get('right-hand')!;
const ikGrip = ikFixture.rig.skeleton.bones.get('staff-grip')!;
const ikClavicle = ikFixture.rig.skeleton.bones.get('right-clavicle')!;
ikFixture.root.updateMatrixWorld(true);
const restIkHand = ikHand.getWorldPosition(new THREE.Vector3());
const restIkGripRotation = ikGrip.getWorldQuaternion(new THREE.Quaternion());
const restIkClaviclePosition = ikClavicle.position.clone();
const protectedJointNames = [
  'left-clavicle', 'left-shoulder', 'left-elbow', 'left-wrist', 'left-hand',
  'cape-right', 'coat-right', 'coat-left', 'coat-front', 'coat-front-mid',
  'coat-front-tip', 'sash-tail', 'sash-tail-mid', 'sash-tail-tip',
] as const;
const protectedRestMatrices = new Map(protectedJointNames.map((name) => [name, ikFixture.rig.skeleton.bones.get(name)!.matrixWorld.clone()]));
ikFixture.rig.animationController.play('staff-attack');
for (let frame = 0; frame < 4; frame += 1) ikFixture.rig.update(0.045);
ikFixture.root.updateMatrixWorld(true);
const preparedIkHand = ikHand.getWorldPosition(new THREE.Vector3());
const preparedIkGripRotation = ikGrip.getWorldQuaternion(new THREE.Quaternion());
const preparedClearanceShift = preparedIkHand.clone().sub(restIkHand);
let protectedStaffAttackMatrixError = 0;
for (const name of protectedJointNames) {
  protectedStaffAttackMatrixError = Math.max(
    protectedStaffAttackMatrixError,
    matrixDelta(protectedRestMatrices.get(name)!, ikFixture.rig.skeleton.bones.get(name)!.matrixWorld),
  );
}
for (let elapsed = 0.18; elapsed < WARRIOR_STAFF_ACTION.impactTimeSeconds - 1e-9; elapsed += 0.04) {
  ikFixture.rig.update(Math.min(0.04, WARRIOR_STAFF_ACTION.impactTimeSeconds - elapsed));
}
ikFixture.root.updateMatrixWorld(true);
const straightThrust = ikHand.getWorldPosition(new THREE.Vector3()).sub(preparedIkHand);
const straightThrustMetres = straightThrust.dot(measuredStaffAxis);
const straightThrustLateralError = straightThrust.clone().cross(measuredStaffAxis).length();
const preparedClearanceError = preparedClearanceShift.distanceTo(measuredClearanceShift);
const preparedStaffWorldRotationError = preparedIkGripRotation.angleTo(restIkGripRotation);
const impactStaffWorldRotationError = ikGrip.getWorldQuaternion(new THREE.Quaternion()).angleTo(preparedIkGripRotation);
assert.ok(preparedClearanceError < 2e-5, 'staff preparation must apply the measured 20 mm body-clearance shift');
assert.ok(Math.abs(straightThrustMetres - WARRIOR_STAFF_ACTION.thrustMetres) < 2e-5, 'staff impact must advance 20 mm along the measured shaft axis');
assert.ok(straightThrustLateralError < 2e-5, 'staff impact path must be collinear with the measured shaft axis');
assert.ok(preparedStaffWorldRotationError < 2e-5, 'clearance preparation must not rotate the staff');
assert.ok(impactStaffWorldRotationError < 2e-5, 'inverse wrist compensation must keep the staff world orientation fixed at impact');
assert.ok(ikClavicle.position.distanceTo(restIkClaviclePosition) < 1e-9, 'staff attack must preserve the shoulder seam anchor');
assert.ok(protectedStaffAttackMatrixError < 1e-9, 'staff attack must preserve the left arm and every garment joint');

const impactSpark = attackFixture.root.getObjectByName('staff-impact-spark') as THREE.Group;
assert.ok(impactSpark, 'staff attack requires a procedural impact spark');
assert.equal(impactSpark.parent, staffGrip, 'impact spark must remain attached to the staff grip');
assert.ok(impactSpark.position.distanceTo(new THREE.Vector3().fromArray(WARRIOR_STAFF_ACTION.attackTipGripLocal)) < 1e-7, 'impact spark must sit at the measured staff tip');
assert.equal(impactSpark.userData.assetBacked, false, 'impact spark must be code-only');
assert.equal(impactSpark.visible, false, 'impact spark must remain hidden before contact');
for (let frame = 0; frame < 8; frame += 1) attackFixture.rig.update(0.025);
assert.equal(impactSpark.visible, true, 'impact spark must flash at the authored contact instant');
for (let frame = 0; frame < 8; frame += 1) attackFixture.rig.update(0.025);
assert.equal(impactSpark.visible, false, 'impact spark must disappear quickly after contact');

// Nodes 47 and 50 are measured upper-arm sleeve shells and intentionally
// follow their underlying arm chains. Only the free garment panels below must
// remain independent from arm joints.
const garmentNodes = [55, 63, 64, 67, 75, 84];
const armJoints = new Set([
  'right-clavicle', 'right-shoulder', 'right-elbow', 'right-wrist', 'right-hand',
  'left-clavicle', 'left-shoulder', 'left-elbow', 'left-wrist', 'left-hand',
]);
const garmentArmBindingCount = garmentNodes.filter((node) =>
  armJoints.has(WARRIOR_NODE_JOINT_BINDINGS[node])).length;
assert.equal(garmentArmBindingCount, 0, 'garment surfaces must not be bound to arm joints');

const actionFixture = createRigFixture();
assert.deepEqual(
  actionFixture.rig.animationController.actions.map((action) => action.id),
  ['tripo-motion-4', 'staff-attack'],
);
assert.equal(
  actionFixture.root.animations.some((clip) => ['walk', 'walk-procedural'].includes(clip.name)),
  false,
  'Walk must not be compiled into the runtime or exposed by the showcase',
);
assert.equal(
  actionFixture.root.animations.some((clip) => clip.name === 'died'),
  false,
  'Died must not be compiled into the runtime or exposed by the showcase',
);
assert.equal(
  actionFixture.root.animations.some((clip) => ['tripo-motion-1', 'tripo-motion-3'].includes(clip.name)),
  false,
  'Staff Twirl and Tripo Motion 3 must not be compiled into the runtime or exposed by the showcase',
);
console.log(JSON.stringify({
  status: 'pass',
  boneCount: actionFixture.rig.skeleton.skeleton.bones.length,
  actions: actionFixture.rig.animationController.actions.map((action) => action.id),
  handDrivenStaffOffsetError: matrixDelta(restHandToGrip, attackHandToGrip),
  rigidWeaponNodes: [54],
  rigidWeaponSpanError,
  rightSleeveSurfaceMotion,
  rightHandSurfaceMotion,
  attack: {
    durationSeconds: attackClip.duration,
    straightThrustMetres,
    straightThrustLateralError,
    preparedClearanceShift: preparedClearanceShift.toArray(),
    preparedClearanceError,
    measuredStaticClearanceQ95Metres: WARRIOR_STAFF_ACTION.measuredStaticClearanceQ95Metres,
    protectedStaffAttackTrackCount: protectedStaffAttackTracks.length,
    protectedStaffAttackMatrixError,
    weaponRotationTrackCount: attackWeaponRotationTracks.length,
    measuredArmReachMetres: WARRIOR_STAFF_ACTION.armMaxReachMetres,
    impactReachMarginMetres: WARRIOR_STAFF_ACTION.impactReachMarginMetres,
    preparedStaffWorldRotationError,
    impactStaffWorldRotationError,
    sparkRayCount: WARRIOR_STAFF_ACTION.sparkRayCount,
  },
  hatSpanError,
  eyeFrameLockError,
  eyeGlow: {
    measuredLinearColour: WARRIOR_EYE_GLOW.colorLinear,
    initialIntensity: initialEyeGlowIntensity,
    quarterPeriodIntensity: peakEyeGlowIntensity,
    periodSeconds: WARRIOR_EYE_GLOW.periodSeconds,
  },
  tripoMotion4Prelude: {
    hiddenPhysicalNodes: WARRIOR_TRIPO_MOTION_4_HIDE.physicalNodes,
    measuredSourceSampleRateHz: WARRIOR_TRIPO_MOTION_4_HIDE.sourceSampleRateHz,
    authoredFadeFrameCount: WARRIOR_TRIPO_MOTION_4_HIDE.authoredFadeFrameCount,
    fadeSeconds: WARRIOR_TRIPO_MOTION_4_HIDE.fadeSeconds,
    halfFadeOpacity,
    tripo4MotionAfterPrelude,
    sharedPeerOpacityDuringFade: sharedPeerMaterial.opacity,
    restored: tripo4Staff.visible && tripo4Cheese.visible,
  },
  garmentArmBindingCount,
  earMotionByAction,
  clothTipMotionByAction,
  hatMotionByAction,
  whiskerMotionByAction,
  semanticNodeBindingCount: Object.keys(WARRIOR_NODE_JOINT_BINDINGS).length,
  secondaryMotionJoints: [
    'hat-back', 'cape-right', 'coat-right', 'coat-left',
    'coat-front', 'coat-front-mid', 'coat-front-tip',
    'sash-tail', 'sash-tail-mid', 'sash-tail-tip',
    'whisker-73-base', 'whisker-73-tip', 'whisker-74-base', 'whisker-74-tip',
    'whisker-76-base', 'whisker-76-tip', 'whisker-77-base', 'whisker-77-tip',
    'cheese-pendulum', 'mouse-tail',
  ],
}, null, 2));
