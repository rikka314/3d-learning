/**
 * The motion pipeline: the primitives every clip in this demo is built out of.
 *
 * WHY THIS IS A SEPARATE MODULE. The first version of these animations put the joint angles straight into
 * the clips, and the result was reported as stiff -- correctly. Stiffness is not a property of any single
 * curve, it is what you get when a figure's joints all reach their extremes on the same frame, when its
 * feet slide rather than roll, and when its clothes hold still. None of that is fixable clip by clip, so
 * the fixes live here, as stages a clip composes:
 *
 *   1  CONTACT      where the foot touches, and which part of it. `stanceFoot` -- three rockers.
 *   2  SOLVE        the leg that reaches a placed foot. `solveLeg`, `plantFoot`.
 *   3  PHASING      joint amplitudes and timings taken from gait norms, not from taste.
 *   4  OVERLAP      `delayed` -- a chain propagates instead of moving as one piece.
 *   5  SECONDARY    springs, for anything that hangs or trails. `spring`.
 *   6  GATES        scripts/verify-animation-clips.mjs, measure-gait.ts, measure-cloth.mjs.
 *
 * Everything here is a PURE function of time. That is what lets stage 4 exist at all: "the chest follows
 * the pelvis by 60 ms" is just the pelvis's own curve evaluated 60 ms ago, which needs no state, cannot
 * drift, and can be sampled by a gate at any resolution.
 *
 * Angles are radians, distances metres, and +Z is forward.
 */

import * as THREE from 'three';
import { BONE_SPECS } from './skeleton';

export const TAU = Math.PI * 2;

/** What a clip has done to the pelvis this frame. Every leg solve has to be told, or it solves blind. */
export type PelvisState = {
  tx?: number; ty?: number; tz?: number; rx?: number; ry?: number; rz?: number;
};

/**
 * One bone's additive channels. Absent fields mean "leave the rest pose alone".
 *
 * `q` EXISTS BECAUSE EULER ANGLES ARE NOT A SAFE OUTPUT FOR A SOLVER. A solved rotation is a rotation; the
 * three angles are one of many encodings of it, and the encoding is discontinuous where the middle angle
 * passes a right angle and ambiguous where a quaternion meets its own negation. Both showed up the moment
 * the arms were driven by IK: a hand travelling a perfectly smooth arc produced 75 mrad steps in
 * `upperArm.rz` between adjacent frames, and third derivatives near two million on the forearm.
 *
 * Hand-authored poses keep using the angles, which are easier to read and to reason about. Solvers write
 * `q`, and it is composed after the angles.
 */
export type BoneDelta = {
  rx?: number; ry?: number; rz?: number;
  tx?: number; ty?: number; tz?: number;
  q?: THREE.Quaternion;
};

export type Pose = Record<string, BoneDelta>;

export function add(out: Pose, bone: string, delta: BoneDelta): void {
  const at = (out[bone] ??= {});
  if (delta.rx !== undefined) at.rx = (at.rx ?? 0) + delta.rx;
  if (delta.ry !== undefined) at.ry = (at.ry ?? 0) + delta.ry;
  if (delta.rz !== undefined) at.rz = (at.rz ?? 0) + delta.rz;
  if (delta.tx !== undefined) at.tx = (at.tx ?? 0) + delta.tx;
  if (delta.ty !== undefined) at.ty = (at.ty ?? 0) + delta.ty;
  if (delta.tz !== undefined) at.tz = (at.tz ?? 0) + delta.tz;
  if (delta.q) at.q = (at.q ? at.q.clone() : new THREE.Quaternion()).multiply(delta.q);
}

/** A bone delta's rotation, however it was written. Angles first, then any solved quaternion. */
export function deltaQuaternion(d: BoneDelta | undefined, into = new THREE.Quaternion()): THREE.Quaternion {
  into.identity();
  if (!d) return into;
  if (d.rx || d.ry || d.rz) {
    into.setFromEuler(new THREE.Euler(d.rx ?? 0, d.ry ?? 0, d.rz ?? 0, 'XYZ'));
  }
  if (d.q) into.multiply(d.q);
  return into;
}

// ---- stage 0: curves ------------------------------------------------------------------------------

