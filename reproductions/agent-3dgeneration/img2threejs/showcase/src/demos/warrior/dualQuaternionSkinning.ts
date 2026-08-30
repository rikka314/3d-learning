/**
 * Dual quaternion skinning for the warrior surfaces.
 *
 * Linear blend skinning collapses a surface as a joint closes, and Victory
 * Dance closes the knee to 130.6 degrees. Measured on that clip, node 64 edges
 * fell to 0.087 of their rest length and node 84 to 0.061 - the pinch that
 * reads as a torn garment. No weighting fixes it: the collapse is the weight
 * gradient times the separation between the two bone transforms, so holding it
 * under a quarter of the rest length would need a blend band of 0.27 m spread
 * over a 0.10 m thigh. Dual quaternion skinning interpolates the rigid motions
 * themselves instead of their matrices, so the blend of two rigid transforms
 * stays rigid and the surface cannot lose volume.
 *
 * Both paths must agree, because the measurement scripts read geometry through
 * `getVertexPosition` on the CPU while the viewer renders on the GPU. The two
 * implementations below are the same algorithm written twice, and
 * `measureDualQuaternionAgreement` exists to prove they do not drift.
 */
import * as THREE from 'three';

/** Bone matrices must be rigid for a dual quaternion to represent them. */
const MAXIMUM_BONE_SCALE_DEVIATION = 1e-3;

const skinIndexScratch = new THREE.Vector4();
const skinWeightScratch = new THREE.Vector4();
const basePositionScratch = new THREE.Vector3();
const boneMatrixScratch = new THREE.Matrix4();
const boneRotationScratch = new THREE.Quaternion();
const realScratch = new THREE.Quaternion();
const dualScratch = new THREE.Quaternion();
const translationScratch = new THREE.Quaternion();
const crossScratch = new THREE.Vector3();

/**
 * Switches one skinned mesh to dual quaternion skinning on the CPU and on the
 * GPU. Safe to call once per mesh; the material is patched in place.
 */
export function installDualQuaternionSkinning(mesh: THREE.SkinnedMesh): void {
  // Diagnostic escape hatch for the capture harness, which renders the same
  // poses both ways to show what the change is responsible for. Never set in
  // the application itself.
  if ((globalThis as { __WARRIOR_DISABLE_DQS__?: boolean }).__WARRIOR_DISABLE_DQS__) return;
  installCpuSkinning(mesh);
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  materials.forEach(patchMaterial);
}

