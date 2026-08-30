/**
 * What each joint can do, modelled as the KIND of joint it is.
 *
 * WHY NOT ONE LIMIT PER AXIS, which is where this started. Three signed ranges per joint looks like the
 * anatomical answer and it is not, for three reasons that all showed up the moment it was measured:
 *
 *   the sign of "flexion" is not shared.  A hip flexes by swinging the thigh FORWARD; a knee flexes by
 *     carrying the shin BACK. Read in one world convention, a correctly flexed knee reports 52 degrees of
 *     hyperextension.
 *   a hinge does not turn about a body axis.  The elbow's axis is the normal of the plane its own two bones
 *     lie in, tilted well off the body's medial-lateral line, so a pure elbow bend reports 40 degrees of
 *     abduction that no elbow is doing.
 *   flexion and extension stop being different at the pole.  With the arm straight up, the sagittal
 *     projection is degenerate: an overhead reach reported -180 degrees of extension.
 *
 * So joints are modelled by kind. A HINGE has one axis, taken from the rig's own geometry, a range along
 * it, and a tolerance for anything off it. A BALL has an elevation limit that DEPENDS ON DIRECTION -- a
 * shoulder lifts 175 degrees forward and 60 back -- plus its own twist range. FREE is for the pelvis, the
 * cloth and the face, which are not skeletal joints.
 *
 * Numbers are clinical active ranges for an adult, in degrees. A limit here is a claim about the BODY: if a
 * clip wants more, the clip is wrong; if a body really does more, the number is wrong.
 */

export type JointModel =
  | {
    kind: 'hinge';
    /** Degrees along the joint's own axis: [the way it must not go, the way it does]. */
    range: [number, number];
    /** How much rotation off that axis is tolerated before it stops being a hinge. */
    offAxis: number;
  }
  | {
    kind: 'ball';
    /** How far the bone may swing from rest, by the direction of the swing. */
    forward: number;
    back: number;
    /** Away from the midline, and across it. */
    lateral: number;
    medial: number;
    /** [internal, external] twist about the bone's own length. */
    twist: [number, number];
  }
  | { kind: 'free' };

