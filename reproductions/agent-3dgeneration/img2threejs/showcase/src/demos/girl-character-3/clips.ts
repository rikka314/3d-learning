/**
 * The animation clips: what the figure does, expressed as pure functions of time.
 *
 * The HOW lives in ./motion.ts -- contact model, leg solver, overlap, curves -- and this file is only the
 * authoring layer. That split exists because the first version of these clips drove joint angles directly
 * and was reported as stiff: stiffness came from the pipeline (feet that never rolled, joints that all
 * peaked on the same frame), not from any one number in any one clip.
 *
 * A clip is `(t, out) => void` writing an additive pose; the animator owns blending, looping and
 * cross-fades. Nothing here touches the scene.
 *
 * EVERY CURVE IS C2-CONTINUOUS, and for looping clips value, slope and curvature match across the seam.
 * That is the whole of the "no snapping" requirement, and it is verified rather than eyeballed -- see
 * scripts/verify-animation-clips.mjs. The one exception is declared: a jump's takeoff and landing are
 * changes in the forces on the body, and those are impulses by nature.
 *
 * Angles are radians, offsets metres, and `out` is additive over the rest pose.
 */

import { Quaternion } from 'three';
import {
  TAU, add, ease, bump, delayed, trail, hingeAxis,
  activity, plantFoot, hipAnchor, gaitFoot, solveLeg, LEG,
  WALK, walkPelvis, clamp01, reachHand, bodyPoint, handAt, Path3, strikeCurve,
  type Pose, type BoneDelta,
} from './motion';

export type { Pose, BoneDelta };

export type Clip = {
  name: string;
  /** Shown on the control that plays it. Lives here so the UI never has to guess from the name. */
  label: string;
  /** seconds; a looping clip repeats over exactly this span */
  duration: number;
  loop: boolean;
  /** Written additively into `out`. Called once per frame with 0 <= t < duration for loops. */
  pose(t: number, out: Pose): void;
  /** Optional per-clip root motion, for a jump or a spin that leaves the spot. */
  root?(t: number): { y?: number; yaw?: number };
  /**
   * Instants, in seconds, where an IMPULSE is part of what the clip depicts.
   *
   * Only a jump has any. Leaving the ground and arriving back on it are changes in the forces acting on
   * the body, and a rigid figure shows a change in force as a step in acceleration -- there is no curve
   * that both keeps the feet on the floor until takeoff and leaves smoothly, because those describe
   * different physics. Declaring them lets the verification hold every other frame to its bound while
   * still checking, at these frames, the things that must hold anyway: no jump in POSITION, and no change
   * of direction. Anything not declared here is a defect, which is how a 33,247 rad/s^2 knee was found.
   */
  impulses?: number[];
};

// ---- the walk -------------------------------------------------------------------------------------
//
// Built from the gait model in ./motion.ts, with the joint amplitudes and timings taken from clinical
// gait norms rather than from taste. The numbers below are the standard ones for level walking at a
// comfortable speed: pelvic rotation and obliquity about 4 degrees each, thoracic counter-rotation a
// little more and LATER, arm swing opposed to the same-side leg, and the whole body rising twice per
// cycle -- highest over each supporting leg, lowest in double support.
//
// What keeps it from reading as a machine is that none of these peak together. Each driver below is a
// pure function of phase, and the ones further out along a chain are the SAME function evaluated
// earlier: the chest follows the pelvis, the neck follows the chest, the elbow follows the shoulder.

const GAIT = WALK;

/**
 * How far each ankle tracks from the centre line, and how far the toe turns out.
 *
 * Clinical figures: ankles 80 to 120 mm apart in a comfortable walk, toe-out 5 to 7 degrees. The rig rests
 * with its ankles 325 mm apart and its foot bones already toeing out 8 degrees, and the walk inherited all
 * of it -- measured at 314 to 350 mm of width and up to 51 degrees of toe-out, wandering 30 degrees inside
 * a single cycle because the pelvis's own yaw was carrying the whole leg with it.
 */
const WALK_STANCE_HALF = 0.050;
const WALK_TOE_OUT = 0.105;

/** A braced or striking stance: wider and more turned out than a walk, and said so rather than inherited. */
const FIGHT_HALF = 0.085;
const FIGHT_TOE_OUT = 0.20;
const BRACE_HALF = 0.095;
const BRACE_TOE_OUT = 0.26;
const JUMP_HALF = 0.075;
const JUMP_TOE_OUT = 0.16;

/** Phase of the cycle at which each driver is evaluated; delays are in fractions of a cycle. */
const THORAX_LAG = 0.070;
const NECK_LAG = 0.045;
const ELBOW_LAG = 0.080;
/** The wrist is further out than the elbow, so it is later. */
const WRIST_LAG = 0.135;

/**
 * The pelvis comes from the gait model, not from here.
 *
 * `walkPelvis` is what the stride derivation solves against, so writing a second copy of these curves in
 * the clip is how the two come to disagree -- and they did, by 26 degrees of knee. These wrappers exist
 * only so stage 4 has a named function of phase to delay.
 */
const pelvisYaw = (u: number): number => walkPelvis(u).ry!;
const pelvisList = (u: number): number => walkPelvis(u).rz!;

/** The left shoulder, opposed to the left leg: back at heel strike, forward at toe-off. */
const shoulderSwing = (u: number): number => -0.26 * Math.cos(u * TAU);

