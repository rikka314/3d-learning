import * as THREE from 'three';
import {
  buildRigidSemanticWeights,
  buildSkeleton,
  compileCharacterActions,
  createStylizedCharacterIR,
  type CharacterActionSpec,
  type CharacterAnimationController,
  type CharacterIR,
  type RigJoint,
  type SkeletonBuildResult,
} from '../../character';
import {
  WARRIOR_SOURCE_ACTIONS,
  WARRIOR_SOURCE_ANIMATION_SHA256,
} from './sourceAnimationData';
import { installDualQuaternionSkinning } from './dualQuaternionSkinning';
import { WARRIOR_TRIPO1_CLEARANCE } from './tripo1ClearanceData';
import { WARRIOR_TRIPO4_CLEARANCE } from './tripo4ClearanceData';

const IDENTITY = [0, 0, 0, 1] as const;

/**
 * Six-view physical-ID-confirmed semantic segments. Most reconstructed
 * surfaces bind to one joint because their disconnected topology provides no
 * trustworthy deformation loops. Only measured toe, cloth and whisker spans
 * receive controlled multi-bone blends. The former broad XYZ split tore
 * garments and assigned hand vertices to hips and knees.
 */
export const WARRIOR_NODE_JOINT_BINDINGS: Readonly<Record<number, string>> = {
  41: 'hat-back', 42: 'head', 43: 'head', 44: 'head',
  45: 'right-knee', 46: 'left-knee', 47: 'right-shoulder', 48: 'right-foot',
  49: 'head', 50: 'left-shoulder', 51: 'right-wrist', 52: 'pelvis',
  53: 'head', 54: 'staff-grip', 55: 'coat-front', 56: 'left-elbow',
  57: 'left-hand', 58: 'right-elbow', 59: 'cheese-pendulum', 60: 'hat-back',
  61: 'chest', 62: 'left-wrist', 63: 'coat-front', 64: 'coat-right',
  65: 'head', 66: 'mouse-tail', 67: 'coat-right', 68: 'left-ankle',
  69: 'head', 70: 'head', 71: 'hat-back', 72: 'head', 73: 'whisker-73-base',
  74: 'whisker-74-base', 75: 'sash-tail', 76: 'whisker-76-base', 77: 'whisker-77-base', 78: 'head',
  79: 'left-toes', 80: 'pelvis', 81: 'head', 82: 'left-toes',
  83: 'left-toes', 84: 'coat-left', 85: 'ear-left', 86: 'ear-right', 87: 'head',
};

/**
 * Node 48's printed Surface Nets quantiles. The q75-q90 forward interval is
 * the toe transition; the q50-q75 height interval prevents the lower-leg
 * vertices on the same connected surface from inheriting toe motion.
 */
export const RIGHT_TOE_BLEND = {
  zStart: 0.05108693614602089,
  zEnd: 0.07322245836257935,
  yStart: 0.026644552126526833,
  yEnd: 0.07388334721326828,
} as const;

/**
 * These disconnected surfaces cross real articulation spans. Their printed
 * q0-q100 bounds overlap the corresponding measured source-rest joints, so
 * each vertex is projected to the closest measured bone segment instead of
 * being rigidly assigned to one joint.
 */
export const WARRIOR_ARTICULATED_CHAINS: Readonly<Record<number, readonly string[]>> = {
  45: ['right-hip', 'right-knee'],
  46: ['left-hip', 'left-knee'],
  47: ['right-shoulder', 'right-elbow'],
  48: ['right-knee', 'right-ankle', 'right-foot', 'right-toes'],
  50: ['left-shoulder', 'left-elbow'],
  51: ['right-elbow', 'right-wrist', 'right-hand'],
  52: ['pelvis', 'chest'],
  56: ['left-shoulder', 'left-elbow'],
  58: ['right-shoulder', 'right-elbow'],
  62: ['left-elbow', 'left-wrist', 'left-hand'],
  68: ['left-knee', 'left-ankle', 'left-foot'],
} as const;

/**
 * The outer tunic panels are disconnected garment shells, not deforming leg
 * surfaces. Their measured Victory Dance q99 edge stretch (1.866x/1.960x)
 * came from the hip-knee blend, so they stay rigid on a dedicated coat driver
 * for every action. The driver follows the measured hip-to-knee direction and
 * applies a symmetric coverage offset without changing shell topology.
 */
export const WARRIOR_PERMANENT_RIGID_GARMENT_BINDINGS = {
  64: 'coat-right',
  84: 'coat-left',
} as const;

/** Measured q10-q90 spans on the long axis of each thin cloth panel. */
export const WARRIOR_CLOTH_BLEND = {
  55: { axis: 'y', lower: 0.20970630645751953, upper: 0.3223254382610321, outward: -1 },
  75: { axis: 'x', lower: 0.24491139501333237, upper: 0.4341798722743988, outward: 1 },
} as const;

/** Per-whisker q25-q75 lateral spans; direction identifies the free end. */
export const WARRIOR_WHISKER_BLEND = {
  73: { lower: 0.11363939009606838, upper: 0.146514642983675, outward: 1 },
  74: { lower: -0.06832398846745491, upper: -0.036022529006004333, outward: -1 },
  76: { lower: 0.10784351080656052, upper: 0.17028097808361053, outward: 1 },
  77: { lower: -0.09061650559306145, upper: -0.029004428535699844, outward: -1 },
} as const;

/**
 * Printed Surface Nets long-axis quantiles for the flexible tail and ears.
 * These intervals keep each attachment stable while spreading curvature over
 * the measured free span instead of rotating an entire disconnected surface.
 */
export const WARRIOR_FLEXIBLE_SURFACE_BLEND = {
  66: { axis: 'z', lower: -0.32276904582977295, upper: -0.004334107693284756, outward: -1 },
  85: { axis: 'y', lower: 0.7851841449737549, upper: 0.9184658527374268, outward: 1 },
  86: { axis: 'y', lower: 0.78583824634552, upper: 0.9164526462554932, outward: 1 },
} as const;

export const WARRIOR_EYE_GLOW = {
  colorLinear: [0.5448966680206299, 0.8092182711126265, 0.8964105215219142] as const,
  periodSeconds: 3.2,
  minIntensity: 0.16,
  maxIntensity: 0.34,
} as const;

/**
 * The Tripo source has no visibility channel for the carried weapon. Nine
 * frames is an authored transition length; 24 Hz is the measured source
 * sampling cadence, so the prelude lasts exactly 0.375 seconds.
 */
export const WARRIOR_TRIPO_MOTION_4_HIDE = {
  actionId: 'tripo-motion-4',
  physicalNodes: [54, 59] as const,
  sourceSampleRateHz: 24,
  authoredFadeFrameCount: 9,
  fadeSeconds: 9 / 24,
} as const;

export const WARRIOR_STAFF_ACTION = {
  shaftNode: 54,
  axis: [-0.737900257608946, -0.33849847367299474, 0.5838852568285178] as const,
  lengthMetres: 1.0261823131017225,
  radiusQ95Metres: 0.018362515684991653,
  attackTipGripLocal: [-0.33010724449858947, -0.136872069216242, 0.27805508395620415] as const,
  thrustMetres: 0.02,
  armMaxReachMetres: 0.26988730523934956,
  impactReachMetres: 0.26156572654293864,
  impactReachMarginMetres: 0.00832157869641092,
  clearanceDirection: [-0.6264715529560569, 0.6653641045777317, -0.40598522347038657] as const,
  clearanceOffsetMetres: 0.02,
  measuredStaticClearanceQ95Metres: 0.00850501893748417,
  ikSampleRateHz: 24,
  impactTimeSeconds: 0.5,
  sparkStartSeconds: 0.46,
  sparkEndSeconds: 0.66,
  sparkRayCount: 7,
} as const;

export const WARRIOR_TRIPO1_STAFF_FORWARD = {
  actionId: 'tripo-motion-1',
  measuredMeanAngleToFrontRadians: 1.0694580864719796,
  measuredRestAngleToFrontRadians: 0.9472900615728855,
  correctionRadians: 1.0694580864719796 - 0.9472900615728855,
} as const;

export const WARRIOR_TAIL_WAVE = {
  sourceSampleRateHz: 24,
  midDelayFrames: 2,
  tipDelayFrames: 4,
} as const;

/**
 * Rest anchors are world-space measurements in the normalized 0.965271 m
 * figure. They were read from the printed physical-node bounds and confirmed
 * against the six physical-ID renders; node names were not used as evidence.
 */