/** Smootherstep: zero first AND second derivative at both ends, so a one-shot cannot jerk. */
export function ease(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** A bell over [0,1]: zero value, slope and curvature at both ends, and flat at the peak. */
export function bump(t: number): number {
  return ease(Math.min(1, t * 2)) * ease(Math.min(1, (1 - t) * 2));
}

/**
 * The same bell, with its peak moved to `peak` instead of the middle.
 *
 * WHY A SWING NEEDS ONE. A symmetric bell puts the highest point of the swinging foot exactly half way
 * through the swing, and that is not where a leg folds. Measured on the walk it drove peak knee flexion to
 * phase 0.80 -- within five percent of peak HIP flexion at 0.85 -- so both joints reached their extremes
 * together and the leg swung forward as one piece. The eye reads that as a bend at the thigh, which is
 * exactly how it was reported.
 *
 * In a real gait the knee peaks near phase 0.72 and the hip near 0.87: the knee folds first, while the
 * thigh is still behind the body, and only then does the thigh come through. Fifteen percent of a cycle
 * apart, not five.
 *
 * The reparameterisation keeps both halves of the bell intact, so the value, slope and curvature are still
 * zero at both ends and flat at the peak -- it only spends less of the interval on the way up.
 */
export function skewBump(t: number, peak: number): number {
  /**
   * TWO EASES OF DIFFERENT WIDTHS, not a bell with its input warped.
   *
   * The warp was piecewise linear, and although it joined at the peak in value and slope its SECOND
   * derivative stepped there -- the two halves scale the bell's input by different factors, and the bell's
   * curvature at its own peak is not zero. That is a jerk impulse twice per swing, and it stayed under the
   * gate's bound only while the swing was small: at a stride worth walking it measured 362,588 rad/s^3
   * against the 36,000 that curves believed smooth produce here.
   *
   * Built as a product of two eases instead, each reaching its clamp exactly at the peak, every derivative is
   * flat where the two meet. Same shape, same peak, nothing to kink.
   */
  const rise = ease(Math.min(1, t / Math.max(1e-6, peak)));
  const fall = ease(Math.min(1, (1 - t) / Math.max(1e-6, 1 - peak)));
  return rise * fall;
}

/**
 * A smooth, non-negative, periodic pulse peaking at phase 0.
 *
 * This replaces `max(0, sin(x))`, which was used for knee flexion and looked reasonable and is not: the
 * clamp leaves a slope discontinuity at every zero crossing, and the verification measured the knee's
 * second derivative at 1425 rad/s^2 there -- a kink twice per stride, which is exactly the "breaking"
 * this animation was asked not to have.
 */
export function pulse(phase: number, sharpness = 2): number {
  return Math.pow(0.5 + 0.5 * Math.cos(phase), sharpness);
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/**
 * `min(d, limit)` without the corner.
 *
 * A hard clamp on the leg's reach is a slope discontinuity, and every clip whose stance grazed full
 * extension inherited it: the verification measured 500-1200 rad/s^2 on knees whose driving curves were
 * all perfectly smooth, because the smoothness was destroyed downstream by the clamp. This is a softplus,
 * so it is differentiable everywhere -- indistinguishable from `d` while there is room to spare, and
 * settling onto the limit rather than colliding with it.
 */
export function softMin(d: number, limit: number, knee = 0.004): number {
  return limit - knee * Math.log1p(Math.exp((limit - d) / knee));
}

/** The same, applied to a magnitude: a joint that saturates at +/-`limit` without a corner. */
export function softLimit(x: number, limit: number, knee = 0.05): number {
  return Math.sign(x) * softMin(Math.abs(x), limit, knee);
}

// ---- stage 4: overlap -----------------------------------------------------------------------------

/**
 * A driver as it was `delay` seconds ago. THE ANTI-STIFFNESS PRIMITIVE.
 *
 * A body does not move as one piece. The pelvis turns, and the chest follows it a moment later, and the
 * head later still; the shoulder starts the arm swing and the elbow is still finishing the last one. When
 * every joint instead reaches its extreme on the same frame the figure reads as a mannequin being posed,
 * which is what "cứng" -- stiff -- describes. Mocap has this lag in it for free because a real body has
 * mass. A procedural clip has to put it in on purpose.
 *
 * Because clips here are pure functions of time, the lag needs no buffer and no state: it is the driver
 * evaluated earlier. `period` wraps for a looping clip, so the lag is seamless across the loop seam.
 */
export function delayed(
  f: (t: number) => number, t: number, delay: number, period?: number,
): number {
  if (period === undefined) return f(Math.max(0, t - delay));
  return f((((t - delay) % period) + period) % period);
}

/**
 * A critically-damped step response, for anything that hangs or trails.
 *
 * Stateless by the same trick: the impulse response of a second-order system is a closed form, so a
 * trailing part is its driver convolved with `exp(-t/tau)`. In practice one delayed sample plus one
 * overshoot term reads as mass without integrating anything, which keeps clips samplable by the gates.
 */
export function trail(
  f: (t: number) => number, t: number, tau: number, period?: number,
): number {
  const a = delayed(f, t, tau, period);
  const b = delayed(f, t, tau * 2, period);
  return a + (a - b) * 0.5;
}

// ---- stage 1: the rig's own measurements ----------------------------------------------------------

/**
 * WHICH WAY A KNEE BENDS, established by measurement rather than by assumption.
 *
 * With the rig's shin pointing straight down at rest, driving `shin.rx` to -0.8 puts the ankle 251 mm
 * IN FRONT of the knee, and +0.8 puts it 265 mm behind. Behind is flexion; in front is a knee bending
 * backwards. Every clip was first written with the negative sign, so every one of them hyperextended --
 * that was the "broken, kinked legs" in the walk -- and the verification asserted the same wrong
 * convention, so it confirmed the fault instead of catching it.
 *
 * Forward is +Z. A bone's world PITCH is the angle from straight-down toward +Z, and rotations about X
 * compose additively down the chain, so pitch = restPitch - (sum of rx).
 */
export const LEG = (() => {
  const by = new Map(BONE_SPECS.map((b) => [b.name, b]));
  /**
   * The length that PITCH can actually spend, which is the bone's shadow in the sagittal plane.
   *
   * Rotating about X leaves a bone's x-component exactly where it was and swings only (y, z). The thigh
   * carries 30 mm of x and the shin 35 mm, so their full 3-D lengths overstate the reach available to the
   * solver by 1.1 mm and 1.6 mm. Solving with the 3-D figures asked for a straighter leg than the rig can
   * produce and the ankle came out past its target.
   */
  const planarLength = (name: string): number => {
    const b = by.get(name)!;
    return Math.hypot(b.tail[1] - b.head[1], b.tail[2] - b.head[2]);
  };
  /**
   * A bone's pitch AT REST, which is not zero and cannot be ignored: the thigh runs
   * (0.030, -0.400, -0.010) and the shin (0.035, -0.360, -0.010), both leaning back a degree or two
   * rather than hanging straight down.
   */
  const pitchOf = (name: string): number => {
    const b = by.get(name)!;
    return Math.atan2(b.tail[2] - b.head[2], -(b.tail[1] - b.head[1]));
  };
  const pelvis = by.get('hips')!.head;
  const offset = (name: string): readonly [number, number, number] => {
    const h = by.get(name)!.head;
    return [h[0] - pelvis[0], h[1] - pelvis[1], h[2] - pelvis[2]] as const;
  };
  return {
    thighRest: pitchOf('thigh.L'),
    shinRest: pitchOf('shin.L'),
    footRest: pitchOf('foot.L'),
    thigh: planarLength('thigh.L'),
    shin: planarLength('shin.L'),
    hipY: by.get('thigh.L')!.head[1],
    pelvis,
    hipOffsetL: offset('thigh.L'),
    hipOffsetR: offset('thigh.R'),
    /** Where the ankle rests in the rig. */
    standY: by.get('foot.L')!.head[1],
    /** Each ankle's resting x. The feet keep it: a walk this narrow does not cross the centre line. */
    footXL: by.get('foot.L')!.head[0],
    footXR: by.get('foot.R')!.head[0],
  };
})();

/**
 * WHERE THE BOOT ACTUALLY TOUCHES THE GROUND, measured from the boot mesh rather than from the bone.
 *
 * A foot bone has a head and a tail and says nothing about the shape of the sole, which is what a stance
 * is built on. `scripts/measure-cloth.mjs` reads the boot's own vertices and reports the contact patch:
 * the sole sits at y = -0.8 mm -- the floor -- and runs from z = -53 mm at the heel to z = +58.5 mm at
 * the ball, so it is 111 mm long. Against the ankle at (0.150, 0.140, -0.030) that puts the heel just
 * 23 mm behind the ankle and the ball 88 mm in front of it: a short heel lever and a long forefoot, which
 * is what a heeled boot is.
 *
 * Those two points are the pivots the three rockers turn about. Guessing them from the bone's tail would
 * have put the ball 70 mm forward instead of 88 and the heel nowhere at all.
 */
export const FOOT = (() => {
  const SOLE_Y = -0.0008;
  const HEEL_Z = -0.0530;
  /**
   * The forefoot rocker pivots under the METATARSAL HEADS, not under the toe tip.
   *
   * With no toe joint in the rig there was nothing to pivot about but the sole's front edge at z=+58 mm, so
   * the whole boot rotated about its tip. Now that the rig has a toe joint at z=+25 mm, the foot rolls over
   * that and the toe stays flat on the ground behind it, which is what a foot does and what makes a sole
   * look like it bends.
   */
  const BALL_Z = 0.0250;
  const ankle = BONE_SPECS.find((b) => b.name === 'foot.L')!.head;
  /** A contact point as a lever from the ankle: how long, and at what pitch when the foot is at rest. */
  const lever = (z: number): { r: number; phi: number } => {
    const dz = z - ankle[2];
    const dy = SOLE_Y - ankle[1];
    return { r: Math.hypot(dz, dy), phi: Math.atan2(dz, -dy) };
  };
  return { soleY: SOLE_Y, heel: lever(HEEL_Z), ball: lever(BALL_Z) };
})();

/** Where the ankle is, given a contact point on the ground and how far the foot has rotated from rest. */
function ankleOver(
  contactZ: number, lever: { r: number; phi: number }, pitch: number,
): { y: number; z: number } {
  return {
    z: contactZ - lever.r * Math.sin(lever.phi + pitch),
    y: FOOT.soleY + lever.r * Math.cos(lever.phi + pitch),
  };
}

// ---- stage 2: the solve ---------------------------------------------------------------------------

/** A world point in the pelvis's frame: the plain inverse of three's `Rx * Ry * Rz` about its pivot. */
export function intoPelvisFrame(p: PelvisState, w: THREE.Vector3): THREE.Vector3 {
  const px = w.x - (p.tx ?? 0) - LEG.pelvis[0];
  const py = w.y - (p.ty ?? 0) - LEG.pelvis[1];
  const pz = w.z - (p.tz ?? 0) - LEG.pelvis[2];
  // Rx first, then Ry, then Rz -- innermost factor first, which is what inverting the product means.
  const cx = Math.cos(-(p.rx ?? 0)); const sx = Math.sin(-(p.rx ?? 0));
  const by = py * cx - pz * sx;
  const bz = py * sx + pz * cx;
  const cy = Math.cos(-(p.ry ?? 0)); const sy = Math.sin(-(p.ry ?? 0));
  const ax = px * cy + bz * sy;
  const az = -px * sy + bz * cy;
  const cz = Math.cos(-(p.rz ?? 0)); const sz = Math.sin(-(p.rz ?? 0));
  return new THREE.Vector3(ax * cz - by * sz, ax * sz + by * cz, az);
}

/**
 * The pelvis-frame ankle target that lands the foot at a given WORLD height and depth.
 *
 * This is subtler than transforming a point, and getting it wrong cost 11 mm of foot placement. The leg's
 * two pitch joints sweep the pelvis's sagittal plane, so the ankle's x IN THAT FRAME is fixed by the bone
 * offsets -- 150 mm out -- and cannot be chosen. What the clip asks for is a world height and depth: the
 * sole on the floor, at this point in the stride. Its world x is then whatever the rotated chain happens
 * to give, and is not ours to specify.
 *
 * Feeding the transform a world point with x = 150 mm asserted otherwise, and the assertion is false the
 * moment the pelvis rotates: the error tracked the pelvic tilt and list exactly. So instead of
 * transforming a point, solve for the one that works -- two equations (world y and z as required), two
 * unknowns (the pelvis-frame y and z), with the frame's x pinned at the value the chain must produce.
 *
 * Rows 1 and 2 of three's `Rx * Ry * Rz` are all it takes.
 */
export function pelvisTarget(
  p: PelvisState, footX: number, worldY: number, worldZ: number,
): { y: number; z: number } {
  const cx = Math.cos(p.rx ?? 0); const sx = Math.sin(p.rx ?? 0);
  const cy = Math.cos(p.ry ?? 0); const sy = Math.sin(p.ry ?? 0);
  const cz = Math.cos(p.rz ?? 0); const sz = Math.sin(p.rz ?? 0);
  const r1 = [cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy];
  const r2 = [sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy];
  const b1 = worldY - LEG.pelvis[1] - (p.ty ?? 0) - r1[0] * footX;
  const b2 = worldZ - LEG.pelvis[2] - (p.tz ?? 0) - r2[0] * footX;
  const det = r1[1] * r2[2] - r1[2] * r2[1];
  return {
    y: (b1 * r2[2] - r1[2] * b2) / det,
    z: (r1[1] * b2 - b1 * r2[1]) / det,
  };
}

/**
 * Two-bone inverse kinematics in the sagittal plane: where must the hip and knee point for the ankle to
 * be HERE?
 *
 * Driving joint angles directly is what produced a walk whose feet never reached the ground -- the lowest
 * toe sat 52 mm up -- and whose planted foot slid 300 mm per step. Neither is fixable by tuning angles,
 * because neither is expressed in angles: contact and slide are statements about where the foot IS.
 */
export function solveLeg(hipY: number, hipZ: number, ankleY: number, ankleZ: number): {
  thighRx: number; shinRx: number;
} {
  const dy = ankleY - hipY;
  const dz = ankleZ - hipZ;
  const l1 = LEG.thigh;
  const l2 = LEG.shin;
  const reach = softMin(Math.hypot(dy, dz), l1 + l2 - IK_REACH_RESERVE);
  const line = Math.atan2(dz, -dy);
  const cosHip = Math.min(1, Math.max(-1, (l1 * l1 + reach * reach - l2 * l2) / (2 * l1 * reach)));
  const thighPitch = line + Math.acos(cosHip);
  const kneeY = hipY - Math.cos(thighPitch) * l1;
  const kneeZ = hipZ + Math.sin(thighPitch) * l1;
  const shinPitch = Math.atan2(ankleZ - kneeZ, -(ankleY - kneeY));
  const thighRx = LEG.thighRest - thighPitch;
  return { thighRx, shinRx: LEG.shinRest - shinPitch - thighRx };
}

/** How far the ankle can be driven either way. Beyond this it is not an ankle. */
export const ANKLE_RANGE = 0.72;

/**
 * How far short of straight the leg solver refuses to go, in metres.
 *
 * It exists because two-bone IK is singular at full extension -- the knee angle comes out of an `acos`
 * whose sensitivity runs away as the argument approaches 1. It was 8 mm, and 8 mm of a 760 mm leg is
 * 16 degrees of knee: it, and not the pelvis drop, was the floor under the "walks in a permanent crouch"
 * report. The derivation that was supposed to control the knee did not model it and so believed the knee
 * was at 7 degrees while the rig produced 17.
 *
 * At 2 mm the floor is 8 degrees, which reads as a straight leg, and the softplus in `softMin` keeps the
 * approach smooth rather than clamped.
 */
export const IK_REACH_RESERVE = 0.002;



/**
 * Put one ankle HERE, at this foot pitch, and let the leg work out how.
 *
 * Every clip used to drive `thigh.rx` and `shin.rx` by hand, and the numbers were mutually dependent -- a
 * thigh angle chosen to compensate for a hyperextended knee only looks right while the knee stays broken
 * -- so the signs could not be fixed one at a time. Naming the ankle's position instead makes the knee a
 * consequence of geometry, and a stance becomes describable as the thing a stance actually is.
 *
 * `pitch` is the foot's rotation away from its resting angle: 0 keeps the sole flat, negative lifts the
 * heel. `amount` scales the whole solved pose, which is how a one-shot starts and ends exactly at rest.
 */
export function plantFoot(
  out: Pose, side: 1 | -1, pelvis: PelvisState,
  y: number, z: number, pitch = 0, amount = 1, ankleX?: number, toeOut?: number,
): void {
  const suffix = side > 0 ? '.L' : '.R';
  const hipOffset = side > 0 ? LEG.hipOffsetL : LEG.hipOffsetR;
  const restX = side > 0 ? LEG.footXL : LEG.footXR;
  /**
   * SIDEWAYS AS WELL AS FORE-AND-AFT, which the solver could not do before.
   *
   * It only ever placed the ankle in the pelvis's sagittal plane, with the foot's lateral position pinned
   * at whatever the rest pose gave it -- and this rig rests with its legs splayed: the ankles sit 325 mm
   * apart against hips 180 mm apart. Measured on the walk, the feet stayed 314 to 350 mm apart throughout.
   * A human walk keeps them 80 to 120. That is the straddle, and no amount of work in the sagittal plane
   * could have touched it.
   *
   * Bringing the ankle in is hip ADDUCTION: rotate the whole leg about Z and the chain's fixed lateral
   * offset swings with it. Given the ankle's wanted (x, y) relative to the hip, the rotation and the leg's
   * remaining vertical are one right-triangle solve -- the chain's offset vector simply has to be turned to
   * point at the target, and its length is what it is.
   */
  const wantX = ankleX ?? restX;
  const local = intoPelvisFrame(pelvis, new THREE.Vector3(wantX, y, z));
  const dx = local.x - hipOffset[0];
  const dy = local.y - hipOffset[1];
  const dz = local.z - hipOffset[2];
  const x0 = restX - hipOffset[0];
  const span = Math.hypot(dx, dy);
  // The leg cannot be shorter than its own lateral offset; below that, adduct as far as it goes.
  const yPrime = -Math.sqrt(Math.max(1e-6, span * span - x0 * x0));
  const adduct = Math.atan2(dy, dx) - Math.atan2(yPrime, x0);
  const solved = solveLeg(0, 0, yPrime, dz);
  add(out, `thigh${suffix}`, { rz: adduct * amount });
  add(out, `thigh${suffix}`, { rx: solved.thighRx * amount });
  add(out, `shin${suffix}`, { rx: solved.shinRx * amount });
  // The ankle cancels the chain -- which is what keeps the sole flat -- and then adds the pitch asked
  // for. With the knee at 1.13 rad the cancellation alone wants 0.82 rad of ankle, more than an ankle
  // has, so it saturates smoothly rather than being clamped or tapered. Tapering was tried and let the
  // toe drop 9 mm THROUGH the floor, because a foot that stops levelling points wherever its shin does.
  const footRx = -pitch - solved.thighRx - solved.shinRx;
  add(out, `foot${suffix}`, { rx: softLimit(footRx, ANKLE_RANGE) * amount });
  /**
   * WHICH WAY THE FOOT POINTS, which was previously whatever the chain above it happened to leave.
   *
   * The pelvis yaws, the leg is carried with it, and the rig's own foot bone already toes out 8 degrees --
   * so the measured toe-out on the walk ran to 51 degrees on one side and 49 on the other, wandering by 30
   * degrees within a single cycle. A human walk holds 5 to 7. Corrected by measuring what the chain has
   * actually produced and turning the ankle back, which needs forward kinematics rather than arithmetic:
   * the yaw a bone inherits is not the sum of the yaws above it once pitches and rolls are in play.
   */
  if (toeOut !== undefined) {
    // MEASURED THROUGH A HORIZONTAL REFERENCE, not through the foot's own bone. The bone points down and
    // forward, so once the foot pitches for a heel strike or a toe-off its shadow on the ground is almost
    // nothing and the yaw read off it is noise: the correction spiked to 102 degrees mid-swing while
    // holding a correct 6 through stance. A forward unit vector carried by the same rotation keeps a long
    // shadow at every pitch this gait uses.
    const rot = poseFK(out, `foot${suffix}`).rot;
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(rot);
    const have = Math.atan2(fwd.x, fwd.z);
    add(out, `foot${suffix}`, { ry: (side * toeOut - have) * amount });
  }
  /**
   * THE TOE STAYS ON THE GROUND while the heel comes up over it.
   *
   * `pitch` is negative once the heel is rising, and holding the toe's world pitch at its rest angle means
   * cancelling everything above it -- which comes out to exactly `pitch`. Positive pitch is heel strike,
   * where the toe is in the air and has nothing to hold onto, so it stays in line with the foot instead.
   *
   * `min(0, pitch)` is the obvious way to write that and it is a corner. It looked safe because pitch
   * reaches zero with zero slope at the end of the heel rocker -- but it crosses zero again in MID-SWING,
   * on the way from toe-off back to the next contact, and there its slope is not zero at all. The jerk gate
   * measured 444,113 rad/s^3 on the toe. The softplus is the same shape without the corner.
   */
  add(out, `toe${suffix}`, { rx: softMin(pitch, 0, 0.03) * amount });
}

/**
 * Where a hip joint actually IS once the pelvis has moved.
 *
 * The pelvis pivot sits at y=0.900, the same height as both hip joints, so a pelvic roll of 0.035 rad
 * swings each hip through a pure 3 mm rise or fall -- opposite signs left and right, reversing every half
 * cycle. Solving each leg against the rig's resting hip instead ignored that, and the planted foot paid
 * for it. Mirrors three's `Rx * Ry * Rz` Euler composition exactly.
 */
export function hipAnchor(side: 1 | -1, p: PelvisState): { x: number; y: number; z: number } {
  const [ox, oy, oz] = side > 0 ? LEG.hipOffsetL : LEG.hipOffsetR;
  const cz = Math.cos(p.rz ?? 0); const sz = Math.sin(p.rz ?? 0);
  const bx = ox * cz - oy * sz;
  const by = ox * sz + oy * cz;
  const cy = Math.cos(p.ry ?? 0); const sy = Math.sin(p.ry ?? 0);
  const ax = bx * cy + oz * sy;
  const az = -bx * sy + oz * cy;
  const cx = Math.cos(p.rx ?? 0); const sx = Math.sin(p.rx ?? 0);
  return {
    x: LEG.pelvis[0] + ax + (p.tx ?? 0),
    y: LEG.pelvis[1] + by * cx - az * sx + (p.ty ?? 0),
    z: LEG.pelvis[2] + by * sx + az * cx + (p.tz ?? 0),
  };
}

/**
 * How much of a one-shot clip's stance is engaged, so it begins and ends exactly at rest.
 *
 * The solver will not straighten a leg completely -- it holds 8 mm back to stay clear of the singular
 * pose -- so asking it for the rig's own standing pose returns something 8 mm short of it. In a looping
 * walk that never shows; in a one-shot it would be a jolt on the first and last frame.
 */
export function activity(t: number, duration: number): number {
  return ease(Math.min(1, t / 0.14)) * ease(Math.min(1, (duration - t) / 0.22));
}

// ---- stage 2b: the arm ------------------------------------------------------------------------------

/**
 * Forward kinematics over a pose, for any bone.
 *
 * The leg solver never needed this: a leg hangs off the pelvis, and a clip knows what it did to the
 * pelvis. An arm hangs off the chest, which hangs off the spine, which hangs off the hips -- and a combat
 * clip moves all three. Solving the arm without knowing where the chest ended up is guessing, and guessing
 * is what the hand-authored combat poses were.
 */
export function poseFK(pose: Pose, target: string): { pos: THREE.Vector3; rot: THREE.Quaternion } {
  const chain: string[] = [];
  for (let name: string | null = target; name; ) {
    const spec = BONE_SPECS.find((b) => b.name === name);
    if (!spec) break;
    chain.unshift(spec.name);
    name = spec.parent;
  }
  const pos = new THREE.Vector3();
  const rot = new THREE.Quaternion();
  const local = new THREE.Vector3();
  const step = new THREE.Quaternion();
  let prevHead: readonly number[] = [0, 0, 0];
  for (const name of chain) {
    const spec = BONE_SPECS.find((b) => b.name === name)!;
    const d = pose[name] ?? {};
    local.set(
      spec.head[0] - prevHead[0] + (d.tx ?? 0),
      spec.head[1] - prevHead[1] + (d.ty ?? 0),
      spec.head[2] - prevHead[2] + (d.tz ?? 0),
    );
    pos.add(local.applyQuaternion(rot));
    rot.multiply(deltaQuaternion(d, step));
    prevHead = spec.head;
  }
  return { pos, rot };
}

/** The arm's own measurements, taken from the rig the same way `LEG` takes the leg's. */
export const ARM = (() => {
  const by = new Map(BONE_SPECS.map((b) => [b.name, b]));
  const dir = (name: string): THREE.Vector3 => {
    const b = by.get(name)!;
    return new THREE.Vector3(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]);
  };
  const upperL = dir('upperArm.L');
  const foreL = dir('foreArm.L');
  const upperR = dir('upperArm.R');
  const foreR = dir('foreArm.R');
  // PER SIDE. This rig's arms are not mirror images: the right upper arm is 285.7 mm and the left 272.6.
  // Using the left's length for both put the right wrist 13.1 mm off every target it was given, which is
  // exactly the difference -- a solver cannot be more accurate than the measurements it is handed.
  return {
    upper: { L: upperL.length(), R: upperR.length() },
    fore: { L: foreL.length(), R: foreR.length() },
    restUpper: { L: upperL.clone().normalize(), R: upperR.clone().normalize() },
    restFore: { L: foreL.clone().normalize(), R: foreR.clone().normalize() },
  };
})();

/**
 * How far the elbow may flex, and the fact that it may not go the other way.
 *
 * Measured, not assumed -- `scripts/measure-joint-axis.ts` drives the joint and looks: `foreArm.rx = -0.9`
 * carries the hand 208 mm FORWARD, which is flexion, and +0.9 carries it the same distance backward, which
 * is an elbow bending the wrong way. The knee had exactly this fault in all six clips and it took a render
 * to notice; the elbow was never checked at all, and the clip gate had no sign test on it.
 */
export const ELBOW_MAX_FLEX = 2.5;

const IDENTITY_Q = new THREE.Quaternion();


/**
 * THE ELBOW'S HINGE AXIS, which is not a model axis.
 *
 * It is the normal to the plane the upper arm and forearm already lie in -- and they do lie in one, at 24
 * degrees to each other, because this rig's arm is not straight at rest. Folding about the model's X
 * instead sweeps the forearm around a cone that is tilted out of that plane, so the wrist's distance from
 * the shoulder stops being monotone in the fold angle: the bisection that assumed it was missed its target
 * by 54 mm on some directions and would have gone on doing so silently.
 *
 * The sign is measured rather than reasoned about: whichever way shortens the arm is flexion.
 */
const ELBOW_AXIS = (() => {
  const make = (side: 1 | -1): THREE.Vector3 => {
    const u = side > 0 ? ARM.restUpper.L : ARM.restUpper.R;
    const f = side > 0 ? ARM.restFore.L : ARM.restFore.R;
    const n = u.clone().cross(f).normalize();
    const lu = side > 0 ? ARM.upper.L : ARM.upper.R;
    const lf = side > 0 ? ARM.fore.L : ARM.fore.R;
    const span = (axis: THREE.Vector3, a: number): number => u.clone().multiplyScalar(lu)
      .add(f.clone().applyAxisAngle(axis, a).multiplyScalar(lf)).length();
    return span(n, 0.4) < span(n, -0.4) ? n : n.negate();
  };
  return { L: make(1), R: make(-1) };
})();

/**
 * How far the wrist sits from the shoulder when the elbow is flexed `flex` past its resting bend.
 *
 * The rig's arm is not straight at rest, so the usual cosine rule on two segments does not apply directly.
 * Building the wrist and measuring is exact and costs nothing worth counting.
 */
export function wristLocal(side: 1 | -1, flex: number): THREE.Vector3 {
  const restUpper = side > 0 ? ARM.restUpper.L : ARM.restUpper.R;
  const restFore = side > 0 ? ARM.restFore.L : ARM.restFore.R;
  const axis = side > 0 ? ELBOW_AXIS.L : ELBOW_AXIS.R;
  const fore = restFore.clone().applyAxisAngle(axis, flex)
    .multiplyScalar(side > 0 ? ARM.fore.L : ARM.fore.R);
  return restUpper.clone().multiplyScalar(side > 0 ? ARM.upper.L : ARM.upper.R).add(fore);
}

/**
 * Put a HAND where the clip asks, and let the shoulder and elbow work out how.
 *
 * The combat clips were written the way the walk once was -- `upperArm.rx`, `.ry`, `.rz` and `foreArm.rx`
 * chosen by eye, one number at a time -- and they failed the same way. A strike is a statement about where
 * the weapon goes, so the angles that get it there are a consequence, not an input, and choosing them by
 * hand means the numbers only agree with each other in the one pose they were tuned in.
 *
 * THE ELBOW IS A HINGE, and modelling it as anything else is what the first version of this got wrong. It
 * aimed the forearm at the target with a free rotation, which lands the wrist correctly and produces an
 * `rx` of either sign -- so the round-trip test found the elbow bending backwards on 47 of 128 targets.
 * A hinge has one degree of freedom: the elbow only flexes, the SHOULDER carries all the orientation, and
 * the two together are exactly enough to reach any point in range.
 *
 * `pole` IS AN ANGLE ABOUT A TRANSPORTED FRAME, which took two wrong turns to arrive at.
 *
 * Twisting about the aim on top of a minimal rotation was the first attempt. `setFromUnitVectors` gives
 * the rotation with no roll about the a-to-b axis, and "no roll" is defined relative to that axis, so as
 * the aim sweeps, the roll it implies sweeps with it in a way nobody asked for: the shoulder spun at
 * 45.6 rad/s while the hand moved a perfectly ordinary 3.6 m/s.
 *
 * Aiming the elbow at a POINT was the second, and it is what most rigs do -- but a pole point is only
 * stable while it stays well off the shoulder-to-hand line, and an authored one drifts onto it. Measured:
 * 101 rad/s, with the arm plane flipping through the degenerate configuration.
 *
 * What works is to carry the rest arm's own plane along with the aim -- the minimal rotation is exactly
 * the right tool for THAT, since transporting a frame is what it does well -- and to let the clip turn the
 * elbow from there. Degenerate only if the hand aims opposite its resting direction, which is behind the
 * shoulder and through the ribs.
 */
/**
 * How far the shoulder may roll the upper arm about its own length.
 *
 * A humerus rotates about 90 degrees each way, and nothing in a rig makes that untrue -- it just lets you
 * ignore it. Ignoring it cost 176.9 degrees of roll at one shoulder in the diagonal cut, which is a half
 * turn of the upper arm at a single joint, and no amount of twist-bone distribution rescues that: halving
 * a half turn is still a quarter turn of shear across the deltoid.
 *
 * Capping the POLE is not enough, and the measurement said so: the swing onto an overhead aim carries roll
 * of its own, so a pole held to 92 degrees still produced 119 degrees of internal rotation.
 *
 * CLAMPING THE FINISHED TWIST IS NOT THE ANSWER EITHER, which took a measurement to establish. A twist
 * about the arm's own length looked harmless -- it moves the hand only in proportion to how bent the elbow
 * is -- and with the elbow past 90 degrees it swings the forearm through a wide arc: the round-trip test
 * went from landing exactly on 128 targets to missing one by 280 mm. The solver stays exact, and a clip
 * that asks for an impossible shoulder is a clip to fix, which `verify-joint-limits.mjs` now says out loud.
 */
export const SHOULDER_ROLL_LIMIT = 1.30;
export const SHOULDER_TWIST: [number, number] = [(-70 * Math.PI) / 180, (90 * Math.PI) / 180];

export function reachHand(
  out: Pose, side: 1 | -1, targetWorld: THREE.Vector3, pole: number, amount = 1,
  pronate = 0, alreadyLimited = false,
): void {
  const suffix = side > 0 ? '.L' : '.R';
  const shoulder = poseFK(out, `upperArm${suffix}`);
  const parent = poseFK(out, `shoulder${suffix}`);
  const toParent = parent.rot.clone().invert();

  // In the upper arm's PARENT frame, which is where its rotation acts.
  const toTarget = targetWorld.clone().sub(shoulder.pos).applyQuaternion(toParent);
  const straight = wristLocal(side, 0).length();
  const folded = wristLocal(side, ELBOW_MAX_FLEX).length();
  const reach = Math.min(Math.max(toTarget.length(), folded + 0.004), straight - 0.004);
  if (reach < 1e-4) return;
  const aim = toTarget.normalize();

  // Bisect the elbow: folding it monotonically shortens the reach.
  let lo = 0;
  let hi = ELBOW_MAX_FLEX;
  for (let i = 0; i < 28; i += 1) {
    const mid = (lo + hi) * 0.5;
    if (wristLocal(side, mid).length() > reach) lo = mid; else hi = mid;
  }
  const flex = (lo + hi) * 0.5;
  const wrist = wristLocal(side, flex);

  // Where the elbow sits on its cone about the aim line. The reference is the rest arm's own plane,
  // carried onto the current aim, and `pole` turns the elbow from there.
  const restUpper = side > 0 ? ARM.restUpper.L : ARM.restUpper.R;
  const lift = restUpper.angleTo(wrist);
  const restAim = wristLocal(side, flex).normalize();
  const transport = new THREE.Quaternion().setFromUnitVectors(restAim, aim);
  const perp = restUpper.clone().applyQuaternion(transport);
  perp.sub(aim.clone().multiplyScalar(perp.dot(aim)));
  /**
   * AN ALMOST STRAIGHT ARM HAS NO ELBOW PLANE, and that used to make this function give up silently.
   *
   * `perp` is the reference the elbow's position on its cone is measured from, and its length is exactly
   * sin(lift) -- so it vanishes precisely when the arm is straight, because a straight arm's elbow is on the
   * line and has no cone to sit on. The old code returned there, WITHOUT WRITING ANYTHING: the shoulder and
   * elbow stayed at rest, so an arm asked to reach its full extension simply did not move. It surfaced in a
   * transition, where a blended reach can land on the extension clamp for a frame or two and the arm flicked
   * back to hanging -- 190 rad/s and 20,831 rad/s^2 at the shoulder, out of curves with nothing wrong with
   * them. But it was never confined to transitions.
   *
   * When there is no plane there is also nothing to decide: `lift` is zero, so the upper arm points straight
   * down the aim and the pole has nothing to turn.
   */
  const flat = perp.lengthSq() < 1e-8;
  if (!flat) {
    /**
     * `alreadyLimited` EXISTS SO THE ROUND TRIP IS EXACT, and the reason is a measurable step.
     *
     * `armStateOf` reads back the pole this function produced, which is the value AFTER `softLimit` has
     * compressed it. Feeding that back in compresses it a second time, so re-solving an arm from its own
     * readback moves the shoulder about two degrees. That does not matter while an arm is being solved
     * continuously -- but the moment a transition's offset retires, the arm goes back to the clip's own
     * channels, and those two degrees arrive in a single frame: 920 to 973 rad/s^2 on the twist bones, at
     * the same value in every transition, which is what one fixed event looks like. With the compression
     * skipped the readback is exact and there is nothing to step.
     *
     * Hard-clamped rather than left free, because the sum of a limited pole and an offset can still exceed
     * the limit; `softLimit` is nearly flat out there, so the two agree to within rounding where it binds.
     */
    const held = alreadyLimited
      ? Math.max(-SHOULDER_ROLL_LIMIT, Math.min(SHOULDER_ROLL_LIMIT, pole))
      : softLimit(pole, SHOULDER_ROLL_LIMIT);
    perp.normalize().applyAxisAngle(aim, held);
  }
  const upperDir = flat
    ? aim.clone()
    : aim.clone().multiplyScalar(Math.cos(lift)).add(perp.multiplyScalar(Math.sin(lift))).normalize();

  // One rotation carries the whole arm: the upper arm onto its direction, and the arm's PLANE with it.
  const turn = frameRotation(restUpper, wrist.clone().normalize(), upperDir, aim);
  if (amount < 1) turn.slerp(IDENTITY_Q, 1 - amount);
  add(out, `upperArm${suffix}`, { q: turn });
  const axis = side > 0 ? ELBOW_AXIS.L : ELBOW_AXIS.R;
  add(out, `foreArm${suffix}`, {
    q: new THREE.Quaternion().setFromAxisAngle(axis, flex * amount),
  });
  /**
   * PRONATION, which is where most of an arm's roll actually lives.
   *
   * Turning a blade over is not a shoulder movement. The radius rolls across the ulna and the palm follows
   * -- 150 degrees of it, against the humerus's 90 -- and it is distributed along the forearm rather than
   * concentrated at either end. Applied at the hand so that `applyArmTwist` can spread it: the elbow gets
   * none, the mid-forearm half, the wrist all of it.
   */
  if (pronate !== 0) {
    const foreAxis = side > 0 ? ARM.restFore.L : ARM.restFore.R;
    // ON THE FOREARM'S OWN TWIST BONE, not on the hand. Turning the palm over is the radius crossing the
    // ulna, and a wrist has almost no twist of its own -- written on the hand it measured 109 degrees
    // against a joint that has 15. Capped at what a forearm actually does, 85 degrees either way.
    // Same reason as the pole above: `armStateOf` reads back the roll this wrote, so compressing it again on
    // the way in moves the forearm a little, and that little arrives in one frame when a transition's offset
    // retires. It measured 916 to 987 rad/s^2 on the twist bones and the forearm, at repeated exact values
    // across unrelated pairs of clips -- the signature of one fixed event rather than a curve.
    const cap = (85 * Math.PI) / 180;
    const roll = pronate * amount;
    const held = alreadyLimited
      ? Math.max(-cap, Math.min(cap, roll))
      : softLimit(roll, cap, 0.1);
    add(out, `foreArmTwist${suffix}`, {
      q: new THREE.Quaternion().setFromAxisAngle(foreAxis, held),
    });
  }
  applyArmTwist(out, side, pronate !== 0);
}

/**
 * Read an arm's state back OUT of a pose: where the wrist is, where the elbow sits on its cone, and how far
 * the forearm is rolled. The inverse of what `reachHand` writes.
 *
 * WHY THIS EXISTS. Cross-fading two clips bone by bone works while the two poses are close and fails when
 * they are not, and the arms are exactly where they are not. Measured on `slash` interrupted a quarter of
 * the way into `spin-slash`: one clip has the right wrist out to the side at (-515, 1303, -15) and the other
 * has it across the front at (-37, 1043, 170) -- 575 mm apart, the same shoulder ELEVATION of 56 and 60
 * degrees but azimuths of 139 and -79. As rotations those two poses pass through 179.8 degrees apart, and a
 * pair of rotations 180 degrees apart has no shorter way round: interpolating them either jumps when the
 * choice of direction flips (measured: 138 rad/s in one frame, where nothing else in that transition passed
 * 17) or, if the direction is held, sweeps the long way and puts 159 degrees of twist through a shoulder
 * that has 90.
 *
 * Neither is a tuning problem. A body does not get from one to the other by turning its humerus 180 degrees
 * about some axis; it carries its HAND across, and the joints follow. So a transition blends the hand's
 * place and re-solves, and then the intermediate poses are arm poses rather than points on an arbitrary
 * geodesic.
 */
export function armStateOf(
  pose: Pose, side: 1 | -1,
): { dir: THREE.Vector3; reach: number; pole: number; pronate: number } {
  const suffix = side > 0 ? '.L' : '.R';
  const wrist = poseFK(pose, `hand${suffix}`).pos;
  const shoulder = poseFK(pose, `upperArm${suffix}`);
  const parent = poseFK(pose, `shoulder${suffix}`);
  const restUpper = side > 0 ? ARM.restUpper.L : ARM.restUpper.R;

  const toTarget = wrist.clone().sub(shoulder.pos).applyQuaternion(parent.rot.clone().invert());
  const straight = wristLocal(side, 0).length();
  const folded = wristLocal(side, ELBOW_MAX_FLEX).length();
  /**
   * THE RAW LENGTH IS RETURNED, THE CLAMPED ONE IS USED HERE.
   *
   * `reachHand` holds the wrist 4 mm short of full extension, so reading back a clamped value and handing it
   * straight in gives the same answer -- but its DERIVATIVE is zero wherever the clamp binds, and 4 mm of
   * reach near full extension is a large elbow angle, because the elbow comes out of an `acos` whose
   * sensitivity runs away there. So an arm sitting on the clamp reads back as having a still elbow, and when
   * a transition's offset retires and the arm goes back to the clip's own channels the difference arrives in
   * one frame: 916 to 987 rad/s^2 on the forearm and the twist bones. Returning the true length and letting
   * `reachHand` do the clamping makes the round trip exact instead.
   */
  const reach = Math.min(Math.max(toTarget.length(), folded + 0.004), straight - 0.004);
  const aim = toTarget.clone().normalize();

  // Same bisection `reachHand` uses, so the two agree on which elbow angle a given reach means.
  let lo = 0;
  let hi = ELBOW_MAX_FLEX;
  for (let i = 0; i < 28; i += 1) {
    const mid = (lo + hi) * 0.5;
    if (wristLocal(side, mid).length() > reach) lo = mid; else hi = mid;
  }
  const flex = (lo + hi) * 0.5;

  // The reference the pole is measured from: the rest arm's own plane, carried onto this aim.
  const restAim = wristLocal(side, flex).normalize();
  const transport = new THREE.Quaternion().setFromUnitVectors(restAim, aim);
  const reference = restUpper.clone().applyQuaternion(transport);
  reference.sub(aim.clone().multiplyScalar(reference.dot(aim)));

  // And where the upper arm actually points, in the same frame.
  const actual = restUpper.clone().applyQuaternion(deltaQuaternion(pose[`upperArm${suffix}`], new THREE.Quaternion()));
  actual.sub(aim.clone().multiplyScalar(actual.dot(aim)));

  let pole = 0;
  if (reference.lengthSq() > 1e-8 && actual.lengthSq() > 1e-8) {
    reference.normalize();
    actual.normalize();
    const cross = reference.clone().cross(actual);
    pole = Math.atan2(cross.dot(aim), reference.dot(actual));
  }
  const foreAxis = side > 0 ? ARM.restFore.L : ARM.restFore.R;
  const roll = pose[`foreArmTwist${suffix}`];
  const pronate = roll
    ? twistAngle(deltaQuaternion(roll, new THREE.Quaternion()), foreAxis)
    : 0;
  // AS A DIRECTION AND A LENGTH, in the shoulder's parent frame -- not as an elevation and an azimuth.
  //
  // Four spaces were tried for holding an arm's difference from a clip, and the first three are wrong for
  // reasons worth keeping:
  //
  //   THE WRIST'S PLACE IN THE BODY. A straight line between two places is not how a hand travels. The two
  //   wrists in `slash` -> `spin-slash` are 575 mm apart and the segment between them passes 268 mm from the
  //   shoulder, where the arm is folded nearly to its 230 mm minimum, so the arm collapsed into the chest
  //   and opened out again -- 40 rad/s at the shoulder.
  //
  //   THE BONE'S ROTATION. An offset held as a rotation decays about a fixed axis, and for a shoulder half a
  //   turn from where it is going that axis took the wrist 106 mm INSIDE the torso, with every joint in range
  //   and every speed legal the whole way.
  //
  //   ELEVATION AND AZIMUTH. An azimuth does not exist at the pole, and clips go there: `spin-slash` brings
  //   this arm within one degree of hanging, where its own azimuth reads -13, then 38, then 97 degrees in
  //   consecutive frames. Adding an offset to a number that means nothing gave the shoulder 135 rad/s. The
  //   sum of two elevations can also exceed 180, and past that the coordinate folds over the top and takes
  //   the azimuth with it -- measured at 236 degrees.
  //
  //   A DIRECTION, with the offset held as the ROTATION between two directions. This. There are no
  //   coordinates to be singular, the rotation is fixed at the instant of the switch so there is no path to
  //   re-decide, and a decaying rotation applied to the clip's own aim carries the hand along an arc at
  //   arm's length -- which is the one thing all three of the others got wrong.
  return { dir: aim.clone(), reach: toTarget.length(), pole, pronate };
}

/**
 * The rotation carrying one pair of directions onto another.
 *
 * Two pairs, not one: a single pair leaves a free roll, and that free roll is what made the shoulder spin.
 * `(a0, b0)` span the rest plane and `(a1, b1)` the target plane, so the frames are fully determined and
 * so is the rotation between them.
 */
function frameRotation(
  a0: THREE.Vector3, b0: THREE.Vector3, a1: THREE.Vector3, b1: THREE.Vector3,
): THREE.Quaternion {
  const basis = (f: THREE.Vector3, g: THREE.Vector3): THREE.Matrix4 => {
    const e1 = f.clone().normalize();
    const e2 = g.clone().sub(e1.clone().multiplyScalar(g.dot(e1)));
    if (e2.lengthSq() < 1e-10) e2.set(e1.y, -e1.x, 0);
    e2.normalize();
    const e3 = e1.clone().cross(e2);
    return new THREE.Matrix4().makeBasis(e1, e2, e3);
  };
  const from = new THREE.Quaternion().setFromRotationMatrix(basis(a0, b0));
  const to = new THREE.Quaternion().setFromRotationMatrix(basis(a1, b1));
  return to.multiply(from.invert());
}

/**
 * WHICH WAY THE BLADE POINTS, in the hand's own frame.
 *
 * Measured off the sword mesh rather than assumed: its bounding box runs 693 mm down and 949 mm forward
 * of the grip, so a held blade points down and forward at about 36 degrees below horizontal. The hand
 * bone has no rest rotation, so that world direction is also its local one.
 */
export const BLADE_LOCAL = new THREE.Vector3(0, -0.590, 0.807).normalize();

/**
 * Turn the hand so the blade points somewhere.
 *
 * `reachHand` places the wrist and says nothing about the hand's own rotation, which is what carries the
 * weapon -- so a cut solved without this has the arm sweeping the right arc with the blade pointing
 * wherever the arm plane happens to leave it. In the first render of the rebuilt cut the sword stuck out
 * horizontally behind her through the wind-up and stood straight up at the moment of impact.
 *
 * The roll about the blade's own axis is left free. It is the edge orientation, and at this scale a
 * katana's edge reads far less than its direction does.
 */
export function pointBlade(
  out: Pose, side: 1 | -1, worldDir: THREE.Vector3, amount = 1,
): void {
  const suffix = side > 0 ? '.L' : '.R';
  const parent = poseFK(out, `foreArm${suffix}`);
  const want = worldDir.clone().normalize().applyQuaternion(parent.rot.clone().invert());
  const turn = new THREE.Quaternion().setFromUnitVectors(BLADE_LOCAL, want);
  if (amount < 1) turn.slerp(IDENTITY_Q, 1 - amount);
  add(out, `hand${suffix}`, { q: turn });
}

/**
 * How much a rotation TWISTS about a given axis, as opposed to swinging away from it.
 *
 * The swing-twist decomposition: project the quaternion's vector part onto the axis and renormalise. This
 * is what separates "the arm turned to point somewhere else" from "the arm rolled about its own length",
 * and only the second one is a twist bone's business.
 */
export function twistAngle(q: THREE.Quaternion, axis: THREE.Vector3): number {
  // CANONICALISED FIRST. A quaternion and its negation are the same rotation, and `atan2` of the negated
  // pair differs by pi -- so a solver that happens to hand back the other sign makes the twist appear to
  // jump half a turn between adjacent frames. The gate caught it as a twist bone turning 61 mrad in one
  // frame while the joint it follows was moving smoothly.
  const w = q.w < 0 ? -q.w : q.w;
  const sign = q.w < 0 ? -1 : 1;
  const dot = sign * (q.x * axis.x + q.y * axis.y + q.z * axis.z);
  if (Math.abs(dot) < 1e-9 && w > 0.999999) return 0;
  return 2 * Math.atan2(dot, w);
}

/**
 * A joint's HINGE AXIS, taken from the rig rather than assumed.
 *
 * A hinge turns about the normal of the plane its own two bones lie in -- the elbow's axis is tilted well
 * off the body's medial-lateral line, and reading it as a body axis reports 40 degrees of abduction on a
 * pure elbow bend.
 *
 * THAT ONLY WORKS WHERE THERE IS A PLANE. This rig's thigh and shin are 1.35 degrees apart -- a nearly
 * straight leg -- so their cross product is numerical dust, and taking it anyway produced a knee axis
 * pointing along +Z. Measured against that, a correct knee bend read as 94 degrees off its own hinge. Ten
 * degrees of separation is the threshold for trusting the plane; below it the joint's axis is the
 * anatomical one, medial-lateral, which is also how this rig's knee was laid out.
 *
 * A ROLL BONE's axis is its own length by definition -- it exists to twist -- and its direction is nearly
 * parallel to its parent's, so the plane test would never trust it anyway.
 *
 * The sign is measured, not reasoned about: whichever way shortens the chain is the closing direction.
 */
export const hingeAxis = (() => {
  const cache = new Map<string, THREE.Vector3>();
  const dirOf = (name: string): THREE.Vector3 | null => {
    const b = BONE_SPECS.find((x) => x.name === name);
    if (!b) return null;
    return new THREE.Vector3(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]);
  };
  return (bone: string): THREE.Vector3 => {
    const hit = cache.get(bone);
    if (hit) return hit;
    const spec = BONE_SPECS.find((x) => x.name === bone);
    const own = dirOf(bone);
    const parent = spec?.parent ? dirOf(spec.parent) : null;
    let axis: THREE.Vector3;
    if (/Twist/.test(bone) && own) {
      axis = own.clone().normalize();
      cache.set(bone, axis);
      return axis;
    }
    const separated = own && parent
      && own.clone().normalize().angleTo(parent.clone().normalize()) > (10 * Math.PI) / 180;
    if (own && parent && separated) {
      axis = parent.clone().normalize().cross(own.clone().normalize()).normalize();
    } else {
      // The anatomical axis, which is also how this rig's knee was laid out.
      axis = new THREE.Vector3(1, 0, 0);
    }
    /**
     * THE SIGN IS MEASURED, for both branches.
     *
     * Applying it only where the plane was trusted left the fallback axis pointing whichever way the
     * medial-lateral convention says -- which flips by side, while this rig's channel convention does not.
     * The right knee then read as bending 96 degrees the WRONG way while bending correctly.
     */
    if (own && parent) {
      const reach = (a: number): number =>
        parent.clone().add(own.clone().applyAxisAngle(axis, a)).length();
      if (reach(0.4) > reach(-0.4)) axis.negate();
    }
    cache.set(bone, axis);
    return axis;
  };
})();