export const walk: Clip = {
  name: 'walk',
  label: 'Walk',
  duration: GAIT.cycle,
  loop: true,
  /**
   * THE TWO TOE-OFFS ARE DECLARED IMPULSES, for exactly the reason the jump's takeoff is.
   *
   * A planted foot has zero velocity and a swinging one travels with the body, so at the instant a foot
   * leaves the ground its velocity steps by the whole of the walking speed. No curve avoids that while also
   * keeping the foot still until it leaves; the two requirements describe different physics. The knee
   * inherits the step.
   *
   * It was inside the jerk bound before only because the stride was short. Measured at the stride this gait
   * now derives, the shin reaches 315,000 rad/s^3 at the right foot's toe-off -- and the neighbourhood test
   * says what it is: 3.8 times the mean of the frames around it, which is a hump. A kink is a spike, fifteen
   * times and up. Inside the declared window the value-step and no-reversal checks still apply.
   */
  impulses: [GAIT.stance * GAIT.cycle, ((GAIT.stance + 0.5) % 1) * GAIT.cycle],
  pose(t, out) {
    const u = (t / GAIT.cycle) % 1;

    // ---- pelvis: everything below is solved against it, so it goes first ----------------------
    // ONE object, used for the bone AND the leg solve, because the two must not be allowed to disagree:
    // the tilt was once added to the bone and left out of the state handed to the solver, and the foot
    // drifted 12 mm -- the tilt's own lever arm at the ankle -- for exactly that reason.
    const pelvis = walkPelvis(u);
    add(out, 'hips', pelvis);

    // ---- legs: placed, not posed --------------------------------------------------------------
    for (const side of [1, -1] as const) {
      const phase = side > 0 ? u : (u + 0.5) % 1;
      const foot = gaitFoot(phase, GAIT, side);
      // The feet track close to the centre line and point where she is going. Left to the rest pose they
      // stayed 325 mm apart and toed out up to 51 degrees, which is a straddle and reads as one.
      plantFoot(out, side, pelvis, foot.y, foot.z, foot.pitch, 1,
        side * WALK_STANCE_HALF, WALK_TOE_OUT);
    }

    // ---- trunk: counter-rotates the pelvis, and LATER than it ---------------------------------
    // Thorax against pelvis is the classic counter-rotation; the lag is what makes the spine read as a
    // spine rather than a rod. Two segments, each following the one below it.
    // The shoulders counter-rotate the hips and do it LATER. Raised from 0.85 to 1.0 of the pelvis: a
    // warrior's walk carries its shoulders against its hips, and a small counter-rotation reads as timid.
    const thorax = -1.0 * delayed(pelvisYaw, u, THORAX_LAG, 1);
    add(out, 'spine', { ry: thorax * 0.60, rz: -0.35 * delayed(pelvisList, u, THORAX_LAG * 0.6, 1) });
    add(out, 'chest', { ry: thorax, rz: -0.30 * delayed(pelvisList, u, THORAX_LAG, 1), rx: 0.012 });

    // ---- head: held level, which means undoing the chest a beat later ------------------------
    // Vision stabilises the head, so it does not simply ride the shoulders. Counter-rotating with a lag
    // is what produces the small settle at each end of the turn instead of a rigid offset.
    add(out, 'neck', { ry: -0.55 * delayed(() => thorax, u, NECK_LAG, 1) });
    add(out, 'head', {
      ry: -0.42 * trail(pelvisYaw, u, NECK_LAG, 1),
      rz: -0.030 * Math.sin(u * TAU + Math.PI / 2),
    });

    // ---- arms: shoulder leads, elbow follows --------------------------------------------------
    for (const side of [1, -1] as const) {
      const suffix = side > 0 ? '.L' : '.R';
      const phase = side > 0 ? u : (u + 0.5) % 1;
      // A trace of asymmetry, upper body only. Real walks are not mirror-symmetric, and the eye reads
      // perfect symmetry as mechanical -- but the FEET stay symmetric, because a gait that limps is a
      // different fault from a gait that is stiff.
      // The two arms are not each other's mirror -- see `swingBias` for the legs' version of the same
      // point. The elbow's own gain differs from the shoulder's, so the pair never quite matches.
      const gainer = side > 0 ? 1.0 : 0.92;
      const swing = shoulderSwing(phase) * gainer;
      /**
       * THE SHOULDER GIRDLE HAS TO ALTERNATE, and it did not.
       *
       * It was `rz: side * -0.035 * swing / 0.26`, and `swing` is already this arm's own -- phase-shifted
       * half a cycle on the right. Multiplying by `side` cancels exactly that shift: measured, both girdles
       * reached their extreme at u = 0.496, in the same direction, so the two shoulders rose and fell
       * TOGETHER while the arms below them swung opposite. That is one of the two things "không có sự chuyển
       * động luân phiên" is describing, and no amount of arm swing hides it -- the girdle is what joins the
       * arm to the trunk, so a girdle moving symmetrically reads as a trunk that is one piece.
       *
       * Protraction, forward with its own arm, is the movement it should have: `ry` carries the joint itself
       * forward and back, and the small mirrored `rz` is left as elevation, which IS symmetric.
       */
      add(out, `shoulder${suffix}`, {
        ry: -0.055 * swing / 0.26,
        rz: side * -0.020 * Math.cos(u * TAU),
      });
      add(out, `upperArm${suffix}`, { rx: swing, rz: side * 0.05 * swing / 0.26 });
      // The elbow keeps a working bend and flexes most as the arm comes forward -- one beat behind the
      // shoulder, which is the whole reason the arm looks jointed rather than welded.
      const elbow = delayed(shoulderSwing, phase, ELBOW_LAG + (side > 0 ? 0 : 0.015), 1)
        * (side > 0 ? 1.0 : 0.95);
      // ABOUT THE ELBOW'S OWN AXIS. A raw `rx` is a rotation about the model's X, and this elbow hinges
      // about the normal of the plane its two bones lie in -- 24 degrees off it. Driving the swing with rx
      // put 30 degrees of rotation off the hinge, which is an elbow doing something an elbow does not.
      /**
       * A CARRIED BLADE IS HELD, and that changes the elbow's job.
       *
       * An empty arm hangs and swings from the shoulder. An arm with a sword in it keeps a real bend, because
       * the blade has to clear the ground and the hip -- 15 to 45 degrees through the cycle rather than the 7
       * to 32 an empty arm uses. The modulation is what matters more than the mean: the elbow closing as the
       * arm comes forward and opening as it goes back is most of what makes an arm read as jointed.
       */
      add(out, `foreArm${suffix}`, {
        q: new Quaternion().setFromAxisAngle(hingeAxis(`foreArm${suffix}`), 0.52 + 0.26 * (elbow / 0.26)),
      });
      /**
       * AND THE WRIST, which had no movement at all on the axis a blade swings about.
       *
       * The hand was written with 2.9 degrees of `rz` and nothing else, so each sword was rigidly bolted to
       * its forearm: a 600 mm blade with no wrist between it and the bone. Measured, the blades stayed level
       * to within 77 mm through a whole cycle. That is the other half of "khúc gỗ" -- and the largest single
       * cause of it, because the blade is the part of this character an eye follows.
       *
       * `trail` rather than `delayed`: a held blade has mass, so the wrist does not merely lag the forearm,
       * it overshoots and comes back. The driver is the arm's own swing, so the two wrists alternate with the
       * two arms, and the lag is longer than the elbow's -- the further out along a chain, the later.
       */
      const wristLag = WRIST_LAG + (side > 0 ? 0 : 0.012);
      const wrist = trail(shoulderSwing, phase, wristLag, 1) * (side > 0 ? 1.0 : 0.94);
      add(out, `hand${suffix}`, {
        // 0.14 rad of drive, not 0.30: `trail` adds its own overshoot term, so it multiplies the amplitude
        // by about 2.4 -- driven at 0.30 the wrist swung 42 degrees, which is inside what a wrist can do and
        // far more than one carrying a blade does. This lands it near 20.
        rx: -0.14 * wrist / 0.26,
        rz: side * 0.05 * (elbow / 0.26),
      });
      /**
       * The forearm's roll, so the blades are not held at one fixed angle for the whole walk. A held weight
       * rolls the forearm a few degrees as the arm swings -- it is what turns a pair of blades from two rods
       * into two things being carried.
       */
      add(out, `foreArmTwist${suffix}`, { ry: side * 0.10 * delayed(shoulderSwing, phase, ELBOW_LAG, 1) / 0.26 });
    }
  },
};

/**
 * SLASH FORWARD, right hand.
 *
 * A slash is not a rotation of the arm: it is a chain -- hips lead, chest follows, shoulder follows,
 * and the blade arrives last. The phases below overlap deliberately so the body is already unwinding
 * when the hand is still accelerating, which is what makes a strike read as weight rather than as a
 * wave. Wind-up is slow, the strike is short, the recovery is longer than the strike.
 */
