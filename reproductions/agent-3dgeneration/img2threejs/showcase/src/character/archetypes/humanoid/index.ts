import { addSemanticNode, addSemanticRelation } from "../../ir/semantic-graph.js";
import type { CharacterArchetype, CharacterCrossSection, CharacterIR, FiberDefinition, MaterialDefinition, Quat, RigGraph, Vec2, Vec3 } from "../../ir/character-ir.js";
import { createCharacterIR } from "../../ir/character-ir.js";
import { defaultDensityFields } from "../../topology/adaptive-density/index.js";
import { defaultFacialLoops } from "../../topology/facial-loops/index.js";
import { humanoidJointZones } from "../../topology/joint-loops/index.js";
import { continuityPairs } from "../../topology/continuity/index.js";

export interface HumanoidCharacterOptions {
  name?: string;
  profile?: CharacterIR["meta"]["fidelityProfile"];
  archetype?: CharacterArchetype;
  addTail?: boolean;
  addWings?: boolean;
  addShirt?: boolean;
}

const Q: [number, number, number, number] = [0, 0, 0, 1];

export function createHumanoidCharacterIR(options: HumanoidCharacterOptions = {}): CharacterIR {
  const archetype = options.archetype ?? {
    baseFamily: "stylized-humanoid",
    traits: ["animation-ready"],
    appendages: [
      { id: "arms", semanticRole: "arm", count: 2, bilateral: true, articulation: "shoulder-elbow-wrist", rigidity: "soft" },
      { id: "legs", semanticRole: "leg", count: 2, bilateral: true, articulation: "hip-knee-ankle", rigidity: "soft" },
    ],
    anatomicalPrior: "humanoid-proportion-table",
    symmetryPrior: "bilateral-sagittal",
    rigidityProfile: "soft-organic",
  } satisfies CharacterArchetype;
  const ir = createCharacterIR(options.name ?? "Procedural Character", archetype, options.profile ?? "standard");
  const p = ir.proportionModel;
  p.stature = 1;
  p.headScale = 0.135;
  p.shoulderBreadth = 0.26;
  p.thoraxWidth = 0.205;
  p.thoraxDepth = 0.14;
  p.waistWidth = 0.14;
  p.pelvisWidth = 0.19;
  p.upperArmLength = 0.18;
  p.forearmLength = 0.17;
  p.handLength = 0.1;
  p.thighLength = 0.25;
  p.lowerLegLength = 0.24;
  p.footLength = 0.14;

  const anatomy = [
    ["character", "character"], ["skull", "anatomy"], ["face", "face"], ["eyes", "eyes"], ["scalp", "emitter"],
    ["neck", "anatomy"], ["thorax", "anatomy"], ["abdomen", "anatomy"], ["pelvis", "anatomy"],
    ["left-arm", "appendage"], ["right-arm", "appendage"], ["left-hand", "appendage"], ["right-hand", "appendage"], ["left-leg", "appendage"], ["right-leg", "appendage"], ["left-foot", "appendage"], ["right-foot", "appendage"],
    ["hair", "fiber"], ["shirt", "wearable"], ["shorts", "wearable"],
  ] as const;
  for (const [id, kind] of anatomy) addSemanticNode(ir.semanticGraph, { id, kind });
  const parentRelations: Array<[string, string]> = [["character", "skull"], ["character", "neck"], ["character", "thorax"], ["character", "abdomen"], ["character", "pelvis"], ["character", "left-arm"], ["character", "right-arm"], ["character", "left-leg"], ["character", "right-leg"], ["left-arm", "left-hand"], ["right-arm", "right-hand"], ["left-leg", "left-foot"], ["right-leg", "right-foot"], ["skull", "face"], ["skull", "eyes"], ["skull", "scalp"]];
  for (const [from, to] of parentRelations) addSemanticRelation(ir.semanticGraph, from, to, "parent");
  addSemanticRelation(ir.semanticGraph, "hair", "scalp", "grows-from");
  addSemanticRelation(ir.semanticGraph, "neck", "thorax", "continuous-with");
  addSemanticRelation(ir.semanticGraph, "thorax", "abdomen", "continuous-with");
  addSemanticRelation(ir.semanticGraph, "abdomen", "pelvis", "continuous-with");
  addSemanticRelation(ir.semanticGraph, "left-arm", "right-arm", "mirrors", 0.9);
  addSemanticRelation(ir.semanticGraph, "left-leg", "right-leg", "mirrors", 0.9);
  addSemanticRelation(ir.semanticGraph, "left-arm", "thorax", "deforms-with");
  addSemanticRelation(ir.semanticGraph, "right-arm", "thorax", "deforms-with");
  addSemanticRelation(ir.semanticGraph, "left-leg", "pelvis", "deforms-with");
  addSemanticRelation(ir.semanticGraph, "right-leg", "pelvis", "deforms-with");
  addSemanticRelation(ir.semanticGraph, "shirt", "thorax", "covers");
  addSemanticRelation(ir.semanticGraph, "shorts", "pelvis", "covers");

  ir.shapeGraph.lofts.push(
    loft("torso", "thorax", [
      section(0.0, [0, 0.76, 0], 0.095, 0.065), section(0.32, [0, 0.82, 0], 0.12, 0.075), section(0.62, [0, 0.89, 0], 0.105, 0.07), section(1, [0, 0.95, 0], 0.085, 0.06),
    ], "skin"),
    loft("neck", "neck", [section(0, [0, 0.94, 0], 0.052, 0.047), section(1, [0, 1.01, 0], 0.045, 0.043)], "skin"),
    loft("left-upper-arm", "left-arm", armSections(1), "skin"),
    loft("right-upper-arm", "right-arm", armSections(-1), "skin"),
    loft("left-leg", "left-leg", legSections(1), "skin"),
    loft("right-leg", "right-leg", legSections(-1), "skin"),
    loft("left-hand", "left-hand", handSections(1), "skin"),
    loft("right-hand", "right-hand", handSections(-1), "skin"),
    loft("left-foot", "left-foot", footSections(1), "skin"),
    loft("right-foot", "right-foot", footSections(-1), "skin"),
    loft("head", "skull", [section(0, [0, 1.01, 0], 0.08, 0.07), section(0.5, [0, 1.08, 0], 0.088, 0.077), section(1, [0, 1.16, 0.005], 0.075, 0.068)], "skin"),
  );
  ir.shapeGraph.lofts[0].continuityConstraints.push(...continuityPairs(["neck", "thorax", "abdomen", "pelvis"]));
  ir.shapeGraph.lofts.find((candidate) => candidate.id === "left-upper-arm")?.continuityConstraints.push({ regionA: "left-arm", regionB: "left-hand", positionalContinuity: true, tangentContinuity: true, topologyBridge: "shared-boundary", deformationBridge: "shared-weight-zone" });
  ir.shapeGraph.lofts.find((candidate) => candidate.id === "right-upper-arm")?.continuityConstraints.push({ regionA: "right-arm", regionB: "right-hand", positionalContinuity: true, tangentContinuity: true, topologyBridge: "shared-boundary", deformationBridge: "shared-weight-zone" });
  ir.shapeGraph.lofts.find((candidate) => candidate.id === "left-leg")?.continuityConstraints.push({ regionA: "left-leg", regionB: "left-foot", positionalContinuity: true, tangentContinuity: true, topologyBridge: "shared-boundary", deformationBridge: "shared-weight-zone" });
  ir.shapeGraph.lofts.find((candidate) => candidate.id === "right-leg")?.continuityConstraints.push({ regionA: "right-leg", regionB: "right-foot", positionalContinuity: true, tangentContinuity: true, topologyBridge: "shared-boundary", deformationBridge: "shared-weight-zone" });
  ir.topologyGraph.jointZones.push(...humanoidJointZones());
  ir.topologyGraph.densityFields.push(...defaultDensityFields());
  ir.topologyGraph.facialLoops.push(...defaultFacialLoops());
  if (options.addTail) ir.appendageGraph = { items: [{ id: "tail", rootRegion: "pelvis", semanticRole: "tail", geometryMode: "tube", materialId: "skin", path: { id: "tail-axis", role: "tail-axis", points: [[0, 0.45, -0.04], [0, 0.32, -0.14], [0.03, 0.2, -0.23], [0.07, 0.12, -0.29]] } }] };
  if (options.addWings) ir.appendageGraph = { items: [...(ir.appendageGraph?.items ?? []), { id: "left-wing", rootRegion: "thorax", semanticRole: "wing", geometryMode: "loft", materialId: "cloth", path: { id: "left-wing-axis", role: "wing-axis", points: [[0.1, 0.88, -0.01], [0.32, 1.04, -0.02], [0.52, 0.82, -0.08]] } }, { id: "right-wing", rootRegion: "thorax", semanticRole: "wing", geometryMode: "loft", materialId: "cloth", path: { id: "right-wing-axis", role: "wing-axis", points: [[-0.1, 0.88, -0.01], [-0.32, 1.04, -0.02], [-0.52, 0.82, -0.08]] } }] };

  const rig = humanoidRig();
  ir.rigGraph = rig;
  ir.deformationGraph = { skinning: { strategy: "semantic-region", maxInfluences: 4, normalize: true }, jointCorrectives: [
    { id: "elbow-bend", region: "arm", driver: "left-elbow.angle", threshold: 0.35, maxWeight: 1 },
    { id: "knee-bend", region: "leg", driver: "left-knee.angle", threshold: 0.35, maxWeight: 1 },
    { id: "shoulder-raise", region: "shoulder", driver: "left-shoulder.angle", threshold: 0.35, maxWeight: 1 },
  ], twistDistribution: [{ id: "left-forearm-twist", sourceJoint: "left-forearm", targetJoints: ["left-wrist"], distribution: [1] }], volumePreservation: [{ region: "upper-arm", joint: "left-elbow", preserve: 0.9 }, { region: "thigh", joint: "left-knee", preserve: 0.92 }], muscleDrivers: [], morphDrivers: [], surfaceFollowers: [] };
  ir.morphGraph = { relative: true, definitions: [
    { id: "blink-left", region: "left-eye", type: "expression" }, { id: "blink-right", region: "right-eye", type: "expression" }, { id: "smile", region: "mouth", type: "expression" }, { id: "jaw-open", region: "jaw", type: "expression" }, { id: "elbow-corrective", region: "elbow", type: "corrective", driver: "elbow.angle" }, { id: "knee-corrective", region: "knee", type: "corrective", driver: "knee.angle" },
  ] };
  ir.appearanceGraph.materials.push(...defaultMaterials());
  ir.surfaceGraph.features.push({ id: "left-pectoral-mark", region: "left-pectoral", representation: "material-mask", coordinate: { region: "left-pectoral", u: 0.38, v: 0.62, normalOffset: 0.002 }, intensity: 0.2, materialId: "skin" });
  ir.fiberGraph = { definitions: [defaultHair()] };
  if (options.addShirt !== false) ir.wearableGraph = { items: [{ id: "shirt", kind: "shirt", covers: ["thorax", "abdomen"], attachmentMode: "skins-with", offset: 0.008, materialId: "cloth", seamIds: ["shirt-collar", "shirt-sleeve"], foldStrength: 0.35 }, { id: "shorts", kind: "shorts", covers: ["pelvis"], attachmentMode: "skins-with", offset: 0.01, materialId: "cloth", seamIds: ["waistband"], foldStrength: 0.25 }] };
  ir.runtimeGraph.stableJointNames = rig.joints.map((joint) => joint.id);
  ir.runtimeGraph.stableMorphNames = ir.morphGraph.definitions.map((morph) => morph.id);
  ir.validationGraph.requiredGates = ["GEO-DEGENERATE", "GEO-CONTINUITY", "SURF-UV-VALID", "SURF-NORMAL-VALID", "RIG-HIERARCHY", "RIG-WEIGHT-SUM", "DEF-ELBOW-90", "HAIR-ROOT-ATTACHMENT", "CLOTH-CLEARANCE", "RUNTIME-API"];
  ir.validationGraph.thresholds = { maxDegenerateVertices: 0, maxWeightError: 0.001, minHairRootClearance: 0, maxWearablePenetration: 0.002 };
  if (options.profile === "hero") ir.meta.assumptions.push("Hero appearance backends remain capability-gated; SSS/TSL are optional at runtime.");
  return ir;
}

