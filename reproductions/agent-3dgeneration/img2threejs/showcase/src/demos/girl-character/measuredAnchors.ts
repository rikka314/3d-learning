/**
 * Blockout anchors MEASURED from the baseline GLB, not estimated by eye.
 *
 * Every number here came out of `forge/stage1_intake/label_glb_nodes.py`, which reads each node's
 * POSITION accessor min/max and composes the node's world transform. So these are the asset's own
 * world-space bounds, exact to the accessor, with no vertex decoded and nothing guessed.
 *
 * WHY THE REGION NAMES DIFFER FROM THE LABELLER'S OUTPUT. The labeller assigns a height band, which
 * is the honest limit of what bounds alone can say -- it called node 0 `thigh-left` because that is
 * where its centroid sits. Reading the bounds ALONGSIDE the reference images resolves them properly:
 * node 0 is 0.577 wide and spans y 0.52-1.16, which is not a thigh, it is the overalls covering both
 * legs. Those resolutions are recorded per entry as `resolvedFrom`, so the disagreement with the
 * labeller is visible instead of silently overwritten.
 *
 * These remain HYPOTHESES until a browser semantic-ID pass confirms them, exactly as the labeller's
 * report says. What they are good for right now is a measured blockout, which is pass 1.
 */

export type MeasuredAnchor = {
  /** Region id from the render profile, so blockout meshes and review regions share one vocabulary. */
  readonly region: string;
  readonly nodeIndex: number;
  /** World-space AABB from the GLB. */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly resolvedFrom: string;
  /**
   * For a part that lies along an axis rather than filling its box.
   *
   * An AABB is the worst possible fit for a diagonal object: it has to contain the whole diagonal,
   * so it covers the rectangle the diagonal spans instead of the object. The katana measured 8.62x
   * the reference's area for exactly this reason -- not misplaced, just the wrong shape of
   * container. A part with this field is built as a thin mass along `from`->`to` and INSCRIBED in
   * the anchor rather than filling it.
   */
  /**
   * Cross-section of the mass. Omitted means a box, which is what a blockout starts as.
   *
   * A box is the wrong container for a round part in the same way it was the wrong container for a
   * diagonal one: it circumscribes. A circular cross-section covers pi/4 = 78.5% of the square that
   * bounds it, so a genuinely cylindrical part built as a box over-covers by 27% before any
   * positioning error is counted.
   */
  readonly crossSection?: 'box' | 'cylinder' | 'ellipsoid';
  /**
   * Name of a traced front silhouette in `silhouettes.ts`, extruded through the anchor's own z.
   *
   * Takes precedence over `crossSection`: a traced outline is measured, a cross-section is a guess
   * at which primitive the part resembles. Only valid where nothing covers the part.
   */
  readonly silhouette?: 'HAIR' | 'POUCHES' | 'CANISTER' | 'KNEE_PAD_LEFT' | 'KNEE_PAD_RIGHT'
    | 'BOOT_LEFT' | 'BOOT_RIGHT' | 'GLOVE_FIST' | 'GLOVE_HIP' | 'KATANA' | 'OVERALLS'
    | 'SKIN_UPPER' | 'SKIN_SHIN_LEFT' | 'SKIN_SHIN_RIGHT'
    | 'SPORTS_BRA' | 'BELT';
  readonly orientedAxis?: {
    readonly from: readonly [number, number, number];
    readonly to: readonly [number, number, number];
    /** Cross-section side length, in world units. */
    readonly thickness: number;
    readonly measuredFrom: string;
  };
};

/** The baseline's own overall bounds. The figure is 1.75 tall, so the asset is in metres. */
export const FIGURE_BOUNDS = {
  min: [-0.377582, 0.0, -0.169605] as const,
  max: [0.372726, 1.75, 0.170423] as const,
  height: 1.75,
} as const;

/**
 * Sorted bottom-to-top, which is also the order a blockout is easiest to read in.
 *
 * `left`/`right` follow CHARACTER_LEFT_SIGN: with forward +Z and a right-handed frame the
 * character's own left is +X. So a node at x = +0.317 is her LEFT arm, and it appears on the
 * viewer's right in a front view.
 */