function installCpuSkinning(mesh: THREE.SkinnedMesh): void {
  mesh.applyBoneTransform = function applyDualQuaternionBoneTransform(
    this: THREE.SkinnedMesh,
    index: number,
    target: THREE.Vector3,
  ): THREE.Vector3 {
    const skeleton = this.skeleton;
    const geometry = this.geometry;
    skinIndexScratch.fromBufferAttribute(geometry.attributes.skinIndex as THREE.BufferAttribute, index);
    skinWeightScratch.fromBufferAttribute(geometry.attributes.skinWeight as THREE.BufferAttribute, index);
    basePositionScratch.copy(target).applyMatrix4(this.bindMatrix);

    let realX = 0;
    let realY = 0;
    let realZ = 0;
    let realW = 0;
    let dualX = 0;
    let dualY = 0;
    let dualZ = 0;
    let dualW = 0;
    // Antipodal quaternions describe the same rotation but blend to the wrong
    // place, so every bone is aligned against one reference. The reference is
    // slot 0's bone whether or not it carries weight: picking "the first bone
    // with weight" instead makes the reference change identity exactly where a
    // weight reaches zero, and the sign flip there tears the surface open.
    const referenceBone = skinIndexScratch.getComponent(0);
    boneMatrixScratch.multiplyMatrices(
      skeleton.bones[referenceBone].matrixWorld,
      skeleton.boneInverses[referenceBone],
    );
    boneDualQuaternion(boneMatrixScratch, realScratch, dualScratch);
    const referenceX = realScratch.x;
    const referenceY = realScratch.y;
    const referenceZ = realScratch.z;
    const referenceW = realScratch.w;

    for (let slot = 0; slot < 4; slot += 1) {
      const weight = skinWeightScratch.getComponent(slot);
      if (weight === 0) continue;
      const boneIndex = skinIndexScratch.getComponent(slot);
      boneMatrixScratch.multiplyMatrices(
        skeleton.bones[boneIndex].matrixWorld,
        skeleton.boneInverses[boneIndex],
      );
      boneDualQuaternion(boneMatrixScratch, realScratch, dualScratch);
      const alignment = realScratch.x * referenceX + realScratch.y * referenceY
        + realScratch.z * referenceZ + realScratch.w * referenceW < 0 ? -weight : weight;
      realX += realScratch.x * alignment;
      realY += realScratch.y * alignment;
      realZ += realScratch.z * alignment;
      realW += realScratch.w * alignment;
      dualX += dualScratch.x * alignment;
      dualY += dualScratch.y * alignment;
      dualZ += dualScratch.z * alignment;
      dualW += dualScratch.w * alignment;
    }

    const length = Math.hypot(realX, realY, realZ, realW);
    if (length < 1e-12) return target.applyMatrix4(this.bindMatrixInverse);
    realX /= length;
    realY /= length;
    realZ /= length;
    realW /= length;
    dualX /= length;
    dualY /= length;
    dualZ /= length;
    dualW /= length;

    const { x, y, z } = basePositionScratch;
    crossScratch.set(
      realY * z - realZ * y + realW * x,
      realZ * x - realX * z + realW * y,
      realX * y - realY * x + realW * z,
    );
    target.set(
      x + 2 * (realY * crossScratch.z - realZ * crossScratch.y)
        + 2 * (realW * dualX - dualW * realX + realY * dualZ - realZ * dualY),
      y + 2 * (realZ * crossScratch.x - realX * crossScratch.z)
        + 2 * (realW * dualY - dualW * realY + realZ * dualX - realX * dualZ),
      z + 2 * (realX * crossScratch.y - realY * crossScratch.x)
        + 2 * (realW * dualZ - dualW * realZ + realX * dualY - realY * dualX),
    );
    return target.applyMatrix4(this.bindMatrixInverse);
  };
}

function boneDualQuaternion(
  matrix: THREE.Matrix4,
  real: THREE.Quaternion,
  dual: THREE.Quaternion,
): void {
  boneRotationScratch.setFromRotationMatrix(matrix);
  real.copy(boneRotationScratch);
  const elements = matrix.elements;
  translationScratch.set(elements[12], elements[13], elements[14], 0);
  dual.copy(translationScratch).multiply(real);
  dual.set(dual.x * 0.5, dual.y * 0.5, dual.z * 0.5, dual.w * 0.5);
}

/**
 * Largest deviation from unit length across every bone matrix column. A rigid
 * skeleton measures zero; anything above the tolerance means a scaled bone,
 * which a dual quaternion cannot represent.
 */
export function measureBoneScaleDeviation(skeleton: THREE.Skeleton): number {
  const matrix = new THREE.Matrix4();
  const column = new THREE.Vector3();
  let deviation = 0;
  for (let bone = 0; bone < skeleton.bones.length; bone += 1) {
    matrix.multiplyMatrices(skeleton.bones[bone].matrixWorld, skeleton.boneInverses[bone]);
    for (let axis = 0; axis < 3; axis += 1) {
      column.fromArray(matrix.elements, axis * 4);
      deviation = Math.max(deviation, Math.abs(column.length() - 1));
    }
  }
  return deviation;
}

export const DUAL_QUATERNION_SKINNING = {
  maximumBoneScaleDeviation: MAXIMUM_BONE_SCALE_DEVIATION,
} as const;

