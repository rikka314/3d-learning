import * as THREE from 'three';
import { CLIPS, CLIPS_BY_NAME, type Clip, type Pose } from './clips';
import { armStateOf, deltaQuaternion, poseFK, reachHand } from './motion';
import {
  angleBetween, dampingOf, matchPhase, rateOf, rotationVector, settleTime, stepSpring, vectorRotation,
} from './transition';

/**
 * Plays clips on the rig, and carries the body from whatever it was doing into whatever it is asked for.
 *
 * WHY A LAYER AND NOT A REPLACEMENT. The breath is not a behaviour you switch to -- the figure breathes
 * while it walks and while it holds a guard -- so it is applied on top of whatever clip is running,
 * additively, and only the channels a clip actually writes are taken from the clip. That is also what
 * lets a clip stay small: `walk` says nothing about the ponytail or the eyelids, so the idle keeps
 * driving them.
 *
 * HOW A CHANGE OF ACTION WORKS, and it is not a cross-fade. At the instant of the switch the difference
 * between where the body IS -- pose and velocity, read off the rig itself -- and where the incoming clip
 * wants it is measured once, and from then on the body plays the incoming clip with that difference decaying
 * to nothing through a damped spring per joint. `transition.ts` records what a cross-fade did instead and
 * the four distinct one-frame steps it produced; the short version is that interpolating between two
 * endpoints which are both still moving means re-deciding the path every frame, and every such decision can
 * flip.
 *
 * What the arrangement gives, in the order it was asked for:
 *
 *   A RESUME POINT. A cycle is rejoined at the phase the body is already in, not at its own beginning. A
 *   resumed walk used to restart 30 to 45 degrees from the pose it was holding, while an identical pose sat
 *   elsewhere in the same cycle.
 *
 *   A REST POINT. An action that has finished is held for a beat before the body picks up what it was doing.
 *
 *   HUMAN SPEED. The settle time comes from the size of the offset and the speed the slowest-arriving joint
 *   actually has, bounded so that no joint is ever asked to move faster in a transition than it can move in
 *   an action. It ranges from 0.16 to 0.6 s across the 30 ordered pairs of clips, where one fixed 0.28 s
 *   implied anything from 155 to 529 deg/s.
 *
 *   PROXIMAL FIRST, AND A SETTLE. The spring is stiffer near the pelvis and slightly under-damped out at the
 *   hands, so the body commits from the ground up while the far end overshoots a little and settles, which
 *   is what momentum does to a limb.
 *
 * The rest pose is captured once, at construction, and every clip is additive over it. The clip layer is a
 * pure function of time and cannot drift; the springs are integrated, but they only ever decay towards zero,
 * so a dropped frame costs a slightly different arrival and nothing permanent.
 */
/** Used where there is no offset worth measuring -- the very first clip, and fading out to the idle alone. */
const DEFAULT_SETTLE = 0.28;

/** The beat of stillness at the end of an action, before the body picks up what it was doing. */
const HOLD_S = 0.14;

/** How far ahead to look when measuring how fast the incoming clip is moving a joint. */
const PROBE = 0.04;

/**
 * The bones whose offset is NOT held as a rotation.
 *
 * A rotation offset decays about a fixed axis, which is fine for a joint whose offset is small and wrong for
 * a shoulder whose offset can be most of a half turn: measured, a wrist travelled 106 mm INSIDE the torso on
 * its way from `spin-slash` to `jump-slash`, against 20 mm for the closest any clip brings its own hand to
 * the chest. An arm's offset is held in the arm's own coordinates instead -- how far it is raised, which way,
 * how far out, and where the elbow sits -- so what decays is a hand swinging round the shoulder rather than
 * a humerus turning about an arbitrary axis. There is no path to re-decide here either: the offset is fixed
 * at the switch, azimuth wrapped once, and only its size changes after that.
 */
const ARM_IK = new Set([
  'upperArm.L', 'upperArm.R', 'foreArm.L', 'foreArm.R',
  'upperArmTwist.L', 'upperArmTwist.R', 'foreArmTwist.L', 'foreArmTwist.R',
]);

/**
 * An arm's difference from the clip: the rotation between the two aim directions, how much further out the
 * wrist is, where the elbow sits on its cone, and how far the forearm is rolled. Each with its rate.
 */
