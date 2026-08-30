import * as THREE from 'three';

/**
 * Idle animation for the dual-sword warrior.
 *
 * WHY IT IS NOT SKINNED. The figure has no skeleton — it is procedural geometry, and the reference
 * asset carries no skin or animation data either (`skinCount: 0`, `animationCount: 0`), so there is
 * nothing to bind against and nothing to import. Idle motion is therefore split between two
 * mechanisms, chosen per body part by what the motion actually is:
 *
 *  - RIGID PIVOTS for parts that swing as a unit — the arms about the shoulder, the ponytail about
 *    its tie, the eyelids about the eye centre. A pivot is a parent Group, never a registered part,
 *    so the viewer's explode (which writes mesh positions) and this (which writes group rotations)
 *    compose instead of fighting.
 *  - VERTEX DISPLACEMENT for parts that deform — the chest expanding, the skirt hem lifting. A rigid
 *    transform cannot express either: a breathing chest changes shape, and a hem that swung as a
 *    rigid body would read as a bell, not as cloth.
 *
 * EVERYTHING IS DETERMINISTIC. Every value is a function of elapsed time through hash-based pseudo
 * noise, with no `Math.random()` anywhere. Two runs at the same timestamp are identical, which is
 * what keeps a captured frame reproducible and a render diff meaningful.
 *
 * The viewer strips `userData.tick` in capture mode, so evaluation frames render the rest pose.
 */

/** Amplitudes, in metres and radians, on a figure 1.75 m tall. */
const BREATH_PERIOD_S = 4.0;        // 15 breaths/min, resting adult
const BREATH_CHEST_MM = 5.5;        // real quiet-breathing chest excursion is 5-10 mm
const BREATH_SHOULDER_MM = 2.0;
/**
 * The bust bounce.
 *
 * Soft tissue does not follow the skeleton, it LAGS it, and that lag is the whole reason a bounce reads
 * as flesh instead of as a pulsing balloon. So the amplitude below is driven through a damped spring
 * whose target is the breath plus whatever vertical acceleration the body is under -- which means the
 * same code carries the walk's bob and the landing from a jump without either clip knowing about it.
 *
 * Numbers chosen to stay inside what a supported chest actually does: 7 mm of travel, a natural
 * frequency around 4.5 Hz, damping just under critical so there is one visible follow-through and not a
 * wobble.
 */
const BUST_TRAVEL_MM = 7.0;
const BUST_STIFFNESS = 800;         // (2*pi*4.5)^2, near enough
const BUST_DAMPING = 9.0;
const ARM_SWING_RAD = 0.022;        // ~1.3 degrees
/**
 * Ponytail sway.
 *
 * Raised from 0.055 rad. At ~3 degrees the tip travelled about 8 mm, which is inside the noise of the
 * silhouette at demo framing -- the hair was moving and nobody could see it. 7 degrees of drive measures
 * 15 mm of tip travel across each axis (the spring keeps the realised swing near 3.5 degrees, well under
 * the drive), which reads as hanging hair rather than as a pendulum.
 */
const PONYTAIL_SWING_RAD = 0.122;   // ~7.0 degrees

/**
 * What the turntable adds to the hair, as a multiple of the resting sway.
 *
 * At rest the tail keeps the ~7 degrees above, which reads as hanging hair in still air. While the orbit
 * runs it is asked to look as though the figure were turning under it, and 2.4x drive carries the tip from
 * about 15 mm of travel to the mid-40s -- clearly moving at demo framing, and still nothing like a strike.
 * Eased in and out rather than switched, because hair that snapped to a new amplitude the instant a button
 * was pressed would read as a different rig, not as a draught.
 */
const PONYTAIL_TURN_GAIN = 1.4;

/** Seconds for the hair to take up, or give up, the turntable's share of its motion. */
const SWAY_EASE_S = 1.1;
const HEM_LIFT_MM = 9.0;
const BLINK_CLOSE_S = 0.13;         // a human blink is 100-150 ms
const BLINK_MIN_GAP_S = 2.6;
const BLINK_MAX_GAP_S = 6.4;

/** Deterministic value noise in one dimension, smooth and periodic-free. */
function hash1(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453123;
  return s - Math.floor(s);
}

function valueNoise(t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  return (hash1(i) * (1 - u) + hash1(i + 1) * u) * 2 - 1;
}

/** A mesh whose vertices this module moves, with its rest state and a per-vertex weight. */
interface DeformTarget {
  /**
   * Second weight, for the bust bounce. Separate from `weight` because the two motions are different
   * shapes: the breath is a wide radial swell across the whole chest, and the bounce is a narrow
   * vertical one centred on the bust. Sharing one weight would make the bounce move the collarbone.
   */
  bust?: Float32Array;
  geometry: THREE.BufferGeometry;
  rest: Float32Array;
  /** 0 = never moves, 1 = full amplitude */
  weight: Float32Array;
}

