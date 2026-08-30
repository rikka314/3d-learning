import * as THREE from 'three';
import { BONE_SPECS } from './skeleton';

/**
 * How a body changes from one action to another.
 *
 * WHAT WAS HERE BEFORE, AND WHY IT IS NOT. A cross-fade interpolates between two poses that are BOTH still
 * moving, and every interpolation between two moving endpoints has to keep re-deciding which way to go. Four
 * separate failures came out of that, all of them one-frame steps in the middle of curves with nothing wrong
 * with them:
 *
 *   A quaternion slerp re-picks the shorter way round on every call. Two shoulder poses in `slash` ->
 *   `spin-slash` drift through 179.8 degrees apart, the dot product crosses zero, the direction flips, and
 *   the joint moved 1.15 rad in one frame -- 138 rad/s, where nothing else in that transition passed 17.
 *
 *   Holding the direction instead sent it the long way round, putting 159 degrees of twist through a
 *   shoulder that has 90.
 *
 *   Interpolating the hand's PLACE dragged the wrist along a line passing 268 mm from the shoulder, where
 *   the arm is folded almost to its 230 mm minimum, so the arm collapsed into the chest and opened out
 *   again -- 40 rad/s at the shoulder.
 *
 *   Interpolating the arm's own azimuth has the same re-decision on a circle, and it flipped too: 86 degrees
 *   in one frame, 20,831 rad/s^2.
 *
 * None of those is a tuning problem and none belongs to a particular clip. So nothing here interpolates
 * between two poses. At the instant of the switch, the difference between where the body IS and where the
 * incoming clip WANTS it is measured once -- a pose offset and a velocity offset -- and from then on the
 * body plays the incoming clip with that offset decaying to nothing. One endpoint instead of two; a fixed
 * offset, so there is no path left to re-decide; and because the velocity offset is measured too, the body
 * leaves its previous motion at exactly the speed it was already moving at.
 */

/**
 * COMFORTABLE TRANSITION SPEED, rad/s, per joint family.
 *
 * Not peak speed. A joint's peak is what it reaches in a strike or a throw -- a shoulder does about 20 rad/s
 * -- and a transition is not a strike, it is a deliberate repositioning: roughly half. The ordering is what
 * matters and it is anatomy, not taste: a wrist repositions faster than a shoulder because it moves far less
 * mass, and a trunk is the slowest thing on a body.
 */
const TRANSITION_SPEED: Record<string, number> = {
  hips: 4, spine: 4, chest: 4.5, neck: 5, head: 5,
  shoulder: 5, upperArm: 8, foreArm: 10, hand: 12,
  upperArmTwist: 8, foreArmTwist: 10,
  thigh: 5, shin: 8, foot: 6, toe: 7,
  jaw: 6, lipCorner: 6, eyelid: 15, ponytail: 7, cloth: 7,
};

/**
 * PEAK FUNCTIONAL SPEED, rad/s -- the fastest that joint goes in the fastest thing a body does with it,
 * which is the ceiling nothing may cross. A transition may approach it briefly; it may not exceed what the
 * body can do.
 *
 * The leg numbers are the two that had to be corrected, and the correction came from asking what the FASTEST
 * movement of each joint is rather than the fastest movement in these six clips. A knee's is not a jump, it
 * is a kick -- the shank comes through at 1500 to 2000 deg/s, which is 26 to 35 rad/s -- so 17 was the speed
 * of a jump takeoff, not of a knee, and it made this clip library's own perfectly ordinary takeoff (16.6
 * rad/s) sit 0.4 rad/s under a ceiling it should not have been anywhere near. A hip's fastest is a sprint's
 * recovery swing at about 12.
 */
const PEAK_SPEED: Record<string, number> = {
  hips: 8, spine: 8, chest: 9, neck: 10, head: 10,
  shoulder: 12, upperArm: 20, foreArm: 25, hand: 30,
  upperArmTwist: 20, foreArmTwist: 25,
  thigh: 12, shin: 26, foot: 12, toe: 14,
  jaw: 12, lipCorner: 12, eyelid: 30, ponytail: 14, cloth: 14,
};

/** Strip a bone name down to its family: `foreArmTwist.L` -> `foreArmTwist`, `cloth.F.2` -> `cloth`. */
export const familyOf = (bone: string): string =>
  bone.replace(/\.[LR]$/, '').replace(/\.[FBLR]\.[0-9]+$/, '').replace(/\.[0-9]+$/, '');

const speedOf = (bone: string): number => TRANSITION_SPEED[familyOf(bone)] ?? 6;
const peakOf = (bone: string): number => PEAK_SPEED[familyOf(bone)] ?? 12;

