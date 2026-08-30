import { addSemanticNode, addSemanticRelation } from "../ir/semantic-graph.js";
import type { CharacterIR, CharacterArchetype, AppendageSpec, Vec3 } from "../ir/character-ir.js";
import { createHumanoidCharacterIR, type HumanoidCharacterOptions } from "./humanoid/index.js";
import { createDefaultArchetypes } from "./index.js";

export interface ArchetypeCharacterOptions extends Omit<HumanoidCharacterOptions, "archetype"> {
  archetype?: CharacterArchetype;
  traits?: string[];
}

/** Resolve a registered archetype into a compilable CharacterIR template. */
export function createCharacterForArchetype(id: string, options: ArchetypeCharacterOptions = {}): CharacterIR {
  const descriptor = createDefaultArchetypes().get(id);
  if (!descriptor && !options.archetype) throw new Error(`unknown character archetype: ${id}`);
  const archetype = options.archetype ?? descriptor!.archetype;
  const ir = createHumanoidCharacterIR({
    ...options,
    archetype,
    addTail: options.addTail ?? ["quadruped", "reptilian", "serpentine"].includes(id),
    addWings: options.addWings ?? id === "winged",
  });
  ir.meta.assumptions.push(`archetype template: ${id}`);
  if (options.traits?.length) ir.archetype.traits = [...new Set([...ir.archetype.traits, ...options.traits])];
  if (id === "mechanical") applyMechanicalAppearance(ir);
  if (id === "reptilian") applyReptilianAppearance(ir);
  if (id === "multi-limb") addExtraArmAppendages(ir);
  if (id === "quadruped") addQuadrupedAppendages(ir);
  if (id === "serpentine") addSerpentineAppendage(ir);
  return ir;
}

function applyMechanicalAppearance(ir: CharacterIR): void {
  const skin = ir.appearanceGraph.materials.find((material) => material.id === "skin");
  if (skin) { skin.semanticType = "armor"; skin.baseColor = [0.22, 0.27, 0.34]; skin.roughness = 0.32; skin.metalness = 0.72; skin.clearcoat = 0.42; }
  ir.meta.assumptions.push("mechanical template uses rigid material and organic blockout geometry until mechanical evidence replaces the shape graph");
}

function applyReptilianAppearance(ir: CharacterIR): void {
  ir.appearanceGraph.materials.push({ id: "scales", semanticType: "scales", baseColor: [0.18, 0.33, 0.12], roughness: 0.66, metalness: 0, clearcoat: 0.18, anisotropy: 0.1 });
  ir.meta.assumptions.push("reptilian template enables scale material semantics and tail appendage");
}

function addExtraArmAppendages(ir: CharacterIR): void {
  const extras: AppendageSpec[] = [
    { id: "extra-left-arm", rootRegion: "thorax", semanticRole: "arm", geometryMode: "tube", materialId: "skin", path: { id: "extra-left-arm-axis", role: "arm-axis", points: [[0.04, 0.84, 0], [0.14, 0.73, 0.04], [0.22, 0.64, 0.08]] } },
    { id: "extra-right-arm", rootRegion: "thorax", semanticRole: "arm", geometryMode: "tube", materialId: "skin", path: { id: "extra-right-arm-axis", role: "arm-axis", points: [[-0.04, 0.84, 0], [-0.14, 0.73, 0.04], [-0.22, 0.64, 0.08]] } },
  ];
  ir.appendageGraph = { items: [...(ir.appendageGraph?.items ?? []), ...extras] };
  for (const extra of extras) {
    addSemanticNode(ir.semanticGraph, { id: extra.id, kind: "appendage" });
    addSemanticRelation(ir.semanticGraph, "character", extra.id, "parent");
    addSemanticRelation(ir.semanticGraph, extra.id, "thorax", "deforms-with");
  }
}

function addQuadrupedAppendages(ir: CharacterIR): void {
  const legs: AppendageSpec[] = [
    { id: "front-left-leg", rootRegion: "thorax", semanticRole: "leg", geometryMode: "tube", materialId: "skin", path: { id: "front-left-leg-axis", role: "leg-axis", points: [[0.1, 0.72, 0], [0.14, 0.42, 0.04], [0.14, 0.12, 0.12]] } },
    { id: "front-right-leg", rootRegion: "thorax", semanticRole: "leg", geometryMode: "tube", materialId: "skin", path: { id: "front-right-leg-axis", role: "leg-axis", points: [[-0.1, 0.72, 0], [-0.14, 0.42, 0.04], [-0.14, 0.12, 0.12]] } },
  ];
  ir.appendageGraph = { items: [...(ir.appendageGraph?.items ?? []), ...legs] };
  ir.meta.assumptions.push("quadruped template adds front-leg appendage geometry; a dedicated quadruped rig remains an archetype extension point");
}

function addSerpentineAppendage(ir: CharacterIR): void {
  const points: Vec3[] = [[0, 0.58, 0], [0.12, 0.45, -0.05], [-0.08, 0.28, -0.16], [0.04, 0.12, -0.3]];
  const item: AppendageSpec = { id: "serpentine-body", rootRegion: "pelvis", semanticRole: "serpentine-body", geometryMode: "tube", materialId: "skin", path: { id: "serpentine-body-axis", role: "serpentine-axis", points } };
  ir.appendageGraph = { items: [...(ir.appendageGraph?.items ?? []), item] };
}