export interface IdleRig {
  /** shoulder pivots — rotated, never translated */
  armPivots: { left: THREE.Object3D | null; right: THREE.Object3D | null };
  ponytailPivot: THREE.Object3D | null;
  eyelids: { left: THREE.Object3D | null; right: THREE.Object3D | null };
  /** chest/torso meshes that expand with the breath */
  breathing: DeformTarget[];
  /** skirt panels whose hems lift */
  hems: DeformTarget[];
  /**
   * The object the clips move vertically, if any. Read only to measure acceleration, which is what
   * drives the bust bounce during a walk or a landing.
   */
  body?: THREE.Object3D | null;
  /**
   * How hard the viewer's turntable is turning, 0..1, sampled per frame. Optional: a rig without it
   * simply keeps the resting amount of motion.
   */
  sway?: () => number;
}

/**
 * Build a per-vertex weight from a height band.
 *
 * `full` is where the motion is at maximum and `zero` where it dies out; between them the ramp is
 * smoothstep, because a linear ramp leaves a visible crease at both ends.
 */
export function heightWeight(
  geometry: THREE.BufferGeometry,
  fullY: number,
  zeroY: number,
): Float32Array {
  const position = geometry.getAttribute('position');
  const weight = new Float32Array(position.count);
  const span = fullY - zeroY || 1;
  for (let i = 0; i < position.count; i += 1) {
    let t = (position.getY(i) - zeroY) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    weight[i] = t * t * (3 - 2 * t);
  }
  return weight;
}

export function makeDeformTarget(
  geometry: THREE.BufferGeometry,
  weight: Float32Array,
  bust?: Float32Array,
): DeformTarget {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  return {
    geometry,
    rest: Float32Array.from(position.array as Float32Array),
    weight,
    bust,
  };
}

/**
 * A weight that peaks inside a band and dies out either side of it, for a motion that belongs to one
 * feature rather than to everything above a line. `heightWeight` is a ramp and cannot do that: a ramp
 * from the waist up puts as much motion on the collarbone as on the bust.
 */
export function bandWeight(
  geometry: THREE.BufferGeometry,
  centreY: number,
  halfSpan: number,
  maxRadius: number,
): Float32Array {
  const position = geometry.getAttribute('position');
  const weight = new Float32Array(position.count);
  for (let i = 0; i < position.count; i += 1) {
    const dy = Math.abs(position.getY(i) - centreY) / halfSpan;
    // Only the front of the body: a bust bounce on the back is a lump.
    const z = position.getZ(i);
    const radial = Math.hypot(position.getX(i), z);
    if (dy >= 1 || z <= 0 || radial > maxRadius) continue;
    const along = 1 - dy * dy;
    const forward = Math.max(0, z) / Math.max(radial, 1e-6);
    weight[i] = along * along * forward;
  }
  return weight;
}

/**
 * The blink schedule.
 *
 * Blinks are irregular in a way a sine wave is not — a periodic blink reads as a tic. Gaps are
 * drawn deterministically from the blink index, so the sequence is unpredictable to the eye and
 * identical between runs.
 *
 * Returns 0 fully open, 1 fully closed.
 */
export function blinkAmount(elapsed: number): number {
  // Walk forward through blink slots until the one containing `elapsed` is found. The loop is
  // bounded by construction: every gap is at least BLINK_MIN_GAP_S.
  let t = 0;
  for (let index = 0; index < 4096; index += 1) {
    const gap = BLINK_MIN_GAP_S
      + (hash1(index * 7.13 + 0.5)) * (BLINK_MAX_GAP_S - BLINK_MIN_GAP_S);
    if (elapsed < t + gap) return 0;
    t += gap;
    if (elapsed < t + BLINK_CLOSE_S) {
      const phase = (elapsed - t) / BLINK_CLOSE_S;
      // Close fast, open slightly slower — the asymmetry is what makes a blink read as a blink.
      return phase < 0.4
        ? phase / 0.4
        : 1 - (phase - 0.4) / 0.6;
    }
    t += BLINK_CLOSE_S;
  }
  return 0;
}

/**
 * The rotation a driven pivot rests at, captured before anything has moved it.
 *
 * THE IDLE LAYER OWNS THESE CHANNELS ABSOLUTELY. It used to ADD its rotations instead, which was safe
 * only because a clip animator ran ahead of it and reset every bone to rest at the top of every frame --
 * so `+=` meant "breathe on top of whatever the clip is doing". When the action clips were removed that
 * reset went with them, and an added rotation had nothing left to return it: the arm swing is a random
 * walk about zero, so it walked. A page left sitting still wound the right upper arm 514 degrees round and
 * put the hand above the head.
 *
 * Writing `rest + offset` is idempotent by construction, so it no longer matters whether anything runs
 * first, and nothing has to reset a bone on this layer's behalf.
 */