type ArmOffset = {
  aim: THREE.Vector3;
  aimRate: THREE.Vector3;
  reach: number; pole: number; pronate: number;
  rates: { reach: number; pole: number; pronate: number };
  /**
   * WHAT THE SOLVER CANNOT REPRODUCE, per bone, and why it has to be carried separately.
   *
   * The solver reproduces a hand's PLACE. It does not reproduce arbitrary joint angles, because the arms it
   * writes are constrained -- the elbow turns only about its own axis, the roll is determined by the aim and
   * the pole -- and not every clip writes its arms that way. `walk` and `speak-hello` write theirs as plain
   * channels, so an arm read out of them and solved back lands the wrist in the same place with the elbow a
   * few degrees off. Small, and it arrives in ONE FRAME at each end of a transition: measured at 3.8 degrees
   * on the forearm, 8 rad/s and 958 rad/s^2, at the same value for every clip leaving `speak-hello` --
   * because the first frames of a transition are the body's own pose whatever it is heading towards.
   *
   * So the difference is measured at both ends and handed over: the body's at the start, the clip's at the
   * finish, and a slerp between them in between. Both are a few degrees, so there is nothing here that can
   * go the wrong way round.
   */
  residual: Map<string, THREE.Quaternion>;
  /** Decays 1 -> 0 alongside the rest, and chooses between the two residuals. */
  carry: number;
  carryRate: number;
};
const ARM_PARTS = ['reach', 'pole', 'pronate'] as const;

/** Above this much difference at the shoulder, an arm is carried as an arc rather than as a rotation. */
const ARM_ARC_ABOVE = (10 * Math.PI) / 180;

/** How long the leftover from an arc-carried arm takes to fade once the arc itself is done. */
const HANDOVER_SETTLE = 0.3;

/**
 * How far into the incoming clip to look for its own fast parts, and how many samples.
 *
 * As far as the longest settle can run, because the headroom the decay is given has to hold for the whole
 * time the decay lasts -- not just at the instant of the switch. Sampling only the first 40 ms missed the
 * jump's takeoff at 260 ms, where its knee is already turning at 16.6 rad/s, so the decay was handed the
 * full budget and the two together came out at 17.6 against a knee's 17.
 */
const BUSY_WINDOW = 0.6;
const BUSY_SAMPLES = 10;

export type AnimatorRig = {
  bones: Record<string, THREE.Bone | undefined>;
  /** Rotated and translated as a whole, for a jump or a spin. Retargetable -- see `setRoot`. */
  root: THREE.Object3D | null;
};

type Rest = { position: THREE.Vector3; quaternion: THREE.Quaternion };

/** One joint's difference from the clip, and how fast that difference is changing. Both decay to zero. */
type Offset = {
  rotation: THREE.Vector3;
  rotationRate: THREE.Vector3;
  translation: THREE.Vector3;
  translationRate: THREE.Vector3;
  /** Its own settle time, where it was not created by a change of clip. */
  settle?: number;
};

export class Animator {
  private readonly rest = new Map<string, Rest>();

  private readonly pose: Pose = {};

  private current: Clip | null = null;

  /** The clip returned to when a one-shot finishes. */
  private base: Clip | null = null;

  private currentTime = 0;

  /** Per-bone difference between the body and the clip, decaying to nothing. Empty once settled. */
  private readonly offsets = new Map<string, Offset>();

  /** The same thing for the two arms, in their own coordinates. */
  private readonly armOffsets = new Map<string, ArmOffset>();

  /** The clip's pose with the offsets folded in, which is what the arm solver has to stand on. */
  private readonly composed: Pose = {};

  /** The clip's own arm channels for this frame, so a solve can be attempted more than once. */
  private readonly armBase: Pose = {};

  private settle = DEFAULT_SETTLE;

  /** Counts down the beat at the end of an action; nothing advances while it runs. */
  private hold = 0;

  /** Last frame's bone rotations, so a switch can measure how fast the body was already moving. */
  private readonly lastBody = new Map<string, THREE.Quaternion>();

  private lastStep = 1 / 60;

  private rootOffset = 0;

  private readonly rootOffsetRate = { value: 0 };

  private rootYawOffset = 0;

  private readonly rootYawOffsetRate = { value: 0 };

  private rootRest: { y: number; yaw: number } | null = null;

  constructor(private readonly rig: AnimatorRig) {
    for (const [name, bone] of Object.entries(rig.bones)) {
      if (!bone) continue;
      this.rest.set(name, { position: bone.position.clone(), quaternion: bone.quaternion.clone() });
      this.lastBody.set(name, bone.quaternion.clone());
    }
    if (rig.root) this.rootRest = { y: rig.root.position.y, yaw: rig.root.rotation.y };
  }

  /**
   * Point the root motion at a different object.
   *
   * Needed because this model rebuilds itself when its code-split surfaces arrive, and the rebuild is a
   * fresh call to the builder: it produces a NEW group, and only that group's children and userData are
   * moved across into the one the scene is holding. The animator kept the group it was built with, which
   * by then was an orphan, so a jump lifted an object nobody was drawing and a spin turned it -- while
   * the bones, which really had moved across, animated correctly. The clip looked like it had no root
   * motion at all.
   */
  setRoot(root: THREE.Object3D | null): void {
    this.rig.root = root;
    this.rootRest = root ? { y: root.position.y, yaw: root.rotation.y } : null;
  }

