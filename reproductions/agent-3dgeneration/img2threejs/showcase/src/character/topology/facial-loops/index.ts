import type { FacialLoop } from "../../ir/character-ir.js";

export function defaultFacialLoops(): FacialLoop[] {
  return ["orbital-left", "orbital-right", "mouth", "nasolabial", "brow-left", "brow-right"].map((role) => ({ id: role, role, vertexIds: [] }));
}
