import * as THREE from 'three';
import { SECTIONS, type Ring } from './crossSections';

/**
 * Loft clustered cross-sections into solids.
 *
 * Rings are chained into STRANDS by centroid proximity within a node, never by slice index, because
 * one slice can yield several rings: the skirt's lower bands hold two panels, the tights' hold two
 * legs, the torso's top bands hold two shoulder caps. Chaining by index would join the left leg to
 * the right one across the gap between them.
 *
 * Ends are closed with a fan to the ring's own centroid. The garment materials here are DoubleSide,
 * but the skin is FrontSide, and an open end on it renders as a hole straight through the part.
 */

/** Largest gap between consecutive ring centroids that still counts as the same strand. */
const STRAND_RADIUS = 0.09;

/**
 * Largest perimeter ratio between consecutive rings of one strand.
 *
 * Proximity alone is not enough to say two sections belong to the same tube. At shoulder height the
 * torso node splits into the bodice and its straps, and a strap's centroid can sit within the 90 mm
 * chaining radius of the bodice's — so the chain steps from a 600 mm outline to a 60 mm one and the
 * loft spans the difference with a sheet of enormous triangles. Measured on the torso: triangles 120x
 * the median area, all at y 1.41-1.45, which is exactly where the shards were visible.
 *
 * A real tube's section does not treble between slices 12 mm apart. Comparing the outlines as well as
 * the centroids is what separates "the same tube, one slice further along" from "a different piece
 * that happens to pass nearby".
 */
const STRAND_PERIMETER_RATIO = 3;

/** Shortest strand kept, as a fraction of the node's longest. See strandsForNode. */
const STRAND_MIN_SPAN = 0.08;

/**
 * Largest radius jump between neighbouring spokes that still counts as surface.
 *
 * Where a section stops being star-convex — a deep V-neck, an armhole, the C of a back panel — the
 * ring has no way to follow the surface in and simply spans the opening. The quad that does the
 * spanning is enormous next to its neighbours: measured on the torso, 122x the median triangle area,
 * all at bust and armhole height, and it renders as a flat grey shard hanging in front of the chest.
 *
 * The reference has an OPENING there, so emitting nothing is closer than emitting a bridge. The
 * triangles that would have gone into it are not lost — they are added back as centre splits
 * elsewhere on the same strand, so the part still lands on its exact count.
 *
 * Swept: 1.6 leaves the worst triangle at 52x the median, 1.0 at 36x, 0.6 at 35x but with surface
 * noise rising 1.30 -> 1.35 as real surface starts being cut away. 1.0 is where the artefact stops
 * shrinking and the cost starts.
 *
 * AND THE TEST STAYS ON THE RADII, not on the finished quad. Measuring the quad directly catches
 * SLIVERS as well as bridges, and it works: the skirt's sliver triangles fell from 8.4% to 0.02% and
 * its edges past 20 mm from 9,356 to 398. It was still reverted, because those slivers are the cloth
 * — thin panels genuinely produce thin quads — and removing them opened holes that cost more than the
 * slivers did: IoU 0.872 -> 0.846 and surface noise 1.30 -> 1.38. A defect metric improving while the
 * two quality metrics fall is the whole reason both are measured.
 */
const BRIDGE_RADIUS_JUMP = 1.0;

/**
 * Below this ratio of smallest to largest radius, a section is a SHEET and gets no end caps.
 *
 * A cap on a tube is a small lid. A cap on a sheet is a plate as wide as the sheet itself, and it is
 * flat, so it shades as a hard slab: the skirt's cape panels each grew a horizontal plate across the
 * waist and a rim around the hem, which is what the isolated skirt render showed as a wide band and a
 * cylinder sitting between the panels. The reference has none of that, because a cape is an open
 * shell rather than a solid.
 *
 * This is the one useful half of the old open-arc machinery, kept without the rest of it: exact
 * slicing already represents a sheet correctly as a thin closed loop, so all that was still needed
 * was to stop lidding it.
 */
const SHEET_FLATNESS = 0.25;

/**
 * An OPEN strand is one whose sections are arcs rather than closed outlines.
 *
 * Decided per STRAND, not per ring, because correspondence has to hold along the whole strip: rings
 * disagreeing about where the arc starts would twist it. The arc used is the median start and the
 * SHORTEST run, so every ring in the strand actually has surface across the whole span.
 */
export function strandArc(strand: Ring[]): { start: number; length: number } | null {
  const arcs = strand.map((r) => r.arc).filter(Boolean) as Array<readonly [number, number]>;
  if (arcs.length < strand.length * 0.5) return null;
  const starts = arcs.map((a) => a[0]).sort((a, b) => a - b);
  const lengths = arcs.map((a) => a[1]).sort((a, b) => a - b);
  return { start: starts[Math.floor(starts.length / 2)], length: Math.max(3, lengths[0]) };
}