  /** What the controls need to draw themselves: no name parsing, no duplicated label table. */
  get clipList(): Array<{ name: string; label: string; loop: boolean; duration: number }> {
    return CLIPS.map((c) => ({ name: c.name, label: c.label, loop: c.loop, duration: c.duration }));
  }

  get playing(): string | null {
    return this.current?.name ?? null;
  }

  /** Start a clip. A looping clip also becomes the one that one-shots return to. */
  play(name: string): boolean {
    const clip = CLIPS_BY_NAME[name];
    if (!clip) return false;
    if (this.current === clip) return true;
    const hadClip = this.current !== null;
    this.current = clip;
    this.hold = 0;
    if (clip.loop) this.base = clip;
    this.beginTransition(hadClip);
    return true;
  }

  /** Stop clip playback and hand the rig back to the idle layer alone. */
  stop(): void {
    const hadClip = this.current !== null;
    this.current = null;
    this.hold = 0;
    this.beginTransition(hadClip);
  }

  /**
   * Measure the difference between the body and the incoming clip, once.
   *
   * Reads the rig rather than the outgoing clip, because the body may still be settling out of an earlier
   * change -- the bones hold what is actually on screen and a clip does not.
   */
  private beginTransition(hadClip: boolean): void {
    const clip = this.current;
    // A cycle is joined where the body already is. A one-shot is not: a slash beginning halfway through its
    // own swing is not a slash.
    this.currentTime = clip && clip.loop && hadClip
      ? matchPhase(clip.duration, (t) => this.clipRotations(clip, t), this.bodyRotations())
      : 0;
    this.offsets.clear();
    this.armOffsets.clear();
    if (!hadClip) {
      this.settle = DEFAULT_SETTLE;
      this.rootOffset = 0;
      this.rootYawOffset = 0;
      this.rootOffsetRate.value = 0;
      this.rootYawOffsetRate.value = 0;
      return;
    }

    const want = this.clipRotations(clip, this.currentTime);
    const soon = this.clipRotations(clip, this.currentTime + PROBE);
    const size = new Map<string, number>();
    const busy = this.clipBusy(clip);

    for (const [name, rest] of this.rest) {
      const bone = this.rig.bones[name];
      if (!bone) continue;
      const target = want.get(name)!;
      // The offset lives in the bone's OWN frame -- what the clip's rotation has to be followed by to land
      // on the body's -- so the clip can turn underneath it without the offset coming to mean something
      // else.
      const offset: Offset = {
        rotation: rotationVector(new THREE.Vector3(), target.clone().invert().multiply(bone.quaternion)),
        rotationRate: new THREE.Vector3(),
        translation: bone.position.clone().sub(rest.position),
        translationRate: new THREE.Vector3(),
      };
      // AND THE VELOCITY OFFSET, which is what lets the body leave its old motion at the speed it was
      // already moving. Without it, the first frame of every change is a step in velocity: the output takes
      // up the incoming clip's speed at once and the body's own momentum simply disappears.
      const was = this.lastBody.get(name);
      if (was) {
        const bodyRate = rotationVector(scratchVec, was.clone().invert().multiply(bone.quaternion))
          .multiplyScalar(1 / this.lastStep);
        const clipRate = rotationVector(scratchOtherVec, target.clone().invert().multiply(soon.get(name)!))
          .multiplyScalar(1 / PROBE);
        offset.rotationRate.copy(bodyRate).sub(clipRate);
      }
      this.offsets.set(name, offset);
      size.set(name, offset.rotation.length());
    }

    // THE ARMS, in their own coordinates. The clip's arm is read on the BODY's trunk rather than its own, so
    // that at the instant of the switch the reconstruction lands exactly where the body already is: the
    // trunk offset is full then, and it moves the shoulder with it.
    const bodyPose = this.poseFrom((n) => this.rig.bones[n]?.quaternion);
    const wasPose = this.poseFrom((n) => this.lastBody.get(n));
    const clipPose: Pose = {};
    if (clip) clip.pose(clip.loop ? this.currentTime % clip.duration : this.currentTime, clipPose);
    const onBodyTrunk: Pose = { ...bodyPose };
    for (const name of ARM_IK) {
      if (clipPose[name]) onBodyTrunk[name] = clipPose[name];
      else delete onBodyTrunk[name];
    }
    const soonPose: Pose = {};
    if (clip) {
      clip.pose(clip.loop ? (this.currentTime + PROBE) % clip.duration
        : Math.min(this.currentTime + PROBE, clip.duration), soonPose);
    }
    const onBodyTrunkSoon: Pose = { ...bodyPose };
    for (const name of ARM_IK) {
      if (soonPose[name]) onBodyTrunkSoon[name] = soonPose[name];
      else delete onBodyTrunkSoon[name];
    }
    for (const side of [1, -1] as const) {
      const suffix = side > 0 ? '.L' : '.R';
      const body = armStateOf(bodyPose, side);
      const want = armStateOf(onBodyTrunk, side);
      const wasArm = armStateOf(wasPose, side);
      const wantSoon = armStateOf(onBodyTrunkSoon, side);
      // THE ROTATION FROM WHERE THE CLIP AIMS TO WHERE THE BODY AIMS, decided here and never again.
      const aim = rotationVector(new THREE.Vector3(),
        scratchOther.setFromUnitVectors(want.dir, body.dir));
      // Its rate is how fast the body was turning its aim, less how fast the clip is turning its own.
      const bodyTurn = rotationVector(scratchVec,
        scratchOther.setFromUnitVectors(wasArm.dir, body.dir)).multiplyScalar(1 / this.lastStep);
      const clipTurn = rotationVector(scratchOtherVec,
        scratchOther.setFromUnitVectors(want.dir, wantSoon.dir)).multiplyScalar(1 / PROBE);
      const offset: ArmOffset = {
        residual: new Map(),
        carry: 1,
        carryRate: 0,
        aim: this.wayRound(bodyPose, suffix, aim, body.dir, want, body.reach),
        aimRate: bodyTurn.clone().sub(clipTurn),
        reach: body.reach - want.reach,
        pole: shortestTurn(body.pole - want.pole),
        pronate: shortestTurn(body.pronate - want.pronate),
        rates: {
          reach: (body.reach - wasArm.reach) / this.lastStep - (wantSoon.reach - want.reach) / PROBE,
          pole: shortestTurn(body.pole - wasArm.pole) / this.lastStep
            - shortestTurn(wantSoon.pole - want.pole) / PROBE,
          pronate: shortestTurn(body.pronate - wasArm.pronate) / this.lastStep
            - shortestTurn(wantSoon.pronate - want.pronate) / PROBE,
        },
      };
      /**
       * WHICH MECHANISM CARRIES THIS ARM, decided here and held for the whole settle.
       *
       * Two are needed, because neither is right everywhere:
       *
       *   A ROTATION OFFSET ON THE BONES, like every other joint. Its round trip is exact -- nothing is
       *   solved, so nothing can be lost -- but it decays about a fixed axis, and for a shoulder most of a
       *   half turn from where it is going that axis took a wrist 106 mm inside the torso.
       *
       *   A ROTATION OF THE AIM, re-solved. Its path is an arc about the shoulder and stays out of the body,
       *   but the solver reproduces a hand's PLACE and not a clip's exact joint angles, so for the clips that
       *   write their arms as plain channels -- `walk`, `speak-hello` -- the arm comes back a few degrees
       *   off, and those degrees arrive in one frame at each end.
       *
       * So the arc is used for any difference worth the name -- ten degrees at the shoulder -- and the bone
       * offset keeps only the cases too small to bend a path anywhere.
       *
       * The threshold was thirty, on the reasoning that a small offset cannot bow far enough into the body to
       * matter. That reasoning depends on where the hands ARE: once the walk held its swords with the elbows
       * bent for carrying, its hands sat close enough to the chest that a 25-degree offset decaying about a
       * fixed axis took a wrist 47 mm inside it -- while no clip's own pose goes inside at all. Ten degrees
       * puts every case that could reach the body on the arc, which is the only mechanism that can choose to
       * go around. Decided once per transition, so it cannot change mid-movement.
       */
      if (aim.length() < ARM_ARC_ABOVE) continue;
      this.armOffsets.set(suffix, offset);
      // The body's residual, measured once: solve the arm onto where the body's wrist actually is, on the
      // body's own trunk, and see how far the joints end up from the body's own.
      const probe: Pose = { ...bodyPose };
      // `solveInto` restores the arm from `armBase`, which is only filled while writing a frame -- so it has
      // to be filled here too, or the probe solves from whatever the last frame left behind. It did, and the
      // residual it measured was nonsense: 41 degrees of shoulder arriving in the first frame of
      // `jump-slash` into `walk`, 85.6 rad/s, from a correction meant to be worth a few degrees.
      for (const name of ARM_IK) {
        if (clipPose[name]) {
          probe[name] = clipPose[name];
          this.armBase[name] = clipPose[name];
        } else {
          delete probe[name];
          delete this.armBase[name];
        }
      }
      this.solveInto(probe, side, suffix, offset, 1);
      for (const name of ARM_IK) {
        if (!name.endsWith(suffix)) continue;
        const solved = deltaQuaternion(probe[name], new THREE.Quaternion());
        offset.residual.set(name, solved.invert().multiply(
          deltaQuaternion(bodyPose[name], scratchOther).clone(),
        ));
      }
      // What sizes the settle for a shoulder is the ARC ITS HAND SWEEPS, which is exactly the angle of that
      // rotation -- not the angle between two shoulder rotations, which counts roll the hand does not feel.
      size.set(`upperArm${suffix}`, aim.length());
    }
    this.settle = settleTime(size, busy);

    if (this.rig.root && this.rootRest) {
      const at = clip?.root?.(this.currentTime);
      this.rootOffset = this.rig.root.position.y - this.rootRest.y - (at?.y ?? 0);
      this.rootYawOffset = this.rig.root.rotation.y - this.rootRest.yaw - (at?.yaw ?? 0);
    }
  }

