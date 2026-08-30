/**
 * The coat, driven by the legs inside it. Stage 5 of the motion pipeline.
 *
 * THE PROBLEM, MEASURED. `scripts/measure-cloth.mjs` samples the tights -- the leg's own surface -- and
 * asks how many of those vertices end up OUTSIDE the coat. Before this module existed: 36.3% of them, by
 * as much as 264 mm. A leg outside its own coat is a leg drawn in front of it, which is what "the skirt
 * shows skin when she moves" describes. Run `?cloth=0` and the same script reproduces that figure; the
 * flag exists so the two arrangements can be compared by measurement instead of from memory.
 *
 * WHAT ACTUALLY FIXED IT, which was not what I expected. The cure is the BINDING, not the pushing. The
 * coat used to be weighted partly to the thighs and shins -- distance decides, and the hem is nearest the
 * legs -- so a swinging leg dragged the panel along with it and ended up in front of the cloth it was
 * carrying. Giving the garment its own bones takes it off the legs, and that alone takes the figure from
 * 36.3% to 0.0%. The dynamics below barely move during a walk: 0.002 rad.
 *
 * SO WHY KEEP THE DYNAMICS. Because clearance has to be guaranteed rather than hoped for, and because a
 * coat that never moves is its own defect. Measured on the other clips: the spin flares the back panel
 * 0.319 rad with the lower segments falling back behind it, and the jump's tuck pushes the right panel
 * 0.104 rad out of the knee's way. The walk simply does not happen to need it, and that is a finding, not
 * a reason to delete the mechanism that proves it.
 *
 * WHY NOT CLOTH SIMULATION. The coat is 208,342 triangles, about 110,000 vertices. Testing each of them
 * against the legs every frame is not a budget this demo has. What it does instead is what game rigs do:
 * the garment gets its own small bone chains -- four panels of three segments, twelve bones -- and only
 * those twelve are simulated. The GPU still does the skinning, so the cost is twelve springs a frame
 * regardless of how dense the mesh is.
 *
 * WHY NOT JUST WEIGHT THE COAT TO THE THIGHS. That is what it was doing, and it is the cause rather than
 * the cure: a hem rigidly following a thigh reads as a trouser leg, and the panel goes wherever the leg
 * goes -- including behind it.
 *
 * WHAT IS SIMULATED. Each panel segment has one degree of freedom: swing OUT, away from the body axis.
 * That is the direction a leg pushes a garment, and it is the only direction that resolves the defect.
 * Two forces act on it -- the legs pushing from inside, and the centrifugal flare of a turn -- and a
 * spring with an asymmetric rate carries it between them: cloth is displaced instantly and falls back
 * slowly, and a symmetric spring reads as rubber.
 */

import * as THREE from 'three';

/**
 * How wide a leg is, for the purpose of pushing cloth.
 *
 * These are the leg's actual half-widths. They were briefly 135 mm and 95 mm, inflated while chasing a
 * poke-through that turned out to be the COSTUME: the leather thigh pieces are worn over the coat and are
 * meant to be outside it, and the metric was counting them. With the metric measuring the tights -- the
 * leg's own surface -- the honest radii clear it completely, and the fat ones were flaring both side
 * panels to their limit for the whole cycle, permanently, for nothing.
 *
 * TAPERED, because a uniform cylinder is fatter than the leg at both ends. At the hip that showed at once:
 * a wide collider at the hip joint sticks out past the waist of the coat.
 */
const THIGH_RADIUS = 0.082;
const SHIN_RADIUS = 0.058;

/** Clearance kept between the leg and the inside of the coat, so contact does not read as grazing. */
const MARGIN = 0.018;

/**
 * How much narrower the live coat sits than its resting profile.
 *
 * The profile is measured in the REST pose, and the garment does not stay there: gravity pulls the lower
 * segments slightly inward -- visible in the swing readout as small negative angles -- and the pelvis moves
 * under it. So a leg can be outside the cloth while the sim, comparing against the resting profile, still
 * believes there is room. Measured that way: 21.6 mm of trailing shin outside the back panel on frames
 * where the sim computed no demand at all, and adding sample heights did not touch it, because the samples
 * were never the problem.
 */
const CLOTH_SLACK = 0.024;

/** The furthest a panel segment may be pushed. Beyond this the coat reads as an umbrella. */
const MAX_SWING = 0.32;

