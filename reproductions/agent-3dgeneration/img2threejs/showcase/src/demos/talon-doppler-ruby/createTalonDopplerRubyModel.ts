/**
 * ★ Talon Knife | Doppler Ruby (Factory New)
 *
 * Built by the img2threejs pipeline from two broadside references (front + back). Geometry is
 * TRACED, not eyeballed: `geo.json` carries world-space outlines converted through one fixed
 * image->world mapping, so the render can be compared to the reference without a framing excuse.
 *
 * Reconstruction decisions worth knowing when reading this file:
 *
 *  - The steel is ONE body: hawkbill blade -> tang -> closed finger ring. A Talon has NO
 *    crossguard and no bolster, so none is modelled (the generic CS2 knife adapter seeds both).
 *  - The blade is a VARIABLE-THICKNESS LOFT, not an extrude. A constant-thickness extrude has
 *    2 distinct Z planes and reads as a toy cutout the moment it rotates; `buildGrindLoft`
 *    warps every vertex's Z by a grind field so the section runs from full stock at the spine
 *    to a near-zero apex at the cutting edge. This is the documented fix for that failure.
 *  - The finish is the reference's OWN de-lit pixels, projected. A procedural Doppler swirl is
 *    the single biggest CS2 fidelity failure, so it is not used. +Z faces sample the front
 *    plate, -Z faces the back plate (mirrored in u), walls get a solid ruby.
 *  - Tone mapping must be AgX. The measured peak ruby is rgb(245,56,65) with the red channel
 *    already clipped in the source; ACES desaturates near-primary red toward pink/orange.
 *    The registry entry sets it.
 *  - Every Z (thickness) value is an INFERENCE. Both references are broadside, so nothing in
 *    this file knows the real stock thickness, grind type, or scale doming. See geo.json's
 *    `thicknessInference` block (confidence 0.35).
 */
import * as THREE from 'three';
import geo from './geo.json';

const BASE = import.meta.env.BASE_URL;

/** Image->world mapping used by the tracer; UVs invert it to sample the reference plates. */
const MAP = geo.mapping as { SX: number; SY: number; CX: number; CY: number };

type XY = [number, number];