function section(t: number, center: Vec3, width: number, depth: number, orientation: Quat = Q): CharacterCrossSection {
  const contour: Vec2[] = [];
  const count = 12;
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    contour.push([Math.cos(angle), Math.sin(angle)]);
  }
  return { t, center, orientation, contour, width, depth, landmarks: [], anatomicalInfluences: [], deformationZone: undefined };
}

function loft(id: string, region: string, sections: CharacterCrossSection[], materialId: string) {
  return { id, region, axis: { id: `${id}-axis`, role: "anatomical-axis", points: sections.map((item) => item.center) }, sections, continuityConstraints: [], topologyIntent: "deformable-organic" as const, materialId };
}

function armSections(side: 1 | -1): CharacterCrossSection[] {
  const x = side * 0.155;
  return [section(0, [x, 0.91, 0], 0.058, 0.05), section(0.3, [side * 0.19, 0.86, 0], 0.05, 0.045), section(0.62, [side * 0.205, 0.78, 0], 0.044, 0.041), section(0.78, [side * 0.21, 0.73, 0], 0.041, 0.038), section(1, [side * 0.215, 0.66, 0], 0.034, 0.032)];
}

function legSections(side: 1 | -1): CharacterCrossSection[] {
  return [section(0, [side * 0.085, 0.62, 0], 0.075, 0.06), section(0.32, [side * 0.088, 0.47, 0], 0.067, 0.055), section(0.5, [side * 0.086, 0.37, 0], 0.05, 0.046), section(0.67, [side * 0.085, 0.28, 0], 0.047, 0.043), section(0.85, [side * 0.085, 0.17, 0], 0.038, 0.036), section(1, [side * 0.085, 0.06, 0.015], 0.043, 0.07)];
}

