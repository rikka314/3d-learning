import * as THREE from 'three';
import { MEASURED_SECTIONS, type Ring } from './crossSections';
import { EDGE_TARGET_METRES } from './edgeTargets';
import {
  decodeSurfaces,
  type DecodedSurface,
  type EncodedSurfaceMaterial,
} from '../girl-character/surfaceCodec';
import { MeshoptSimplifier } from 'meshoptimizer';
import { installWarriorRig, WARRIOR_TRIPO_MOTION_4_HIDE } from './warriorRig';
import { WARRIOR_TRIPO4_CLEARANCE } from './tripo4ClearanceData';

export type WarriorQuality = 'high' | 'medium' | 'low';

/**
 * The measured stream contours 47 nodes at 4,261,479 vertices and 8,534,984 triangles. That is the
 * evidence, and High still renders every one of them, but it is not a sensible thing to hand a
 * browser by default: the figure is skinned, so each frame pays the triangle count twice over in
 * vertex work before the rasteriser sees it.
 *
 * Low is therefore the default. It is not a different reconstruction — the same decoded surfaces are
 * decimated with meshoptimizer, boundary edges locked so node seams and open silhouettes stay where
 * the measurement put them.
 *
 * Measured on a built model, and the deviation measured against the full-density surfaces:
 *
 *     level     triangles     of baseline     worst deviation     mean deviation
 *     High      8,535,064          100%       0 (untouched)       0
 *     Medium    4,000,260           47%       0.117 mm            0.029 mm
 *     Low       1,499,476           18%       0.250 mm            0.072 mm
 *
 * Those are small against the grid the surfaces were contoured on — cells run 0.77 to 1.21 mm, so
 * even the worst node moves by a quarter of one cell, under the resolution of the measurement
 * itself. Rendered and diffed against High at the same frozen capture camera, Low changes 172 of
 * 150,913 subject pixels along the silhouette (0.11%) and 1.55% of them by more than 32/255.
 *
 * `?quality=high` and `?quality=medium` remain reachable, and High is byte-identical to what this
 * file produced before the levels existed.
 */
function readWarriorQuality(): WarriorQuality {
  if (typeof window === 'undefined') return 'low';
  const raw = (new URLSearchParams(window.location.search).get('quality') ?? '').toLowerCase();
  if (raw === 'high') return 'high';
  if (raw === 'medium') return 'medium';
  return 'low';
}

const WARRIOR_QUALITY = readWarriorQuality();

/** Kept beside the table above so the note and the ratio cannot drift apart. */
const WARRIOR_QUALITY_RATIO: Record<WarriorQuality, number> = { high: 1, medium: 0.4687, low: 0.1757 };

/**
 * Generous enough that meshoptimizer reaches the requested ratio on every node rather than stopping
 * early on the dense ones; the table above records what it actually cost.
 */
const WARRIOR_SIMPLIFY_ERROR = 1e-2;

/** Below this a node is already cheap, and decimating it only costs silhouette. */
const WARRIOR_MIN_TRIANGLES = 64;

async function simplifyWarriorSurfaces(
  surfaces: DecodedSurface[], quality: WarriorQuality,
): Promise<DecodedSurface[]> {
  const ratio = WARRIOR_QUALITY_RATIO[quality];
  if (ratio >= 1) return surfaces;
  await MeshoptSimplifier.ready;
  return surfaces.map((surface) => {
    const triangles = surface.index.length / 3;
    const target = Math.max(WARRIOR_MIN_TRIANGLES, Math.floor(triangles * ratio)) * 3;
    if (target >= surface.index.length) return surface;
    const [index] = MeshoptSimplifier.simplify(
      surface.index, surface.position, 3, target, WARRIOR_SIMPLIFY_ERROR, ['LockBorder'],
    );
    // Positions and colours are left whole: the rig skins by measured position, and the indices no
    // longer reaching a vertex simply stop drawing it.
    return { ...surface, index };
  });
}

export interface WarriorOptions {
  castShadow?: boolean;
  receiveShadow?: boolean;
  diagnosticIds?: boolean;
  /** Measurement-only escape hatch for regenerating runtime correction curves. */
  disableTripo4Clearance?: boolean;
  disableTripo1Clearance?: boolean;
}

type Strand = Ring[];
let implicitSurfaces: DecodedSurface[] | null = null;
let implicitPromise: Promise<void> | null = null;