const SLASH_TIME = 1.35;

/**
 * WHERE THE RIGHT HAND GOES, which is what a cut actually is.
 *
 * The previous version chose `upperArm.rx`, `.ry`, `.rz` and `foreArm.rx` by eye, one number at a time,
 * and it failed the way the legs once did: the numbers only agree with each other in the single pose they
 * were tuned in, and between poses the hand takes whatever route the interpolation happens to give it.
 * A diagonal cut is a path -- up and behind the right shoulder, then down and across the body -- so it is
 * written as one, and the shoulder and elbow are solved to follow it.
 *
 * THE TIMING IS IN THE SPACING, and the spacing has to be checked rather than felt. A natural cubic spline
 * distributes curvature, not speed: given one long segment and several short ones it will run the long one
 * fast to keep the joins smooth. A first version with a single wind-up knot did exactly that and put the
 * clip's fastest hand -- 5.2 m/s -- at t=0.10, during the wind-up, before the strike had begun.
 *
 * THE DISTANCE FROM THE SHOULDER MATTERS AS MUCH AS THE SHAPE. A path that dives in toward the shoulder
 * and back out folds and unfolds the elbow, and the upper arm swings hard to compensate while the hand
 * hardly moves: measured at 35 rad/s of shoulder for 2.9 m/s of hand, on knots whose reach ran
 * 469, 301, 363, 242, 437 mm. These stay in a band, so the arc is carried by direction rather than by
 * repeatedly folding the arm. `measure-hand-path.ts` reports both, and the shoulder's own rate, which is
 * the number that actually bounds how hard a strike can be.
 *
 * AND THE BAND STAYS OFF THE LIMIT. This rig's arm is nearly straight at rest, so its resting wrist is
 * already at full extension -- and within a few millimetres of that the elbow angle changes enormously for
 * a small move of the hand. Working knots that reached 437 to 469 mm put 3.3 million rad/s^3 of jerk in
 * the forearm. They stay under 420 now, and only the first knot is the true resting pose, where the clip's
 * own fade means nothing is being asked of the joint anyway.
 */
const SLASH_PATH = Path3.timed([
  { pos: handAt(-1, [-0.42, -0.86, 0.06], 0.920) },
  { pos: handAt(-1, [-0.48, -0.78, 0.10], 0.920), speed: 0.9 },
  { pos: handAt(-1, [-0.62, -0.30, -0.30], 0.920), speed: 1.2 },
  { pos: handAt(-1, [-0.50, 0.52, -0.40], 0.920), speed: 1.3 },
  { pos: handAt(-1, [-0.36, 0.42, 0.55], 0.920), speed: 2.6 },
  { pos: handAt(-1, [0.28, -0.34, 0.86], 0.920), speed: 3.4 },
  { pos: handAt(-1, [0.34, -0.74, 0.52], 0.920), speed: 2.0 },
  { pos: handAt(-1, [-0.10, -0.86, 0.28], 0.920), speed: 1.3 },
  { pos: handAt(-1, [-0.42, -0.86, 0.06], 0.920), speed: 1.0 },
])
/**
 * The off hand counterbalances. A limb left at rest during a strike reads as paralysed.
 *
 * EVERY TARGET STAYS INSIDE REACH, and not by a little. Near full extension the elbow angle is extremely
 * sensitive to the hand's position -- it comes out of an `acos` whose argument is approaching 1 -- so a
 * path that grazes the limit turns a smooth hand arc into a violent elbow. Measured on a first version
 * whose off hand went 52 mm past reach: 4.2 million rad/s^3 of angular jerk at the forearm. The rig's arm
 * is nearly straight at rest, so even the RESTING wrist position is at that limit; the guard poses here
 * sit 30 mm inside it.
 */
const SLASH_OFF_PATH = Path3.timed([
  { pos: handAt(1, [0.40, -0.88, 0.06], 0.920) },
  { pos: handAt(1, [0.46, -0.80, 0.20], 0.920), speed: 0.8 },
  { pos: handAt(1, [0.52, -0.68, 0.34], 0.920), speed: 0.9 },
  { pos: handAt(1, [0.30, -0.88, -0.10], 0.920), speed: 1.4 },
  { pos: handAt(1, [0.40, -0.88, 0.06], 0.920), speed: 0.9 },
])
/**
 * The pelvis drives the cut, and everything above it follows LATE.
 *
 * A strike is a kinetic chain: the ground pushes the legs, the legs turn the pelvis, the pelvis carries the
 * chest, the chest throws the shoulder, and the arm arrives last. Each link peaks after the one below it.
 * Driving them all off the same curve -- which is what `0.22 * wind - 0.34 * strike` in every line amounts
 * to -- makes the torso rotate as a single block, and no amount of smoothing reads as power after that.
 */
const slashHipYaw = (t: number): number => {
  const wind = ease(clamp01(t / 0.46));
  const through = strikeCurve(clamp01((t - 0.44) / 0.38));
  const settle = ease(clamp01((t - 0.80) / 0.55));
  return 0.26 * wind - 0.52 * through + 0.24 * settle;
};

/**
 * WHERE THE BLADE POINTS, in the body's frame, and it is the arm's job to make that true.
 *
 * Three attempts got here. Pointing the blade along the hand's own tangent flips 180 degrees the instant
 * the hand turns around -- 1247 mrad of wrist in one frame. Cocking the wrist by an authored angle and
 * letting the arm decide the rest leaves the blade wherever the arm's roll happens to put it: measured
 * through the impact, 62 degrees UP, on a downward cut. What works is to state the blade's direction and
 * SOLVE the elbow's pole for it, because the pole is what rolls the forearm and the forearm carries the
 * grip.
 */

/**
 * WHERE THE ELBOW GOES, fitted from measurement rather than solved or guessed.
 *
 * The pole turns the elbow about the shoulder-to-wrist line, and in doing so it rolls the forearm -- which
 * is what decides where a rigidly-held blade points. Solving for it numerically was the first instinct and
 * it does not survive: two poles are often equally good, the search hops between them, and the arm snaps
 * (17 million rad/s^3 of wrist). Authoring it blind does not work either, because the relationship between
 * pole and blade angle is not something anyone can picture.
 *
 * So it was MEASURED. `POLE_PROBE` swept a constant pole from -2.4 to 3.0 and reported the blade's
 * elevation at seven moments of the cut; the table said 2.4 early and 3.0 late gives a blade that rises to
 * about 79 degrees at the top of the wind-up and falls through zero to -46 by the follow-through, which is
 * a diagonal downward cut. This curve is that reading, smoothed.
 */
const SLASH_POLE_CURVE = new Path3([
  { at: 0.00, pos: [0.00, 0, 0] },
  { at: 0.08, pos: [0.35, 0, 0] },
  { at: 0.20, pos: [0.65, 0, 0] },
  { at: 0.45, pos: [0.75, 0, 0] },
  { at: 0.66, pos: [0.74, 0, 0] },
  { at: 0.85, pos: [0.74, 0, 0] },
  { at: 1.00, pos: [0.60, 0, 0] },
]);
const SLASH_POLE = (u: number): number => SLASH_POLE_CURVE.at(u).x;