/**
 * THE COAT'S OWN OUTWARD EXTENT, PER PANEL, measured by scripts/measure-cloth.mjs band by band.
 *
 * Per panel and not one radius, because the coat is not a cylinder -- and the measurement said something
 * more useful than that. The FRONT has exactly one band, at the waist: below that there is no front panel
 * at all, the coat is open. So a knee swinging forward is not poking through anything, and the front chain
 * has almost nothing bound to it. The back runs from the waist to y=0.20, the sides all the way to 0.15,
 * and the right panel is consistently 20 mm wider than the left because the coat wraps that way.
 *
 * Using a single circumferential maximum instead had both errors at once: it let a knee through at the
 * front, where it thought there was 240 mm of clearance and there was no cloth at all, while flaring the
 * side panels to their limit because it thought they were narrower than they are.
 *
 * A height below a panel's lowest band means NO CLOTH THERE, which is not the same as cloth at radius
 * zero: there is nothing to push, so nothing is asked of the chain.
 */
const COAT_PROFILE: Record<string, ReadonlyArray<readonly [number, number]>> = {
  F: [[0.90, 0.117]],
  B: [[0.90, 0.127], [0.85, 0.129], [0.80, 0.130], [0.75, 0.129], [0.70, 0.144], [0.65, 0.165],
    [0.60, 0.190], [0.55, 0.212], [0.50, 0.238], [0.45, 0.262], [0.40, 0.286], [0.35, 0.313],
    [0.30, 0.335], [0.25, 0.359], [0.20, 0.367]],
  L: [[0.95, 0.176], [0.90, 0.186], [0.85, 0.193], [0.80, 0.201], [0.75, 0.209], [0.70, 0.225],
    [0.65, 0.244], [0.60, 0.261], [0.55, 0.278], [0.50, 0.293], [0.45, 0.307], [0.40, 0.321],
    [0.35, 0.335], [0.30, 0.348], [0.25, 0.361], [0.20, 0.373], [0.15, 0.380]],
  R: [[0.95, 0.201], [0.90, 0.211], [0.85, 0.216], [0.80, 0.218], [0.75, 0.222], [0.70, 0.239],
    [0.65, 0.255], [0.60, 0.271], [0.55, 0.286], [0.50, 0.304], [0.45, 0.319], [0.40, 0.335],
    [0.35, 0.351], [0.30, 0.367], [0.25, 0.380], [0.20, 0.394], [0.15, 0.403]],
};