interface RestRotation {
  object: THREE.Object3D;
  x: number;
  z: number;
}

function restRotation(object: THREE.Object3D | null): RestRotation | null {
  return object ? { object, x: object.rotation.x, z: object.rotation.z } : null;
}

/**
 * Install the idle ticker on a group.
 *
 * The returned function is what the viewer calls each frame; it is also assigned to
 * `group.userData.tick`, which is the hook the viewer discovers.
 */
export function installIdleAnimation(group: THREE.Group, rig: IdleRig): void {
  const scratch = new THREE.Vector3();

  // Captured NOW, before the first tick: these are the authored bind-pose rotations, and every frame
  // writes them plus its own offset. See `RestRotation`.
  const armRest = {
    left: restRotation(rig.armPivots.left),
    right: restRotation(rig.armPivots.right),
  };
  const ponytailRest = restRotation(rig.ponytailPivot);
  const lidRest = [restRotation(rig.eyelids.left), restRotation(rig.eyelids.right)];

  // Ponytail lag state. The tie leads and the mass follows, which is the whole reason hair reads as
  // hair: driving the ponytail directly off the same phase as the body makes it look welded on.
  let ponytailAngle = 0;
  let ponytailVelocity = 0;
  let bustOffset = 0;
  let bustVelocity = 0;
  // Eased, not sampled raw: see PONYTAIL_TURN_GAIN.
  let swayEased = 0;
  let lastBodyY = rig.body ? rig.body.position.y : 0;
  let lastBodyVelocity = 0;

  const tick = (dt: number, elapsed: number): void => {
    // A tab that was backgrounded returns one enormous dt; integrating it throws the spring.
    const step = Math.min(dt, 1 / 20);

    // ---- how much the turntable is contributing this frame -------------------------------------
    const swayTarget = rig.sway ? rig.sway() : 0;
    swayEased += (swayTarget - swayEased) * Math.min(1, step / SWAY_EASE_S);
    const swingScale = 1 + PONYTAIL_TURN_GAIN * swayEased;

    // ---- breathing ---------------------------------------------------------------------------
    const breathPhase = (elapsed / BREATH_PERIOD_S) * Math.PI * 2;
    // Not a sine: inhale is quicker than exhale, and a symmetric wave reads as a pump.
    const rawBreath = Math.sin(breathPhase);
    const breath = rawBreath >= 0 ? Math.pow(rawBreath, 0.75) : -Math.pow(-rawBreath, 1.25);

    // ---- bust bounce ---------------------------------------------------------------------------
    // The spring is integrated once per frame, not per target, so both sides stay in phase with each
    // other. Its driver is the breath plus the body's own vertical acceleration, measured from the root
    // rather than passed in: that is what makes the walk's bob and a jump's landing show up here without
    // any clip having to ask.
    let bodyY = rig.body ? rig.body.position.y : 0;
    const bodyVelocity = (bodyY - lastBodyY) / Math.max(step, 1e-4);
    const bodyAcceleration = (bodyVelocity - lastBodyVelocity) / Math.max(step, 1e-4);
    lastBodyY = bodyY;
    lastBodyVelocity = bodyVelocity;
    const bustDriver = breath * 0.55 - Math.max(-40, Math.min(40, bodyAcceleration)) * 0.010;
    bustVelocity += (bustDriver - bustOffset) * BUST_STIFFNESS * step;
    bustVelocity -= bustVelocity * BUST_DAMPING * step;
    bustOffset += bustVelocity * step;
    const bust = Math.max(-1.6, Math.min(1.6, bustOffset));

    for (const target of rig.breathing) {
      const position = target.geometry.getAttribute('position') as THREE.BufferAttribute;
      const array = position.array as Float32Array;
      for (let i = 0; i < position.count; i += 1) {
        const w = target.weight[i];
        const b = target.bust ? target.bust[i] : 0;
        if (w === 0 && b === 0) continue;
        const o = i * 3;
        const rx = target.rest[o];
        const ry = target.rest[o + 1];
        const rz = target.rest[o + 2];
        // Expand along the horizontal radial direction: a chest grows outward, not upward.
        scratch.set(rx, 0, rz);
        const radius = scratch.length();
        const scale = radius > 1e-5 ? (BREATH_CHEST_MM / 1000) * breath * w / radius : 0;
        // The bounce drops and lifts, and swings slightly forward as it does -- soft tissue on a hinge,
        // not a piston.
        const drop = (BUST_TRAVEL_MM / 1000) * bust * b;
        array[o] = rx + rx * scale;
        array[o + 1] = ry + (BREATH_SHOULDER_MM / 1000) * breath * w - drop;
        array[o + 2] = rz + rz * scale + drop * 0.35;
      }
      position.needsUpdate = true;
      target.geometry.computeVertexNormals();
    }

    // ---- arms --------------------------------------------------------------------------------
    // Two different periods so the pair never looks mechanically synchronised, and both carry a
    // slow noise term so the motion does not loop visibly.
    //
    // REST PLUS OFFSET, never `+=`. This layer is now the only thing writing these bones, so there is no
    // clip pose to add on top of and nothing upstream that would undo an accumulation. See `RestRotation`.
    if (armRest.left) {
      armRest.left.object.rotation.z = armRest.left.z + ARM_SWING_RAD
        * (Math.sin(elapsed * 0.62) * 0.6 + valueNoise(elapsed * 0.21) * 0.4);
      armRest.left.object.rotation.x = armRest.left.x
        + ARM_SWING_RAD * 0.5 * Math.sin(elapsed * 0.44 + 1.1);
    }
    if (armRest.right) {
      armRest.right.object.rotation.z = armRest.right.z - ARM_SWING_RAD
        * (Math.sin(elapsed * 0.55 + 2.3) * 0.6 + valueNoise(elapsed * 0.19 + 7) * 0.4);
      armRest.right.object.rotation.x = armRest.right.x
        + ARM_SWING_RAD * 0.5 * Math.sin(elapsed * 0.48 + 2.7);
    }

    // ---- ponytail ----------------------------------------------------------------------------
    // A damped spring chasing a slow target. The lag is the point: the mass arrives after the
    // impulse, which is what a rigid offset cannot express.
    if (ponytailRest) {
      const driver = PONYTAIL_SWING_RAD * swingScale
        * (valueNoise(elapsed * 0.33) * 0.7 + Math.sin(elapsed * 0.51) * 0.3);
      // A SECOND AXIS, on its own slower clock. Driving x and z from one number swings the tail in a single
      // plane, which is a hinge rather than hair; an independent lateral term traces the shallow figure of
      // eight that a hanging mass actually describes.
      const lateral = PONYTAIL_SWING_RAD * 0.42 * swingScale
        * (Math.sin(elapsed * 0.29 + 0.7) * 0.65 + valueNoise(elapsed * 0.17 + 3.5) * 0.35);
      const stiffness = 26;
      const damping = 6.2;
      ponytailVelocity += (driver - ponytailAngle) * stiffness * step;
      ponytailVelocity -= ponytailVelocity * damping * step;
      ponytailAngle += ponytailVelocity * step;
      ponytailRest.object.rotation.x = ponytailRest.x + ponytailAngle;
      ponytailRest.object.rotation.z = ponytailRest.z + ponytailAngle * 0.55 + lateral;
    }

    // ---- skirt hem ---------------------------------------------------------------------------
    // A wave travelling around the circumference rather than one global lift, so opposite sides of
    // the skirt are never at the same phase — a uniform lift reads as a bell being rung.
    for (const target of rig.hems) {
      const position = target.geometry.getAttribute('position') as THREE.BufferAttribute;
      const array = position.array as Float32Array;
      for (let i = 0; i < position.count; i += 1) {
        const w = target.weight[i];
        if (w === 0) continue;
        const o = i * 3;
        const rx = target.rest[o];
        const ry = target.rest[o + 1];
        const rz = target.rest[o + 2];
        const azimuth = Math.atan2(rz, rx);
        const wave = Math.sin(elapsed * 1.15 + azimuth * 2.4)
          * 0.6 + valueNoise(elapsed * 0.42 + azimuth) * 0.4;
        const lift = (HEM_LIFT_MM / 1000) * wave * w;
        array[o] = rx + rx * lift * 0.5;
        array[o + 1] = ry + lift * 0.55;
        array[o + 2] = rz + rz * lift * 0.5;
      }
      position.needsUpdate = true;
      target.geometry.computeVertexNormals();
    }

    // ---- blink -------------------------------------------------------------------------------
    const closed = blinkAmount(elapsed);
    for (const lid of lidRest) {
      if (!lid) continue;
      // The lid is a shell that sweeps down over the eye. Scaling it would squash the curvature, so
      // it rotates about the eye centre instead — which is what an eyelid does.
      //
      // Absolute, for the same reason as the arms: `+=` here drove the lids a further 1.85 rad into the
      // skull on every frame of every blink, and they never came back out.
      lid.object.rotation.x = lid.x + closed * 1.85;
    }
  };

  group.userData.tick = tick;
}