/**
 * FOREARM PRONATION, which is where most of the blade's orientation now comes from.
 *
 * The first fitted version paid for the whole thing at the shoulder: a pole curve reaching 3.0 rad, which
 * measured 176.9 degrees of roll across one joint. A humerus rotates about 90 degrees. Halving that with a
 * twist bone still leaves a quarter turn of shear across the deltoid, so the fix is not to distribute the
 * roll better but to stop asking the shoulder for it.
 *
 * A forearm supinates and pronates through about 150 degrees, and that is the joint a swordsman turns a
 * blade with. With the pole held to 0.85 rad the shoulder now rolls 97 degrees at its worst -- essentially
 * its own limit -- and the rest of the blade angle comes from here. Knotless ramps, so there are no knots
 * for the third derivative to step at.
 */
const slashPronate = (u: number): number =>
  0.7 * ease(clamp01((u - 0.05) / 0.45))
  + 0.7 * ease(clamp01((u - 0.55) / 0.30))
  - 1.0 * ease(clamp01((u - 0.85) / 0.15));

const TORSO_LAG = 0.055;

export const slash: Clip = {
  name: 'slash',
  label: 'Slash',
  duration: SLASH_TIME,
  loop: false,
  pose(t, out) {
    const u = clamp01(t / SLASH_TIME);
    const engaged = activity(t, SLASH_TIME);

    // ---- the chain, from the ground up --------------------------------------------------------
    const wind = ease(clamp01(t / 0.46));
    const through = strikeCurve(clamp01((t - 0.44) / 0.38));
    const settle = ease(clamp01((t - 0.80) / 0.55));
    const hipYaw = slashHipYaw(t);
    const lunge = {
      ty: -0.048 * wind - 0.030 * through + 0.020 * settle,
      tz: -0.018 * wind + 0.075 * through - 0.040 * settle,
      ry: hipYaw,
    };
    add(out, 'hips', lunge);
    // A FIGHTING STANCE IS DELIBERATE TOO. Wider than a walk and turned out more -- that is what bracing
    // looks like -- but chosen rather than inherited from a rest pose whose ankles sit 325 mm apart and
    // whose feet already toe out 8 degrees before anything moves them.
    plantFoot(out, 1, lunge, LEG.standY, 0.14 * wind, 0, engaged, FIGHT_HALF, FIGHT_TOE_OUT);
    plantFoot(out, -1, lunge, LEG.standY, -0.16 * wind, -0.10 * through, engaged,
      -FIGHT_HALF, FIGHT_TOE_OUT);

    add(out, 'spine', { ry: 0.55 * delayed(slashHipYaw, t, TORSO_LAG) });
    add(out, 'chest', {
      ry: 1.05 * delayed(slashHipYaw, t, TORSO_LAG * 2),
      rx: -0.12 * through + 0.10 * settle,
    });
    add(out, 'shoulder.R', { rz: -0.16 * wind + 0.20 * through - 0.04 * settle });
    add(out, 'shoulder.L', { rz: 0.10 * wind - 0.12 * through });
    // The head leads the strike: eyes go to the target before the blade does.
    add(out, 'neck', { ry: -0.24 * ease(clamp01((t - 0.20) / 0.30)) + 0.10 * settle });

    // ---- the hands, placed rather than posed --------------------------------------------------
    //
    // BOTH PATHS START AND END AT THE RESTING WRIST, so the clip's fade-in has nothing to carry. Otherwise
    // it drags the arm from rest to a pose a radian away, and a radian about the shoulder moves the hand
    // nearly half a metre: measured, the fastest the hand ever moved in an early version was 5.2 m/s at
    // t=0.10, during the fade, before the strike had begun.
    //
    // The elbow lifts OUT through the wind-up and tucks UNDER as the cut comes across, which is what
    // carries a blade rather than pushing it.
    const pole = SLASH_POLE(u);
    reachHand(out, -1, bodyPoint(out, SLASH_PATH.at(u)), pole, engaged, slashPronate(u));
    reachHand(out, 1, bodyPoint(out, SLASH_OFF_PATH.at(u)),
      0.30 * ease(clamp01(t / 0.30)), engaged);

  },
};


/**
 * CROSS GUARD -- the two blades brought together into an X in front of the chest, held, then released.
 *
 * The X is a POSE, so the clip is mostly a hold: in and out are eased over a fifth of the clip each and
 * the middle three fifths do not move. Both arms cross the centre line, one high and one low, and the
 * wrists counter-rotate so the blades meet edge to edge instead of lying flat against each other.
 */
const GUARD_TIME = 1.80;

/**
 * THE X, stated as two hand positions instead of six joint angles.
 *
 * The previous version reached this pose by SEARCHING for joint angles -- twice, because the first search
 * produced hands that never crossed the centre line and the second crossed by only 85 mm, which the render
 * showed reads as praying rather than as a guard. With an arm solver the pose is simply named: the right
 * hand 185 mm past the centre and high, the left 150 mm past it and 140 mm lower, so the blades cross
 * rather than stack. Both sit comfortably inside reach, which is what keeps the elbows from locking.
 *
 * A HOLD NEEDS MORE THAN TWO EQUAL KNOTS. A natural cubic spline through two identical positions does not
 * sit still between them: it arrives with the velocity the approach gave it, bulges past, and comes back.
 * Measured here, that bulge carried the left wrist to 456 mm from a shoulder 398 mm away -- straight into
 * the solver's extension clamp, where the elbow angle changes 6 degrees for 6 mm of hand and the gate read
 * over a million rad/s^3 of jerk. Four knots pin it.
 */
const GUARD_R = new Path3([
  { at: 0.00, pos: handAt(-1, [-0.42, -0.86, 0.06], 0.920) },
  { at: 0.14, pos: handAt(-1, [-0.10, -0.50, 0.60], 0.900) },
  { at: 0.26, pos: handAt(-1, [0.62, -0.14, 0.55], 0.900) },
  { at: 0.42, pos: handAt(-1, [0.62, -0.14, 0.55], 0.900) },
  { at: 0.58, pos: handAt(-1, [0.62, -0.14, 0.55], 0.900) },
  { at: 0.74, pos: handAt(-1, [0.62, -0.14, 0.55], 0.900) },
  { at: 0.86, pos: handAt(-1, [-0.10, -0.50, 0.60], 0.900) },
  { at: 1.00, pos: handAt(-1, [-0.42, -0.86, 0.06], 0.920) },
]);
const GUARD_L = new Path3([
  { at: 0.00, pos: handAt(1, [0.40, -0.88, 0.06], 0.920) },
  { at: 0.14, pos: handAt(1, [0.06, -0.62, 0.56], 0.900) },
  { at: 0.26, pos: handAt(1, [-0.58, -0.42, 0.62], 0.900) },
  { at: 0.42, pos: handAt(1, [-0.58, -0.42, 0.62], 0.900) },
  { at: 0.58, pos: handAt(1, [-0.58, -0.42, 0.62], 0.900) },
  { at: 0.74, pos: handAt(1, [-0.58, -0.42, 0.62], 0.900) },
  { at: 0.86, pos: handAt(1, [0.06, -0.62, 0.56], 0.900) },
  { at: 1.00, pos: handAt(1, [0.40, -0.88, 0.06], 0.920) },
]);

