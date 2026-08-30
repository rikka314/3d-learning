/**
 * Glock-18 | Ghost Protocol (Well-Worn) — procedural CS2 reconstruction.
 *
 * Route: reference-projection.  Exactness tier: image-only.
 * Family adapter: pistol / glock-18 (authored for this build — the img2threejs CS2 adapter
 * table shipped knife-only, and a knife tree must never stand in for a pistol).
 *
 * GEOMETRY is the alpha trace of the two supplied broadside references (`geo.json`):
 * the slide silhouette, the slide/frame parting line, the dust cover, the trigger-guard
 * loop and its hole, the beavertail, the grip rake and the magazine extension are all real
 * silhouette samples. Front and back traces agree to 1.6 px mean on both edges.
 *
 * CROSS-SECTION is NOT a constant extrusion. Every shell part is a variable-thickness LOFT:
 * the traced outline is swept through eleven rings whose Z is `t * halfWidth(x, y)`, so the
 * dust cover is thinner than the receiver, the grip carries a palm swell and a raised panel
 * plateau, the slide deck chamfers in above the flats, and the magazine floorplate flares.
 * A constant extrusion — even a bevelled one — lands on ~10 distinct Z planes no matter how
 * many triangles it has, and reads as cardboard from every angle the review gates cannot see.
 *
 * FINISH is not a procedural circuit pattern. Each broad face carries the de-lit reference
 * crop for that side, projected through one shared planar UV frame, so every painted
 * detail — the magenta and orange trace bundles, "G18", "GLOCK(18)", "GHOST", "(*)",
 * "PROTOCOL", the ">_" prompt, the bar-graph glyphs and the worn magwell streak — lands
 * exactly where the reference has it. Roughness / metalness / AO / normal are separate
 * authored channels built from the traced geometry; none is derived from the albedo.
 *
 * Frame: +X = muzzle, +Y = sights, Z = across the gun.
 *   +Z face = FRONT reference (muzzle RIGHT; a camera on +Z reproduces it)
 *   -Z face = BACK reference, mirrored into the same UV frame
 *
 * Z thickness is INFERRED (confidence 0.45): both supplied views are broadside and neither
 * resolves depth. Widths are the published Glock-18 cross-sections scaled by the traced
 * height. See geo.thickness.basis.
 *
 * The shell is translucent polymer, so the internals are real mechanism rather than paint:
 * a lathed barrel with chamber swell, locking hood and bored muzzle; a coiled recoil spring
 * on its guide rod; the striker; the breech face behind a genuinely CUT ejection port; the
 * magazine body with feed lips and follower; and a Safe Action trigger built as two
 * intersecting components — a slotted curved shoe and a separate safety lever living in that
 * slot — riding a trigger bar and connector that lift out of the frame as one module.
 *
 * Two lessons are baked into the numbers here and are easy to undo by accident. A sloped cap
 * surface is measured by the BROADSIDE gate: an over-scaled slide-deck break put that zone
 * +23 luma over the reference, and what the gate reads is the SLOPE, not the depth — halving
 * the trigger-guard bow's ramp for a shallower waist took it from +19 to +54. And a cap must
 * be tessellated and normalled from the field, not from the triangulation: ear-clipping hands
 * back slivers whose averaged normals draw hard creases across the grip.
 */
import * as THREE from 'three';
import geo from './geo.json';
import frontAlbedoUrl from './front-albedo.png';
import backAlbedoUrl from './back-albedo.png';
import roughnessUrl from './roughness.png';
import metalnessUrl from './metalness.png';
import aoUrl from './ao.png';
import normalUrl from './normal.png';

export interface GlockGhostProtocolOptions {
  shadows?: boolean;
  /** 0 disables the see-through polymer (cheaper); default 0.3, solved against the reference. */
  transmission?: number;
}

type P2 = [number, number];
/** Half the Z thickness of a shell part at a point on its traced outline. */
type WidthFn = (x: number, y: number) => number;
/** Z of a loft ring at parameter `t` in [-1, 1] over outline point (x, y). */
type ZFn = (x: number, y: number, t: number) => number;

/** The one planar UV frame every projected part shares, in world units. */
const UV = (() => {
  const { scale, xc, yc, textureCrop: c } = geo.meta;
  return {
    x0: (c.x0 - xc) * scale,
    x1: (c.x1 - xc) * scale,
    y0: (yc - c.y1) * scale,
    y1: (yc - c.y0) * scale,
  };
})();

const px = (v: number) => v * geo.meta.scale; // pixel length -> world length
const wx = (v: number) => (v - geo.meta.xc) * geo.meta.scale;
const wy = (v: number) => (geo.meta.yc - v) * geo.meta.scale;

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const sq = (v: number) => v * v;
/** Hermite ramp from 0 at `a` to 1 at `b`; `b < a` simply reverses the direction. */
function sstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- geometry helpers

function shapeFrom(outline: number[][], holes: number[][][] = []): THREE.Shape {
  const s = new THREE.Shape();
  outline.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  for (const h of holes) {
    const p = new THREE.Path();
    h.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
    p.closePath();
    s.holes.push(p);
  }
  return s;
}

/** Clip a polygon to the half-plane y <= yMax (Sutherland–Hodgman, one edge). */
function clipTop(pts: number[][], yMax: number): number[][] {
  const out: number[][] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const ain = a[1] <= yMax;
    if (ain) out.push(a);
    if (ain !== b[1] <= yMax) {
      const t = (yMax - a[1]) / (b[1] - a[1]);
      out.push([a[0] + (b[0] - a[0]) * t, yMax]);
    }
  }
  return out;
}

/**
 * Move every vertex of a ring along its angle bisector, into the material. For a CCW
 * outer contour that shrinks the part; for a CW hole the same formula grows the opening,
 * which is the same operation seen from the material's side.
 *
 * The distance is per-vertex: a roll sized off the part's NOMINAL thickness turns a locally
 * slim section — the trigger-guard bow, at 58% of the receiver's width — almost entirely
 * into roll, and the bow renders as a white tube instead of a dark red bar.
 */
function offsetRing(ring: THREE.Vector2[], dAt: (p: THREE.Vector2) => number): THREE.Vector2[] {
  const n = ring.length;
  const nrm = (a: THREE.Vector2, b: THREE.Vector2) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    return new THREE.Vector2(-dy / l, dx / l);
  };
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const n1 = nrm(ring[(i - 1 + n) % n], p);
    const n2 = nrm(p, ring[(i + 1) % n]);
    const b = new THREE.Vector2(n1.x + n2.x, n1.y + n2.y);
    if (b.lengthSq() < 1e-12) {
      out.push(p.clone());
      continue;
    }
    b.normalize();
    // Miter length, clamped: a traced outline has near-cusps where an unclamped miter would
    // fling the vertex clean across the part.
    const c = Math.max(0.45, b.dot(n1));
    const d = dAt(p) / c;
    out.push(new THREE.Vector2(p.x + b.x * d, p.y + b.y * d));
  }
  return out;
}