function handSections(side: 1 | -1): CharacterCrossSection[] {
  const orientation: Quat = side === 1 ? [0, 0, -Math.SQRT1_2, Math.SQRT1_2] : [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  return [section(0, [side * 0.215, 0.66, 0], 0.034, 0.032, orientation), section(1, [side * 0.26, 0.65, 0], 0.028, 0.026, orientation)];
}

function footSections(side: 1 | -1): CharacterCrossSection[] {
  const orientation: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  return [section(0, [side * 0.085, 0.06, 0.015], 0.043, 0.05, orientation), section(1, [side * 0.085, 0.06, 0.14], 0.047, 0.052, orientation)];
}

function humanoidRig(): RigGraph {
  const joint = (id: string, parentId: string | undefined, role: string, restPosition: Vec3): [string, string | undefined, string, Vec3] => [id, parentId, role, restPosition];
  const values = [
    joint("root", undefined, "root", [0, 0, 0]), joint("spine", "root", "spine", [0, 0.45, 0]), joint("chest", "spine", "thorax", [0, 0.76, 0]), joint("neck", "chest", "neck", [0, 0.95, 0]), joint("head", "neck", "head", [0, 1.06, 0]),
    joint("left-shoulder", "chest", "shoulder", [0.11, 0.9, 0]), joint("left-elbow", "left-shoulder", "elbow", [0.19, 0.8, 0]), joint("left-forearm", "left-elbow", "forearm", [0.205, 0.73, 0]), joint("left-wrist", "left-forearm", "wrist", [0.215, 0.66, 0]), joint("left-hand", "left-wrist", "hand", [0.24, 0.655, 0]), joint("left-finger", "left-hand", "finger", [0.265, 0.65, 0]),
    joint("right-shoulder", "chest", "shoulder", [-0.11, 0.9, 0]), joint("right-elbow", "right-shoulder", "elbow", [-0.19, 0.8, 0]), joint("right-forearm", "right-elbow", "forearm", [-0.205, 0.73, 0]), joint("right-wrist", "right-forearm", "wrist", [-0.215, 0.66, 0]), joint("right-hand", "right-wrist", "hand", [-0.24, 0.655, 0]), joint("right-finger", "right-hand", "finger", [-0.265, 0.65, 0]),
    joint("left-hip", "root", "hip", [0.085, 0.61, 0]), joint("left-knee", "left-hip", "knee", [0.085, 0.36, 0]), joint("left-ankle", "left-knee", "ankle", [0.085, 0.12, 0]), joint("left-foot", "left-ankle", "foot", [0.085, 0.06, 0.015]), joint("left-toe", "left-foot", "toe", [0.085, 0.06, 0.12]),
    joint("right-hip", "root", "hip", [-0.085, 0.61, 0]), joint("right-knee", "right-hip", "knee", [-0.085, 0.36, 0]), joint("right-ankle", "right-knee", "ankle", [-0.085, 0.12, 0]), joint("right-foot", "right-ankle", "foot", [-0.085, 0.06, 0.015]), joint("right-toe", "right-foot", "toe", [-0.085, 0.06, 0.12]),
  ];
  return {
    joints: values.map(([id, parentId, role, restPosition]) => ({ id, parentId, role, restPosition, restRotation: Q, axis: [0, 1, 0] as Vec3 })),
    chains: [{ id: "left-arm", joints: ["left-shoulder", "left-elbow", "left-forearm", "left-wrist", "left-hand", "left-finger"], role: "arm" }, { id: "right-arm", joints: ["right-shoulder", "right-elbow", "right-forearm", "right-wrist", "right-hand", "right-finger"], role: "arm" }, { id: "left-leg", joints: ["left-hip", "left-knee", "left-ankle", "left-foot", "left-toe"], role: "leg" }, { id: "right-leg", joints: ["right-hip", "right-knee", "right-ankle", "right-foot", "right-toe"], role: "leg" }],
    constraints: [{ joint: "left-elbow", type: "hinge", axis: [1, 0, 0], min: 0, max: Math.PI * 0.9 }, { joint: "right-elbow", type: "hinge", axis: [1, 0, 0], min: 0, max: Math.PI * 0.9 }, { joint: "left-knee", type: "hinge", axis: [1, 0, 0], min: 0, max: Math.PI * 0.9 }, { joint: "right-knee", type: "hinge", axis: [1, 0, 0], min: 0, max: Math.PI * 0.9 }],
    effectors: [{ id: "left-hand", joint: "left-hand" }, { id: "right-hand", joint: "right-hand" }, { id: "left-foot", joint: "left-foot" }, { id: "right-foot", joint: "right-foot" }],
    twistSystems: [], drivers: [], ikChains: [{ id: "left-arm-ik", joints: ["left-shoulder", "left-elbow", "left-forearm", "left-wrist", "left-hand"], effector: "left-hand", target: "left-hand-target", solverHint: "ccd" }, { id: "right-arm-ik", joints: ["right-shoulder", "right-elbow", "right-forearm", "right-wrist", "right-hand"], effector: "right-hand", target: "right-hand-target", solverHint: "ccd" }],
  };
}

function defaultMaterials(): MaterialDefinition[] {
  return [
    { id: "skin", semanticType: "skin", baseColor: [0.64, 0.34, 0.22], roughness: 0.58, metalness: 0, backend: "physical", skin: { baseColor: [0.64, 0.34, 0.22], roughness: 0.58, thickness: 0.5 } },
    { id: "eye-sclera", semanticType: "eye", baseColor: [0.92, 0.95, 1], roughness: 0.2, metalness: 0, transmission: 0.05, clearcoat: 0.3 },
    { id: "eye-iris", semanticType: "eye", baseColor: [0.08, 0.24, 0.18], roughness: 0.18, metalness: 0, clearcoat: 0.45 },
    { id: "hair", semanticType: "hair", baseColor: [0.035, 0.018, 0.012], roughness: 0.38, metalness: 0, anisotropy: 0.65 },
    { id: "cloth", semanticType: "cloth", baseColor: [0.06, 0.11, 0.2], roughness: 0.82, metalness: 0, sheen: 0.2 },
  ];
}

function defaultHair(): FiberDefinition {
  const points: Vec3[] = [[-0.055, 1.14, 0.005], [-0.035, 1.17, 0.03], [0, 1.18, 0.045], [0.035, 1.17, 0.03], [0.055, 1.14, 0.005], [0, 1.16, -0.03]];
  const roots = points.map((point, index) => ({ id: `hair-root-${index}`, emitter: "scalp", coordinate: { region: "scalp", u: 0.5 + point[0] * 2.5, v: 0.45 + (point[1] - 1.14) * 2, normalOffset: 0.006 }, normalOffset: 0.006 }));
  const guides = points.map((point, index) => ({ id: `hair-guide-${index}`, rootId: `hair-root-${index}`, points: [point, [point[0] * 1.15, point[1] + 0.035, point[2] + 0.01] as Vec3, [point[0] * 1.3, point[1] - 0.005, point[2] + (point[2] >= 0 ? 0.06 : -0.06)] as Vec3], taper: 0.4 }));
  return { id: "hair", kind: "hair" as const, materialId: "hair", representation: "tube" as const, lod: [1, 0.4], flow: { emitter: "scalp", roots, directionalField: { id: "crown-flow", type: "linear", parameters: { lateralAttraction: -0.2, upward: 0.2, frontFlow: 0.25, rearFlow: -0.25 } }, guides, clumps: [{ id: "hair-clump-0", guideIds: guides.map((guide) => guide.id), spread: 0.02, strandCount: 8 }], modifiers: { gravity: 0.15, attraction: 0.25, spread: 0.3 } } };
}