/** Elbow poles, fitted the same way the cut's was: swept, measured, and read off the table. */
/**
 * The elbow's pole through the guard, as a ramp rather than a spline.
 *
 * SPREAD OVER THE WHOLE APPROACH, because ramping the pole faster than the hand travels rolls the arm
 * about its own axis instead of swinging it -- measured at 8.5 rad/s of twist against 4.1 of swing, which
 * on screen is a forearm spinning inside a sleeve.
 *
 * And NOT a `Path3`. A natural cubic spline is continuous to the second derivative and no further: its
 * third derivative steps at every knot, and on a control that moves 1.55 rad those steps measured over a
 * million rad/s^3. A pair of smootherstep ramps has no knots to step at.
 */
const guardPole = (u: number): number =>
  1.55 * (ease(clamp01((u - 0.02) / 0.30)) - ease(clamp01((u - 0.68) / 0.30)));

export const crossGuard: Clip = {
  name: 'cross-guard',
  label: 'Cross guard',
  duration: GUARD_TIME,
  loop: false,
  pose(t, out) {
    const u = clamp01(t / GUARD_TIME);
    const inn = ease(clamp01(t / 0.40));
    const outn = ease(clamp01((t - 1.40) / 0.40));
    const hold = inn - outn;
    const engaged = activity(t, GUARD_TIME);

    // A braced stance: the pelvis settles, the feet hold their ground, and the knees load by as much as
    // that settling demands rather than by a number chosen to look loaded.
    const brace = { ty: -0.030 * hold, rx: -0.03 * hold };
    add(out, 'hips', brace);
    plantFoot(out, 1, brace, LEG.standY, 0.03 * hold, 0, engaged, BRACE_HALF, BRACE_TOE_OUT);
    plantFoot(out, -1, brace, LEG.standY, -0.03 * hold, 0, engaged, -BRACE_HALF, BRACE_TOE_OUT);
    add(out, 'thigh.L', { rz: 0.06 * hold });
    add(out, 'thigh.R', { rz: -0.06 * hold });

    // The trunk closes behind the guard, later than the pelvis and less than it.
    add(out, 'spine', { rx: -0.06 * delayed(() => hold, t, 0.05) });
    add(out, 'chest', { rx: -0.10 * delayed(() => hold, t, 0.09) });
    add(out, 'neck', { rx: 0.07 * hold });

    reachHand(out, -1, bodyPoint(out, GUARD_R.at(u)), guardPole(u), engaged);
    reachHand(out, 1, bodyPoint(out, GUARD_L.at(u)), -guardPole(u), engaged);
  },
};


/**
 * SPIN AND SLASH -- a full turn carrying a horizontal cut.
 *
 * The turn is root motion, and it is eased so the body accelerates into it and settles out; a linear
 * yaw looks like a turntable. The cut lands three fifths of the way through, when the body is facing
 * back toward the front, because a strike that lands while facing away has nothing to hit.
 */
/**
 * The sweeping hand, at chest height, opening out as the turn carries it round.
 *
 * TIMED BY SPEED, and with a waypoint on the way back. With even knot spacing the recovery leg had to
 * cover the whole return in a seventh of the clip, and the spline ran it at 6.11 m/s -- faster than the cut
 * it was recovering from, which reads as a snatch and put 215,000 rad/s^3 into the forearm.
 */
const SPIN_R = Path3.timed([
  { pos: handAt(-1, [-0.42, -0.86, 0.06], 0.92) },
  { pos: handAt(-1, [0.30, -0.60, 0.24], 0.92), speed: 1.1 },
  { pos: handAt(-1, [-0.18, -0.52, -0.54], 0.92), speed: 1.3 },
  { pos: handAt(-1, [-0.68, -0.30, 0.34], 0.92), speed: 2.4 },
  { pos: handAt(-1, [-0.30, -0.24, 0.82], 0.92), speed: 3.2 },
  { pos: handAt(-1, [0.44, -0.34, 0.72], 0.92), speed: 2.6 },
  { pos: handAt(-1, [0.10, -0.66, 0.40], 0.92), speed: 1.5 },
  { pos: handAt(-1, [-0.42, -0.86, 0.06], 0.92), speed: 1.1 },
]);
const SPIN_L = Path3.timed([
  { pos: handAt(1, [0.40, -0.88, 0.06], 0.92) },
  { pos: handAt(1, [0.62, -0.66, -0.24], 0.92), speed: 1.0 },
  { pos: handAt(1, [0.16, -0.70, 0.56], 0.92), speed: 1.4 },
  { pos: handAt(1, [0.40, -0.88, 0.06], 0.92), speed: 1.0 },
]);
/** Elbow out through the gather, further out through the sweep. Knotless, so its jerk is bounded. */
const spinPole = (u: number): number =>
  1.20 * ease(clamp01((u - 0.02) / 0.28)) + 0.80 * ease(clamp01((u - 0.45) / 0.30))
  - 1.60 * ease(clamp01((u - 0.80) / 0.20));

export const spinSlash: Clip = {
  name: 'spin-slash',
  label: 'Spin & slash',
  duration: 1.60,
  loop: false,
  root(t) {
    return { yaw: TAU * ease(Math.min(1, t / 1.30)) };
  },
  pose(t, out) {
    const wind = ease(Math.min(1, t / 0.30));
    const cut = bump(Math.max(0, Math.min(1, (t - 0.62) / 0.42)));
    const settle = ease(Math.max(0, (t - 1.20) / 0.40));
    add(out, 'hips', { ry: -0.20 * wind + 0.26 * cut });
    add(out, 'spine', { ry: -0.16 * wind + 0.30 * cut });
    add(out, 'chest', { ry: -0.24 * wind + 0.52 * cut, rz: 0.10 * cut });
    add(out, 'shoulder.R', { rz: -0.18 * wind + 0.20 * cut });
    // HORIZONTAL, and the hand says so: the blade sweeps round at chest height while the body turns under
    // it, rather than coming over the top. Written as a path for the same reason the diagonal cut is --
    // six joint angles chosen by eye only agree with each other in the one pose they were tuned in.
    const engagedArm = activity(t, 1.60);
    const su = clamp01(t / 1.60);
    reachHand(out, -1, bodyPoint(out, SPIN_R.at(su)), spinPole(su), engagedArm);
    reachHand(out, 1, bodyPoint(out, SPIN_L.at(su)), -0.8 * ease(clamp01(t / 0.40)), engagedArm);
    // A PIVOT, so both feet stay on the floor and the turn is carried by the root. The lead foot steps
    // slightly across as the body loads, which is what gives a spin something to turn about.
    const pivot = { ty: -0.045 * wind + 0.020 * settle,
      ry: -0.20 * wind + 0.26 * cut };
    const engaged = activity(t, 1.60);
    plantFoot(out, 1, pivot, LEG.standY, 0.10 * wind - 0.05 * settle, 0, engaged,
      FIGHT_HALF, FIGHT_TOE_OUT);
    plantFoot(out, -1, pivot, LEG.standY, -0.10 * wind + 0.04 * settle, 0, engaged,
      -FIGHT_HALF, FIGHT_TOE_OUT);
    add(out, 'thigh.L', { rz: 0.10 * wind });
    add(out, 'thigh.R', { rz: -0.12 * wind });
    add(out, 'hips', { ty: pivot.ty });
  },
};