/**
 * Split every cap triangle four ways, `rounds` times, and re-sample the thickness field at
 * each new interior vertex. Interior vertex indices are collected into `interior`.
 *
 * Without this the caps carry vertices only where the traced OUTLINE has them, so a swell in
 * the middle of the grip has nothing to displace and the palm dome collapses into a handful
 * of flat facets. Midpoints on a boundary edge keep the straight-line interpolation of their
 * parents, so they stay exactly on the wall and open no crack.
 */
function subdivideCap(
  P: number[], tris: number[][], t: number, zAt: ZFn, rounds: number, interior: number[],
): number[][] {
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let r = 0; r < rounds; r++) {
    const uses = new Map<string, number>();
    for (const [a, b, c] of tris)
      for (const [u, v] of [[a, b], [b, c], [c, a]])
        uses.set(key(u, v), (uses.get(key(u, v)) ?? 0) + 1);

    const mids = new Map<string, number>();
    const midOf = (a: number, b: number) => {
      const k = key(a, b);
      const hit = mids.get(k);
      if (hit !== undefined) return hit;
      const x = (P[a * 3] + P[b * 3]) / 2;
      const y = (P[a * 3 + 1] + P[b * 3 + 1]) / 2;
      const i = P.length / 3;
      const edge = uses.get(k) === 1;
      P.push(x, y, edge ? (P[a * 3 + 2] + P[b * 3 + 2]) / 2 : zAt(x, y, t));
      if (!edge) interior.push(i);
      mids.set(k, i);
      return i;
    };

    const next: number[][] = [];
    for (const [a, b, c] of tris) {
      const ab = midOf(a, b);
      const bc = midOf(b, c);
      const ca = midOf(c, a);
      next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    tris = next;
  }
  return tris;
}

/**
 * Overwrite cap-interior normals with the analytic normal of the thickness field.
 *
 * `computeVertexNormals` averages face normals, and ear-clipping hands back long slivers: three
 * nearly collinear samples of a curved field, whose averaged normal swings wildly. The palm
 * swell rendered as a fan of hard creases radiating across the grip — a shading artefact of the
 * triangulation, not of the surface. The field is analytic, so its gradient is the truth here.
 * Boundary vertices are left alone: theirs are shared with the wall and carry the rolled rim.
 */
function fieldNormals(g: THREE.BufferGeometry, zAt: ZFn, t: number, interior: number[]): void {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const e = 0.004;
  const s = Math.sign(t);
  for (const i of interior) {
    const x = p.getX(i);
    const y = p.getY(i);
    const fx = (zAt(x + e, y, t) - zAt(x - e, y, t)) / (2 * e);
    const fy = (zAt(x, y + e, t) - zAt(x, y - e, t)) / (2 * e);
    const l = Math.hypot(fx, fy, 1);
    n.setXYZ(i, (-s * fx) / l, (-s * fy) / l, s / l);
  }
}

/**
 * Ring parameters of the loft. Dense near ±1 so the silhouette rim rolls smoothly (the
 * references show a broad specular band all the way round, which a square extrusion cannot
 * produce) and sparse through the middle, where the surface is the broad projected face.
 */
const LOFT_T = [-1, -0.986, -0.945, -0.87, -0.55, 0, 0.55, 0.87, 0.945, 0.986, 1];

/**
 * Sweep a traced outline through `zAt`, producing a solid whose CROSS-SECTION varies with
 * position instead of a slab of constant depth. Three material groups come back: +Z face,
 * -Z face, rim — so each broad face can carry its own reference projection.
 *
 * `roll` insets the outline toward the caps so the widest ring lands exactly ON the trace
 * (an outward bevel cost ~7 points of silhouette IoU). `holeRoll` is separate because a
 * cut-out sometimes has to keep its traced opening at every depth — see the ejection port.
 */
function lofted(
  shape: THREE.Shape, zAt: ZFn, rollAt: WidthFn, holeRollAt = rollAt, subdiv = 2,
  openWall?: (x: number, y: number) => boolean,
): THREE.BufferGeometry {
  const raw = shape.extractPoints(12);
  const dedupe = (r: THREE.Vector2[]) =>
    r.length > 1 && r[0].distanceToSquared(r[r.length - 1]) < 1e-12 ? r.slice(0, -1) : r;
  const orient = (r: THREE.Vector2[], cw: boolean) =>
    THREE.ShapeUtils.isClockWise(r) === cw ? r : r.slice().reverse();

  const contour = orient(dedupe(raw.shape), false);
  const holes = raw.holes.map((h) => orient(dedupe(h), true));
  const rings = [contour, ...holes];
  const perLayer = rings.reduce((a, r) => a + r.length, 0);
  const ringBase: number[] = [];
  rings.reduce((a, r) => (ringBase.push(a), a + r.length), 0);

  // Triangulated once on the untouched trace and reused for both caps: the topology is the
  // same at every ring, and an inset ring can graze self-intersection on a traced outline.
  const capFaces = THREE.ShapeUtils.triangulateShape(contour, holes);

  const P: number[] = [];
  for (const t of LOFT_T) {
    const k = 1 - Math.sqrt(Math.max(0, 1 - t * t));
    rings.forEach((ring, ri) => {
      const d = ri === 0 ? rollAt : holeRollAt;
      const off = offsetRing(ring, (p) => d(p.x, p.y) * k);
      for (let i = 0; i < ring.length; i++) {
        // Z always comes from the untouched trace position, so a wall stays a clean quad strip.
        P.push(off[i].x, off[i].y, zAt(ring[i].x, ring[i].y, t));
      }
    });
  }

  const last = (LOFT_T.length - 1) * perLayer;
  const front: number[] = [];
  const back: number[] = [];
  const frontInner: number[] = [];
  const backInner: number[] = [];
  const shifted = capFaces.map(([a, b, c]) => [last + a, last + b, last + c]);
  for (const [a, b, c] of subdivideCap(P, shifted, 1, zAt, subdiv, frontInner)) front.push(a, b, c);
  for (const [a, b, c] of subdivideCap(P, capFaces, -1, zAt, subdiv, backInner)) back.push(c, b, a);
  const walls: number[] = [];
  for (let ti = 0; ti < LOFT_T.length - 1; ti++) {
    const lo = ti * perLayer;
    const hi = (ti + 1) * perLayer;
    rings.forEach((ring, ri) => {
      const o = ringBase[ri];
      for (let j = 0; j < ring.length; j++) {
        const k = (j + 1) % ring.length;
        // Leaving a run of the outer wall out opens a MOUTH between the two caps — how the
        // magwell and the slide's barrel raceway are cut. A loft sweeps along Z, so a cavity
        // that opens along -Y cannot be a hole in the outline; it has to be missing wall.
        if (openWall && ri === 0
            && openWall((ring[j].x + ring[k].x) / 2, (ring[j].y + ring[k].y) / 2)) continue;
        const a = o + j;
        const b = o + k;
        walls.push(lo + a, lo + b, hi + a, lo + b, hi + b, hi + a);
      }
    });
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
  g.setIndex([...front, ...back, ...walls]);
  g.addGroup(0, front.length, 0);
  g.addGroup(front.length, back.length, 1);
  g.addGroup(front.length + back.length, walls.length, 2);
  g.computeVertexNormals();
  fieldNormals(g, zAt, 1, frontInner);
  fieldNormals(g, zAt, -1, backInner);
  planarUV(g);
  return g;
}

/** Symmetric loft: the part is `2 * half(x, y)` thick, centred on z = 0. */
const sym = (half: WidthFn): ZFn => (x, y, t) => t * half(x, y);

/** One shared planar projection for every vertex, so the rim continues the face image. */
function planarUV(g: THREE.BufferGeometry): void {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = (p.getX(i) - UV.x0) / (UV.x1 - UV.x0);
    uv[i * 2 + 1] = (p.getY(i) - UV.y0) / (UV.y1 - UV.y0);
  }
  const attr = new THREE.BufferAttribute(uv, 2);
  g.setAttribute('uv', attr);
  g.setAttribute('uv1', attr); // aoMap reads uv1; same projection, so share the buffer
}