/**
 * What a joint has actually been asked to do, in terms its own anatomy can be checked against.
 *
 * For a HINGE: the angle about its own axis, and how much rotation is left over off that axis. For a BALL:
 * how far the bone has swung from rest (elevation), in which direction (azimuth: 0 forward, +pi/2 away from
 * the midline, pi back), and how much it has twisted about its own length.
 *
 * Elevation and azimuth rather than flexion and abduction, because those two stop being distinguishable at
 * the pole: with the arm straight up the sagittal projection is degenerate and an overhead reach reads as
 * 180 degrees of EXTENSION. A swing is one angle and a direction; that is well defined everywhere except
 * exactly at rest, where the direction does not matter because the angle is zero.
 */
export function jointState(bone: string, q: THREE.Quaternion, side: 1 | -1): {
  hinge: number; offAxis: number; elevation: number; azimuth: number; twist: number;
} {
  const spec = BONE_SPECS.find((x) => x.name === bone);
  const rest = spec
    ? new THREE.Vector3(spec.tail[0] - spec.head[0], spec.tail[1] - spec.head[1], spec.tail[2] - spec.head[2])
    : new THREE.Vector3(0, -1, 0);
  if (rest.lengthSq() < 1e-9) rest.set(0, -1, 0);
  const long = rest.clone().normalize();

  const axis = hingeAxis(bone);
  const hinge = twistAngle(q, axis);
  // Whatever is left once the hinge rotation is taken out.
  const residue = new THREE.Quaternion().setFromAxisAngle(axis, -hinge).premultiply(q);
  const offAxis = 2 * Math.acos(Math.min(1, Math.abs(residue.w)));

  const moved = long.clone().applyQuaternion(q);
  const elevation = Math.acos(Math.min(1, Math.max(-1, long.dot(moved))));
  // The swing's direction, measured in the plane across the bone: forward is +Z, outward is +X on the left.
  const forward = new THREE.Vector3(0, 0, 1);
  forward.sub(long.clone().multiplyScalar(forward.dot(long)));
  if (forward.lengthSq() < 1e-8) forward.set(1, 0, 0).sub(long.clone().multiplyScalar(long.x));
  forward.normalize();
  const outward = long.clone().cross(forward).multiplyScalar(side > 0 ? -1 : 1).normalize();
  const swing = moved.clone().sub(long.clone().multiplyScalar(long.dot(moved)));
  const azimuth = swing.lengthSq() < 1e-10 ? 0 : Math.atan2(swing.dot(outward), swing.dot(forward));
  return { hinge, offAxis, elevation, azimuth, twist: twistAngle(q, long) };
}