/**
 * JUMP AND DOUBLE OVERHEAD SLASH.
 *
 * The root follows a real trajectory rather than a sine: a crouch, then a ballistic arc under gravity,
 * then a landing that absorbs. The blades come up during the rise and come down THROUGH the fall, so
 * the cut is driven by the body dropping rather than by the arms alone -- that is where the weight in
 * an overhead strike comes from.
 */
const JUMP_RISE = 0.34;
const JUMP_FALL = 0.40;
const JUMP_CROUCH = 0.26;
const JUMP_LAND = 0.40;

const JUMP_DURATION = JUMP_CROUCH + JUMP_RISE + JUMP_FALL + JUMP_LAND;

const JUMP_AIR = JUMP_RISE + JUMP_FALL;
const JUMP_PEAK = 0.42;
/**
 * The vertical speed the body leaves and lands with, in m/s, which is not a free choice: it is what a
 * 420 mm arc over this many seconds requires. Everything else vertical is derived from it.
 */
const JUMP_TAKEOFF_V = JUMP_PEAK * 4 / JUMP_AIR;
/**
 * How far the knees are already folded when the feet touch down, ready to absorb.
 *
 * 85 mm, not the 60 it was, and the reason is the knee's angular SPEED at contact rather than how the pose
 * looks. The leg is a two-bone chain, so its length is 2 L cos(phi/2) and the rate the knee has to turn at
 * to absorb a given descent is v / (L sin(phi/2)) -- which runs away as the leg straightens. Landing 60 mm
 * short of standing is 45 degrees of knee, where that denominator is 0.38 and a 2.27 m/s descent asks the
 * knee for 15 rad/s, past what a knee does. 85 mm is 61 degrees, the denominator is 0.45, and the same
 * descent asks 12.7. A body lands with its knees already bent for exactly this reason: not to look ready,
 * but because a straight leg cannot yield fast enough.
 */
const JUMP_PRELOAD = 0.085;
/** How high the ankles are drawn under the body at the top of the arc. */
const JUMP_TUCK = 0.22;
/**
 * How far short of standing the pelvis is at the instant the feet leave.
 *
 * Not decoration: a leg at full stretch is where two-bone IK is singular. The knee angle comes out of an
 * `acos`, whose sensitivity runs away as the argument approaches 1, so a pelvis rising to exactly standing
 * height at takeoff drives the knee through that runaway and the verification measured 2,814 rad/s^2 there
 * -- from perfectly smooth inputs. 30 mm short keeps 32 degrees of bend in the knee, which is both well
 * clear of the singularity and what a leg mid-extension actually looks like.
 */
const JUMP_TAKEOFF_BEND = 0.030;

/**
 * How high the body is off the ground at time `t`.
 *
 * `pose()` needs this as much as `root()` does: the floor is at a fixed world height, so in the pose's
 * own frame it RECEDES as the body rises. A foot solved against a fixed pose-space floor would stay
 * glued to the character's feet through the whole jump, stretching the legs to the takeoff point.
 */
function jumpLift(t: number): number {
  const air = t - JUMP_CROUCH;
  if (air <= 0 || air >= JUMP_AIR) return 0;
  // One parabola across the whole airborne span, peaking at the top of the rise.
  const x = air / JUMP_AIR;
  return JUMP_PEAK * 4 * x * (1 - x);
}

/**
 * How far the pelvis sits below standing height -- the crouch and the landing absorb, DERIVED.
 *
 * The body's height off the ground is one continuous quantity, and splitting it across a root offset and
 * a pelvis offset is only bookkeeping: the root carries it while the feet are in the air, the knees carry
 * it while they are on the ground. So the two halves have to agree at the handover, and the way to make
 * them agree is to let the ballistic arc dictate the terms. It leaves at `JUMP_TAKEOFF_V`, so the crouch
 * is the cubic that arrives at the takeoff instant moving upward at exactly that speed; it lands at the
 * same speed downward, so the absorb is the cubic that leaves the landing instant moving downward at it
 * and comes to rest. Both curves then hand over with matching velocity, and the crouch depth (87 mm) and
 * the absorb depth (134 mm) are consequences rather than numbers picked to look right.
 *
 * Chosen this way because the picked numbers did not survive measurement: a pelvis that stopped dead at
 * touchdown made the knees jump 33,247 rad/s^2 in one frame.
 */
function jumpSquat(t: number): number {
  if (t < JUMP_CROUCH) {
    const k = t / JUMP_CROUCH;
    // Hermite: still at standing height at the start, and at takeoff still slightly folded but already
    // rising at takeoff speed.
    return (-2 * k ** 3 + 3 * k ** 2) * -JUMP_TAKEOFF_BEND
      + (k ** 3 - k ** 2) * JUMP_TAKEOFF_V * JUMP_CROUCH;
  }
  const land = t - JUMP_CROUCH - JUMP_AIR;
  if (land <= 0) {
    // Airborne: the knees fold under the body through the flight, so it meets the ground with them
    // already bent. A figure that lands on legs at full stretch has nothing to absorb with, and asking
    // the solver for full stretch at that instant made it saturate: the knee snapped open 110 mrad in a
    // single frame on the approach. The pelvis is not the centre of mass, so it is free to move relative
    // to the arc while the arc itself stays ballistic.
    return -JUMP_TAKEOFF_BEND
      + (JUMP_TAKEOFF_BEND - JUMP_PRELOAD) * ease((t - JUMP_CROUCH) / JUMP_AIR);
  }
  const k = Math.min(1, land / JUMP_LAND);
  // Hermite from the folded height back to standing: leaves the landing still travelling down at
  // touchdown speed, and comes to rest with nothing left over.
  return (2 * k ** 3 - 3 * k ** 2 + 1) * -JUMP_PRELOAD
    - (k ** 3 - 2 * k ** 2 + k) * JUMP_TAKEOFF_V * JUMP_LAND;
}

/**
 * The overhead strike, as two hand paths.
 *
 * Mirrored about the body's centre line, which is what makes a two-handed overhead read as one action:
 * the hands rise together, reach their highest at the top of the arc, and come down together in front.
 * Every knot stays 320 to 470 mm from its shoulder -- inside reach, and off the extension limit where the
 * elbow angle stops being stable.
 */
/**
 * The overhead strike's hands sit at 0.875 of full extension, not the 0.92 the other clips use.
 *
 * This clip shrugs the shoulders as the blades go up -- which is how a real overhead reach finds its last
 * few centimetres -- and a shrug moves the shoulder JOINT about 25 mm. The hand target is carried by the
 * chest, not by the shoulder, so that 25 mm comes straight off the arm's remaining reach: with knots at
 * 0.92 the solver sat pinned against its extension clamp for a tenth of a second at the apex.
 */