export interface TalonDopplerRubyOptions {
  /** Cast/receive shadows on every part (default true). */
  shadows?: boolean;
  /** Skip texture loading (used by geometry-only checks). */
  noTextures?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Reference-plate projection
// ---------------------------------------------------------------------------------------------

/**
 * Planar projection along Z that lands the de-lit reference plate exactly where the tracer read
 * it: it is the algebraic inverse of geo.json's image->world mapping, so a vertex traced from
 * pixel (px,py) samples that same pixel. `mirror` flips u for the back plate, whose subject is
 * mirrored in the source photograph.
 */
function projectUV(geometry: THREE.BufferGeometry, mirror = false): void {
  const pos = geometry.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) / MAP.SX + MAP.CX;
    const v = 1 - MAP.CY + pos.getY(i) / MAP.SY;
    uv[i * 2] = mirror ? 1 - u : u;
    uv[i * 2 + 1] = v;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function loadPlate(file: string): THREE.Texture {
  const tex = new THREE.TextureLoader().load(`${BASE}talon-doppler-ruby/${file}`);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  return tex;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

/**
 * Back-view traced coordinates are in the BACK PHOTOGRAPH's frame, which is mirrored relative to
 * the object's own frame: the back scale traces to x [-1.138, 0.159] while the same physical part
 * lives at x [-0.170, 1.141]. Using them raw put the entire back assembly on top of the blade
 * (caught by a world-bbox dump, not by eye). Negating x maps the back trace into object space and
 * keeps the back view's OWN measurements rather than mirroring the front's. Winding flips with the
 * negation, so the point order is reversed to keep the outer ring CCW for THREE.Shape.
 */
function mirrorX(points: XY[]): XY[] {
  return points.map(([x, y]) => [-x, y] as XY).reverse();
}

function shapeFrom(points: XY[], holes?: { cx: number; cy: number; r: number }[]): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  for (const h of holes ?? []) {
    const path = new THREE.Path();
    path.absarc(h.cx, h.cy, h.r, 0, Math.PI * 2, true);
    shape.holes.push(path);
  }
  return shape;
}

/**
 * Per-column spine (max Y) and edge (min Y) of a traced outline, so the grind field knows how
 * far up the blade any point sits. Sampled into bins because the outline is an unordered-in-x
 * closed loop, not a function of x.
 */
function heightField(points: XY[], bins = 256) {
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const [x] of points) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  const top = new Float32Array(bins).fill(-Infinity);
  const bot = new Float32Array(bins).fill(Infinity);
  const bin = (x: number) => Math.min(bins - 1, Math.max(0, Math.floor(((x - x0) / (x1 - x0)) * bins)));
  for (const [x, y] of points) {
    const b = bin(x);
    top[b] = Math.max(top[b], y);
    bot[b] = Math.min(bot[b], y);
  }
  // Fill empty bins from their neighbours so a sparse column cannot produce Infinity.
  for (let i = 1; i < bins; i++) {
    if (top[i] === -Infinity) top[i] = top[i - 1];
    if (bot[i] === Infinity) bot[i] = bot[i - 1];
  }
  for (let i = bins - 2; i >= 0; i--) {
    if (top[i] === -Infinity) top[i] = top[i + 1];
    if (bot[i] === Infinity) bot[i] = bot[i + 1];
  }
  // Box-smooth, then sample with LINEAR INTERPOLATION between bins. Both matter for shading, not
  // for shape: a per-bin staircase is piecewise constant, so the analytic normal's central
  // difference reads exactly zero inside a bin and spikes across every boundary — which rendered
  // as a comb of bright slivers radiating over the blade. A smooth, interpolated field has a
  // well-behaved gradient.
  const smooth = (arr: Float32Array): Float32Array => {
    const out = new Float32Array(arr.length);
    const r = 2;
    for (let i = 0; i < arr.length; i++) {
      let sum = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const j = Math.min(arr.length - 1, Math.max(0, i + k));
        sum += arr[j];
        n++;
      }
      out[i] = sum / n;
    }
    return out;
  };
  const topS = smooth(top);
  const botS = smooth(bot);
  const sample = (arr: Float32Array, x: number): number => {
    const t = ((x - x0) / (x1 - x0)) * (bins - 1);
    const i = Math.min(bins - 2, Math.max(0, Math.floor(t)));
    const f = Math.min(1, Math.max(0, t - i));
    return arr[i] * (1 - f) + arr[i + 1] * f;
  };
  return {
    x0,
    x1,
    spineAt: (x: number) => sample(topS, x),
    edgeAt: (x: number) => sample(botS, x),
  };
}

const smoothstep = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/**
 * Traced outline -> a real ground blade solid.
 *
 * ExtrudeGeometry supplies the topology (both caps plus walls around the outline AND around
 * every hole - which is why the three through-holes come out as real openings with real inner
 * walls). Then every vertex's Z is replaced by the grind field, so:
 *   - above the grind line the section keeps full stock,
 *   - below it the section ramps down to a near-zero apex at the cutting edge,
 *   - near the tip a distal taper thins the whole section.
 * Cap triangles are subdivided first: `ShapeUtils.triangulateShape` puts vertices only on the
 * outline, so without subdivision a triangle spanning spine-to-edge would interpolate the grind
 * linearly across the blade's whole width and lose the bevel break.
 */