/** The ceiling for a joint, for anything that needs to check against it. One table, one source. */
export const peakSpeedOf = peakOf;

/** Aim this far under the peak, because the headroom estimate is sampled rather than exact. */
const SAFETY = 0.85;

/**
 * DEPTH FROM THE PELVIS, normalised to 0..1.
 *
 * Used to stagger the settle and to decide which joints overshoot. A body changing action commits from the
 * ground up and the centre out: the pelvis and legs take the weight first because they have to, the trunk
 * follows, the hands are last, and anything hanging -- hair, cloth -- is later still. Graph depth says
 * exactly that without a table to maintain, and it stays right when a bone is added.
 */
const DEPTH = ((): Record<string, number> => {
  const parent: Record<string, string | null> = {};
  for (const spec of BONE_SPECS) parent[spec.name] = spec.parent ?? null;
  const depth: Record<string, number> = {};
  const walk = (name: string): number => {
    if (depth[name] !== undefined) return depth[name];
    const p = parent[name];
    depth[name] = p ? walk(p) + 1 : 0;
    return depth[name];
  };
  for (const spec of BONE_SPECS) walk(spec.name);
  const max = Math.max(...Object.values(depth));
  const out: Record<string, number> = {};
  for (const [name, d] of Object.entries(depth)) out[name] = d / max;
  return out;
})();

/** 0 for the pelvis, 1 for the furthest tip of the longest chain. */
export const depthOf = (bone: string): number => DEPTH[bone] ?? 0.5;

/**
 * DAMPING. Critically damped by default -- it arrives and stops, without a wobble.
 *
 * The distal joints are given slightly less than critical, which is the overshoot-and-settle a limb has from
 * its own momentum, and the pelvis is given none of it. That is the same asymmetry as the stagger and it has
 * the same reason: momentum belongs to the far end of a chain.
 */
export const dampingOf = (bone: string): number => 1 - 0.16 * depthOf(bone);

/**
 * HOW FAST AN OFFSET DECAYS, as the spring's natural frequency.
 *
 * A critically damped spring is within about a percent of home after 4.6 / lambda seconds, so lambda follows
 * from the settle time the speed law asks for. The stagger is here too: a proximal joint settles in the time
 * asked for and the most distal takes half again as long, so the pelvis arrives first and the hands last
 * without anything needing to be delayed or sequenced.
 */
export const rateOf = (bone: string, settle: number): number =>
  4.6 / (settle * (1 + 0.5 * depthOf(bone)));

/**
 * One step of a damped spring pulling an offset back to zero.
 *
 * Semi-implicit rather than explicit: an explicit step of a stiff spring gains energy when the step is
 * large, and `dt` here is a browser frame. The whole value of this being a spring is that a long frame
 * cannot make it explode. `v` is updated in place; the new offset is returned.
 */
export function stepSpring(
  x: number, v: { value: number }, lambda: number, zeta: number, dt: number,
): number {
  v.value += (-2 * zeta * lambda * v.value - lambda * lambda * x) * dt;
  return x + v.value * dt;
}

/**
 * THE FASTEST THE DECAY EVER MOVES A JOINT, as a multiple of offset over settle time.
 *
 * The correction that made the speed law work, and its absence is what the measurement caught: dividing a
 * distance by a speed bounds the AVERAGE rate, and an average is not what an eye sees. A critically damped
 * spring released from rest peaks at lambda/e of its offset, which with lambda = 4.6 / settle is about 1.7
 * offsets per settle time; the lighter damping on the distal joints lifts it a little further. Measured on a
 * real transition before this was accounted for: 66 degrees over a 0.19 s window is 6.1 rad/s on average and
 * the shoulder reached 13.7.
 */
function peakRate(bone: string): number {
  const SAMPLES = 480;
  const lambda = rateOf(bone, 1);
  const zeta = dampingOf(bone);
  const dt = 2 / SAMPLES;
  const v = { value: 0 };
  let x = 1;
  let peak = 0;
  for (let i = 0; i < SAMPLES; i += 1) {
    x = stepSpring(x, v, lambda, zeta, dt);
    if (Math.abs(v.value) > peak) peak = Math.abs(v.value);
  }
  return peak;
}

const PEAK_RATE = new Map<string, number>();
const peakRateOf = (bone: string): number => {
  let cached = PEAK_RATE.get(bone);
  if (cached === undefined) {
    cached = peakRate(bone);
    PEAK_RATE.set(bone, cached);
  }
  return cached;
};