const JUMP_R = new Path3([
  { at: 0.00, pos: handAt(-1, [-0.42, -0.86, 0.06], 0.875) },
  { at: 0.10, pos: handAt(-1, [-0.40, -0.84, 0.18], 0.875) },
  { at: 0.22, pos: handAt(-1, [-0.34, -0.80, 0.34], 0.875) },
  { at: 0.33, pos: handAt(-1, [-0.60, -0.16, 0.42], 0.875) },
  { at: 0.45, pos: handAt(-1, [-0.38, 0.68, 0.52], 0.875) },
  { at: 0.60, pos: handAt(-1, [-0.20, 0.84, 0.44], 0.875) },
  // A knot between the apex and the chop, because the arm's ROLL turns fastest where its direction does:
  // the twist bone that follows half of it was moving 67 mrad in a frame across this gap.
  { at: 0.66, pos: handAt(-1, [-0.16, 0.70, 0.58], 0.875) },
  { at: 0.72, pos: handAt(-1, [-0.16, 0.34, 0.86], 0.875) },
  { at: 0.86, pos: handAt(-1, [-0.14, -0.44, 0.82], 0.875) },
  { at: 0.94, pos: handAt(-1, [-0.32, -0.78, 0.42], 0.875) },
  { at: 1.00, pos: handAt(-1, [-0.42, -0.86, 0.06], 0.875) },
]);
const JUMP_L = new Path3([
  { at: 0.00, pos: handAt(1, [0.40, -0.88, 0.06], 0.875) },
  { at: 0.10, pos: handAt(1, [0.38, -0.86, 0.18], 0.875) },
  { at: 0.22, pos: handAt(1, [0.32, -0.82, 0.34], 0.875) },
  { at: 0.33, pos: handAt(1, [0.58, -0.18, 0.42], 0.875) },
  { at: 0.45, pos: handAt(1, [0.36, 0.68, 0.52], 0.875) },
  { at: 0.60, pos: handAt(1, [0.18, 0.84, 0.44], 0.875) },
  { at: 0.66, pos: handAt(1, [0.14, 0.70, 0.58], 0.875) },
  { at: 0.72, pos: handAt(1, [0.14, 0.34, 0.86], 0.875) },
  { at: 0.86, pos: handAt(1, [0.12, -0.44, 0.82], 0.875) },
  { at: 0.94, pos: handAt(1, [0.30, -0.78, 0.42], 0.875) },
  { at: 1.00, pos: handAt(1, [0.40, -0.88, 0.06], 0.875) },
]);
/**
 * Elbows out and up for the overhead grip, dropping as the blades come down.
 *
 * Held to 0.62 rad rather than the 1.10 it started at, because the pole is not the only thing that rolls
 * the upper arm -- the swing onto the aim direction contributes too, and the measured total was 117
 * degrees at one shoulder against a humerus's 90.
 */
const jumpPole = (u: number): number =>
  1.20 * ease(clamp01((u - 0.05) / 0.35)) - 1.20 * ease(clamp01((u - 0.70) / 0.25));

export const jumpSlash: Clip = {
  name: 'jump-slash',
  label: 'Jump & slash',
  duration: JUMP_DURATION,
  loop: false,
  impulses: [JUMP_CROUCH, JUMP_CROUCH + JUMP_AIR],
  root(t) {
    return { y: jumpLift(t) };
  },
  pose(t, out) {
    const rise = ease(Math.max(0, Math.min(1, (t - JUMP_CROUCH) / JUMP_RISE)));
    const fall = ease(Math.max(0, Math.min(1, (t - JUMP_CROUCH - JUMP_RISE) / JUMP_FALL)));
    // Both arms overhead on the rise, driven down through the fall -- as hand paths, so the blades go
    // where an overhead strike puts them instead of wherever four angles happen to leave them.
    const ju = clamp01(t / JUMP_DURATION);
    const armFade = activity(t, JUMP_DURATION);
    for (const suffix of ['.L', '.R'] as const) {
      const side = suffix === '.L' ? 1 : -1;
      // THE SHOULDERS SHRUG UP to strike overhead, which is both what a body does and what makes the
      // reach possible. The sign was the other way round: it DEPRESSED the joint 18 mm during the rise,
      // taking that much off an already-stretched arm, and the solver sat pinned against its extension
      // clamp through the whole apex.
      add(out, `shoulder${suffix}`, { rz: side * (0.24 * rise - 0.20 * fall) });
      reachHand(out, side, bodyPoint(out, (side > 0 ? JUMP_L : JUMP_R).at(ju)),
        side * jumpPole(ju), armFade);
    }
    const hipsTy = jumpSquat(t);
    const pelvis = { ty: hipsTy };
    // WHERE THE FEET ARE, in two regimes that meet without a seam.
    //
    // On the ground the ankle is on the floor. In the air it is held relative to the BODY and tucked by a
    // bell -- and crucially the two agree exactly at takeoff and at touchdown, because the bell is zero
    // there and the body is on the floor there. So there is nothing to blend and no rush to blend it in.
    //
    // Two attempts came before this. Following the floor through the flight asks the leg to reach the
    // ground from 420 mm up, which no leg can do, so the solver saturated. Blending from floor to tuck
    // over a window then compressed a 300 mm move into the 70 ms the window lasted, and the knee stepped
    // 91 mrad in one frame. Neither was a tuning problem: the floor is simply not where a jumping foot is.
    const airPhase = Math.max(0, Math.min(1, (t - JUMP_CROUCH) / JUMP_AIR));
    const tuck = bump(airPhase);
    const engaged = activity(t, JUMP_DURATION);
    for (const side of [1, -1] as const) {
      plantFoot(out, side, pelvis,
        LEG.standY + JUMP_TUCK * tuck,
        side * 0.06 + (0.14 - side * 0.06) * tuck,
        0.30 * tuck, engaged, side * JUMP_HALF, JUMP_TOE_OUT);
    }
    add(out, 'hips', { rx: 0.10 * rise - 0.14 * fall, ty: hipsTy });   // ty also drives the leg solve
    add(out, 'spine', { rx: -0.12 * rise + 0.20 * fall });
    add(out, 'chest', { rx: -0.18 * rise + 0.30 * fall });
    add(out, 'neck', { rx: 0.10 * rise - 0.14 * fall });
    add(out, 'head', { rx: 0.06 * rise - 0.10 * fall });
  },
};

/**
 * SPEAK "Hello Everyone", then smile.
 *
 * WHY VISEMES AND NOT A JAW WAVE. A jaw opening and closing at a fixed rate reads as a puppet. Speech is
 * a sequence of shapes held for different lengths, and the shapes that matter at this scale are how far
 * the jaw is down and how wide or round the mouth is. Each syllable below is one entry: its start, its
 * length, how open, and how wide (negative is rounded, as in "o").
 *
 *   he-LLO      /h/ light, /e/ mid-wide, /l/ closed-ish, /oʊ/ rounded and held
 *   EV-ry-one   /e/ wide, /v/ nearly closed, /r/ small, /i/ wide-narrow, /w/ rounded, /ʌn/ mid then shut
 *
 * The gaps between words are real closures, because a mouth that never shuts does not read as speech.
 * Consecutive shapes are blended with a raised-cosine window, so the jaw is never asked to jump.
 */