function buildGrindLoft(
  points: XY[],
  holes: { cx: number; cy: number; r: number }[],
  grind: {
    spineHalf: number; apexHalf: number; grindFrac: number;
    distalTaperFromTipFrac: number; distalTaperHalf: number; tipAtMinX: boolean;
  },
  subdivisions = 2,
): THREE.BufferGeometry {
  const shape = shapeFrom(points, holes);
  const geom = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, steps: 1 });
  geom.translate(0, 0, -0.5); // z in {-0.5, +0.5}; sign selects which face a vertex belongs to
  const src = geom.toNonIndexed();
  geom.dispose();

  const hf = heightField(points);
  const halfWidth = (x: number, y: number): number => {
    const spineY = hf.spineAt(x);
    const edgeY = hf.edgeAt(x);
    const h = Math.max(1e-5, spineY - edgeY);
    const hr = Math.min(1, Math.max(0, (y - edgeY) / h)); // 0 at cutting edge, 1 at spine
    const apexFrac = grind.apexHalf / grind.spineHalf;
    const profile = hr >= grind.grindFrac
      ? 1
      : apexFrac + (1 - apexFrac) * smoothstep(hr / grind.grindFrac);
    // Distal taper: thin the whole section as it approaches the tip.
    const fromTip = grind.tipAtMinX
      ? (x - hf.x0) / (hf.x1 - hf.x0)
      : (hf.x1 - x) / (hf.x1 - hf.x0);
    const taper = fromTip >= grind.distalTaperFromTipFrac
      ? 1
      : (grind.distalTaperHalf / grind.spineHalf)
        + (1 - grind.distalTaperHalf / grind.spineHalf)
          * smoothstep(fromTip / grind.distalTaperFromTipFrac);
    return grind.spineHalf * profile * taper;
  };

  // Which vertices belong to a cap: ExtrudeGeometry emits group 0 = caps, group 1 = walls.
  const capGroup = src.groups.find((g) => g.materialIndex === 0) ?? src.groups[0];
  const capStart = capGroup?.start ?? 0;
  const capEnd = capStart + (capGroup?.count ?? 0);

  const p = src.getAttribute('position');
  const verts: number[] = [];
  const norms: number[] = [];
  const at = (i: number): number[] => [p.getX(i), p.getY(i), p.getZ(i)];

  /**
   * Cap normals are computed ANALYTICALLY from the grind field's gradient, never from the
   * triangulation. Ear-clipping returns slivers, and three nearly-collinear samples of a curved
   * field average to a normal that swings wildly — which renders as a fan of hard creases
   * radiating across the surface. That is exactly what the first build did: the blade shaded like
   * shattered crystal because a near-mirror material (roughness 0.07, clearcoat 0.65) amplifies
   * every bad facet normal. For a surface z = side*f(x,y) the true normal is
   * normalize(-f_x, -f_y, 1/side) — recovered here by central differences on f.
   */
  // EPS spans several bins of the (now smoothed+interpolated) field so the central difference
  // measures real curvature rather than interpolation noise.
  const EPS = 6e-3;
  const capNormal = (x: number, y: number, side: number): number[] => {
    const fx = (halfWidth(x + EPS, y) - halfWidth(x - EPS, y)) / (2 * EPS);
    const fy = (halfWidth(x, y + EPS) - halfWidth(x, y - EPS)) / (2 * EPS);
    const n = [-side * fx, -side * fy, side];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / len, n[1] / len, n[2] / len];
  };

  const warp = (v: number[]): number[] => {
    const side = Math.sign(v[2]) || 1;
    return [v[0], v[1], side * halfWidth(v[0], v[1])];
  };

  for (let i = 0; i < p.count; i += 3) {
    const isCap = i >= capStart && i < capEnd;
    let tris: number[][][] = [[at(i), at(i + 1), at(i + 2)]];
    if (isCap) {
      // 4-way subdivide so a field that curves mid-triangle has interior vertices to land on.
      for (let s = 0; s < subdivisions; s++) {
        const next: number[][][] = [];
        for (const [a, b, c] of tris) {
          const mid = (u: number[], v: number[]): number[] => [
            (u[0] + v[0]) / 2, (u[1] + v[1]) / 2, (u[2] + v[2]) / 2,
          ];
          const ab = mid(a, b);
          const bc = mid(b, c);
          const ca = mid(c, a);
          next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
        }
        tris = next;
      }
    }
    for (const tri of tris) {
      const w = tri.map(warp);
      for (const v of w) verts.push(v[0], v[1], v[2]);
      if (isCap) {
        for (const v of w) {
          const n = capNormal(v[0], v[1], Math.sign(v[2]) || 1);
          norms.push(n[0], n[1], n[2]);
        }
      } else {
        // Walls (outer silhouette, ground bevel, hole interiors) keep a flat geometric normal:
        // they are genuinely faceted, and a smoothed wall normal would round the apex away.
        const [a, b, c] = w;
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const len = Math.hypot(n[0], n[1], n[2]) || 1;
        for (let k = 0; k < 3; k++) norms.push(n[0] / len, n[1] / len, n[2] / len);
      }
    }
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  src.dispose();
  return out;
}

/**
 * Split a non-indexed geometry into three material groups by face orientation: +Z faces take
 * the front reference plate, -Z faces the back plate, and everything steeply-angled (walls,
 * the ground bevel, hole interiors) takes a solid material. Done per triangle so one mesh can
 * carry both plates - which keeps `bladeBody` ONE named part for the explode/pick contract
 * instead of three meshes pretending to be one.
 */
