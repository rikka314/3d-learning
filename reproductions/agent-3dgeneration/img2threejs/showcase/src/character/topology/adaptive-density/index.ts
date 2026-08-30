import type { DensityField } from "../../ir/character-ir.js";

const RANK: Record<DensityField["density"], number> = { low: 1, medium: 2, high: 3, "very-high": 4 };

export function densityForRegion(fields: DensityField[], region: string): number {
  const field = fields.find((candidate) => candidate.region === region);
  return field ? RANK[field.density] * Math.max(0.1, field.weight) : 2;
}

export function segmentCount(fields: DensityField[], region: string, base = 8): number {
  return Math.max(3, Math.round(base * densityForRegion(fields, region)));
}

export function defaultDensityFields(): DensityField[] {
  return [
    { region: "face", density: "very-high", weight: 1 }, { region: "eyelids", density: "very-high", weight: 1 },
    { region: "shoulder", density: "high", weight: 1 }, { region: "elbow", density: "high", weight: 1 }, { region: "wrist", density: "high", weight: 1 },
    { region: "finger", density: "high", weight: 1 }, { region: "torso", density: "medium", weight: 1 }, { region: "back", density: "low", weight: 0.8 },
  ];
}
