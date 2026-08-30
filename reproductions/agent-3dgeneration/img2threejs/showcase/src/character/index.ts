/**
 * CharacterIR runtime — first-party source, ported from the img2threejs 1.5.1 character
 * reconstruction pipeline.
 *
 * The warrior demo previously reached this code through an `img2threejs-character` npm dependency
 * declared as `file:../img2threejs-character/character-plugin`. That path points outside the
 * repository, so it resolved only on a machine that happened to have the sibling checkout and
 * broke every clean CI checkout with TS2307. The modules below are the transitive closure the
 * warrior demo actually reaches, carried here as ordinary project source so the showcase builds
 * from a bare clone with `three` as its only runtime dependency.
 *
 * Scope is deliberately the warrior rig alone. Archetypes and pipeline stages no demo in this
 * repository reaches — the CharacterSession compiler, the evaluation gates, the lee-sin-v2
 * archetype — are not carried here; port them alongside the demo that first needs them.
 */

export { createStylizedCharacterIR } from './archetypes/stylized/index.js';
export { buildSkeleton } from './rig/skeleton/index.js';
export { buildRigidSemanticWeights } from './rig/weights/index.js';
export { compileCharacterActions } from './runtime/animation.js';

export type { SkeletonBuildResult } from './rig/skeleton/index.js';
export type { CharacterActionSpec, CharacterAnimationController } from './runtime/animation.js';
export type { CharacterIR, RigJoint } from './ir/character-ir.js';