/** Ratio of the smallest to the largest radius, medianed over a strand. 0 is a plane, 1 a circle. */
function strandFlatness(strand: Ring[]): number {
  const ratios = strand.map((ring) => {
    let lo = Infinity;
    let hi = 0;
    for (const [px, pz] of ring.points) {
      const r = Math.hypot(px - ring.centroid[0], pz - ring.centroid[1]);
      if (r < lo) lo = r;
      if (r > hi) hi = r;
    }
    return hi > 0 ? lo / hi : 1;
  }).sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)];
}

function ringPerimeter(ring: Ring): number {
  let total = 0;
  for (let k = 0; k < ring.points.length; k += 1) {
    const a = ring.points[k];
    const b = ring.points[(k + 1) % ring.points.length];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

/**
 * Place a ring coordinate back into world space.
 *
 * Rings are stored in the plane perpendicular to their node's own slicing axis, so the two stored
 * numbers mean different world axes for different parts: for a z-sliced scabbard they are x and y,
 * for a y-sliced boot they are x and z.
 */
function toWorld(axis: 0 | 1 | 2, t: number, u: number, v: number): [number, number, number] {
  if (axis === 0) return [t, u, v];
  if (axis === 1) return [u, t, v];
  return [u, v, t];
}

/** Rings of one node, chained into strands. */
export function strandsForNode(node: number): Ring[][] {
  const rings = SECTIONS.filter((r) => r.node === node).slice().sort((a, b) => a.t - b.t);
  const strands: Ring[][] = [];
  for (const ring of rings) {
    let best: Ring[] | null = null;
    let bestDistance = STRAND_RADIUS;
    for (const strand of strands) {
      const tip = strand[strand.length - 1];
      // One ring per strand per band, or a band with two clusters would stack both on one strand.
      if (tip.t >= ring.t) continue;
      const distance = Math.hypot(tip.centroid[0] - ring.centroid[0],
        tip.centroid[1] - ring.centroid[1]);
      const ratio = ringPerimeter(ring) / Math.max(ringPerimeter(tip), 1e-6);
      if (ratio > STRAND_PERIMETER_RATIO || ratio < 1 / STRAND_PERIMETER_RATIO) continue;
      if (distance < bestDistance) {
        best = strand;
        bestDistance = distance;
      }
    }
    if (best) best.push(ring);
    else strands.push([ring]);
  }
  // A lone ring is a slab, not a solid — and a strand only a few rings long inside a part that spans
  // dozens is not a feature either. Those stubs come from a plane clipping a fold or a seam for two
  // or three bands running; lofted and capped they become small closed tubes floating inside the
  // part, which is what the isolated skirt render showed sitting between its panels.
  //
  // The floor is RELATIVE to the node's own longest strand, not absolute: a genuinely short part has
  // every strand short, and an absolute floor would delete the whole part.
  const longest = strands.reduce((m, s) => Math.max(m, s.length), 0);
  const floor = Math.max(2, Math.round(longest * STRAND_MIN_SPAN));
  return strands.filter((s) => s.length >= floor);
}

interface ResampledRing {
  t: number;
  centroid: [number, number];
  points: Array<[number, number]>;
}

/**
 * Centripetal Catmull-Rom (alpha = 0.5) between p1 and p2, in Barry-Goldman pyramidal form.
 *
 * The pyramid rather than the basis-matrix form because the knots here are NON-UNIFORM, which is the
 * entire point: the matrix form assumes even spacing and would reintroduce the defect it exists to
 * remove.
 *
 * Why centripetal and not uniform, measured on this same kind of data by the girl-character build
 * that solved it first:
 *
 *     uniform      11.82% of samples leave the bracketing pair, worst 29.61 mm
 *     centripetal   6.12%                                       worst  5.94 mm
 *
 * The residual 6.12% is deliberately NOT clamped. Around a convex ring the curve MUST bow outside the
 * chord — that bowing is exactly what turns a 32-gon into a circle. Clamping it to the chord's
 * bounding box flattens it straight back and destroys the smoothing this exists to produce.
 */
function centripetal(
  p0: readonly [number, number], p1: readonly [number, number],
  p2: readonly [number, number], p3: readonly [number, number], s: number,
): [number, number] {
  const knot = (a: readonly [number, number], b: readonly [number, number]): number =>
    Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])), 1e-6);
  const t1 = knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + s * (t2 - t1);
  const mix = (a: readonly [number, number], b: readonly [number, number],
    ta: number, tb: number): [number, number] => {
    const w = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };
  const a1 = mix(p0, p1, 0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  return mix(mix(a1, a2, 0, t2), mix(a2, a3, t1, t3), t1, t2);
}