type Viseme = { at: number; hold: number; open: number; wide: number };

const SPEECH: Viseme[] = [
  { at: 0.10, hold: 0.09, open: 0.22, wide: 0.30 },   // h
  { at: 0.19, hold: 0.13, open: 0.62, wide: 0.75 },   // e
  { at: 0.32, hold: 0.10, open: 0.18, wide: 0.20 },   // ll
  { at: 0.42, hold: 0.26, open: 0.52, wide: -0.65 },  // o, rounded and held
  { at: 0.80, hold: 0.10, open: 0.05, wide: 0.05 },   // closure between words
  { at: 0.94, hold: 0.13, open: 0.60, wide: 0.72 },   // E
  { at: 1.07, hold: 0.09, open: 0.16, wide: 0.35 },   // v
  { at: 1.16, hold: 0.09, open: 0.34, wide: 0.10 },   // ry
  { at: 1.25, hold: 0.11, open: 0.30, wide: 0.80 },   // i
  { at: 1.36, hold: 0.12, open: 0.40, wide: -0.70 },  // w
  { at: 1.48, hold: 0.14, open: 0.55, wide: 0.25 },   // u
  { at: 1.62, hold: 0.12, open: 0.10, wide: 0.15 },   // n, closing
];

const SMILE_AT = 1.90;
const SMILE_RISE = 0.42;
const SMILE_HOLD = 0.90;

const SPEAK_TIME = SMILE_AT + SMILE_RISE + SMILE_HOLD + 0.5;

/** The free hand: down at the start, turning out and opening through the greeting, then settling. */
const SPEAK_GESTURE = new Path3([
  { at: 0.00, pos: handAt(1, [0.40, -0.88, 0.06], 0.92) },
  { at: 0.16, pos: handAt(1, [0.52, -0.76, 0.30], 0.90) },
  { at: 0.34, pos: handAt(1, [0.60, -0.60, 0.50], 0.88) },
  { at: 0.60, pos: handAt(1, [0.60, -0.60, 0.50], 0.88) },
  { at: 0.80, pos: handAt(1, [0.50, -0.78, 0.30], 0.90) },
  { at: 1.00, pos: handAt(1, [0.40, -0.88, 0.06], 0.92) },
]);

export const speak: Clip = {
  name: 'speak-hello',
  label: 'Say hello',
  duration: SPEAK_TIME,
  loop: false,
  pose(t, out) {
    let open = 0;
    let wide = 0;
    for (const v of SPEECH) {
      // Raised cosine over the syllable, so every shape arrives and leaves with zero slope.
      const x = (t - v.at) / v.hold;
      if (x <= 0 || x >= 1) continue;
      const window = 0.5 - 0.5 * Math.cos(TAU * x);
      open += v.open * window;
      wide += v.wide * window;
    }
    // A smile that starts while the last syllable is still closing, which is how people actually do it.
    const smile = ease(Math.max(0, Math.min(1, (t - SMILE_AT) / SMILE_RISE)))
      * (1 - ease(Math.max(0, (t - SMILE_AT - SMILE_RISE - SMILE_HOLD) / 0.5)));

    // Negative rx drops the chin: the bone runs down and forward from the condyle.
    add(out, 'jaw', { rx: -0.30 * Math.min(1, open), tz: 0.004 * Math.min(1, open) });
    // Wide pulls the corners apart and back; rounded pushes them together and forward.
    for (const suffix of ['.L', '.R'] as const) {
      const side = suffix === '.L' ? 1 : -1;
      add(out, `lipCorner${suffix}`, {
        tx: side * (0.0055 * wide),
        tz: -0.0035 * Math.max(0, wide) + 0.0045 * Math.max(0, -wide),
        // The smile lifts the corners and takes them wider than any viseme does.
        ty: 0.0060 * smile,
      });
    }
    add(out, 'jaw', { rx: -0.05 * smile });
    // The face is not only the mouth: a smile narrows the eyes and lifts the head a little.
    add(out, 'eyelid.L', { rx: 0.10 * smile });
    add(out, 'eyelid.R', { rx: 0.10 * smile });
    add(out, 'head', { rx: -0.020 * smile, ry: 0.012 * Math.sin(t * 1.7) });
    add(out, 'neck', { rx: 0.010 * smile });

    /**
     * AND THE REST OF HER, which this clip did not touch at all.
     *
     * It drove the jaw, the lip corners and the eyelids and nothing else, so the figure delivered a
     * greeting as a statue with a moving mouth -- the arms measured a flat 28 degrees of elbow from the
     * first frame to the last. People speak with their whole body: the weight settles onto one hip, the
     * chest lifts on the first word and eases out, the head nods into the greeting, and the free hand
     * opens a little. None of it is large; all of it is the difference between speaking and being
     * ventriloquised.
     */
    const alive = activity(t, SPEAK_TIME);
    const greet = ease(clamp01((t - 0.10) / 0.45)) * (1 - ease(clamp01((t - 1.75) / 0.70)));
    const settle = ease(clamp01((t - 0.30) / 0.90));
    const stand = {
      // The weight goes onto the left hip and stays there: a stance held, not a sway repeated.
      tx: 0.020 * settle,
      ty: -0.012 * settle,
      rz: 0.030 * settle,
      ry: -0.045 * greet,
    };
    add(out, 'hips', stand);
    plantFoot(out, 1, stand, LEG.standY, 0.030 * settle, 0, alive, 0.062, 0.16);
    plantFoot(out, -1, stand, LEG.standY, -0.045 * settle, 0, alive, -0.070, 0.20);
    // The trunk follows the pelvis late, as it does everywhere else in this file.
    add(out, 'spine', { ry: 0.030 * greet, rx: -0.020 * greet });
    add(out, 'chest', { ry: 0.055 * delayed(() => greet, t, 0.10), rx: -0.030 * greet });
    add(out, 'shoulder.L', { rz: 0.06 * greet });
    add(out, 'shoulder.R', { rz: -0.04 * greet });
    // The free hand turns out and opens, the sword hand stays down: a greeting, not a surrender.
    reachHand(out, 1, bodyPoint(out, SPEAK_GESTURE.at(clamp01(t / SPEAK_TIME))), 0.35 * greet, alive);
    add(out, 'hand.L', { rz: 0.22 * greet });
  },
};

export const CLIPS: Clip[] = [walk, slash, crossGuard, spinSlash, jumpSlash, speak];

export const CLIPS_BY_NAME: Record<string, Clip> = Object.fromEntries(CLIPS.map((c) => [c.name, c]));

/**
 * The walk's own intent, exposed for measurement only.
 *
 * `measure-gait` runs the real skeleton forward; without these it can only see where the ankle ENDED UP,
 * not where the clip meant to put it, and the difference between those two is the whole question when a
 * planted foot will not stay still.
 */
export const walkInternals = { gaitFoot, hipAnchor, solveLeg, LEG, gait: GAIT };