export const MEASURED_ANCHORS: readonly MeasuredAnchor[] = [
  {
    region: 'boots', nodeIndex: 11,
    silhouette: 'BOOT_LEFT',
    min: [-0.1755, 0.0, -0.1495], max: [-0.0195, 0.162, 0.1695],
    resolvedFrom: 'z-depth 0.319 is the deepest thing at ground level; a platform boot, character right. '
      + 'Outer edge moved out 0.021 (GLB -0.1545 -> -0.1755): band9 body-only reference is 565 px against '
      + 'the render 516, and band9 is the one band in the table that is too NARROW. Inner edge untouched.',
  },
  {
    region: 'boots', nodeIndex: 13,
    silhouette: 'BOOT_RIGHT',
    min: [0.1635, 0.0, -0.138], max: [0.3255, 0.167, 0.170],
    resolvedFrom: 'mirror of node 11 at x +0.234; character left boot. Outer edge moved out 0.021 to '
      + 'match, so the pair stays a reflection — a one-sided widen would break validate_chirality.',
  },
  // NODES 15 AND 3 WERE NOT OVERALLS. Both sit at y 0.159-0.433, which the profile camera puts at
  // image y 1502-1797. The reference's trouser hem is at image y 1441 and the boots start at 1628,
  // so this span is bare shin and boot -- there is no trouser there at all. Calling them `overalls`
  // inflated that region to 2.17x the reference area, and because `overalls` is a large forward mass
  // it then OCCLUDED the pouch node behind it: `pouches` scored 0.0019 with a correct reference mask
  // purely because its geometry never reached the frame.
  //
  // "lower leg inside the trouser" was the original reading and it was wrong about which is which:
  // the leg is inside the BOOT here, and above the boot it is bare.
  {
    region: 'skin', nodeIndex: 15,
    silhouette: 'SKIN_SHIN_LEFT',
    min: [-0.1325, 0.159, -0.1065], max: [-0.0215, 0.433, -0.0035],
    resolvedFrom: 'narrow (0.111) vertical mass spanning image y 1502-1797, below the trouser hem at '
      + '1441; the bare shin above the boot, character right',
  },
  {
    region: 'skin', nodeIndex: 3,
    silhouette: 'SKIN_SHIN_RIGHT',
    min: [0.125, 0.159, -0.0895], max: [0.239, 0.426, 0.0175],
    resolvedFrom: 'bare shin above the boot, character left; mirror of node 15',
  },
  // BOTH PADS TRIMMED TO THE REFERENCE MASKS. The region was covering 2.33x the reference's pixel
  // area, the largest over-cover left in the model, and node 12 carried most of it: its top sat at
  // y 0.754 against a measured 0.658, about 103 px of height that is not pad in the photograph.
  // Node 10 was over-wide rather than over-tall. The GLB node bounds are the outer hull of a pad
  // that curves away from the camera, so they exceed what the pad actually presents from the front.
  {
    region: 'knee-pads', nodeIndex: 10,
    silhouette: 'KNEE_PAD_LEFT',
    // A knee pad is a flat plate, not a round bar: the cylinder took its area to 0.90x and cost it
    // 0.19. Kept anyway, because shrinking it uncovers the trousers behind and overalls gained 0.51
    // -- the pair is +0.32 net. Recorded so the individual regression is not mistaken for a miss.
    crossSection: 'cylinder',
    min: [-0.180, 0.464, -0.1315], max: [0.021, 0.697, 0.1455],
    resolvedFrom: 'steampunk knee pad, character right. Box from the reference mask bbox '
      + '[254,1218,490,1469] projected through the profile camera; z kept from the GLB node, which '
      + 'a front view cannot measure',
  },
  {
    region: 'knee-pads', nodeIndex: 12,
    silhouette: 'KNEE_PAD_RIGHT',
    crossSection: 'cylinder',
    min: [0.081, 0.422, -0.117], max: [0.281, 0.658, 0.157],
    resolvedFrom: 'knee pad, character left. Box from the reference mask bbox [560,1260,794,1514]; '
      + 'z kept from the GLB node',
  },
  // NODE 0 IS NOW EIGHT MEASURED BANDS, read from its 371083 VERTICES rather than its bounding box.
  //
  // Everything before this used each GLB node's AABB, which is a hull: it reports the widest point at
  // every height. Decoding the POSITION accessor shows the trousers are 0.5769 wide at y 0.68-0.84
  // and only 0.4942 at y 1.00-1.08, and the depth varies 0.2275 to 0.3097 over the same span. A box
  // holds the widest figure everywhere, so it invented volume at every height except one.
  //
  // What that cost, concretely: the hip glove rendered 1260 of its 32760 projected pixels -- 96%
  // buried -- because the box reached x 0.318 and z 0.140 at the glove's height, while the geometry
  // there actually stops at x 0.2711. Narrowing the box uniformly could not fix it without also
  // destroying the correct width lower down.
  //
  // This is the GLB used as a STRUCTURAL baseline, which is its sanctioned role: shape and extent,
  // never pixels, and no topology or material copied.
  {
    region: 'overalls', nodeIndex: 0,
    silhouette: 'OVERALLS',
    min: [-0.2570, 0.5215, -0.1696], max: [0.3199, 1.1595, 0.1401],
    resolvedFrom: 'trousers, character-left leg. Two outlines, not one: the mask separates into two '
      + 'components where the belt and canister hang between the legs. Bounds are node 0\'s full '
      + 'extent, used now only for the extrusion depth',
  },
  // NODES 5 AND 6 WERE SWAPPED, and the per-part render score is what caught it. The first pass
  // called node 5 the canister because it is narrow, tall and forward -- true of the canister, but
  // also true of a hanging pouch, so the shape argument never distinguished them. Scoring the
  // semantic-ID render against the SAM2 reference mask gave `canister` an IoU of exactly 0.0000 at
  // an area ratio of 1.47: right size, no overlap at all, which only happens when a part is in the
  // wrong place rather than the wrong shape. Render x 356-471 sat left of the midline while the
  // reference sits at 515-630, right of it.
  //
  // Projecting the reference bbox back through the profile camera puts the canister at world
  // x +0.043..+0.141, y 0.765..1.003. Node 6 is x +0.059..+0.189, y 0.762..0.957 -- agreeing on
  // BOTH axes. Node 5 is x -0.0985..+0.0065, on the far side of the midline, so it cannot be the
  // canister at any scale. The labels are exchanged accordingly.
  //
  // This is the render confirmation the file header said these labels were still waiting on, and it
  // rejected the hypothesis rather than confirming it. Bounds alone genuinely could not settle this.
  {
    region: 'pouches', nodeIndex: 5,
    silhouette: 'POUCHES',
    min: [-0.2416, 0.8377, 0.0855], max: [-0.1006, 0.9847, 0.1505],
    resolvedFrom: 'belt pouch, character right; a pouch, not the canister — the canister is measured '
      + 'on the opposite side of the midline. Box from the reference mask bbox [187,862,406,1073]; '
      + 'z kept from the GLB node',
  },
  {
    region: 'canister', nodeIndex: 6,
    silhouette: 'CANISTER',
    min: [0.0347, 0.7467, 0.039], max: [0.1647, 0.9417, 0.147],
    resolvedFrom: 'the cage canister. Its bounds match the reference canister on both axes once the '
      + 'reference bbox [515,889,630,1145] is projected back through the profile camera',
  },
  {
    region: 'gloves', nodeIndex: 14,
    silhouette: 'GLOVE_HIP',
    min: [0.2969, 0.7973, -0.099], max: [0.3701, 0.9341, 0.059],
    resolvedFrom: 'outermost mass in x (+0.317, against a half-width of 0.375) hanging at hip height; '
      + 'the gloved left hand',
  },
  {
    region: 'katana', nodeIndex: 8,
    silhouette: 'KATANA',
    min: [-0.3615, 0.810, -0.163], max: [-0.0665, 1.268, 0.169],
    resolvedFrom: 'z-depth 0.332 is the deepest node in the asset and it is diagonal across the '
      + 'character right side; the katana and its sheath',
    // Endpoints come from the reference mask, not the GLB node. Projecting the SAM2 katana bbox
    // [19,519,317,834] back through the profile camera (midline at image x 465, 0.000855 world/px;
    // image y 1000 = world y 0.900 at -0.00093 world/px) gives world x -0.381..-0.127 and
    // y 1.054..1.347. The grip is up and outboard, the sheath runs down and inboard, so the axis is
    // the anti-diagonal of that box.
    //
    // The GLB node reaches down to y 0.810, well below the reference's 1.054, because the node
    // includes sword that the character's own body hides in this view. The reference mask is
    // VISIBLE extent and the semantic-ID render is visible extent too, so the two agree only if the
    // mass is built to the visible span -- building to the node's full span would guarantee an
    // over-cover that no repositioning could fix.
  },
  // NODE 1 IS SPLIT IN TWO, and the split point and widths are MEASURED, not guessed.
  //
  // Per-band foreground width against the reference showed the error was not spread over the figure:
  // mid-body was within ~30 px, while band1 (image y 200-400, i.e. world y ~1.418-1.598) was 786 px
  // against the reference's 390 -- more than double. The merged shell was presenting full shoulder
  // width at head height. At the measured 0.000855 world-units per pixel, 390 px is 0.334 world and
  // 762 px is 0.652 world, so the split is at y 1.42 with those two widths.
  //
  // This is still ONE baseline node, so both halves keep nodeIndex 1 and say so. The GLB cannot tell
  // us where the neck ends; the reference silhouette can, and did.
  {
    region: 'skin', nodeIndex: 1,
    silhouette: 'SKIN_UPPER',
    min: [-0.0825, 1.42, -0.1645], max: [0.0825, 1.5823, 0.0985],
    resolvedFrom: 'upper half of the split node 1: head, neck and shoulder line. Width 0.165, derived '
      + 'from the reference BODY-ONLY band1 width of 193 px at 0.000855 world/px. The first pass used '
      + '390 px and got 0.334, but that 390 came from a bbox the two swords inflate — body-only is 193',
  },
  // WAIST-RIG IS SPLIT INTO BRA AND BELT. One label over both meant the belt had no comparable
  // render mask and stayed unscorable while everything around it was measured. Both keep node 1's
  // bounds, used only for extrusion depth.
  {
    region: 'sports-bra', nodeIndex: 1,
    silhouette: 'SPORTS_BRA',
    min: [-0.326, 0.973, -0.1645], max: [0.326, 1.42, 0.0985],
    resolvedFrom: 'the sports bra, traced from its own reference mask (SAM2 confidence 0.969)',
  },
  {
    region: 'belt', nodeIndex: 1,
    silhouette: 'BELT',
    min: [-0.326, 0.973, -0.1645], max: [0.326, 1.42, 0.1220],
    resolvedFrom: 'the leather belt, traced from its own reference mask (SAM2 confidence 0.759)',
  },
  // THE KATANA-GRIPPING GLOVE HAD NO GEOMETRY AT ALL. `gloves` carried only node 14, the hand
  // hanging at the hip, so 10033 of the reference region's 14038 pixels -- 71% of it -- had nothing
  // to be compared against and the score was capped near zero no matter where node 14 sat.
  //
  // The GLB has no separate node for it: node 8's bounds cover the katana AND the fist holding it,
  // the same merge the node 0 and node 1 splits already had to undo. So this shares nodeIndex 8 and
  // takes its box from the reference, exactly as those splits do.
  {
    region: 'gloves', nodeIndex: 8,
    silhouette: 'GLOVE_FIST',
    min: [-0.3303, 1.1574, -0.020], max: [-0.2083, 1.2704, 0.110],
    resolvedFrom: 'the gloved fist gripping the katana, character right. Box from the reference mask '
      + 'bbox [102,534,245,656] projected through the profile camera. Shares node 8 with the katana '
      + 'because the GLB merges the two; z is bracketed around the katana axis at z 0.14 rather than '
      + 'measured, since a front view cannot see depth',
  },
  {
    region: 'hair', nodeIndex: 9,
    silhouette: 'HAIR',
    min: [-0.0332, 1.5823, -0.158], max: [0.1863, 1.7480, 0.078],
    resolvedFrom: 'topmost node, 0.226 tall; the head with its hair mass. Width narrowed from the GLB '
      + 'node0.260 to 0.188 from the reference BODY-ONLY band0 width of 220 px, keeping the node centre',
  },
] as const;

/** Regions that the anchors above cover. Used to prove the blockout addresses every measured node. */
export function anchoredRegions(): string[] {
  return [...new Set(MEASURED_ANCHORS.map((a) => a.region))].sort();
}

/** Every node index the baseline exposed, so a missing one is detectable rather than invisible. */
export function anchoredNodeIndices(): number[] {
  return MEASURED_ANCHORS.map((a) => a.nodeIndex).sort((a, b) => a - b);
}