function groupByFacing(geometry: THREE.BufferGeometry, threshold = 0.5): THREE.BufferGeometry {
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const p = geometry.getAttribute('position');
  const n = geometry.getAttribute('normal');
  const posBuckets: number[][] = [[], [], []];
  const nrmBuckets: number[][] = [[], [], []];
  const nz = (i: number): number => (n.getZ(i) + n.getZ(i + 1) + n.getZ(i + 2)) / 3;
  for (let i = 0; i < p.count; i += 3) {
    const z = nz(i);
    const b = z > threshold ? 0 : z < -threshold ? 1 : 2;
    for (let k = 0; k < 3; k++) {
      posBuckets[b].push(p.getX(i + k), p.getY(i + k), p.getZ(i + k));
      nrmBuckets[b].push(n.getX(i + k), n.getY(i + k), n.getZ(i + k));
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(
    [...posBuckets[0], ...posBuckets[1], ...posBuckets[2]], 3,
  ));
  // Carry the authored normals through the reorder. Recomputing here would throw away the
  // analytic cap normals and put the shattered-facet shading straight back.
  out.setAttribute('normal', new THREE.Float32BufferAttribute(
    [...nrmBuckets[0], ...nrmBuckets[1], ...nrmBuckets[2]], 3,
  ));
  let start = 0;
  posBuckets.forEach((b, idx) => {
    const count = b.length / 3;
    if (count > 0) out.addGroup(start, count, idx);
    start += count;
  });
  return out;
}

function extrudeSlab(points: XY[], depth: number, bevel: number, holes?: { cx: number; cy: number; r: number }[]): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shapeFrom(points, holes), {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    steps: 1,
  });
  g.translate(0, 0, -depth / 2);
  return g;
}

function annulus(cx: number, cy: number, outer: number, inner: number, depth: number, bevel: number): THREE.BufferGeometry {
  const pts: XY[] = [];
  const seg = 96;
  for (let i = 0; i < seg; i++) {
    const t = (i / seg) * Math.PI * 2;
    pts.push([cx + Math.cos(t) * outer, cy + Math.sin(t) * outer]);
  }
  return extrudeSlab(pts, depth, bevel, [{ cx, cy, r: inner }]);
}

/** Shallow domed pin head: a lathe profile, so one geometry serves every instanced rivet. */
function pinHead(radius: number, dome: number, shank: number): THREE.BufferGeometry {
  const profile: THREE.Vector2[] = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    profile.push(new THREE.Vector2(Math.max(1e-4, radius * Math.sin((t * Math.PI) / 2)), dome * Math.cos((t * Math.PI) / 2)));
  }
  profile.push(new THREE.Vector2(radius, -shank));
  return new THREE.LatheGeometry(profile, 20);
}

// ---------------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------------