/**
 * Distribute the arm's roll along the limb, the way a forearm's two bones do.
 *
 * WHAT GOES WRONG WITHOUT IT. A forearm is a radius crossing an ulna: turning the palm over rotates the
 * wrist end while the elbow end stays where it is. Modelled as one rigid segment there is nowhere for that
 * to happen, so the entire rotation lands on the single joint and the skin shears across it -- a visible
 * crease at the wrist, and the same again at the shoulder, where the upper arm's roll otherwise twists the
 * deltoid at the joint rather than along the arm.
 *
 * Each twist bone takes HALF of the roll of the joint it serves. The shoulder's is a COUNTER-rotation,
 * because the upper arm has already rolled all of its own skin and the job is to give the half nearest the
 * shoulder less of it; the forearm's is a forward rotation, because the hand's roll has not reached the
 * forearm's skin at all.
 *
 * Called by `reachHand`, so every clip that solves an arm gets it without having to remember.
 */
export function applyArmTwist(out: Pose, side: 1 | -1, pronated = false): void {
  const suffix = side > 0 ? '.L' : '.R';
  const upperAxis = side > 0 ? ARM.restUpper.L : ARM.restUpper.R;
  const foreAxis = side > 0 ? ARM.restFore.L : ARM.restFore.R;

  const upperRoll = twistAngle(deltaQuaternion(out[`upperArm${suffix}`]), upperAxis);
  out[`upperArmTwist${suffix}`] = {
    q: new THREE.Quaternion().setFromAxisAngle(upperAxis, -0.5 * upperRoll),
  };
  // When the clip has asked for pronation it is already on this bone; do not overwrite it. Otherwise the
  // twist bone follows half of whatever roll the hand itself carries.
  if (!pronated) {
    const handRoll = twistAngle(deltaQuaternion(out[`hand${suffix}`]), foreAxis);
    out[`foreArmTwist${suffix}`] = {
      q: new THREE.Quaternion().setFromAxisAngle(foreAxis, 0.5 * handRoll),
    };
  }
}