const RIG_JOINTS: RigJoint[] = [
  joint('root', undefined, 'character-root', [0, 0, 0], [0, 1, 0]),
  // Core anchors are the animation GLB's measured world-rest joints shifted
  // by its measured floor offset, 0.4826360046863556 m. Names are audit-only;
  // hierarchy and world-space locations establish the correspondence.
  joint('pelvis', 'root', 'pelvis', [0.0385487782322158, 0.38789428932952885, 0.1337780740504992], [0, 1, 0]),
  joint('spine', 'pelvis', 'spine', [0.03855423026430309, 0.38796278544003326, 0.13377061497206297], [0, 1, 0]),
  joint('chest', 'spine', 'chest', [0.04400186050164815, 0.4565400598095688, 0.12620491628346725], [0, 1, 0]),
  joint('neck', 'chest', 'neck', [0.05488483993018846, 0.5935400136252316, 0.11109054353730409], [0, 1, 0]),
  joint('head', 'neck', 'head', [0.06440249733398587, 0.7133526457226986, 0.0978724196440361], [0, 1, 0]),
  joint('hat-back', 'head', 'hat-back', [0.122134, 0.751408, -0.082897], [1, 0, 0]),
  // Ear roots use the measured minimum-Y attachment of nodes 85 and 86. The
  // child pivots are the printed median positions in each Y q45-q55 slab.
  joint('ear-left', 'head', 'ear-left', [0.138978, 0.752864, 0.119228], [0, 0, 1]),
  joint('ear-left-tip', 'ear-left', 'ear-left-tip', [0.12707319855690002, 0.848001629114151, 0.1303500160574913], [0, 0, 1]),
  joint('ear-right', 'head', 'ear-right', [-0.059858, 0.753420, 0.118988], [0, 0, 1]),
  joint('ear-right-tip', 'ear-right', 'ear-right-tip', [-0.04883481375873089, 0.8471701741218567, 0.13081810623407364], [0, 0, 1]),
  joint('whisker-73-base', 'head', 'whisker-73-base', [0.072413, 0.577912, 0.202547], [0, 0, 1]),
  joint('whisker-73-tip', 'whisker-73-base', 'whisker-73-tip', [0.113639, 0.577912, 0.237066], [0, 0, 1]),
  joint('whisker-74-base', 'head', 'whisker-74-base', [0.006800, 0.577484, 0.202506], [0, 0, 1]),
  joint('whisker-74-tip', 'whisker-74-base', 'whisker-74-tip', [-0.036023, 0.577484, 0.236581], [0, 0, 1]),
  joint('whisker-76-base', 'head', 'whisker-76-base', [0.071013, 0.604638, 0.200797], [0, 0, 1]),
  joint('whisker-76-tip', 'whisker-76-base', 'whisker-76-tip', [0.107844, 0.604638, 0.243822], [0, 0, 1]),
  joint('whisker-77-base', 'head', 'whisker-77-base', [0.007711, 0.604500, 0.200912], [0, 0, 1]),
  joint('whisker-77-tip', 'whisker-77-base', 'whisker-77-tip', [-0.029004, 0.604500, 0.244000], [0, 0, 1]),
  // Source rotations are retargeted onto the target character's measured
  // contacts. Clavicle and shoulder are coincident at the sleeve/body seam so
  // a clavicle turn cannot orbit the complete arm away from the torso.
  joint('right-clavicle', 'chest', 'right-clavicle', [-0.04667465016245842, 0.5167526006698608, 0.11597828194499016], [0, 0, 1]),
  joint('right-shoulder', 'right-clavicle', 'right-shoulder', [-0.04667465016245842, 0.5167526006698608, 0.11597828194499016], [0, 0, 1]),
  joint('right-elbow', 'right-shoulder', 'right-elbow', [-0.09913896024227142, 0.4484771192073822, 0.07011058181524277], [1, 0, 0]),
  joint('right-wrist', 'right-elbow', 'right-wrist', [-0.16876797378063202, 0.30188463628292084, 0.1280696615576744], [1, 0, 0]),
  joint('right-hand', 'right-wrist', 'right-hand', [-0.16876797378063202, 0.30188463628292084, 0.1280696615576744], [1, 0, 0]),
  joint('staff-grip', 'right-hand', 'weapon-socket', [-0.16876797378063202, 0.30188463628292084, 0.1280696615576744], [0, 0, 1]),
  // Node 59's measured centre is (0.227943, 0.453506, -0.147533). The pivot is
  // placed at its upper contact with the staff so the cheese swings from the
  // attachment instead of rotating around its own centre.
  joint('cheese-pendulum', 'staff-grip', 'staff-cheese', [0.228, 0.493, -0.148], [0, 0, 1]),
  joint('left-clavicle', 'chest', 'left-clavicle', [0.12215294688940048, 0.534097284078598, 0.12767324596643448], [0, 0, 1]),
  joint('left-shoulder', 'left-clavicle', 'left-shoulder', [0.12215294688940048, 0.534097284078598, 0.12767324596643448], [0, 0, 1]),
  joint('left-elbow', 'left-shoulder', 'left-elbow', [0.17513993382453918, 0.44529303908348083, 0.07354199513792992], [1, 0, 0]),
  joint('left-wrist', 'left-elbow', 'left-wrist', [0.24498479813337326, 0.3629699796438217, 0.10341373085975647], [1, 0, 0]),
  joint('left-hand', 'left-wrist', 'left-hand', [0.24498479813337326, 0.3629699796438217, 0.10341373085975647], [1, 0, 0]),
  joint('right-hip', 'pelvis', 'right-hip', [-0.0079954368192528, 0.3786300653159165, 0.1382543259380603], [1, 0, 0]),
  joint('right-knee', 'right-hip', 'right-knee', [-0.02373983059078455, 0.1411326453089714, 0.04873239994049072], [1, 0, 0]),
  joint('right-ankle', 'right-knee', 'right-ankle', [0.006556041867065043, 0.017598242383205287, -0.023994569976943256], [1, 0, 0]),
  joint('right-foot', 'right-ankle', 'right-foot', [-0.026412473060190678, 0.026644552126526833, 0.05108693614602089], [0, 0, 1]),
  joint('right-toes', 'right-foot', 'right-toes', [-0.013470628904937193, 0.014141325703601104, 0.018871729477860637], [1, 0, 0]),
  joint('left-hip', 'pelvis', 'left-hip', [0.08509979022362489, 0.39674203610942277, 0.12922637764257888], [1, 0, 0]),
  joint('left-knee', 'left-hip', 'left-knee', [0.1518409252166748, 0.1304462030529976, 0.06514503061771393], [1, 0, 0]),
  joint('left-ankle', 'left-knee', 'left-ankle', [0.20793975827904596, 0.03961532343914731, 0.06364784361167963], [1, 0, 0]),
  joint('left-foot', 'left-ankle', 'left-foot', [0.21120943466724218, 0.02907408979035514, 0.07154932741361127], [0, 0, 1]),
  // Combined node 79/82/83 medians place the toe group near this measured
  // contact region; the separate surfaces remain rigid under one toe pivot.
  joint('left-toes', 'left-foot', 'left-toes', [0.21120943466724218, 0.02907408979035514, 0.07154932741361127], [1, 0, 0]),
  // Secondary-motion pivots are measured at garment/tail attachment heights;
  // their animation amplitudes are authored because the GLB is static.
  // Node 47's measured centre is (-0.120541, 0.498413, 0.089298); its upper
  // Y bound (0.556091) is the cape attachment used as the rotation pivot.
  joint('cape-right', 'chest', 'right-shoulder-cape', [-0.120541, 0.556091, 0.089298], [1, 0, 0]),
  joint('coat-right', 'pelvis', 'coat-right-panel', [-0.055, 0.43, 0.10], [1, 0, 0]),
  joint('coat-left', 'pelvis', 'coat-left-panel', [0.065, 0.43, 0.10], [1, 0, 0]),
  joint('coat-front', 'pelvis', 'coat-front-panel', [0.01, 0.43, 0.19], [1, 0, 0]),
  joint('coat-front-mid', 'coat-front', 'coat-front-mid', [0.033324, 0.273011, 0.202302], [1, 0, 0]),
  joint('coat-front-tip', 'coat-front-mid', 'coat-front-tip', [0.033324, 0.216594, 0.202302], [1, 0, 0]),
  joint('sash-tail', 'pelvis', 'sash-tail', [0.19, 0.245, 0.00], [0, 0, 1]),
  joint('sash-tail-mid', 'sash-tail', 'sash-tail-mid', [0.281800, 0.179222, -0.026493], [0, 0, 1]),
  joint('sash-tail-tip', 'sash-tail-mid', 'sash-tail-tip', [0.390207, 0.179222, -0.026493], [0, 0, 1]),
  joint('mouse-tail', 'pelvis', 'mouse-tail', [0.03, 0.39, -0.02], [0, 1, 0]),
  joint('mouse-tail-mid', 'mouse-tail', 'mouse-tail-mid', [0.12056146562099457, 0.29444849491119385, -0.15512028336524963], [0, 1, 0]),
  joint('mouse-tail-tip', 'mouse-tail-mid', 'mouse-tail-tip', [0.23696612566709518, 0.33069905638694763, -0.35661426186561584], [0, 1, 0]),
];

const PROCEDURAL_ACTIONS: CharacterActionSpec[] = [
  {
    id: 'idle',
    label: 'Idle',
    duration: 3.2,
    loop: true,
    expose: false,
    tracks: [
      position('pelvis', [0, 1.6, 3.2], [[0.0385487782322158, 0.38789428932952885, 0.1337780740504992], [0.0385487782322158, 0.39189428932952885, 0.1337780740504992], [0.0385487782322158, 0.38789428932952885, 0.1337780740504992]]),
      rotation('chest', [0, 1.6, 3.2], [[0, 0, 0], [-0.018, 0.012, 0.01], [0, 0, 0]]),
      rotation('head', [0, 1.6, 3.2], [[0, 0, 0], [0.012, -0.018, 0], [0, 0, 0]]),
      ...hatMotion([0, 0.8, 1.6, 2.4, 3.2], 0.018, true),
      ...whiskerMotion([0, 0.8, 1.6, 2.4, 3.2], 0.052, true),
      rotation('ear-left', [0, 0.8, 1.6, 2.4, 3.2], [[0, 0, 0], [0.018, -0.012, 0.025], [0.006, 0.010, -0.012], [-0.014, -0.006, 0.018], [0, 0, 0]]),
      rotation('ear-right', [0, 0.8, 1.6, 2.4, 3.2], [[0, 0, 0], [-0.012, 0.010, -0.020], [0.010, -0.012, 0.014], [0.016, 0.006, -0.024], [0, 0, 0]]),
      rotation('cape-right', [0, 1.6, 3.2], [[0, 0, 0], [0.012, 0, -0.008], [0, 0, 0]]),
      rotation('coat-right', [0, 1.6, 3.2], [[0, 0, 0], [0.022, 0, -0.012], [0, 0, 0]]),
      rotation('coat-left', [0, 1.6, 3.2], [[0, 0, 0], [0.018, 0, 0.012], [0, 0, 0]]),
      rotation('coat-front-mid', [0, 0.8, 1.6, 2.4, 3.2], [[-0.020, 0, 0], [-0.038, 0.006, 0.010], [-0.026, -0.004, -0.008], [-0.042, 0.004, 0.009], [-0.020, 0, 0]]),
      rotation('coat-front-tip', [0, 0.8, 1.6, 2.4, 3.2], [[-0.034, 0, 0], [-0.068, 0.010, 0.016], [-0.042, -0.008, -0.012], [-0.074, 0.008, 0.014], [-0.034, 0, 0]]),
      rotation('sash-tail-mid', [0, 0.8, 1.6, 2.4, 3.2], [[0, 0, 0.018], [0.018, -0.010, 0.040], [-0.014, 0.008, -0.032], [0.016, -0.008, 0.036], [0, 0, 0.018]]),
      rotation('sash-tail-tip', [0, 0.8, 1.6, 2.4, 3.2], [[0, 0, 0.028], [0.030, -0.016, 0.070], [-0.024, 0.014, -0.056], [0.028, -0.014, 0.064], [0, 0, 0.028]]),
      rotation('cheese-pendulum', [0, 1.6, 3.2], [[0, 0, 0], [0.025, 0, -0.018], [0, 0, 0]]),
    ],
  },
  {
    id: 'staff-attack',
    label: 'Staff Strike',
    duration: 1.35,
    loop: false,
    returnToDefault: false,
    fadeSeconds: 0,
    tracks: [
      // The shoulder stays seated at its measured target seam. A two-bone IK
      // solve first holds the hand/staff 20 mm outside the measured garment
      // collision, then advances another 20 mm along node 54's measured axis.
      // Inverse wrist rotation preserves the staff's world orientation.
      ...staffThrustTracks(),
      ...hatMotion([0, 0.18, 0.36, 0.5, 0.68, 0.94, 1.35], 0.032, false),
      ...whiskerMotion([0, 0.18, 0.36, 0.5, 0.68, 0.94, 1.35], 0.086, false),
      rotation('ear-left', [0, 0.18, 0.5, 0.92, 1.35], [[0, 0, 0], [-0.018, 0.012, 0.026], [0.022, -0.014, -0.032], [-0.010, 0.006, 0.018], [0, 0, 0]]),
      rotation('ear-right', [0, 0.18, 0.5, 0.92, 1.35], [[0, 0, 0], [0.016, -0.010, -0.024], [-0.020, 0.012, 0.030], [0.012, -0.006, -0.016], [0, 0, 0]]),
      // The grip has no track: the complete right arm is the only staff
      // driver, so the hand-to-grip transform cannot drift. The left arm,
      // legs and all garment joints intentionally have no Staff Attack track;
      // this prevents the weapon action from pulling sleeves or opening cloth.
      rotation('cheese-pendulum', [0, 0.18, 0.5, 0.62, 0.92, 1.35], [[0, 0, 0], [-0.08, 0, -0.12], [0.22, 0, 0.28], [-0.16, 0, -0.18], [0.08, 0, 0.10], [0, 0, 0]]),
    ],
  },
];

export const WARRIOR_DISABLED_SOURCE_ACTION_IDS = ['tripo-motion-1', 'tripo-motion-3', 'walk'] as const;

/**
 * Victory Dance closes the limb joints far enough to visibly stretch these disconnected shells.
 * During that action the shoulder shells follow their parent joint as one rigid
 * object. The two outer garment shells are permanently rigid hip-bound by the
 * separate garment policy above.
 */
export const WARRIOR_VICTORY_DANCE_RIGID_BINDINGS = {
  47: 'right-shoulder',
  50: 'left-shoulder',
} as const;

/**
 * The exporter names every clip `Tripo Motion N`, which tells a viewer nothing.
 * The retained label comes from the clip's measured signature rather than its
 * export order: Motion 4 travels 0.481 m sideways and lifts 0.150 m in a
 * one-shot with the staff stowed.
 */
const WARRIOR_ACTION_LABELS: Record<string, string> = {
  'tripo-motion-4': 'Victory Dance',
};

const SOURCE_ACTIONS: CharacterActionSpec[] = WARRIOR_SOURCE_ACTIONS
  .filter((action) => !WARRIOR_DISABLED_SOURCE_ACTION_IDS.includes(
    action.id as (typeof WARRIOR_DISABLED_SOURCE_ACTION_IDS)[number],
  ))
  .map((action) => {
    let correctedAction: CharacterActionSpec = action;
    if (action.id === WARRIOR_TRIPO1_STAFF_FORWARD.actionId) {
      correctedAction = turnTripo1HandAndStaffForward(correctedAction);
    }
    return {
      ...correctedAction,
      label: WARRIOR_ACTION_LABELS[action.id] ?? correctedAction.label,
      returnToDefault: action.id === WARRIOR_TRIPO_MOTION_4_HIDE.actionId
        ? true
        : action.returnToDefault,
      tracks: [
        ...correctedAction.tracks,
        ...sourceSecondaryMotion(action.duration, action.loop, 1),
      ],
    };
  });

const ACTIONS: CharacterActionSpec[] = [
  PROCEDURAL_ACTIONS[0],
  ...SOURCE_ACTIONS,
  PROCEDURAL_ACTIONS[1],
].map((action) => {
  const tracks = ensureMouseTailMotion(action);
  return {
    ...action,
    tracks: distributeFlexibleSurfaceMotion(tracks, action.loop),
  };
});