/** A panel's resting outward extent at a height, or null where that panel has no cloth. */
function coatExtent(tag: string, y: number): number | null {
  const table = COAT_PROFILE[tag];
  if (!table || !table.length) return null;
  if (y >= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (y < last[0] - 0.05) return null;
  if (y <= last[0]) return last[1];
  for (let i = 1; i < table.length; i += 1) {
    const [yb, rb] = table[i];
    if (y >= yb) {
      const [ya, ra] = table[i - 1];
      return rb + (ra - rb) * ((y - yb) / (ya - yb));
    }
  }
  return last[1];
}

/** Attack is fast because a leg is solid; release is slow because cloth falls under gravity alone. */
const ATTACK_RATE = 26;
const RELEASE_RATE = 4.6;
/**
 * Release slowed from 7.5, which is what turns leather into silk.
 *
 * Release is how fast a segment gives up an angle it is no longer being pushed into, so it IS the material:
 * a stiff panel snaps back and a light one drifts. Halving it roughly doubles how long each ripple lives,
 * so the phase differences between segments stay visible instead of being flattened out by the return --
 * which is what makes a travelling fold read as fabric rather than as four hinged boards.
 *
 * Attack is left alone at 26. It exists so a swinging leg cannot pass THROUGH the coat, and softening that
 * would trade a look for a penetration.
 */

/**
 * How strongly each segment pulls the panel back toward hanging straight down.
 *
 * WITHOUT THIS THE COAT IS A BOARD. The chain solve on its own gives the top segment whatever angle clears
 * the widest part of the leg -- the mid-thigh -- and then the lower rings need nothing, so they stay in
 * line with it and the whole panel rotates as one rigid sheet. Measured: segment 1 swinging 0.25 rad while
 * segments 2 and 3 sat at exactly 0 through every frame of every cycle.
 *
 * Real cloth pushed at mid-thigh bulges THERE and hangs vertically below, because gravity is still acting
 * on the part that is not being pushed. So clearance is a floor on each segment's angle, not a target, and
 * what each segment actually does is fall back toward vertical as far as that floor allows.
 */
const GRAVITY_RETURN = 0.52;
/**
 * Return to vertical eased from 0.68, for the same reason as the release rate.
 *
 * This is the fraction of the swing above that a segment gives back to gravity. A heavy skirt gives back
 * most of it and hangs almost straight; a light one keeps more, so the panel carries its curve further down
 * and the hem trails. Not lowered further: below about 0.45 the panels stop returning to plumb between
 * gusts and the coat stands off the legs permanently, which reads as starched, not as silk.
 */

/**
 * How much a turn flares the coat outward.
 *
 * Squared in the rate, because this is the centrifugal term: a spin throws a hem out in proportion to
 * omega squared, which is why the spin-slash flares and the walk barely does. An earlier attempt used a
 * TANGENTIAL drag instead, which is the other real effect and cannot be expressed here at all -- a panel
 * whose only freedom is to swing outward has no way to be dragged sideways, so that term was pretending.
 */
const FLARE_GAIN = 0.020;

/**
 * A slow ambient sway, so the coat is never dead still.
 *
 * THIS REPLACES A PER-VERTEX WAVE. The idle layer used to run a travelling lift over the coat's own
 * vertices -- all 110,000 of them, every frame -- which was measured at 32 ms per tick on its own and was
 * also a second mechanism moving a garment that now has bones of its own. Two things driving one panel is
 * a defect regardless of what it costs.
 *
 * Each panel AND each segment gets its own phase, so nothing breathes in unison. Applied per segment
 * rather than to the panel as a whole: as a cumulative target it only ever moved the top segment, because
 * the lower ones then had nothing left to ask for -- measured at 2.84 mrad of hem motion, which the gate
 * caught. Air pushes on the whole surface, not on the waist.
 */
const BREEZE_RAD = 0.105;

/**
 * What the turntable adds to the breeze, as a multiple of its resting amount.
 *
 * The coat has no real input left -- `clearance` needs a swinging leg and `flare` a turning hip, and with
 * the action clips gone it gets neither -- so while the orbit runs the air is treated as moving instead.
 * Physically this is theatre: the camera is what turns. It is also what was asked for, and at 1.9x the hem
 * travels far enough to read as silk being carried round rather than as a hanging panel.
 */
const BREEZE_TURN_GAIN = 1.9;

/** Seconds for the coat to take up, or give up, the turntable's share. Slower than the hair: more mass. */
const BREEZE_EASE_S = 1.6;

/**
 * A second, much slower breeze period layered under the first.
 *
 * One sine per segment gives every fold the same dwell, and a fabric read comes from folds that outlast
 * each other. This beats against the primary term so the panel is never twice in the same state, which is
 * the cheapest thing that stops a loop from being visible.
 */
const BREEZE_SLOW_RAD = 0.055;
/**
 * Raised from 0.010 rad, and the reason is that the coat lost its other two drivers.
 *
 * Both real inputs are now zero for the whole of a showcase: `clearance` needs a leg swinging inside the
 * panel and `flare` needs a hip turning, and with the action clips gone neither ever happens -- the
 * turntable moves the CAMERA, so the body it orbits does not rotate at all and there is no rate of turn to
 * flare against. At 0.010 rad the breeze was a rounding error under those two, which was the right size
 * while they were live and leaves a dead sheet of leather now that they are not.
 *
 * 0.105 rad is per SEGMENT and per segment phase, so it accumulates down the chain against
 * `GRAVITY_RETURN` instead of rotating the panel as a board -- which is what makes the hem trail the waist
 * rather than swing with it, and why this reads as cloth and not as a hinged plate. Still an order of
 * magnitude inside `MAX_SWING`, so a leg that does demand room continues to win outright.
 */

type Panel = {
  tag: string;
  /** Outward direction in the XZ plane. */
  dx: number;
  dz: number;
  /** Which channel swings this panel outward, and with which sign. */
  channel: 'rx' | 'rz';
  sign: number;
  bones: THREE.Bone[];
  /** Ring heights and radii, from the skeleton's own cloth ring table. */
  rings: Array<{ y: number; r: number }>;
  /** Current angle per segment, and the value it is being pulled toward. */
  angle: number[];
};

type Collider = { bone: THREE.Bone; tail: THREE.Vector3; radius: number };

export type ClothRig = { update(dt: number): void };

/**
 * Wire the coat's bones to the legs inside it.
 *
 * `bones` is the skeleton's name -> bone map. Missing bones are tolerated: a rig built before the cloth
 * bones existed should animate exactly as it did, not throw.
 */
export function createClothDynamics(
  bones: Record<string, THREE.Bone | undefined>, root: THREE.Object3D,
  /** How hard the viewer's turntable is turning, 0..1. Absent means a still camera. */
  sway?: () => number,
): ClothRig | null {
  const RINGS = [
    { y: 0.900, r: 0.150 },
    { y: 0.650, r: 0.210 },
    { y: 0.400, r: 0.290 },
    { y: 0.150, r: 0.350 },
  ];
  const SPEC: Array<{ tag: string; dx: number; dz: number; channel: 'rx' | 'rz'; sign: number }> = [
    // Positive rx swings a downward bone toward -Z, so the FRONT panel needs a negative one to go out.
    { tag: 'F', dx: 0, dz: 1, channel: 'rx', sign: -1 },
    { tag: 'B', dx: 0, dz: -1, channel: 'rx', sign: 1 },
    // Positive rz swings it toward +X.
    { tag: 'L', dx: 1, dz: 0, channel: 'rz', sign: 1 },
    { tag: 'R', dx: -1, dz: 0, channel: 'rz', sign: -1 },
  ];

  const panels: Panel[] = [];
  for (const s of SPEC) {
    const chain: THREE.Bone[] = [];
    for (let i = 1; i < RINGS.length; i += 1) {
      const bone = bones[`cloth.${s.tag}.${i}`];
      if (bone) chain.push(bone);
    }
    if (chain.length !== RINGS.length - 1) return null;
    panels.push({ ...s, bones: chain, rings: RINGS, angle: chain.map(() => 0) });
  }

  const colliders: Collider[] = [];
  for (const [name, radius] of [
    ['thigh.L', THIGH_RADIUS], ['thigh.R', THIGH_RADIUS],
    ['shin.L', SHIN_RADIUS], ['shin.R', SHIN_RADIUS],
  ] as const) {
    const bone = bones[name];
    if (bone) colliders.push({ bone, tail: new THREE.Vector3(), radius });
  }

  const hips = bones.hips;
  const head = new THREE.Vector3();
  const point = new THREE.Vector3();
  const axis = new THREE.Vector3();
  let lastHipYaw = 0;
  let swayEased = 0;
  let elapsed = 0;

  /**
   * How far out, in metres, a leg demands the coat be at a given height.
   *
   * Each collider is sampled along its own length and projected onto the panel's outward direction; the
   * projection plus the leg's tapered radius plus a margin is where the inside of the cloth has to be.
   * The window is deliberately narrow -- this is asked about one height, at a ring, not about a band.
   *
   * MEASURED FROM THE BODY AXIS, not from the world origin. The cloth bones hang off the pelvis, so the
   * coat's radius profile is in the pelvis's frame; the legs' world position is not. Comparing the two
   * directly charged the cloth for the pelvis's 22 mm of lateral sway, which it moves with -- enough on
   * its own to drive a panel into its 0.32 rad limit for no reason at all.
   */
  const demandAt = (panel: Panel, y: number): number => {
    let reach = -Infinity;
    for (const c of colliders) {
      c.bone.getWorldPosition(head);
      // A bone's tail is its first child's origin; with none, extend along the bone's own axis.
      const child = c.bone.children.find((o) => (o as THREE.Bone).isBone) as THREE.Bone | undefined;
      if (child) child.getWorldPosition(c.tail);
      else c.tail.set(head.x, head.y - 0.36, head.z);
      for (let k = 0; k <= 8; k += 1) {
        point.copy(head).lerp(c.tail, k / 8);
        if (Math.abs(point.y - y) > 0.07) continue;
        const taper = 0.55 + 0.45 * Math.sin(Math.PI * (k / 8));
        const proj = (point.x - axis.x) * panel.dx + (point.z - axis.z) * panel.dz
          + c.radius * taper + MARGIN;
        if (proj > reach) reach = proj;
      }
    }
    return reach;
  };

  return {
    update(dt: number): void {
      const step = Math.min(dt, 1 / 30);
      elapsed += step;
      root.updateMatrixWorld(true);

      // A turn flares the hem. Rate of turn, not the angle: a coat on a body that has stopped turning
      // hangs straight, however far round it has come.
      if (hips) hips.getWorldPosition(axis); else axis.set(0, 0, 0);
      const yaw = hips ? hips.rotation.y : 0;
      const yawRate = (yaw - lastHipYaw) / Math.max(step, 1e-4);
      lastHipYaw = yaw;

      // Eased rather than sampled raw, so pressing the turntable button does not step the whole coat.
      swayEased += ((sway ? sway() : 0) - swayEased) * Math.min(1, step / BREEZE_EASE_S);
      const breezeScale = 1 + BREEZE_TURN_GAIN * swayEased;

      for (let pi = 0; pi < panels.length; pi += 1) {
        const panel = panels[pi];
        const flare = FLARE_GAIN * yawRate * yawRate;
        /**
         * SOLVED AS A CHAIN, one ring at a time, which the first version was not.
         *
         * That version gave each segment the angle its own BAND demanded and then subtracted the parent's.
         * Two things went wrong and the measurement showed both. A demand near a segment's own head has
         * almost no lever on that segment -- `extra / 0.04` -- so the angle came out enormous, and the two
         * upper segments both pinned to the limit for a total of 0.64 rad, which on screen was a pair of
         * stiff black wings. Meanwhile the subtraction drove the LOWEST segment to exactly zero on every
         * frame of every cycle, so the hem never moved at all and the coat bent only at the waist.
         *
         * The chain is what fixes it: ask how far out the cloth must be at each ring, and how far the
         * segments above have already carried it. What is left is this segment's job, over its own full
         * length, which is a real lever.
         */
        let carried = 0;                 // outward displacement already delivered, in metres
        let angleSoFar = 0;              // world swing of the segment above, in radians
        for (let i = 0; i < panel.bones.length; i += 1) {
          const top = panel.rings[i];
          const bottom = panel.rings[i + 1];
          const length = Math.hypot(top.y - bottom.y, bottom.r - top.r);
          // Clearance is a FLOOR on this segment's angle: it must at least carry the cloth clear of the
          // leg. Sampled at the segment's MIDPOINT as well as its end, because a leg's widest point is
          // rarely at a ring, and each sample is converted with its own lever -- a bulge halfway along has
          // only half the segment's length to work with.
          //
          // NO DEMAND MEANS NO CONSTRAINT, not a constraint of zero. Writing this as `asin(0)` made the
          // floor 0 rad, and `max(0, gravity)` is 0 for every negative gravity there is -- so the lower
          // segments stayed at exactly 0 and the panel went on rotating as one board.
          let clearance = -MAX_SWING;
          // Four heights per segment. Two was not enough: a trailing shin bulged between them and the
          // measurement found 21 mm of leg outside the back panel while the sim saw no demand at all.
          for (const f of [0.25, 0.5, 0.75, 1]) {
            const y = top.y + (bottom.y - top.y) * f;
            const rest = coatExtent(panel.tag, y);
            if (rest === null) continue;              // no cloth at this height on this panel
            const have = rest - CLOTH_SLACK;
            const reach = demandAt(panel, y);
            if (reach === -Infinity) continue;
            const need = reach - have - carried;
            if (need <= 0) continue;
            clearance = Math.max(clearance, Math.asin(Math.min(0.95, need / (f * length))));
          }
          // Each segment on its own clock: same amplitude, different period and phase.
          const breeze = breezeScale * (
            BREEZE_RAD
              * Math.sin(elapsed * (0.37 + pi * 0.062 + i * 0.13) + pi * 1.9 + i * 0.8)
              * (0.6 + 0.4 * Math.sin(elapsed * 0.19 + pi + i))
            // The slow layer. Its phase runs DOWN the chain (`i * 0.55`) rather than being scattered, so
            // successive segments reach their extreme in order and the fold travels toward the hem instead
            // of the whole panel arriving at once.
            + BREEZE_SLOW_RAD
              * Math.sin(elapsed * (0.14 + pi * 0.021) - i * 0.55 + pi * 0.8)
          );
          const gravity = -angleSoFar * GRAVITY_RETURN + breeze;
          let target = Math.max(clearance, gravity, flare - angleSoFar);
          target = Math.min(MAX_SWING, Math.max(-MAX_SWING, target));

          const rate = target > panel.angle[i] ? ATTACK_RATE : RELEASE_RATE;
          panel.angle[i] += (target - panel.angle[i]) * Math.min(1, rate * step);
          angleSoFar += panel.angle[i];
          carried += length * Math.sin(angleSoFar);
          const swing = panel.sign * panel.angle[i];
          if (panel.channel === 'rx') panel.bones[i].rotation.x = swing;
          else panel.bones[i].rotation.z = swing;
        }
      }
    },
  };

}
