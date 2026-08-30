import { createCharacterForArchetype } from "../factory.js";
export { createCharacterForArchetype } from "../factory.js";
export const createStylizedCharacterIR = (options: Parameters<typeof createCharacterForArchetype>[1] = {}) => createCharacterForArchetype("stylized-humanoid", options);