  /**
   * The fastest the incoming clip moves each joint by itself while the offset is decaying.
   *
   * What is left of a joint's speed for the decay is its peak minus what the clip is already spending, and
   * the clip's spending is not constant: a jump is nearly still for its first tenth of a second and then
   * extends a knee at 16.6 rad/s. So this is the maximum across the window, not a reading at the switch.
   */
  private clipBusy(clip: Clip | null): Map<string, number> {
    const out = new Map<string, number>();
    if (!clip) return out;
    const h = BUSY_WINDOW / BUSY_SAMPLES;
    let previous = this.clipRotations(clip, this.currentTime);
    for (let i = 1; i <= BUSY_SAMPLES; i += 1) {
      const now = this.clipRotations(clip, this.currentTime + i * h);
      for (const [name, q] of now) {
        const rate = angleBetween(previous.get(name)!, q) / h;
        if (rate > (out.get(name) ?? 0)) out.set(name, rate);
      }
      previous = now;
    }
    return out;
  }

  /**
   * WHICH WAY ROUND THE HAND GOES, when the short way is through the chest.
   *
   * The offset that carries the clip's aim onto the body's is a rotation, and the SHORTEST such rotation
   * traces the shortest arc -- which is right nearly always, and wrong when the two ends are on opposite
   * sides of the body: measured, a wrist 59 mm inside the torso leaving `spin-slash`, against 20 mm for the
   * closest any clip brings its own hand to its chest.
   *
   * The fix is not to shove the hand out of the way. That was tried: pushing the target clear each frame
   * fights the solver in exactly the region where the arm is folded up and the shoulder is most sensitive,
   * and it cost 50 rad/s and 5,404 rad/s^2 to save 20 mm. It is to pick a different rotation. Every rotation
   * of the form exp(phi * bodyAim) * Q carries the clip's aim to the same place, for any phi -- they differ
   * only in the path taken -- so the way round is a free choice, and this makes it once, before the movement
   * starts, by trying eight of them and taking the one whose arc stays out of the body. Ties go to the
   * smallest turn, so the ordinary case is the shortest arc, unchanged.
   */
  private wayRound(
    bodyPose: Pose, suffix: string, minimal: THREE.Vector3,
    bodyDir: THREE.Vector3, want: { dir: THREE.Vector3; reach: number }, bodyReach: number,
  ): THREE.Vector3 {
    const hips = poseFK(bodyPose, 'hips').pos;
    const neck = poseFK(bodyPose, 'neck').pos;
    const shoulder = poseFK(bodyPose, `upperArm${suffix}`);
    const parent = poseFK(bodyPose, `shoulder${suffix}`);
    const cx = (hips.x + neck.x) / 2;
    const cz = (hips.z + neck.z) / 2;
    const deepest = (turn: THREE.Vector3): number => {
      let worst = 0;
      for (let i = 1; i < 8; i += 1) {
        const s = i / 8;
        const dir = scratchDir.copy(want.dir)
          .applyQuaternion(vectorRotation(scratchOther, scratchVec.copy(turn).multiplyScalar(s)));
        const wrist = scratchTarget.copy(dir)
          .multiplyScalar(want.reach + (bodyReach - want.reach) * s)
          .applyQuaternion(parent.rot).add(shoulder.pos);
        if (wrist.y < hips.y - 0.02 || wrist.y > neck.y) continue;
        const r = Math.hypot((wrist.x - cx) / GATE_A, (wrist.z - cz) / GATE_B);
        if (r < 1) worst = Math.max(worst, (1 - r) * ((GATE_A + GATE_B) / 2));
      }
      return worst;
    };
    let best = minimal;
    let bestDeep = deepest(minimal);
    if (bestDeep <= 0.02) return best;
    // SIXTEEN, not eight. The plane of the arc is a continuous parameter and eight samples of it is coarse:
    // measured on `cross-guard` into `walk`, the best of eight still took a wrist 47 mm inside the chest,
    // where no clip's own pose goes inside it at all. The search runs once per transition, so the extra
    // candidates cost nothing that matters.
    for (const phi of [
      0.39, -0.39, 0.79, -0.79, 1.18, -1.18, 1.57, -1.57,
      1.96, -1.96, 2.36, -2.36, 2.75, -2.75, 3.14,
    ]) {
      const candidate = rotationVector(new THREE.Vector3(),
        scratchQuat.setFromAxisAngle(bodyDir, phi).multiply(vectorRotation(scratchOther, minimal)));
      const deep = deepest(candidate);
      if (deep < bestDeep - 0.002) {
        bestDeep = deep;
        best = candidate;
      }
    }
    return best;
  }

