/**
 * CharacterIR is deliberately renderer-agnostic.  It contains semantic
 * character data and plain tuples; Three.js types belong to compiler/runtime.
 */

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export type EvidenceState = "observed" | "inferred" | "unknown";

export interface Evidence<T> {
  value: T;
  confidence: number;
  observed: boolean;
  inferred: boolean;
  state: EvidenceState;
  sourceView?: string;
  sourceRef?: string;
  notes?: string[];
}

export interface CameraEvidence {
  projection: "perspective" | "orthographic" | "unknown";
  fovDegrees?: number;
  orthographicHalfHeight?: number;
  aspect?: number;
  position?: Vec3;
  target?: Vec3;
  confidence: number;
  sourceView?: string;
}

export interface SilhouetteEvidence {
  viewId: string;
  polygon: Vec2[];
  confidence: number;
  observed: boolean;
}

export interface LandmarkEvidence {
  id: string;
  semanticRole: string;
  position: Vec3;
  confidence: number;
  observed: boolean;
  sourceView?: string;
}

export interface SemanticRegionEvidence {
  id: string;
  label: string;
  bounds?: { min: Vec3; max: Vec3 };
  confidence: number;
  observed: boolean;
  parentId?: string;
}

export interface PoseEvidence {
  jointAngles?: Record<string, number>;
  landmarks?: string[];
  restPoseConfidence: number;
  confidence: number;
}

export interface ProportionEvidence {
  id: string;
  ratio: number;
  numerator: string;
  denominator: string;
  confidence: number;
  observed: boolean;
}

export interface DepthEvidence {
  region: string;
  relativeDepth: number;
  confidence: number;
  sourceView?: string;
}

export interface OcclusionGraph {
  edges: Array<{ occluder: string; occluded: string; confidence: number }>;
}

export interface SymmetryEvidence {
  plane: "sagittal" | "coronal" | "transverse" | "none";
  score: number;
  exceptions: string[];
  confidence: number;
}

export interface CrossSectionEvidence {
  region: string;
  t: number;
  width: number;
  depth: number;
  rotation?: Quat;
  confidence: number;
}

export interface MaterialEvidence {
  id: string;
  semanticType: string;
  baseColor?: Vec3;
  roughness?: number;
  metalness?: number;
  transmission?: number;
  confidence: number;
  sourceView?: string;
}

export type SurfaceFeatureRepresentation =
  | "texture"
  | "material-mask"
  | "decal"
  | "surface-curve"
  | "normal-detail"
  | "height-detail"
  | "geometry-relief";

export interface SurfaceFeatureEvidence {
  id: string;
  region: string;
  representation: SurfaceFeatureRepresentation;
  coordinate?: SemanticSurfaceCoordinate;
  confidence: number;
  observed: boolean;
}

export interface FiberEvidence {
  id: string;
  emitter: string;
  flow?: Vec3;
  length?: number;
  density?: number;
  confidence: number;
}

export interface WearableEvidence {
  id: string;
  label: string;
  covers: string[];
  attachment?: string;
  confidence: number;
}

export type EvidenceConfidenceMap = Record<
  string,
  { confidence: number; state: EvidenceState; reason?: string }
>;

export interface CharacterEvidence {
  camera: CameraEvidence;
  captureProfiles: CaptureProfile[];
  silhouettes: SilhouetteEvidence[];
  landmarks: LandmarkEvidence[];
  semanticRegions: SemanticRegionEvidence[];
  pose: PoseEvidence;
  proportions: ProportionEvidence[];
  depthHints: DepthEvidence[];
  occlusionGraph: OcclusionGraph;
  symmetry: SymmetryEvidence;
  crossSectionHints: CrossSectionEvidence[];
  materials: MaterialEvidence[];
  surfaceFeatures: SurfaceFeatureEvidence[];
  fibers: FiberEvidence[];
  wearables: WearableEvidence[];
  uncertainty: EvidenceConfidenceMap;
}

export interface CaptureProfile {
  id: string;
  view: "front" | "three-quarter" | "side" | "rear";
  authority: "bind-pose" | "visible-design";
  poseProfileId: string;
  camera: CameraEvidence;
}