/**
 * A hand target written the way a strike is actually thought about: a DIRECTION and how far out.
 *
 * WHY NOT ABSOLUTE COORDINATES, which is how these clips were first written. The thing that decides
 * whether an arm reads as firm or as a noodle is how EXTENDED it is, and in absolute coordinates that is
 * invisible -- it is the distance from a shoulder that is itself moving. Measured on the first pass, the
 * combat poses put the hand 320 to 400 mm from a 470 mm arm, which is a 99 degree elbow, and the pole then
 * swung that folded joint out into a loop 147 to 187 mm off the shoulder-to-wrist line. On screen that is
 * a rounded, boneless arm, and no amount of pole tuning fixes a hand placed too close to its own shoulder.
 *
 * `reach` is a fraction of full extension. 0.90 to 0.95 gives a 45 to 55 degree elbow -- a firm, carrying
 * arm; below about 0.85 the joint starts to fold; above 0.97 it approaches the singular pose where the
 * elbow angle stops being stable.
 */
export function handAt(side: 1 | -1, dir: [number, number, number], reach: number): [number, number, number] {
  const shoulder = BONE_SPECS.find((b) => b.name === (side > 0 ? 'upperArm.L' : 'upperArm.R'))!.head;
  const full = wristLocal(side, 0).length();
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const k = (reach * full) / len;
  return [shoulder[0] + dir[0] * k, shoulder[1] + dir[1] * k, shoulder[2] + dir[2] * k];
}

/**
 * A point written in the REST pose's coordinates, placed where the body has since moved it.
 *
 * A strike is authored relative to the body -- "up behind the right shoulder", "across to the left hip" --
 * and if it is authored in world coordinates instead, the torso's own rotation moves the shoulder out from
 * under it. Measured on a diagonal cut whose every knot was inside reach by 45 mm: the wind-up swung the
 * chest, the shoulder went with it, and the arm sat PINNED at the solver's extension clamp for 130 ms,
 * coming off it with 2.9 million rad/s^3 of jerk. Carrying the path with the chest removes the problem
 * rather than compensating for it, and it is also the more natural thing to author.
 */
export function bodyPoint(pose: Pose, restPoint: THREE.Vector3): THREE.Vector3 {
  const chest = poseFK(pose, 'chest');
  const rest = BONE_SPECS.find((b) => b.name === 'chest')!.head;
  return restPoint.clone()
    .sub(new THREE.Vector3(rest[0], rest[1], rest[2]))
    .applyQuaternion(chest.rot)
    .add(chest.pos);
}

/**
 * A path through space, smooth to the second derivative.
 *
 * WHY NOT KEYFRAMES WITH EASING BETWEEN THEM. Easing each leg of a path separately forces the hand to a
 * standstill at every key, because `ease` has zero slope at both ends -- so a strike stops dead in the
 * middle of its own arc. And WHY NOT CATMULL-ROM, the usual answer to that: it carries velocity through a
 * key but not curvature, so the acceleration steps at every knot, which is what the jerk gate exists to
 * catch. This is a natural cubic spline: continuous position, velocity AND acceleration everywhere, and
 * the only thing given up is that it does not pass through the keys with a preordained speed.
 *
 * Solved once, at construction, by the standard tridiagonal sweep.
 */
export class Path3 {
  private readonly t: number[];

  private readonly p: THREE.Vector3[];

  private readonly m: THREE.Vector3[];