/**
 * The same curve for the slice coordinate.
 *
 * `t` is not bookkeeping — it is a coordinate of the finished vertex, so a kink in it is a crease in
 * the surface exactly like a kink in the outline. Interpolating the outline smoothly while stepping
 * `t` linearly would leave the faceting in place along the axis and hide the reason for it.
 */
function centripetalScalar(v0: number, v1: number, v2: number, v3: number, s: number): number {
  return centripetal([v0, 0], [v1, 0], [v2, 0], [v3, 0], s)[0];
}

/**
 * Resample a strand to an arbitrary ring count and spoke count.
 *
 * SMOOTH, NOT LINEAR, AND THAT IS THE WHOLE POINT. An earlier version lerped between neighbouring
 * measured rings and neighbouring spokes. A lerp is C0: the surface it produces has a crease at every
 * one of the 40 measured rings and every one of the 32 measured spokes. At the measured resolution
 * those creases are the facets of a coarse mesh and read as low-poly. Subdivided to hit the
 * reference's triangle count they do not go away — the extra rows and columns just lay flat panels
 * between the same creases, so the count rises while the surface stays a polyhedron and the creases
 * become visible as crumpling and horizontal banding. That is what "still noisy at 1.6M triangles"
 * was: not measurement noise, an interpolant with no second derivative.
 *
 * Rings stay spoke-aligned — spoke k of every ring came from the same ray angle — so each spoke is
 * its own curve up the strand and the lofted walls come out untwisted.
 *
 * NOT TRIED, AND ON PURPOSE: radial smoothing along the strand. The girl-character build tested two
 * filters ([1,2,1]/4 and an excess-second-difference notch) against exactly these streaks. The notch
 * removes 100% of the Nyquist component and the noise fell only 6.8%, which refutes ring-to-ring
 * jitter as the cause, and both filters cost IoU (0.912 -> 0.874/0.883 on gloves). A filter is the
 * wrong tool here; the interpolant was.
 */
function resampleStrand(
  strand: Ring[], rows: number, spokes: number,
  arc: { start: number; length: number } | null,
): ResampledRing[] {
  const sourceSpokes = strand[0].points.length;
  const clamp = (i: number, n: number): number => Math.min(n - 1, Math.max(0, i));

  // PASS 1: resample each MEASURED ring around its own outline. The lookup wraps, so the curve closes
  // on itself with no seam at spoke 0.
  const wide: Array<Array<[number, number]>> = strand.map((ring) => {
    const pts = ring.points as ReadonlyArray<readonly [number, number]>;
    const at = (i: number): readonly [number, number] =>
      pts[((i % sourceSpokes) + sourceSpokes) % sourceSpokes];
    const out: Array<[number, number]> = [];
    for (let k = 0; k < spokes; k += 1) {
      // A closed ring walks the whole circle; an arc walks only the span that has surface. The
      // control-point LOOKUP still wraps either way — an arc can cross spoke 0, and the neighbours
      // just outside the span are real measured points that make good end tangents.
      const fs = arc
        ? arc.start + (k / (spokes - 1)) * (arc.length - 1)
        : (k / spokes) * sourceSpokes;
      const i1 = Math.floor(fs);
      out.push(centripetal(at(i1 - 1), at(i1), at(i1 + 1), at(i1 + 2), fs - i1));
    }
    return out;
  });

  // PASS 2: run each spoke up the strand as its own curve.
  const out: ResampledRing[] = [];
  for (let r = 0; r < rows; r += 1) {
    const f = (r / (rows - 1)) * (strand.length - 1);
    const i1 = Math.min(strand.length - 1, Math.floor(f));
    const s = f - i1;
    const j0 = clamp(i1 - 1, strand.length);
    const j1 = clamp(i1, strand.length);
    const j2 = clamp(i1 + 1, strand.length);
    const j3 = clamp(i1 + 2, strand.length);
    const points: Array<[number, number]> = [];
    for (let k = 0; k < spokes; k += 1) {
      points.push(centripetal(wide[j0][k], wide[j1][k], wide[j2][k], wide[j3][k], s));
    }
    out.push({
      t: centripetalScalar(strand[j0].t, strand[j1].t, strand[j2].t, strand[j3].t, s),
      centroid: centripetal(strand[j0].centroid as readonly [number, number],
        strand[j1].centroid as readonly [number, number],
        strand[j2].centroid as readonly [number, number],
        strand[j3].centroid as readonly [number, number], s),
      points,
    });
  }
  return out;
}