/** Discretise a shape into a Path usable as a hole in another shape. */
function pathOf(shape: THREE.Shape, divisions = 12): THREE.Path {
  const p = new THREE.Path();
  shape.getPoints(divisions).forEach((q, i) => (i ? p.lineTo(q.x, q.y) : p.moveTo(q.x, q.y)));
  return p;
}

function roundedRect(x0: number, y0: number, x1: number, y1: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(x0 + r, y0);
  s.lineTo(x1 - r, y0);
  s.quadraticCurveTo(x1, y0, x1, y0 + r);
  s.lineTo(x1, y1 - r);
  s.quadraticCurveTo(x1, y1, x1 - r, y1);
  s.lineTo(x0 + r, y1);
  s.quadraticCurveTo(x0, y1, x0, y1 - r);
  s.lineTo(x0, y0 + r);
  s.quadraticCurveTo(x0, y0, x0 + r, y0);
  return s;
}

/**
 * Axis-aligned block placed by world extents — used for every small opaque part.
 * `depth` is the TOTAL z extent including the chamfer, and the result is centred on `zc`,
 * so a part told to sit inside the shell actually stays inside it.
 */
function block(x: P2, y: P2, depth: number, zc = 0, r = 0): THREE.BufferGeometry {
  if (r <= 0) {
    return new THREE.BoxGeometry(x[1] - x[0], y[1] - y[0], depth).translate(
      (x[0] + x[1]) / 2, (y[0] + y[1]) / 2, zc);
  }
  const bev = depth * 0.14;
  const g = new THREE.ExtrudeGeometry(roundedRect(x[0], y[0], x[1], y[1], r), {
    depth: depth - 2 * bev,
    bevelEnabled: true,
    bevelSegments: 2,
    bevelThickness: bev,
    bevelSize: bev,
    bevelOffset: -bev,
    curveSegments: 6,
  });
  g.translate(0, 0, zc - depth / 2 + bev);
  return g;
}

function cyl(x: P2, cy: number, r: number, radial = 28): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, x[1] - x[0], radial, 1, false);
  g.rotateZ(Math.PI / 2);
  g.translate((x[0] + x[1]) / 2, cy, 0);
  return g;
}

// ---------------------------------------------------------------- cross-sections
//
// Each of these is the part's half-thickness as a function of position on the trace. They
// are the whole reason the build is not a stack of flat plates, so they are kept together
// and each term names the Glock feature it models.

const T = geo.thickness;
const F = geo.features;
const I = geo.internals;

/** Sight base: the traced slide outline is clipped here and the sights rebuilt above it. */
const SLIDE_TOP = F.rearSight.base;

const slideHalf: WidthFn = (x, y) => {
  let h = T.slide / 2;
  // The deck chamfers in from the flats over the top ~2 mm — the single most recognisable
  // thing about a Glock slide in cross-section, and what a plain extrusion throws away.
  // Sized off the broadside reference, not off a guess: a 5 mm band tilted enough of the
  // slide's rear face toward the key to put that zone +23 luma over the reference, where a
  // real Glock's top-edge break is closer to 1.5 mm.
  h *= mix(1, 0.84, sstep(SLIDE_TOP - 0.030, SLIDE_TOP, y));
  // Rails at the very bottom sit inboard of the flats.
  h *= mix(1, 0.90, sstep(0.74, 0.68, y));
  // Muzzle nose and breech-end radii.
  h *= mix(1, 0.95, sstep(1.5, 1.71, x));
  h *= mix(1, 0.96, sstep(-1.55, -1.69, x));
  return h;
};

/** Bounding box of the traced trigger-guard opening, used to slim the bow around it. */
const GUARD = (geo.parts.frame.holes[0] as number[][]).reduce(
  (b, [x, y]) => ({
    x0: Math.min(b.x0, x), x1: Math.max(b.x1, x),
    y0: Math.min(b.y0, y), y1: Math.max(b.y1, y),
  }),
  { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity },
);

const GP = F.gripPanel;

const frameHalf: WidthFn = (x, y) => {
  // Along the gun: the receiver tapers from the grip section down to the dust cover.
  let h = mix(0.196, 0.176, sstep(-0.55, 0.1, x));
  h = mix(h, 0.152, sstep(0.1, 0.95, x));
  h = mix(h, 0.142, sstep(0.95, 1.71, x));

  // The trigger-guard bow is a slender loop, not a full-width slab. Distance to the traced
  // opening, gated so the receiver ABOVE the guard keeps its width.
  const dx = Math.max(GUARD.x0 - x, x - GUARD.x1, 0);
  const dy = Math.max(GUARD.y0 - y, y - GUARD.y1, 0);
  // Same lesson as the slide deck, and the measurement is of the SLOPE, not the depth: at a
  // 58% waist over an 18 mm ramp the bow read +19 luma against the reference's flat bar, and
  // halving the ramp (a steeper slope for a shallower waist) took it to +54. The reference
  // will carry a slim bow only if the shoulder into it is gentle.
  const bow = (1 - sstep(0.02, 0.34, Math.hypot(dx, dy))) * sstep(GUARD.y1 + 0.06, GUARD.y1 - 0.04, y);
  h = mix(h, 0.158, bow);

  // Palm swell. This and the plateau below replace the two proud side plates the earlier
  // build bolted on: those detached into floating planes the moment the model was exploded,
  // and their inner faces double-imaged "GHOST"/"PROTOCOL" through the frame behind them.
  const s = 1 - sq((x + 0.95) / 0.46) - sq((y + 0.02) / 0.74);
  if (s > 0) h += 0.034 * Math.sqrt(s);

  // Raised grip panel: a rounded-rect plateau, the border both references show.
  const px0 = Math.max(GP.x[0] + GP.cornerR - x, x - (GP.x[1] - GP.cornerR), 0);
  const py0 = Math.max(GP.y[0] + GP.cornerR - y, y - (GP.y[1] - GP.cornerR), 0);
  h += 0.015 * (1 - sstep(GP.cornerR * 0.35, GP.cornerR, Math.hypot(px0, py0)));
  return h;
};