export interface WarriorRigRuntime {
  ir: CharacterIR;
  skeleton: SkeletonBuildResult;
  animationController: CharacterAnimationController;
  skinMesh(mesh: THREE.Mesh, moduleNode: number): THREE.SkinnedMesh;
  update(deltaSeconds: number): void;
  readonly weightedMeshCount: number;
  readonly weightedVertexCount: number;
}

export function createWarriorCharacterIR(): CharacterIR {
  const ir = createStylizedCharacterIR({ name: 'Mouse Warrior' });
  ir.meta.id = 'warrior';
  ir.meta.version = '1.5.1-rig.20-victory-dance-rigid-shells';
  ir.meta.sourceRefs = [
    'pipelines/warrior/evidence/nodes.json',
    'pipelines/warrior/evidence/reference-physical-id/physical-id-manifest.json',
    'public/references/warrior/mouse-warrior-reference.png',
    'pipelines/warrior/evidence/animation-analysis.json',
    'pipelines/warrior/evidence/animation-retarget.json',
    'pipelines/warrior/evidence/tripo4-clearance-measurement.json',
    'pipelines/warrior/evidence/tripo1-staff-tail-runtime.json',
    'pipelines/warrior/evidence/tripo1-staff-clearance-solve.json',
    'pipelines/warrior/evidence/tripo-motion-4-leg-layer-stretch.json',
    'pipelines/warrior/evidence/tripo4-clearance-runtime-verification.json',
  ];
  ir.meta.assumptions.push(
    'Source joint rotations and root translation come from animation.glb; target clavicle, shoulder, elbow, wrist and grip anchors come from exact nearest-vertex contacts on the procedural surfaces in pipelines/warrior/evidence/animation-target-seams.json.',
    'Idle duration 3.2 s and its small chest/head amplitudes are authored assumptions because the static reference contains no breathing motion evidence.',
    'Attack duration 1.35 s, 20 mm thrust distance, timing and seven-ray impact spark are authored assumptions because the references contain no dedicated staff-impact clip.',
    'The right-toe blend uses node 48 Surface Nets Z q75-q90 (0.0510869-0.0732225 m) and suppresses lower-leg influence over Y q50-q75 (0.0266446-0.0738833 m).',
    'Nodes 85 and 86 use two-joint ear chains over printed Surface Nets Y q10-q90 spans. Existing gentle ear rotations are divided equally across the two measured-length segments, preserving the authored total tip angle while producing distributed curvature.',
    'Nodes 55 and 75 use three-joint cloth chains over their printed q10-q90 long-axis spans; flutter frequency, phase and amplitude are authored assumptions.',
    'Nodes 41, 60 and 71 share one rigid hat-back joint so their relative offsets cannot separate; its listening/sway amplitude is authored.',
    'Whisker nodes 73, 74, 76 and 77 use individual two-joint chains over their printed X q25-q75 spans; sway amplitudes are authored because the source has no motion. Imported secondary tracks now sample at the measured 24 Hz source cadence rather than five keys per clip.',
    'Node 66 uses a three-joint tail chain over its printed 0.318435 m Z q10-q90 span. Its authored total rotation remains divided equally, but mid and tip sample the base wave 2 and 4 frames later at the measured 24 Hz cadence so the tail forms a travelling S-curve instead of rotating all segments in phase. The propagation speed is an authored assumption because neither source GLB contains tail dynamics.',
    'Node 81 remains rigidly head-bound with no transform track. Its measured mean linear vertex colour drives a slow authored emissive pulse from 0.16 to 0.34 over 3.2 seconds.',
    'Exact surface contacts identify node 50 as the left upper-arm shell (23.978 micrometres from node 56), not weapon geometry. Only node 54 is rigidly bound to staff-grip; its measured 67.640 micrometre contact with node 51 defines the grip pivot.',
    'Node 54 measures 1.026182 m along principal axis (-0.737900, -0.338498, 0.583885), with q95 radial extent 0.018363 m; inverse wrist compensation keeps its world orientation fixed during the straight IK thrust.',
    'The 20 mm authored thrust stays inside the measured 0.269887 m two-bone arm reach with an 8.322 mm impact-pose reach margin; no shoulder translation is allowed because it opened the body seam.',
    'Staff Attack enters without a cross-fade and holds the hand and rigid staff 20 mm along measured perpendicular direction (-0.626472, 0.665364, -0.405985); this changes the measured node-64 q95-cylinder collision into 8.505 mm static clearance. The one-shot clamps at its clearance pose instead of pulling the staff back through the body; the left arm, legs and garments have no Staff Attack tracks.',
    'Articulated surfaces 45, 46, 47, 48, 50, 51, 52, 56, 58, 62 and 68 use closest-segment blends over measured target-rest chains. Nodes 64 and 84 are permanently single-parent coat-driver garment shells whose rigid driver follows the measured hip-to-knee direction; nodes 47 and 50 switch to one parent-joint influence during Victory Dance and restore their articulated attributes after the action.',
    'Exact node 45/48 and node 46/68 contacts define the target knee pivots at 26.975 and 105.457 micrometre rest gaps; the source bind labels are not used to place these target joints.',
    `Four source actions were recorded from animation.glb SHA-256 ${WARRIOR_SOURCE_ANIMATION_SHA256}; all 64 channels above the measured per-path export-noise floors remain preserved in sourceAnimationData.ts. Tripo Motion 1, Walk and Tripo Motion 3 are intentionally excluded from compilation and the runtime action list; only the measured Tripo Motion 4 source clip is retained alongside the code-native Staff Strike.`,
    'The animation source contains no terminal fallen pose. The retained source clip is Victory Dance; Staff Strike remains code-native.',
    'The Tripo source has a different skin and rest skeleton. The retarget preserves each mapped local rotation delta in its measured world-rest basis and exact root translation delta, but cannot reproduce source vertex deformation one-to-one on the procedural surface topology.',
    'The animation GLB has no dedicated ear, whisker, cloth, tail or cheese bones. Their secondary amplitudes on the two retained imported actions remain authored assumptions required by the prior character-motion contract; they are additive only on joints absent from the source rig.',
    'Tripo Motion 4 has no source visibility track. Before that clip starts, nodes 54 and 59 use an authored nine-frame smooth fade at the measured 24 Hz source cadence (0.375 s), then remain excluded from rendering until the clip completes or another action is selected. The one-shot now returns through the runtime default transition to Idle instead of clamping the final source pose.',
    'Tripo Motion 4 leg separation and node-55 forward cloth clearance are code-native correction curves measured at 96 Hz after lower-rate gates exposed nonlinear half-frame loss. Runtime uses the nearest measured correction (maximum temporal error 1/192 s) because both interpolation and a larger-angle envelope failed runtime cloth gates. The knee threshold 0.139143 m uses the full node-45/46 inward q50-q100/q0-q50 spans plus the 0.002966 m maximum p95 surface edge tolerance; the ankle threshold 0.045693 m retains its q10-q90 inward radii rule.',
    'Node-45/46 sampled vertex proximity below their lower measured Y q90 is retained as a diagnostic, not called an intersection result: point proximity cannot distinguish adjacent or tangent shells from triangle penetration. Multi-angle render and exported-triangle self-intersection review remain required.',
    'The Tripo Motion 4 clearance measurement samples at most 4096 vertices per surface, uses a projection bin twice the measured surface tolerance, and solves within a pi/2 bound using 20 bisection iterations. Those three numeric budgets are explicit measurement-method assumptions, not properties copied from either GLB.',
    'Every warrior surface is skinned with dual quaternions rather than linear blends, on the CPU and in the vertex shader from one shared algorithm, because Victory Dance closes the knee to 130.6 degrees. Under linear blending node 64 edges fell to 0.087 of their rest length and node 84 to 0.061; no weighting fixes that, since holding the collapse under a quarter of rest length would need a 0.27 m blend band on a 0.10 m thigh. Nodes 64/84 now remain single-parent rigid from bind pose, while the two implementations are proved to agree by the equal-weight rigidity check: vertex pairs carrying identical weights hold their distance to 1.8e-13.',
    'Victory Dance shape-lock measurements cover 321 poses at 24 Hz. Before the action-scoped rigid binding, q99 edge stretch measured 2.502x and 1.891x on nodes 47 and 50; the permanent single-parent bindings for nodes 64/84 preserve their shells in every action. When the measured lateral knee gap grows beyond its measured rest value, the runtime splits that increase equally between the two garment panels as an outward translation, preserving shell shape.',
    'Open defect: the two tunic panels still overlap by up to 186.4 mm while the legs are crossed. Enforcing the lateral surface gap inside the hip solve was measured and rejected: it leaves 221 of 1232 poses unsolved at the pi/2 bound and only reaches -168.3 mm, because no hip angle separates two wide panels around crossed legs. Fixing it properly needs a garment layer that can slide over the opposite leg, not a joint correction.',
    'Action labels are authored from each retained clip s measured signature rather than its export order. Victory Dance travels 0.481 m laterally and lifts 0.150 m over a 12.833 s one-shot with the staff stowed.',
  );
  ir.archetype.traits = [...new Set([...ir.archetype.traits, 'mouse', 'warrior', 'staff-user'])];
  ir.rigGraph = {
    joints: RIG_JOINTS,
    chains: [
      { id: 'right-arm-chain', joints: ['right-clavicle', 'right-shoulder', 'right-elbow', 'right-wrist', 'right-hand'], role: 'staff-arm' },
      { id: 'left-arm-chain', joints: ['left-clavicle', 'left-shoulder', 'left-elbow', 'left-wrist', 'left-hand'], role: 'counterbalance-arm' },
      { id: 'right-leg-chain', joints: ['right-hip', 'right-knee', 'right-ankle', 'right-foot', 'right-toes'], role: 'leg' },
      { id: 'left-leg-chain', joints: ['left-hip', 'left-knee', 'left-ankle', 'left-foot', 'left-toes'], role: 'leg' },
      { id: 'coat-front-cloth-chain', joints: ['coat-front', 'coat-front-mid', 'coat-front-tip'], role: 'cloth-secondary' },
      { id: 'sash-tail-cloth-chain', joints: ['sash-tail', 'sash-tail-mid', 'sash-tail-tip'], role: 'cloth-secondary' },
      { id: 'hat-back-chain', joints: ['head', 'hat-back'], role: 'headwear-secondary' },
      { id: 'left-ear-chain', joints: ['ear-left', 'ear-left-tip'], role: 'ear-secondary' },
      { id: 'right-ear-chain', joints: ['ear-right', 'ear-right-tip'], role: 'ear-secondary' },
      { id: 'mouse-tail-chain', joints: ['mouse-tail', 'mouse-tail-mid', 'mouse-tail-tip'], role: 'tail-secondary' },
      ...([73, 74, 76, 77] as const).map((node) => ({
        id: `whisker-${node}-chain`,
        joints: [`whisker-${node}-base`, `whisker-${node}-tip`],
        role: 'whisker-secondary',
      })),
    ],
    constraints: [
      { joint: 'right-elbow', type: 'hinge', axis: [1, 0, 0], min: -1.8, max: 1.2 },
      { joint: 'left-elbow', type: 'hinge', axis: [1, 0, 0], min: -1.8, max: 1.2 },
      { joint: 'right-wrist', type: 'ball', min: -0.8, max: 0.8 },
      { joint: 'left-wrist', type: 'ball', min: -0.8, max: 0.8 },
      { joint: 'right-knee', type: 'hinge', axis: [1, 0, 0], min: -0.2, max: 1.8 },
      { joint: 'left-knee', type: 'hinge', axis: [1, 0, 0], min: -0.2, max: 1.8 },
    ],
    effectors: [
      { id: 'right-hand-effector', joint: 'right-hand' },
      { id: 'staff-effector', joint: 'staff-grip' },
    ],
    twistSystems: [],
    drivers: [],
    ikChains: [],
  };
  ir.runtimeGraph.stableJointNames = RIG_JOINTS.map((item) => item.id);
  ir.runtimeGraph.nodes = RIG_JOINTS.map((item) => ({
    id: item.id,
    kind: item.id === 'root' ? 'root' : 'joint',
    parentId: item.parentId,
    semanticRegion: item.role,
  }));
  ir.runtimeGraph.poseProfiles = [{ id: 'measured-rest', role: 'bind', joints: {} }];
  ir.validationGraph.requiredGates.push('RIG-HIERARCHY', 'RIG-WEIGHT-SUM', 'RIG-BIND-POSE', 'RUNTIME-ANIMATION');
  return ir;
}