export function prewarmWarrior(): Promise<void> {
  implicitPromise ??= import('./surfaceData').then(async (data) => {
    const decoded = decodeSurfaces(data.SURFACE_STREAM, data.SURFACE_NODES);
    const expected = new Set(Array.from({ length: 47 }, (_, index) => index + 41));
    for (const surface of decoded) expected.delete(surface.node);
    if (expected.size) throw new Error(`warrior implicit stream misses nodes ${[...expected].join(', ')}`);
    // Decimate before the meshes exist, so the triangles the rig skins and the GPU draws are the
    // reduced ones rather than the full measured set.
    implicitSurfaces = await simplifyWarriorSurfaces(decoded, WARRIOR_QUALITY);
  });
  return implicitPromise;
}

/** Centripetal Catmull-Rom (alpha 0.5), used because its knot spacing limits corner overshoot. */
function centripetal(
  p0: readonly number[], p1: readonly number[], p2: readonly number[], p3: readonly number[], s: number,
): [number, number] {
  const knot = (a: readonly number[], b: readonly number[]) =>
    Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])), 1e-6);
  const t1 = knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + s * (t2 - t1);
  const mix = (a: readonly number[], b: readonly number[], ta: number, tb: number): [number, number] => {
    const weight = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * weight, a[1] + (b[1] - a[1]) * weight];
  };
  const a1 = mix(p0, p1, 0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  return mix(mix(a1, a2, 0, t2), mix(a2, a3, t1, t3), t1, t2);
}

/** Horizontal radius measured directly from a ring's emitted outline. */
function outlineRadius(ring: Ring): number {
  return ring.points.reduce(
    (radius, [x, z]) => Math.max(radius, Math.hypot(x - ring.centroid[0], z - ring.centroid[1])),
    0,
  );
}

/**
 * Join only rings in consecutive measured height bands whose outlines overlap in XZ.
 * There is deliberately no inherited or hand-picked distance threshold here: the admission test is
 * the two measured outline radii themselves. A cluster that vanishes for one band starts a new
 * strand instead of being bridged through empty space.
 */
function chainMeasuredStrands(rings: readonly Ring[]): Strand[] {
  const bands = new Map<number, Ring[]>();
  for (const ring of rings) {
    const band = bands.get(ring.y);
    if (band) band.push(ring);
    else bands.set(ring.y, [ring]);
  }

  const strands: Strand[] = [];
  let active: Strand[] = [];
  for (const [, band] of [...bands.entries()].sort(([a], [b]) => a - b)) {
    const available = new Set(active);
    const next: Strand[] = [];
    for (const ring of [...band].sort((a, b) =>
      a.centroid[0] - b.centroid[0] || a.centroid[1] - b.centroid[1])) {
      let best: Strand | null = null;
      let bestDistance = Infinity;
      for (const strand of available) {
        const tip = strand[strand.length - 1];
        const distance = Math.hypot(
          tip.centroid[0] - ring.centroid[0],
          tip.centroid[1] - ring.centroid[1],
        );
        if (distance <= outlineRadius(tip) + outlineRadius(ring) && distance < bestDistance) {
          best = strand;
          bestDistance = distance;
        }
      }
      if (best) {
        best.push(ring);
        available.delete(best);
        next.push(best);
      } else {
        const strand = [ring];
        strands.push(strand);
        next.push(strand);
      }
    }
    active = next;
  }
  return strands.filter((strand) => strand.length >= 2);
}

/**
 * Subdivide toward the source node's measured median triangle edge. The factors are computed from
 * this strand's own mean ring and spoke spacing; no global triangle count or smoothing radius is used.
 */