/** The trigger shoe is a curved blade, thickest through the middle of the face. */
const triggerHalf: WidthFn = (_x, y) =>
  (T.trigger / 2) * mix(1, 1.5, Math.max(0, 1 - sq((y - 0.16) / 0.26)));

/** Slide side-wall thickness, ~3.7 mm at the traced scale. */
const SLIDE_WALL = px(30);

const magHalf: WidthFn = (_x, y) => {
  let h = T.magazine / 2;
  h *= mix(1, 1.07, sstep(-1.0, -1.11, y)); // floorplate flare
  h *= mix(1, 0.93, sstep(-0.82, -0.71, y)); // tucks up into the magwell
  return h;
};

// ---------------------------------------------------------------- textures & materials

const loader = new THREE.TextureLoader();

function tex(url: string, srgb: boolean): THREE.Texture {
  const t = loader.load(url);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 16;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

interface Maps {
  front: THREE.Texture;
  back: THREE.Texture;
  rough: THREE.Texture;
  metal: THREE.Texture;
  ao: THREE.Texture;
  normal: THREE.Texture;
}

function loadMaps(): Maps {
  return {
    front: tex(frontAlbedoUrl, true),
    back: tex(backAlbedoUrl, true),
    rough: tex(roughnessUrl, false),
    metal: tex(metalnessUrl, false),
    ao: tex(aoUrl, false),
    normal: tex(normalUrl, false),
  };
}

/**
 * Translucent-polymer face material. `transmission` is deliberately partial: the reference
 * shows the internals as a tinted ghost under the paint, not clear glass, and the projected
 * decals must survive. The albedo tints the transmitted lobe too, so the trace bundles keep
 * their colour where the shell goes see-through.
 */
function polymerFace(m: Maps, side: 'front' | 'back', o: { transmission: number; thickness: number }) {
  return new THREE.MeshPhysicalMaterial({
    map: side === 'front' ? m.front : m.back,
    roughnessMap: m.rough,
    metalnessMap: m.metal,
    aoMap: m.ao,
    aoMapIntensity: 0.65,
    normalMap: m.normal,
    // 0.42, not 0.85: the broadside review view barely shows the normal map, but as soon as the
    // demo rocks off-axis the micro-stipple and the grip stria read at a grazing angle and the
    // polymer turned into coarse leather. Solved at the rocked extreme, not at the flat view.
    normalScale: new THREE.Vector2(0.42, 0.42),
    roughness: 1.0, // scalar x map; both maps carry the authored per-pixel values
    metalness: 1.0,
    // clearcoat solved against the FRONT reference at the fixed review view: 0.62 washed a
    // specular veil over every zone (+13..+19 counts of red above the reference). At 0.40 the
    // FRONT mean lands at [69.8, 26.0, 32.1] against the reference's [74.6, 24.8, 30.7].
    clearcoat: 0.4,
    clearcoatRoughness: 0.22,
    transmission: o.transmission,
    thickness: o.thickness,
    ior: 1.52, // injection-moulded polymer
    attenuationColor: new THREE.Color(0x4a0710),
    attenuationDistance: 0.55,
    specularIntensity: 1.0,
  });
}

/**
 * Rolled rim. Neither view resolves the edge band, so it is authored, not projected — and
 * it is authored DARK: in both references the silhouette edge falls away to near-black, so
 * a bright rim would draw a glowing outline round the whole gun that the references do not have.
 */
function polymerRim(o: { transmission: number; thickness: number }) {
  return new THREE.MeshPhysicalMaterial({
    color: 0x2c060c,
    roughness: 0.56,
    metalness: 0.0,
    // The loft gives the rim real width where the section is slim, so it is now most of what
    // the trigger-guard bow shows: at the old 0x3a0710 the bow measured +15 luma over the
    // reference while the broad faces sat within 3.
    envMapIntensity: 0.6,
    // Duller than the faces on purpose: at clearcoat 0.4 the rolled rim blew out to a white
    // outline round the whole silhouette, where the references show a thin dark-red edge.
    clearcoat: 0.2,
    clearcoatRoughness: 0.5,
    transmission: o.transmission * 0.45,
    thickness: o.thickness,
    ior: 1.52,
    attenuationColor: new THREE.Color(0x330509),
    attenuationDistance: 0.28,
  });
}

/**
 * Safe Action trigger polymer. Deliberately its OWN material, not the black polymer the sights
 * and the cyber module share and not the translucent crimson of the frame: on the real item the
 * trigger group is a matte grey injection moulding, and giving it the frame's response was what
 * made the shoe read as an extrusion of the frame rather than a part dropped into it.
 */
const triggerPolymer = () =>
  new THREE.MeshPhysicalMaterial({ color: 0x35383d, roughness: 0.7, metalness: 0.1 });

const blackPolymer = () =>
  new THREE.MeshPhysicalMaterial({ color: 0x0a0a0d, roughness: 0.44, metalness: 0.05, clearcoat: 0.4, clearcoatRoughness: 0.22 });

/**
 * Surface hardware (extractor, slide stop, magazine catch) sits at the same XY as the
 * reference's own pixels, so it takes the FRONT projection through the shared planar UV
 * and is merely darkened. Painting these as flat black slabs instead reads as stickers
 * pasted over the reference art — it hides the knurling and the cast shadow the photo has.
 */
function hardwareFace(m: Maps, tint: number) {
  return new THREE.MeshPhysicalMaterial({
    map: m.front,
    color: new THREE.Color(tint),
    roughnessMap: m.rough,
    normalMap: m.normal,
    normalScale: new THREE.Vector2(0.5, 0.5),
    roughness: 1.0,
    metalness: 0.08,
    clearcoat: 0.4,
    clearcoatRoughness: 0.26,
  });
}

// Solved against the reference's ejection port, which reads [68, 77, 94] — cool, dark and
// blue-biased. Chrome (0xd2d7df) measured +61 luma there and 0x6b7079 still +29: the visible
// mechanism is phosphated and nitrided, not polished.
const steel = () =>
  new THREE.MeshPhysicalMaterial({ color: 0x3d454f, roughness: 0.46, metalness: 1.0 });
/** Every internal part shares this: matte dark mechanism, never a bright slab. */
const gunmetal = () =>
  new THREE.MeshPhysicalMaterial({ color: 0x3c4046, roughness: 0.42, metalness: 0.85 });

// ---------------------------------------------------------------- internals

/**
 * The barrel as a real solid of revolution: chamber swell at the breech, taper into the
 * shank, a stepped muzzle and a bore lathed back up the inside. A constant-radius cylinder
 * has no chamber and no hole, and read as a pipe floating under the slide.
 */
function barrelGeometry(): THREE.BufferGeometry {
  const b = I.barrel;
  const L = b.x[1] - b.x[0];
  const R = b.r;
  const profile: P2[] = [
    [0.0, 0.0], [0.0, R * 1.18],           // breech face
    [0.3, R * 1.18], [0.4, R],             // chamber, then the taper into the shank
    [L - 0.22, R], [L - 0.17, R * 0.93],
    [L, R * 0.93], [L, R * 0.58],          // muzzle crown
    [L - 0.05, R * 0.54], [0.44, R * 0.54], // bore, back up the inside
    [0.34, R * 0.66], [0.02, R * 0.66],    // chamber mouth
    [0.02, 0.0],
  ];
  const g = new THREE.LatheGeometry(profile.map(([a, r]) => new THREE.Vector2(r, a)), 32);
  g.rotateZ(-Math.PI / 2); // lathe spins about +Y; the bore axis is +X
  g.translate(b.x[0], b.cy, 0);
  return g;
}

/**
 * Recoil-assembly axis. The traced barrel leaves only ~17 mm of slide below it, so the coil
 * radius is bounded by that gap rather than by the published spring — noted as an inference.
 */
const RECOIL_CY = I.recoilRod.cy - px(10);
const COIL_R = px(15);

/** Recoil spring: a real coil swept along a helix, not a smooth rod. */
function springGeometry(): THREE.BufferGeometry {
  const rr = I.recoilRod;
  const turns = 21;
  const seg = turns * 14;
  const x0 = rr.x[0] + 0.1;
  const span = rr.x[1] - rr.x[0] - 0.22;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= seg; i++) {
    const u = i / seg;
    const a = u * turns * Math.PI * 2;
    pts.push(new THREE.Vector3(x0 + u * span, RECOIL_CY + Math.sin(a) * COIL_R, Math.cos(a) * COIL_R));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), seg, px(6), 6, false);
}