interface VisibilityFadeMaterialState {
  material: THREE.Material;
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
}

interface VisibilityFadeTarget {
  mesh: THREE.SkinnedMesh;
  visible: boolean;
  materials: VisibilityFadeMaterialState[];
}

interface Tripo4PlaybackState {
  clipRunning: boolean;
  clipSeconds: number;
}

function cloneMaterialSet(material: THREE.Material | THREE.Material[]): THREE.Material | THREE.Material[] {
  return Array.isArray(material) ? material.map((entry) => entry.clone()) : material.clone();
}

function createVisibilityFadeTarget(mesh: THREE.SkinnedMesh): VisibilityFadeTarget {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return {
    mesh,
    visible: mesh.visible,
    materials: materials.map((material) => ({
      material,
      opacity: material.opacity,
      transparent: material.transparent,
      depthWrite: material.depthWrite,
    })),
  };
}

function applyVisibilityFade(target: VisibilityFadeTarget, visibility: number): void {
  const fading = visibility < 1;
  target.mesh.visible = target.visible && visibility > 0;
  target.materials.forEach((state) => {
    const nextTransparent = fading || state.transparent;
    if (state.material.transparent !== nextTransparent) state.material.needsUpdate = true;
    state.material.opacity = state.opacity * visibility;
    state.material.transparent = nextTransparent;
    state.material.depthWrite = fading ? false : state.depthWrite;
  });
}

function createTripo4PreludeController(
  base: CharacterAnimationController,
  applyVisibility: (visibility: number) => void,
  playback: Tripo4PlaybackState,
  applyClearance: (clipSeconds: number) => void,
  applyStaffTwirlClearance: () => void,
): CharacterAnimationController {
  const listeners = new Set<(active: string) => void>();
  let active = base.active;
  let preludeActive = false;
  let preludeSeconds = 0;

  const setActive = (next: string): void => {
    if (active === next) return;
    active = next;
    listeners.forEach((listener) => listener(active));
  };
  const restoreHiddenParts = (): void => applyVisibility(1);

  base.subscribe((next) => {
    if (preludeActive) return;
    if (next !== WARRIOR_TRIPO_MOTION_4_HIDE.actionId) {
      playback.clipRunning = false;
      playback.clipSeconds = 0;
      restoreHiddenParts();
    }
    setActive(next);
  });

  return {
    actions: base.actions,
    get active() { return active; },
    play: (name) => {
      if (name === WARRIOR_TRIPO_MOTION_4_HIDE.actionId) {
        if (active === name) return;
        preludeActive = true;
        preludeSeconds = 0;
        playback.clipRunning = false;
        playback.clipSeconds = 0;
        restoreHiddenParts();
        setActive(name);
        return;
      }
      preludeActive = false;
      playback.clipRunning = false;
      playback.clipSeconds = 0;
      restoreHiddenParts();
      base.play(name);
      setActive(base.active);
    },
    stop: () => {
      preludeActive = false;
      playback.clipRunning = false;
      playback.clipSeconds = 0;
      restoreHiddenParts();
      base.stop();
      setActive(base.active);
    },
    update: (deltaSeconds) => {
      if (!preludeActive) {
        base.update(deltaSeconds);
        // Applied here rather than in the rig update so that any caller
        // driving the controller directly - the capture harness does - sees
        // the same corrected pose the viewer does.
        if (base.active === WARRIOR_TRIPO1_STAFF_FORWARD.actionId) applyStaffTwirlClearance();
        if (playback.clipRunning) {
          const safeDelta = Math.max(0, deltaSeconds);
          playback.clipSeconds = Math.min(
            WARRIOR_TRIPO4_CLEARANCE.durationSeconds,
            playback.clipSeconds + safeDelta,
          );
          applyClearance(playback.clipSeconds);
        }
        return;
      }
      const safeDelta = THREE.MathUtils.clamp(deltaSeconds, 0, 0.05);
      preludeSeconds += safeDelta;
      const progress = THREE.MathUtils.clamp(
        preludeSeconds / WARRIOR_TRIPO_MOTION_4_HIDE.fadeSeconds,
        0,
        1,
      );
      const smoothProgress = progress * progress * (3 - 2 * progress);
      applyVisibility(1 - smoothProgress);
      if (progress < 1) return;

      preludeActive = false;
      applyVisibility(0);
      base.play(WARRIOR_TRIPO_MOTION_4_HIDE.actionId);
      playback.clipRunning = true;
      playback.clipSeconds = 0;
      applyClearance(0);
      setActive(base.active);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener(active);
      return () => listeners.delete(listener);
    },
  };
}

function sampleTripo4Correction(samples: readonly number[], clipSeconds: number): number {
  const frame = THREE.MathUtils.clamp(
    clipSeconds * WARRIOR_TRIPO4_CLEARANCE.sampleRateHz,
    0,
    samples.length - 1,
  );
  // Cloth clearance is nonlinear and not monotone over the complete search
  // interval: both angle interpolation and an upper envelope failed runtime
  // gates. At 96 Hz, nearest-sample hold limits timing error to 1/192 second.
  return samples[Math.round(frame)];
}

/**
 * Applies only the measured residual needed to keep both leg chains ordered
 * and node 55 in front of their sampled surface corridor. The AnimationMixer
 * writes the source pose first on every update, so these premultiplied deltas
 * cannot accumulate between frames.
 */
function applyTripo4Clearance(
  skeleton: SkeletonBuildResult,
  clipSeconds: number,
): void {
  const rootBone = skeleton.bones.get('root') as THREE.Bone | undefined;
  const rightHip = skeleton.bones.get('right-hip') as THREE.Bone | undefined;
  const leftHip = skeleton.bones.get('left-hip') as THREE.Bone | undefined;
  const coatFront = skeleton.bones.get('coat-front') as THREE.Bone | undefined;
  if (!rootBone || !rightHip?.parent || !leftHip?.parent || !coatFront?.parent) {
    throw new Error('warrior Tripo Motion 4 clearance joints are incomplete');
  }

  rootBone.updateMatrixWorld(true);
  const rootWorldQuaternion = rootBone.getWorldQuaternion(new THREE.Quaternion());
  const hipAxisWorld = new THREE.Vector3(0, 0, 1).applyQuaternion(rootWorldQuaternion);
  const hipAngle = sampleTripo4Correction(
    WARRIOR_TRIPO4_CLEARANCE.hipCorrectionRadians,
    clipSeconds,
  );
  const hipAxisInParent = (hip: THREE.Bone): THREE.Vector3 => hipAxisWorld.clone()
    .applyQuaternion(hip.parent!.getWorldQuaternion(new THREE.Quaternion()).invert())
    .normalize();
  rightHip.quaternion.premultiply(
    new THREE.Quaternion().setFromAxisAngle(hipAxisInParent(rightHip), -hipAngle),
  );
  leftHip.quaternion.premultiply(
    new THREE.Quaternion().setFromAxisAngle(hipAxisInParent(leftHip), hipAngle),
  );
  rootBone.updateMatrixWorld(true);

  const clothAngle = sampleTripo4Correction(
    WARRIOR_TRIPO4_CLEARANCE.clothCorrectionRadians,
    clipSeconds,
  );
  const clothAxisWorld = new THREE.Vector3(1, 0, 0).applyQuaternion(rootWorldQuaternion);
  const clothAxisInParent = clothAxisWorld
    .applyQuaternion(coatFront.parent.getWorldQuaternion(new THREE.Quaternion()).invert())
    .normalize();
  coatFront.quaternion.premultiply(
    new THREE.Quaternion().setFromAxisAngle(clothAxisInParent, -clothAngle),
  );
  rootBone.updateMatrixWorld(true);
}

/**
 * Keeps the Staff Twirl weapon clear of the body.
 *
 * The staff measures 1.026 m on a 0.965 m figure, so with the arm where the
 * retarget puts it the shaft has to sweep through the legs and head: the
 * uncorrected clip penetrates 21.8 mm on 356 of 521 measured poses. Solving
 * that per frame produced a 95.7 deg single-frame flip, so the correction is
 * instead two constants - one rotation of the whole weapon arm, one of the
 * staff inside the hand - which are the same on every frame and therefore
 * cannot pop. The hip curve stays per pose because leg separation genuinely
 * varies with the source gait.
 *
 * The AnimationMixer writes the source pose first on every update, so these
 * premultiplied deltas cannot accumulate between frames.
 */
function applyTripo1Clearance(skeleton: SkeletonBuildResult, clipSeconds: number): void {
  const rootBone = skeleton.bones.get('root') as THREE.Bone | undefined;
  const rightHip = skeleton.bones.get('right-hip') as THREE.Bone | undefined;
  const leftHip = skeleton.bones.get('left-hip') as THREE.Bone | undefined;
  const shoulder = skeleton.bones.get('right-shoulder') as THREE.Bone | undefined;
  const hand = skeleton.bones.get('right-hand') as THREE.Bone | undefined;
  const grip = skeleton.bones.get('staff-grip') as THREE.Bone | undefined;
  if (!rootBone || !rightHip?.parent || !leftHip?.parent || !shoulder || !hand || !grip) {
    throw new Error('warrior Staff Twirl clearance joints are incomplete');
  }

  rootBone.updateMatrixWorld(true);
  const rootWorldQuaternion = rootBone.getWorldQuaternion(new THREE.Quaternion());
  const hipAxisWorld = new THREE.Vector3(0, 0, 1).applyQuaternion(rootWorldQuaternion);
  const samples = WARRIOR_TRIPO1_CLEARANCE.hipCorrectionRadians;
  const frame = THREE.MathUtils.clamp(
    Math.round(clipSeconds * WARRIOR_TRIPO1_CLEARANCE.sampleRateHz),
    0,
    samples.length - 1,
  );
  const hipAngle = samples[frame];
  const hipAxisInParent = (hip: THREE.Bone): THREE.Vector3 => hipAxisWorld.clone()
    .applyQuaternion(hip.parent!.getWorldQuaternion(new THREE.Quaternion()).invert())
    .normalize();
  rightHip.quaternion.premultiply(
    new THREE.Quaternion().setFromAxisAngle(hipAxisInParent(rightHip), -hipAngle),
  );
  leftHip.quaternion.premultiply(
    new THREE.Quaternion().setFromAxisAngle(hipAxisInParent(leftHip), hipAngle),
  );

  // Shoulder-local: rotates the whole weapon arm, so the elbow, wrist, hand and
  // staff travel together and the grip transform is untouched.
  shoulder.quaternion.multiply(new THREE.Quaternion().fromArray(
    WARRIOR_TRIPO1_CLEARANCE.armShoulderLocalCorrection as unknown as number[],
  ));

  // Grip-local, applied at the wrist so the fingers turn with the staff rather
  // than sliding off it. The hand and grip anchors are coincident, so
  // conjugating by the grip's current local rotation reproduces the solved
  // world staff pose exactly.
  const gripLocal = grip.quaternion.clone();
  const staffCorrection = new THREE.Quaternion().fromArray(
    WARRIOR_TRIPO1_CLEARANCE.staffGripLocalCorrection as unknown as number[],
  );
  hand.quaternion.multiply(
    gripLocal.clone().multiply(staffCorrection).multiply(gripLocal.clone().invert()),
  );
  rootBone.updateMatrixWorld(true);
}