const DUAL_QUATERNION_PARS = /* glsl */`
void warriorBoneDualQuaternion( in mat4 boneMatrix, out vec4 real, out vec4 dual ) {
  float trace = boneMatrix[ 0 ][ 0 ] + boneMatrix[ 1 ][ 1 ] + boneMatrix[ 2 ][ 2 ];
  if ( trace > 0.0 ) {
    float s = sqrt( trace + 1.0 ) * 2.0;
    real = vec4(
      ( boneMatrix[ 1 ][ 2 ] - boneMatrix[ 2 ][ 1 ] ) / s,
      ( boneMatrix[ 2 ][ 0 ] - boneMatrix[ 0 ][ 2 ] ) / s,
      ( boneMatrix[ 0 ][ 1 ] - boneMatrix[ 1 ][ 0 ] ) / s,
      0.25 * s
    );
  } else if ( boneMatrix[ 0 ][ 0 ] > boneMatrix[ 1 ][ 1 ] && boneMatrix[ 0 ][ 0 ] > boneMatrix[ 2 ][ 2 ] ) {
    float s = sqrt( 1.0 + boneMatrix[ 0 ][ 0 ] - boneMatrix[ 1 ][ 1 ] - boneMatrix[ 2 ][ 2 ] ) * 2.0;
    real = vec4(
      0.25 * s,
      ( boneMatrix[ 1 ][ 0 ] + boneMatrix[ 0 ][ 1 ] ) / s,
      ( boneMatrix[ 2 ][ 0 ] + boneMatrix[ 0 ][ 2 ] ) / s,
      ( boneMatrix[ 1 ][ 2 ] - boneMatrix[ 2 ][ 1 ] ) / s
    );
  } else if ( boneMatrix[ 1 ][ 1 ] > boneMatrix[ 2 ][ 2 ] ) {
    float s = sqrt( 1.0 + boneMatrix[ 1 ][ 1 ] - boneMatrix[ 0 ][ 0 ] - boneMatrix[ 2 ][ 2 ] ) * 2.0;
    real = vec4(
      ( boneMatrix[ 1 ][ 0 ] + boneMatrix[ 0 ][ 1 ] ) / s,
      0.25 * s,
      ( boneMatrix[ 2 ][ 1 ] + boneMatrix[ 1 ][ 2 ] ) / s,
      ( boneMatrix[ 2 ][ 0 ] - boneMatrix[ 0 ][ 2 ] ) / s
    );
  } else {
    float s = sqrt( 1.0 + boneMatrix[ 2 ][ 2 ] - boneMatrix[ 0 ][ 0 ] - boneMatrix[ 1 ][ 1 ] ) * 2.0;
    real = vec4(
      ( boneMatrix[ 2 ][ 0 ] + boneMatrix[ 0 ][ 2 ] ) / s,
      ( boneMatrix[ 2 ][ 1 ] + boneMatrix[ 1 ][ 2 ] ) / s,
      0.25 * s,
      ( boneMatrix[ 0 ][ 1 ] - boneMatrix[ 1 ][ 0 ] ) / s
    );
  }
  vec3 t = boneMatrix[ 3 ].xyz;
  dual = 0.5 * vec4(
    real.w * t + cross( t, real.xyz ),
    - dot( t, real.xyz )
  );
}

void warriorAccumulateBone(
  in mat4 boneMatrix,
  in float weight,
  in vec4 reference,
  inout vec4 real,
  inout vec4 dual
) {
  if ( weight == 0.0 ) return;
  vec4 boneReal;
  vec4 boneDual;
  warriorBoneDualQuaternion( boneMatrix, boneReal, boneDual );
  // Antipodal quaternions describe the same rotation but blend to the wrong
  // place, so every bone is aligned against one reference.
  float aligned = dot( boneReal, reference ) < 0.0 ? - weight : weight;
  real += boneReal * aligned;
  dual += boneDual * aligned;
}

vec3 warriorDualQuaternionRotate( in vec4 real, in vec3 v ) {
  return v + 2.0 * cross( real.xyz, cross( real.xyz, v ) + real.w * v );
}
`;