/**
 * How long the change should take.
 *
 * Two constraints per joint, and the answer is the largest demand any joint makes -- a transition is over
 * when the LAST joint has arrived, so the max, not the mean.
 *
 *   The average rate must sit at the speed that joint repositions itself at comfortably.
 *   The PEAK rate must stay under what that joint can physically reach -- and the decay is not the only
 *   thing moving it. The incoming clip is playing underneath, so what is left for the decay is the peak
 *   minus whatever the clip is already doing. Ignoring that term is what let a shoulder reach 25.5 rad/s
 *   where its own clips never passed 17.
 *
 * The clamp is at both ends: below about a sixth of a second nothing reads as a movement at all, and past
 * six tenths a change of action reads as indecision.
 *
 * @param offset per-bone size of the offset to be decayed, radians
 * @param busy per-bone rate, rad/s, the clip itself contributes while the offset is decaying
 */
export function settleTime(offset: Map<string, number>, busy: Map<string, number>): number {
  let worst = 0.16;
  for (const [name, distance] of offset) {
    if (distance < 1e-4) continue;
    const peak = peakOf(name);
    // Never let the reserved headroom eat the whole budget: a joint the clip is already driving hard still
    // has to be able to change over.
    const budget = Math.max(0.3 * peak, peak - (busy.get(name) ?? 0));
    const need = Math.max(
      distance / speedOf(name),
      (distance * peakRateOf(name)) / (SAFETY * budget),
    );
    if (need > worst) worst = need;
  }
  return Math.min(0.6, worst);
}

/** Unsigned angle between two rotations, radians. Sign-agnostic: q and -q are the same rotation. */
export function angleBetween(a: THREE.Quaternion, b: THREE.Quaternion): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, dot));
}

/**
 * A rotation as a vector along its own axis, length equal to its angle. The offset a spring can act on.
 *
 * Canonicalised to the shorter of the two representations, because q and -q are the same rotation but their
 * logarithms differ by a full turn, and a spring pulling a 2 pi offset to zero would spin the joint all the
 * way round to arrive where it already was.
 */
export function rotationVector(out: THREE.Vector3, q: THREE.Quaternion): THREE.Vector3 {
  const w = q.w < 0 ? -q.w : q.w;
  const sign = q.w < 0 ? -1 : 1;
  const sin = Math.hypot(q.x, q.y, q.z);
  if (sin < 1e-9) return out.set(0, 0, 0);
  const angle = 2 * Math.atan2(sin, w);
  const k = (angle * sign) / sin;
  return out.set(q.x * k, q.y * k, q.z * k);
}

/** The rotation a vector means: turn by its length about its own direction. */
export function vectorRotation(out: THREE.Quaternion, v: THREE.Vector3): THREE.Quaternion {
  const angle = v.length();
  if (angle < 1e-9) return out.identity();
  return out.setFromAxisAngle(scratchAxis.copy(v).multiplyScalar(1 / angle), angle);
}

const scratchAxis = new THREE.Vector3();

/**
 * WHERE A LOOPING CLIP SHOULD START, given where the body already is.
 *
 * `play()` used to set the clip's time to zero unconditionally, which is right for a strike -- a slash that
 * begins halfway through its own swing is not a slash -- and wrong for anything cyclic. A walk interrupted
 * at 25 %, 50 % or 75 % of its cycle and then resumed restarted at its own first contact, which measured 30
 * to 45 degrees away from the pose the body was holding, WHILE A POSE AT ZERO DISTANCE EXISTED ELSEWHERE IN
 * THE SAME CYCLE. The offset then had to carry the whole body there. That is the missing "resume point": the
 * cycle should be joined at the phase the body is already in, and then there is almost nothing to decay.
 *
 * Sampled rather than solved because a clip is an arbitrary function of time, not something invertible. 48
 * samples is a phase resolution of about 25 ms on a 1.2 s cycle, well under what the decay then smooths out,
 * and it runs once per transition rather than once per frame.
 */
export function matchPhase(
  duration: number,
  poseAt: (t: number) => Map<string, THREE.Quaternion>,
  body: Map<string, THREE.Quaternion>,
): number {
  const SAMPLES = 48;
  let best = 0;
  let bestScore = Infinity;
  for (let i = 0; i < SAMPLES; i += 1) {
    const t = (i / SAMPLES) * duration;
    const candidate = poseAt(t);
    // The MEAN over joints, not the max: one joint the clip happens not to write should not decide the
    // phase, and the mean is what "the body is in this pose" means.
    let sum = 0;
    let count = 0;
    for (const [name, q] of candidate) {
      const have = body.get(name);
      if (!have) continue;
      sum += angleBetween(have, q);
      count += 1;
    }
    const score = count ? sum / count : Infinity;
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}