function subdivideMeasuredStrand(node: number, strand: Strand): Strand {
  if (strand.length < 2) return strand;
  const spokes = strand[0].points.length;
  const target = EDGE_TARGET_METRES[node];
  if (!target || spokes < 4 || strand.some((ring) => ring.points.length !== spokes)) return strand;

  let vertical = 0;
  for (let r = 0; r < strand.length - 1; r += 1) {
    for (let k = 0; k < spokes; k += 1) {
      const a = strand[r].points[k];
      const b = strand[r + 1].points[k];
      vertical += Math.hypot(b[0] - a[0], strand[r + 1].y - strand[r].y, b[1] - a[1]);
    }
  }
  let horizontal = 0;
  for (const ring of strand) {
    for (let k = 0; k < spokes; k += 1) {
      const a = ring.points[k];
      const b = ring.points[(k + 1) % spokes];
      horizontal += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
  }
  const ringSub = Math.max(1, Math.ceil(vertical / ((strand.length - 1) * spokes) / target));
  const spokeSub = Math.max(1, Math.ceil(horizontal / (strand.length * spokes) / target));

  const widened: Strand = spokeSub === 1 ? strand : strand.map((ring) => {
    const points: [number, number][] = [];
    const at = (index: number) => ring.points[((index % spokes) + spokes) % spokes];
    for (let k = 0; k < spokes; k += 1) {
      for (let sub = 0; sub < spokeSub; sub += 1) {
        const s = sub / spokeSub;
        points.push(s === 0 ? [...at(k)] as [number, number]
          : centripetal(at(k - 1), at(k), at(k + 1), at(k + 2), s));
      }
    }
    return { ...ring, points, uv: [] };
  });
  if (ringSub === 1) return widened;

  const out: Strand = [];
  const ringAt = (index: number) => widened[Math.max(0, Math.min(widened.length - 1, index))];
  for (let r = 0; r < widened.length - 1; r += 1) {
    for (let sub = 0; sub < ringSub; sub += 1) {
      const s = sub / ringSub;
      if (s === 0) {
        out.push(widened[r]);
        continue;
      }
      const points: [number, number][] = [];
      for (let k = 0; k < widened[0].points.length; k += 1) {
        points.push(centripetal(
          ringAt(r - 1).points[k], ringAt(r).points[k],
          ringAt(r + 1).points[k], ringAt(r + 2).points[k], s,
        ));
      }
      out.push({
        node,
        y: widened[r].y + (widened[r + 1].y - widened[r].y) * s,
        centroid: [
          widened[r].centroid[0] + (widened[r + 1].centroid[0] - widened[r].centroid[0]) * s,
          widened[r].centroid[1] + (widened[r + 1].centroid[1] - widened[r].centroid[1]) * s,
        ],
        points,
        uv: [],
      });
    }
  }
  out.push(widened[widened.length - 1]);
  return out;
}

function measuredNodeMaterial(
  node: number,
  diagnosticIds: boolean,
  measured: EncodedSurfaceMaterial | null = null,
): THREE.MeshStandardMaterial {
  if (diagnosticIds) {
    // Diagnostic palette only: deterministic separation between physical node ids, not a semantic or
    // source-material claim. The beauty pass replaces this after the baseline render is inspected.
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(((node - 41) * 0.61803398875) % 1, 0.62, 0.52),
      roughness: 0.82,
      metalness: 0,
      flatShading: false,
    });
  }
  if (!measured) {
    return new THREE.MeshStandardMaterial({
      color: 0x8b765f,
      roughness: 0.78,
      metalness: 0,
    });
  }
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: measured.roughnessMedian,
    metalness: measured.metalnessMedian,
    emissive: new THREE.Color().fromArray(measured.emissiveFactor),
    side: measured.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    opacity: measured.baseColorFactor[3],
    transparent: measured.alphaMode === 'BLEND',
    alphaTest: measured.alphaMode === 'MASK' ? measured.alphaCutoff : 0,
  });
  material.userData.measuredSource = measured;
  return material;
}