export function createTalonDopplerRubyModel(options: TalonDopplerRubyOptions = {}): THREE.Group {
  const shadows = options.shadows ?? true;
  const F = geo.front as any;
  const B = geo.back as any;
  const T = geo.thicknessInference as any;

  const root = new THREE.Group();
  root.name = 'talonRoot';

  const frontPlate = options.noTextures ? null : loadPlate('projection-front.webp');
  const backPlate = options.noTextures ? null : loadPlate('projection-back.webp');

  // --- materials. Measured medians; see the spec's `materials` block for provenance. --------
  // metalness 0.30, NOT the finish profile's 0.95 — a measured correction, and a real tension
  // worth naming. `anodized-multicolored` calls for high metalness because the finish takes its
  // colour from environment reflection. But on the PROJECTION route the de-lit plate already IS
  // the appearance, and at metalness 0.95 a metal has almost no diffuse term, so the plate's
  // colour is suppressed and replaced by a neutral RoomEnvironment reflection. Measured against
  // the reference at 0.95: ruby came out 26 value-units DARK and 24 saturation-units FLAT. Lower
  // metalness lets the measured albedo through; clearcoat keeps the lacquer gloss. Roughness is
  // also up from 0.07 — a near-mirror amplified every residual grind facet into a bright sliver.
  const rubyProjFront = new THREE.MeshPhysicalMaterial({
    map: frontPlate ?? undefined, color: frontPlate ? 0xffffff : 0x7f181a,
    metalness: 0.08, roughness: 0.42, clearcoat: 0.18, clearcoatRoughness: 0.26,
    envMapIntensity: 0.35, name: 'rubyFinish/front-plate',
  });
  const rubyProjBack = new THREE.MeshPhysicalMaterial({
    map: backPlate ?? undefined, color: backPlate ? 0xffffff : 0x7f181a,
    metalness: 0.08, roughness: 0.42, clearcoat: 0.18, clearcoatRoughness: 0.26,
    envMapIntensity: 0.35, name: 'rubyFinish/back-plate',
  });
  // Walls, ground bevel and hole interiors: the plates carry no data for surfaces the camera
  // never saw, so a solid measured ruby is used rather than smeared texture.
  const rubyEdge = new THREE.MeshPhysicalMaterial({
    color: 0x8c1a1d, metalness: 0.95, roughness: 0.12, clearcoat: 0.5,
    clearcoatRoughness: 0.14, envMapIntensity: 1.8, name: 'rubyFinish/edge',
  });
  const ivoryFront = new THREE.MeshPhysicalMaterial({
    // 0xededed: the plate tint is a measured correction, re-solved after the tone-mapping change.
    // At agx@1.15 the ivory rendered +35 too bright and needed 0.814; at neutral@0.70 it came out
    // -20 too dark, so the ratio 162/142 = 1.141 lifts the previous 208 tint to 237.
    map: frontPlate ?? undefined, color: frontPlate ? 0xededed : 0xa2a29f,
    metalness: 0.0, roughness: 0.45, envMapIntensity: 0.85, name: 'ivoryScale/front-plate',
  });
  const ivoryBack = new THREE.MeshPhysicalMaterial({
    map: backPlate ?? undefined, color: backPlate ? 0xededed : 0xa2a29f,
    metalness: 0.0, roughness: 0.45, envMapIntensity: 0.85, name: 'ivoryScale/back-plate',
  });
  const ivoryEdge = new THREE.MeshPhysicalMaterial({
    color: 0xaaaca8, metalness: 0.0, roughness: 0.34, envMapIntensity: 1.0,
    name: 'ivoryScale/chamfer',
  });
  const brass = new THREE.MeshPhysicalMaterial({
    // 0x7a6b36 = rgb(122,107,54): re-solved after the tone-mapping change (ratios 122/103,
    // 106/86, 64/49). metalness 0.65 keeps brass metallic while letting the warm
    // hue survive — at 0.9 the neutral env reflection cost 39 saturation units.
    color: 0x7a6b36, metalness: 0.65, roughness: 0.3, clearcoat: 0.15,
    clearcoatRoughness: 0.3, envMapIntensity: 1.15, name: 'brassHardware',
  });
  const inlay = new THREE.MeshPhysicalMaterial({
    color: 0x4e4e4c, metalness: 0.25, roughness: 0.45, envMapIntensity: 0.9, name: 'inlayGrey',
  });

  const meshes: THREE.Mesh[] = [];
  const nodes: Record<string, THREE.Object3D> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const add = (parent: THREE.Object3D, mesh: THREE.Mesh, name: string, relief = false): THREE.Mesh => {
    mesh.name = name;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    // Surface relief belongs TO its shell: it rides the parent on explode and a click on it
    // resolves up to the shell instead of selecting one sliver.
    if (relief) mesh.userData.explodeWithParent = true;
    parent.add(mesh);
    meshes.push(mesh);
    nodes[name] = mesh;
    return mesh;
  };
  const socket = (parent: THREE.Object3D, name: string, at: [number, number, number]): void => {
    const s = new THREE.Object3D();
    s.name = name;
    s.position.set(...at);
    parent.add(s);
    sockets[name] = s;
  };

  // --- blade: traced outline, real holes, real grind ---------------------------------------
  const bladePivot = new THREE.Group();
  bladePivot.name = 'bladePivot';
  root.add(bladePivot);
  nodes.bladePivot = bladePivot;

  const bladeGeom = groupByFacing(buildGrindLoft(
    F.blade.outlineWorld as XY[],
    (F.blade.holes as any[]).map((h) => ({ cx: h.center[0], cy: h.center[1], r: h.radius })),
    {
      spineHalf: T.bladeHalfStock,
      apexHalf: 0.0012,
      grindFrac: 0.55,
      distalTaperFromTipFrac: 0.34,
      distalTaperHalf: 0.010,
      tipAtMinX: true, // front view: the tip is the -x extreme
    },
  ));
  projectUV(bladeGeom);
  // The back plate is sampled mirrored, so give the -Z group its own mirrored UV set.
  const bladeBack = bladeGeom.clone();
  projectUV(bladeBack, true);
  bladeGeom.setAttribute('uv2', bladeBack.getAttribute('uv'));
  bladeBack.dispose();
  add(bladePivot, new THREE.Mesh(bladeGeom, [rubyProjFront, rubyProjBack, rubyEdge]), 'bladeBody');
  socket(bladePivot, 'bladeBase', [F.blade.maxWorldX, 0, 0]);

  // --- tang (occluded in both views; inferred so blade and ring stay one body) --------------
  const tangGeom = extrudeSlab(F.tang.polygonWorld as XY[], T.tangHalf * 2, 0.002);
  projectUV(tangGeom);
  add(root, new THREE.Mesh(tangGeom, rubyEdge), 'tangSpine');

  // --- finger ring -------------------------------------------------------------------------
  const ring = F.fingerRing as any;
  const ringPivot = new THREE.Group();
  ringPivot.name = 'ringPivot';
  ringPivot.position.set(ring.centerWorld[0], ring.centerWorld[1], 0);
  root.add(ringPivot);
  nodes.ringPivot = ringPivot;
  const ringGeom = annulus(0, 0, ring.outerRadiusWorld, ring.boreRadiusWorld, T.tangHalf * 2, 0.006);
  ringGeom.translate(ring.centerWorld[0], ring.centerWorld[1], 0);
  projectUV(ringGeom);
  ringGeom.translate(-ring.centerWorld[0], -ring.centerWorld[1], 0);
  add(ringPivot, new THREE.Mesh(ringGeom, rubyEdge), 'fingerRing');
  socket(ringPivot, 'fingerRingAxis', [0, 0, 0]);

  // --- scales + their hardware -------------------------------------------------------------
  const scaleZ = T.tangHalf + T.scaleHalf;
  for (const side of ['Front', 'Back'] as const) {
    const src = side === 'Front' ? F : B;
    const z = side === 'Front' ? scaleZ : -scaleZ;
    const plate = side === 'Front' ? ivoryFront : ivoryBack;
    const mirror = side === 'Back';
    // Back-view traces live in the back photograph's mirrored frame; map them into object space.
    const ox = (x: number): number => (mirror ? -x : x);
    const poly = (pts: XY[]): XY[] => (mirror ? mirrorX(pts) : pts);

    const group = new THREE.Group();
    group.name = `scale${side}Assembly`;
    root.add(group);
    nodes[group.name] = group;

    // The scale must carry the finger-ring bore as a real HOLE. `trace()` returns only the
    // EXTERNAL contour, so the traced ivory outline fills the bore — which rendered as a solid
    // ivory blob over the ring with only its outer rim showing. In the reference the scale wraps
    // the ring and the bore is open through both.
    // NB: `ring.centerWorld` is front-derived and therefore ALREADY object space — unlike
    // `src.*`, it must not be passed through ox(). The ring sits at the same +x for both scales.
    const bore = { cx: ring.centerWorld[0], cy: ring.centerWorld[1], r: ring.boreRadiusWorld };
    // Bevel kept small: ExtrudeGeometry's bevel self-intersects on the concave choil corners of a
    // 240-point outline and spikes into bright white creases along the scale edge.
    const slab = groupByFacing(extrudeSlab(
      poly(src.scale.outlineWorld as XY[]), T.scaleHalf * 2, 0.0025, [bore],
    ));
    projectUV(slab, mirror);
    slab.translate(0, 0, z);
    add(group, new THREE.Mesh(slab, [plate, plate, ivoryEdge]), `scale${side}`);
    socket(group, `scaleSeat${side}`, [0.45, 0.12, z]);

    // rivets: one InstancedMesh, at the MEASURED irregular positions (even spacing reads wrong)
    const rivets = src.rivets as any[];
    const head = pinHead(rivets[0].radius, 0.006, T.scaleHalf * 2);
    const inst = new THREE.InstancedMesh(head, brass, rivets.length);
    inst.name = `rivetRow${side}`;
    inst.castShadow = shadows;
    inst.receiveShadow = shadows;
    inst.userData.explodeWithParent = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(side === 'Front' ? Math.PI / 2 : -Math.PI / 2, 0, 0),
    );
    rivets.forEach((r, i) => {
      m.compose(
        new THREE.Vector3(ox(r.center[0]), r.center[1], z + (side === 'Front' ? T.scaleHalf : -T.scaleHalf)),
        q,
        new THREE.Vector3(r.radius / rivets[0].radius, 1, r.radius / rivets[0].radius),
      );
      inst.setMatrixAt(i, m);
    });
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
    nodes[inst.name] = inst;

    // medallion: brass annulus + neutral-grey inlay + 4 radial spokes
    const med = src.medallion as any;
    const medZ = z + (side === 'Front' ? T.scaleHalf : -T.scaleHalf);
    const rimGeom = annulus(0, 0, med.radius, med.radius * med.inlayRadiusFraction, 0.006, 0.0015);
    const rim = add(group, new THREE.Mesh(rimGeom, brass), `medallionRim${side}`, true);
    rim.position.set(ox(med.center[0]), med.center[1], medZ);

    const inlayGeom = new THREE.CylinderGeometry(
      med.radius * med.inlayRadiusFraction, med.radius * med.inlayRadiusFraction, 0.004, 32,
    );
    inlayGeom.rotateX(Math.PI / 2);
    const inl = add(group, new THREE.Mesh(inlayGeom, inlay), `medallionInlay${side}`, true);
    inl.position.set(ox(med.center[0]), med.center[1], medZ);

    const spokeGeom = new THREE.BoxGeometry(med.radius * 0.8, med.radius * 0.22, 0.003);
    const spokes = new THREE.InstancedMesh(spokeGeom, brass, med.spokeCount);
    spokes.name = `medallionSpokes${side}`;
    spokes.castShadow = shadows;
    spokes.userData.explodeWithParent = true;
    for (let i = 0; i < med.spokeCount; i++) {
      const a = (i * Math.PI * 2) / med.spokeCount;
      m.compose(
        new THREE.Vector3(ox(med.center[0]), med.center[1], medZ + 0.002),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a)),
        new THREE.Vector3(1, 1, 1),
      );
      spokes.setMatrixAt(i, m);
    }
    spokes.instanceMatrix.needsUpdate = true;
    group.add(spokes);
    nodes[spokes.name] = spokes;

    // spacer strips: traced quads. The aft strip is raked ~12deg - not parallel to the fore one.
    (src.spacerStrips as any[]).forEach((st, i) => {
      const tag = i === 0 ? 'Fore' : 'Aft';
      const g = extrudeSlab(poly(st.quadWorld as XY[]), T.scaleHalf * 2 + 0.001, 0.001);
      g.translate(0, 0, z);
      add(group, new THREE.Mesh(g, brass), `spacer${tag}${side}`, true);
    });
  }

  // --- runtime contract --------------------------------------------------------------------
  // destructionGroups maps a module name to mesh NAMES (what the viewer's assembly panel reads).
  const destructionGroups: Record<string, string[]> = {
    steelBody: ['bladeBody', 'tangSpine', 'fingerRing'],
    scaleFrontAssembly: ['scaleFront', 'rivetRowFront', 'medallionRimFront', 'medallionInlayFront',
      'medallionSpokesFront', 'spacerForeFront', 'spacerAftFront'],
    scaleBackAssembly: ['scaleBack', 'rivetRowBack', 'medallionRimBack', 'medallionInlayBack',
      'medallionSpokesBack', 'spacerForeBack', 'spacerAftBack'],
  };

  root.userData.sculptRuntime = {
    nodes,
    meshes,
    sockets,
    colliders: {
      bladeBody: { type: 'box', notes: 'box proxy over the traced blade extent' },
      fingerRing: { type: 'cylinder', notes: 'annulus proxy at the ring centre' },
      scaleFront: { type: 'box', notes: 'slab proxy' },
      scaleBack: { type: 'box', notes: 'slab proxy' },
    },
    destructionGroups,
    pivots: {
      bladePivot: 'whole-blade transform, origin at the blade/scale split',
      ringPivot: 'origin at the finger-ring centre — the axis a talon actually spins about',
    },
  };

  root.userData.reconstruction = {
    generatedWith: 'img2threejs v1.4.4',
    route: 'reference-projection',
    exactnessTier: 'image-only',
    toneMapping: 'agx',
    unobserved: 'every Z/thickness value, the blade grind type, the spine top face and the ring '
      + 'bore chamfer are inferences — both references are broadside (confidence 0.35)',
  };

  // --- looping idle ------------------------------------------------------------------------
  // A Talon is a fixed blade: nothing on it articulates, so inventing a moving part would be
  // faking a mechanism. What the item genuinely needs is MOTION — an anodized-multicolored
  // finish reads its colour from environment reflections and only resolves while turning.
  // So the idle turns the whole knife about the finger-ring axis (the real-world talon spin)
  // with a slow secondary pitch. Driven from `elapsed`, and the two periods share a 9 s common
  // multiple, so it loops seamlessly and never drifts.
  const IDLE_PERIOD = 9;
  root.userData.tick = (_dt: number, elapsed: number): void => {
    const t = (elapsed % IDLE_PERIOD) / IDLE_PERIOD;
    const a = t * Math.PI * 2;
    root.rotation.y = Math.sin(a) * THREE.MathUtils.degToRad(19);
    root.rotation.x = Math.sin(a * 2) * THREE.MathUtils.degToRad(4.5);
    root.rotation.z = Math.sin(a) * THREE.MathUtils.degToRad(2.5);
  };

  return root;
}