  constructor(keys: Array<{ at: number; pos: [number, number, number] }>) {
    this.t = keys.map((k) => k.at);
    this.p = keys.map((k) => new THREE.Vector3(...k.pos));
    const n = keys.length;
    this.m = keys.map(() => new THREE.Vector3());
    if (n < 3) return;
    // Second derivatives at the knots, natural boundary (zero curvature at both ends).
    for (const axis of ['x', 'y', 'z'] as const) {
      const a = new Array<number>(n).fill(0);
      const b = new Array<number>(n).fill(1);
      const c = new Array<number>(n).fill(0);
      const d = new Array<number>(n).fill(0);
      for (let i = 1; i < n - 1; i += 1) {
        const h0 = this.t[i] - this.t[i - 1];
        const h1 = this.t[i + 1] - this.t[i];
        a[i] = h0;
        b[i] = 2 * (h0 + h1);
        c[i] = h1;
        d[i] = 6 * ((this.p[i + 1][axis] - this.p[i][axis]) / h1
          - (this.p[i][axis] - this.p[i - 1][axis]) / h0);
      }
      for (let i = 1; i < n; i += 1) {
        const w = a[i] / b[i - 1];
        b[i] -= w * c[i - 1];
        d[i] -= w * d[i - 1];
      }
      const x = new Array<number>(n).fill(0);
      x[n - 1] = d[n - 1] / b[n - 1];
      for (let i = n - 2; i >= 0; i -= 1) x[i] = (d[i] - c[i] * x[i + 1]) / b[i];
      for (let i = 0; i < n; i += 1) this.m[i][axis] = x[i];
    }
  }

  /**
   * A path whose knot TIMES come from how fast each leg should be travelled.
   *
   * Writing the times by hand is writing the speeds by hand in disguise, and badly: a natural spline
   * distributes curvature rather than speed, so an evenly-timed path with uneven legs runs the long ones
   * fast. Three attempts at a diagonal cut put its fastest hand in the wind-up rather than the strike --
   * 5.2 m/s, then 2.6, then 3.45 -- each time by moving one knot and hoping.
   *
   * Saying "the wind-up travels at 1.2 m/s and the cut at 3.5" is both what one actually means and
   * something the timing can be computed from. The spline still smooths across the knots, so the speeds
   * are close rather than exact, but they no longer come out in the wrong order.
   */
  static timed(legs: Array<{ pos: [number, number, number]; speed?: number }>): Path3 {
    const pts = legs.map((l) => new THREE.Vector3(...l.pos));
    const times = [0];
    for (let i = 1; i < pts.length; i += 1) {
      const chord = pts[i].distanceTo(pts[i - 1]);
      // A LEG MUST TAKE TIME, even one that goes nowhere. Two identical knots give a chord of zero, and a
      // zero-length interval divides by zero in the spline's own solve -- which produces NaN for the whole
      // curve, and a NaN target is silently ignored by the IK, so the arm simply never moves. That is a
      // hard failure that looks exactly like nothing happening.
      times.push(times[i - 1] + Math.max(chord / (legs[i].speed ?? 1), 1e-3));
    }
    const total = times[times.length - 1] || 1;
    return new Path3(legs.map((l, i) => ({ at: times[i] / total, pos: l.pos })));
  }

  at(time: number, into = new THREE.Vector3()): THREE.Vector3 {
    const n = this.t.length;
    if (n === 0) return into.set(0, 0, 0);
    if (time <= this.t[0]) return into.copy(this.p[0]);
    if (time >= this.t[n - 1]) return into.copy(this.p[n - 1]);
    let i = 0;
    while (i < n - 2 && time > this.t[i + 1]) i += 1;
    const h = this.t[i + 1] - this.t[i];
    const s = (time - this.t[i]) / h;
    for (const axis of ['x', 'y', 'z'] as const) {
      const a = this.p[i][axis];
      const b = this.p[i + 1][axis];
      const ma = this.m[i][axis];
      const mb = this.m[i + 1][axis];
      into[axis] = a * (1 - s) + b * s
        + ((h * h) / 6) * ((Math.pow(1 - s, 3) - (1 - s)) * ma + (Math.pow(s, 3) - s) * mb);
    }
    return into;
  }
}

/**
 * A strike's timing: gather slowly, go through fast, decelerate out.
 *
 * A symmetric ease spends as long leaving the impact as arriving at it, and that is what makes an authored
 * strike read as a wave rather than a blow. Real striking is asymmetric -- the wind-up is deliberate, the
 * strike itself is the fastest thing in the clip, and the follow-through bleeds off gradually because
 * something has to absorb the momentum.
 *
 * `sharp` is how much of the interval the strike itself occupies; the rest is deceleration.
 */
export function strikeCurve(t: number, sharp = 0.35): number {
  const x = clamp01(t);
  if (x < sharp) return ease(x / sharp) * 0.86;
  return 0.86 + 0.14 * ease((x - sharp) / (1 - sharp));
}

// ---- stage 1: the gait ----------------------------------------------------------------------------

export type Gait = {
  /** How far the planted contact point travels over one stance, in metres. */
  stride: number;
  /** Seconds for one full cycle: two steps. */
  cycle: number;
  /** Fraction of the cycle each foot is on the ground. 0.60 gives the normal 20% of double support. */
  stance: number;
  /** Peak clearance of the sole during the swing. */
  lift: number;
  /** Where in the swing that peak falls. Early, so the knee folds before the thigh comes through. */
  liftPeak: number;
};


/**
 * THE THREE ROCKERS, which are what makes a walk stop looking stiff.
 *
 * A foot does not sit flat on the ground for the whole of stance and then leave. It arrives on the heel
 * with the toe up, drops flat as the body rolls forward over the ankle, and then the heel lifts and the
 * body rolls over the ball of the foot before the toe leaves. Clinical gait analysis names them the heel,
 * ankle and forefoot rockers, and they run to roughly 10%, 30% and 60% of the cycle.
 *
 * The version before this held the sole flat and level for the whole of stance. Every measurement passed
 * -- the foot touched at exactly the sole plane, it never slid, support was 100% -- and it still read as
 * stiff, because a foot that never rolls is a foot on the end of a stilt. Worse, holding the ankle at
 * standing height for the whole of stance is what made the stride unreachable: with no heel rise there is
 * nothing to shorten the leg at the end of stance, so the pelvis had to be dropped 40 mm to compensate,
 * which put the figure in a permanent half-crouch.
 *
 * The rockers fix both at once. The pivot moves along the foot -- heel, then whole sole, then ball -- and
 * because the pivot is what stays planted, the ankle rises 23 mm and draws back 30 mm at push-off, all as
 * a consequence of the foot rotating rather than as a curve anyone authored.
 */
const HEEL_ROCKER_END = 0.17;      // fraction of stance: heel contact to foot flat
const FLAT_END = 0.50;             // fraction of stance: foot flat to heel rise
const CONTACT_PITCH = 0.10;        // toe up at heel strike
const TOE_OFF_PITCH = -0.40;       // heel high at push-off

/** The foot's pitch away from rest, through one stance. */
function stancePitch(s: number): number {
  if (s < HEEL_ROCKER_END) return CONTACT_PITCH * (1 - ease(s / HEEL_ROCKER_END));
  if (s < FLAT_END) return 0;
  return TOE_OFF_PITCH * ease((s - FLAT_END) / (1 - FLAT_END));
}

/**
 * The ankle and the foot pitch at a point in stance.
 *
 * The planted point travels backward at a constant speed for the whole of stance -- that is what "not
 * sliding" means for a walk in place -- and WHICH point it is changes at the rocker boundaries. The heel
 * carries it to foot-flat; from there the sole is down, so the ball is a fixed 111 mm ahead of the heel
 * and takes over without a step; from mid-stance the ball carries it to toe-off.
 */
function stanceFoot(s: number, gait: Gait): { y: number; z: number; pitch: number } {
  const travel = gait.stride * s;                    // how far the planted point has come back
  const pitch = stancePitch(s);
  const heelToBall = FOOT.ball.r * Math.sin(FOOT.ball.phi) - FOOT.heel.r * Math.sin(FOOT.heel.phi);
  /**
   * CENTRED ON THE HIP, not on the travel.
   *
   * Starting the heel at half a stride forward centres what the planted point DOES, which is not the same
   * thing: at mid-stance the ankle then sat 105 mm in front of the hip joint. Mid-stance is where the leg
   * has to be longest, and 105 mm of horizontal there is 105 mm that cannot be spent on vertical -- so it
   * was paid for out of the pelvis, as drop, as a permanently bent knee. Putting the ankle under the hip
   * at mid-stance hands that reach back.
   */
  const midFlat = (HEEL_ROCKER_END + FLAT_END) * 0.5;
  const heelStart = gait.stride * midFlat + LEG.hipOffsetL[2] - FOOT.heel.r * Math.sin(FOOT.heel.phi);
  if (s < FLAT_END) {
    return { ...ankleOver(heelStart - travel, FOOT.heel, pitch), pitch };
  }
  return { ...ankleOver(heelStart + heelToBall - travel, FOOT.ball, pitch), pitch };
}

/**
 * The ankle, the foot pitch, and whether it is planted, at cycle phase `u`.
 *
 * The swing is a quintic Hermite between the two ends of stance. Its end VELOCITIES are read off the
 * rocker formulas by finite difference rather than assumed to be the stride speed: the ankle does not
 * travel at the speed of the planted point during a rocker -- at push-off it is rising and drawing back
 * while the ball stays put -- so assuming otherwise would put a velocity step at toe-off. The end
 * ACCELERATIONS are zero, because a cubic that matches only velocity still arrives with acceleration to
 * spare, and that step was measured on the knee at 1927 rad/s^2.
 */
/**
 * A per-side variation on the swing, so the two legs are not identical.
 *
 * "Twinning" -- two limbs doing exactly the same thing at exactly opposite phases -- is the other thing
 * every walk-cycle guide warns about, and a procedural gait produces it by construction: the right leg was
 * the left leg's function evaluated half a cycle later, to the last decimal. The gait metric even confirmed
 * it, reporting that the two feet agreed on the ground's speed to 1 mm/s.
 *
 * The CONTACT must stay identical -- both feet are on the same floor, and a foot that travels at its own
 * speed is a foot that scuffs -- so the difference goes into the swing: how high the foot lifts and when it
 * peaks. Small enough to be felt rather than seen.
 */
export function swingBias(side: 1 | -1): { lift: number; peak: number } {
  return side > 0 ? { lift: 1, peak: 0 } : { lift: 0.93, peak: 0.03 };
}

export function gaitFoot(u: number, gait: Gait = WALK, side: 1 | -1 = 1): {
  y: number; z: number; pitch: number; planted: boolean;
} {
  if (u < gait.stance) {
    return { ...stanceFoot(u / gait.stance, gait), planted: true };
  }
  const k = (u - gait.stance) / (1 - gait.stance);
  const span = (1 - gait.stance) * gait.cycle;
  const bias = swingBias(side);
  const h = 1e-4;
  // State at toe-off and at the next heel strike, with the ankle's own velocity at each.
  const end = stanceFoot(1, gait);
  const endBack = stanceFoot(1 - h, gait);
  const start = stanceFoot(0, gait);
  const startFwd = stanceFoot(h, gait);
  const dt = h * gait.stance * gait.cycle;
  const v0 = { y: (end.y - endBack.y) / dt, z: (end.z - endBack.z) / dt };
  const v1 = { y: (startFwd.y - start.y) / dt, z: (startFwd.z - start.z) / dt };
  const k3 = k ** 3; const k4 = k ** 4; const k5 = k ** 5;
  const p0 = 1 - 10 * k3 + 15 * k4 - 6 * k5;
  const m0 = k - 6 * k3 + 8 * k4 - 3 * k5;
  const p1 = 10 * k3 - 15 * k4 + 6 * k5;
  const m1 = -4 * k3 + 7 * k4 - 3 * k5;
  const z = p0 * end.z + m0 * v0.z * span + p1 * start.z + m1 * v1.z * span;
  const y = p0 * end.y + m0 * v0.y * span + p1 * start.y + m1 * v1.y * span
    + gait.lift * bias.lift * skewBump(k, gait.liftPeak + bias.peak);
  return {
    y,
    z,
    // Dorsiflexes out of push-off and holds the toe up for the landing.
    pitch: lerp(TOE_OFF_PITCH, CONTACT_PITCH, ease(k)),
    planted: false,
  };
}


/**
 * How far the pelvis must sit below standing height for the gait to be reachable at every phase.
 *
 * DERIVED, not dialled in. Thigh and shin span 760 mm and the solver holds 8 mm back, so a stride that
 * needs more than that has to be paid for by lowering the pelvis -- and tuning the two independently
 * meant every change to the stride silently broke reachability again, which is how a foot ended up
 * clamped 8 mm off a floor it was supposed to be standing on. This is the smallest drop for which every
 * phase is inside reach with `reserve` of bend still in hand.
 *
 * The rockers do NOT earn it back, which is worth recording because it is the opposite of what I expected
 * when adding them. The heel rise shortens the leg at the END of stance, but the binding constraint is at
 * the START: at heel strike the foot is furthest forward AND the toe is up, which puts the ankle 219 mm
 * ahead of the hip and needs 739 mm of the 745 mm available. Measured drop for this gait: 37.9 mm, against
 * a 900 mm hip -- about 4%, which is roughly what a real pelvis does lower by when walking.
 */