export function installWarriorRig(
  root: THREE.Group,
  options: { disableTripo4Clearance?: boolean; disableTripo1Clearance?: boolean } = {},
): WarriorRigRuntime {
  const ir = createWarriorCharacterIR();
  const skeleton = buildSkeleton(ir.rigGraph!);
  assertWarriorHierarchy(skeleton);
  root.add(skeleton.root as unknown as THREE.Object3D);
  const staffGrip = skeleton.bones.get('staff-grip');
  if (!staffGrip) throw new Error('warrior staff-grip joint is missing');
  const staffImpactSpark = createStaffImpactSpark(staffGrip as unknown as THREE.Object3D);
  const coverageFrame = (skeleton.root.parent ?? root) as THREE.Object3D;
  const garmentDrivers = [
    { node: 64, boneName: 'coat-right', hipName: 'right-hip', kneeName: 'right-knee' },
    { node: 84, boneName: 'coat-left', hipName: 'left-hip', kneeName: 'left-knee' },
  ] as const;
  let weightedMeshCount = 0;
  let weightedVertexCount = 0;
  let runtimeSeconds = 0;
  const eyeGlowMaterials = new Set<THREE.MeshStandardMaterial>();
  const tripo4HideTargets = new Set<VisibilityFadeTarget>();
  const victoryDanceRigidTargets: Array<{
    geometry: THREE.BufferGeometry;
    articulatedIndex: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    articulatedWeight: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    rigidIndex: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    rigidWeight: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  }> = [];
  let tripo4Visibility = 1;

  const applyTripo4Visibility = (visibility: number): void => {
    tripo4Visibility = THREE.MathUtils.clamp(visibility, 0, 1);
    tripo4HideTargets.forEach((target) => applyVisibilityFade(target, tripo4Visibility));
  };

  const skinMesh = (mesh: THREE.Mesh, moduleNode: number): THREE.SkinnedMesh => {
    const permanentGarmentJoint = WARRIOR_PERMANENT_RIGID_GARMENT_BINDINGS[
      moduleNode as keyof typeof WARRIOR_PERMANENT_RIGID_GARMENT_BINDINGS
    ];
    if (permanentGarmentJoint) {
      buildRigidSemanticWeights(mesh.geometry, skeleton, () => permanentGarmentJoint);
    }
    else if ([45, 46].includes(moduleNode)) {
      buildVerticalLegLayerWeights(mesh.geometry, skeleton, WARRIOR_ARTICULATED_CHAINS[moduleNode]);
    }
    else if (WARRIOR_ARTICULATED_CHAINS[moduleNode]) {
      buildPolylineSkinWeights(mesh.geometry, skeleton, WARRIOR_ARTICULATED_CHAINS[moduleNode]);
    }
    else if (moduleNode === 55 || moduleNode === 75) buildThinClothBlendWeights(mesh.geometry, skeleton, moduleNode);
    else if ([73, 74, 76, 77].includes(moduleNode)) buildWhiskerBlendWeights(mesh.geometry, skeleton, moduleNode as 73 | 74 | 76 | 77);
    else if (moduleNode === 66 || moduleNode === 85 || moduleNode === 86) {
      buildFlexibleSurfaceWeights(mesh.geometry, skeleton, moduleNode);
    }
    else {
      buildRigidSemanticWeights(
        mesh.geometry,
        skeleton,
        (x, y, z) => semanticJointForVertex(moduleNode, x, y, z),
      );
    }
    const victoryDanceJoint = WARRIOR_VICTORY_DANCE_RIGID_BINDINGS[
      moduleNode as keyof typeof WARRIOR_VICTORY_DANCE_RIGID_BINDINGS
    ];
    if (victoryDanceJoint) {
      const articulatedIndex = mesh.geometry.getAttribute('skinIndex').clone();
      const articulatedWeight = mesh.geometry.getAttribute('skinWeight').clone();
      buildRigidSemanticWeights(mesh.geometry, skeleton, () => victoryDanceJoint);
      const rigidIndex = mesh.geometry.getAttribute('skinIndex').clone();
      const rigidWeight = mesh.geometry.getAttribute('skinWeight').clone();
      mesh.geometry.setAttribute('skinIndex', articulatedIndex);
      mesh.geometry.setAttribute('skinWeight', articulatedWeight);
      victoryDanceRigidTargets.push({
        geometry: mesh.geometry,
        articulatedIndex,
        articulatedWeight,
        rigidIndex,
        rigidWeight,
      });
    }
    const skinnedMaterial = moduleNode === 81
      ? cloneEyeGlowMaterial(mesh.material, eyeGlowMaterials)
      : moduleNode === 54 || moduleNode === 59
        ? cloneMaterialSet(mesh.material)
        : mesh.material;
    const skinned = new THREE.SkinnedMesh(mesh.geometry, skinnedMaterial);
    skinned.name = mesh.name;
    skinned.userData = { ...mesh.userData, rigged: true };
    skinned.position.copy(mesh.position);
    skinned.quaternion.copy(mesh.quaternion);
    skinned.scale.copy(mesh.scale);
    skinned.castShadow = mesh.castShadow;
    skinned.receiveShadow = mesh.receiveShadow;
    skinned.visible = mesh.visible;
    skinned.renderOrder = mesh.renderOrder;
    skinned.frustumCulled = false;
    skinned.bindMode = THREE.DetachedBindMode;
    skinned.bind(skeleton.skeleton as unknown as THREE.Skeleton, new THREE.Matrix4());
    // Linear blend skinning collapses these surfaces at the knee, which closes
    // to 130.6 degrees in Victory Dance. See dualQuaternionSkinning.ts.
    installDualQuaternionSkinning(skinned);
    if (moduleNode === 54 || moduleNode === 59) {
      const target = createVisibilityFadeTarget(skinned);
      tripo4HideTargets.add(target);
      applyVisibilityFade(target, tripo4Visibility);
    }
    weightedMeshCount += 1;
    weightedVertexCount += mesh.geometry.getAttribute('position').count;
    return skinned;
  };

  const existing = new Map<THREE.Mesh, number>();
  root.traverse((object) => {
    if (object instanceof THREE.Mesh && !(object instanceof THREE.SkinnedMesh)) {
      existing.set(object, Number(object.userData.moduleNode));
    }
  });
  for (const [mesh, moduleNode] of existing) {
    const parent = mesh.parent;
    if (!parent || !Number.isFinite(moduleNode)) continue;
    const skinned = skinMesh(mesh, moduleNode);
    const index = parent.children.indexOf(mesh);
    parent.remove(mesh);
    parent.add(skinned);
    if (index >= 0) {
      parent.children.splice(parent.children.indexOf(skinned), 1);
      parent.children.splice(index, 0, skinned);
      skinned.parent = parent;
    }
  }

  skeleton.root.updateMatrixWorld(true);
  const restKneeGap = lateralKneeGap(
    coverageFrame,
    skeleton.bones.get('right-knee')!,
    skeleton.bones.get('left-knee')!,
  );
  const garmentDriverRest = garmentDrivers.map((driver) => {
    const hip = skeleton.bones.get(driver.hipName);
    const knee = skeleton.bones.get(driver.kneeName);
    const bone = skeleton.bones.get(driver.boneName);
    if (!hip || !knee || !bone) throw new Error(`warrior garment driver is missing for node ${driver.node}`);
    return {
      ...driver,
      hip,
      knee,
      bone,
      restHipPosition: hip.getWorldPosition(new THREE.Vector3()),
      restKneePosition: knee.getWorldPosition(new THREE.Vector3()),
      restBonePosition: bone.getWorldPosition(new THREE.Vector3()),
      restBoneQuaternion: bone.getWorldQuaternion(new THREE.Quaternion()),
    };
  });

  const actions = compileCharacterActions(root as unknown as THREE.Object3D, ACTIONS);
  const victoryDanceClip = actions.clips.get(WARRIOR_TRIPO_MOTION_4_HIDE.actionId);
  if (!victoryDanceClip) throw new Error('warrior Victory Dance clip is missing');
  const victoryDanceMixerAction = actions.mixer.existingAction(victoryDanceClip);
  if (!victoryDanceMixerAction) throw new Error('warrior Victory Dance mixer action is missing');
  const tripo4Playback: Tripo4PlaybackState = { clipRunning: false, clipSeconds: 0 };
  const animationController = createTripo4PreludeController(
    actions.controller,
    applyTripo4Visibility,
    tripo4Playback,
    (clipSeconds) => {
      if (!options.disableTripo4Clearance) applyTripo4Clearance(skeleton, clipSeconds);
    },
    () => {
      if (options.disableTripo1Clearance) return;
      // The mixer's own action time is the phase of record; a local
      // accumulator would drift away from it across cross-fades and loops.
      const clip = actions.clips.get(WARRIOR_TRIPO1_STAFF_FORWARD.actionId);
      const action = clip ? actions.mixer.existingAction(clip) : null;
      applyTripo1Clearance(skeleton, action ? action.time : 0);
    },
  );
  const updateGarmentCoverage = (): void => {
    coverageFrame.updateWorldMatrix(true, false);
    skeleton.root.updateMatrixWorld(true);
    // Each panel follows its current hip->knee direction as a single rigid
    // transform. Its local-X span expands by the measured knee-gap ratio, so
    // a wider stance produces a wider shell without deforming its topology.
    const currentKneeGap = lateralKneeGap(
      coverageFrame,
      skeleton.bones.get('right-knee')!,
      skeleton.bones.get('left-knee')!,
    );
    const garmentWidthScale = restKneeGap > 0
      ? Math.max(1, currentKneeGap / restKneeGap)
      : 1;
    for (const driver of garmentDriverRest) {
      const currentHip = driver.hip.getWorldPosition(new THREE.Vector3());
      const currentKnee = driver.knee.getWorldPosition(new THREE.Vector3());
      const restThigh = driver.restKneePosition.clone().sub(driver.restHipPosition).normalize();
      const currentThigh = currentKnee.clone().sub(currentHip).normalize();
      const thighRotation = new THREE.Quaternion().setFromUnitVectors(restThigh, currentThigh);
      const desiredPosition = currentHip.clone().add(
        driver.restBonePosition.clone().sub(driver.restHipPosition).applyQuaternion(thighRotation),
      );
      const desiredQuaternion = thighRotation.clone().multiply(driver.restBoneQuaternion);
      const parent = driver.bone.parent;
      if (!parent) continue;
      parent.updateWorldMatrix(true, false);
      const parentWorldQuaternion = parent.getWorldQuaternion(new THREE.Quaternion());
      driver.bone.position.copy(parent.worldToLocal(desiredPosition));
      driver.bone.quaternion.copy(parentWorldQuaternion.invert().multiply(desiredQuaternion));
      driver.bone.scale.set(garmentWidthScale, 1, 1);
    }
  };
  let activeAction = animationController.active;
  let attackSeconds = 0;
  let victoryDanceShapeLocked = false;
  const setVictoryDanceShapeLock = (locked: boolean): void => {
    if (locked === victoryDanceShapeLocked) return;
    victoryDanceShapeLocked = locked;
    for (const target of victoryDanceRigidTargets) {
      const skinIndex = locked ? target.rigidIndex : target.articulatedIndex;
      const skinWeight = locked ? target.rigidWeight : target.articulatedWeight;
      target.geometry.setAttribute('skinIndex', skinIndex);
      target.geometry.setAttribute('skinWeight', skinWeight);
      skinIndex.needsUpdate = true;
      skinWeight.needsUpdate = true;
    }
  };
  animationController.subscribe((nextAction) => {
    activeAction = nextAction;
    if (nextAction === WARRIOR_TRIPO_MOTION_4_HIDE.actionId) setVictoryDanceShapeLock(true);
    if (nextAction === 'staff-attack') attackSeconds = 0;
    else staffImpactSpark.group.visible = false;
  });
  return {
    ir,
    skeleton,
    animationController,
    skinMesh,
    update: (deltaSeconds) => {
      animationController.update(deltaSeconds);
      updateGarmentCoverage();
      // The public active id changes at the START of a cross-fade. Keep the four shells rigid until
      // the mixer says Victory Dance contributes no weight, otherwise the articulated attributes
      // return while the final bent pose is still visible and create a one-frame deformation spike.
      setVictoryDanceShapeLock(
        activeAction === WARRIOR_TRIPO_MOTION_4_HIDE.actionId
        || (victoryDanceMixerAction.isScheduled()
          && victoryDanceMixerAction.getEffectiveWeight() > 0),
      );
      const safeDelta = THREE.MathUtils.clamp(deltaSeconds, 0, 0.05);
      runtimeSeconds += safeDelta;
      if (activeAction === 'staff-attack') {
        attackSeconds += safeDelta;
        updateStaffImpactSpark(staffImpactSpark, attackSeconds);
      } else staffImpactSpark.group.visible = false;
      const wave = 0.5 + 0.5 * Math.sin((runtimeSeconds / WARRIOR_EYE_GLOW.periodSeconds) * Math.PI * 2);
      const intensity = THREE.MathUtils.lerp(WARRIOR_EYE_GLOW.minIntensity, WARRIOR_EYE_GLOW.maxIntensity, wave);
      eyeGlowMaterials.forEach((material) => { material.emissiveIntensity = intensity; });
    },
    get weightedMeshCount() { return weightedMeshCount; },
    get weightedVertexCount() { return weightedVertexCount; },
  };
}

interface StaffImpactSpark {
  group: THREE.Group;
  rayMaterial: THREE.LineBasicMaterial;
  coreMaterial: THREE.MeshBasicMaterial;
}