/** Mean perimeter and height of a strand, for choosing a grid with square-ish quads. */
function strandMetrics(strand: Ring[]): { perimeter: number; height: number } {
  let perimeter = 0;
  for (const ring of strand) {
    let p = 0;
    for (let k = 0; k < ring.points.length; k += 1) {
      const a = ring.points[k];
      const b = ring.points[(k + 1) % ring.points.length];
      p += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    perimeter += p;
  }
  return {
    perimeter: perimeter / strand.length,
    height: Math.max(strand[strand.length - 1].t - strand[0].t, 1e-4),
  };
}

/**
 * Neighbour-averaging passes over the NORMAL attribute only.
 *
 * Positions are left untouched, and that is the point. The silhouette is a function of positions, so
 * this cannot move it — IoU is unaffected by construction — while the crumpling the eye actually sees
 * is a function of normals. Every earlier attempt at the noise went after positions and paid for it
 * in shape: pooling the radius estimator cost 0.05 IoU, and dropping the section resolution cost
 * another 0.03. This separates the two properties instead of trading one against the other.
 *
 * Two passes. One leaves visible residue on the tightest parts, and past three the shading starts to
 * flatten genuine creases — the belt edge and the boot cuff stop reading as edges.
 */
const NORMAL_SMOOTHING_PASSES = 2;

function smoothNormals(geometry: THREE.BufferGeometry, passes: number): void {
  const index = geometry.getIndex();
  const normal = geometry.getAttribute('normal');
  if (!index || passes <= 0) return;
  const count = normal.count;
  const idx = index.array;
  let src = normal.array as Float32Array;
  for (let pass = 0; pass < passes; pass += 1) {
    const acc = new Float32Array(count * 3);
    // Accumulate each triangle's three normals onto all three of its corners: every vertex ends up
    // holding the sum over its incident triangles' corners, which is its one-ring neighbourhood.
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t];
      const b = idx[t + 1];
      const c = idx[t + 2];
      for (const v of [a, b, c]) {
        acc[v * 3] += src[a * 3] + src[b * 3] + src[c * 3];
        acc[v * 3 + 1] += src[a * 3 + 1] + src[b * 3 + 1] + src[c * 3 + 1];
        acc[v * 3 + 2] += src[a * 3 + 2] + src[b * 3 + 2] + src[c * 3 + 2];
      }
    }
    for (let v = 0; v < count; v += 1) {
      const x = acc[v * 3];
      const y = acc[v * 3 + 1];
      const z = acc[v * 3 + 2];
      const len = Math.hypot(x, y, z);
      if (len > 1e-8) {
        acc[v * 3] = x / len;
        acc[v * 3 + 1] = y / len;
        acc[v * 3 + 2] = z / len;
      } else {
        acc[v * 3] = src[v * 3];
        acc[v * 3 + 1] = src[v * 3 + 1];
        acc[v * 3 + 2] = src[v * 3 + 2];
      }
    }
    src = acc;
  }
  geometry.setAttribute('normal', new THREE.BufferAttribute(src, 3));
}

/**
 * Loft one strand to an EXACT triangle count.
 *
 * A grid alone cannot land on an arbitrary integer: a closed strand of S spokes and R rows yields
 * 2*S*R triangles, so the reachable counts are the even multiples of 2S. The reference's per-mesh
 * counts are arbitrary even numbers, so the grid is solved to the largest count that does not exceed
 * the target and the remainder is made up by CENTRE-SPLITTING quads.
 *
 * A centre split replaces a quad's two triangles with four around a new vertex, so each one adds
 * exactly two. The new vertex is the bilinear midpoint of its own quad, which lies ON the surface
 * the quad already describes — the mesh stays watertight, gains no T-junction, and does not change
 * shape. Splits are spread on a stride across the whole grid rather than run together, so the extra
 * density is not visible as a patch.
 *
 * `inflate` pushes each ring point out along its own radius from the cluster centroid. It exists for
 * LAYERING, not for shape. Each part is reconstructed independently, so where the inner layer's
 * reconstruction runs slightly fat it pokes through the garment over it: measured, the torso came out
 * at 1.12x the reference volume and 8.6% wider, and the arms inside it then took the glove sleeves'
 * pixels — IoU 0.09 on gloves whose own area ratio was 0.94, i.e. the right size in the wrong
 * z-order. Shrinking the body rather than growing the garment keeps the silhouette, which is what the
 * outer layer owns.
 */
export interface CapPlan { readonly bottom: boolean; readonly top: boolean }


/**
 * Where this strand's band sits in its part's texture sheet.
 *
 * A part is one mesh with one material, and a strand is a piece of that mesh — so the strands share
 * one image, stacked as horizontal bands, and each addresses its own. Without this every strand's UVs
 * would overlap and each would sample the whole sheet.
 */
export interface UvBand { readonly index: number; readonly count: number }