// ---------------------------------------------------------------- build

export function createGlockGhostProtocolModel(o: GlockGhostProtocolOptions = {}): THREE.Group {
  const shadows = o.shadows ?? true;
  const transmission = o.transmission ?? 0.3;
  const m = loadMaps();
  const root = new THREE.Group();
  root.name = 'glock18-ghost-protocol';
  const nodes: Record<string, THREE.Object3D> = {};

  const add = (parent: THREE.Object3D, name: string, g: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[]) => {
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = name;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    parent.add(mesh);
    nodes[name] = mesh;
    return mesh;
  };

  /** Marks a mesh as part of the shell it hangs off, so the explode moves it with its parent. */
  const integral = <T extends THREE.Object3D>(o: T): T => {
    o.userData.explodeWithParent = true;
    return o;
  };

  /** A projected shell part: front face, back face and rim as three material slots. */
  const shell = (
    parent: THREE.Object3D, name: string, shape: THREE.Shape,
    half: WidthFn, nominal: number, holeRollAt?: WidthFn,
    openWall?: (x: number, y: number) => boolean,
  ) => {
    const opt = { transmission, thickness: nominal };
    const roll: WidthFn = (x, y) => half(x, y) * geo.chamfer.shellRollFrac;
    const g = lofted(shape, sym(half), roll, holeRollAt, 2, openWall);
    return add(parent, name, g, [
      polymerFace(m, 'front', opt),
      polymerFace(m, 'back', opt),
      polymerRim(opt),
    ]);
  };

  /**
   * Vertical ribs standing proud of both broad faces. Serrations and grip stria existed only
   * in the normal map before; at a grazing angle a normal map has no silhouette, so the
   * surface went smooth exactly where the reference shows the deepest relief. They share the
   * face materials and the planar UV, so the projection runs across them unbroken.
   */
  const ribs = (
    parent: THREE.Object3D, name: string,
    band: { x: number[]; y: number[]; count: number },
    half: WidthFn, proud: number, mats: THREE.Material[],
  ) => {

    const g = new THREE.Group();
    g.name = name;
    const w = (band.x[1] - band.x[0]) / (band.count * 2 - 1); // rib and gap are equal
    const cy = (band.y[0] + band.y[1]) / 2;
    for (let i = 0; i < band.count; i++) {
      const x0 = band.x[0] + i * 2 * w;
      for (const s of [0, 1]) {
        const bg = block([x0, x0 + w], [band.y[0], band.y[1]], proud * 2,
          (s ? 1 : -1) * half(x0 + w / 2, cy), w * 0.34);
        planarUV(bg);
        const mesh = new THREE.Mesh(bg, mats[s]);
        mesh.castShadow = shadows;
        // Named so a raycast hit reports which rib it landed on rather than an anonymous mesh.
        mesh.name = `${name}_${String(i).padStart(2, '0')}${s ? 'f' : 'b'}`;
        // Surface relief on the shell, not a part of the assembly: it must travel with the
        // shell when the model is exploded instead of scattering as a comb of loose slivers,
        // and a click on one rib must resolve up to the comb, not select a single sliver.
        mesh.userData.explodeWithParent = true;
        g.add(mesh);
      }
    }
    parent.add(g);
    nodes[name] = g;
    return g;
  };

  // Ribs are proud and curved, so they catch far more key and environment than the flat face
  // they sit on, and the AO channel was baked before they existed — it has no groove shadow to
  // give them. Pulling the coat and the environment back stands in for that missing occlusion:
  // with them at full strength the rear-serration zone measured +23 luma over the reference.
  const ribMats = (['back', 'front'] as const).map((side) => {
    const mm = polymerFace(m, side, { transmission: 0, thickness: 0 });
    mm.clearcoat = 0.16;
    mm.clearcoatRoughness = 0.42;
    mm.envMapIntensity = 0.45;
    return mm;
  });

  const projectedHardware = (parent: THREE.Object3D, name: string, g: THREE.BufferGeometry, tint: number) => {
    planarUV(g);
    return add(parent, name, g, hardwareFace(m, tint));
  };

  // ---- slide assembly (its own group: it is the moving part) ----
  const slideGrp = new THREE.Group();
  slideGrp.name = 'slideAssembly';
  root.add(slideGrp);

  const ep = F.ejectionPort;
  // The port is a genuine cut through the slide, not a dark rectangle painted on it. Its
  // hole ring takes NO roll so the traced opening survives to full depth, and so the floor
  // plug below can seal the -Z side exactly.
  const slideShape = shapeFrom(clipTop(geo.parts.slide.outline, SLIDE_TOP));
  slideShape.holes.push(pathOf(roundedRect(ep.x[0], ep.y[0], ep.x[1], ep.y[1], ep.cornerR)));
  // The slide's traced underside is one full-length edge, so dropping that wall turns the
  // slide into the U-channel it actually is: open along the bottom, closed by the deck above.
  // Before this the slide was a solid billet the barrel simply intersected — it could not have
  // been assembled, which is exactly the objection raised against the previous pass.
  const slideMesh = shell(slideGrp, 'slide', slideShape, slideHalf, T.slide, () => 0,
    // Bottom: the U-channel. Nose: the barrel has to come OUT somewhere. Without this the slide's
    // muzzle-end wall capped the bore — exploded you could see straight down the barrel, assembled
    // the slide's solid nose sealed it, which is exactly the defect reported.
    (x, y) => y < 0.69 || (x > 1.7 && y > 0.7 && y < 0.95));

  // Interior of that channel. Rendered back-faces-only so it is invisible from outside and
  // only shows when you look up into the slide: the raceway the barrel and recoil assembly
  // ride in. Its outer surface stops SLIDE_WALL short of the flats, which IS the side-wall
  // thickness, and the two rails below close the remaining gap at the mouth.
  const raceway = lofted(
    roundedRect(wx(160), 0.655, wx(1852), 0.995, px(16)),
    sym((x, y) => Math.max(px(10), slideHalf(x, y) - SLIDE_WALL)),
    () => px(6), () => px(6), 1,
  );
  // Parented to the slide and flagged: the raceway and its rails are the slide's own inner
  // surface, so they must travel with it. Exploded as free parts they read as a stray bar.
  // Mid-grey nitrided interior. NOT the reason the ejection-port zone sits at -16 luma: opening
  // the slide's underside moved that zone from -10 to -16, and swapping this from near-black to
  // mid-grey moved it by 0.1, so the cause is the open wall changing what the transmission pass
  // sees through the slide, not the colour of the channel behind the port.
  integral(add(slideMesh, 'slideRaceway', raceway,
    new THREE.MeshPhysicalMaterial({ color: 0x3a4149, roughness: 0.5, metalness: 0.8, side: THREE.BackSide })));
  // Muzzle face: closes the nose opening back up EXCEPT for a round bore the barrel passes
  // through, which is what the front of a slide actually is.
  const noseH = slideHalf(1.705, 0.83);
  const noseShape = roundedRect(-noseH, 0.665, noseH, 0.975, px(22));
  const boreHole = new THREE.Path();
  boreHole.absarc(0, I.barrel.cy, I.barrel.r * 0.96, 0, Math.PI * 2, true);
  noseShape.holes.push(boreHole);
  const noseGeo = new THREE.ExtrudeGeometry(noseShape, { depth: px(26), bevelEnabled: false, curveSegments: 24 });
  noseGeo.rotateY(Math.PI / 2); // built in (z, y); swing the extrusion axis onto +X
  noseGeo.translate(1.708 - px(26), 0, 0);
  planarUV(noseGeo);
  integral(add(slideMesh, 'muzzleFace', noseGeo, polymerRim({ transmission, thickness: T.slide })));

  // Slide rails: the inward ledges the frame rides on, and the reason the mouth is narrower
  // than the raceway is wide.
  for (const sgn of [1, -1]) {
    const g = block([wx(210), wx(1800)], [0.68, 0.68 + px(26)], SLIDE_WALL,
      sgn * (slideHalf(wx(900), 0.7) - SLIDE_WALL / 2), px(5));
    const mesh = new THREE.Mesh(g, gunmetal());
    mesh.name = sgn > 0 ? 'slideRailFront' : 'slideRailBack';
    mesh.castShadow = shadows;
    slideMesh.add(mesh);
    nodes[mesh.name] = integral(mesh);
  }

  // Left inner wall: plugs the port on the -Z side, exactly where the BACK reference shows
  // unbroken slide, and gives the cut a floor to cast into instead of a hole through the gun.
  const floorMat = new THREE.MeshPhysicalMaterial({ color: 0x14161a, roughness: 0.55, metalness: 0.7 });
  const portFloor = lofted(
    roundedRect(ep.x[0], ep.y[0], ep.x[1], ep.y[1], ep.cornerR),
    (x, y, t) => -slideHalf(x, y) + ((t + 1) / 2) * 0.078,
    () => 0, () => 0, 0,
  );
  integral(add(slideMesh, 'portFloor', portFloor, [
    floorMat,
    polymerFace(m, 'back', { transmission, thickness: T.slide }),
    floorMat,
  ]));

  // Steel breech face at the rear of the port — what a chambered round headspaces against.
  add(slideGrp, 'breechFace',
    block([ep.x[0] - px(4), ep.x[0] + px(52)], [I.breechFace.y[0], ep.y[1] - px(4)],
      T.slide * 0.6, 0, px(12)),
    steel());
  add(slideGrp, 'breechBody',
    block([I.breechFace.x[0] - px(40), I.breechFace.x[0] + px(48)],
      [wy(220), I.breechFace.y[1] - px(20)],
      T.slide * 0.72, 0),
    gunmetal());
  // Striker running back from the breech face through the rear of the slide, so the
  // translucent rear reads as mechanism instead of an empty red shell.
  add(slideGrp, 'striker', cyl([wx(240), ep.x[0] + px(10)], wy(190), px(22), 18), gunmetal());
  add(slideGrp, 'strikerCollar', cyl([wx(560), wx(640)], wy(190), px(30), 18), steel());

  projectedHardware(slideGrp, 'extractor',
    block(F.extractor.x as P2, F.extractor.y as P2, px(16), slideHalf(F.extractor.x[1], F.extractor.y[0]) - px(6), px(8)),
    0xb4b4bc);

  // ---- sights (the traced outline is clipped at the sight base and these rebuilt on top) ----
  const rs = F.rearSight;
  const rsHalf = px(60);
  const notch = px(18);
  const sightGrp = new THREE.Group();
  sightGrp.name = 'rearSight';
  const rsMat = blackPolymer();
  // Base bar plus two wings: the gap between the wings IS the sight notch, the thing you
  // aim through. A single rounded box has no notch and reads as a lump.
  // The three pieces are one sight, so they are flagged integral: the explode lifts the sight
  // off the slide whole, and a click anywhere on it selects 'rearSight' rather than one wing.
  sightGrp.add(integral(new THREE.Mesh(
    block([rs.x[0], rs.x[1]], [rs.base - px(6), rs.top - px(16)], rsHalf * 2, 0, px(4)), rsMat)));
  for (const s of [1, -1]) {
    sightGrp.add(integral(new THREE.Mesh(
      new THREE.BoxGeometry(rs.x[1] - rs.x[0], px(16), rsHalf - notch)
        .translate((rs.x[0] + rs.x[1]) / 2, rs.top - px(8), s * (rsHalf + notch) / 2), rsMat)));
  }
  slideGrp.add(sightGrp);
  nodes.rearSight = sightGrp;

  const fs = F.frontSight;
  const fsHalf = px(22);
  const fsGrp = new THREE.Group();
  fsGrp.name = 'frontSight';
  fsGrp.add(integral(new THREE.Mesh(
    block([fs.x[0], fs.x[1]], [fs.base - px(6), fs.top], fsHalf * 2, 0, px(3)), rsMat)));
  // The white aiming dot on the rear-facing flat, the one detail that identifies the post.
  const dot = integral(new THREE.Mesh(
    cyl([fs.x[0] - px(3), fs.x[0] + px(1)] as P2, (fs.base + fs.top) / 2, px(9), 14),
    new THREE.MeshPhysicalMaterial({ color: 0xf2f4f0, roughness: 0.35, metalness: 0.0 })));
  fsGrp.add(dot);
  slideGrp.add(fsGrp);
  nodes.frontSight = fsGrp;

  // ---- barrel & recoil assembly ----
  add(slideGrp, 'barrel', barrelGeometry(), steel());
  // The hood: the rectangular tang on top of the chamber that locks up into the port. It is
  // what visually ties the barrel to the slide instead of leaving it a cylinder in mid-air.
  add(slideGrp, 'barrelHood',
    block([I.barrel.x[0] - px(6), I.barrel.x[0] + px(150)],
      [I.barrel.cy, I.barrel.cy + I.barrel.r * 1.15], I.barrel.r * 1.5, 0, px(8)),
    steel());
  add(slideGrp, 'lockingLug',
    block([I.barrel.x[0] + px(220), I.barrel.x[0] + px(400)],
      [I.barrel.cy - I.barrel.r * 1.5, I.barrel.cy - I.barrel.r * 0.7], I.barrel.r * 1.2, 0, px(6)),
    gunmetal());
  add(slideGrp, 'recoilRod', cyl(I.recoilRod.x as P2, RECOIL_CY, px(9), 18), steel());
  add(slideGrp, 'recoilSpring', springGeometry(), gunmetal());

  ribs(slideMesh, 'rearSerrations', F.rearSerrations, slideHalf, px(4), ribMats);
  ribs(slideMesh, 'frontSerrations', F.frontSerrations, slideHalf, px(4), ribMats);

  // ---- frame ----
  // NOT given a cut magwell, deliberately. The mechanism exists (see the slide raceway) and the
  // grip's traced base is a single edge that would open cleanly, but the cavity's inner surface
  // has to stay contained inside a translucent shell whose thickness varies, and it does not:
  // rendered back-faces-only it still ghosts through the grip as a grey slab. The magazine tube
  // already occupies the magwell volume and reads correctly through the polymer, and the mouth
  // is only ever seen from directly underneath, which no framing in this demo uses.
  const frameMesh = shell(root, 'frame', shapeFrom(geo.parts.frame.outline, geo.parts.frame.holes),
    frameHalf, T.frame);
  ribs(frameMesh, 'gripSerrations', F.gripSerrations, frameHalf, px(4), ribMats);

  // ---- magazine ----
  const magGrp = new THREE.Group();
  magGrp.name = 'magazineAssembly';
  root.add(magGrp);
  const magMesh = shell(magGrp, 'magazine', shapeFrom(geo.parts.magazine.outline), magHalf, T.magazine);
  ribs(magMesh, 'magSerrations', F.magSerrations, magHalf, px(4), ribMats);

  // The magazine tube running up inside the grip, with the parts that make it a magazine:
  // feed lips at the mouth and a follower under them. The floorplate is modelled by the
  // flare in `magHalf` rather than a separate mesh — a plate laid over the extension would
  // cover the projected skin art the reference paints there.
  // y is [min, max]: passing [top, bottom] here built a negative-height box, i.e. an
  // inside-out magazine body with flipped normals.
  // A rounded, spined tube rather than a plain billet: exploded, a featureless grey box the
  // length of the grip was the single most artificial-looking part in the assembly.
  add(magGrp, 'magBody',
    block([wx(470), wx(650)], [wy(980), I.magBody.top - px(40)], T.magazine * 0.56, 0, px(18)),
    gunmetal());
  add(magGrp, 'magSpine',
    block([wx(470), wx(496)], [wy(970), I.magBody.top - px(50)], T.magazine * 0.42, 0, px(8)),
    steel());
  for (const s of [1, -1]) {
    const lip = block([wx(470), wx(650)], [I.magBody.top - px(44), I.magBody.top],
      T.magazine * 0.1, s * T.magazine * 0.25, px(5));
    const mesh = new THREE.Mesh(lip, steel());
    mesh.name = s > 0 ? 'feedLipFront' : 'feedLipBack';
    magGrp.add(mesh);
    nodes[mesh.name] = mesh;
  }
  add(magGrp, 'follower',
    block([wx(486), wx(634)], [I.magBody.top - px(110), I.magBody.top - px(46)],
      T.magazine * 0.44, 0, px(8)),
    new THREE.MeshPhysicalMaterial({ color: 0xc2571c, roughness: 0.55, metalness: 0.0 }));

  // ---- trigger group (its own pivot: the shoe swings about the trigger pin) ----
  const trigGrp = new THREE.Group();
  trigGrp.name = 'triggerPivot';
  trigGrp.position.set(F.triggerPin.cx, F.triggerPin.cy, 0);
  root.add(trigGrp);
  // Safe Action, as two intersecting components rather than one monolith: the shoe is a curved
  // blade with a vertical SLOT cut clean through it, and the trigger safety is a separate lever
  // living in that slot. The slot walls are visible from either side, so the two parts read as
  // two parts even before the model is taken apart.
  const ts = F.triggerSafety;
  const SLOT = { x0: ts.x[0], x1: ts.x[1], y0: 0.006, y1: 0.344 };
  const shoeShape = shapeFrom(geo.parts.trigger.outline);
  shoeShape.holes.push(pathOf(roundedRect(SLOT.x0, SLOT.y0, SLOT.x1, SLOT.y1, px(9))));
  const trigGeo = lofted(shoeShape, sym(triggerHalf), (x, y) => triggerHalf(x, y) * 0.4, () => 0);
  trigGeo.translate(-F.triggerPin.cx, -F.triggerPin.cy, 0);
  const shoe = add(trigGrp, 'trigger', trigGeo, triggerPolymer());

  // The lever itself. Thin and recessed where it pivots at the top, swelling past the shoe's
  // own faces at the tip — on a Glock that lower tip is the part your finger actually depresses,
  // and it is the only part of the blade that stands proud.
  const bladeHalf: WidthFn = (x, y) => triggerHalf(x, y) * mix(0.5, 1.22, sstep(0.30, 0.03, y));
  const bladeGeo = lofted(
    roundedRect(SLOT.x0 + px(3), SLOT.y0 + px(3), SLOT.x1 - px(3), SLOT.y1 - px(3), px(7)),
    sym(bladeHalf), (x, y) => bladeHalf(x, y) * 0.35, undefined, 1);
  bladeGeo.translate(-F.triggerPin.cx, -F.triggerPin.cy, 0);
  integral(add(shoe, 'triggerSafety', bladeGeo, triggerPolymer()));

  // Trigger bar and connector: the linkage that makes the shoe part of a mechanism rather than
  // a shape suspended inside the guard. Stamped steel on a real Glock, so they keep the metal
  // material — the matte polymer is for the shoe and the blade only. Both hang off the shoe and
  // are flagged integral, so disassembly lifts the whole fire-control module out of the frame
  // as one piece instead of scattering three parts across the trigger guard.
  const barMat = gunmetal();
  integral(add(shoe, 'triggerBar',
    block([wx(700) - F.triggerPin.cx, wx(960) - F.triggerPin.cx],
      [wy(390) - F.triggerPin.cy, wy(350) - F.triggerPin.cy], px(24), -px(28), px(6)),
    barMat));
  integral(add(shoe, 'connector',
    block([wx(620) - F.triggerPin.cx, wx(720) - F.triggerPin.cx],
      [wy(410) - F.triggerPin.cy, wy(270) - F.triggerPin.cy], px(20), -px(28), px(5)),
    barMat));

  // ---- frame hardware ----
  for (const id of ['triggerPin', 'lockingBlockPin'] as const) {
    const p = F[id];
    const g = new THREE.CylinderGeometry(p.r, p.r, frameHalf(p.cx, p.cy) * 2 + px(6), 20);
    g.rotateX(Math.PI / 2);
    g.translate(p.cx, p.cy, 0);
    add(root, id, g, gunmetal());
  }
  // Both levers stand slightly PROUD of the frame's +Z face — they are external controls, and the
  // FRONT reference shows their cast shadow on the frame.
  projectedHardware(root, 'slideStop',
    block(F.slideStop.x as P2, F.slideStop.y as P2, px(14),
      frameHalf(F.slideStop.x[0], F.slideStop.y[0]) + px(3), px(12)), 0xb0b4bc);
  // The catch is a shallow relief, not a tab: at px(5) proud its side walls caught the key and
  // read as a pale slab sticking out of the frame's front edge.
  projectedHardware(root, 'magRelease',
    block([F.magRelease.x[0] + px(16), F.magRelease.x[1] - px(2)],
      [F.magRelease.y[0] + px(6), F.magRelease.y[1] - px(6)],
      px(9), frameHalf(F.magRelease.x[0], F.magRelease.y[0]) + px(1), px(8)), 0x9096a0);

  // ---- the cybernetic module the references show through the translucent frame ----
  const cm = F.cyberModule;
  add(root, 'cyberModule', block(cm.barX as P2, cm.barY as P2, px(34), 0, px(5)), blackPolymer());
  const ribbon = new THREE.MeshPhysicalMaterial({
    color: 0x1a1a20, roughness: 0.5, metalness: 0.2,
    emissive: new THREE.Color(0xff6a1e), emissiveIntensity: 0.55,
  });
  const ribbonDark = blackPolymer();
  const rGrp = new THREE.Group();
  rGrp.name = 'ribbonCables';
  const rows = 7;
  for (let i = 0; i < rows; i++) {
    const y = cm.y[0] + ((i + 0.5) / rows) * (cm.y[1] - cm.y[0]);
    const g = new THREE.BoxGeometry(cm.x[1] - cm.x[0], px(4), px(20));
    g.translate((cm.x[0] + cm.x[1]) / 2, y, 0);
    const cable = new THREE.Mesh(g, i % 2 ? ribbon : ribbonDark);
    cable.name = `ribbonCable_${String(i).padStart(2, '0')}`;
    // One loom, not seven parts: integral so it explodes and selects as `ribbonCables`.
    rGrp.add(integral(cable));
  }
  root.add(rGrp);
  nodes.ribbonCables = rGrp;

  // ---- action-ready runtime ----
  const bbox = new THREE.Box3().setFromObject(root);
  root.userData.sculptRuntime = {
    nodes,
    pivots: { trigger: trigGrp, slide: slideGrp, magazine: magGrp },
    sockets: {
      muzzle: new THREE.Vector3(wx(1856), I.barrel.cy, 0),
      grip: new THREE.Vector3(wx(450), wy(620), 0),
      accessoryRail: new THREE.Vector3(wx(1676), wy(372), 0),
      magWell: new THREE.Vector3(wx(430), wy(930), 0),
      ejectionPort: new THREE.Vector3(wx(1012), wy(86), T.slide / 2),
    },
    colliders: [{ type: 'box', min: bbox.min.clone(), max: bbox.max.clone() }],
    destructionGroups: {
      slide: ['slide', 'slideRaceway', 'muzzleFace', 'slideRailFront', 'slideRailBack',
        'portFloor', 'breechFace', 'breechBody', 'striker', 'strikerCollar',
        'extractor', 'rearSight', 'frontSight', 'rearSerrations', 'frontSerrations',
        'barrel', 'barrelHood', 'lockingLug', 'recoilRod', 'recoilSpring'],
      frame: ['frame', 'gripSerrations', 'slideStop', 'magRelease', 'triggerPin', 'lockingBlockPin'],
      magazine: ['magazine', 'magSerrations', 'magBody', 'magSpine', 'feedLipFront',
        'feedLipBack', 'follower'],
      fireControl: ['trigger', 'triggerSafety', 'triggerBar', 'connector', 'cyberModule', 'ribbonCables'],
    },
    provenance: {
      route: 'reference-projection',
      exactnessTier: 'image-only',
      familyAdapter: 'pistol/glock-18',
      thicknessConfidence: T.confidence,
      inferred: ['z-thickness and every cross-section profile', 'barrel & recoil-rod depth',
        'magazine internals', 'trigger linkage', 'rim colour'],
    },
  };
  return root;
}