function createStaffImpactSpark(staffGrip: THREE.Object3D): StaffImpactSpark {
  const group = new THREE.Group();
  group.name = 'staff-impact-spark';
  group.position.fromArray(WARRIOR_STAFF_ACTION.attackTipGripLocal);
  group.visible = false;
  group.userData = {
    procedural: true,
    attachment: 'staff-grip',
    rayCount: WARRIOR_STAFF_ACTION.sparkRayCount,
    assetBacked: false,
  };

  const axis = new THREE.Vector3().fromArray(WARRIOR_STAFF_ACTION.axis).normalize();
  const basisA = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 1, 0)).normalize();
  const basisB = new THREE.Vector3().crossVectors(axis, basisA).normalize();
  const radius = WARRIOR_STAFF_ACTION.radiusQ95Metres * 1.25;
  const rayPositions: number[] = [];
  for (let ray = 0; ray < WARRIOR_STAFF_ACTION.sparkRayCount; ray += 1) {
    const angle = (ray / WARRIOR_STAFF_ACTION.sparkRayCount) * Math.PI * 2;
    const length = radius * (0.72 + (ray % 3) * 0.14);
    const endpoint = basisA.clone().multiplyScalar(Math.cos(angle))
      .addScaledVector(basisB, Math.sin(angle))
      .multiplyScalar(length)
      .addScaledVector(axis, radius * (ray % 2 === 0 ? 0.20 : -0.12));
    rayPositions.push(0, 0, 0, endpoint.x, endpoint.y, endpoint.z);
  }
  const rayGeometry = new THREE.BufferGeometry();
  rayGeometry.setAttribute('position', new THREE.Float32BufferAttribute(rayPositions, 3));
  const rayMaterial = new THREE.LineBasicMaterial({
    color: 0xffc54d,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const rays = new THREE.LineSegments(rayGeometry, rayMaterial);
  rays.name = 'staff-impact-spark-rays';
  group.add(rays);

  const coreMaterial = new THREE.MeshBasicMaterial({
    color: 0xfff1a8,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(WARRIOR_STAFF_ACTION.radiusQ95Metres * 0.22, 8, 6),
    coreMaterial,
  );
  core.name = 'staff-impact-spark-core';
  group.add(core);
  staffGrip.add(group);
  return { group, rayMaterial, coreMaterial };
}

function updateStaffImpactSpark(spark: StaffImpactSpark, attackSeconds: number): void {
  const start = WARRIOR_STAFF_ACTION.sparkStartSeconds;
  const impact = WARRIOR_STAFF_ACTION.impactTimeSeconds;
  const end = WARRIOR_STAFF_ACTION.sparkEndSeconds;
  const rise = THREE.MathUtils.clamp((attackSeconds - start) / (impact - start), 0, 1);
  const fall = THREE.MathUtils.clamp((end - attackSeconds) / (end - impact), 0, 1);
  const pulse = Math.min(rise, fall);
  spark.group.visible = pulse > 0;
  spark.group.scale.setScalar(0.55 + pulse * 0.65);
  spark.rayMaterial.opacity = pulse * 0.92;
  spark.coreMaterial.opacity = pulse;
}

function semanticJointForVertex(moduleNode: number, _x: number, _y: number, _z: number): string {
  const joint = WARRIOR_NODE_JOINT_BINDINGS[moduleNode];
  if (!joint) throw new Error(`warrior physical node ${moduleNode} has no render-confirmed rig binding`);
  return joint;
}

function buildPolylineSkinWeights(
  geometry: THREE.BufferGeometry,
  skeleton: SkeletonBuildResult,
  chain: readonly string[],
): void {
  const position = geometry.getAttribute('position');
  if (!position) throw new Error(`cannot bind articulated chain ${chain.join(' -> ')} without position attribute`);
  const bones = chain.map((name) => skeleton.bones.get(name));
  if (bones.some((bone) => !bone)) throw new Error(`articulated chain has missing bones: ${chain.join(' -> ')}`);
  skeleton.root.updateMatrixWorld(true);
  const anchors = bones.map((bone) => (bone as THREE.Bone).getWorldPosition(new THREE.Vector3()));
  const boneIndices = chain.map((name) => skeleton.skeleton.bones.findIndex((bone) => bone.name === name));
  const indices = new Uint8Array(position.count * 4);
  const weights = new Uint8Array(position.count * 4);
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const point = new THREE.Vector3().fromBufferAttribute(position, vertex);
    let closestSegment = 0;
    let closestT = 0;
    let closestDistanceSquared = Number.POSITIVE_INFINITY;
    for (let segment = 0; segment < anchors.length - 1; segment += 1) {
      const start = anchors[segment];
      const delta = anchors[segment + 1].clone().sub(start);
      const lengthSquared = delta.lengthSq();
      const t = lengthSquared > 0
        ? THREE.MathUtils.clamp(point.clone().sub(start).dot(delta) / lengthSquared, 0, 1)
        : 0;
      const distanceSquared = point.distanceToSquared(start.clone().addScaledVector(delta, t));
      if (distanceSquared < closestDistanceSquared) {
        closestDistanceSquared = distanceSquared;
        closestSegment = segment;
        closestT = t;
      }
    }
    const childByte = Math.round(255 * closestT);
    const offset = vertex * 4;
    indices[offset] = boneIndices[closestSegment];
    indices[offset + 1] = boneIndices[closestSegment + 1];
    weights[offset] = 255 - childByte;
    weights[offset + 1] = childByte;
  }
  geometry.setAttribute('skinIndex', new THREE.Uint8BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new THREE.Uint8BufferAttribute(weights, 4, true));
}

/**
 * Legs 45/46 use their measured hip-knee height parameter. The outer garment
 * layers 64/84 are permanently rigid hip-bound and are covered by the runtime
 * lateral offset above, so they cannot select a different point on the slanted
 * leg segment or tear when the knees separate.
 *
 * Skins a thigh-layer surface across its hip-knee chain.
 *
 * With dual quaternion skinning the blend of two bone transforms is rigid, so
 * the surface can no longer collapse and the only remaining distortion is the
 * weight gradient along an edge times the screw motion between the two bones.
 * That makes the widest possible band the best one, and a linear ramp over the
 * full measured hip-to-knee span is exactly the profile with the smallest peak
 * gradient. Narrowing the band to the measured joint radius was tried and
 * measured worse on Victory Dance: node 64's q99 stretch rose from 1.82 to
 * 2.14 because the same weight change was forced through less surface.
 */
function buildVerticalLegLayerWeights(
  geometry: THREE.BufferGeometry,
  skeleton: SkeletonBuildResult,
  chain: readonly string[],
): void {
  if (chain.length !== 2) throw new Error(`leg coverage chain requires two bones: ${chain.join(' -> ')}`);
  const position = geometry.getAttribute('position');
  if (!position) throw new Error(`cannot bind leg coverage chain ${chain.join(' -> ')} without position attribute`);
  const parent = skeleton.bones.get(chain[0]);
  const child = skeleton.bones.get(chain[1]);
  if (!parent || !child) throw new Error(`leg coverage chain has missing bones: ${chain.join(' -> ')}`);
  skeleton.root.updateMatrixWorld(true);
  const parentY = parent.getWorldPosition(new THREE.Vector3()).y;
  const childY = child.getWorldPosition(new THREE.Vector3()).y;
  const height = childY - parentY;
  if (Math.abs(height) < 1e-9) throw new Error(`leg coverage chain has zero measured height: ${chain.join(' -> ')}`);
  const parentIndex = skeleton.skeleton.bones.findIndex((bone) => bone.name === chain[0]);
  const childIndex = skeleton.skeleton.bones.findIndex((bone) => bone.name === chain[1]);
  const indices = new Uint8Array(position.count * 4);
  const weights = new Uint8Array(position.count * 4);
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const t = THREE.MathUtils.clamp((position.getY(vertex) - parentY) / height, 0, 1);
    const childByte = Math.round(255 * t);
    const offset = vertex * 4;
    indices[offset] = parentIndex;
    indices[offset + 1] = childIndex;
    weights[offset] = 255 - childByte;
    weights[offset + 1] = childByte;
  }
  geometry.setAttribute('skinIndex', new THREE.Uint8BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new THREE.Uint8BufferAttribute(weights, 4, true));
}

function lateralKneeGap(
  frame: THREE.Object3D,
  rightKnee: THREE.Object3D,
  leftKnee: THREE.Object3D,
): number {
  const right = frame.worldToLocal(rightKnee.getWorldPosition(new THREE.Vector3()));
  const left = frame.worldToLocal(leftKnee.getWorldPosition(new THREE.Vector3()));
  return Math.abs(left.x - right.x);
}

function buildThinClothBlendWeights(
  geometry: THREE.BufferGeometry,
  skeleton: SkeletonBuildResult,
  moduleNode: 55 | 75,
): void {
  const position = geometry.getAttribute('position');
  if (!position) throw new Error(`cannot bind cloth node ${moduleNode} without position attribute`);
  const baseName = moduleNode === 55 ? 'coat-front' : 'sash-tail';
  const midName = moduleNode === 55 ? 'coat-front-mid' : 'sash-tail-mid';
  const tipName = moduleNode === 55 ? 'coat-front-tip' : 'sash-tail-tip';
  const baseIndex = skeleton.skeleton.bones.findIndex((bone) => bone.name === baseName);
  const midIndex = skeleton.skeleton.bones.findIndex((bone) => bone.name === midName);
  const tipIndex = skeleton.skeleton.bones.findIndex((bone) => bone.name === tipName);
  if (baseIndex < 0 || midIndex < 0 || tipIndex < 0) throw new Error(`cloth bones are missing for node ${moduleNode}`);
  const interval = WARRIOR_CLOTH_BLEND[moduleNode];
  const indices = new Uint8Array(position.count * 4);
  const weights = new Uint8Array(position.count * 4);
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const axisValue = interval.axis === 'x' ? position.getX(vertex) : position.getY(vertex);
    const axisBlend = smoothstep(interval.lower, interval.upper, axisValue);
    const progress = interval.outward < 0 ? 1 - axisBlend : axisBlend;
    const baseWeight = 1 - smoothstep(0, 0.5, progress);
    const tipWeight = smoothstep(0.5, 1, progress);
    const baseByte = Math.round(255 * baseWeight);
    const tipByte = Math.round(255 * tipWeight);
    const midByte = 255 - baseByte - tipByte;
    const offset = vertex * 4;
    indices[offset] = baseIndex;
    indices[offset + 1] = midIndex;
    indices[offset + 2] = tipIndex;
    weights[offset] = baseByte;
    weights[offset + 1] = midByte;
    weights[offset + 2] = tipByte;
  }
  geometry.setAttribute('skinIndex', new THREE.Uint8BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new THREE.Uint8BufferAttribute(weights, 4, true));
}

function buildWhiskerBlendWeights(
  geometry: THREE.BufferGeometry,
  skeleton: SkeletonBuildResult,
  moduleNode: 73 | 74 | 76 | 77,
): void {
  const position = geometry.getAttribute('position');
  if (!position) throw new Error(`cannot bind whisker node ${moduleNode} without position attribute`);
  const baseName = `whisker-${moduleNode}-base`;
  const tipName = `whisker-${moduleNode}-tip`;
  const baseIndex = skeleton.skeleton.bones.findIndex((bone) => bone.name === baseName);
  const tipIndex = skeleton.skeleton.bones.findIndex((bone) => bone.name === tipName);
  if (baseIndex < 0 || tipIndex < 0) throw new Error(`whisker bones are missing for node ${moduleNode}`);
  const interval = WARRIOR_WHISKER_BLEND[moduleNode];
  const indices = new Uint8Array(position.count * 4);
  const weights = new Uint8Array(position.count * 4);
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const axisBlend = smoothstep(interval.lower, interval.upper, position.getX(vertex));
    const tipWeight = interval.outward < 0 ? 1 - axisBlend : axisBlend;
    const tipByte = Math.round(255 * tipWeight);
    const offset = vertex * 4;
    indices[offset] = baseIndex;
    indices[offset + 1] = tipIndex;
    weights[offset] = 255 - tipByte;
    weights[offset + 1] = tipByte;
  }
  geometry.setAttribute('skinIndex', new THREE.Uint8BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new THREE.Uint8BufferAttribute(weights, 4, true));
}