function loftStrand(node: number, strand: Strand, index: number, options: WarriorOptions): THREE.Mesh {
  const rawRingCount = strand.length;
  const rawSpokes = strand[0].points.length;
  strand = subdivideMeasuredStrand(node, strand);
  const spokes = strand[0].points.length;
  const positions: number[] = [];
  const indices: number[] = [];
  for (const ring of strand) {
    if (ring.points.length !== spokes) {
      throw new Error(`node ${node} changes spoke count inside one strand`);
    }
    for (const [x, z] of ring.points) positions.push(x, ring.y, z);
  }
  for (let r = 0; r < strand.length - 1; r += 1) {
    for (let k = 0; k < spokes; k += 1) {
      const next = (k + 1) % spokes;
      const a = r * spokes + k;
      const b = r * spokes + next;
      const c = (r + 1) * spokes + k;
      const d = (r + 1) * spokes + next;
      indices.push(a, c, b, b, c, d);
    }
  }
  for (const [ring, top] of [[strand[0], false], [strand[strand.length - 1], true]] as const) {
    const centre = positions.length / 3;
    positions.push(ring.centroid[0], ring.y, ring.centroid[1]);
    const base = top ? (strand.length - 1) * spokes : 0;
    for (let k = 0; k < spokes; k += 1) {
      const next = (k + 1) % spokes;
      if (top) indices.push(centre, base + k, base + next);
      else indices.push(centre, base + next, base + k);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, measuredNodeMaterial(node, options.diagnosticIds ?? false));
  mesh.name = `measured-node-${node}-strand-${index + 1}`;
  mesh.userData.region = `node-${node}`;
  mesh.userData.moduleNode = node;
  mesh.userData.measurement = {
    method: '40 measured horizontal bands with per-node density-limited radial outlines',
    rawSpokes,
    rawRings: rawRingCount,
    subdividedSpokes: spokes,
    subdividedRings: strand.length,
    targetEdgeMetres: EDGE_TARGET_METRES[node],
  };
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  return mesh;
}

export function createWarriorModel(options: WarriorOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'warrior-procedural';

  const ringsByNode = new Map<number, Ring[]>();
  for (const ring of MEASURED_SECTIONS) {
    const rings = ringsByNode.get(ring.node);
    if (rings) rings.push(ring);
    else ringsByNode.set(ring.node, [ring]);
  }

  const destructionGroups: Record<string, string[]> = {};
  let meshCount = 0;
  let triangleCount = 0;
  for (const [node, rings] of [...ringsByNode].sort(([a], [b]) => a - b)) {
    const module = new THREE.Group();
    module.name = `physical-node-${node}`;
    const strands = chainMeasuredStrands(rings);
    for (const [index, strand] of strands.entries()) {
      const mesh = loftStrand(node, strand, index, options);
      module.add(mesh);
      (destructionGroups[module.name] ??= []).push(mesh.name);
      meshCount += 1;
      triangleCount += (mesh.geometry.index?.count ?? 0) / 3;
    }
    if (module.children.length) root.add(module);
  }

  // CharacterIR remains the rig/action source of truth. This adapter only
  // binds the already reconstructed code surfaces to the compiled skeleton.
  const warriorRig = installWarriorRig(root, {
    disableTripo4Clearance: options.disableTripo4Clearance,
    disableTripo1Clearance: options.disableTripo1Clearance,
  });

  const attachImplicit = (): void => {
    if (!implicitSurfaces || root.getObjectByName('implicit-physical-nodes')) return;
    const implicitRoot = new THREE.Group();
    implicitRoot.name = 'implicit-physical-nodes';
    for (const surface of implicitSurfaces) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(surface.position, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(surface.colour, 3, true));
      geometry.setIndex(new THREE.BufferAttribute(surface.index, 1));
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const baseMesh = new THREE.Mesh(
        geometry,
        measuredNodeMaterial(surface.node, options.diagnosticIds ?? false, surface.material),
      );
      baseMesh.name = `implicit-node-${surface.node}`;
      baseMesh.userData.region = `node-${surface.node}`;
      baseMesh.userData.moduleNode = surface.node;
      baseMesh.userData.sdfSurface = {
        method: 'oriented point-cloud SDF contoured with new Surface Nets topology',
        cellMillimetres: surface.cellMillimetres,
        vertices: surface.position.length / 3,
        triangles: surface.index.length / 3,
        sourceTopologyCopied: false,
        baseColourBakedToVertices: true,
        materialParametersMeasured: surface.material,
      };
      baseMesh.castShadow = options.castShadow ?? true;
      baseMesh.receiveShadow = options.receiveShadow ?? true;
      const mesh = warriorRig.skinMesh(baseMesh, surface.node);
      implicitRoot.add(mesh);
      const loft = root.getObjectByName(`physical-node-${surface.node}`);
      if (loft?.parent) {
        loft.parent.remove(loft);
        loft.traverse((part) => {
          if (!(part instanceof THREE.Mesh)) return;
          part.geometry.dispose();
          if (Array.isArray(part.material)) part.material.forEach((material) => material.dispose());
          else part.material.dispose();
        });
      }
      destructionGroups[`physical-node-${surface.node}`] = [mesh.name];
      meshCount += 1;
      triangleCount += surface.index.length / 3;
    }
    root.add(implicitRoot);
    const runtime = root.userData.sculptRuntime as Record<string, unknown>;
    let activeMeshCount = 0;
    let activeTriangleCount = 0;
    let activeVertexCount = 0;
    root.traverse((part) => {
      if (!(part instanceof THREE.Mesh)) return;
      activeMeshCount += 1;
      activeVertexCount += part.geometry.getAttribute('position')?.count ?? 0;
      activeTriangleCount += (part.geometry.index?.count ?? 0) / 3;
    });
    runtime.pass = 'stage-3-embedded-surface-set';
    runtime.route = 'GLB-measured Surface Nets decoded from TypeScript; no runtime source asset';
    runtime.meshCount = activeMeshCount;
    runtime.triangleCount = activeTriangleCount;
    runtime.omittedNodes = [];
    runtime.implicitNodes = implicitSurfaces.map((surface) => surface.node);
    runtime.weightedMeshCount = activeMeshCount;
    runtime.weightedVertexCount = activeVertexCount;
  };
  root.userData.sculptRuntime = {
    detailLevels: {
      current: WARRIOR_QUALITY,
      options: [
        { id: 'high', label: 'High',
          note: '8.53M triangles · every measured Surface Nets triangle, untouched' },
        { id: 'medium', label: 'Medium',
          note: '4.00M triangles · 0.117 mm worst deviation from the measured surface' },
        { id: 'low', label: 'Low',
          note: '1.50M triangles · 0.250 mm worst deviation, node seams locked' },
      ],
    },
    pass: 'stage-1-cross-section-floor',
    route: 'GLB-measured code-only loft; no runtime source asset',
    exactnessTier: 'measurement-derived blockout',
    meshCount,
    triangleCount,
    measuredNodes: [...ringsByNode.keys()].sort((a, b) => a - b),
    omittedNodes: implicitSurfaces ? [] : Array.from({ length: 47 }, (_, index) => index + 41),
    destructionGroups,
    animationController: warriorRig.animationController,
    characterIR: warriorRig.ir,
    skeleton: warriorRig.skeleton.skeleton,
    joints: [...warriorRig.skeleton.bones.keys()],
    weightedMeshCount: warriorRig.weightedMeshCount,
    weightedVertexCount: warriorRig.weightedVertexCount,
    actionAnchors: {
      staffGrip: { joint: 'staff-grip', binding: 'physical-node-54', evidence: 'exact node-51/node-54 nearest-vertex contact' },
    },
    actionReadiness: {
      rigged: true,
      actions: ['tripo-motion-4', 'staff-attack'],
      sourceAnimation: {
        kind: 'code-native-retarget',
        runtimeAssetFetch: false,
        evidence: 'pipelines/warrior/evidence/animation-retarget.json',
      },
      tripoMotion4Prelude: {
        hiddenPhysicalNodes: WARRIOR_TRIPO_MOTION_4_HIDE.physicalNodes,
        measuredSourceSampleRateHz: WARRIOR_TRIPO_MOTION_4_HIDE.sourceSampleRateHz,
        authoredFadeFrameCount: WARRIOR_TRIPO_MOTION_4_HIDE.authoredFadeFrameCount,
        fadeSeconds: WARRIOR_TRIPO_MOTION_4_HIDE.fadeSeconds,
        clipStartsAfterFullyHidden: true,
        restoresOnActionChange: true,
      },
      tripoMotion4Clearance: {
        evidence: 'pipelines/warrior/evidence/tripo4-clearance-measurement.json',
        measuredCorrectionPoseCount: WARRIOR_TRIPO4_CLEARANCE.hipCorrectionRadians.length,
        measuredSourceSampleRateHz: WARRIOR_TRIPO4_CLEARANCE.sourceSampleRateHz,
        measuredCorrectionSampleRateHz: WARRIOR_TRIPO4_CLEARANCE.sampleRateHz,
        runtimeVerification: 'pipelines/warrior/evidence/tripo4-clearance-runtime-verification.json',
        surfaceToleranceMetres: WARRIOR_TRIPO4_CLEARANCE.surfaceToleranceMetres,
        kneeCentrelineThresholdMetres: WARRIOR_TRIPO4_CLEARANCE.kneeCentrelineThresholdMetres,
        ankleCentrelineThresholdMetres: WARRIOR_TRIPO4_CLEARANCE.ankleCentrelineThresholdMetres,
        maximumHipCorrectionRadians: Math.max(...WARRIOR_TRIPO4_CLEARANCE.hipCorrectionRadians),
        maximumClothCorrectionRadians: Math.max(...WARRIOR_TRIPO4_CLEARANCE.clothCorrectionRadians),
        correctedPhysicalNodes: [45, 46, 48, 55, 68],
        runtimeAssetFetch: false,
      },
      victoryDanceShapeLock: {
        rigidPhysicalNodes: [47, 50],
        permanentRigidGarmentNodes: [64, 84],
        mode: 'action-scoped-single-bone-binding',
        restoresArticulatedWeightsOnExit: true,
        garmentCoverage: 'rigid coat-driver follows measured hip-to-knee direction; symmetric outward translation equals half of measured knee-gap increase',
        evidence: 'pipelines/warrior/evidence/tripo-motion-4-surface-integrity-47-50-64-84.json',
      },
      backend: 'img2threejs CharacterIR + Three.js AnimationMixer',
      staffDriverChain: ['right-clavicle', 'right-shoulder', 'right-elbow', 'right-wrist', 'right-hand', 'staff-grip'],
      weaponAttachment: {
        gripJoint: 'staff-grip',
        rigidPhysicalNodes: [54],
        skinning: 'single-bone-100-percent',
        independentlyAnimated: false,
        attackMotion: '20 mm target-space two-bone IK thrust along node-54 principal axis with inverse-wrist orientation lock',
        proceduralImpactEffect: 'code-only seven-ray spark attached at the measured node-54 attack tip',
      },
      secondaryMotion: {
        garmentJoints: [
          'cape-right', 'coat-right', 'coat-left',
          'coat-front', 'coat-front-mid', 'coat-front-tip',
          'sash-tail', 'sash-tail-mid', 'sash-tail-tip',
        ],
        hatJoint: 'hat-back',
        rigidHatPhysicalNodes: [41, 60, 71],
        whiskerChains: [73, 74, 76, 77].map((node) => [`whisker-${node}-base`, `whisker-${node}-tip`]),
        eyeGlowNode: 81,
        cheeseJoint: 'cheese-pendulum',
        tailJoint: 'mouse-tail',
      },
      skinningPolicy: 'rigid semantic surfaces except measured articulated, toe, thin-cloth and whisker spans; nodes 64/84 are permanently rigid coat-driver garment shells aligned to measured hip-to-knee direction, while Victory Dance action-locks nodes 47/50',
    },
    provenance:
      'new Surface Nets topology reconstructed from measured source points and normals; base colour is '
      + 'baked to linear vertex RGB and measured material parameters are embedded as TypeScript metadata',
    limitations: [
      'the Stage 1 cross-section loft remains only as the zero-data fallback while the embedded surface module loads',
      'normal-map texels are recorded as present with their scale but are not reproduced as tangent-space raster detail',
      'roughness and metalness textures are represented by measured per-node distributions and runtime medians, not per-fragment texels',
      'physical node ids are not semantic labels until multi-angle renders confirm them',
      'the source reference photo is admitted for visual comparison but was not the original geometry measurement instrument',
      'animation.glb supplies four measured source clips, but Tripo Motion 1 (Staff Twirl) and Tripo Motion 3 are intentionally excluded from runtime; eye pulse and secondary motion for parts without source bones remain authored',
    ],
  };
  root.userData.tick = (deltaSeconds: number): void => warriorRig.update(deltaSeconds);
  if (implicitSurfaces) attachImplicit();
  else void prewarmWarrior().then(attachImplicit).catch((error: unknown) => {
    console.error('[warrior] implicit surfaces unavailable; retaining the measured Stage 1 floor:', error);
  });
  return root;
}

export function createWarriorLookDevLights(): THREE.Group {
  const lights = new THREE.Group();
  lights.name = 'warrior-lookdev';
  lights.add(new THREE.HemisphereLight(0xe5e9f2, 0x15110d, 0.72));
  const key = new THREE.DirectionalLight(0xfff1dd, 1.1);
  key.position.set(1.8, 2.7, 2.4);
  key.castShadow = true;
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xb9ccff, 0.48);
  fill.position.set(-2.0, 1.25, 1.4);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xffc98a, 0.34);
  rim.position.set(-1.2, 2.0, -2.2);
  lights.add(rim);
  return lights;
}