  /** A pose built from some source of absolute local rotations -- the bones now, or the bones last frame. */
  private poseFrom(source: (name: string) => THREE.Quaternion | undefined): Pose {
    const out: Pose = {};
    for (const [name, rest] of this.rest) {
      const q = source(name);
      if (!q) continue;
      out[name] = { q: rest.quaternion.clone().invert().multiply(q) };
    }
    return out;
  }

  /** Where the body is right now, as absolute local rotations. */
  private bodyRotations(): Map<string, THREE.Quaternion> {
    const out = new Map<string, THREE.Quaternion>();
    for (const [name] of this.rest) {
      const bone = this.rig.bones[name];
      if (bone) out.set(name, bone.quaternion.clone());
    }
    return out;
  }

  /** A clip's absolute local rotations at a time. No clip means the rest pose, which is what that is. */
  private clipRotations(clip: Clip | null, time: number): Map<string, THREE.Quaternion> {
    const pose: Pose = {};
    if (clip) clip.pose(clip.loop ? time % clip.duration : Math.min(time, clip.duration), pose);
    const out = new Map<string, THREE.Quaternion>();
    for (const [name, rest] of this.rest) {
      deltaQuaternion(pose[name], scratchQuat);
      out.set(name, rest.quaternion.clone().multiply(scratchQuat));
    }
    return out;
  }