function buildFlexibleSurfaceWeights(
  geometry: THREE.BufferGeometry,
  skeleton: SkeletonBuildResult,
  moduleNode: 66 | 85 | 86,
): void {
  const position = geometry.getAttribute('position');
  if (!position) throw new Error(`cannot bind flexible surface node ${moduleNode} without position attribute`);
  const chain = moduleNode === 66
    ? ['mouse-tail', 'mouse-tail-mid', 'mouse-tail-tip'] as const
    : moduleNode === 85
      ? ['ear-left', 'ear-left-tip'] as const
      : ['ear-right', 'ear-right-tip'] as const;
  const boneIndices = chain.map((name) => skeleton.skeleton.bones.findIndex((bone) => bone.name === name));
  if (boneIndices.some((index) => index < 0)) {
    throw new Error(`flexible surface bones are missing for node ${moduleNode}`);
  }
  const interval = WARRIOR_FLEXIBLE_SURFACE_BLEND[moduleNode];
  const indices = new Uint8Array(position.count * 4);
  const weights = new Uint8Array(position.count * 4);
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const axisValue = interval.axis === 'y' ? position.getY(vertex) : position.getZ(vertex);
    const axisBlend = smoothstep(interval.lower, interval.upper, axisValue);
    const progress = interval.outward < 0 ? 1 - axisBlend : axisBlend;
    const offset = vertex * 4;
    if (chain.length === 2) {
      const tipByte = Math.round(255 * progress);
      indices[offset] = boneIndices[0];
      indices[offset + 1] = boneIndices[1];
      weights[offset] = 255 - tipByte;
      weights[offset + 1] = tipByte;
      continue;
    }
    const baseWeight = 1 - smoothstep(0, 0.5, progress);
    const tipWeight = smoothstep(0.5, 1, progress);
    const baseByte = Math.round(255 * baseWeight);
    const tipByte = Math.round(255 * tipWeight);
    indices[offset] = boneIndices[0];
    indices[offset + 1] = boneIndices[1];
    indices[offset + 2] = boneIndices[2];
    weights[offset] = baseByte;
    weights[offset + 1] = 255 - baseByte - tipByte;
    weights[offset + 2] = tipByte;
  }
  geometry.setAttribute('skinIndex', new THREE.Uint8BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new THREE.Uint8BufferAttribute(weights, 4, true));
}

function cloneEyeGlowMaterial(
  material: THREE.Material | THREE.Material[],
  registry: Set<THREE.MeshStandardMaterial>,
): THREE.Material | THREE.Material[] {
  if (Array.isArray(material)) return material.map((entry) => cloneEyeGlowMaterial(entry, registry) as THREE.Material);
  if (!(material instanceof THREE.MeshStandardMaterial)) return material;
  const clone = material.clone();
  clone.emissive.setRGB(...WARRIOR_EYE_GLOW.colorLinear);
  clone.emissiveIntensity = WARRIOR_EYE_GLOW.minIntensity;
  clone.userData = { ...clone.userData, eyeGlow: { ...WARRIOR_EYE_GLOW } };
  registry.add(clone);
  return clone;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function assertWarriorHierarchy(skeleton: SkeletonBuildResult): void {
  const expectedParents: ReadonlyArray<readonly [string, string]> = [
    ['right-shoulder', 'right-clavicle'],
    ['right-elbow', 'right-shoulder'],
    ['right-wrist', 'right-elbow'],
    ['right-hand', 'right-wrist'],
    ['staff-grip', 'right-hand'],
    ['cheese-pendulum', 'staff-grip'],
    ['ear-left', 'head'],
    ['ear-left-tip', 'ear-left'],
    ['ear-right', 'head'],
    ['ear-right-tip', 'ear-right'],
    ['hat-back', 'head'],
    ['whisker-73-base', 'head'],
    ['whisker-73-tip', 'whisker-73-base'],
    ['whisker-74-base', 'head'],
    ['whisker-74-tip', 'whisker-74-base'],
    ['whisker-76-base', 'head'],
    ['whisker-76-tip', 'whisker-76-base'],
    ['whisker-77-base', 'head'],
    ['whisker-77-tip', 'whisker-77-base'],
    ['cape-right', 'chest'],
    ['coat-right', 'pelvis'],
    ['coat-left', 'pelvis'],
    ['coat-front', 'pelvis'],
    ['coat-front-mid', 'coat-front'],
    ['coat-front-tip', 'coat-front-mid'],
    ['sash-tail', 'pelvis'],
    ['sash-tail-mid', 'sash-tail'],
    ['sash-tail-tip', 'sash-tail-mid'],
    ['mouse-tail', 'pelvis'],
    ['mouse-tail-mid', 'mouse-tail'],
    ['mouse-tail-tip', 'mouse-tail-mid'],
    ['right-toes', 'right-foot'],
    ['left-toes', 'left-foot'],
    ['left-shoulder', 'left-clavicle'],
    ['left-elbow', 'left-shoulder'],
    ['left-wrist', 'left-elbow'],
    ['left-hand', 'left-wrist'],
  ];
  for (const [childId, parentId] of expectedParents) {
    const child = skeleton.bones.get(childId);
    const parent = skeleton.bones.get(parentId);
    if (!child || !parent || child.parent !== parent) {
      throw new Error(`warrior rig hierarchy requires ${parentId} -> ${childId}`);
    }
  }
}

function joint(
  id: string,
  parentId: string | undefined,
  role: string,
  restPosition: readonly [number, number, number],
  axis: readonly [number, number, number],
): RigJoint {
  return { id, parentId, role, restPosition, restRotation: IDENTITY, axis };
}

function staffThrustTracks(): CharacterActionSpec['tracks'] {
  const shoulder = new THREE.Vector3(-0.04667465016245842, 0.5167526006698608, 0.11597828194499016);
  const elbow = new THREE.Vector3(-0.09913896024227142, 0.4484771192073822, 0.07011058181524277);
  const hand = new THREE.Vector3(-0.16876797378063202, 0.30188463628292084, 0.1280696615576744);
  const axis = new THREE.Vector3().fromArray(WARRIOR_STAFF_ACTION.axis).normalize();
  const clearance = new THREE.Vector3()
    .fromArray(WARRIOR_STAFF_ACTION.clearanceDirection)
    .multiplyScalar(WARRIOR_STAFF_ACTION.clearanceOffsetMetres);
  const upperRest = elbow.clone().sub(shoulder);
  const lowerRest = hand.clone().sub(elbow);
  const upperLength = upperRest.length();
  const lowerLength = lowerRest.length();
  const planeNormal = upperRest.clone().cross(hand.clone().sub(shoulder)).normalize();
  const controls = [
    { time: 0, thrust: 0 },
    { time: 0.18, thrust: 0 },
    { time: WARRIOR_STAFF_ACTION.impactTimeSeconds, thrust: WARRIOR_STAFF_ACTION.thrustMetres },
    { time: 0.62, thrust: 0.018 },
    { time: 0.92, thrust: 0.008 },
    { time: 1.15, thrust: 0 },
    { time: 1.35, thrust: 0 },
  ] as const;
  const times = new Set<number>(controls.map((control) => control.time));
  const frameSeconds = 1 / WARRIOR_STAFF_ACTION.ikSampleRateHz;
  for (let time = 0; time < 1.35; time += frameSeconds) times.add(time);
  times.add(1.35);
  const orderedTimes = [...times].sort((a, b) => a - b);
  const shoulderValues: Array<readonly [number, number, number]> = [];
  const elbowValues: Array<readonly [number, number, number]> = [];
  const wristValues: Array<readonly [number, number, number]> = [];
  for (const time of orderedTimes) {
    const thrust = sampleStaffThrust(controls, time);
    const target = hand.clone().add(clearance).addScaledVector(axis, thrust);
    const shoulderToTarget = target.clone().sub(shoulder);
    const reach = shoulderToTarget.length();
    if (reach > upperLength + lowerLength + 1e-9) {
      throw new Error(`staff thrust target exceeds the measured arm reach at ${time.toFixed(6)} s`);
    }
    const direction = shoulderToTarget.clone().normalize();
    const perpendicular = planeNormal.clone().cross(direction).normalize();
    if (elbow.clone().sub(shoulder).dot(perpendicular) < 0) perpendicular.negate();
    const along = (
      upperLength * upperLength - lowerLength * lowerLength + reach * reach
    ) / (2 * reach);
    const outward = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));
    const solvedElbow = shoulder.clone().addScaledVector(direction, along).addScaledVector(perpendicular, outward);
    const shoulderRotation = new THREE.Quaternion().setFromUnitVectors(
      upperRest.clone().normalize(),
      solvedElbow.clone().sub(shoulder).normalize(),
    );
    const desiredLowerLocal = target.clone().sub(solvedElbow).normalize()
      .applyQuaternion(shoulderRotation.clone().invert());
    const elbowRotation = new THREE.Quaternion().setFromUnitVectors(
      lowerRest.clone().normalize(),
      desiredLowerLocal,
    );
    const wristRotation = shoulderRotation.clone().multiply(elbowRotation).invert();
    shoulderValues.push(quaternionEuler(shoulderRotation));
    elbowValues.push(quaternionEuler(elbowRotation));
    wristValues.push(quaternionEuler(wristRotation));
  }
  return [
    rotation('right-shoulder', orderedTimes, shoulderValues),
    rotation('right-elbow', orderedTimes, elbowValues),
    rotation('right-wrist', orderedTimes, wristValues),
  ];
}

function sampleStaffThrust(
  controls: ReadonlyArray<{ readonly time: number; readonly thrust: number }>,
  time: number,
): number {
  for (let index = 1; index < controls.length; index += 1) {
    const end = controls[index];
    if (time > end.time) continue;
    const start = controls[index - 1];
    const mix = (time - start.time) / (end.time - start.time);
    return THREE.MathUtils.lerp(start.thrust, end.thrust, mix);
  }
  return controls.length > 0 ? controls[controls.length - 1].thrust : 0;
}

function quaternionEuler(quaternion: THREE.Quaternion): readonly [number, number, number] {
  const value = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
  return [value.x, value.y, value.z];
}

/**
 * Tripo Motion 1 rotates the complete hand socket, not the shaft mesh. At
 * every measured source key the staff axis takes the same 7 degree
 * shortest-arc step toward character-front, retaining the source variation.
 */
function turnTripo1HandAndStaffForward(action: CharacterActionSpec): CharacterActionSpec {
  type RotationTrack = {
    readonly target: string;
    readonly property: 'rotation';
    readonly times: readonly number[];
    readonly values: ReadonlyArray<readonly [number, number, number]>;
  };
  const rotationTracks = new Map<string, RotationTrack>();
  for (const track of action.tracks) {
    if (track.property === 'rotation') rotationTracks.set(track.target, track as RotationTrack);
  }
  const elbowTrack = rotationTracks.get('right-elbow');
  if (!elbowTrack) throw new Error('Tripo Motion 1 requires a right-elbow rotation track');
  const upstreamTargets = ['pelvis', 'spine', 'chest', 'right-shoulder', 'right-elbow'] as const;
  const restStaffAxis = new THREE.Vector3().fromArray(WARRIOR_STAFF_ACTION.axis).normalize();
  const characterFront = new THREE.Vector3(0, 0, 1);
  const handValues = elbowTrack.times.map((time) => {
    const upstream = new THREE.Quaternion();
    for (const target of upstreamTargets) {
      const track = rotationTracks.get(target);
      if (!track) throw new Error(`Tripo Motion 1 requires a ${target} rotation track`);
      upstream.multiply(sampleRotationQuaternion(track, time));
    }
    const staffDirection = restStaffAxis.clone().applyQuaternion(upstream);
    // The principal axis measured from a rod is unsigned. Keep the nearer end
    // facing character-front before solving the shortest correction so a
    // source pose that crosses the +Z hemisphere cannot reverse the turn.
    if (staffDirection.dot(characterFront) < 0) staffDirection.negate();
    const angleToFront = staffDirection.angleTo(characterFront);
    const worldAxis = staffDirection.cross(characterFront);
    if (worldAxis.lengthSq() < 1e-12 || angleToFront < 1e-12) return [0, 0, 0] as const;
    worldAxis.normalize();
    const worldCorrection = new THREE.Quaternion().setFromAxisAngle(
      worldAxis,
      Math.min(WARRIOR_TRIPO1_STAFF_FORWARD.correctionRadians, angleToFront),
    );
    const localHandCorrection = upstream.clone().invert()
      .multiply(worldCorrection)
      .multiply(upstream);
    return quaternionEuler(localHandCorrection);
  });
  return {
    ...action,
    tracks: [
      ...action.tracks.filter((track) => !(track.target === 'right-hand' && track.property === 'rotation')),
      rotation('right-hand', elbowTrack.times, handValues),
    ],
  };
}