// ---- the gait's derived constants -----------------------------------------------------------------
//
// AT THE END OF THE FILE, and that is load-bearing. This block runs at module initialisation and calls
// `gaitFoot`, which reads the rocker constants above it. Declared earlier, those constants were still in
// their temporal dead zone when this ran -- and the bundler having turned them into `var` meant no error,
// just `undefined`, arithmetic on it, and NaN propagated into every leg channel of every clip. Nothing
// reported anything: the gates measure joint angles, and NaN is not out of range.

/**
 * How much bend is left in the stance knee at its straightest, in radians.
 *
 * THIS IS THE NUMBER THAT DECIDES WHETHER A WALK LOOKS STIFF. The reserve the solver holds back from full
 * extension, plus the reserve the pelvis drop is derived with, together set it -- and at 15 mm and 8 mm
 * they set it to 18 degrees, measured. A knee that never comes inside 18 degrees of straight is a crouch:
 * the thigh has to stay forward to keep the ankle under the body, so the leg never trails, the stride
 * collapses to half scale, and every one of those is what "cứng" and "đơ" describe. Contact and continuity
 * were both perfect throughout.
 *
 * Real terminal stance is about 5 degrees. The knee angle is very sensitive near extension -- 5 degrees is
 * 0.6 mm short of straight -- so this settles at 10, which is close enough to read as a straight leg and
 * far enough from the singularity that the solver stays well behaved.
 */
export const STANCE_KNEE_MIN = 0.130;

/**
 * WHAT THE DEEPEST STANCE KNEE TURNED OUT TO BE, recorded because two guesses about it were wrong.
 *
 * The first guess was that the deepest bend is the crouch at mid-stance and that it grows with stride, so
 * the stride should be capped to keep it small. Measured, both halves are false. It grows as the stride
 * gets SHORTER -- 46 degrees at a 300 mm stride, 37 at 550 -- and it does not happen at mid-stance at all:
 * every measurement puts it at phase 0.49 to 0.51, the end of stance, where the heel has risen over the
 * ball and the ankle with it, shortening the leg. That is pre-swing, and a 35-42 degree knee there is what
 * a real gait does. So there is nothing to cap: the number is a consequence, and this constant is gone.
 *
 * The one that mattered was always the STRAIGHTEST knee. At 18 degrees the leg never straightened and the
 * walk read as a permanent crouch, which is what was reported. It is 7.4 now.
 */

/**
 * The pelvis, through a walk cycle. Part of the GAIT MODEL, not of the clip.
 *
 * It lives here because two things need it and they must not disagree: the clip, which writes it onto the
 * hips and hands it to the leg solver, and the stride derivation below, which has to know what the solver
 * will be told. The first version of that derivation carried its own closed-form copy of this -- world
 * coordinates, no pelvic rotation -- and the two disagreed by 26 degrees of knee: it reported a 10-degree
 * knee for a stride whose real minimum was 36. It ran to the end of its search range without noticing.
 *
 * Amplitudes are the clinical ones for level walking: about 4 degrees of transverse rotation, 4 of
 * obliquity, and a rise twice per cycle.
 */
/**
 * The body's height through a step, as a curve that DWELLS rather than a cosine that does not.
 *
 * A cosine spends its time evenly, and even spacing is the thing every walk-cycle guide warns about: it is
 * what makes a cycle read as a machine. A real walk holds at two moments -- weight acceptance, when the
 * body has just landed and sinks onto the leading leg, and mid-stance, when it is balanced at the top of
 * the arc -- and moves quickly between them. That hold is the "moment of pause" a walk needs to look like
 * someone deciding to take a step rather than a mechanism completing one.
 *
 * `bump` is flat in value, slope AND curvature at both ends and at its peak, so building the curve out of
 * it puts the dwell at the extremes and the speed in the transitions, with nothing to kink.
 *
 * +1 is the lowest point of the step and -1 the highest.
 */
export function bobShape(u: number, phase = WALK_BOB_PHASE): number {
  const step = (((u - phase) * 2) % 1 + 1) % 1;
  return 1 - 2 * bump(step);
}

/**
 * THE STANCE KNEE, AUTHORED -- and the pelvis derived from it, which is the way round a body works.
 *
 * It was the other way round and that is why the walk read as a crouch. The pelvis had a hand-shaped rise
 * plus a constant drop solved for reachability, and the knee got whatever was left: measured, 21 degrees at
 * heel strike where a body has 0 to 8, a loading peak of 46 where a body has 15 to 22, and never straighter
 * than 16 anywhere in stance.
 *
 * The insight the numbers forced: a walking pelvis does not rise and fall because the knee extends and
 * flexes. It rises and falls because the leg PIVOTS about the planted foot -- a compass -- so the hip's
 * height is the leg's length times the cosine of its inclination. Get that profile right and the knee is
 * free to do what a knee does. Get it wrong by even a centimetre and the knee pays for the difference at
 * about four degrees a millimetre.
 *
 * These are the clinical figures for a free-speed walk: nearly straight at contact, a loading peak as the
 * body accepts its weight, straight again through mid and terminal stance, and then the fast fold into
 * pre-swing.
 */
function stanceKneeTarget(s: number): number {
  /**
   * The floor of 0.10 rad is the SOLVER's, not anatomy's: it holds the wrist and the ankle a little short of
   * full extension, so asking for a knee straighter than about six degrees asks for a leg longer than the rig
   * will make. Left at four degrees the derivation over-reached by a millimetre at every stride it tried --
   * `stanceKneeRange` reported a negative straightest, which is the signature of a leg pinned at its limit
   * rather than a leg that is straight.
   */
  const KEYS: Array<[number, number]> = [
    [0.00, 0.11],   // heel strike, 6 deg
    [0.20, 0.31],   // loading response, 18 deg
    [0.45, 0.11],   // mid-stance, 6 deg
    [0.78, 0.10],   // terminal stance, 6 deg
    [1.00, 0.73],   // toe-off, 42 deg -- the fold into swing has already begun
  ];
  for (let i = 1; i < KEYS.length; i += 1) {
    const [u0, v0] = KEYS[i - 1];
    const [u1, v1] = KEYS[i];
    if (s <= u1) return lerp(v0, v1, ease((s - u0) / (u1 - u0)));
  }
  return KEYS[KEYS.length - 1][1];
}

/** How far the ankle is from the hip when the knee is flexed by `knee`. */
function hipToAnkle(knee: number): number {
  const a = LEG.thigh;
  const b = LEG.shin;
  return Math.sqrt(a * a + b * b + 2 * a * b * Math.cos(knee));
}

/**
 * The pelvis's height through the cycle, DERIVED: at every phase, low enough that whichever planted leg
 * needs it most gets the knee it was asked for.
 *
 * The minimum over the legs in stance, not the average: during double support both feet are down, and a
 * pelvis higher than either leg can reach is a foot pulled off the floor.
 *
 * Fitted to a few harmonics rather than sampled and interpolated. The raw profile has a corner wherever the
 * binding leg changes -- twice a cycle -- and a corner in the pelvis is a kink in every joint below it. A
 * periodic fit is smooth to every order by construction, it cannot fail to close the loop, and it rounds
 * exactly the corners that should be rounded: a real pelvis does not change direction instantly either.
 */
const PELVIS_HARMONICS = 10;

/** The straightest this rig's solver will make a leg. The ceiling a trailing foot imposes, and no more. */
const STANCE_KNEE_FLOOR = 0.11;

/**
 * How far the pelvis must sit below standing for ONE planted leg to have the knee it was asked for.
 *
 * Solved through `pelvisTarget`, which is the same function the clip's leg solve uses, and with the same
 * lateral ankle placement. Deriving it in the sagittal plane instead -- ignoring the 25 mm of lateral sway
 * and the 50 mm the ankles track inside the hips -- looked like a rounding error and was not: the hip-to-
 * ankle distance it left out is about 2 mm, and 2 mm within a few millimetres of full extension is eight
 * degrees of knee. The loading peak came out at 38 degrees against the 18 the profile was built to produce.
 *
 * Bisected rather than inverted because `pelvisTarget` composes three rotations about a moving pivot; the
 * distance is monotone in the height, which is all a bisection needs.
 */
export function heightForKnee(gait: Gait, phase: number, knee?: number): number {
  const foot = stanceFoot(phase / gait.stance, gait);
  const want = hipToAnkle(knee ?? stanceKneeTarget(phase / gait.stance));
  const sway = pelvisSway(phase);
  /**
   * THE SAME ARITHMETIC `plantFoot` USES, including the part that is easy to leave out.
   *
   * A leg reaching to a point beside its own hip spends some of its length sideways: `plantFoot` absorbs that
   * with hip adduction and hands the solver a SHORTENED sagittal target, `sqrt(span^2 - x0^2)`. Deriving the
   * height against `pelvisTarget` alone -- which solves in the leg's plane and knows nothing about the
   * adduction -- left that out, and left out is where the loading knee's extra twenty degrees came from.
   */
  const reach = (ty: number): number => {
    const local = intoPelvisFrame({ ...sway, ty }, scratchFoot.set(STANCE_HALF, foot.y, foot.z));
    const dx = local.x - LEG.hipOffsetL[0];
    const dy = local.y - LEG.hipOffsetL[1];
    const dz = local.z - LEG.hipOffsetL[2];
    const x0 = LEG.footXL - LEG.hipOffsetL[0];
    const span = Math.hypot(dx, dy);
    const yPrime = -Math.sqrt(Math.max(1e-6, span * span - x0 * x0));
    return Math.hypot(yPrime, dz);
  };
  let lo = -0.30;
  let hi = 0.05;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) * 0.5;
    if (reach(mid) > want) hi = mid; else lo = mid;
  }
  return (lo + hi) * 0.5;
}

function fitPelvisY(gait: Gait): { mean: number; cos: number[]; sin: number[] } {
  const N = 720;
  const raw = new Float64Array(N);
  for (let i = 0; i < N; i += 1) {
    const u = i / N;
    /**
     * THE LEADING LEG DECIDES, and the trailing one only sets a ceiling. Taking the lower of the two was
     * wrong and it was wrong in a way that showed: in double support the trailing leg's knee is already
     * folding for the swing -- 31 degrees by the end -- and a folded leg wants a low pelvis to keep its foot
     * on the floor. So the requirement dived to -56 mm twice a cycle, and the loading knee inherited it at
     * 39 degrees against the 18 the profile asks for.
     *
     * But a trailing foot in pre-swing is UNLOADING. It is not carrying anything; it only has to still reach
     * the ground, which is a ceiling on the pelvis (a straight leg's height), not a demand for a low one. The
     * leg that is accepting weight is the one whose knee has to be right.
     *
     * The two legs are each other mirrored half a cycle apart, and so is the sway, so one leg's phase
     * evaluated at both places gives both legs.
     */
    const a = u;
    const b = (u + 0.5) % 1;
    const aIn = a < gait.stance;
    const bIn = b < gait.stance;
    let want: number;
    if (aIn && bIn) {
      const lead = a < b ? a : b;
      const trail = a < b ? b : a;
      /**
       * AND THE TRAILING FOOT'S CEILING RELAXES AS IT UNLOADS, which is what removed the last corner.
       *
       * Held at full strength, that ceiling drove the pelvis to -67.7 mm at u = 0.075 and then released it
       * to -30.5 mm at u = 0.100 when the foot came off -- a 37 mm STEP in the requirement, twice a cycle.
       * No smooth periodic curve follows a step, so the fit split the difference and the loading knee
       * inherited the error at 36 degrees against 18.
       *
       * The step is an artefact of pretending a foot is planted right up to the instant it leaves. A real
       * toe-off is progressive: by the last sixth of stance the heel is long gone, the knee is folding for
       * the swing, and the foot is carrying almost nothing. So the ceiling fades out over that stretch
       * instead of ending, and there is nothing left to step.
       */
      const sTrail = trail / gait.stance;
      const unload = ease((sTrail - 0.74) / 0.26);
      const target = heightForKnee(gait, trail);
      const straight = heightForKnee(gait, trail, STANCE_KNEE_FLOOR);
      // The ceiling relaxes from the knee this leg WANTS towards the straightest it can manage, and no
      // further. Relaxed without that bound -- the first attempt added a flat 250 mm -- it let the pelvis sit
      // above what the trailing leg can reach at all, so the foot was already off the floor when the swing
      // began and the swing's own clearance snatched it up: `foot.R` turned 172 mrad in one frame at u = 0.10,
      // 87,925 rad/s^2, out of curves that were smooth on both sides of it.
      want = softMin(heightForKnee(gait, lead), lerp(target, straight, unload), 0.003);
    } else if (aIn) {
      want = heightForKnee(gait, a);
    } else if (bIn) {
      want = heightForKnee(gait, b);
    } else {
      want = 0;
    }
    raw[i] = want;
  }
  const cos: number[] = [];
  const sin: number[] = [];
  let mean = 0;
  for (let i = 0; i < N; i += 1) mean += raw[i];
  mean /= N;
  for (let h = 1; h <= PELVIS_HARMONICS; h += 1) {
    let c = 0;
    let d = 0;
    for (let i = 0; i < N; i += 1) {
      const a = (TAU * h * i) / N;
      c += raw[i] * Math.cos(a);
      d += raw[i] * Math.sin(a);
    }
    cos.push((2 * c) / N);
    sin.push((2 * d) / N);
  }
  const fit = { mean, cos, sin };
  /**
   * AND THEN LOWERED, BY ONE CONSTANT, UNTIL THE SWING FITS TOO.
   *
   * The shape comes from stance, where the geometry is real. The swing then has to be reachable as well, and
   * it is the harder end: its quintic leaves and arrives travelling backward, so it bulges about 30 mm past
   * the stride at both ends and the leg is momentarily longer there than any stance phase asks for.
   *
   * Lifting the foot to absorb that was tried three ways and each one put a kink where the lift began or
   * ended -- 126 million rad/s^3, then 7.7 million, then 1.3 million, against the 36,000 that curves believed
   * smooth produce here. The lift has to switch off at the ends of the swing, where the stance pose already
   * decides the height, and every window smooth enough to hide the switch was still only C2, which is exactly
   * one derivative short of what a jerk bound measures.
   *
   * A constant cannot kink. It costs a few millimetres of pelvis height everywhere instead of a few
   * centimetres of foot height somewhere, and it is the whole of what the original derivation was doing --
   * the mistake was never the constant, it was deriving the SHAPE from a bell instead of from the legs.
   */
  return fit;
}