  update(dt: number): void {
    // CLIP TIME ADVANCES BY THE REAL dt, unlike the springs in the idle layer.
    //
    // Clamping to 1/20 s is right for anything integrated -- a spring given one enormous step explodes --
    // and wrong here: a clip is a pure function of time, so clamping does not protect it, it just makes it
    // run in slow motion whenever the frame rate drops below 20. It showed up as a one-shot that had not
    // handed back 4.2 seconds into a 3.72-second clip, because the headless run renders 1.6 M triangles
    // at well under 20 fps and the clock was running at half speed.
    //
    // The cap is still there, generously: after a tab has been in the background, dt arrives in seconds,
    // and jumping a quarter of a second per frame is preferable to skipping a whole one-shot.
    const step = Math.min(dt, 0.25);

    // THE REST POINT. An action that has finished is held for a moment before the body picks up what it was
    // doing. Nothing advances during it -- the clip's clock is still and the offsets do not decay -- so the
    // pose that stands is exactly the one the action ended on.
    if (this.hold > 0) {
      this.hold -= step;
    } else {
      this.currentTime += step;
      this.decay(step);
    }

    // A one-shot that has run out goes back to the looping clip it interrupted.
    //
    // THE OFFSET IS MEASURED HERE, not when the hold expires, and the order matters. The bones still hold
    // last frame's pose at this point, so measuring now captures the pose the action finished on; the hold
    // then simply stops the decay, and what stands still for that beat is exactly that pose. Measuring later
    // instead left one frame with the new clip written and no offset yet, and the body snapped to it: 28.8
    // rad/s through the chest at the last frame of `spin-slash`, which is a whole torso jumping in 8 ms.
    if (this.current && !this.current.loop && this.currentTime >= this.current.duration) {
      const back = this.base;
      this.current = back && back !== this.current ? back : null;
      this.beginTransition(true);
      this.hold = HOLD_S;
    }

    // Reset to rest, then write the clip and whatever is left of the offset. Absolute every frame.
    for (const [name, rest] of this.rest) {
      const bone = this.rig.bones[name];
      if (!bone) continue;
      bone.position.copy(rest.position);
      bone.quaternion.copy(rest.quaternion);
    }
    for (const key of Object.keys(this.pose)) delete this.pose[key];
    if (this.current) {
      const clip = this.current;
      const t = clip.loop ? this.currentTime % clip.duration : Math.min(this.currentTime, clip.duration);
      clip.pose(t, this.pose);
    }
    this.write();
    this.applyRoot();

    for (const [name, bone] of Object.entries(this.rig.bones)) {
      if (bone) this.lastBody.get(name)?.copy(bone.quaternion);
    }
    this.lastStep = Math.max(1e-4, step);
  }