function sampleRotationQuaternion(
  track: {
    readonly times: readonly number[];
    readonly values: ReadonlyArray<readonly [number, number, number]>;
  },
  time: number,
): THREE.Quaternion {
  let end = track.times.findIndex((candidate) => candidate >= time);
  if (end < 0) end = track.times.length - 1;
  if (end === 0 || track.times[end] === time) {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(...track.values[end], 'XYZ'));
  }
  const start = end - 1;
  const span = track.times[end] - track.times[start];
  const mix = span > 0 ? (time - track.times[start]) / span : 0;
  const startQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(...track.values[start], 'XYZ'));
  const endQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(...track.values[end], 'XYZ'));
  return startQuaternion.slerp(endQuaternion, mix);
}

function rotation(
  target: string,
  times: readonly number[],
  values: ReadonlyArray<readonly [number, number, number]>,
): CharacterActionSpec['tracks'][number] {
  return { target, property: 'rotation', times, values };
}

function position(
  target: string,
  times: readonly number[],
  values: ReadonlyArray<readonly [number, number, number]>,
): CharacterActionSpec['tracks'][number] {
  return { target, property: 'position', times, values };
}

function hatMotion(
  times: readonly number[],
  amplitude: number,
  loop: boolean,
): CharacterActionSpec['tracks'] {
  const values = times.map((_, index) => {
    const u = index / (times.length - 1);
    const envelope = loop ? 1 : Math.sin(Math.PI * u);
    const phase = (loop ? 2 : 3) * Math.PI * u;
    return [
      amplitude * 0.70 * Math.sin(phase) * envelope,
      amplitude * 0.28 * Math.cos(phase) * envelope,
      amplitude * 0.22 * Math.sin(phase + 0.45) * envelope,
    ] as [number, number, number];
  });
  return [rotation('hat-back', times, values)];
}

function whiskerMotion(
  times: readonly number[],
  tipAmplitude: number,
  loop: boolean,
): CharacterActionSpec['tracks'] {
  const definitions = [
    { node: 73, direction: 1, phaseOffset: 0 },
    { node: 74, direction: -1, phaseOffset: 0.72 },
    { node: 76, direction: 1, phaseOffset: 1.34 },
    { node: 77, direction: -1, phaseOffset: 2.02 },
  ] as const;
  return definitions.flatMap(({ node, direction, phaseOffset }) => {
    const values = (amplitude: number) => times.map((_, index) => {
      const u = index / (times.length - 1);
      const envelope = loop ? 1 : Math.sin(Math.PI * u);
      const phase = (loop ? 4 : 5) * Math.PI * u + phaseOffset;
      return [
        amplitude * 0.18 * Math.cos(phase) * envelope,
        amplitude * 0.32 * Math.sin(phase + 0.38) * envelope,
        direction * amplitude * Math.sin(phase) * envelope,
      ] as [number, number, number];
    });
    return [
      rotation(`whisker-${node}-base`, times, values(tipAmplitude * 0.32)),
      rotation(`whisker-${node}-tip`, times, values(tipAmplitude)),
    ];
  });
}

function distributeFlexibleSurfaceMotion(
  tracks: CharacterActionSpec['tracks'],
  loop: boolean,
): CharacterActionSpec['tracks'] {
  return tracks.flatMap((track) => {
    if (track.property !== 'rotation') return [track];
    const scaledTrack = (target: string, scale: number) => rotation(
      target,
      track.times,
      track.values.map(([x, y, z]) => [x * scale, y * scale, z * scale]),
    );
    if (track.target === 'ear-left' || track.target === 'ear-right') {
      return [
        scaledTrack(track.target, 0.5),
        scaledTrack(`${track.target}-tip`, 0.5),
      ];
    }
    if (track.target === 'mouse-tail') {
      const delaySeconds = 1 / WARRIOR_TAIL_WAVE.sourceSampleRateHz;
      return [
        shiftedScaledRotationTrack(track, 'mouse-tail', 0, 1 / 3, loop),
        shiftedScaledRotationTrack(
          track,
          'mouse-tail-mid',
          WARRIOR_TAIL_WAVE.midDelayFrames * delaySeconds,
          1 / 3,
          loop,
        ),
        shiftedScaledRotationTrack(
          track,
          'mouse-tail-tip',
          WARRIOR_TAIL_WAVE.tipDelayFrames * delaySeconds,
          1 / 3,
          loop,
        ),
      ];
    }
    return [track];
  });
}

function ensureMouseTailMotion(action: CharacterActionSpec): CharacterActionSpec['tracks'] {
  if (action.tracks.some((track) => track.target === 'mouse-tail' && track.property === 'rotation')) {
    return action.tracks;
  }
  const times = measuredSourceTimes(action.duration);
  return [
    ...action.tracks,
    rotation('mouse-tail', times, resampleQuarterRotation(times, action.duration, [
      [0, -0.08, 0.02],
      [0.04, 0.15, -0.04],
      [0, 0.08, 0.03],
      [-0.04, -0.15, -0.04],
      [0, -0.08, 0.02],
    ])),
  ];
}

function shiftedScaledRotationTrack(
  track: CharacterActionSpec['tracks'][number],
  target: string,
  delaySeconds: number,
  scale: number,
  loop: boolean,
): CharacterActionSpec['tracks'][number] {
  if (track.property !== 'rotation') throw new Error('tail wave requires a rotation track');
  const first = track.times[0];
  const last = track.times[track.times.length - 1];
  const duration = last - first;
  const values = track.times.map((time) => {
    let sampleTime = time - delaySeconds;
    if (loop && duration > 0) sampleTime = first + (((sampleTime - first) % duration) + duration) % duration;
    else sampleTime = THREE.MathUtils.clamp(sampleTime, first, last);
    const [x, y, z] = sampleRotationVector(track, sampleTime);
    return [x * scale, y * scale, z * scale] as const;
  });
  return rotation(target, track.times, values);
}

function sampleRotationVector(
  track: {
    readonly times: readonly number[];
    readonly values: ReadonlyArray<readonly [number, number, number]>;
  },
  time: number,
): readonly [number, number, number] {
  let end = track.times.findIndex((candidate) => candidate >= time);
  if (end < 0) end = track.times.length - 1;
  if (end === 0 || track.times[end] === time) return track.values[end];
  const start = end - 1;
  const span = track.times[end] - track.times[start];
  const mix = span > 0 ? (time - track.times[start]) / span : 0;
  return [
    THREE.MathUtils.lerp(track.values[start][0], track.values[end][0], mix),
    THREE.MathUtils.lerp(track.values[start][1], track.values[end][1], mix),
    THREE.MathUtils.lerp(track.values[start][2], track.values[end][2], mix),
  ];
}

function measuredSourceTimes(duration: number): number[] {
  const frameCount = Math.round(duration * WARRIOR_TRIPO_MOTION_4_HIDE.sourceSampleRateHz);
  return Array.from({ length: frameCount + 1 }, (_, frame) => Math.min(
    duration,
    frame / WARRIOR_TRIPO_MOTION_4_HIDE.sourceSampleRateHz,
  ));
}

function resampleQuarterRotation(
  times: readonly number[],
  duration: number,
  controls: ReadonlyArray<readonly [number, number, number]>,
): Array<readonly [number, number, number]> {
  if (controls.length !== 5) throw new Error('secondary rotation requires five quarter controls');
  return times.map((time) => {
    const frame = THREE.MathUtils.clamp((time / duration) * 4, 0, 4);
    const start = Math.min(3, Math.floor(frame));
    const mix = frame - start;
    return [
      THREE.MathUtils.lerp(controls[start][0], controls[start + 1][0], mix),
      THREE.MathUtils.lerp(controls[start][1], controls[start + 1][1], mix),
      THREE.MathUtils.lerp(controls[start][2], controls[start + 1][2], mix),
    ];
  });
}

function sourceSecondaryMotion(
  duration: number,
  loop: boolean,
  intensity: number,
): CharacterActionSpec['tracks'] {
  const times = [0, duration * 0.25, duration * 0.5, duration * 0.75, duration];
  const flexibleTimes = measuredSourceTimes(duration);
  const scaled = (value: number): number => value * intensity;
  const flexibleRotation = (
    target: string,
    controls: ReadonlyArray<readonly [number, number, number]>,
  ) => rotation(target, flexibleTimes, resampleQuarterRotation(flexibleTimes, duration, controls));
  return [
    ...hatMotion(flexibleTimes, scaled(0.026), loop),
    ...whiskerMotion(flexibleTimes, scaled(0.070), loop),
    flexibleRotation('ear-left', [[0, 0, 0], [scaled(-0.018), scaled(0.010), scaled(0.028)], [scaled(0.012), scaled(-0.008), scaled(-0.020)], [scaled(-0.014), scaled(0.006), scaled(0.022)], [0, 0, 0]]),
    flexibleRotation('ear-right', [[0, 0, 0], [scaled(0.016), scaled(-0.010), scaled(-0.026)], [scaled(-0.010), scaled(0.008), scaled(0.018)], [scaled(0.014), scaled(-0.006), scaled(-0.020)], [0, 0, 0]]),
    rotation('cape-right', times, [[0, 0, 0], [scaled(0.07), 0, scaled(0.04)], [scaled(-0.04), 0, scaled(-0.03)], [scaled(0.09), 0, scaled(-0.04)], [0, 0, 0]]),
    rotation('coat-right', times, [[0, 0, 0], [scaled(0.11), 0, scaled(0.06)], [scaled(-0.05), 0, scaled(-0.04)], [scaled(0.13), 0, scaled(-0.06)], [0, 0, 0]]),
    rotation('coat-left', times, [[0, 0, 0], [scaled(0.10), 0, scaled(-0.06)], [scaled(-0.04), 0, scaled(0.04)], [scaled(0.12), 0, scaled(0.06)], [0, 0, 0]]),
    rotation('coat-front', times, [[scaled(-0.03), 0, 0], [scaled(-0.07), 0, scaled(0.02)], [scaled(-0.04), 0, 0], [scaled(-0.08), 0, scaled(-0.02)], [scaled(-0.03), 0, 0]]),
    rotation('coat-front-mid', times, [[scaled(-0.04), 0, 0], [scaled(-0.09), scaled(-0.01), scaled(0.018)], [scaled(-0.055), scaled(0.012), scaled(-0.02)], [scaled(-0.085), scaled(-0.008), scaled(0.016)], [scaled(-0.04), 0, 0]]),
    rotation('coat-front-tip', times, [[scaled(-0.065), 0, 0], [scaled(-0.15), scaled(-0.018), scaled(0.03)], [scaled(-0.085), scaled(0.022), scaled(-0.034)], [scaled(-0.14), scaled(-0.014), scaled(0.026)], [scaled(-0.065), 0, 0]]),
    rotation('sash-tail', times, [[0, 0, 0], [scaled(0.15), 0, scaled(0.10)], [scaled(-0.08), 0, scaled(-0.08)], [scaled(0.17), 0, scaled(-0.11)], [0, 0, 0]]),
    rotation('sash-tail-mid', times, [[0, 0, 0], [scaled(-0.06), scaled(0.022), scaled(-0.08)], [scaled(0.07), scaled(-0.026), scaled(0.09)], [scaled(-0.055), scaled(0.020), scaled(-0.072)], [0, 0, 0]]),
    rotation('sash-tail-tip', times, [[0, 0, 0], [scaled(-0.10), scaled(0.036), scaled(-0.13)], [scaled(0.12), scaled(-0.042), scaled(0.15)], [scaled(-0.09), scaled(0.032), scaled(-0.12)], [0, 0, 0]]),
    flexibleRotation('mouse-tail', [[0, scaled(-0.08), scaled(0.02)], [scaled(0.04), scaled(0.15), scaled(-0.04)], [0, scaled(0.08), scaled(0.03)], [scaled(-0.04), scaled(-0.15), scaled(-0.04)], [0, scaled(-0.08), scaled(0.02)]]),
    rotation('cheese-pendulum', times, [[0, 0, 0], [scaled(-0.12), 0, scaled(0.16)], [scaled(0.08), 0, scaled(-0.10)], [scaled(0.14), 0, scaled(-0.18)], [0, 0, 0]]),
  ];
}