/**
 * Three-point rig matched to the reference's read lighting: a broad key high and slightly fore
 * (the brass crowns fall from rgb(159,130,74) fore to rgb(91,76,42) aft), a low cool fill that
 * keeps the apex band off black, and a tight rim that produces the compact spine specular.
 */
export function createTalonDopplerRubyLookDevLights(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'talonLookDevLights';

  const key = new THREE.DirectionalLight(0xfff2e2, 1.05);
  key.position.set(-1.6, 4.2, 3.4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 20;
  key.shadow.camera.left = -2.2;
  key.shadow.camera.right = 2.2;
  key.shadow.camera.top = 1.4;
  key.shadow.camera.bottom = -1.4;
  key.shadow.bias = -0.0004;

  const fill = new THREE.DirectionalLight(0xbcd2ff, 0.22);
  fill.position.set(2.8, -1.2, 2.2);

  const rim = new THREE.DirectionalLight(0xffd9c8, 0.45);
  rim.position.set(0.8, 1.6, -3.6);

  // Intensities are deliberately LOW. The projected plates are de-lit reference pixels that
  // already carry the finish's own value, so a hot rig double-counts: at key 2.5 / rim 1.5 /
  // ambient 0.35 the neutral additive term lifted the ruby's green channel from a measured 24
  // to 96 and cost 83 saturation units. The plate supplies colour; the rig only has to supply
  // form and the spine specular.
  g.add(key, fill, rim, new THREE.AmbientLight(0x2a2430, 0.10));

  // Sized to the subject (2.4 units long), not oversized. `meshBounds()` skips ShadowMaterial
  // catchers, but capture-mode `frameForCapture()` uses a raw expandByObject over every mesh, so
  // an oversized catcher pushes the review camera back: a 24-unit plane put it at z=54.87 and
  // rendered the knife at 8% of frame width. The pinned capture camera in registry.ts is the
  // real fix; keeping this tight means the un-pinned auto-fit is also sane.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(3.6, 3.6),
    new THREE.ShadowMaterial({ opacity: 0.36 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.62;
  ground.receiveShadow = true;
  ground.name = 'contactShadowGround';
  ground.userData.explodeWithParent = true;
  g.add(ground);

  return g;
}

/** Near-black backdrop with a faint warm centre so the saturated blade separates. */
export function makeTalonDopplerRubyBackground(): THREE.CanvasTexture {
  const size = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const c = cv.getContext('2d')!;
  const grad = c.createRadialGradient(
    size * 0.5, size * 0.48, size * 0.03,
    size * 0.5, size * 0.5, size * 0.74,
  );
  grad.addColorStop(0, '#20101a');
  grad.addColorStop(1, '#050307');
  c.fillStyle = grad;
  c.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