export function strandGeometry(
  strand: Ring[], target: number, inflate = 0,
  plan: CapPlan = { bottom: true, top: true },
  band: UvBand = { index: 0, count: 1 },
): THREE.BufferGeometry {
  const arc = strandArc(strand);
  // An arc has no interior to close. A fan to a centroid sitting in the air beside it would rebuild
  // exactly the solid the arc exists to avoid.
  //
  // These two booleans, not the caller's plan, are what BOTH the triangle count and the emitter read.
  // Deriving the count from one and the geometry from the other is how the open branch shipped eight
  // triangles over its target: the count said an arc has no caps while the emitter still fanned the
  // plan's two, and the exactness sweep caught it on the first open strand it tried.
  const capBottom = !arc && plan.bottom;
  const capTop = !arc && plan.top;
  const caps = (capBottom ? 1 : 0) + (capTop ? 1 : 0);
  const { perimeter, height } = strandMetrics(strand);
  const aspect = Math.max(0.08, perimeter / height);

  if (target % 2 !== 0) {
    throw new Error(`girl-character-3: odd triangle target ${target}. A quad grid emits triangles in `
      + 'pairs and a centre split adds two at a time, so an odd target is unreachable by construction.');
  }

  // Side quads contribute 2*C*(R-1) where C is the column count — S around a closed ring, S-1 across
  // an open strip, which has no column joining its last spoke back to its first. Each cap fan
  // contributes S. A closed tube with both caps is therefore the familiar 2*S*R.
  //
  // The cap count is a PARAMETER because a cap is not always wanted: a strand that ends buried inside
  // a sibling emits a flat disc there, and being flat it shades as a hard band across the surface --
  // the shards visible around the torso's armholes. Dropping such a cap has to be reflected here or
  // the part misses its triangle count.
  //
  // There is no open-strip case any more. It existed because the percentile estimator could not tell
  // a thin curved sheet from a tube and closed it into a solid; an exact plane slice through a sheet
  // is simply a long thin CLOSED loop, which is what the sheet is.
  const columnsFor = (spokes: number): number => (arc ? spokes - 1 : spokes);
  const countFor = (spokes: number, rows: number): number =>
    2 * columnsFor(spokes) * (rows - 1) + caps * spokes;
  // Bridges are discovered only once the grid exists, so the solve below is done without them and the
  // shortfall becomes extra centre splits — which is exactly what the split budget is for.
  // Tallest grid of this width that still fits under the target. Flooring is what guarantees the
  // count lands under it; the width bound below is what guarantees the answer is at least two rows,
  // so this needs no feasibility branch of its own.
  const rowsFor = (spokes: number): number =>
    Math.floor((target - caps * spokes) / (2 * columnsFor(spokes))) + 1;

  // PICK THE WIDTH BY CLAMPING, NOT BY SEARCHING.
  //
  // An earlier version seeded the width at the square-quad ideal and then looked for a better one with
  // `count <= target && count > base`. When the seed itself overshot, that condition could never fire
  // — nothing under the target is greater than a base already above it — so the overshoot survived,
  // was clamped to zero splits, and shipped the part a few triangles heavy. A sweep found 310
  // (target, aspect) pairs that missed this way, all at small targets with a wide aspect where the
  // ideal width leaves room for fewer than two rows. None were among this model's thirty-one, so every
  // part-level gate was green while the mechanism was broken.
  //
  // The fix needs no search. Feasibility here means "two rows still fit", which is monotonic in width:
  // the feasible widths are the contiguous range up to target/4 closed, target/2 + 1 open. Flooring
  // the row count already guarantees the resulting count is under the target. And the width wanted is
  // the FEASIBLE ONE CLOSEST TO THE SQUARE-QUAD IDEAL, which for a contiguous integer range is just
  // the ideal clamped into it. A loop over every candidate returns the same answer after up to
  // target/4 iterations — 64,849 of them for this model's largest part.
  //
  // Closest to the ideal, and NOT the tightest fit: the tightest fit is usually a very wide grid of
  // exactly two rows, which flattens the strand's whole length into one band and throws the silhouette
  // away. Measured, that cost 0.844 -> 0.778 area-weighted IoU while every triangle count stayed
  // exact. Centre splits sit ON the surface and change no shape, so how many there are does not matter
  // to the result. Shape decides the grid; splits absorb the remainder.
  // Spokes are kept EVEN so the emitted count stays even for an odd cap count too: the total is
  // S*(2R-2+caps), which with an odd cap count inherits S's parity, and an odd total is unreachable
  // by a mechanism that adds triangles two at a time.
  const minSpokes = 4;
  // Widest grid that still leaves two rows: closed needs caps*S + 2*S <= target, open 2*(S-1) <= target.
  const maxSpokes = Math.max(minSpokes, (arc
    ? Math.floor(target / 2) + 1
    : Math.floor(target / (caps + 2))) & ~1);
  if (maxSpokes < minSpokes) {
    throw new Error(`girl-character-3: triangle target ${target} is below the smallest grid this loft `
      + `can build (${countFor(minSpokes, 2)}). Raise the strand's share of the node budget.`);
  }
  const ideal = Math.round(Math.sqrt((target / 2) * aspect));
  const spokes = Math.min(maxSpokes, Math.max(minSpokes, ideal)) & ~1;
  const rows = rowsFor(spokes);
  const base = countFor(spokes, rows);

  const rings = resampleStrand(strand, rows, spokes, arc);
  const cols = columnsFor(spokes);

  /** Quads that span a non-star-convex opening rather than covering surface. */
  const bridged = (r: number, k: number): boolean => {
    const ringA = rings[r];
    const ringB = rings[r + 1];
    const next = (k + 1) % spokes;
    const kk = k % spokes;
    const radius = (ring: ResampledRing, i: number): number => Math.hypot(
      ring.points[i][0] - ring.centroid[0], ring.points[i][1] - ring.centroid[1]);
    for (const ring of [ringA, ringB]) {
      const a = radius(ring, kk);
      const b = radius(ring, next);
      const lo = Math.min(a, b);
      if (lo > 1e-6 && Math.abs(a - b) / lo > BRIDGE_RADIUS_JUMP) return true;
    }
    return false;
  };
  /**
   * Vertices per ring. A CLOSED ring carries one MORE than it has spokes.
   *
   * The wrap column used to index straight back to spoke 0, which is right for positions and wrong
   * for UVs: u ran (spokes-1)/spokes on one side of that quad and 0 on the other, so the last quad
   * sampled the ENTIRE sheet backwards across itself. On a y-sliced torso that seam sits down the
   * front centreline, and it rendered as the black smear running from the collar through the corset.
   *
   * Duplicating the seam vertices — same position, u = 1 instead of 0 — is the standard fix. It costs
   * one column of vertices per ring and NO triangles, so the exact per-part counts are untouched.
   */
  const ringStride = arc ? spokes : spokes + 1;
  // Which quads bridge an opening, worst first — and only as many as the split budget can pay for.
  //
  // Dropping a quad costs two triangles that must be found again as centre splits, and a split needs
  // a surviving quad to sit in. With B dropped the grid emits 2*(total-B) + caps*spokes, so
  // splits = (target - caps*spokes)/2 - (total-B), and splits <= total-B gives
  // B <= total - (target - caps*spokes)/4.
  //
  // Bounding it HERE rather than letting it surface downstream matters: without it a small strand
  // threw outright — a 4x7 grid with eighteen quads asked for twenty-five splits — and the sweep
  // caught it at targets none of this model's thirty-one parts happen to use. The same shape of
  // latent defect as the solver overshoot found earlier.
  const total = cols * (rings.length - 1);
  const jump = (r: number, k: number): number => {
    const next = (k + 1) % spokes;
    const kk = k % spokes;
    const radius = (ring: ResampledRing, i: number): number => Math.hypot(
      ring.points[i][0] - ring.centroid[0], ring.points[i][1] - ring.centroid[1]);
    let worst = 0;
    for (const ring of [rings[r], rings[r + 1]]) {
      const a = radius(ring, kk);
      const b = radius(ring, next);
      const lo = Math.min(a, b);
      if (lo > 1e-6) worst = Math.max(worst, Math.abs(a - b) / lo);
    }
    return worst;
  };
  const candidates: Array<{ key: number; badness: number }> = [];
  for (let r = 0; r < rings.length - 1; r += 1) {
    for (let k = 0; k < cols; k += 1) {
      if (bridged(r, k)) candidates.push({ key: r * cols + k, badness: jump(r, k) });
    }
  }
  candidates.sort((a, b) => b.badness - a.badness);
  const affordable = Math.max(0, Math.floor(total - Math.max(0, target - caps * spokes) / 4));
  const suppressed = new Set<number>();
  for (const c of candidates.slice(0, affordable)) suppressed.add(c.key);
  const bridgeCount = suppressed.size;
  const quads = total - bridgeCount;
  // Each split adds two triangles, and both base and target are even, so this is a whole number.
  //
  // No clamp. Flooring the row count leaves a deficit smaller than one full row of quads, so there is
  // always room; if that ever stops holding, the loft must say so rather than quietly ship a part that
  // misses its count.
  //
  // The margin is thinner than it sounds. Swept over 399,540 (target, aspect) solves the invariant
  // never broke, but the worst case consumed 99.8% of the available quads. So this is a real
  // guarantee with almost no slack: any future change to how rows are floored breaks it immediately,
  // which is exactly why it throws here instead of trusting the argument.
  const splitsNeeded = (target - base) / 2 + bridgeCount;
  if (splitsNeeded < 0 || splitsNeeded > quads) {
    throw new Error(`girl-character-3: cannot reach ${target} triangles from a ${spokes}x${rows} grid `
      + `of ${base} with ${quads} quads (needs ${splitsNeeded} centre splits).`);
  }
  const stride = splitsNeeded > 0 ? quads / splitsNeeded : Infinity;

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const axis = strand[0].axis;

  const pushVertex = (t: number, u: number, v: number, uu: number, vv: number): number => {
    const [x, y, z] = toWorld(axis, t, u, v);
    positions.push(x, y, z);
    uvs.push(uu, vv);
    return positions.length / 3 - 1;
  };

  const spokeSpan = arc ? Math.max(1, spokes - 1) : spokes;
  const offsetPoint = (ring: ResampledRing, k: number): [number, number] => {
    let [pu, pv] = ring.points[k];
    const du = pu - ring.centroid[0];
    const dv = pv - ring.centroid[1];
    const len = Math.hypot(du, dv);
    if (len > 1e-6) {
      // Inflate is a fixed layering nudge; displacement is measured detail. Both act along the same
      // outward direction, so they are applied in one step rather than two normalisations.
      if (inflate !== 0) {
        pu += (du / len) * inflate;
        pv += (dv / len) * inflate;
      }
    }
    return [pu, pv];
  };

  for (let rowIndex = 0; rowIndex < rings.length; rowIndex += 1) {
    const ring = rings[rowIndex];
    for (let k = 0; k < ringStride; k += 1) {
      // The duplicate at k === spokes takes spoke 0's POSITION and the seam's own u.
      const [pu, pv] = offsetPoint(ring, k % spokes);
      // NORMALISED, and addressed to this strand's band of its part's sheet.
      //
      // These used to run in world units so a procedural grain would keep one physical scale
      // regardless of part size. That is the right choice for a tiling grain and the wrong one for a
      // baked sheet, which is a MAP of this strand and has to be sampled exactly once across it. The
      // grain textures keep their scale through their own `repeat`.
      pushVertex(ring.t, pu, pv,
        arc ? k / spokeSpan : k / spokes,
        (band.index + rowIndex / Math.max(1, rings.length - 1)) / band.count);
    }
  }

  let quadIndex = 0;
  let splitsPlaced = 0;
  for (let r = 0; r < rings.length - 1; r += 1) {
    for (let k = 0; k < cols; k += 1) {
      // No modulo any more: the closed ring's extra column IS the wrap, so the neighbour is always
      // the next index.
      const next = k + 1;
      const a = r * ringStride + k;
      const b = r * ringStride + next;
      const c = (r + 1) * ringStride + k;
      const d = (r + 1) * ringStride + next;

      if (suppressed.has(r * cols + k)) continue;
      const wantSplit = splitsPlaced < splitsNeeded
        && Math.floor(quadIndex / stride) >= splitsPlaced;
      if (wantSplit) {
        // Bilinear midpoint of this quad's own four corners: on the surface, so the split is
        // invisible.
        const ringA = rings[r];
        const ringB = rings[r + 1];
        const [au, av] = offsetPoint(ringA, k % spokes);
        const [bu, bv] = offsetPoint(ringA, next % spokes);
        const [cu, cv] = offsetPoint(ringB, k % spokes);
        const [du2, dv2] = offsetPoint(ringB, next % spokes);
        const centre = pushVertex(
          (ringA.t + ringB.t) / 2,
          (au + bu + cu + du2) / 4,
          (av + bv + cv + dv2) / 4,
          arc ? (k + 0.5) / spokeSpan : (k + 0.5) / spokes,
          (band.index + (r + 0.5) / Math.max(1, rings.length - 1)) / band.count,
        );
        indices.push(a, c, centre, c, d, centre, d, b, centre, b, a, centre);
        splitsPlaced += 1;
      } else {
        indices.push(a, c, b, b, c, d);
      }
      quadIndex += 1;
    }
  }

  // Caps close the tube's ends — those that are not buried in a sibling.
  {
    const ends = ([[rings[0], false], [rings[rings.length - 1], true]] as
      ReadonlyArray<readonly [ResampledRing, boolean]>)
      .filter(([, isTop]) => (isTop ? capTop : capBottom));
    for (const [ring, isTop] of ends) {
      const centre = pushVertex(ring.t, ring.centroid[0], ring.centroid[1], 0.5,
        (band.index + (isTop ? 1 : 0)) / band.count);
      const base2 = isTop ? (rings.length - 1) * ringStride : 0;
      for (let k = 0; k < spokes; k += 1) {
        // The cap fan closes the real ring, so here the wrap IS modulo — it must join spoke
        // spokes-1 back to spoke 0, not to the duplicate, or the lid has a gap the width of one quad.
        const next = (k + 1) % spokes;
        if (isTop) indices.push(centre, base2 + k, base2 + next);
        else indices.push(centre, base2 + next, base2 + k);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  smoothNormals(geometry, NORMAL_SMOOTHING_PASSES);

  // The exactness is the whole point of this function, so it is checked here rather than left to a
  // gate downstream. A gate can only report that some part is off; this names the strand and the
  // arithmetic that produced it, at the moment it happens.
  const built = indices.length / 3;
  if (built !== target) {
    throw new Error(`girl-character-3: loft emitted ${built} triangles for a target of ${target} `
      + `(${spokes}x${rows} grid, base ${base}, ${splitsPlaced}/${splitsNeeded} splits placed).`);
  }
  return geometry;
}

/**
 * Every strand of one node, each as its own geometry, sharing the node's triangle budget in
 * proportion to its surface area.
 *
 * Proportional and not equal: node 0 has a long skirt panel beside a short one, and splitting the
 * budget evenly would give the short one a denser mesh than the long one.
 */
/**
 * Is this strand's end buried inside a sibling strand of the same node?
 *
 * WHY IT MATTERS: A CAP THAT IS BURIED IS AN ARTEFACT, NOT A REDUNDANCY. Clustering splits a node
 * into separate tubes — the torso's bodice and its shoulder straps, a boot and its folded cuff — and
 * where one tube ends INSIDE another, capping it emits a flat disc embedded in the neighbouring
 * surface. Being flat, it shades as a hard-edged shard cutting across the part; those were the
 * slivers visible around the torso's armholes. The girl-character build hit the same thing on the
 * arms, where the cap read as the arm having been sliced in half.
 *
 * Leaving such an end open is invisible precisely BECAUSE the opening is inside another surface. An
 * end that is NOT buried — a wrist, a hem — keeps its lid.
 */
function endIsBuried(strand: Ring[], siblings: Ring[][], top: boolean): boolean {
  const ring = top ? strand[strand.length - 1] : strand[0];
  for (const other of siblings) {
    if (other === strand) continue;
    // Compare against the sibling's own section at this height; a sibling that does not reach this
    // far along the axis cannot be enclosing anything here.
    let nearest: Ring | null = null;
    let bestGap = Infinity;
    for (const candidate of other) {
      const gap = Math.abs(candidate.t - ring.t);
      if (gap < bestGap) { bestGap = gap; nearest = candidate; }
    }
    if (!nearest || bestGap > 0.02) continue;
    if (pointInRing(ring.centroid, nearest)) return true;
  }
  return false;
}

/** Even-odd crossing test against a ring's sampled outline. */
function pointInRing(point: readonly [number, number], ring: Ring): boolean {
  const pts = ring.points;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > point[1]) !== (yj > point[1])
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function nodeGeometries(
  node: number, budget: number, inflate = 0,
): THREE.BufferGeometry[] {
  const strands = strandsForNode(node);
  if (strands.length === 0) {
    throw new Error(`girl-character-3: reference node ${node} produced no strands to loft.`);
  }
  const areas = strands.map((s) => {
    const { perimeter, height } = strandMetrics(s);
    return Math.max(perimeter * height, 1e-6);
  });
  const total = areas.reduce((a, b) => a + b, 0);

  // Proportional to surface area, not equal: a node can hold a long skirt panel beside a short one,
  // and an equal split would give the short one the denser mesh.
  //
  // Each share is rounded DOWN to an even number, because a strand's reachable counts are even, and
  // the whole remainder is then handed to the largest strand. Spreading the remainder would leave a
  // rounding residue on every strand and the node total would miss its target by a few triangles —
  // which is the difference between "within a percent" and equal.
  const FLOOR = 48;
  const shares = areas.map((a) => Math.max(FLOOR, Math.floor((budget * a / total) / 2) * 2));
  const largest = areas.indexOf(Math.max(...areas));
  const assigned = shares.reduce((a, b) => a + b, 0);
  shares[largest] += budget - assigned;

  // Guard the value that can actually go wrong, not a proxy for it.
  //
  // Every share is floored UP to FLOOR, so a node with many small strands can have its shares sum
  // past the budget before correction; the correction then subtracts the whole overshoot from one
  // strand and can drive it under FLOOR, or negative. Checking `strands.length * FLOOR > budget`
  // instead only catches the case where every strand is at the floor, and misses the skewed one.
  // This check subsumes it: that case makes `assigned` exceed the budget too.
  //
  // Not reachable with this model's geometry — the tightest node clears FLOOR by 6,372 triangles —
  // but the failure would otherwise surface as an unexplained grid error inside one strand rather
  // than as a statement about which node's budget cannot be divided.
  if (shares[largest] < FLOOR) {
    throw new Error(`girl-character-3: node ${node} cannot divide a budget of ${budget} across `
      + `${strands.length} strands: after every strand is raised to the ${FLOOR}-triangle floor, the `
      + `largest is left with ${shares[largest]}.`);
  }

  return strands.map((strand, i) => {
    const sheet = strandFlatness(strand) < SHEET_FLATNESS;
    return strandGeometry(strand, shares[i], inflate, {
      bottom: !sheet && !endIsBuried(strand, strands, false),
      top: !sheet && !endIsBuried(strand, strands, true),
    }, { index: i, count: strands.length });
  });
}