  /** Pull every offset towards zero. Once one is negligible it is dropped and the clip plays clean. */
  private decay(step: number): void {
    for (const [suffix, arm] of this.armOffsets) {
      const lambda = rateOf(`upperArm${suffix}`, this.settle);
      const zeta = dampingOf(`upperArm${suffix}`);
      let quiet = true;
      for (const axis of AXES) {
        rateHolder.value = arm.aimRate[axis];
        arm.aim[axis] = stepSpring(arm.aim[axis], rateHolder, lambda, zeta, step);
        arm.aimRate[axis] = rateHolder.value;
      }
      rateHolder.value = arm.carryRate;
      arm.carry = stepSpring(arm.carry, rateHolder, lambda, zeta, step);
      arm.carryRate = rateHolder.value;
      for (const part of ARM_PARTS) {
        rateHolder.value = arm.rates[part];
        arm[part] = stepSpring(arm[part], rateHolder, lambda, zeta, step);
        arm.rates[part] = rateHolder.value;
        // A twentieth of a degree, and a rate of a third of a degree per second. Tighter than this and the
        // offset never retires, which matters: while it is alive the arms go through the solver every frame
        // instead of straight from the clip.
        if (Math.abs(arm[part]) > 5e-4 || Math.abs(arm.rates[part]) > 5e-3) quiet = false;
      }
      if (quiet) this.handBack(suffix);
    }
    if (!this.offsets.size) return;
    for (const [name, offset] of this.offsets) {
      const lambda = rateOf(name, offset.settle ?? this.settle);
      const zeta = dampingOf(name);
      for (const axis of AXES) {
        rateHolder.value = offset.rotationRate[axis];
        offset.rotation[axis] = stepSpring(offset.rotation[axis], rateHolder, lambda, zeta, step);
        offset.rotationRate[axis] = rateHolder.value;
        rateHolder.value = offset.translationRate[axis];
        offset.translation[axis] = stepSpring(offset.translation[axis], rateHolder, lambda, zeta, step);
        offset.translationRate[axis] = rateHolder.value;
      }
      if (offset.rotation.lengthSq() < 1e-9 && offset.rotationRate.lengthSq() < 1e-7
        && offset.translation.lengthSq() < 1e-12 && offset.translationRate.lengthSq() < 1e-10) {
        this.offsets.delete(name);
      }
    }
    const lambda = rateOf('hips', this.settle);
    const zeta = dampingOf('hips');
    this.rootOffset = stepSpring(this.rootOffset, this.rootOffsetRate, lambda, zeta, step);
    this.rootYawOffset = stepSpring(this.rootYawOffset, this.rootYawOffsetRate, lambda, zeta, step);
  }

  /**
   * HANDING AN ARM BACK TO THE CLIP, without a step.
   *
   * When the arc has run out the arm should stop going through the solver -- but the solved arm and the
   * clip's own are not the same thing for a clip that writes its arms as plain channels, so simply stopping
   * steps by the difference. Measured leaving the jump into the walk: 85.6 rad/s at the shoulder.
   *
   * So the difference is measured here, where both are this frame's, and installed as an ordinary bone
   * offset for the springs to decay. With its OWN settle time, which is the part the first attempt got wrong:
   * reusing the transition's settle meant a fresh offset decaying at a rate chosen for a movement that had
   * already finished, and it came out faster than the movement itself.
   */
  private handBack(suffix: string): void {
    for (const name of ARM_IK) {
      if (!name.endsWith(suffix)) continue;
      const bone = this.rig.bones[name];
      const rest = this.rest.get(name);
      if (!bone || !rest) continue;
      deltaQuaternion(this.pose[name], scratchQuat);
      const handover = rotationVector(new THREE.Vector3(),
        rest.quaternion.clone().multiply(scratchQuat).invert().multiply(bone.quaternion));
      if (handover.lengthSq() > 1e-8) {
        this.offsets.set(name, {
          rotation: handover,
          rotationRate: new THREE.Vector3(),
          translation: new THREE.Vector3(),
          translationRate: new THREE.Vector3(),
          settle: HANDOVER_SETTLE,
        });
      }
    }
    this.armOffsets.delete(suffix);
  }