const DUAL_QUATERNION_BLEND = /* glsl */`
#ifdef USE_SKINNING
  vec4 warriorDqReal = vec4( 0.0 );
  vec4 warriorDqDual = vec4( 0.0 );
  // The reference is slot 0's bone whether or not it carries weight: picking
  // "the first bone with weight" instead makes the reference change identity
  // exactly where a weight reaches zero, and the sign flip there tears the
  // surface open.
  vec4 warriorDqReference;
  vec4 warriorDqReferenceDual;
  warriorBoneDualQuaternion( boneMatX, warriorDqReference, warriorDqReferenceDual );
  warriorAccumulateBone( boneMatX, skinWeight.x, warriorDqReference, warriorDqReal, warriorDqDual );
  warriorAccumulateBone( boneMatY, skinWeight.y, warriorDqReference, warriorDqReal, warriorDqDual );
  warriorAccumulateBone( boneMatZ, skinWeight.z, warriorDqReference, warriorDqReal, warriorDqDual );
  warriorAccumulateBone( boneMatW, skinWeight.w, warriorDqReference, warriorDqReal, warriorDqDual );
  float warriorDqLength = length( warriorDqReal );
  if ( warriorDqLength > 1e-6 ) {
    warriorDqReal /= warriorDqLength;
    warriorDqDual /= warriorDqLength;
  } else {
    warriorDqReal = vec4( 0.0, 0.0, 0.0, 1.0 );
    warriorDqDual = vec4( 0.0 );
  }
#endif
`;

const DUAL_QUATERNION_NORMAL = /* glsl */`
#ifdef USE_SKINNING
  objectNormal = mat3( bindMatrixInverse ) * warriorDualQuaternionRotate(
    warriorDqReal,
    mat3( bindMatrix ) * objectNormal
  );
  #ifdef USE_TANGENT
    objectTangent = mat3( bindMatrixInverse ) * warriorDualQuaternionRotate(
      warriorDqReal,
      mat3( bindMatrix ) * objectTangent
    );
  #endif
#endif
`;

const DUAL_QUATERNION_POSITION = /* glsl */`
#ifdef USE_SKINNING
  vec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );
  vec3 warriorSkinned = warriorDualQuaternionRotate( warriorDqReal, skinVertex.xyz )
    + 2.0 * ( warriorDqReal.w * warriorDqDual.xyz - warriorDqDual.w * warriorDqReal.xyz
      + cross( warriorDqReal.xyz, warriorDqDual.xyz ) );
  transformed = ( bindMatrixInverse * vec4( warriorSkinned, 1.0 ) ).xyz;
#endif
`;

function patchMaterial(material: THREE.Material): void {
  if ((material as { userData?: Record<string, unknown> }).userData?.dualQuaternionSkinning) return;
  material.userData = { ...material.userData, dualQuaternionSkinning: true };
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <skinning_pars_vertex>',
        `#include <skinning_pars_vertex>\n${DUAL_QUATERNION_PARS}`,
      )
      .replace(
        '#include <skinbase_vertex>',
        `#include <skinbase_vertex>\n${DUAL_QUATERNION_BLEND}`,
      )
      .replace('#include <skinnormal_vertex>', DUAL_QUATERNION_NORMAL)
      .replace('#include <skinning_vertex>', DUAL_QUATERNION_POSITION);
  };
  // Without a distinct cache key the renderer can hand this material a program
  // compiled for an unpatched one.
  const previousKey = material.customProgramCacheKey;
  material.customProgramCacheKey = function dualQuaternionCacheKey(this: THREE.Material): string {
    return `${previousKey ? previousKey.call(this) : ''}|warrior-dqs`;
  };
}