export interface AppendageArchetype {
  id: string;
  semanticRole: string;
  count: number;
  bilateral?: boolean;
  articulation?: string;
  rigidity?: "soft" | "rigid" | "mixed";
}

export interface CharacterArchetype {
  baseFamily: string;
  traits: string[];
  appendages: AppendageArchetype[];
  anatomicalPrior?: string;
  symmetryPrior?: string;
  rigidityProfile?: string;
}

export interface CharacterCoordinateSystem {
  up: "+Y";
  front: "+Z";
  lateral: "X";
  groundY: 0;
  height: 1;
  leftSign: 1;
}

export type SemanticRelation =
  | "parent"
  | "continuous-with"
  | "articulates-with"
  | "attached-to"
  | "covers"
  | "grows-from"
  | "deforms-with"
  | "mirrors"
  | "surface-bound";

export interface SemanticNode {
  id: string;
  kind: string;
  label?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface SemanticEdge {
  from: string;
  to: string;
  relation: SemanticRelation;
  confidence?: number;
}

export interface SemanticGraph {
  nodes: SemanticNode[];
  edges: SemanticEdge[];
}

export interface ProportionModel {
  stature: number;
  headScale: number;
  shoulderBreadth: number;
  thoraxWidth: number;
  thoraxDepth: number;
  waistWidth: number;
  pelvisWidth: number;
  armSpan: number;
  upperArmLength: number;
  forearmLength: number;
  handLength: number;
  thighLength: number;
  lowerLegLength: number;
  footLength: number;
  customSegments: SegmentMeasurement[];
}

export type ProportionKey = Exclude<keyof ProportionModel, "customSegments">;
export type TransformAxis = "x" | "y" | "z";

/**
 * Declarative bridge between solved proportions and authored character data.
 * A binding scales selected coordinates around an explicit origin. This keeps
 * archetype-specific intent in CharacterIR while the resolver stays generic.
 */
export type ProportionBindingTarget =
  | { kind: "loft-section-center"; ids: string[]; axes: TransformAxis[]; origin?: Vec3 }
  | { kind: "loft-section-size"; ids: string[]; components: Array<"width" | "depth"> }
  | { kind: "rig-joint-position"; ids: string[]; axes: TransformAxis[]; origin?: Vec3 }
  | { kind: "accessory-position"; ids: string[]; axes: TransformAxis[]; origin?: Vec3 }
  | { kind: "accessory-size"; ids: string[]; axes: TransformAxis[] }
  | { kind: "landmark-position"; ids: string[]; axes: TransformAxis[]; origin?: Vec3 }
  | { kind: "face-skull-radius"; axes: TransformAxis[] }
  | { kind: "hand-digit-point"; handIds: string[]; axes: TransformAxis[]; origin?: Vec3 };

export interface ProportionBinding {
  id: string;
  proportion: ProportionKey;
  referenceValue: number;
  targets: ProportionBindingTarget[];
}

export interface SegmentMeasurement {
  id: string;
  length: number;
  width?: number;
  depth?: number;
  confidence: number;
}

export interface FacialLandmark {
  id: string;
  role: string;
  position: Vec3;
  confidence: number;
}

export interface SkullModel {
  center: Vec3;
  radius: Vec3;
  jawWidth: number;
  jawDepth: number;
}

export interface FacialCurve {
  id: string;
  role: string;
  points: Vec3[];
}

export interface FacialPatch {
  id: string;
  role: string;
  vertices: Vec3[];
}

export interface ExpressionZone {
  id: string;
  region: string;
  morphIds: string[];
}

export interface FaceGraph {
  skull: SkullModel;
  landmarks: FacialLandmark[];
  curves: FacialCurve[];
  patches: FacialPatch[];
  expressionZones: ExpressionZone[];
  morphSet: MorphDefinition[];
}

export interface SectionLandmark {
  id: string;
  position: Vec2;
  role: string;
}

export interface SectionAsymmetry {
  lateralBias: number;
  depthBias: number;
}

export interface Influence {
  source: string;
  strength: number;
}

export interface CharacterCrossSection {
  t: number;
  center: Vec3;
  orientation: Quat;
  contour: Vec2[];
  width: number;
  depth: number;
  landmarks: SectionLandmark[];
  asymmetry?: SectionAsymmetry;
  anatomicalInfluences?: Influence[];
  deformationZone?: string;
}

export type TopologyIntent =
  | "deformable-organic"
  | "rigid-surface"
  | "fiber"
  | "shell"
  | "explicit";

export interface ContinuityConstraint {
  regionA: string;
  regionB: string;
  positionalContinuity: boolean;
  tangentContinuity?: boolean;
  curvaturePreference?: number;
  topologyBridge?: string;
  deformationBridge?: string;
}

export interface SemanticCurve {
  id: string;
  role: string;
  points: Vec3[];
  closed?: boolean;
  tension?: number;
}

export interface AnatomicalLoft {
  id: string;
  region: string;
  axis: SemanticCurve;
  sections: CharacterCrossSection[];
  continuityConstraints: ContinuityConstraint[];
  topologyIntent: TopologyIntent;
  materialId?: string;
}

export interface ShapeGraph {
  lofts: AnatomicalLoft[];
  hands: HandShapeSpec[];
  curves: SemanticCurve[];
  face?: FaceGraph;
  implicitFields: Array<{ id: string; region: string; resolution: number }>;
  patches: Array<{ id: string; region: string; vertices: Vec3[] }>;
}

export interface HandDigitSpec {
  id: string;
  jointId: string;
  points: Vec3[];
  radiusStart: number;
  radiusEnd: number;
  sides: number;
}

export interface HandShapeSpec {
  id: string;
  loftId: string;
  digits: HandDigitSpec[];
}

export interface SurfacePatch {
  id: string;
  region: string;
  vertexIds: number[];
  semanticCoordinates?: string[];
}

export interface EdgeLoop {
  id: string;
  region: string;
  vertexIds: number[];
}

export interface JointTopologyZone {
  joint: string;
  preJointLoops: number;
  coreLoops: number;
  postJointLoops: number;
  compressionSide?: Vec3;
  extensionSide?: Vec3;
  twistRegion?: [number, number];
  deformationDensity: number;
}

export interface FacialLoop {
  id: string;
  role: string;
  vertexIds: number[];
}

export interface TopologyPole {
  vertexId: number;
  valence: number;
  reason: string;
}

export interface TopologySeam {
  id: string;
  regionA: string;
  regionB: string;
  intentional: boolean;
}

export interface DensityField {
  region: string;
  density: "low" | "medium" | "high" | "very-high";
  weight: number;
}

export interface TopologyGraph {
  patches: SurfacePatch[];
  edgeLoops: EdgeLoop[];
  jointZones: JointTopologyZone[];
  facialLoops: FacialLoop[];
  poles: TopologyPole[];
  seams: TopologySeam[];
  densityFields: DensityField[];
}

export interface TangentSpaceSpec {
  algorithm: "mikktspace";
  requirePosition: true;
  requireNormal: true;
  requireUV: true;
}

export interface SemanticSurfaceCoordinate {
  region: string;
  u: number;
  v: number;
  normalOffset: number;
}

export interface SurfaceFeature {
  id: string;
  region: string;
  representation: SurfaceFeatureRepresentation;
  coordinate?: SemanticSurfaceCoordinate;
  points?: Vec3[];
  intensity?: number;
  materialId?: string;
  sourceAccessoryId?: string;
}

export interface SurfaceGraph {
  features: SurfaceFeature[];
  coordinates: Record<string, SemanticSurfaceCoordinate>;
  tangentSpace: TangentSpaceSpec;
  uvStrategy: "semantic-region" | "atlas" | "procedural";
  projection?: { sourceRef: string; cameraId: string; coverage: number };
}

export interface TextureRef {
  id: string;
  uri?: string;
  colorSpace?: "srgb" | "linear";
  channel?: "albedo" | "roughness" | "normal" | "height" | "mask" | "thickness";
}

export type TextureOrValue = Vec3 | number | TextureRef;

export interface SSSSpec {
  thickness: TextureOrValue;
  attenuation: number;
  color: Vec3;
  distortion: number;
  power: number;
  scale: number;
}

export interface SkinAppearance {
  baseColor: TextureOrValue;
  colorVariation?: TextureOrValue;
  roughness: TextureOrValue;
  microNormal?: TextureRef;
  poreNormal?: TextureRef;
  thickness?: TextureOrValue;
  subsurface?: SSSSpec;
  oilMask?: TextureRef;
}

export interface MaterialDefinition {
  id: string;
  semanticType: "skin" | "eye" | "hair" | "cloth" | "leather" | "scales" | "armor" | "custom";
  baseColor: Vec3;
  roughness: number;
  metalness: number;
  transmission?: number;
  thickness?: number;
  clearcoat?: number;
  sheen?: number;
  anisotropy?: number;
  iridescence?: number;
  emissive?: Vec3;
  flatShading?: boolean;
  skin?: SkinAppearance;
  backend?: "physical" | "sss-node" | "custom-tsl";
}

export interface AppearanceGraph {
  materials: MaterialDefinition[];
  variants: Record<string, Record<string, Partial<MaterialDefinition>>>;
}

export interface RigJoint {
  id: string;
  parentId?: string;
  role: string;
  restPosition: Vec3;
  restRotation: Quat;
  rotationLimits?: { min: Vec3; max: Vec3 };
  axis?: Vec3;
}

export interface RigChain {
  id: string;
  joints: string[];
  role: string;
}

export interface JointConstraint {
  joint: string;
  type: "hinge" | "ball" | "cone" | "fixed";
  axis?: Vec3;
  min?: number;
  max?: number;
}

export interface Effector {
  id: string;
  joint: string;
  target?: string;
}

export interface TwistSystem {
  id: string;
  sourceJoint: string;
  targetJoints: string[];
  distribution: number[];
}

export interface RigDriver {
  id: string;
  source: string;
  target: string;
  response: Array<[number, number]>;
}

export interface IKChain {
  id: string;
  joints: string[];
  effector: string;
  target: string;
  constraints?: string[];
  solverHint?: string;
}

export interface RigGraph {
  joints: RigJoint[];
  chains: RigChain[];
  constraints: JointConstraint[];
  effectors: Effector[];
  twistSystems: TwistSystem[];
  drivers: RigDriver[];
  ikChains: IKChain[];
}

export interface SkinningSpec {
  strategy: "proximity" | "geodesic" | "semantic-region" | "manual";
  maxInfluences: 4;
  normalize: true;
}

export interface CorrectiveMorph {
  id: string;
  region: string;
  driver: string;
  threshold: number;
  maxWeight: number;
  deltas?: Vec3[];
}

export interface VolumeRule {
  region: string;
  joint: string;
  preserve: number;
}

export interface MuscleDriver {
  id: string;
  sourceJoint: string;
  region: string;
  response: Array<[number, number]>;
}

export interface SoftTissueRule {
  region: string;
  stiffness: number;
  damping: number;
}

export interface MorphDriver {
  source: string;
  target: string;
  response: Array<[number, number]>;
}

export interface SurfaceFollower {
  featureId: string;
  bodyRegion: string;
  strategy: "uv" | "raycast" | "decal" | "parented";
}

export interface DeformationGraph {
  skinning: SkinningSpec;
  jointCorrectives: CorrectiveMorph[];
  twistDistribution: TwistSystem[];
  volumePreservation: VolumeRule[];
  muscleDrivers: MuscleDriver[];
  softTissue?: SoftTissueRule[];
  morphDrivers: MorphDriver[];
  surfaceFollowers: SurfaceFollower[];
}

export type MorphType = "expression" | "corrective" | "body-shape" | "creature" | "runtime";

export interface MorphDefinition {
  id: string;
  region: string;
  type: MorphType;
  driver?: string;
  deltas?: Vec3[];
}

export interface MorphGraph {
  definitions: MorphDefinition[];
  relative: boolean;
}

export interface VectorField {
  id: string;
  type: "constant" | "linear" | "radial" | "custom";
  parameters: Record<string, number>;
}

export interface FiberRoot {
  id: string;
  emitter: string;
  coordinate: SemanticSurfaceCoordinate;
  normalOffset: number;
}

export interface GuideCurve {
  id: string;
  rootId: string;
  points: Vec3[];
  taper: number;
}

export interface FiberClump {
  id: string;
  guideIds: string[];
  spread: number;
  strandCount: number;
}

export interface FiberFlowGraph {
  emitter: string;
  roots: FiberRoot[];
  directionalField: VectorField;
  guides: GuideCurve[];
  clumps: FiberClump[];
  modifiers: { gravity?: number; curl?: number; attraction?: number; spread?: number };
}

export interface FiberDefinition {
  id: string;
  kind: "hair" | "fur" | "feather" | "whisker" | "fiber";
  flow: FiberFlowGraph;
  materialId: string;
  representation: "tube" | "ribbon" | "card" | "lock" | "shell";
  radius?: number;
  lod: number[];
}

export interface FiberGraph {
  definitions: FiberDefinition[];
}

export interface WearableSpec {
  id: string;
  kind: "shirt" | "pants" | "shorts" | "dress" | "shoe" | "glove" | "hat" | "armor" | "belt" | "jewelry" | "accessory";
  covers: string[];
  attachmentMode: "surface-follows" | "bone-attaches" | "skins-with" | "secondary-motion";
  offset: number;
  materialId: string;
  seamIds: string[];
  foldStrength: number;
  sourceAccessoryIds?: string[];
}

export interface WearableGraph {
  items: WearableSpec[];
}

export interface AppendageSpec {
  id: string;
  rootRegion: string;
  semanticRole: string;
  path?: SemanticCurve;
  profile?: Vec2[];
  geometryMode: "loft" | "tube" | "curve-sweep" | "sdf" | "explicit";
  rig?: RigGraph;
  deformation?: DeformationGraph;
  materialId?: string;
}

export interface AppendageGraph {
  items: AppendageSpec[];
}

export type AccessoryPrimitive =
  | "anchor"
  | "box"
  | "ellipsoid"
  | "dodecahedron"
  | "cylinder"
  | "cone"
  | "torus"
  | "polygon";

export interface AccessorySpec {
  id: string;
  semanticRole: string;
  layer: "L2" | "L3" | "L4" | "L5";
  primitive: AccessoryPrimitive;
  materialId: string;
  position: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  size?: Vec3;
  radius?: number;
  radiusTop?: number;
  radiusBottom?: number;
  tube?: number;
  radialSegments?: number;
  tubularSegments?: number;
  detail?: number;
  points?: Vec2[];
  jointId?: string;
  space?: "model" | "joint-local";
  flatShading?: boolean;
  doubleSided?: boolean;
  explodeWithParent?: boolean;
}

export interface AccessoryGraph {
  items: AccessorySpec[];
}

export interface RuntimeNode {
  id: string;
  kind: "root" | "mesh" | "joint" | "fiber" | "wearable" | "accessory" | "skeleton";
  parentId?: string;
  semanticRegion?: string;
}

export interface RuntimeGraph {
  nodes: RuntimeNode[];
  stableJointNames: string[];
  stableMorphNames: string[];
  poseProfiles: PoseProfile[];
}

export interface PoseProfile {
  id: string;
  role: "bind" | "design" | "capture";
  joints: Record<string, Quat>;
}

export interface OptimizationGraph {
  profile: "lite" | "standard" | "hero";
  geometryLod: number[];
  fiberLod: number[];
  boneBudget: number;
  morphBudget: number;
  textureBudgetMb: number;
  materialBudget: number;
}

export interface ValidationGraph {
  requiredGates: string[];
  thresholds: Record<string, number>;
  lastResults?: unknown[];
}

export interface CharacterMeta {
  id: string;
  name: string;
  version: string;
  fidelityProfile: "lite" | "standard" | "hero";
  sourceRefs: string[];
  assumptions: string[];
  nonGoals: string[];
}

export interface CharacterIR {
  meta: CharacterMeta;
  evidence: CharacterEvidence;
  archetype: CharacterArchetype;
  coordinateSystem: CharacterCoordinateSystem;
  semanticGraph: SemanticGraph;
  proportionModel: ProportionModel;
  proportionBindings: ProportionBinding[];
  landmarkGraph: { landmarks: FacialLandmark[]; semanticToId: Record<string, string> };
  shapeGraph: ShapeGraph;
  topologyGraph: TopologyGraph;
  surfaceGraph: SurfaceGraph;
  appearanceGraph: AppearanceGraph;
  rigGraph?: RigGraph;
  deformationGraph?: DeformationGraph;
  morphGraph?: MorphGraph;
  fiberGraph?: FiberGraph;
  wearableGraph?: WearableGraph;
  appendageGraph?: AppendageGraph;
  accessoryGraph?: AccessoryGraph;
  runtimeGraph: RuntimeGraph;
  optimizationGraph: OptimizationGraph;
  validationGraph: ValidationGraph;
}

export function emptyCharacterEvidence(): CharacterEvidence {
  return {
    camera: { projection: "perspective", confidence: 0.2 },
    captureProfiles: [],
    silhouettes: [],
    landmarks: [],
    semanticRegions: [],
    pose: { restPoseConfidence: 0.2, confidence: 0.2 },
    proportions: [],
    depthHints: [],
    occlusionGraph: { edges: [] },
    symmetry: { plane: "sagittal", score: 0.5, exceptions: [], confidence: 0.2 },
    crossSectionHints: [],
    materials: [],
    surfaceFeatures: [],
    fibers: [],
    wearables: [],
    uncertainty: {},
  };
}

export function createCharacterIR(
  name: string,
  archetype: CharacterArchetype,
  profile: "lite" | "standard" | "hero" = "standard",
): CharacterIR {
  return {
    meta: {
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "character",
      name,
      version: "0.1.0",
      fidelityProfile: profile,
      sourceRefs: [],
      assumptions: [],
      nonGoals: ["full cloth simulation", "soft-body physics", "motion synthesis", "strand simulation"],
    },
    evidence: emptyCharacterEvidence(),
    archetype,
    coordinateSystem: { up: "+Y", front: "+Z", lateral: "X", groundY: 0, height: 1, leftSign: 1 },
    semanticGraph: { nodes: [], edges: [] },
    proportionModel: {
      stature: 1,
      headScale: 0.13,
      shoulderBreadth: 0.24,
      thoraxWidth: 0.2,
      thoraxDepth: 0.12,
      waistWidth: 0.14,
      pelvisWidth: 0.18,
      armSpan: 0.52,
      upperArmLength: 0.17,
      forearmLength: 0.16,
      handLength: 0.1,
      thighLength: 0.25,
      lowerLegLength: 0.24,
      footLength: 0.13,
      customSegments: [],
    },
    proportionBindings: [],
    landmarkGraph: { landmarks: [], semanticToId: {} },
    shapeGraph: { lofts: [], hands: [], curves: [], implicitFields: [], patches: [] },
    topologyGraph: { patches: [], edgeLoops: [], jointZones: [], facialLoops: [], poles: [], seams: [], densityFields: [] },
    surfaceGraph: { features: [], coordinates: {}, tangentSpace: { algorithm: "mikktspace", requirePosition: true, requireNormal: true, requireUV: true }, uvStrategy: "semantic-region" },
    appearanceGraph: { materials: [], variants: {} },
    runtimeGraph: { nodes: [], stableJointNames: [], stableMorphNames: [], poseProfiles: [] },
    optimizationGraph: {
      profile,
      geometryLod: profile === "lite" ? [1, 0.55] : profile === "standard" ? [1, 0.65, 0.3] : [1, 0.75, 0.45, 0.2],
      fiberLod: profile === "hero" ? [1, 0.6, 0.25] : [1, 0.35],
      boneBudget: profile === "lite" ? 48 : profile === "standard" ? 96 : 160,
      morphBudget: profile === "lite" ? 8 : profile === "standard" ? 32 : 96,
      textureBudgetMb: profile === "lite" ? 32 : profile === "standard" ? 128 : 512,
      materialBudget: profile === "lite" ? 8 : profile === "standard" ? 24 : 64,
    },
    validationGraph: { requiredGates: [], thresholds: {} },
  };
}