  /** The clip's pose, then whatever is left of the offset, onto the bones. */
  private write(): void {
    const solving = this.armOffsets.size > 0;
    const solved = (name: string): boolean =>
      solving && ARM_IK.has(name) && this.armOffsets.has(name.endsWith('.L') ? '.L' : '.R');
    const composed = this.composed;
    for (const key of Object.keys(composed)) delete composed[key];
    const names = new Set<string>([...Object.keys(this.pose), ...this.offsets.keys()]);
    for (const name of names) {
      const bone = this.rig.bones[name];
      const rest = this.rest.get(name);
      if (!bone || !rest) continue;
      const delta = this.pose[name];
      const offset = solved(name) ? undefined : this.offsets.get(name);
      deltaQuaternion(delta, scratchQuat);
      if (offset) scratchQuat.multiply(vectorRotation(scratchOther, offset.rotation));
      const tx = (delta?.tx ?? 0) + (offset?.translation.x ?? 0);
      const ty = (delta?.ty ?? 0) + (offset?.translation.y ?? 0);
      const tz = (delta?.tz ?? 0) + (offset?.translation.z ?? 0);
      if (delta || offset) bone.quaternion.copy(rest.quaternion).multiply(scratchQuat);
      if (tx || ty || tz) bone.position.set(rest.position.x + tx, rest.position.y + ty, rest.position.z + tz);
      // The solver reads the trunk out of a pose, and the trunk it has to stand on is the OFFSET one -- the
      // hand target is carried by the chest, so a shoulder still on its way home moves the target with it.
      if (solving) composed[name] = { q: scratchQuat.clone(), tx, ty, tz };
    }
    if (!solving) return;

    // The clip's own arm channels, kept aside so each attempt at a solve starts from them.
    for (const key of Object.keys(this.armBase)) delete this.armBase[key];
    for (const name of ARM_IK) {
      const at = composed[name];
      if (at) this.armBase[name] = at;
    }

    for (const [suffix, arm] of this.armOffsets) {
      const side = suffix === '.L' ? 1 : -1;
      this.solveInto(composed, side, suffix, arm, 1);
      for (const name of ARM_IK) {
        if (!name.endsWith(suffix)) continue;
        const bone = this.rig.bones[name];
        const rest = this.rest.get(name);
        if (!bone || !rest) continue;
        deltaQuaternion(composed[name], scratchQuat);
        // The body's residual, fading out: what the solver could not reproduce about the pose the body was
        // actually in. Without it the first frame of a transition steps by it.
        const toBody = arm.residual.get(name);
        if (toBody) {
          scratchOther.identity().slerp(toBody, Math.max(0, Math.min(1, arm.carry)));
          scratchQuat.multiply(scratchOther);
        }
        bone.quaternion.copy(rest.quaternion).multiply(scratchQuat);
      }
    }
  }

  /**
   * Put one arm where the clip wants it, displaced by `scale` of its remaining offset.
   *
   * The clip's own arm channels are restored first because `add` MULTIPLIES into what is already in the pose,
   * so a second attempt on the same pose would compound the first rather than replace it.
   */
  private solveInto(
    composed: Pose, side: 1 | -1, suffix: string, arm: ArmOffset, scale: number,
  ): void {
    // READ THE ARM, THEN CLEAR IT. Both halves matter and getting the second one wrong was subtle: reading
    // the clip's arm needs its channels present, but `add` MULTIPLIES into whatever is already in the pose,
    // so leaving them there made the solver stack its answer on top of the clip's own rotation instead of
    // replacing it. The shoulder came out roughly squared -- climbing 5.5 degrees a frame to 158, while the
    // clip alone never passes 66 -- and it looked like a runaway integration rather than the transcription
    // error it was. A copy, too: five attempts at a solve are made per frame and each must start clean.
    for (const name of ARM_IK) {
      if (!name.endsWith(suffix)) continue;
      const original = this.armBase[name];
      if (original) composed[name] = { ...original }; else delete composed[name];
    }
    const at = armStateOf(composed, side);
    for (const name of ARM_IK) {
      if (name.endsWith(suffix)) delete composed[name];
    }
    // The clip's own aim, turned by what is left of the offset rotation.
    scratchDir.copy(arm.aim).multiplyScalar(scale);
    scratchTarget.copy(at.dir).applyQuaternion(vectorRotation(scratchOther, scratchDir));
    const shoulder = poseFK(composed, `upperArm${suffix}`);
    const parent = poseFK(composed, `shoulder${suffix}`);
    scratchTarget.multiplyScalar(Math.max(0.05, at.reach + arm.reach * scale))
      .applyQuaternion(parent.rot).add(shoulder.pos);
    reachHand(composed, side, scratchTarget,
      at.pole + arm.pole * scale, 1, at.pronate + arm.pronate * scale, true);
  }

  private applyRoot(): void {
    if (!this.rig.root || !this.rootRest) return;
    const at = this.current?.root?.(Math.min(this.currentTime, this.current.duration));
    this.rig.root.position.y = this.rootRest.y + (at?.y ?? 0) + this.rootOffset;
    this.rig.root.rotation.y = this.rootRest.yaw + (at?.yaw ?? 0) + this.rootYawOffset;
  }
}

/** The torso in plan, as an ellipse -- the same surface the gate measures against. */
const GATE_A = 0.125;
const GATE_B = 0.098;

const AXES = ['x', 'y', 'z'] as const;
const rateHolder = { value: 0 };
const scratchQuat = new THREE.Quaternion();
const scratchOther = new THREE.Quaternion();
const scratchVec = new THREE.Vector3();
const scratchOtherVec = new THREE.Vector3();
const scratchDir = new THREE.Vector3();
const scratchTarget = new THREE.Vector3();

/** The short way round for an angle difference: a joint does not travel 350 degrees to arrive at 10. */
function shortestTurn(d: number): number {
  let x = d;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}