// ---------------------------------------------------------------- look-dev

/**
 * Three-point rig for a broadside hero framing, cool-biased so the crimson polymer keeps
 * its hue instead of going orange. Routed through DemoEntry.installLights so the Viewer
 * skips its default studio rig (two rigs stacked blow the clearcoat out to white).
 */
export function createGlockGhostProtocolLookDevLights(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'glockGhostProtocolLights';

  const key = new THREE.DirectionalLight(0xfff2ee, 2.35);
  key.position.set(1.9, 3.4, 4.6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 14;
  key.shadow.bias = -0.0006;
  g.add(key);

  const fill = new THREE.DirectionalLight(0x7aa8ff, 0.58);
  fill.position.set(-3.4, 0.8, 3.0);
  g.add(fill);

  // The item is a two-sided broadside object and BOTH faces carry a reference projection,
  // so the -Z side gets its own mirrored key/fill. With only a warm back-kick the BACK view
  // measured 19..33 counts of luma below its reference and lost half its green.
  // A light behind the object contributes nothing to the +Z faces, so this pair does not
  // disturb the FRONT match that the key/fill were solved against.
  const backKey = new THREE.DirectionalLight(0xfff4f0, 3.05);
  backKey.position.set(-1.9, 3.4, -4.6);
  g.add(backKey);

  const backFill = new THREE.DirectionalLight(0x7aa8ff, 0.78);
  backFill.position.set(3.4, 0.8, -3.0);
  g.add(backFill);

  // Low warm kicker that grazes the rolled rim; kept weak so it does not red-shift the
  // -Z face away from the BACK reference's cooler magenta-grey slide.
  const kick = new THREE.DirectionalLight(0xff5f6d, 0.62);
  kick.position.set(-1.2, -1.9, -3.2);
  g.add(kick);

  g.add(new THREE.AmbientLight(0x24202a, 0.26));
  return g;
}

/** Dark radial stage; matches the references' near-black backdrop. */
export function makeGhostProtocolBackground(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const ctx = cv.getContext('2d')!;
  const grd = ctx.createRadialGradient(256, 232, 24, 256, 256, 340);
  grd.addColorStop(0, '#241017');
  grd.addColorStop(0.55, '#12080c');
  grd.addColorStop(1, '#070507');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}