const MODELS: Record<string, JointModel> = {
  // The pelvis carries the body rather than articulating against it.
  hips: { kind: 'free' },

  // Trunk. Anatomy's lumbar-plus-thoracic range, split across the two segments this rig has.
  spine: { kind: 'ball', forward: 35, back: 15, lateral: 15, medial: 15, twist: [-18, 18] },
  chest: { kind: 'ball', forward: 30, back: 15, lateral: 15, medial: 15, twist: [-22, 22] },
  neck: { kind: 'ball', forward: 30, back: 35, lateral: 25, medial: 25, twist: [-45, 45] },
  head: { kind: 'ball', forward: 25, back: 25, lateral: 20, medial: 20, twist: [-35, 35] },

  // The scapula shrugs and rolls; it does not swing.
  shoulder: { kind: 'ball', forward: 25, back: 15, lateral: 30, medial: 15, twist: [-15, 15] },
  // Glenohumeral: 175 up and forward, 60 behind, and 90 of external rotation against 70 internal.
  // `medial` is 120, not the 45 that "adduction" is usually quoted as. That 45 is adduction from a hanging
  // arm; the movement a guard actually uses is HORIZONTAL adduction -- forward, then across the chest --
  // and that reaches about 130. Quoting the smaller figure called a hand on the opposite shoulder
  // impossible, which it plainly is not.
  // `back` is 90, not the 60 that shoulder EXTENSION is quoted as. That 60 is from a hanging arm; the cone
  // an elevated arm can reach into goes 30 to 45 degrees behind the frontal plane, and the scapula supplies
  // some of it. At 60 the model called a normal overhead wind-up impossible.
  upperArm: { kind: 'ball', forward: 175, back: 90, lateral: 175, medial: 120, twist: [-70, 90] },
  // A hinge. 145 of flexion, nothing past straight, and pronation belongs to the forearm's twist bone.
  foreArm: { kind: 'hinge', range: [-2, 145], offAxis: 10 },
  /**
   * The wrist FLEXES and DEVIATES; it does not twist.
   *
   * Turning the palm over is the radius crossing the ulna -- a forearm movement, which this rig gives its
   * own bone. Pronation written on the hand therefore reads as 109 degrees of wrist twist against a joint
   * that has almost none, and the reading is right: the movement belonged on `foreArmTwist`.
   */
  hand: { kind: 'ball', forward: 80, back: 70, lateral: 30, medial: 20, twist: [-15, 15] },

  // The hip: flexes far, extends little, and that asymmetry is most of what limits a stride.
  thigh: { kind: 'ball', forward: 120, back: 20, lateral: 45, medial: 25, twist: [-40, 45] },
  // A hinge, and the one this rig had backwards for six clips.
  shin: { kind: 'hinge', range: [-5, 140], offAxis: 10 },
  /**
   * A HINGE, and modelling it as a ball was measuring the wrong thing.
   *
   * The ankle's main freedom is dorsiflexion and plantarflexion about one axis -- plantarflexion far freer,
   * which is why a push-off looks nothing like a landing. Inversion and eversion are secondary and small,
   * and true twist about the tibia is barely a joint movement at all.
   *
   * As a ball joint it reported 19 to 25 degrees of ankle TWIST on clips whose ankles were only flexing:
   * the foot bone points down AND forward, so a rotation about the medial-lateral axis has a component
   * along the bone's own length, and any decomposition about that length reads roughly a tenth of the
   * flexion as twist. That is arithmetic, not anatomy.
   *
   * The off-axis tolerance is 30 rather than something tight, because inversion and eversion are real: 35
   * and 15 degrees respectively, and a leg turned out at the hip couples some of it into the ankle.
   */
  foot: { kind: 'hinge', range: [-20, 50], offAxis: 30 },
  // The metatarsophalangeal joint extends much further than it flexes.
  toe: { kind: 'hinge', range: [-70, 40], offAxis: 10 },

  // Roll bones exist to twist and nothing else.
  upperArmTwist: { kind: 'hinge', range: [-90, 90], offAxis: 6 },
  // Pronation and supination: about 80 and 85 degrees from neutral, and this bone carries both.
  foreArmTwist: { kind: 'hinge', range: [-85, 85], offAxis: 6 },

  // Not skeletal joints.
  jaw: { kind: 'free' },
  lipCorner: { kind: 'free' },
  eyelid: { kind: 'free' },
  ponytail: { kind: 'free' },
  cloth: { kind: 'free' },
};

/** The model for a bone, by family: `shin.L` and `shin.R` share one; `cloth.B.2` uses `cloth`. */
export function jointModel(bone: string): JointModel | null {
  const family = bone
    .replace(/\.[LR]$/, '')
    .replace(/\.[FBLR]\.[0-9]+$/, '')
    .replace(/\.[0-9]+$/, '');
  return MODELS[family] ?? null;
}

/**
 * A ball joint's elevation limit in the direction it is actually swinging.
 *
 * Blended around the circle rather than switched between quadrants, because a limit that steps at 90
 * degrees of azimuth would let a pose sit just inside two sectors and outside the arc between them.
 * `azimuth` is 0 forward, +pi/2 away from the midline, pi back.
 */
export function elevationLimit(m: Extract<JointModel, { kind: 'ball' }>, azimuth: number): number {
  const c = Math.cos(azimuth);
  const s = Math.sin(azimuth);
  const fore = c >= 0 ? m.forward : m.back;
  const side = s >= 0 ? m.lateral : m.medial;
  // An ellipse through the four sector limits: exact on the axes, smooth between them.
  const denom = Math.hypot(c / fore, s / side);
  return denom > 1e-9 ? 1 / denom : Math.min(fore, side);
}