/**
 * How far each ankle tracks from the centre line. Here rather than in the clip, because the pelvis's height
 * is derived against it: a leg reaching 50 mm inside its own hip is a longer leg than one reaching straight
 * down, and the derivation has to know that.
 */
export const STANCE_HALF = 0.050;

const scratchFoot = new THREE.Vector3();

function pelvisYAt(fit: { mean: number; cos: number[]; sin: number[] }, u: number): number {
  let y = fit.mean;
  for (let h = 1; h <= fit.cos.length; h += 1) {
    y += fit.cos[h - 1] * Math.cos(TAU * h * u) + fit.sin[h - 1] * Math.sin(TAU * h * u);
  }
  return y;
}

/**
 * Everything the pelvis does EXCEPT its height. Split out because the height is derived from these: the
 * sway and the rotations move the hip relative to the planted foot, so they have to be known before the
 * height that makes the leg fit can be solved for.
 */
export function pelvisSway(u: number): PelvisState {
  return {
    ty: 0,
    // The lateral sway, the obliquity and the transverse rotation together are what a walk's hips DO, and
    // they are what carries a figure's weight from one leg to the other. Held small, a walk reads as
    // careful; these are at the confident end of the clinical range rather than the middle of it.
    // 25 mm each way. It was 30, which put the lateral excursion at 60 mm against a body's 30 to 50, and
    // with the vertical excursion now larger there is more than enough movement without it.
    tx: 0.025 * Math.sin(u * TAU),
    // MOVED UP INSIDE THE CLINICAL BAND, not past it. Transverse rotation runs 8 to 16 degrees over a cycle
    // and obliquity 8 to 12; these were at 8.7 and 8.6, the very bottom of both. The hips carrying the weight
    // across is what a walk's lower body reads as, and at the bottom of the range it reads as careful.
    ry: 0.105 * Math.sin(u * TAU),
    rz: 0.095 * Math.sin(u * TAU),
    rx: 0.018 * Math.cos(2 * u * TAU),
  };
}

export function walkPelvis(u: number): PelvisState {
  return { ...pelvisSway(u), ty: pelvisYAt(WALK_PELVIS, u) };
}

/**
 * The stance knee's two extremes over a cycle: how straight it gets, and how bent.
 *
 * Solved with `pelvisTarget` and `solveLeg`'s own geometry -- the same pair the clip uses -- so what this
 * measures and what the animation does cannot drift apart. An earlier version of this carried its own
 * closed-form copy, in world coordinates and without the pelvic rotations, and the two disagreed by 26
 * degrees of knee.
 *
 * A NEGATIVE `straightest` means the leg was asked to reach FURTHER than it can, and the value is how much
 * further. That distinction is the whole reason this returns two numbers: the previous version clamped an
 * over-extended leg to "0 degrees of flexion", which reads as a beautifully straight leg and is in fact a
 * solver pinned against its limit. A search that could not tell those apart walked straight past every
 * usable stride and settled on one 70% too long.
 */
export function stanceKneeRange(
  gait: Gait, fit: { mean: number; cos: number[]; sin: number[] } = WALK_PELVIS,
): { straightest: number; deepest: number; deepestAt: number } {
  const span = LEG.thigh + LEG.shin;
  let straightest = Infinity;
  let deepest = -Infinity;
  let deepestAt = 0;
  for (let i = 0; i < 240; i += 1) {
    const u = (i / 240) * gait.stance;
    const foot = gaitFoot(u, gait);
    const local = pelvisTarget({ ...pelvisSway(u), ty: pelvisYAt(fit, u) }, LEG.footXL, foot.y, foot.z);
    const d = Math.hypot(local.y - LEG.hipOffsetL[1], local.z - LEG.hipOffsetL[2]);
    if (d >= span) { straightest = Math.min(straightest, span - d); continue; }
    // READ FROM THE SOLVER, not from the distance. The solver holds `IK_REACH_RESERVE` back from full
    // extension, so a distance of 756 mm does not produce the 7-degree knee the triangle says it should:
    // it produces whatever the solver's own limit allows. Computing it here independently is how the
    // derivation came to believe in a knee the rig was never going to make.
    const flex = solveLeg(LEG.hipOffsetL[1], LEG.hipOffsetL[2], local.y, local.z).shinRx;
    straightest = Math.min(straightest, flex);
    if (flex > deepest) { deepest = flex; deepestAt = u; }
  }
  return { straightest, deepest, deepestAt };
}


/**
 * How late in the cycle the pelvis is at its lowest, as a fraction of it.
 *
 * Zero puts the lowest point exactly at heel strike. A real pelvis keeps descending for the first tenth of
 * the cycle -- loading response, the body absorbing its own weight over the leg that has just landed -- and
 * that descent is what flexes the stance knee into its first of two peaks. Without the shift the knee has
 * only the swing peak, and a gait with one knee peak per cycle is a gait that lands rigid.
 */
export const WALK_BOB_PHASE = 0.10;

/**
 * How far the leg leans, forward and back, over one stance.
 *
 * The angle of the hip-to-ankle LINE, not a joint channel. A channel needs a sign convention and this rig's
 * is not the one a clinical hip angle uses: capping `thighRx` capped extension where flexion was meant, and
 * the derivation collapsed the stride to 660 mm with one degree of hip extension. An inclination has no
 * convention to get wrong -- forward is forward -- and it bounds the step directly, since the step IS twice
 * the leg's length times the sine of it.
 */
function legLean(gait: Gait, fit: { mean: number; cos: number[]; sin: number[] }): {
  forward: number; back: number;
} {
  let forward = -Infinity;
  let back = -Infinity;
  for (let i = 0; i <= 240; i += 1) {
    const u = (i / 240) * gait.stance;
    const foot = stanceFoot(u / gait.stance, gait);
    const local = intoPelvisFrame(
      { ...pelvisSway(u), ty: pelvisYAt(fit, u) },
      scratchFoot.set(STANCE_HALF, foot.y, foot.z),
    );
    const dy = LEG.hipOffsetL[1] - local.y;
    const dz = local.z - LEG.hipOffsetL[2];
    const lean = Math.atan2(dz, Math.max(1e-6, dy));
    forward = Math.max(forward, lean);
    back = Math.max(back, -lean);
  }
  return { forward, back };
}

/**
 * THE STRIDE, chosen by what the pelvis has to do to keep the knee honest.
 *
 * With the knee authored and the pelvis derived from it, the stride has exactly one cost: how far the pelvis
 * must travel vertically. That is the compass again -- a longer step means a more inclined leg at the ends of
 * stance, and a more inclined leg means a lower hip. A body keeps that excursion to 30 to 45 mm, and it can
 * afford a longer step for the same excursion than this character can because its FOOT is longer: the ankle
 * rises over a real heel and a real forefoot by 25 mm at each end of stance, which flattens the arc. This
 * rig's boot is 111 mm from heel to toe, so it earns back almost none of that, and the excursion is close to
 * the raw compass figure.
 *
 * So the stride is the largest one whose derived pelvis stays inside a body's vertical excursion. Everything
 * else follows and nothing is dialled.
 */
const PELVIS_EXCURSION_MAX = 0.062;
/**
 * How far the leg may lean either way at the ends of stance: 27 degrees.
 *
 * This is the anatomy that bounds a step, and it bounds it exactly -- the ankle's travel over stance is twice
 * the leg's length times the sine of this.
 *
 * 23 degrees, and the number came from the joint gate rather than from a table. A leg leaning further than
 * this carries the THIGH past the 20 degrees of extension `anatomy.ts` allows a hip: at 27 degrees of lean
 * the walk measured 24 to 25 at the joint. The lean is what got shortened, not the hip's limit.
 */
const LEG_LEAN_MAX = 0.40;
/** How bent the stance knee may be at its straightest. Past this a walk reads as a crouch. */
const STANCE_KNEE_LIMIT = 0.22;

const GAIT_SOLUTION = (() => {
  // liftPeak 0.26 of the swing puts peak knee flexion at phase 0.72 of the cycle, ten to fifteen percent
  // ahead of peak hip flexion, which is the separation a real gait has.
  /**
   * `lift` shapes the KNEE's fold, not the foot's clearance -- which is worth recording, because it reads the
   * other way round. The clearance is set by the derived floor below: the leg has to stay inside its own
   * reach through the swing, and at this stride that holds the toe about 45 mm up at its lowest, above the 10
   * to 30 mm a body clears. Reducing `lift` does not lower the foot at all; it only unfolds the knee, and at
   * 70 mm the swing peak fell to 53 degrees against a body's 58 to 68. So it stays where the knee wants it.
   */
  const base = { cycle: 1.00, stance: 0.60, lift: 0.092, liftPeak: 0.26 };
  const excursionOf = (stride: number): { span: number; fit: ReturnType<typeof fitPelvisY> } => {
    const fit = fitPelvisY({ ...base, stride });
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 720; i += 1) {
      const y = pelvisYAt(fit, i / 720);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    return { span: hi - lo, fit };
  };
  /**
   * THREE CONSTRAINTS, and which one binds depends on the rig.
   *
   * The pelvis's vertical travel is the compass cost of a longer step. The HIP'S OWN RANGE is anatomy: a
   * walking hip flexes about 30 degrees and extends about 20, and with the corner in the pelvis profile
   * removed the excursion cap alone let the stride run to 1.95 leg lengths -- 41 degrees of flexion and 38 of
   * extension, which is not a walk, it is a racewalk. The hip is what binds now.
   */
  const tooFar = (stride: number): boolean => {
    const { span, fit } = excursionOf(stride);
    if (span > PELVIS_EXCURSION_MAX) return true;
    const lean = legLean({ ...base, stride }, fit);
    if (lean.forward > LEG_LEAN_MAX || lean.back > LEG_LEAN_MAX) return true;
    // AND THE STANCE KNEE, which is what the constant above is spent on. Every millimetre the pelvis drops
    // to make the swing reachable is about a degree of knee it never gets back, so this is the constraint
    // that actually decides the step length on this rig.
    return stanceKneeRange({ ...base, stride }, fit).straightest > STANCE_KNEE_LIMIT;
  };
  let lo = 0.30;
  let hi = 1.20;
  for (let i = 0; i < 34; i += 1) {
    const mid = (lo + hi) * 0.5;
    if (tooFar(mid)) hi = mid; else lo = mid;
  }
  const fit = excursionOf(lo).fit;
  return { gait: { ...base, stride: lo }, fit };
})();

export const WALK: Gait = GAIT_SOLUTION.gait;
/** The pelvis's own vertical path, as a periodic fit. Read through `walkPelvis`. */
const WALK_PELVIS = GAIT_SOLUTION.fit;
