/**
 * Measured tables taken off the reference GLB.
 *
 * Measurements OF the reference rather than any part of it -- no buffer, no
 * image and no topology is carried across, and nothing here is loaded at runtime:
 *
 *  TRIANGLE_BUDGET  the reference's own per-mesh triangle counts, so the procedural rebuild can
 *               match its distribution and not just its total.
 *
 * The per-part silhouette-radius and limb-centreline tables that used to live here are GONE. They
 * were the single-axis representation, and it could not express a band holding two clusters: it
 * fused the legs, turned the split skirt into a cone, and smeared each arm into a cylinder of its
 * widest reach. `crossSections.ts` replaced them, and keeping both would have shipped 900 lines of
 * superseded data in the bundle.
 *
 * Source: base_basic_pbr.glb, sha256 29f9ee0a9bd7f46470a47bcbc67b2570...
 * 31 meshes, 1,599,896 triangles, 1,201,918 vertices, no skin and no animation.
 * Regenerate with scripts/extract-measured-rings.py rather than hand-editing.
 */

/** Character faces +Z: blades reach z=+0.79, scabbards sit at z=-0.29, and the skull carries more
 *  mass behind (zmin -0.123) than in front (zmax +0.086). So the character's own left is +X. */
export const CHARACTER_LEFT_SIGN = 1;

/** The reference's own per-mesh triangle counts, keyed by the semantic name this rebuild uses. */
export const TRIANGLE_BUDGET: Record<string, { node: number; triangles: number; vertices: number }> = {
  'skirt': { node: 0, triangles: 208342, vertices: 146740 },
  'skin-torso': { node: 1, triangles: 130398, vertices: 100530 },
  'corset-trim': { node: 2, triangles: 11458, vertices: 10659 },
  'corset': { node: 3, triangles: 169138, vertices: 142672 },
  'hip-yoke': { node: 4, triangles: 160640, vertices: 93899 },
  'thigh-l': { node: 5, triangles: 49112, vertices: 34543 },
  'thigh-r': { node: 6, triangles: 49164, vertices: 34747 },
  'belt-tail': { node: 7, triangles: 21052, vertices: 17298 },
  'corset-lacing': { node: 8, triangles: 7780, vertices: 6938 },
  'hw-upper': { node: 9, triangles: 16626, vertices: 14275 },
  'hw-lower': { node: 10, triangles: 21606, vertices: 15327 },
  'tights': { node: 11, triangles: 125780, vertices: 89552 },
  'glove-r': { node: 12, triangles: 54086, vertices: 37085 },
  'boot-l': { node: 13, triangles: 57394, vertices: 42426 },
  'glove-l': { node: 14, triangles: 54076, vertices: 36923 },
  'boot-r': { node: 15, triangles: 57500, vertices: 42202 },
  'pouch-r': { node: 16, triangles: 23730, vertices: 19220 },
  'pouch-l': { node: 17, triangles: 27738, vertices: 20809 },
  // Node 18 is the RIGHT cap and node 19 the left -- see the note in createGirlCharacter3Model's PARTS.
  // The budget follows the node, so these swap with the names.
  'skin-shoulder-r': { node: 18, triangles: 12664, vertices: 8267 },
  'skin-shoulder-l': { node: 19, triangles: 12668, vertices: 8269 },
  'head': { node: 20, triangles: 75294, vertices: 60661 },
  'strap-tail-r': { node: 21, triangles: 6422, vertices: 6648 },
  'strap-tail-l': { node: 22, triangles: 6420, vertices: 6582 },
  'scabbard-a': { node: 23, triangles: 32826, vertices: 26826 },
  'scabbard-b': { node: 24, triangles: 29960, vertices: 23013 },
  'sword-l': { node: 25, triangles: 46554, vertices: 41677 },
  'hair': { node: 26, triangles: 40050, vertices: 29716 },
  'sword-r': { node: 27, triangles: 41058, vertices: 35152 },
  'flare-l': { node: 28, triangles: 17344, vertices: 15770 },
  'thigh-wrap': { node: 29, triangles: 15726, vertices: 17860 },
  'flare-r': { node: 30, triangles: 17290, vertices: 15632 },
};

export const REFERENCE_TOTALS = {
  meshes: 31,
  triangles: 1599896,
  vertices: 1201918,
} as const;
