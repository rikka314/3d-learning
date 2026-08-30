import type { CharacterArchetype } from "../ir/character-ir.js";

export interface ArchetypeDescriptor {
  id: string;
  label: string;
  archetype: CharacterArchetype;
  supports: string[];
}

export class ArchetypeRegistry {
  private readonly descriptors = new Map<string, ArchetypeDescriptor>();

  register(descriptor: ArchetypeDescriptor): this {
    this.descriptors.set(descriptor.id, descriptor);
    return this;
  }

  get(id: string): ArchetypeDescriptor | undefined {
    return this.descriptors.get(id);
  }

  list(): ArchetypeDescriptor[] {
    return [...this.descriptors.values()];
  }

  resolve(id: string, traits: string[] = []): CharacterArchetype {
    const descriptor = this.descriptors.get(id);
    if (!descriptor) throw new Error(`unknown character archetype: ${id}`);
    return { ...descriptor.archetype, traits: [...new Set([...descriptor.archetype.traits, ...traits])] };
  }
}

export function createDefaultArchetypes(): ArchetypeRegistry {
  return new ArchetypeRegistry()
    .register({ id: "humanoid-anatomical", label: "Humanoid anatomical", archetype: humanoid("humanoid-anatomical"), supports: ["face", "hair", "wearables"] })
    .register({ id: "stylized-humanoid", label: "Stylized humanoid", archetype: humanoid("stylized-humanoid", ["stylized"]), supports: ["face", "hair", "wearables"] })
    .register({ id: "anime", label: "Anime", archetype: humanoid("anime", ["stylized", "anime"]), supports: ["face", "hair", "wearables"] })
    .register({ id: "chibi", label: "Chibi", archetype: humanoid("chibi", ["stylized", "chibi"]), supports: ["face", "hair", "wearables"] })
    .register({ id: "quadruped", label: "Quadruped", archetype: { baseFamily: "quadruped", traits: [], appendages: [{ id: "legs", semanticRole: "leg", count: 4, bilateral: true, rigidity: "soft" }], symmetryPrior: "bilateral", rigidityProfile: "soft" }, supports: ["four-legged-rig", "tail"] })
    .register({ id: "winged", label: "Winged creature", archetype: { baseFamily: "winged", traits: ["winged"], appendages: [{ id: "wings", semanticRole: "wing", count: 2, bilateral: true, rigidity: "mixed" }], symmetryPrior: "bilateral", rigidityProfile: "mixed" }, supports: ["wings", "feathers"] })
    .register({ id: "reptilian", label: "Reptilian", archetype: { baseFamily: "reptilian", traits: ["scales"], appendages: [{ id: "tail", semanticRole: "tail", count: 1, rigidity: "soft" }], symmetryPrior: "bilateral", rigidityProfile: "mixed" }, supports: ["scales", "tail"] })
    .register({ id: "serpentine", label: "Serpentine", archetype: { baseFamily: "serpentine", traits: ["limbless"], appendages: [{ id: "body", semanticRole: "serpentine-body", count: 1, rigidity: "soft" }], symmetryPrior: "bilateral", rigidityProfile: "soft" }, supports: ["curve-body", "tube"] })
    .register({ id: "multi-limb", label: "Multi-limb", archetype: humanoid("multi-limb", ["multi-limb"], 4), supports: ["face", "hair", "wearables", "arbitrary-limbs"] })
    .register({ id: "mechanical", label: "Mechanical character", archetype: { baseFamily: "mechanical", traits: ["rigid-surface", "mechanical-joints"], appendages: [{ id: "arms", semanticRole: "arm", count: 2, bilateral: true, rigidity: "rigid" }, { id: "legs", semanticRole: "leg", count: 2, bilateral: true, rigidity: "rigid" }], rigidityProfile: "rigid" }, supports: ["rigid-surface", "mechanical-joints"] });
}

function humanoid(baseFamily: string, traits: string[] = [], armCount = 2): CharacterArchetype {
  return {
    baseFamily,
    traits,
    appendages: [
      { id: "arms", semanticRole: "arm", count: armCount, bilateral: armCount === 2, articulation: "shoulder-elbow-wrist", rigidity: "soft" },
      { id: "legs", semanticRole: "leg", count: 2, bilateral: true, articulation: "hip-knee-ankle", rigidity: "soft" },
    ],
    anatomicalPrior: "humanoid-proportion-table",
    symmetryPrior: "bilateral-sagittal",
    rigidityProfile: "soft-organic",
  };
}

export { createHumanoidCharacterIR, type HumanoidCharacterOptions } from "./humanoid/index.js";
export { createCharacterForArchetype, type ArchetypeCharacterOptions } from "./factory.js";
