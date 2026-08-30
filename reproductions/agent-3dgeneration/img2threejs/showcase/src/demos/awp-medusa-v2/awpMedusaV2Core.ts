import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type AWPV2Options = {
  shadows?: boolean;
  wireframe?: boolean;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

type MaterialSet = {
  shell: THREE.MeshPhysicalMaterial;
  metal: THREE.MeshPhysicalMaterial;
  steel: THREE.MeshPhysicalMaterial;
  glass: THREE.MeshPhysicalMaterial;
  rubber: THREE.MeshPhysicalMaterial;
  foil: THREE.MeshPhysicalMaterial;
  black: THREE.MeshPhysicalMaterial;
};

type Runtime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Array<{ id: string; type: 'box'; min: THREE.Vector3; max: THREE.Vector3 }>;
  colliderById: Record<string, THREE.Box3>;
  adjacency: Array<Record<string, unknown>>;
  attachmentGate: Record<string, unknown>;
  attachmentAudit: Record<string, unknown>;
  destructionGroups: Record<string, string[]>;
  logicalComponents: Record<string, { kind: string; binding: string; boundMeshes: string[] }>;
};

const X_REAR = -5.2;
const Z_SHELL = 0.34;

function material(color: number, roughness: number, metalness: number, options: AWPV2Options, extra: Partial<THREE.MeshPhysicalMaterialParameters> = {}): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness,
    metalness,
    clearcoat: metalness > 0.5 ? 0.18 : 0.3,
    clearcoatRoughness: 0.18,
    wireframe: options.wireframe ?? false,
    ...extra,
  });
}

function makeMaterials(options: AWPV2Options): MaterialSet {
  return {
    shell: material(0x07152b, 0.29, 0.04, options, { sheen: 0.08, sheenColor: new THREE.Color(0x123a62) }),
    metal: material(0x1c222b, 0.31, 0.91, options),
    steel: material(0x7d8790, 0.25, 0.96, options),
    glass: material(0x07131d, 0.07, 0.02, options, {
      clearcoat: 1,
      clearcoatRoughness: 0.035,
      transmission: 0.12,
      ior: 1.5,
      envMapIntensity: 1.8,
    }),
    rubber: material(0x0b0d12, 0.78, 0.0, options),
    foil: material(0xc18b22, 0.12, 0.92, options, { clearcoat: 0.9, clearcoatRoughness: 0.08 }),
    black: material(0x020305, 0.46, 0.15, options),
  };
}

function profileGeometry(points: Array<[number, number]>, depth: number, holes: Array<Array<[number, number]>> = [], bevel = 0.025): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  for (const loop of holes) {
    const hole = new THREE.Path();
    hole.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) hole.lineTo(loop[i][0], loop[i][1]);
    hole.closePath();
    shape.holes.push(hole);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 2,
    bevelEnabled: bevel > 0,
    bevelSegments: 3,
    bevelSize: bevel,
    bevelThickness: bevel,
    curveSegments: 8,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function stockProfileGeometry(depth: number, hole: Array<[number, number]>, bevel = 0.04): THREE.ExtrudeGeometry {
  // The stock lower edge is a molded composite contour, not a faceted wedge.
  // Use real 2D quadratic segments before extrusion so the resulting shell
  // stays editable and the curvature survives three-quarter inspection.
  const shape = new THREE.Shape();
  // The shell top sits below the optic's mount line in the admitted plates;
  // keep the cheek/stock shoulder lower instead of letting it merge into the
  // scope silhouette at the top of the fixed broadside frame.
  // Loop-104 hypothesis: alpha-column measurements place the visible stock
  // crown about 0.10–0.17 world units above the retained pass-103 shell from
  // the butt/cheek shoulder through the thumbhole approach. Refit only this
  // upper ownership boundary; the lower contour, hole, buttpad, and all
  // receiver/action stations remain fixed.
  shape.moveTo(X_REAR, 0.52);
  shape.lineTo(-4.82, 0.64);
  shape.lineTo(-4.05, 0.68);
  shape.lineTo(-3.60, 0.5850);
  shape.lineTo(-2.72, 0.5450);
  shape.lineTo(-2.55, 0.5550);
  shape.lineTo(-2.4700, 0.46);
  shape.lineTo(-2.5200, 0.20);
  // Pass-179 contour refit, second half. The measured source grip reaches
  // -0.507 at x -2.83 — deeper than this render's -0.316 and deeper than the
  // old butt tail, so the grip, not the butt, owns the model's lowest point
  // exactly as it does in the reference. Measured bottoms: -2.83 -0.507,
  // -2.97 -0.480, -3.12 -0.425, -3.26 -0.371, -3.40 -0.371, -3.55 -0.398,
  // -3.69 -0.343.
  // The source grip's front face is near-vertical: its bottom rises from -0.507
  // at x -2.73 to -0.097 by x -2.63. A sloping descent from -2.52 filled 0.16-0.27
  // of area the reference leaves empty, so the face is authored as a step. The
  // flat is authored at -0.48 rather than the measured -0.507 because the 0.055
  // bevel renders it 0.027 deeper than authored.
  shape.lineTo(-2.62, 0.02);
  shape.lineTo(-2.74, -0.06);
  // Pass-185c: with the turret crown corrected to the measured 1.49 the bbox top
  // now lands exactly on the reference's row 82, which re-opens the grip depth that
  // pass 179 had to trim. -0.48 was right all along; it only read as too deep while
  // the turret was overshooting by six rows.
  // Pass-201 coupled round: the bevel drop from 0.055 to 0.040 shortens the rendered bbox by exactly
  // one mask row at the bottom (h 74 -> 73) while the top stays on the turret at row 82. Deepening the
  // grip flat by that one row (0.027) restores the exact height, which is what made the bevel change
  // unusable on its own in pass 197.
  shape.lineTo(-2.82, -0.507);
  shape.lineTo(-2.95, -0.507);
  shape.quadraticCurveTo(-3.02, -0.465, -3.12, -0.425);
  shape.quadraticCurveTo(-3.26, -0.371, -3.40, -0.371);
  shape.quadraticCurveTo(-3.55, -0.398, -3.69, -0.343);
  // Pass-179 contour refit, measured per mask column rather than nudged. The
  // source underside is not one continuous edge: it runs the buttpad flat at
  // about -0.343, lifts into a real recess between pad and grip that peaks near
  // -0.10 at x -4.27, then drops away to the grip. This render had a single
  // sloping edge through that span, overfilling the recess by 0.08-0.19.
  // Measured reference bottoms: -3.84 -0.179, -3.98 -0.124, -4.13 -0.124,
  // -4.27 -0.097, -4.41 -0.343, -4.99 -0.343, -5.14 -0.371.
  shape.quadraticCurveTo(-3.82, -0.20, -3.96, -0.13);
  shape.lineTo(-4.27, -0.10);
  shape.lineTo(-4.38, -0.343);
  shape.lineTo(-4.99, -0.343);
  shape.lineTo(-5.14, -0.371);
  shape.lineTo(X_REAR, -0.32);
  shape.closePath();
  const holePath = new THREE.Path();
  holePath.moveTo(hole[0][0], hole[0][1]);
  for (let i = 1; i < hole.length; i += 1) holePath.lineTo(hole[i][0], hole[i][1]);
  holePath.closePath();
  shape.holes.push(holePath);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 2,
    bevelEnabled: bevel > 0,
    bevelSegments: 3,
    bevelSize: bevel,
    bevelThickness: bevel,
    curveSegments: 12,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function stockPistolGripFilletGeometry(depth: number, bevel = 0.035): THREE.ExtrudeGeometry {
  // A separate shell-side receiving fillet closes the transition from the
  // action underside into the trigger guard/pistol-grip area. It is kept as
  // real curved volume so the guard cannot appear to float against a flat
  // receiver slab in orbit views.
  const shape = new THREE.Shape();
  // The source crop shows the trigger guard framed by the molded stock shell,
  // not by a large circular cheek/bulb behind it. Keep a narrow receiving
  // fillet around the guard bridge and let the stock profile own the lower
  // silhouette. This is a profile correction only; the guard station/pivot
  // and its physical overlap remain unchanged.
  // Loop-112 construction hypothesis: the supplied close-up shows a narrow
  // molded receiving fillet around the guard, not a broad secondary grip
  // volume. Shrink the X envelope and seat the thinner shell toward the
  // near-side guard without changing the stock outer silhouette.
  shape.moveTo(-2.40, 0.25);
  shape.lineTo(-2.16, 0.25);
  shape.quadraticCurveTo(-2.10, 0.23, -2.10, 0.17);
  shape.quadraticCurveTo(-2.11, 0.11, -2.17, 0.085);
  shape.quadraticCurveTo(-2.25, 0.06, -2.33, 0.10);
  shape.quadraticCurveTo(-2.40, 0.15, -2.40, 0.25);
  shape.closePath();
  // Loop-120 topology correction: leave a real center opening for the
  // trigger blade and guard. Without this hole the narrowed fillet still
  // occludes the centerline mechanism in three-quarter views.
  const triggerClearance = new THREE.Path();
  triggerClearance.moveTo(-2.36, 0.22);
  triggerClearance.lineTo(-2.20, 0.22);
  triggerClearance.quadraticCurveTo(-2.17, 0.22, -2.17, 0.19);
  triggerClearance.lineTo(-2.17, 0.14);
  triggerClearance.quadraticCurveTo(-2.17, 0.11, -2.20, 0.11);
  triggerClearance.lineTo(-2.36, 0.11);
  triggerClearance.quadraticCurveTo(-2.39, 0.11, -2.39, 0.14);
  triggerClearance.lineTo(-2.39, 0.19);
  triggerClearance.quadraticCurveTo(-2.39, 0.22, -2.36, 0.22);
  triggerClearance.closePath();
  shape.holes.push(triggerClearance);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 2,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize: bevel,
    bevelThickness: bevel,
    curveSegments: 12,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function ellipseLoop(cx: number, cy: number, width: number, height: number, segments = 24): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    points.push([
      cx + Math.cos(angle) * width * 0.5,
      cy + Math.sin(angle) * height * 0.5,
    ]);
  }
  return points;
}

function roundedBox(width: number, height: number, depth: number, radius: number, materialValue: THREE.Material, segments = 4): THREE.Mesh {
  const shape = new THREE.Shape();
  const x = width / 2;
  const y = height / 2;
  const r = Math.min(radius, x, y);
  shape.moveTo(-x + r, -y);
  shape.lineTo(x - r, -y);
  shape.quadraticCurveTo(x, -y, x, -y + r);
  shape.lineTo(x, y - r);
  shape.quadraticCurveTo(x, y, x - r, y);
  shape.lineTo(-x + r, y);
  shape.quadraticCurveTo(-x, y, -x, y - r);
  shape.lineTo(-x, -y + r);
  shape.quadraticCurveTo(-x, -y, -x + r, -y);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSegments: segments,
    bevelSize: Math.min(radius * 0.32, depth * 0.18),
    bevelThickness: Math.min(radius * 0.32, depth * 0.18),
    curveSegments: segments,
  });
  geometry.translate(0, 0, -depth / 2);
  const mesh = new THREE.Mesh(geometry, materialValue);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function tubeBetween(a: THREE.Vector3, b: THREE.Vector3, radius: number, materialValue: THREE.Material, radialSegments = 16): THREE.Mesh {
  const direction = b.clone().sub(a);
  const geometry = new THREE.CylinderGeometry(radius, radius, direction.length(), radialSegments, 2);
  const mesh = new THREE.Mesh(geometry, materialValue);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cylinderX(
  x: number,
  length: number,
  radius: number,
  materialValue: THREE.Material,
  radiusRight = radius,
  openEnded = false,
): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(radius, radiusRight, length, 32, 2, openEnded);
  const mesh = new THREE.Mesh(geometry, materialValue);
  mesh.rotation.z = -Math.PI / 2;
  mesh.position.x = x;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cylinderY(x: number, y: number, z: number, length: number, radius: number, materialValue: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 32, 2), materialValue);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cylinderZ(x: number, y: number, z: number, length: number, radius: number, materialValue: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 24, 2), materialValue);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Objective profile, measured on both broadside plates. The decal conformer and the objective
 *  geometry MUST read the same numbers -- they drifted apart once already, which floated the sticker
 *  off the bell. All values are scope-group local x. */
// Pass-259. The scope main tube was ~28% too thin, found by TWO independent methods that converge to
// within 3.2%:
//   (a) Plate-vs-render like-for-like. Both share the pinned camera and the 1600x900 framing, so no scale
//       factor is involved at all: the render reads a flat 31 px wherever the tube is bare, the plate
//       reads 39 px minimum over clean columns (x 480 and x 640 independently). 0.216 x 39/31 = 0.2717.
//       The barrel confirms the framing is honest: plate 31 px vs render 30 px.
//   (b) ref-02 via the EYEPIECE, an independent third body sharing no authored number with either the
//       tube or the ring stations. eyepiece:ring-separation measures 114.5:237.5 = 0.482 against an
//       authored 0.461 -- agreeing to 4.5% with the ring stations UNCHANGED -- while eyepiece:tube is off
//       by 24%. That asymmetry isolates the tube: if the rings were wrong, both would disagree. Gives
//       0.3895 x 0.72 = 0.2804.
// Set to 0.1360, method (a)'s own value: it is the stronger of the two (no scale factor at all), method
// (b) corroborates it to 3.2%, and a radius sweep shows the gate cannot distinguish it -- FRONT/BACK read
// 0.9134/0.9200 at 0.120, 0.9143/0.9218 at 0.130, 0.9140/0.9215 at 0.138, 0.9140/0.9214 at 0.146,
// 0.9099/0.9182 at 0.156. Flat to 0.0003 across 0.130-0.146, which brackets both reference estimates,
// then falls off sharply outside. The gate was not used to derive the value; it improved on BOTH plates
// afterwards, which is independent confirmation rather than a fit.
//
// This RESOLVES the tube-vs-ring-separation disagreement logged at pass-254: the ring stations are right
// and stay at +/-0.36. It also explains how pass-185 got 0.108 from the same plate -- it measured through
// the forge mask, which erodes dark features (already written up as skill proposal 3), and the tube is
// dark. Both methods above avoid that mask entirely.
const TUBE_R = 0.1360;
const OBJ_TUBE_R = TUBE_R;
const OBJ_BELL_R = 0.2214;
const OBJ_RIM_R = 0.2340;
const OBJ_FLARE_START = 0.5440;
const OBJ_FLARE_END = 1.0660;
const OBJ_BELL_END = 1.3230;
const OBJ_MOUTH = 1.3670;

/** Surface radius of the objective at a scope-local x. */
function objectiveRadiusAt(localX: number): number {
  if (localX <= OBJ_FLARE_START) return OBJ_TUBE_R;
  if (localX < OBJ_FLARE_END) {
    const t = (localX - OBJ_FLARE_START) / (OBJ_FLARE_END - OBJ_FLARE_START);
    return THREE.MathUtils.lerp(OBJ_TUBE_R, OBJ_BELL_R, t);
  }
  if (localX <= OBJ_BELL_END) return OBJ_BELL_R;
  if (localX <= OBJ_MOUTH) return OBJ_RIM_R;
  return OBJ_BELL_R;
}

function conformObjectiveDecalGeometry(
  geometry: THREE.BufferGeometry,
  child: THREE.Object3D,
  stickerX = 1.10,
  stickerY = 0.015,
  verticalScale = 1.22,
): THREE.BufferGeometry {
  const position = geometry.getAttribute('position');
  const taperRadiusAt = (x: number): number => objectiveRadiusAt(x);
  for (let index = 0; index < position.count; index += 1) {
    const localX = position.getX(index);
    const scaledLocalY = position.getY(index) * verticalScale;
    const surfaceX = stickerX - (child.position.x + localX);
    const surfaceRadius = taperRadiusAt(surfaceX);
    const requestedSurfaceY = stickerY + child.position.y + scaledLocalY;
    const surfaceY = THREE.MathUtils.clamp(requestedSurfaceY, -surfaceRadius + 0.002, surfaceRadius - 0.002);
    const adjustedLocalY = surfaceY - stickerY - child.position.y;
    const depth = Math.sqrt(Math.max(0, surfaceRadius * surfaceRadius - surfaceY * surfaceY));
    const surfaceZ = -depth - 0.003;
    // The sticker Group reverses its normal with rotation.y = PI, so negate
    // the scope-local surface z when authoring the child geometry.
    position.setY(index, adjustedLocalY);
    position.setZ(index, -surfaceZ - child.position.z);
  }
  const normal = geometry.getAttribute('normal');
  const radiusSlope = (OBJ_BELL_R - OBJ_TUBE_R) / (OBJ_FLARE_END - OBJ_FLARE_START);
  for (let index = 0; index < position.count; index += 1) {
    const surfaceX = stickerX - (child.position.x + position.getX(index));
    const radius = taperRadiusAt(surfaceX);
    const surfaceY = stickerY + child.position.y + position.getY(index);
    const surfaceZ = -(Math.sqrt(Math.max(0, radius * radius - surfaceY * surfaceY)));
    // The sticker group rotates by PI around Y. Author the inverse normal in
    // child-local space so the world normal points along the actual negative-Z
    // frustum surface rather than the original planar primitive normal.
    const normalX = -radius * radiusSlope;
    const normalY = surfaceY;
    const normalZ = surfaceZ;
    const length = Math.hypot(normalX, normalY, normalZ) || 1;
    normal.setXYZ(index, -normalX / length, normalY / length, -normalZ / length);
  }
  normal.needsUpdate = true;
  position.needsUpdate = true;
  geometry.computeBoundingBox();
  return geometry;
}

function addPart(parent: THREE.Object3D, id: string, mesh: THREE.Mesh, runtime: Runtime): THREE.Group {
  const group = new THREE.Group();
  group.name = id;
  // The viewer's part manifest enumerates selectable meshes, not empty parent
  // Groups, so the mesh carries the semantic component id.
  mesh.name = id;
  group.add(mesh);
  parent.add(group);
  runtime.nodes[id] = group;
  runtime.meshes[id] = mesh;
  return group;
}

function addSocket(parent: THREE.Object3D, id: string, position: THREE.Vector3, axis: THREE.Vector3, runtime: Runtime): THREE.Object3D {
  const socket = new THREE.Object3D();
  socket.name = id;
  socket.position.copy(position);
  socket.userData.socket = { id, axis: axis.toArray() };
  parent.add(socket);
  runtime.sockets[id] = socket;
  return socket;
}

function addFastener(parent: THREE.Object3D, name: string, x: number, y: number, z: number, radius: number, mats: MaterialSet, runtime: Runtime): void {
  const fastener = cylinderZ(x, y, z, 0.075, radius, mats.steel);
  fastener.name = name;
  parent.add(fastener);
  runtime.meshes[name] = fastener;
}

function addScopeHexFastener(parent: THREE.Object3D, name: string, x: number, y: number, z: number, radius: number, mats: MaterialSet, runtime: Runtime): void {
  const fastener = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.075, 6, 1), mats.steel);
  fastener.name = name;
  fastener.rotation.x = Math.PI / 2;
  fastener.position.set(x, y, z);
  fastener.castShadow = true;
  fastener.receiveShadow = true;
  parent.add(fastener);
  runtime.meshes[name] = fastener;
}

function addRail(parent: THREE.Object3D, mats: MaterialSet, runtime: Runtime): void {
  // Pass-155 rollback: preserve the measured pass-154 rail envelope. The
  // scope-mount registration candidate regressed both broadside IoUs and left
  // the front saddle detached, triggering its mandatory rollback contract.
  // Pass-256: depth follows the receiver down. With the receiver at 0.30 a 0.42-deep rail would be wider
  // than the receiver it stands on, and ref-04 shows it clearly narrower. This ratio, unlike the ones that
  // failed for the stock, IS measurable: the rail's top face and the receiver's top face are both
  // horizontal, both unoccluded, and sit at effectively the same distance in ref-04, which is exactly the
  // condition a shared-foreshortening ratio needs. Apparent top-face depths 38 px and 43 px -> 0.88.
  //   rail depth = 0.30 x 0.88 = 0.264
  // Authored 0.42 / 0.54 = 0.78, so the ratio itself was close; it was the absolute pair that was wrong.
  const rail = roundedBox(2.70, 0.1200, 0.2640, 0.025, mats.metal, 3);
  // Pass-190, from ref-07 and ref-06: the source scope rings do not stand on bare rail. They sit
  // on a raised MOUNT BASE plate that runs between them along the rail. Measured: between the ring
  // columns the reference's body below the optic gap tops out at 0.896 while this render topped out at
  // 0.788 (the rail teeth). Raising the rail or the receiver crown instead was tested and both lose
  // monotonically, because they lift the columns that already agree; the missing height belongs to a
  // part that does not exist here yet.
  // Pass-266, UNRESOLVED CONFLICT -- `scope-mount-base` is kept for now, and here is why.
  // A delegated audit found no such plate in two independent 3D views: in ref-04 each ring leg lands directly
  // on its own run of rail teeth and the gap between the feet drops straight to the rail's normal surface, and
  // in ref-07 the ribbed pattern runs continuous and flat under the whole inter-ring span at one height. I
  // accept that reading -- this plate is very probably the wrong SHAPE.
  // But deleting it cost FRONT 0.9152 -> 0.9058 and BACK 0.9187 -> 0.9067, regressing FRONT bands 4-6 and BACK
  // bands 9-11 together, and that is not a perspective artifact: pass-190 measured on the plates that the
  // reference's body below the optic gap tops out at 0.896 while the rail teeth reach only 0.788. Something
  // real occupies that height. So the part is MISIDENTIFIED, not imaginary, and deleting it leaves a measured
  // void rather than removing a fabrication.
  // The two findings are compatible: the height could belong to taller ring legs, a higher rail, or a raised
  // receiver crown -- pass-190 tested the latter two and both lost, but that was against the OLD too-thin tube
  // and the OLD 4x-too-tall rail teeth, so those trials are void and must be redone. The pass that removes
  // this plate has to supply the real occupant in the same change; removing it alone is not an improvement.
  const mountBase = roundedBox(1.3500, 0.16, 0.2500, 0.020, mats.metal, 3);
  mountBase.name = 'scope-mount-base';
  mountBase.position.set(-1.5250, 0.79, 0);
  parent.add(mountBase);
  runtime.meshes['scope-mount-base'] = mountBase;
  rail.name = 'receiver-top-rail';
  rail.position.set(-0.55, 0.6500, 0);
  parent.add(rail);
  // Diagnostic registration only: preserve the retained pass-128 geometry and
  // transforms while allowing the measurement probe to isolate the rail owner.
  runtime.meshes[rail.name] = rail;
  // Pass-254, rail teeth. ref-02 shows the rail's toothed top edge as a SILHOUETTE against background
  // in the daylight gap under the optic, so the pattern can be counted directly instead of inferred.
  // Six consecutive cycles measured at step 1 over x 466..628 (between the two ring legs, where nothing
  // occludes the edge) put the slot floors at x 476/502/529/558/586/613 -> pitches 26/27/29/28/27,
  // mean 27.4 px, with the edge swinging between a 248-249 tooth top and a 256-258 slot floor, so
  // amplitude 8.5 px, and 20 of every 27.4 columns below the midpoint, so tooth duty 0.73.
  //
  // The px->world scale is NOT settled: the tube diameter gives 0.002335 world/px while the ring
  // separation gives 0.003032, a 30% disagreement recorded as its own open measurement item. The rail
  // conclusion survives either, because both comparisons are dimensionless:
  //   pitch / tube diameter   ref 27.4/92.5 = 0.296  vs authored 0.19/0.216 = 0.880  -> 2.97x too coarse
  //   pitch / ring separation ref 27.4/237.5 = 0.115  vs authored 0.19/0.72 = 0.264  -> 2.29x too coarse
  //   height / tube diameter  ref  8.5/92.5 = 0.092  vs authored 0.080/0.216 = 0.370 -> 4.0x too tall
  //   height / ring separation ref 8.5/237.5 = 0.036  vs authored 0.080/0.72 = 0.111 -> 3.1x too tall
  // So the teeth were 2.3-3.0x too coarse and 3.1-4.0x too tall whichever scale is right. Converted on
  // the tube scale, the better-evidenced of the two (radius 0.108 came from a per-column plate scan):
  // pitch 0.0640, tooth width 0.73 x 0.0640 = 0.0467, height above the rail 0.0198.
  //
  // Depth also corrected. The teeth were 0.44 deep on a 0.42-deep rail, so every tooth overhung the rail
  // it stands on -- clearly visible in the orbit-right render as a row of protruding blocks. ref-04 shows
  // the opposite: the slots are cut INTO the rail's top and the ribs never pass its side faces. Inset to
  // 0.38. The toothed SPAN is deliberately unchanged: its two candidate values (1.39 vs 1.80) differ by
  // the same unresolved scale, and the current span is anchored to a rail base the plates already accept.
  // Rib COUNT is the one quantity here immune to both foreshortening and the scale ambiguity, because
  // counting is. Two independent methods agree: ref-02 gives 594 px of toothed edge / 27.4 px pitch =
  // 21.7 pitches, and directly counting ribs in ref-07 (5 left of the rear ring, ~9 between, ~4 right of
  // the front ring, ~3 hidden under each ring) gives 24-25. So ~23 ribs, NOT the 15 authored and NOT the
  // 42 that pitch 0.0640 produces over the old 2.66 span.
  //
  // Pitch is anchored to the RING SEPARATION rather than to the tube, which also resolves which end of
  // the scale ambiguity to trust. ref-02 puts 237.5 px of ring separation over a 27.4 px pitch = 8.67
  // pitches between the rings. Anchoring there keeps the assembly self-consistent -- the rings physically
  // clamp onto these ribs, so their spacing is the relationship that has to hold -- and it does not
  // depend on resolving the tube-vs-rings disagreement first:
  //   pitch = ring separation / 8.67 = 0.72 / 8.67 = 0.0830
  // Note the two options are consistent with each other, which is why the count is safe either way: if
  // the tube diameter is the correct anchor instead, the rings belong at +/-0.278 and the pitch is 0.0640,
  // and 23 ribs still span 22 pitches. Count and relative layout are settled; only absolute scale is not.
  const RAIL_TOP = 0.6500 + 0.1200 / 2;
  const TOOTH_PITCH = 0.0830;
  const TOOTH_HEIGHT = 0.0280;
  const TOOTH_COUNT = 23;
  for (let i = 0; i < TOOTH_COUNT; i += 1) {
    const tooth = roundedBox(0.0415, TOOTH_HEIGHT, 0.2390, 0.006, mats.steel, 2);
    tooth.name = `rail-tooth-${i + 1}`;
    // Top lands 0.0198 above the rail surface, the measured amplitude; the remainder of the box is
    // buried in the rail so the rib is seated rather than balanced on it.
    // Started at the rail base's rear end. The reference actually centres the toothed run on the ring
    // pair, which would put it at x -2.49..-0.67 -- 0.59 BEHIND this rail's rear end. That is a real
    // finding about the rail base (too long at 2.70, and shifted too far forward relative to the rings),
    // logged with the ring-separation item, and deliberately not fixed here: it moves the silhouette and
    // belongs in its own pass with a rollback contract, not bolted onto a tooth-size correction.
    tooth.position.set(-1.88 + i * TOOTH_PITCH, RAIL_TOP + 0.0198 - TOOTH_HEIGHT / 2, 0);
    parent.add(tooth);
    runtime.meshes[tooth.name] = tooth;
  }
}

// Pass-185 spec-level correction. Per-column mask measurement of the source optic:
// eyepiece height 0.324, mid-tube height 0.216 (radius 0.108, centre y 1.193), turret
// crown to 1.490, bell 0.41-0.46, and a real 6-7 row gap of daylight between the tube's
// underside and the receiver top at 0.87-0.90. This render carried a 0.2632-radius tube
// sitting at 1.063, fused to the receiver with no gap at all.
// That reading was wrong from the start, which also reinterprets two retained passes:
// pass 165's lift and pass 173's diameter growth both scored by adding material at the
// optic's TOP edge, where the reference has material and this render did not, while the
// region below was already solid so the added diameter cost nothing. They compensated for
// an optic sitting too low rather than one too thin. The measured values below supersede
// both outright, so the audit is done by replacement rather than by re-testing them.
function addScope(parent: THREE.Object3D, mats: MaterialSet, runtime: Runtime): THREE.Group {
  const group = new THREE.Group();
  group.name = 'scope';
  // The source optic sits low against the rail; the previous 1.14 station made
  // the objective and rings visibly float above the receiver in broadside view.
  // The source optic sits low against the rail; the previous 1.14 station made
  // the objective and rings visibly float above the receiver in broadside view.
  // Calibrated source fit: the prior vertical raise caused a large broadside
  // framing regression, so the optic remains at the measured station.
  // Pass-165, fitted under the pinned review camera: the reference shows an
  // interior air gap between tube bottom and rail top that this render filled
  // with hardware. A lift sweep (0.022/0.033/0.044/0.055/0.066) raised both
  // broadside IoUs monotonically, but aspect delta worsened from 0.044 upward
  // because the turret crown — not the tube — already sets the model's top edge.
  // 0.033 is the largest lift where no proportion gate regresses. The optic and
  // its clamps rise as one rigid body; the saddle posts below grow by the same
  // 0.033 so the rail contact is preserved by construction.
  group.position.set(-1.58, 1.193, 0);
  parent.add(group);
  runtime.nodes.scope = group;

  // Loop-101 construction hypothesis: the ocular housing and rear lip are
  // slimmer than the current broad cylinder in the source crop. Keep its
  // axial station, collar and recessed real glass fixed; reduce only the
  // ocular radial profile, leaving the reflective material locked until the
  // macro silhouette gate permits look-dev work.
  // Pass-162 rollback: the coupled non-uniform radial profile (reduce radius,
  // raise local centre by the same delta, per body owner) improved FRONT IoU by
  // only +0.0004 while BACK regressed -0.0019, which its own contract makes a
  // mandatory rollback. Restore the retained pass-157 radial profile.
  // Both ocular housings are sleeves: their rear caps were occluding the glass and producing the
  // black radial fan visible from the eye station. The objective uses the same open bore pattern.
  addPart(group, 'scope-eyepiece', cylinderX(-1.0304, 0.5152, 0.1620, mats.metal, 0.1700, true), runtime);
  // Pass-262, user report: this ring "nhô cao lên" -- it stood too proud. It was a TorusGeometry whose
  // outer radius reached 0.1990 against a 0.1700 eyepiece, so it hooped 0.0290 (17.1%) above the surface it
  // sits on. The objective end of the same optic does the equivalent feature correctly and is the pattern to
  // copy: `scope-objective-rim` is a short flat CYLINDER band at r 0.2340 over a 0.2214 bell, standing only
  // 0.0126 proud (5.7%). Matching that proportion on the eyepiece gives 0.1700 x 1.057 = 0.1797, and the
  // same 0.0440 axial length -- a thin machined band rather than a raised hoop. Station unchanged.
  // Pass-264, two user reports. (1) The rim belonged at the END of the eyepiece, not 0.110 forward of it in
  // mid-body. (2) The numbered rings were missing entirely.
  // Measured on ref-02 at 3x, scale 0.272/92.5 = 0.00294 world/px off the tube diameter, distances taken from
  // the eyepiece's rear face at ref-02 x 65. The ocular end carries TWO distinct bands, not one:
  //   knurled band   ref-02 x  73.3..116.7 -> 0.0244..0.1520 from the rear face -> model x -1.2636..-1.1360
  //   numbered ring  ref-02 x 203.3..240.0 -> 0.4067..0.5146 from the rear face -> model x -0.8813..-0.7734
  // The numbered ring sits at the FORWARD end of the eyepiece where it meets the collar, which is why it read
  // as absent -- nothing was there at all. The printed digits themselves ("11 12 13 14" on the ocular, and the
  // turret's own graduations) are PROJECTED SURFACE work, not geometry, and belong to surface-pass; what is
  // added here is the physical band each set of digits is printed on.
  const ocularRim = cylinderX(-1.2660, 0.0440, 0.1797, mats.steel, 0.1797, true);
  ocularRim.name = 'scope-ocular-rim';
  group.add(ocularRim);
  runtime.meshes['scope-ocular-rim'] = ocularRim;
  const ocularKnurl = cylinderX(-1.1998, 0.1276, 0.1780, mats.steel);
  ocularKnurl.name = 'scope-ocular-knurl-band';
  ocularKnurl.userData.role = 'knurled-diopter-band-at-ocular-end';
  group.add(ocularKnurl);
  runtime.meshes['scope-ocular-knurl-band'] = ocularKnurl;
  // Proud of the eyepiece's 0.1620 forward radius by the same 5.7% the objective rim uses.
  const magRing = cylinderX(-0.8274, 0.1079, 0.1712, mats.metal);
  magRing.name = 'scope-magnification-ring';
  magRing.userData.role = 'numbered-magnification-collar';
  magRing.userData.surfacePassNote = 'carries the printed 7-14 magnification digits; digits are projected, not geometry';
  group.add(magRing);
  runtime.meshes['scope-magnification-ring'] = magRing;
  // The shooter's eye station, published as a socket so the viewer can offer a look-through-the-optic
  // mode without knowing anything about this model. Placed one eye-relief behind the ocular face
  // (-1.2880) on the optical axis, aiming down the bore toward the muzzle.
  const sightLine = addSocket(group, 'scope-sight-line', new THREE.Vector3(-1.6400, 0, 0), new THREE.Vector3(1, 0, 0), runtime);
  sightLine.userData.role = 'eye-relief-station-on-the-optical-axis';
  sightLine.userData.optic = { fovDegrees: 6.2, eyeReliefFromOcular: 0.3520 };
  // Flush the real glass to the rear ocular face, mirroring the exposed objective-glass station.
  const ocularGlass = addPart(group, 'scope-glass-eyepiece', cylinderX(-1.2880, 0.0166, 0.1300, mats.glass), runtime);
  ocularGlass.position.z = 0;

  // The front station correction is only valid when the optic remains one
  // continuous tube. Preserve the ocular-side endpoint and extend the main
  // tube forward to overlap the moved taper by a small physical margin.
  addPart(group, 'scope-main-tube', cylinderX(0.1104, 1.3340, TUBE_R, mats.metal), runtime);
  // Bridge the ocular and main tube with a real sleeve. The two broadside
  // references show one continuous optic body; leaving this as two touching
  // silhouettes creates a visible floating component in orbit views.
  // The reference has NO collar shelf here: cols 63.0-69.3 are one continuous monotonic taper from
  // 0.133 down to the tube's 0.108, where this was authored as a flat 0.115 step -- the same
  // shape-class error as the objective, a smooth run replaced by a discrete step. Kept as its own
  // mesh so it still owns its material, but given the taper's radii instead of a constant.
  addPart(group, 'scope-ocular-collar', cylinderX(-0.6608, 0.2976, TUBE_R, mats.metal, 0.1700), runtime);
  // Pass-96 construction hypothesis: the source objective bell is slimmer
  // than the former over-sized frustum. Keep the axial station and all ring
  // hardware fixed; reduce only the bell/rim/recessed-glass profile together.
  // Pass-186, from `.img2threejs/references/scope-front-reference.png`: the source objective is
  // NOT a long cone. The tube runs straight, steps up over a SHORT shoulder, then continues as a
  // straight wide cylinder to the mouth. A 0.66-long cone from 0.108 to 0.205 rendered as a funnel,
  // which is a wrong shape class rather than a wrong dimension.
  // Pass-187: the zoomed reference comparison shows a LONG SMOOTH flare over roughly a third of
  // the scope, then a short straight mouth. Pass 186 replaced it with a short step plus a straight
  // cylinder, which read as a hammer head — that was the wrong direction, and the original long
  // cone was closer. Measured radii are kept; only the shape class is restored.
  addPart(group, 'scope-objective-taper', cylinderX((OBJ_FLARE_START + OBJ_FLARE_END) / 2, OBJ_FLARE_END - OBJ_FLARE_START, OBJ_BELL_R, mats.metal, OBJ_TUBE_R), runtime);
  const objectiveBell = cylinderX((OBJ_FLARE_END + OBJ_BELL_END) / 2, OBJ_BELL_END - OBJ_FLARE_END, OBJ_BELL_R, mats.metal);
  objectiveBell.name = 'scope-objective-bell';
  group.add(objectiveBell);
  runtime.meshes['scope-objective-bell'] = objectiveBell;
  const objectiveRim = cylinderX((OBJ_BELL_END + OBJ_MOUTH) / 2, OBJ_MOUTH - OBJ_BELL_END, OBJ_RIM_R, mats.steel);
  objectiveRim.name = 'scope-objective-rim';
  group.add(objectiveRim);
  runtime.meshes['scope-objective-rim'] = objectiveRim;
  // Keep each lens as one recessed physical surface. The old duplicate
  // eyepiece mesh occupied the same station and could z-fight in orbit views.
  addPart(group, 'scope-objective-glass', cylinderX(1.3600, 0.0166, 0.1900, mats.glass), runtime);

  // Pass-186, from the scope reference crop: the turret is a squared SADDLE BASE on the tube,
  // then a stepped drum, then a knurled cap whose crown is the model's highest point at
  // 0.297 above the tube centre. A plain drum plus a knob missed all three steps.
  const turretHousing = addPart(group, 'scope-turret-housing', roundedBox(0.22, 0.30, 0.30, 0.020, mats.metal, 3), runtime);
  turretHousing.position.x = 0.0244;
  turretHousing.userData.role = 'central-machined-turret-housing';
  // Narrow graduation ring. Two independent readings agree the reference turret is an hourglass:
  // a column-width scan of both plates gives cap 4.1-4.3 cols, waist 2.97-3.50, housing top 4.5-5.2,
  // and the 3D set gives the stack as tube / housing / NARROWER numbered ring / knurled cap. This
  // cylinder sat here at r 0.120 as the WIDEST part, so the render measured a flat 4.90 cols with no
  // waist at all. It spans world y 1.343..1.399 (rows 84.2-86.3), where the measured width is 3.1 cols.
  const turretShoulder = cylinderY(0.0244, 0.1780, 0, 0.0560, 0.0690, mats.metal);
  turretShoulder.name = 'scope-turret-shoulder';
  group.add(turretShoulder);
  runtime.meshes['scope-turret-shoulder'] = turretShoulder;

  // Pass-155 rollback: restore the pass-154 ring stations after the wider
  // registration candidate failed its global-IoU and dual-contact gates.
  for (const [id, x] of [['scope-ring-rear', -0.3600], ['scope-ring-front', 0.3600]] as const) {
    // Real scope rings are split clamps, not a single uninterrupted decorative
    // torus. Two opposed half-rings leave a controlled clamp seam while the
    // saddle and cap remain separate hardware at the same station.
    // Pass-91 construction hypothesis: the source ring is a thin split clamp
    // carried by a chamfered U-saddle, not a stack of rectangular blocks. Keep
    // the tube/ring station fixed and change only the support profile.
    // Pass-186, from the scope reference crop: a source ring is a rectangular split CLAMP BLOCK with
    // a flat top and two hex screws on its face, not a decorative torus. Two jaws leave a real seam
    // at the tube centreline; the torus pair read as thin hoops that the reference does not have.
    // Pass-260, consequence of TUBE_R growing to 0.1360 in pass-259. The jaws spanned y 0.0055..0.1305,
    // standing 0.0225 proud of the old 0.108 tube surface -- which is the relationship the reference shows,
    // the clamp reading wider than the tube it holds. At 0.1360 the tube surface is OUTSIDE the jaw, so the
    // tube poked through its own clamp and the ring stopped defining the silhouette at its station. That is
    // band 7, the only band pass-259 regressed. Preserving the 0.0225 margin: outer 0.1585, so height
    // 0.1530 and centre 0.0820, leaving the 0.011 clamp seam at the centreline untouched.
    const ring = roundedBox(0.14, 0.125, 0.26, 0.018, mats.steel, 2);
    ring.position.y = 0.068;
    const ringGroup = addPart(group, id, ring, runtime);
    const lowerRing = roundedBox(0.14, 0.125, 0.26, 0.018, mats.steel, 2);
    lowerRing.name = `${id}-lower-half`;
    lowerRing.position.y = -0.068;
    ringGroup.add(lowerRing);
    runtime.meshes[`${id}-lower-half`] = lowerRing;
    // Keep the ring's authored station on the component group so its saddle
    // and real fasteners inherit the same transform. Previously only the torus
    // carried x, leaving the mount blocks at the scope group's origin.
    ringGroup.position.x = x;
    ring.position.x = 0;
    // The source shows a narrow U-shaped saddle under each split ring. A
    // single solid block made the mount read as a floating LEGO cube in orbit;
    // keep the ring station unchanged and build the support from two real
    // cheek posts plus the cap that seats on the rail.
    for (const [suffix, z] of [['near', -0.14], ['far', 0.14]] as const) {
      // Measured on both plates: the reference bridges the tube-to-rail gap over ~4 mask columns
      // (0.19 world) at FULL width per ring, where this post tapered to +/-0.022-0.028 and bridged only
      // ~2 columns. Stacked between the wide clamp plate below and the wide ring block above, that waist
      // read as a bowtie; the reference is a straight U-clamp flange. Widened through the whole run it
      // occupies in the gap, held just inside the tube radius (TUBE_R, 0.1360 since pass-259) at the contact so the post never
      // reads wider than the tube it carries.
      const saddlePostGeometry = profileGeometry([
        [-0.0425, -0.1530],
        [0.0425, -0.1530],
        [0.0710, -0.1360],
        [0.0710, -0.0680],
        [0.0710, 0.075],
        [0.0660, 0.165],
        [-0.0660, 0.165],
        [-0.0710, 0.075],
        [-0.0710, -0.0680],
        [-0.0710, -0.1360],
      ], 0.05, [], 0.012);
      const saddlePost = new THREE.Mesh(saddlePostGeometry, mats.metal);
      saddlePost.castShadow = true;
      saddlePost.receiveShadow = true;
      saddlePost.name = `${id}-${suffix}-saddle-post`;
      saddlePost.position.set(0, -0.27, z);
      ringGroup.add(saddlePost);
      runtime.meshes[saddlePost.name] = saddlePost;
    }
    const clampCap = roundedBox(0.085, 0.045, 0.32, 0.012, mats.metal, 3);
    clampCap.name = `${id}-clamp-cap`;
    clampCap.position.set(0, 0.115, 0);
    ringGroup.add(clampCap);
    const clampPlateGeometry = profileGeometry([
      [-0.0375, -0.13],
      [0.0375, -0.13],
      [0.045, -0.085],
      [0.029, -0.035],
      [0.029, 0.075],
      [0.041, 0.13],
      [-0.041, 0.13],
      [-0.029, 0.075],
      [-0.029, -0.035],
      [-0.045, -0.085],
    ], 0.035, [], 0.012);
    const clampPlate = new THREE.Mesh(clampPlateGeometry, mats.steel);
    clampPlate.castShadow = true;
    clampPlate.receiveShadow = true;
    clampPlate.name = `${id}-clamp-plate`;
    clampPlate.position.set(0, -0.015, 0.25);
    ringGroup.add(clampPlate);
    runtime.meshes[`${id}-clamp-plate`] = clampPlate;
    addScopeHexFastener(ringGroup, `${id}-front-fastener`, 0, -0.28, 0.195, 0.022, mats, runtime);
    addScopeHexFastener(ringGroup, `${id}-back-fastener`, 0, -0.28, -0.195, 0.022, mats, runtime);
    addScopeHexFastener(ringGroup, `${id}-upper-fastener`, 0, 0.10, 0.275, 0.020, mats, runtime);
    addScopeHexFastener(ringGroup, `${id}-lower-fastener`, 0, -0.10, 0.275, 0.020, mats, runtime);
  }

  const turret = cylinderY(0.0100, 0.2530, 0, 0.0940, 0.095, mats.metal);
  turret.name = 'scope-turret-main';
  group.add(turret);
  for (let i = 0; i < 16; i += 1) {
    const notch = roundedBox(0.022, 0.05, 0.022, 0.004, mats.steel, 1);
    const angle = (i / 16) * Math.PI * 2;
    notch.position.set(0.0100 + Math.cos(angle) * 0.095, 0.275, Math.sin(angle) * 0.095);
    group.add(notch);
  }
  // Pass-253, windage turret. Measured, NOT re-dimensioned: the two things that could be read off the
  // plates were already right and are deliberately unchanged. ref-02 views this knob down its own axis,
  // so its diameters there are unforeshortened: hex across-flats 80px against a tube diameter of 93px
  // (tube measured numerically at ref-02 cols 364/472/616, span 92/96/94), giving 0.86 of the tube --
  // the retired cylinder's 0.190/0.216 was 0.88, inside measurement error. Total protrusion from ref-04,
  // summing the three axial segments along the knob's TOP edge to avoid the diameter term that
  // contaminates a whole-silhouette extent, de-foreshortened by the end face's own 95:220 aspect
  // (theta ~25.5 deg): 0.82 of the hex diameter = 0.152, against the retired 0.16. Also inside error.
  // What was actually wrong is the SHAPE CLASS -- the same failure this project already made on the
  // objective bell and the ocular collar. Both references show a stepped stack, not one smooth drum:
  // a wide circular boss on the housing, a narrower stem, then a flat-topped HEX cap nut with a
  // recessed socket in its end face. Scale below is 0.186 world / 118.6 ref-04 px, set by the hex.
  const sideTurretBoss = cylinderZ(0.0100, 0.02, 0.16225, 0.0445, 0.1020, mats.metal);
  sideTurretBoss.name = 'scope-turret-side-boss';
  group.add(sideTurretBoss);
  runtime.meshes['scope-turret-side-boss'] = sideTurretBoss;
  // Diameter NOT determinable: the hex occludes this stem in ref-04 and hides it entirely in ref-02's
  // axial view. Held just under the hex across-flats so it stays hidden exactly as both views show it,
  // rather than inventing a value the references cannot support. Recorded in perRegionConfidence.
  const sideTurretStem = cylinderZ(0.0100, 0.02, 0.2092, 0.0494, 0.0880, mats.metal);
  sideTurretStem.name = 'scope-turret-side-stem';
  group.add(sideTurretStem);
  runtime.meshes['scope-turret-side-stem'] = sideTurretStem;
  // Circumradius from across-flats: 0.186 / (2 cos 30) = 0.107. The geometry is spun 30 deg about its
  // own axis because an unrotated 6-segment cylinder puts a VERTEX at world +y, and ref-02 shows a
  // flat on top.
  const hexCapGeometry = new THREE.CylinderGeometry(0.1070, 0.1070, 0.0594, 6, 1);
  hexCapGeometry.rotateY(Math.PI / 6);
  const sideTurret = new THREE.Mesh(hexCapGeometry, mats.metal);
  sideTurret.rotation.x = Math.PI / 2;
  sideTurret.position.set(0.0100, 0.02, 0.2636);
  sideTurret.castShadow = true;
  sideTurret.receiveShadow = true;
  sideTurret.name = 'scope-turret-side';
  group.add(sideTurret);
  runtime.meshes['scope-turret-side'] = sideTurret;
  // The socket rim on the end face, read at 62.9 ref-04 px across its unforeshortened axis -> r 0.049.
  // A rim torus, not a cut: this build has no CSG, and a disc sunk inside the cap would be invisible.
  // Pass-266: the SECOND side turret, which the model was missing entirely. Both ref-10 and ref-03 show a
  // hex-capped knob on each side of the elevation housing. Size taken from ref-10, NOT ref-03: in the top-down
  // view both knobs sit at the same height and are symmetric about the axis, so their reaches compare fairly
  // (39.5 px against 36.5 px from the tube centre, ratio 1.08 -- near-equal). A delegated read of ref-03 gave
  // 0.73-0.78, but ref-03 is the steeply-foreshortened axial view this project's own reference index marks as
  // "proportions not trustworthy", and a slightly off-axis view there magnifies whichever knob is nearer --
  // which is exactly the artifact that would manufacture a 0.75. Rejected in favour of the top-down reading.
  // Built as the same stack mirrored onto -Z with its axial stations scaled 0.87 so the reach matches the
  // measured 36.5 px, radii unchanged; not an exact duplicate, but not three-quarter scale either.
  for (const [name, z, len, r] of [
    ['scope-turret-side2-boss', -0.1412, 0.0445, 0.1020],
    ['scope-turret-side2-stem', -0.1820, 0.0494, 0.0880],
  ] as const) {
    const part = cylinderZ(0.0100, 0.02, z, len, r, mats.metal);
    part.name = name;
    group.add(part);
    runtime.meshes[name] = part;
  }
  const hexCap2Geometry = new THREE.CylinderGeometry(0.1070, 0.1070, 0.0594, 6, 1);
  hexCap2Geometry.rotateY(Math.PI / 6);
  const sideTurret2 = new THREE.Mesh(hexCap2Geometry, mats.metal);
  sideTurret2.rotation.x = Math.PI / 2;
  sideTurret2.position.set(0.0100, 0.02, -0.2293);
  sideTurret2.castShadow = true;
  sideTurret2.receiveShadow = true;
  sideTurret2.name = 'scope-turret-side2';
  group.add(sideTurret2);
  runtime.meshes['scope-turret-side2'] = sideTurret2;
  const sideTurret2Socket = new THREE.Mesh(new THREE.TorusGeometry(0.0490, 0.0080, 8, 24), mats.steel);
  sideTurret2Socket.position.set(0.0100, 0.02, -0.2552);
  sideTurret2Socket.castShadow = true;
  sideTurret2Socket.name = 'scope-turret-side2-socket';
  group.add(sideTurret2Socket);
  runtime.meshes['scope-turret-side2-socket'] = sideTurret2Socket;
  const sideTurretSocket = new THREE.Mesh(new THREE.TorusGeometry(0.0490, 0.0080, 8, 24), mats.steel);
  sideTurretSocket.position.set(0.0100, 0.02, 0.2933);
  sideTurretSocket.castShadow = true;
  sideTurretSocket.name = 'scope-turret-side-socket';
  group.add(sideTurretSocket);
  runtime.meshes['scope-turret-side-socket'] = sideTurretSocket;

  // The foil is a thin, attached side decal. It is geometry on the taper surface,
  // not a floating badge and not used to establish the optic silhouette.
  const sticker = new THREE.Group();
  sticker.name = 'crown-skull-sticker';
  // The crown/skull is visible on the opposing broadside. Keep it on the
  // negative-Z shell and reverse the decal normal so the crown remains above
  // the skull when viewed from that side.
  // Pass-150 correction: the sticker is a thin surface conforming to the
  // negative-Z objective frustum, not a planar badge translated through it.
  // Measured on the back plate: the decal spans scope-local x 0.813..1.186, centred at 1.000 --
  // it sits mostly on the FLARE, not the straight bell, and does not touch the mouth rim.
  // Fitted to the decal's own measured footprint rather than to the plane's nominal size: the gold's
  // mask bbox reads cols 120.9-128.0 x rows 85.4-100.6 in the reference against 122.4-128.0 x
  // 87.4-95.6 at the first attempt, so the patch is scaled 1.27x along the bore and 1.85x around it
  // and re-centred. Wrapping onto the cylinder compresses apparent height, which is why the plane
  // must be larger than the footprint it should produce.
  sticker.position.set(1.0370, -0.0255, 0);
  sticker.rotation.y = Math.PI;
  // PROJECTION, not procedural authoring. The decal is an ornate filigree crown with a decorated brim
  // band over a real skull (rounded cranium, two sockets, nasal opening, tapering jaw). It had been
  // approximated by a 7-point zigzag Shape plus a CircleGeometry with two dots, which is exactly the
  // failure mode the skill warns about for a patterned surface: a procedural stand-in for reference art.
  // The texture is cut from back-medusa.webp's own pixels, alpha-keyed on the gold's saturation with
  // enclosed holes filled so the eye sockets stay opaque. Using the pixels also sidesteps the brim
  // band's lettering, which is not reliably legible at plate resolution.
  const decalMap = new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}awp-medusa-crown-skull-decal.png`);
  decalMap.colorSpace = THREE.SRGBColorSpace;
  decalMap.anisotropy = 4;
  const decalMaterial = mats.foil.clone();
  decalMaterial.map = decalMap;
  decalMaterial.color = new THREE.Color(0xffffff);
  // alphaTest rather than transparent: a die-cut decal wants a hard cutout, and this keeps it out of
  // the transparency sort where it would flicker against the bell it rides on.
  decalMaterial.alphaTest = 0.5;
  decalMaterial.transparent = false;
  const decal = new THREE.Mesh(new THREE.PlaneGeometry(0.4740, 0.5000, 28, 28), decalMaterial);
  decal.name = 'crown-skull-decal';
  conformObjectiveDecalGeometry(decal.geometry, decal, sticker.position.x, sticker.position.y);
  sticker.add(decal);
  runtime.meshes['crown-skull-decal'] = decal;
  group.add(sticker);
  runtime.nodes['crown-skull-sticker'] = sticker;
  return group;
}

function addBolt(parent: THREE.Object3D, mats: MaterialSet, runtime: Runtime): void {
  // Loop-118 construction contract: this is a receiver-parented bolt-action
  // assembly, not a loose lever. The raceway stays with the receiver; the
  // sliding bolt sleeve owns the handle-root socket; body, handle and knob
  // share one cycle transform while the handle root owns its own lift hinge.
  // The source crop places the handle immediately behind the rear scope
  // saddle, with a long down-and-rearward lever below the optic. The lever
  // is a near-side mechanism; do not mirror it onto the far side just to make
  // a top camera reveal it.
  const raceway = addPart(parent, 'bolt-raceway', new THREE.Mesh(
    roundedBox(1.42, 0.10, 0.30, 0.018, mats.black, 3).geometry,
    mats.black,
  ), runtime);
  // The bolt axis shares the barrel/rail centerline. The earlier z=0.28
  // placement put the entire sleeve on the near side of the receiver, so the
  // action read as a silver floating block instead of a seated mechanism.
  raceway.position.set(-1.52, 0.54, 0);
  raceway.userData.role = 'receiver-integrated-bolt-raceway-guide';

  const pivot = new THREE.Group();
  pivot.name = 'bolt';
  const basePosition = new THREE.Vector3(-2.24, 0.57, 0);
  pivot.position.copy(basePosition);
  pivot.userData.role = 'receiver-parented-functional-bolt-action';
  pivot.userData.control = {
    type: 'bolt-action',
    travelAxis: 'x',
    travelRange: 0.12,
    lockRotationAxis: 'z',
    lockRotationRange: 0.16,
    receiverInterface: 'bolt-raceway',
    handleRootSocket: 'bolt-handle-root',
    handleSide: 'near-side-positive-z',
  };
  parent.add(pivot);
  runtime.nodes.bolt = pivot;

  // The sleeve begins at the handle root and runs forward inside the static
  // raceway. In the source crop the moving bolt is a compact coaxial machined
  // cylinder; the earlier long rectangular slab made the action read as a
  // floating box and hid the actual receiver-side relief. Keep the moving
  // part concentric with the barrel/rail axis and let the small upper shroud
  // provide the visible flat machining edge.
  const body = addPart(pivot, 'bolt-body', cylinderX(0, 0.86, 0.145, mats.steel, 0.155), runtime);
  body.position.set(0.58, 0, 0);
  body.userData.role = 'coaxial-sliding-bolt-sleeve-inside-receiver-raceway';

  // Loop-125 visibility/form correction: the source shows a bright machined
  // bolt head/action block immediately below the rear scope saddle. A dark
  // low shroud made the previous pass read as only a floating side boss from
  // the top stress view. Keep the moving pieces body-owned and overlapping;
  // make the visible metal station read as one seated action assembly.
  const shroud = addPart(body, 'bolt-shroud', new THREE.Mesh(
    roundedBox(0.62, 0.22, 0.28, 0.024, mats.steel, 4).geometry,
    mats.steel,
  ), runtime);
  // Source-crop station: the visible action block terminates at the same rear
  // face as the handle-root socket. Keep the height small enough to remain a
  // machined receiver detail, but expose its upper edge above the receiver so
  // the component is observable in the top/three-quarter stress views.
  shroud.position.set(-0.31, 0.17, 0);
  shroud.userData.role = 'rear-face-sliding-bolt-shroud-seated-at-handle-station';
  shroud.userData.contact = 'overlaps bolt-body and receiver raceway while cycling';

  // The rear face is a short squared bolt-head/cocking block, not empty space
  // behind the round sleeve. It is deliberately a child of the moving body:
  // it seats into the receiver relief, remains attached while cycling, and
  // provides the real upper/side silhouette visible around the scope mount.
  const headBlock = addPart(body, 'bolt-head-block', new THREE.Mesh(
    roundedBox(0.24, 0.30, 0.34, 0.026, mats.steel, 4).geometry,
    mats.steel,
  ), runtime);
  // The block straddles the receiver wall: its rear half is embedded, while
  // its near face reaches the same z station as the hinge boss. Pass-128
  // observability correction: the prior z=.16 placement was physically
  // seated but disappeared behind the receiver in the top stress view. Move
  // only the block's near-side station to z=.23; it still overlaps the body,
  // sleeve and receiver relief, but its machined face is now readable.
  headBlock.position.set(-0.53, 0.08, 0.11);
  headBlock.userData.role = 'machined-rear-bolt-head-cocking-block';
  headBlock.userData.contact = 'overlaps bolt-shroud, bolt-body and receiver handle relief';
  headBlock.userData.attachment = {
    parent: 'bolt-body',
    parentSocket: 'bolt-handle-root',
    contactType: 'embedded-overlap',
    embedDepth: 0.16,
    overlap: 0.02,
    gapTolerance: 0.015,
  };

  // Loop-123 source-crop correction: the side opening contains a short round
  // machined boss for the handle hinge, not a second rectangular receiver
  // slab. Keep it as a child of the coaxial sleeve so it remains attached
  // during the cycle and overlaps both the embedded receiver pocket and the
  // hinge root. It is not a second free-floating bolt.
  const sideSleeve = addPart(body, 'bolt-side-sleeve', new THREE.Mesh(
    new THREE.CylinderGeometry(0.105, 0.105, 0.28, 24, 2),
    mats.steel,
  ), runtime);
  sideSleeve.rotation.x = Math.PI / 2;
  // The receiver-side relief is on the near face at about z=.34. The boss
  // runs from the cylindrical bolt surface into that relief and shares the
  // rear station with the hinge socket; its circular profile remains visible
  // without turning the action into a side-mounted box.
  sideSleeve.position.set(-0.52, 0.02, 0.18);
  sideSleeve.userData.role = 'near-side-round-bolt-hinge-boss-seated-in-receiver-relief';
  sideSleeve.userData.contact = 'child of coaxial bolt-body; circular boss overlaps receiver relief and hinge root';

  const rearCollar = roundedBox(0.12, 0.23, 0.32, 0.018, mats.metal, 3);
  rearCollar.name = 'bolt-rear-collar';
  rearCollar.position.set(0.08, 0, 0);
  body.add(rearCollar);
  runtime.meshes[rearCollar.name] = rearCollar;
  const lockingLug = roundedBox(0.14, 0.25, 0.34, 0.018, mats.steel, 3);
  lockingLug.name = 'bolt-locking-lug';
  lockingLug.position.set(1.00, 0, 0);
  body.add(lockingLug);
  runtime.meshes[lockingLug.name] = lockingLug;

  // The handle root is a real transverse pin/socket on the REAR face of the
  // bolt body. The body group's local rear face is x=-.58; the previous x=0
  // station put the root in the middle of the receiver and behind the shell.
  // Everything below this socket inherits the bolt cycle transform, while the
  // root itself can lift about its transverse hinge before the sleeve pulls.
  // The sleeve/body stay coaxial with the action, while the hinge pin bridges
  // the sleeve to the receiver's near-side wall. Keeping the lever at the
  // positive-Z surface is important: at z=.20 it was buried inside the
  // receiver shell and read as a perpendicular block fused into the body.
  const handleRoot = addSocket(body, 'bolt-handle-root', new THREE.Vector3(-0.58, 0, 0.30), new THREE.Vector3(0, 0, 1), runtime);
  handleRoot.userData.role = 'transverse-bolt-handle-hinge';
  handleRoot.userData.control = {
    type: 'grip-and-cycle',
    degreesOfFreedom: ['lift-about-z', 'pull-along-x'],
    implementedDegreesOfFreedom: ['lift-about-z', 'pull-along-x'],
    parentControl: 'bolt-action',
    gripMesh: 'bolt-knob',
    pullAxis: 'x',
    liftAxis: 'z',
    hingeRange: 0.45,
  };
  const hingePin = cylinderZ(0, 0, 0, 0.24, 0.048, mats.steel);
  hingePin.name = 'bolt-handle-pivot-pin';
  handleRoot.add(hingePin);
  runtime.meshes[hingePin.name] = hingePin;
  runtime.nodes['bolt-handle'] = handleRoot;

  // Loop-121/125 source-crop correction: the root-to-knob vector travels down
  // and toward the stock/rear (negative X), not toward the muzzle. The longer
  // rearward arc restores the hand clearance visible in the source crop while
  // remaining a single near-side lever; do not mirror it for the top camera.
  // Pass-261, user report: the lever read as PARALLEL to the body. It was -- every point of the path, the
  // neck and the knob carried z = 0, so the whole lever lay flat in the weapon's centreline plane, travelling
  // only rearward and down and never OUTBOARD. From the side that looks like a bolt handle; from above it is
  // a line along the bore.
  // ref-10 (top-down) settles it directly, and this is a same-height ratio so it is legitimate under the
  // ref-10 rules: scale from the receiver's own near edge (21.5 px = 0.15 world -> 0.00698 world/px), the
  // handle leaves the body at (381, 805) and the ball centres at (420, 828), giving OUTBOARD 0.272 against
  // rearward 0.160 -- the lever travels 1.70x further out than back. The knob's outer edge reaches 0.499 from
  // the centreline against a receiver surface at 0.150, so it stands well clear, as a hand needs it to.
  // The x-y projection is deliberately UNCHANGED: that is what the broadside plates can see and have been
  // fitting for 260 passes, and ref-10's absolute scale is on the disputed list. Only the missing third
  // component is added, ramped along arc length so the lever sweeps out smoothly instead of kinking.
  // Pass-263, second user report: still "rất gần thân súng", and the real model is "gần như vuông góc".
  // Correct, and pass-261 only half-fixed it. Adding the outboard component while KEEPING the authored 0.450
  // rearward left the lever at 31 degrees off the bore -- still rearward-dominant. Measured on ref-10 at 6x,
  // the arm leaves the tube at (380, 804) and the ball centres at (424, 828): OUTBOARD 0.308 against rearward
  // 0.163, a 1.89:1 ratio and a 62 degree chord. The authored ratio was 0.60:1 -- inverted.
  //
  // The SHAPE was the deeper error. In the reference the arm leaves the tube almost STRAIGHT OUT and only
  // then curves rearward; my path went rearward from its very first control point. So this is not a
  // magnitude tweak: the early segment is now outboard-dominant (p0->p1 is 84 degrees off the bore) and the
  // rearward component accumulates late, which is what makes it read as perpendicular.
  //
  // Rearward comes down 0.450 -> 0.163 as a consequence. That authored 0.450 was never measured: its own
  // comment says the "longer rearward arc restores the hand clearance visible in the source crop" -- i.e. it
  // was faking, with length, the clearance that a real outboard sweep provides. Same compensation pattern
  // retracted at pass-260 for the ring jaws. Down stays at the plate-fitted 0.42.
  const handlePath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.000, 0.0000, 0.0000),
    new THREE.Vector3(-0.010, -0.0750, 0.1050),
    new THREE.Vector3(-0.040, -0.1650, 0.1950),
    new THREE.Vector3(-0.095, -0.2650, 0.2650),
    new THREE.Vector3(-0.150, -0.3500, 0.3000),
  ]);
  const handle = new THREE.Mesh(new THREE.TubeGeometry(handlePath, 24, 0.040, 12, false), mats.steel);
  handle.name = 'bolt-handle';
  handle.userData.role = 'outboard-downward-rearward-bolt-lever';
  handle.userData.function = 'transmit-grip-force-to-bolt-sleeve';
  handleRoot.add(handle);
  runtime.meshes['bolt-handle'] = handle;
  // Loop-117 hardware correction: the grip ball transitions through a short
  // tapered neck instead of terminating directly on the constant-radius tube.
  const neckStart = new THREE.Vector3(-0.130, -0.3200, 0.2880);
  const neckEnd = new THREE.Vector3(-0.163, -0.4200, 0.3080);
  const neckDirection = neckEnd.clone().sub(neckStart);
  const knobNeck = new THREE.Mesh(
    new THREE.CylinderGeometry(0.074, 0.041, neckDirection.length(), 16, 2),
    mats.steel,
  );
  knobNeck.name = 'bolt-knob-neck';
  knobNeck.position.copy(neckStart).add(neckEnd).multiplyScalar(0.5);
  knobNeck.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), neckDirection.normalize());
  knobNeck.userData.role = 'tapered-grip-ball-transition';
  handleRoot.add(knobNeck);
  runtime.meshes[knobNeck.name] = knobNeck;
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.105, 20, 14), mats.steel);
  knob.name = 'bolt-knob';
  knob.position.set(-0.163, -0.4200, 0.3080);
  knob.userData.role = 'operable-grip-knob';
  handleRoot.add(knob);
  runtime.meshes['bolt-knob'] = knob;
  addSocket(pivot, 'bolt-pivot', new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), runtime);

  // Expose a deterministic cycle control for the viewer and keep the idle
  // tick meaningful. At progress 0 the bolt is closed; at 1 it has translated
  // rearward and lifted the handle around its real root. The mesh hierarchy
  // guarantees that the lever cannot animate independently of the sleeve,
  // while the hinge rotation remains a separate, inspectable DOF.
  const applyHinge = (progress: number): void => {
    const p = THREE.MathUtils.clamp(progress, 0, 1);
    handleRoot.rotation.z = p * 0.45;
    handleRoot.userData.hingeProgress = p;
  };
  handleRoot.userData.applyHinge = applyHinge;
  const applyCycle = (progress: number): void => {
    const p = THREE.MathUtils.clamp(progress, 0, 1);
    pivot.position.set(basePosition.x + p * 0.12, basePosition.y, basePosition.z);
    pivot.rotation.z = -p * 0.16;
    applyHinge(p);
    pivot.userData.cycleProgress = p;
  };
  pivot.userData.applyCycle = applyCycle;
  pivot.userData.restPose = { position: basePosition.toArray(), rotationZ: 0 };
  applyCycle(0);
}

function addTriggerAndMagazine(parent: THREE.Object3D, mats: MaterialSet, runtime: Runtime): void {
  // Loop-120 construction contract: the trigger group is a centerline
  // mechanism, not a near-side ornament. The broadside camera may still see
  // it through the shell opening, but its physical axis stays at z=0.
  const triggerCenterZ = 0;
  // Pass-181 structural correction, from `.img2threejs/references/receiver-trigger-bolt-front.png`:
  // the source trigger guard is not a stamped wire loop. It is a FILLED chassis
  // section carrying the same painted finish as the stock, with the trigger
  // blade sitting in an opening cut through it. The thin tube left open space
  // where the reference has solid material, which is why pass 180's attempt to
  // move the tube down onto the measured -0.042 bottom lost more than it gained:
  // a tube contributes an outline, and the reference needs fill.
  // Measured reference bottoms across this span: -2.44..-2.06 at -0.042, and
  // -1.96 at +0.067. Its top meets the receiver's lower edge near 0.28.
  // Pass-204, from ref-05 read together with the run measurement. The guard is a rectangular
  // opening CUT INTO the chassis, and the bar under that opening is solid painted chassis — not a thin
  // metal bow. So the reference's thin line at y -0.022 is the bottom of that bar, and 0.113/0.059 is
  // the trigger blade inside the opening.
  // This restores pass 181's loop outline and its real hole. Pass 181 was right and looked wrong only
  // because stock-pistol-grip-fillet filled the hole; pass 193c removed that filler, and pass 193's
  // thin-bow substitute was solving a problem that no longer existed.
  const guard = addPart(parent, 'trigger-guard', new THREE.Mesh(profileGeometry([
    [-2.54, 0.05],
    [-2.52, 0.30],
    [-2.02, 0.30],
    [-1.98, 0.07],
    [-2.06, -0.0580],
    [-2.50, -0.0580],
  ], Z_SHELL, [[
    // Pass-208: the reference's bar under the opening reads as a SINGLE mask row (~0.027 thick) at
    // y -0.022, while this loop's bar spanned -0.022..0.04. Raising the hole's floor thins the bar to
    // match and widens the opening toward the walls, which is where cols 56-63 gained 16 extra cells
    // when the loop was restored in pass 204.
    [-2.47, -0.0180],
    [-2.06, -0.0180],
    [-2.04, 0.255],
    [-2.45, 0.270],
  ]], 0.02), mats.shell), runtime);
  guard.userData.role = 'filled-chassis-trigger-guard-with-cut-blade-opening';
  const guardBridge = roundedBox(0.38, 0.055, 0.12, 0.020, mats.metal, 3);
  guardBridge.name = 'trigger-guard-shell-bridge';
  guardBridge.position.set(-2.29, 0.275, triggerCenterZ);
  guard.add(guardBridge);
  runtime.meshes['trigger-guard-shell-bridge'] = guardBridge;
  for (const [name, x] of [['trigger-guard-front-pin', -2.12], ['trigger-guard-rear-pin', -2.46]] as const) {
    const pin = cylinderZ(x, 0.25, triggerCenterZ, 0.065, 0.028, mats.steel);
    pin.name = name;
    guard.add(pin);
    runtime.meshes[name] = pin;
  }
  // Pass-205: measured, the reference's blade shows only one or two mask rows per column and sits at
  // y 0.086-0.113 at col 62 falling to 0.059 at col 64 — a near-horizontal toe, not the near-vertical
  // bar this path described. A 0.022 tube on a mostly vertical path covers many rows per column and is
  // what still fuses cols 58-62 shut where the reference shows the opening as air.
  const triggerPath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-2.30, 0.26, triggerCenterZ),
    new THREE.Vector3(-2.33, 0.16, triggerCenterZ),
    new THREE.Vector3(-2.31, 0.098, triggerCenterZ),
    new THREE.Vector3(-2.25, 0.072, triggerCenterZ),
  ]);
  const trigger = new THREE.Mesh(new THREE.TubeGeometry(triggerPath, 16, 0.010, 12, false), mats.steel);
  trigger.name = 'trigger';
  guard.add(trigger);
  runtime.meshes.trigger = trigger;
  addSocket(guard, 'trigger-pivot', new THREE.Vector3(-2.29, 0.27, triggerCenterZ), new THREE.Vector3(0, 0, 1), runtime);

  // Pass-95 construction hypothesis: the source magazine is a short stamped
  // box with a slight tapered shoulder, not a long hanging block. Keep the
  // group station and well fixed; shorten only the authored envelope and
  // retain real feed lip, base and side ribs.
  const magazine = new THREE.Mesh(profileGeometry([
    [-0.2850, -0.2000],
    [0.2550, -0.2000],
    [0.2850, -0.1500],
    [0.2850, 0.12],
    [0.2550, 0.16],
    [-0.2650, 0.16],
    [-0.2850, 0.11],
  ], 0.42, [], 0.025), mats.steel);
  magazine.castShadow = true;
  magazine.receiveShadow = true;
  const magazineGroup = addPart(parent, 'magazine', magazine, runtime);
  // The mesh and its base must share one physical magazine station. Keeping
  // the station on the group prevents the base from appearing as a detached
  // rectangle at the receiver origin.
  // The visible box sits low and flush under the shell cutout; the well is a
  // separate internal receiver component rather than a floating outer block.
  // Landmark-derived front station: the visible magazine sits closer to the
  // rear than the previous pass, aligned under the forward edge of the guard
  // rather than centered in the receiver slab.
  // The measured baseline station is retained. A later rearward seam
  // experiment regressed both broadside masks, so the visible magazine and
  // well remain at this source-fitted position.
  magazineGroup.position.set(-1.575, 0.02, 0);
  magazine.position.y = 0.10;
  const magWell = addPart(parent, 'magazine-well', roundedBox(0.62, 0.16, 0.52, 0.025, mats.metal, 3), runtime);
  magWell.position.set(-1.62, 0.16, 0);
  magWell.userData.role = 'receiver-mounted-magazine-well';
  const magBase = roundedBox(0.48, 0.06, 0.44, 0.018, mats.metal, 2);
  magBase.position.y = -0.13;
  magazineGroup.add(magBase);
  const feedLip = roundedBox(0.38, 0.04, 0.42, 0.012, mats.steel, 2);
  feedLip.name = 'magazine-feed-lip';
  feedLip.position.y = 0.205;
  magazineGroup.add(feedLip);
  for (let i = 0; i < 4; i += 1) {
    const rib = roundedBox(0.03, 0.22, 0.025, 0.008, mats.metal, 2);
    rib.name = `magazine-side-rib-${i + 1}`;
    rib.position.set(-0.16 + i * 0.105, 0.06, 0.225);
    magazineGroup.add(rib);
  }
}

export type BipodController = {
  /** True when the legs are deployed down (progress >= 0.5). */
  readonly deployed: boolean;
  /** Current fold progress: 0 = folded forward under the fore-end, 1 = deployed down. */
  readonly progress: number;
  setDeployed(on: boolean): void;
  /** Flip the fold state, returns the new `deployed` value. */
  toggle(): boolean;
  /** Frame hook driven by the model tick; eases the pivots toward the target fold. */
  tick(dt: number): void;
};

// Folded (progress 0) the legs run forward under the fore-end exactly as the
// reference plates show; deployed (progress 1) they swing down-and-forward
// about the hinge axle AND splay outward into a slight A-stance (góc nghiêng,
// hơi bẹt) instead of hanging vertical and parallel. The rake keeps the feet
// ahead of the hinge like a real bipod; the per-leg splay widens the stance
// so the rifle reads as standing on its own tripod of feet.
const BIPOD_DEPLOY_ANGLE = -Math.PI / 2 * 0.80; // ~72° from horizontal, forward rake
const BIPOD_SPLAY_ANGLE = THREE.MathUtils.degToRad(10); // per-leg outward tilt

function addBipod(parent: THREE.Object3D, mats: MaterialSet, runtime: Runtime): BipodController {
  // Pass-157 horizontal-overfill hypothesis: preserve every retained Y/Z
  // station, but shorten the independent coil and terminal endpoint while
  // allocating more of the folded chain to a thinner straight telescoping rod.
  // Pass-94 construction hypothesis: the source hinge plate is slimmer in
  // vertical profile while the telescoping tubes carry slightly more visual
  // mass. Keep the spigot station, independent spring paths, hooks/collars,
  // and all receiving contacts fixed.
  const hinge = addPart(parent, 'bipod-hinge', roundedBox(0.42, 0.264, 0.60, 0.035, mats.steel, 3), runtime);
  // The hinge is seated against the receiver underside; the legs start below
  // the receiver rather than cutting through its side silhouette.
  hinge.position.set(0.78, 0.30, 0);
  addSocket(hinge, 'bipod-leg-left-socket', new THREE.Vector3(0.06, -0.15, -0.25), new THREE.Vector3(1, 0, 0), runtime);
  addSocket(hinge, 'bipod-leg-right-socket', new THREE.Vector3(0.06, -0.15, 0.25), new THREE.Vector3(1, 0, 0), runtime);
  const axle = cylinderZ(0.78, 0.30, 0, 0.72, 0.075, mats.steel);
  axle.name = 'bipod-hinge-axle';
  parent.add(axle);
  // Each side's leg + independent spring are children of a deployment pivot
  // seated on the hinge axle. The pivot lives at the hinge centre and its
  // child groups carry the negative offset, so with rotation.z = 0 the whole
  // assembly lands on exactly the authored folded stations; rotating the
  // pivot swings the legs down about the axle without touching any authored
  // number in the geometry below. `splaySign` tilts the left leg toward -Z
  // and the right leg toward +Z as the stance opens.
  const pivots: Array<{ pivot: THREE.Group; splaySign: number }> = [];
  for (const [side, z] of [['left', -0.27], ['right', 0.27]] as const) {
    const pivot = new THREE.Group();
    pivot.name = `bipod-leg-${side}-pivot`;
    pivot.position.set(0.78, 0.30, z);
    parent.add(pivot);
    runtime.nodes[pivot.name] = pivot;
    pivots.push({ pivot, splaySign: z < 0 ? 1 : -1 });
    const leg = new THREE.Group();
    leg.name = `bipod-leg-${side}`;
    leg.position.set(-0.78, -0.30, -z);
    pivot.add(leg);
    runtime.nodes[`bipod-leg-${side}`] = leg;
    // In the supplied broadside plates the folded bipod runs immediately
    // beneath the fore-end, not as a low hanging bar. Keep its rods near the
    // hinge centerline so the assembly remains attached in the fixed shot.
    const legStart = new THREE.Vector3(0.95, 0.22, z);
    const legEnd = new THREE.Vector3(2.40, 0.22, z);
    const outer = tubeBetween(legStart, legEnd, 0.0350, mats.steel);
    outer.name = `bipod-leg-${side}-outer`;
    leg.add(outer);
    // Inner telescoping tube 0.0224 -> 0.0280. Measured: at cols 159-162, the outer/inner overlap,
    // the render necked to 1.99-2.48 mask rows where the reference holds a steady 2.80. A sweep to
    // 0.0330 scored +0.0003/+0.0004 higher but is rejected on physical grounds: the outer tube is
    // 0.035, so 0.033 leaves 0.002 of wall and nothing could telescope through it. 0.0280 leaves
    // 0.007 of wall and already captures the whole gain in the zone that was actually wrong.
    const inner = tubeBetween(new THREE.Vector3(1.35, 0.22, z), new THREE.Vector3(2.6000, 0.22, z), 0.0280, mats.metal);
    inner.name = `bipod-leg-${side}-inner`;
    leg.add(inner);
    // The terminal support is a real rubber boot with a retaining collar and
    // metal end cap, not a placeholder box. The boot axis follows the
    // telescoping leg so the foot remains attached in folded/orbit views.
    // The real leg terminates in a broader tapered rubber boot, not a thin
    // capped pin. Keep the authored leg station but give the foot a readable
    // grip profile for orbit views.
    const foot = cylinderX(2.6900, 0.20, 0.0525, mats.rubber, 0.0665);
    foot.name = `bipod-foot-${side}`;
    foot.position.y = 0.22;
    foot.position.z = z;
    leg.add(foot);
    runtime.meshes[`bipod-foot-${side}`] = foot;
    const footCollar = new THREE.Mesh(new THREE.TorusGeometry(0.0644, 0.0098, 10, 28), mats.steel);
    footCollar.name = `bipod-foot-${side}-collar`;
    footCollar.rotation.y = Math.PI / 2;
    footCollar.position.set(2.6000, 0.22, z);
    leg.add(footCollar);
    runtime.meshes[`bipod-foot-${side}-collar`] = footCollar;
    const footCap = cylinderX(2.8300, 0.06, 0.0665, mats.rubber, 0.0560);
    footCap.name = `bipod-foot-${side}-end-cap`;
    footCap.position.y = 0.22;
    footCap.position.z = z;
    leg.add(footCap);
    runtime.meshes[`bipod-foot-${side}-end-cap`] = footCap;

    // Explicit mechanical seats for the independent spring. The spring is
    // still one logical assembly, but each terminal now has a real collar
    // owned by the component it bears against instead of ending in free space.
    // The reference spring is a separate side-mounted compression coil, not a
    // coil wound around the telescoping leg. Give it its own lateral station
    // and bridge that station to the leg with real seats/connectors.
    const springZ = z + (z < 0 ? -0.13 : 0.13);
    const legSpringAnchor = new THREE.Mesh(new THREE.TorusGeometry(0.046, 0.011, 8, 24), mats.steel);
    legSpringAnchor.name = `bipod-leg-${side}-spring-anchor`;
    legSpringAnchor.rotation.y = Math.PI / 2;
    legSpringAnchor.position.set(1.78, 0.22, z);
    leg.add(legSpringAnchor);
    runtime.meshes[legSpringAnchor.name] = legSpringAnchor;
    const legSpringSeat = new THREE.Mesh(new THREE.TorusGeometry(0.042, 0.010, 8, 24), mats.steel);
    legSpringSeat.name = `bipod-leg-${side}-spring-side-seat`;
    legSpringSeat.rotation.y = Math.PI / 2;
    legSpringSeat.position.set(1.78, 0.22, springZ);
    leg.add(legSpringSeat);
    runtime.meshes[legSpringSeat.name] = legSpringSeat;
    const legSpringConnector = tubeBetween(
      new THREE.Vector3(1.78, 0.22, z),
      new THREE.Vector3(1.78, 0.22, springZ),
      0.018,
      mats.steel,
    );
    legSpringConnector.name = `bipod-leg-${side}-spring-side-connector`;
    leg.add(legSpringConnector);
    runtime.meshes[legSpringConnector.name] = legSpringConnector;

    // One logical spring assembly per side. The coil, two collars, and curved
    // end hooks travel together when the bipod is exploded or animated.
    const springGroup = new THREE.Group();
    springGroup.name = `bipod-spring-${side}`;
    springGroup.position.set(-0.78, -0.30, -z);
    pivot.add(springGroup);
    runtime.nodes[`bipod-spring-${side}`] = springGroup;
    const springPath = new THREE.CatmullRomCurve3(Array.from({ length: 73 }, (_, index) => {
      const t = index / 72;
      const x = 1.02 + t * 0.70;
      // 18 turns, not 11. A per-column run analysis found the mask was RESOLVING individual turns:
      // the render oscillated 2.99..3.73 rows with a 1.2-1.3 column period, matching 11 turns over
      // 0.70 world exactly, and its troughs sat at 2.99 -- the plain-rod baseline -- so the coil
      // visually vanished between turns. The reference never drops that low (min 3.42 against a rod
      // at 2.80-2.98). At 18 turns the render holds 3.24-4.23 and no longer touches baseline.
      // The turn count is capped by physics, not by the gate: pitch = 0.70/turns against a wire
      // diameter of 0.026, so 18 leaves a 0.013 gap, 26 has the turns just touching, and 34 would
      // make them intersect each other. 26 and 34 scored the same as 18 on every gate; 18 is the
      // densest physically valid option. This is a gate-neutral change kept for physical truth.
      // An earlier attempt to fix the same deficit by growing the Y amplitude failed at every value:
      // it only raised already-resolved peaks while the troughs stayed pinned at baseline.
      const angle = t * Math.PI * 2 * 18;
      return new THREE.Vector3(x, 0.24 + Math.cos(angle) * 0.026, springZ + Math.sin(angle) * 0.038);
    }));
    const spring = new THREE.Mesh(new THREE.TubeGeometry(springPath, 234, 0.013, 8, false), mats.steel);
    spring.name = `bipod-spring-${side}-coil`;
    springGroup.add(spring);
    runtime.meshes[`bipod-spring-${side}`] = spring;
    const makeSpringHook = (name: string, points: THREE.Vector3[]): void => {
      const hook = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 16, 0.011, 8, false), mats.steel);
      hook.name = name;
      springGroup.add(hook);
    };
    // Each hook wraps around the receiving anchor instead of terminating in
    // open space. The spring remains a separate side-mounted compression coil;
    // only its terminal hardware is owned by the hinge and telescoping leg.
    makeSpringHook(`bipod-spring-${side}-top-hook`, [
      new THREE.Vector3(1.02, 0.13, springZ),
      new THREE.Vector3(0.98, 0.13, springZ),
      new THREE.Vector3(0.93, 0.17, springZ),
      new THREE.Vector3(0.91, 0.23, springZ),
      new THREE.Vector3(0.94, 0.29, springZ),
      new THREE.Vector3(1.00, 0.30, springZ),
      new THREE.Vector3(1.02, 0.25, springZ),
    ]);
    makeSpringHook(`bipod-spring-${side}-bottom-hook`, [
      new THREE.Vector3(1.72, 0.13, springZ),
      new THREE.Vector3(1.76, 0.12, springZ),
      new THREE.Vector3(1.81, 0.16, springZ),
      new THREE.Vector3(1.82, 0.22, springZ),
      new THREE.Vector3(1.79, 0.28, springZ),
      new THREE.Vector3(1.74, 0.27, springZ),
      new THREE.Vector3(1.78, 0.21, springZ),
    ]);
    const hingeSpringAnchor = new THREE.Mesh(new THREE.TorusGeometry(0.092, 0.021, 8, 24), mats.steel);
    hingeSpringAnchor.name = `bipod-hinge-${side}-spring-anchor`;
    hingeSpringAnchor.rotation.y = Math.PI / 2;
    // The top collar rides the spring assembly (which swings with the leg), so
    // it is authored at the folded-pose hook station in pivot-world space
    // rather than on the static hinge plate. At fold 0 the world position is
    // exactly the old (0.96, 0.25, springZ) hinge-local station.
    hingeSpringAnchor.position.set(0.96, 0.25, springZ);
    springGroup.add(hingeSpringAnchor);
    runtime.meshes[hingeSpringAnchor.name] = hingeSpringAnchor;
    const hingeSpringConnector = tubeBetween(
      new THREE.Vector3(0.96, 0.25, z),
      new THREE.Vector3(0.96, 0.25, springZ),
      0.018,
      mats.steel,
    );
    hingeSpringConnector.name = `bipod-hinge-${side}-spring-side-connector`;
    springGroup.add(hingeSpringConnector);
    runtime.meshes[hingeSpringConnector.name] = hingeSpringConnector;
    // Keep the logical spring manifest names while binding both collars to
    // the actual receiving components. This avoids duplicate floating collars
    // inside the independent spring group.
    runtime.meshes[`bipod-spring-${side}-top-collar`] = hingeSpringAnchor;
    runtime.meshes[`bipod-spring-${side}-bottom-collar`] = legSpringAnchor;
  }

  let deployTarget = 0;
  let deployProgress = 0;
  const applyPose = (): void => {
    const angle = deployProgress * BIPOD_DEPLOY_ANGLE;
    const splay = deployProgress * BIPOD_SPLAY_ANGLE;
    for (const entry of pivots) {
      // Euler XYZ order applies Rz (deploy) first, then Rx (splay), so the
      // legs swing forward-down and open sideways as one continuous motion.
      entry.pivot.rotation.z = angle;
      entry.pivot.rotation.x = entry.splaySign * splay;
    }
  };
  applyPose();
  return {
    get deployed() { return deployTarget >= 0.5; },
    get progress() { return deployProgress; },
    setDeployed(on) { deployTarget = on ? 1 : 0; },
    toggle() { deployTarget = this.deployed ? 0 : 1; return this.deployed; },
    tick(dt) {
      deployProgress += (deployTarget - deployProgress) * Math.min(1, dt * 5);
      if (Math.abs(deployTarget - deployProgress) < 0.001) deployProgress = deployTarget;
      applyPose();
    },
  };
}

function addStock(parent: THREE.Object3D, mats: MaterialSet, runtime: Runtime): void {
  // The source thumbhole is taller than it is wide. Keeping that negative
  // space vertical is important: a wide oval makes the rear chassis read as
  // a generic stock instead of the AWP thumbhole shell.
  // The admitted stock crop shows a near-round thumbhole that is slightly
  // wider than the vertical opening used in the earlier pass. Keep the
  // negative space generous and heavily filleted so the shell reads as a
  // molded ergonomic chassis rather than a narrow rectangular cutout.
  // Pass-127 thumbhole station move was rejected by the full-frame gate
  // (front/back IoU regressed to 0.7697/0.7659). Retain the prior source-fit
  // station until a different stock hypothesis is measured; do not repeat
  // that crop-only retarget here.
  const thumbhole = ellipseLoop(-3.22, 0.07, 0.74, 0.56, 24);
  const stock = addPart(parent, 'stock', new THREE.Mesh(stockProfileGeometry(Z_SHELL, thumbhole), mats.shell), runtime);
  runtime.nodes.stock = stock;
  stock.userData.profileEvidence = 'front/back broadside stock profile with rounded thumbhole cut';
  // Loop-120 clearance correction: the receiving throat is a narrow center
  // shell around the trigger, not a half-depth side slab. Keep the outer
  // stock profile unchanged; reduce only this local fillet so a hand can
  // reach the centerline trigger guard from either side.
  const gripFillet = addPart(parent, 'stock-pistol-grip-fillet', new THREE.Mesh(stockPistolGripFilletGeometry(0.28), mats.shell), runtime);
  // Pass-193c: this fillet spanned y 0.04..0.285 and was the mesh filling the guard's air. Per-column
  // runs put the reference's chassis bottom at 0.302 with open air below it, so a receiving volume
  // that reaches 0.04 is 0.26 of solid where the source shows none. Its original job — stopping the
  // guard reading as floating — is now done by the chassis itself, which meets the receiver at 0.297.
  // Scaled to a top-only transition spanning about 0.26..0.31.
  gripFillet.scale.y = 0.204;
  gripFillet.position.y = 0.252;
  gripFillet.position.z = 0;
  gripFillet.userData.role = 'narrow-centerline-receiving-fillet-for-trigger-guard';
  gripFillet.userData.clearance = { triggerAxis: 'z=0 centerline', depth: 0.28, stockShellDepth: Z_SHELL };
  const cheek = roundedBox(1.62, 0.15, 0.56, 0.05, mats.rubber, 4);
  cheek.position.set(-3.88, 0.56, 0);
  stock.add(cheek);
  // Pass-92 construction hypothesis: the source buttpad is a separate sloped
  // terminal plate with softened corners, not a perfectly rectangular rubber
  // block. Keep its station, height, depth, and stock contact fixed; change
  // only the visible terminal profile.
  const buttpad = new THREE.Mesh(profileGeometry([
    [-0.15, -0.50],
    [0.11, -0.50],
    [0.15, -0.43],
    [0.15, 0.39],
    [0.10, 0.50],
    [-0.12, 0.50],
    [-0.15, 0.41],
  ], 0.3800, [], 0.04), mats.rubber);
  buttpad.castShadow = true;
  buttpad.receiveShadow = true;
  buttpad.position.set(-5.09, 0.12, 0);
  const buttGroup = addPart(parent, 'stock-buttpad', buttpad, runtime);
  buttGroup.userData.contact = 'overlap into rear stock end';
  [0.38, -0.12].forEach((y, index) => addFastener(stock, `stock-fastener-${index}`, -4.66, y, 0.365, 0.045, mats, runtime));
}

function addReceiver(parent: THREE.Object3D, mats: MaterialSet, runtime: Runtime): THREE.Group {
  // Keep the retained pass-128 receiver crown. The pass-129 bare-top span and
  // pass-130 uniform envelope-scale hypotheses both regressed the full-frame
  // broadside masks, and pass-132's non-uniform contour improved full-frame IoU
  // but worsened the critical receiver-action occupancy. The next correction
  // must use a new measured foundation; this code remains at pass-128.
  const points: Array<[number, number]> = [
    // Keep the retained pass85 crown; the pass87 receiver-only crown shrink
    // did not improve either aligned broadside and read unchanged in orbit.
    // Pass-129 tested a stepped bare-top span (x=-2.52..-1.90 lowered to 0.52
    // before rejoining the rail at 0.70) and it regressed front/back IoU to
    // 0.7798/0.7764 versus the retained pass-128 0.7823/0.7796. Rolled back;
    // do not repeat this exact bare-span step without new source evidence.
    [-2.62, 0.42], [-2.52, 0.8070], [-2.25, 0.8070], [-2.20, 0.7000], [0.83, 0.7000],
    [1.00, 0.6000],
    // Pass-183 contour refit of the lower chain, measured per mask column rather
    // than nudged. The source receiver underside is not the near-flat +0.26 this
    // render carried: it rises from +0.149 at x -1.10 to a +0.341 shoulder at
    // x +0.45, then falls to +0.177 at x +0.83. Authored values are the measured
    // reference bottoms plus the 0.007 this shell's bevel adds.
    [1.00, 0.2110], [0.83, 0.1840], [0.64, 0.2110], [0.45, 0.3480],
    [0.25, 0.3200], [0.02, 0.3200], [-0.48, 0.3200], [-0.71, 0.2930],
    [-0.90, 0.2110], [-1.08, 0.1560],
    [-1.48, 0.2900], [-2.62, 0.3000],
  ];
  // Pass-134 tested one rounded receiver clearance opening around the existing
  // centered trigger/guard. It was real geometry, but the paired region audit
  // showed receiver-action still overfilled and trigger occupancy worsening;
  // reject and keep the retained pass-128 shell until a new measured opening
  // packet exists. This is the rollback target, not a camera-facing trick.
  // Pass-256 depth correction, from the user's report that the body reads too thick. The receiver was
  // 0.54 deep against a stock of Z_SHELL = 0.34, so it bulged 0.10 past the chassis it is bedded into on
  // each side. ref-04's receiver-to-stock junction shows the opposite and unambiguously: the stock's
  // surface stands PROUD of the receiver's near face, with a band of stock visible in front of it. A
  // receiver wider than its own chassis is also not a thing a bedded action does.
  //
  // The exact inset is NOT determinable from these nine views. Attempts to turn the junction into a ratio
  // failed: the stock's proud band and the receiver's top face are not the same kind of surface (one is a
  // chamfer), and the two candidates differ by a factor of ~7, which is a measurement failure rather than
  // a result. Comparing the comb to the rail failed too, because in ref-07 they sit at very different
  // distances and perspective breaks the shared-foreshortening assumption those ratios rely on.
  //
  // So this does not invent a ratio. It takes the LARGEST value consistent with the ordering the
  // reference does show (receiver < stock), which is the smallest change that stops violating it. Any
  // value in (0, 0.34) satisfies the evidence equally; 0.30 leaves a 0.02 proud stock shoulder per side.
  // Depth is invisible to the broadside silhouette gate, so this is gate-neutral by construction and
  // fully reversible. A top-down or true-rear view would settle it properly and has been requested.
  const receiver = addPart(parent, 'receiver', new THREE.Mesh(profileGeometry(points, 0.30, [], 0.035), mats.shell), runtime);
  // The reference's Medusa artwork runs across the receiver flank as well as the stock, so the
  // receiver carries its own projection panel from the same de-lit plate.
  addProjectionPanels(
    receiver,
    runtime.meshes.receiver,
    (depth) => profileGeometry(points, depth, [], 0),
    0.27,
    { front: 'painted-receiver-visible-surface', back: 'painted-receiver-visible-surface-back' },
    mats,
    runtime,
  );
  addRail(receiver, mats, runtime);
  // Pass-262: the four `receiver-fastener-*` heads are deleted at the user's direction -- they are not on
  // the real item. They also sat at z=0.355, which since pass-256 put them OUTSIDE the receiver's own
  // 0.30-deep surface (z=0.15) entirely, floating clear of the part they were meant to fasten.

  // The real AWP is a shell/chassis assembly: the painted side shell does not
  // replace the separate machined action. Keep this action block inside the
  // existing receiver envelope so the macro silhouette stays controlled while
  // the broadside view gains a real component boundary and its own hardware.
  // Loop-105 construction hypothesis from the loop-90 audit: the source
  // shows a shorter machined action nested into the painted shell, not one
  // uninterrupted receiver slab. Shrink only the longitudinal action profile
  // around its existing center (~12%) and bring it forward by a controlled
  // overlap so the seam is a real nested component in orbit. Do not translate
  // the receiver, stock, rail, bolt, barrel or any contact station.
  // Loop-109 depth hypothesis: expose only a small real shell/action boundary;
  // preserve the action profile, parent, station, fasteners, and contact graph.
  // Pass-265, user report: the original has no separate action block, and the fasteners sit directly on the
  // receiver. Confirmed by arithmetic as well as by the reference -- `receiver-action-block` was a
  // profileGeometry of depth 0.38 parked at z 0.14, so it spanned z -0.05..0.33 and stood 0.18 PROUD of the
  // receiver's own 0.15 surface since pass-256 shrank the receiver. It read as a slab bolted onto the outside
  // of the gun. Its `receiver-action-seam` partner at z 0.285 marked that same non-existent shell/action
  // boundary and goes with it.
  // The four fasteners were CHILDREN of the block at z 0.255, i.e. z 0.395 in receiver space -- floating well
  // clear of anything. They are now parented straight to the receiver and seated just proud of its real
  // surface, and mirrored onto the negative-Z side, which the user correctly noticed was bare: the
  // crown-sticker face carries the same row on the real item.
  for (const [side, z] of [['near', 0.1550], ['far', -0.1550]] as const) {
    [-2.12, -1.42, -0.12, 0.52].forEach((x, index) => {
      addFastener(receiver, `receiver-action-fastener-${side}-${index}`, x, 0.51, z, 0.034, mats, runtime);
    });
  }
  // Loop-118 bounded correction: the handle relief is registered at the
  // measured rear action station. It is a shallow receiver-owned machining
  // pocket, not a free-floating plate or a camera-facing projection.
  // This is embedded geometry, not a camera-facing decal or texture trick.
  const boltPocket = addPart(receiver, 'receiver-bolt-side-pocket', new THREE.Mesh(
    roundedBox(0.34, 0.15, 0.034, 0.026, mats.black, 3).geometry,
    mats.black,
  ), runtime);
  boltPocket.position.set(-2.24, 0.55, 0.342);
  boltPocket.userData.role = 'machined-receiver-handle-relief-pocket';
  boltPocket.userData.contact = 'embedded into receiver-action near-side face';
  return receiver;
}

function addBarrelAndMuzzle(parent: THREE.Object3D, mats: MaterialSet, runtime: Runtime): void {
  // Measured on the reference at full resolution: the barrel holds ONE constant diameter out to a
  // short rounded crown. There is no muzzle brake -- the only wide station is a squared front-sight
  // block clamped over the barrel, and it reaches further below the bore than above it. The earlier
  // open sleeve, two proud torus rims and two internal baffles matched no component in the source.
  const barrel = addPart(parent, 'barrel', cylinderX(2.2860, 6.3720, 0.0990, mats.metal, 0.0990), runtime);
  barrel.position.y = 0.6860;
  // No barrel shoulder is authored. The reference holds a FLAT top edge at mask row 107.0 across
  // cols 110-128 -- the barrel top itself -- while an r 0.15 collar here pushed 1.5 rows above that
  // line at col 125. This region is bright metal in the source, so the reading is not a dark-opening
  // mask artifact: the collar simply is not visible, and a part that breaks the silhouette to model
  // something the reference never shows is worse than no part.

  // Squared front-sight block. Reference: top 31 source px above the bore, bottom 37 px below, so
  // the block is deliberately asymmetric; depth cannot be read from a broadside plate (see the
  // spec's perRegionConfidence entry) and is taken from the 3D reference set.
  const sightBlock = addPart(parent, 'barrel-front-sight-block', roundedBox(0.279, 0.286, 0.260, 0.022, mats.steel, 2), runtime);
  sightBlock.position.set(4.8975, 0.6734, 0);
  const blockScrew = cylinderY(0, 0.1360, 0, 0.026, 0.026, mats.steel);
  blockScrew.name = 'front-sight-block-screw';
  sightBlock.add(blockScrew);
  runtime.meshes[blockScrew.name] = blockScrew;
  const blockBoss = cylinderZ(0.0285, -0.0850, 0.1380, 0.020, 0.030, mats.steel);
  blockBoss.name = 'front-sight-block-boss';
  sightBlock.add(blockBoss);
  runtime.meshes[blockBoss.name] = blockBoss;
  const blockSocket = cylinderZ(0.0285, -0.0850, 0.1460, 0.014, 0.014, mats.black);
  blockSocket.name = 'front-sight-block-socket';
  sightBlock.add(blockSocket);
  runtime.meshes[blockSocket.name] = blockSocket;

  // Elongated port cut in the barrel wall, flush with the tube surface so it reads as an opening.
  const gasPort = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.036, 20), mats.black);
  gasPort.name = 'barrel-gas-port';
  gasPort.rotation.x = Math.PI / 2;
  gasPort.scale.x = 1.9;
  gasPort.position.set(5.1355, 0.7160, 0.0763);
  parent.add(gasPort);
  runtime.meshes[gasPort.name] = gasPort;

  // Flush seam line: the reference shows a bright ring here with NO change in silhouette height.
  const crownSeam = new THREE.Mesh(new THREE.TorusGeometry(0.0990, 0.004, 8, 32), mats.steel);
  crownSeam.name = 'barrel-crown-seam';
  crownSeam.rotation.y = Math.PI / 2;
  crownSeam.position.set(5.2730, 0.6860, 0);
  parent.add(crownSeam);
  runtime.meshes[crownSeam.name] = crownSeam;

  // Rounded crown: two short cones reproduce the measured 47 -> 34 -> 19 -> 0 px fall, which is far
  // blunter than a single chamfer and is why the tip previously read one mask column short.
  const crownRear = cylinderX(5.4870, 0.0300, 0.0800, mats.metal, 0.0990);
  const muzzle = addPart(parent, 'muzzle', crownRear, runtime);
  muzzle.position.y = 0.6860;
  const crownFront = new THREE.Mesh(new THREE.CylinderGeometry(0.0330, 0.0800, 0.0180, 24, 1, true), mats.metal);
  crownFront.name = 'muzzle-crown-front';
  crownFront.rotation.z = -Math.PI / 2;
  crownFront.position.x = 5.5110;
  muzzle.add(crownFront);
  runtime.meshes[crownFront.name] = crownFront;

  // The bore is real recessed geometry seen through the open crown, capped at its rear so no path
  // through the model can expose the background.
  const boreTube = new THREE.Mesh(new THREE.CylinderGeometry(0.030, 0.030, 0.146, 24), mats.black);
  boreTube.rotation.z = -Math.PI / 2;
  boreTube.position.x = 5.4470;
  addPart(muzzle, 'muzzle-bore', boreTube, runtime);
}

/** The capture camera the review plates are registered to. Projection UVs must be computed through
 *  THIS camera, because the two reference plates were matched to it (bbox delta 0.0000 FRONT,
 *  0.0045 BACK), which is what makes the photo's own pixels land on the right geometry. */
const PROJECTION_CAMERA = {
  position: [0.06105950944125864, 0.6510459728837025, 17.578492692244154] as const,
  target: [0.06105950944125649, 0.6510459728837014, 0.01349999964237214] as const,
  fov: 20,
  near: 16.511992697250943,
  far: 21.776992674005132,
  width: 1600,
  height: 900,
};

/** Assign screen-space UVs by projecting each vertex through the capture camera, so the de-lit
 *  reference plate maps onto the shell exactly as it was photographed. This is the projection path the
 *  skill calls the single biggest fidelity lever: the artwork is the reference's own pixels, not a
 *  procedural approximation of them. */
function projectShellUv(mesh: THREE.Mesh, side: 'front' | 'back'): void {
  const camera = new THREE.PerspectiveCamera(
    PROJECTION_CAMERA.fov,
    PROJECTION_CAMERA.width / PROJECTION_CAMERA.height,
    PROJECTION_CAMERA.near,
    PROJECTION_CAMERA.far,
  );
  const sign = side === 'front' ? 1 : -1;
  camera.position.set(
    PROJECTION_CAMERA.position[0],
    PROJECTION_CAMERA.position[1],
    sign * Math.abs(PROJECTION_CAMERA.position[2]),
  );
  camera.lookAt(PROJECTION_CAMERA.target[0], PROJECTION_CAMERA.target[1], PROJECTION_CAMERA.target[2]);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const uv = new Float32Array(position.count * 2);
  const vertex = new THREE.Vector3();
  mesh.updateWorldMatrix(true, false);
  for (let index = 0; index < position.count; index += 1) {
    vertex.fromBufferAttribute(position as THREE.BufferAttribute, index);
    vertex.applyMatrix4(mesh.matrixWorld);
    vertex.project(camera);
    uv[index * 2] = (vertex.x + 1) / 2;
    uv[index * 2 + 1] = (vertex.y + 1) / 2;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.getAttribute('uv').needsUpdate = true;
  mesh.userData.projectionBinding = 'capture-camera-screen-projection';
  mesh.userData.projectionAsset = `awp-v2-${side}-projection.png`;
}

/** Attach a de-lit reference-projection panel to both visible broadsides of a host mesh.
 *  The offset is derived from the host's REAL geometry depth, because an authored profile depth
 *  understates it by the bevel and a panel placed on the authored value ends up buried inside the host. */
function addProjectionPanels(
  host: THREE.Object3D,
  hostMesh: THREE.Mesh | undefined,
  makeGeometry: (depth: number) => THREE.BufferGeometry,
  authoredHalfDepth: number,
  names: { front: string; back: string },
  mats: MaterialSet,
  runtime: Runtime,
): void {
  const panelDepth = 0.018;
  let halfDepth = authoredHalfDepth;
  if (hostMesh) {
    hostMesh.geometry.computeBoundingBox();
    const box = hostMesh.geometry.boundingBox;
    if (box) halfDepth = Math.max(Math.abs(box.min.z), Math.abs(box.max.z));
  }
  const offset = halfDepth + panelDepth / 2 + 0.002;
  for (const [side, z] of [['front', offset], ['back', -offset]] as const) {
    const panel = new THREE.Mesh(makeGeometry(panelDepth), mats.shell);
    panel.name = side === 'front' ? names.front : names.back;
    panel.position.z = z;
    panel.userData.role = 'conforming-shell-visible-surface';
    panel.userData.projectionBinding = 'capture-camera-screen-projection';
    host.add(panel);
    const projection = new THREE.TextureLoader().load(
      `${import.meta.env.BASE_URL}awp-v2-${side}-projection.png`,
    );
    projection.colorSpace = THREE.SRGBColorSpace;
    projection.anisotropy = 8;
    const painted = (mats.shell as THREE.MeshPhysicalMaterial).clone();
    painted.map = projection;
    painted.color = new THREE.Color(0xffffff);
    panel.material = painted;
    projectShellUv(panel, side);
    runtime.meshes[panel.name] = panel;
  }
}

function addPaintPanels(parent: THREE.Object3D, mats: MaterialSet, runtime: Runtime): void {
  // Loop-115 ownership correction: a paint/projection surface must ride the
  // real stock object, not sit as a root-level plate at the old shell depth.
  // Keep the geometry shallow and use the exact stock profile/hole for both
  // visible broadside faces. Textures remain a later look-dev step; this pass
  // proves that the future projection owner cannot float when the stock moves
  // or is exploded.
  const stock = runtime.nodes.stock ?? parent;
  const panelDepth = 0.018;
  // Derive the offset from the stock's ACTUAL depth, not from Z_SHELL. Z_SHELL is the authored profile
  // depth (0.34), but the stock's bevel carries its real surface out to +/-0.21, so a panel placed at
  // Z_SHELL/2 + margin sat at 0.171..0.189 -- entirely buried inside the stock, which is why the
  // projection rendered as nothing at all. Same class of bug as the trigger guard's bevel reaching past
  // its profile points; here it silently swallowed the whole finish layer.
  const stockMesh = runtime.meshes.stock;
  let stockHalfDepth = Z_SHELL / 2;
  if (stockMesh) {
    stockMesh.geometry.computeBoundingBox();
    const box = stockMesh.geometry.boundingBox;
    if (box) stockHalfDepth = Math.max(Math.abs(box.min.z), Math.abs(box.max.z));
  }
  const panelOffset = stockHalfDepth + panelDepth / 2 + 0.002;
  for (const [side, z] of [['front', panelOffset], ['back', -panelOffset]] as const) {
    const panel = new THREE.Mesh(
      stockProfileGeometry(panelDepth, ellipseLoop(-3.22, 0.07, 0.74, 0.56, 24), 0),
      mats.shell,
    );
    panel.userData.role = 'conforming-stock-shell-visible-surface';
    panel.userData.boundTo = 'stock';
    panel.userData.projectionBinding = 'stock-owned-surface-contact';
    panel.userData.attachment = {
      parent: 'stock',
      parentSocket: `stock.painted-surface-${side}`,
      contactType: 'surface-contact',
      embedDepth: 0.001,
      overlap: 0.001,
      gapTolerance: 0.015,
    };
    panel.name = side === 'front' ? 'painted-shell-visible-surface' : 'painted-shell-visible-surface-back';
    panel.position.z = z;
    stock.add(panel);
    // The de-lit plate carries the Medusa artwork; the shell's own material response stays underneath.
    const projection = new THREE.TextureLoader().load(
      `${import.meta.env.BASE_URL}awp-v2-${side}-projection.png`,
    );
    projection.colorSpace = THREE.SRGBColorSpace;
    projection.anisotropy = 8;
    const painted = (mats.shell as THREE.MeshPhysicalMaterial).clone();
    painted.map = projection;
    painted.color = new THREE.Color(0xffffff);
    panel.material = painted;
    projectShellUv(panel, side);
    runtime.meshes[panel.name] = panel;
  }
}

type MedusaEyeAccent = {
  haloLayers: THREE.Sprite[];
  core: THREE.Mesh;
  baseScale: number;
  phase: number;
};

type MedusaEyeAccentController = {
  tick: (dt: number) => void;
  restart: () => void;
};

function makeMedusaEyeGlowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(48, 48, 1, 48, 48, 48);
  gradient.addColorStop(0, 'rgba(245, 255, 255, 1)');
  gradient.addColorStop(0.12, 'rgba(120, 255, 246, 0.96)');
  gradient.addColorStop(0.38, 'rgba(42, 232, 221, 0.44)');
  gradient.addColorStop(1, 'rgba(14, 153, 174, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 96, 96);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function projectionPixelToWorld(
  pixelX: number,
  pixelY: number,
  side: 'front' | 'back',
  planeZ: number,
): THREE.Vector3 {
  const camera = new THREE.PerspectiveCamera(
    PROJECTION_CAMERA.fov,
    PROJECTION_CAMERA.width / PROJECTION_CAMERA.height,
    PROJECTION_CAMERA.near,
    PROJECTION_CAMERA.far,
  );
  const sign = side === 'front' ? 1 : -1;
  camera.position.set(
    PROJECTION_CAMERA.position[0],
    PROJECTION_CAMERA.position[1],
    sign * Math.abs(PROJECTION_CAMERA.position[2]),
  );
  camera.lookAt(PROJECTION_CAMERA.target[0], PROJECTION_CAMERA.target[1], PROJECTION_CAMERA.target[2]);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const pointOnNearPlane = new THREE.Vector3(
    (pixelX / PROJECTION_CAMERA.width) * 2 - 1,
    1 - (pixelY / PROJECTION_CAMERA.height) * 2,
    0.5,
  ).unproject(camera);
  const direction = pointOnNearPlane.sub(camera.position).normalize();
  const distance = (planeZ - camera.position.z) / direction.z;
  return camera.position.clone().add(direction.multiplyScalar(distance));
}

function addMedusaEyeAccent(
  parent: THREE.Object3D,
  name: string,
  position: THREE.Vector3,
  rotationY: number,
  baseScale: number,
  phase: number,
): MedusaEyeAccent {
  const group = new THREE.Group();
  group.name = name;
  group.position.copy(position);
  group.rotation.y = rotationY;
  group.userData.explodeWithParent = true;
  group.userData.effectOnly = true;

  const coreMaterial = new THREE.MeshBasicMaterial({
    color: 0xeaffff,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });
  const core = new THREE.Mesh(new THREE.CircleGeometry(baseScale * 0.16, 24), coreMaterial);
  core.name = `${name}-core`;
  core.position.z = 0.006;
  core.renderOrder = 100;
  core.userData.explodeWithParent = true;
  core.userData.effectOnly = true;
  group.add(core);

  const haloLayers = [
    { scale: 0.82, opacity: 0.70 },
    { scale: 1.70, opacity: 0.44 },
    { scale: 3.20, opacity: 0.24 },
    { scale: 5.40, opacity: 0.11 },
  ].map(({ scale, opacity }, index) => {
    const glowMaterial = new THREE.SpriteMaterial({
      map: makeMedusaEyeGlowTexture(),
      color: index === 0 ? 0x8ffff8 : 0x36f4e8,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      sizeAttenuation: true,
    });
    const glow = new THREE.Sprite(glowMaterial);
    glow.name = `${name}-halo-${index + 1}`;
    glow.position.z = 0.008 + index * 0.001;
    glow.scale.set(baseScale * scale, baseScale * scale, 1);
    glow.renderOrder = 101 + index;
    glow.userData.explodeWithParent = true;
    glow.userData.effectOnly = true;
    group.add(glow);
    return glow;
  });
  parent.add(group);

  return { haloLayers, core, baseScale, phase };
}

/**
 * Small, persistent accents only: one light on the painted Medusa eye and two lights in the
 * skull decal's sockets. Their layered sprites breathe in and out like a soft bulb; no snake
 * geometry or reveal animation is part of the weapon.
 */
function createMedusaEyeAccents(
  parent: THREE.Group,
  runtime: Runtime,
): MedusaEyeAccentController {
  const accents: MedusaEyeAccent[] = [];
  const facePanel = runtime.meshes['painted-shell-visible-surface-back'];
  if (facePanel) {
    parent.updateWorldMatrix(true, true);
    facePanel.updateWorldMatrix(true, false);
    const panelCenter = facePanel.getWorldPosition(new THREE.Vector3());
    // Pixel measured from awp-v2-back-projection.png: the visible Medusa eye sits at ~1411,514.
    const faceWorld = projectionPixelToWorld(1411, 514, 'back', panelCenter.z - 0.012);
    const faceLocal = parent.worldToLocal(faceWorld);
    accents.push(addMedusaEyeAccent(parent, 'medusa-painted-eye', faceLocal, Math.PI, 0.13, 0));
  }

  const sticker = runtime.nodes['crown-skull-sticker'];
  if (sticker) {
    // The decal is a 0.474 x 0.500 plane with the same 1.22 vertical conform scale used by
    // conformObjectiveDecalGeometry. These are the two dark socket centres in the source decal.
    const eyeY = (0.5 - 90 / 130) * 0.5 * 1.22;
    for (const [index, eyeX] of [0.011, 0.115].entries()) {
      const surfaceX = 1.0370 - eyeX;
      const surfaceY = -0.0255 + eyeY;
      const radius = objectiveRadiusAt(surfaceX);
      const surfaceDepth = Math.sqrt(Math.max(0, radius * radius - surfaceY * surfaceY));
      const eyePosition = new THREE.Vector3(eyeX, eyeY, surfaceDepth + 0.008);
      accents.push(addMedusaEyeAccent(
        sticker,
        `medusa-skull-eye-${index === 0 ? 'left' : 'right'}`,
        eyePosition,
        0,
        0.075,
        index * Math.PI,
      ));
    }
  }

  let elapsed = 0;
  const applyPulse = (accent: MedusaEyeAccent, fade: number): void => {
    const coreMaterial = accent.core.material as THREE.MeshBasicMaterial;
    coreMaterial.opacity = 0.05 + fade * 0.95;
    accent.core.scale.setScalar(0.78 + fade * 0.30);
    const layerOpacity = [0.70, 0.44, 0.24, 0.11];
    const layerScale = [0.82, 1.70, 3.20, 5.40];
    accent.haloLayers.forEach((halo, index) => {
      const material = halo.material as THREE.SpriteMaterial;
      material.opacity = 0.008 + fade * layerOpacity[index];
      halo.scale.setScalar(accent.baseScale * layerScale[index] * (0.82 + fade * 0.24));
    });
  };
  const update = (): void => {
    accents.forEach((accent) => {
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 2.45 + accent.phase);
      // Smoothstep makes the fade linger softly at both ends instead of blinking abruptly.
      const fade = pulse * pulse * (3 - 2 * pulse);
      applyPulse(accent, fade);
    });
  };
  update();

  return {
    tick: (dt: number): void => {
      elapsed += Math.min(Math.max(dt, 0), 0.1);
      update();
    },
    restart: (): void => {
      elapsed = 0;
      update();
    },
  };
}

export function createAWPMedusaMinimalWearModel(options: AWPV2Options = {}): THREE.Group {
  const mats = makeMaterials(options);
  const root = new THREE.Group();
  root.name = 'AWP_Medusa_V2';
  const runtime: Runtime = {
    nodes: { root }, meshes: {}, sockets: {}, colliders: [], colliderById: {},
    adjacency: [], attachmentGate: {}, attachmentAudit: {}, destructionGroups: {}, logicalComponents: {},
  };
  root.userData.reconstructionEvidence = {
    version: 'awp-medusa-v2',
    itemName: 'AWP | Medusa (Minimal Wear)',
    sourceReferences: {
      front: 'public/front-medusa.webp',
      back: 'public/back-medusa.webp',
    },
    sourceAbsoluteReferences: {
      front: '/Users/tamlh/workspaces/self/AI/img2threejs-org/img2threejs-showcase/public/front-medusa.webp',
      back: '/Users/tamlh/workspaces/self/AI/img2threejs-org/img2threejs-showcase/public/back-medusa.webp',
    },
    pass: 'macro-blockout',
    projection: 'pending-macro-silhouette-gate',
    referenceCamera: 'orthographic-first broadside hypothesis',
    evidenceConfidence: { stock: 0.94, receiver: 0.91, barrel: 0.93, scope: 0.88, bipod: 0.72, hiddenThickness: 0.45 },
  };
  addSocket(root, 'receiver-root', new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), runtime);
  addStock(root, mats, runtime);
  const receiver = addReceiver(root, mats, runtime);
  addBarrelAndMuzzle(root, mats, runtime);
  addScope(root, mats, runtime);
  addBolt(receiver, mats, runtime);
  addTriggerAndMagazine(root, mats, runtime);
  const bipod = addBipod(root, mats, runtime);
  root.userData.bipod = bipod;

  // ------------------------------------------------------------------ firing rig
  // Interactive muzzle-flash / tracer / casing / recoil / bolt-cycle effects.
  // Everything here is inert by default (hidden at rest) and only animates
  // inside `root.userData.tick`, which the viewer strips in capture mode, so
  // review frames stay deterministic. The flash group is authored on the
  // muzzle object so it tracks the barrel in every orbit.
  const muzzleGroup = runtime.nodes.muzzle;
  const flashGroup = new THREE.Group();
  flashGroup.name = 'fire-flash';
  flashGroup.position.set(5.51, 0, 0);
  flashGroup.visible = false;
  muzzleGroup.add(flashGroup);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffe0b0,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const flashCore = new THREE.Mesh(new THREE.SphereGeometry(0.085, 14, 12), flashMat);
  flashCore.name = 'fire-flash-core';
  flashGroup.add(flashCore);
  const flashBurst = new THREE.Mesh(new THREE.OctahedronGeometry(0.20, 0), flashMat);
  flashBurst.name = 'fire-flash-burst';
  flashBurst.scale.set(2.1, 1.3, 1.3);
  flashGroup.add(flashBurst);
  const flashFlame = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.11, 0.85, 12, 1, true), flashMat);
  flashFlame.name = 'fire-flash-flame';
  flashFlame.rotation.z = -Math.PI / 2;
  flashFlame.position.x = 0.42;
  flashGroup.add(flashFlame);
  const flashLight = new THREE.PointLight(0xffc36b, 0, 9, 2);
  flashLight.name = 'fire-flash-light';
  flashGroup.add(flashLight);

  const tracerMat = new THREE.MeshBasicMaterial({
    color: 0xffb35c,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const tracerMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.018, 2.2, 8, 1, true), tracerMat);
  tracerMesh.name = 'fire-tracer';
  tracerMesh.rotation.z = -Math.PI / 2;
  tracerMesh.visible = false;
  root.add(tracerMesh);

  const casingMat = new THREE.MeshStandardMaterial({ color: 0xc98a2d, metalness: 0.92, roughness: 0.34 });
  const casingMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.030, 0.030, 0.15, 14), casingMat);
  casingMesh.name = 'fire-casing';
  casingMesh.visible = false;
  root.add(casingMesh);

  const fire = {
    cooldown: 0,
    flashT: -1,
    tracerT: -1,
    casingT: -1,
    casing: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    boltT: -1,
    recoilT: -1,
    rounds: 0,
  };
  const muzzleTipWorld = new THREE.Vector3();
  const fireRifle = (): boolean => {
    if (fire.cooldown > 0) return false;
    fire.cooldown = 0.9;
    fire.flashT = 0;
    flashGroup.getWorldPosition(muzzleTipWorld);
    tracerMesh.position.copy(muzzleTipWorld);
    tracerMesh.material.opacity = 0.95;
    tracerMesh.visible = true;
    fire.tracerT = 0;
    // Brass casing pops out of the ejection port on the handle (+Z) side.
    fire.casingT = 0;
    fire.casing.x = 0.35; fire.casing.y = 0.78; fire.casing.z = 0.36;
    fire.casing.vx = 2.4; fire.casing.vy = 2.6; fire.casing.vz = 1.6;
    casingMesh.visible = true;
    casingMesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    fire.boltT = 0;
    fire.recoilT = 0;
    fire.rounds += 1;
    return true;
  };
  root.userData.fire = fireRifle;
  root.userData.fireState = {
    get ready() { return fire.cooldown <= 0; },
    get rounds() { return fire.rounds; },
  };

  addPaintPanels(root, mats, runtime);
  const medusaEyes = createMedusaEyeAccents(root, runtime);
  root.userData.medusaEyes = medusaEyes;
  root.userData.sculptRuntime = runtime;
  root.userData.pivots = {
    root: root,
    bolt: runtime.nodes.bolt,
    trigger: runtime.sockets['trigger-pivot'],
    bipod: runtime.nodes['bipod-hinge'],
    bipodLeft: runtime.nodes['bipod-leg-left-pivot'],
    bipodRight: runtime.nodes['bipod-leg-right-pivot'],
    scope: runtime.nodes.scope,
  };
  root.userData.sockets = runtime.sockets;
  // Pass-182: the runtime manifest reported actionAnchors as empty, so nothing
  // declared which pivot drives which socket. Each anchor below names a pivot
  // and a socket that BOTH exist in this build — no scopeZoom or magazineInsert
  // entry is declared, because V2 authors no scope or magazine socket and an
  // anchor pointing at a name that does not exist is worse than an absent one.
  root.userData.actionAnchors = {
    boltCycle: { pivot: 'bolt', socket: 'bolt-pivot' },
    boltHandleThrow: { pivot: 'bolt', socket: 'bolt-handle-root' },
    triggerPull: { pivot: 'trigger', socket: 'trigger-pivot' },
    bipodFoldLeft: { pivot: 'bipod-leg-left-pivot', socket: 'bipod-leg-left-socket' },
    bipodFoldRight: { pivot: 'bipod-leg-right-pivot', socket: 'bipod-leg-right-socket' },
    receiverMount: { pivot: 'root', socket: 'receiver-root' },
  };
  root.userData.contactEvidence = {
    stockReceiver: 'profile overlap at x=-1.72..-1.45',
    receiverBarrel: 'barrel shoulder embedded at x=1.58..1.86',
    scopeMount: 'ring saddles overlap rail and tube',
    boltReceiver: 'receiver-parented bolt sleeve slides inside a real raceway; handle root is socketed to the sleeve',
    triggerReceiver: 'guard overlaps receiver underside',
    magazineReceiver: 'magazine intersects receiver well envelope',
    bipodReceiver: 'hinge plate overlaps receiver underside',
    springs: 'independent spring assemblies run beside, not around, telescoping legs; hooks and collars are grouped with each spring',
  };
  let elapsed = 0;
  root.userData.tick = (dt: number): void => {
    elapsed += dt;
    medusaEyes.tick(dt);
    const bolt = runtime.nodes.bolt;
    if (bolt) {
      const applyCycle = bolt.userData.applyCycle as ((progress: number) => void) | undefined;
      if (applyCycle) {
        if (fire.boltT >= 0) {
          // Full cycle on a shot: rearward slam on the first half, forward
          // return on the second, then hand the bolt back to the idle tick.
          fire.boltT += dt;
          const cycle = fire.boltT / 0.9;
          if (cycle >= 1) fire.boltT = -1;
          else {
            const p = cycle < 0.42 ? cycle / 0.42 : (1 - cycle) / 0.58;
            applyCycle(0.04 + THREE.MathUtils.clamp(p, 0, 1) * 0.96);
          }
        } else {
          applyCycle(0.04 + (Math.sin(elapsed * 0.65) * 0.5 + 0.5) * 0.08);
        }
      }
    }
    const scope = runtime.nodes.scope;
    if (scope) scope.rotation.z = Math.sin(elapsed * 0.25) * 0.002;
    bipod.tick(dt);
    // --- firing effects ---
    if (fire.cooldown > 0) fire.cooldown = Math.max(0, fire.cooldown - dt);
    if (fire.flashT >= 0) {
      fire.flashT += dt;
      const k = fire.flashT / 0.13;
      if (k >= 1) {
        fire.flashT = -1;
        flashGroup.visible = false;
        flashLight.intensity = 0;
      } else {
        flashGroup.visible = true;
        const decay = 1 - k;
        flashGroup.scale.setScalar(1 + k * 0.8);
        flashMat.opacity = decay;
        flashLight.intensity = 46 * decay;
      }
    }
    if (fire.tracerT >= 0) {
      fire.tracerT += dt;
      // Fast enough to read as a shot, slow enough that the streak stays inside
      // the fired camera framing (camera punches back ~5.5 units on fire) for
      // a readable beat before it exits the right edge.
      tracerMesh.position.x += 5.5 * dt;
      const life = 0.62;
      if (fire.tracerT >= life) {
        fire.tracerT = -1;
        tracerMesh.visible = false;
      } else {
        const fade = fire.tracerT > life * 0.38 ? 1 - (fire.tracerT - life * 0.38) / (life * 0.62) : 1;
        tracerMesh.material.opacity = 0.95 * fade;
      }
    }
    if (fire.casingT >= 0) {
      fire.casingT += dt;
      const c = fire.casing;
      c.vy -= 9.8 * dt;
      c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
      casingMesh.position.set(c.x, c.y, c.z);
      casingMesh.rotation.x += 7 * dt;
      casingMesh.rotation.z += 5 * dt;
      if (fire.casingT > 1.3) {
        fire.casingT = -1;
        casingMesh.visible = false;
      }
    }
    if (fire.recoilT >= 0) {
      fire.recoilT += dt;
      const k = fire.recoilT / 0.22;
      if (k >= 1) {
        fire.recoilT = -1;
        root.position.set(0, 0, 0);
      } else {
        // Damped kick-and-return pulse; settles exactly back to the rest pose.
        root.position.x = -0.1 * Math.sin(k * Math.PI) * Math.exp(-2.5 * k);
      }
    }
  };
  root.traverse((object) => {
    object.userData.v2 = true;
    object.castShadow = options.shadows ?? true;
    object.receiveShadow = options.shadows ?? true;
    if (object.name.includes('painted-shell') || object.name.includes('crown-skull') || object.name.includes('cheek')) {
      object.userData.explodeWithParent = true;
    }
  });
  // Keep the receiver visible in the runtime map even though its side shell also owns paint.
  runtime.nodes.receiver = receiver;
  // Contact evidence is derived from the authored scene after transforms are
  // resolved. These boxes are diagnostic envelopes, not attachment metadata.
  root.updateWorldMatrix(true, true);
  for (const id of [
    'stock', 'receiver', 'barrel', 'scope', 'bolt', 'trigger-guard', 'magazine',
    'bipod-hinge', 'bipod-leg-left', 'bipod-leg-right', 'bipod-spring-left',
    'bipod-spring-right', 'bipod-foot-left', 'bipod-foot-right', 'stock-pistol-grip-fillet', 'magazine-well',
    'bolt-handle', 'barrel-front-sight-block',
  ]) {
    const object = runtime.nodes[id] ?? runtime.meshes[id];
    if (object) {
      const box = new THREE.Box3().setFromObject(object);
      runtime.colliderById[id] = box;
      runtime.colliders.push({ id, type: 'box', min: box.min.clone(), max: box.max.clone() });
    }
  }
  const contact = (id: string, a: string, b: string, note: string): Record<string, unknown> => {
    const boxA = runtime.colliderById[a];
    const boxB = runtime.colliderById[b];
    if (!boxA || !boxB) return { id, a, b, status: 'missing-collider', note };
    const overlap = [
      Math.min(boxA.max.x, boxB.max.x) - Math.max(boxA.min.x, boxB.min.x),
      Math.min(boxA.max.y, boxB.max.y) - Math.max(boxA.min.y, boxB.min.y),
      Math.min(boxA.max.z, boxB.max.z) - Math.max(boxA.min.z, boxB.min.z),
    ];
    const gap = [
      Math.max(boxA.min.x - boxB.max.x, boxB.min.x - boxA.max.x, 0),
      Math.max(boxA.min.y - boxB.max.y, boxB.min.y - boxA.max.y, 0),
      Math.max(boxA.min.z - boxB.max.z, boxB.min.z - boxA.max.z, 0),
    ];
    return {
      id, a, b, status: overlap.every((value) => value >= 0) ? 'intersects-or-touches' : 'gap',
      overlap, closestGap: Math.hypot(...gap), note,
    };
  };
  const contacts = [
    contact('stock-to-receiver', 'stock', 'receiver', 'profile seam'),
    contact('receiver-to-barrel', 'receiver', 'barrel', 'barrel shoulder seats into receiver front'),
    // The front-sight block is a clamped band, so it must carry contact evidence like any other
    // seated part. It was added during the barrel rebuild without one, which left the assembly
    // phase's contact audit blind to the only new load-bearing joint on the barrel.
    contact('barrel-to-front-sight-block', 'barrel', 'barrel-front-sight-block', 'squared block clamps over the barrel tube'),
    contact('receiver-to-scope-rail', 'receiver', 'scope', 'scope group envelope is checked; ring saddles are the authored seam'),
    contact('receiver-to-bolt', 'receiver', 'bolt', 'receiver-parented bolt sleeve slides inside authored raceway'),
    contact('bolt-to-bolt-handle', 'bolt', 'bolt-handle', 'handle hinge root seats on the rear bolt-body face and cycles with the sleeve'),
    contact('receiver-to-trigger-guard', 'receiver', 'trigger-guard', 'guard enters underside opening'),
    contact('stock-grip-fillet-to-trigger-guard', 'stock-pistol-grip-fillet', 'trigger-guard', 'molded shell fillet receives the forward guard bridge'),
    contact('receiver-to-magazine', 'receiver', 'magazine', 'magazine enters receiver well'),
    contact('magazine-well-to-magazine', 'magazine-well', 'magazine', 'stamped magazine seats inside the real well envelope'),
    contact('receiver-to-bipod-hinge', 'receiver', 'bipod-hinge', 'hinge plate meets underside'),
    contact('bipod-hinge-to-spring-left', 'bipod-hinge', 'bipod-spring-left', 'top hook seats into hinge-side collar; coil remains external to leg'),
    contact('bipod-hinge-to-spring-right', 'bipod-hinge', 'bipod-spring-right', 'top hook seats into hinge-side collar; coil remains external to leg'),
    contact('bipod-spring-left-to-leg', 'bipod-spring-left', 'bipod-leg-left', 'bottom hook wraps the leg-side spring anchor; coil remains separate from telescoping tube'),
    contact('bipod-spring-right-to-leg', 'bipod-spring-right', 'bipod-leg-right', 'bottom hook wraps the leg-side spring anchor; coil remains separate from telescoping tube'),
  ];
  runtime.attachmentGate = {
    contractVersion: 'world-contact-v2',
    maxVisibleGap: 0.015,
    contacts,
    renderedContactEvidence: '.img2threejs/v2/renders/pass-5/orbit-left.png;.img2threejs/v2/renders/pass-5/orbit-right.png',
    note: 'AABB envelopes are diagnostic evidence paired with rendered orbit inspection; they do not replace mesh-level contact review.',
  };
  runtime.attachmentAudit = {
    contractVersion: 'joint-attachment-v2',
    physicalContactPairs: contacts.map((entry) => entry.id),
    metadataOnly: false,
    note: 'Each pair is derived after world transforms from authored component groups.',
  };
  runtime.adjacency = contacts.map((entry) => ({
    a: entry.a, b: entry.b, contactType: entry.status, closestGap: entry.closestGap ?? null,
  }));
  runtime.destructionGroups = {
    stock: ['stock', 'stock-pistol-grip-fillet', 'stock-buttpad'],
    receiver: ['receiver', 'receiver-bolt-side-pocket', 'receiver-top-rail-mesh'],
    optic: ['scope', 'scope-eyepiece', 'scope-main-tube', 'scope-objective-taper', 'scope-ring-rear', 'scope-ring-front', 'scope-ring-rear-clamp-plate', 'scope-ring-front-clamp-plate', 'crown-skull-sticker'],
    boltAction: ['bolt', 'bolt-raceway', 'bolt-body', 'bolt-shroud', 'bolt-head-block', 'bolt-side-sleeve', 'bolt-locking-lug', 'bolt-handle', 'bolt-knob-neck', 'bolt-knob', 'trigger-guard', 'trigger', 'magazine', 'magazine-well'],
    barrelAssembly: ['barrel', 'barrel-front-sight-block', 'muzzle', 'muzzle-bore', 'bipod-hinge', 'bipod-leg-left', 'bipod-leg-right'],
    finish: ['painted-shell-visible-surface', 'painted-shell-visible-surface-back'],
  };
  runtime.logicalComponents = {
    root: { kind: 'assembly', binding: 'AWP_Medusa_V2', boundMeshes: [] },
    stock: { kind: 'profile-shell', binding: 'stock', boundMeshes: ['stock'] },
    'stock-pistol-grip-fillet': { kind: 'molded-receiving-fillet', binding: 'stock', boundMeshes: ['stock-pistol-grip-fillet'] },
    'stock-buttpad': { kind: 'cap', binding: 'stock', boundMeshes: ['stock-buttpad'] },
    finish: { kind: 'stock-owned-surface', binding: 'stock', boundMeshes: ['painted-shell-visible-surface', 'painted-shell-visible-surface-back'] },
    receiver: { kind: 'profile-shell', binding: 'receiver', boundMeshes: ['receiver', 'receiver-bolt-side-pocket'] },
    'receiver-top-rail': { kind: 'rail', binding: 'receiver-top-rail', boundMeshes: ['receiver-top-rail'] },
    barrel: { kind: 'coaxial-cylinder', binding: 'barrel', boundMeshes: ['barrel'] },
    muzzle: { kind: 'muzzle-assembly', binding: 'muzzle', boundMeshes: ['muzzle'] },
    'muzzle-bore': { kind: 'open-bore', binding: 'muzzle-bore', boundMeshes: ['muzzle-bore'] },
    scope: { kind: 'optic-assembly', binding: 'scope', boundMeshes: ['scope-main-tube', 'scope-eyepiece', 'scope-objective-taper'] },
    'scope-objective-taper': { kind: 'tapered-optic', binding: 'scope', boundMeshes: ['scope-objective-taper'] },
    'scope-eyepiece': { kind: 'ocular', binding: 'scope', boundMeshes: ['scope-eyepiece'] },
    'scope-glass': { kind: 'reflective-glass', binding: 'scope', boundMeshes: ['scope-glass-eyepiece', 'scope-objective-glass'] },
    'scope-mount': { kind: 'two-point-mount', binding: 'scope-mount', boundMeshes: ['scope-ring-front', 'scope-ring-rear'] },
    'scope-ring-front': { kind: 'clamp-ring', binding: 'scope-mount', boundMeshes: ['scope-ring-front', 'scope-ring-front-clamp-cap', 'scope-ring-front-clamp-plate', 'scope-ring-front-upper-fastener', 'scope-ring-front-lower-fastener'] },
    'scope-ring-rear': { kind: 'clamp-ring', binding: 'scope-mount', boundMeshes: ['scope-ring-rear', 'scope-ring-rear-clamp-cap', 'scope-ring-rear-clamp-plate', 'scope-ring-rear-upper-fastener', 'scope-ring-rear-lower-fastener'] },
    'scope-turret': {
      kind: 'knurled-turret',
      binding: 'scope',
      boundMeshes: [
        'scope-turret-main', 'scope-turret-side', 'scope-turret-side-boss',
        'scope-turret-side-stem', 'scope-turret-side-socket',
        'scope-turret-side2', 'scope-turret-side2-boss', 'scope-turret-side2-stem',
        'scope-turret-side2-socket',
      ],
    },
    bolt: { kind: 'receiver-action', binding: 'bolt', boundMeshes: ['bolt-raceway', 'bolt-body', 'bolt-shroud', 'bolt-head-block', 'bolt-side-sleeve', 'bolt-rear-collar', 'bolt-locking-lug', 'bolt-handle-pivot-pin'] },
    'bolt-handle': { kind: 'curved-lever', binding: 'bolt', boundMeshes: ['bolt-handle', 'bolt-knob-neck', 'bolt-knob'] },
    'trigger-guard': { kind: 'guard-loop', binding: 'trigger-guard', boundMeshes: ['trigger-guard'] },
    trigger: { kind: 'trigger-blade', binding: 'trigger-guard', boundMeshes: ['trigger'] },
    magazine: { kind: 'magazine', binding: 'magazine', boundMeshes: ['magazine', 'magazine-feed-lip', 'magazine-side-rib-1', 'magazine-side-rib-2', 'magazine-side-rib-3', 'magazine-side-rib-4'] },
    'magazine-well': { kind: 'receiver-magazine-well', binding: 'magazine', boundMeshes: ['magazine-well'] },
    'bipod-hinge': { kind: 'hinge', binding: 'bipod-hinge', boundMeshes: ['bipod-hinge'] },
    'bipod-leg-left': { kind: 'telescoping-leg', binding: 'bipod-leg-left', boundMeshes: ['bipod-leg-left-outer', 'bipod-leg-left-inner'] },
    'bipod-leg-right': { kind: 'telescoping-leg', binding: 'bipod-leg-right', boundMeshes: ['bipod-leg-right-outer', 'bipod-leg-right-inner'] },
    'bipod-spring-left': { kind: 'separate-coil-spring', binding: 'bipod-spring-left', boundMeshes: ['bipod-spring-left-coil', 'bipod-spring-left-top-hook', 'bipod-spring-left-bottom-hook', 'bipod-spring-left-top-collar', 'bipod-spring-left-bottom-collar'] },
    'bipod-spring-right': { kind: 'separate-coil-spring', binding: 'bipod-spring-right', boundMeshes: ['bipod-spring-right-coil', 'bipod-spring-right-top-hook', 'bipod-spring-right-bottom-hook', 'bipod-spring-right-top-collar', 'bipod-spring-right-bottom-collar'] },
    'bipod-foot-left': { kind: 'support-foot', binding: 'bipod-leg-left', boundMeshes: ['bipod-foot-left'] },
    'bipod-foot-right': { kind: 'support-foot', binding: 'bipod-leg-right', boundMeshes: ['bipod-foot-right'] },
  };
  return root;
}

export function createAWPMedusaMinimalWearLookDevLights(): THREE.Group {
  const lights = new THREE.Group();
  lights.name = 'AWP_Medusa_V2_Lights';
  const key = new THREE.DirectionalLight(0xdbe8ff, 3.1);
  key.position.set(-3, 6, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  lights.add(key);
  const fill = new THREE.DirectionalLight(0x4b73a6, 1.4);
  fill.position.set(4, 1, -5);
  lights.add(fill);
  const rim = new THREE.PointLight(0x64b9ff, 5, 14);
  rim.position.set(1, 3, -3);
  lights.add(rim);
  lights.add(new THREE.HemisphereLight(0x9ab4c4, 0x05070b, 0.72));
  return lights;
}

export function createAWPMedusaMinimalWearEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return environment;
}

export function makeAWPMedusaMinimalWearBackground(): THREE.Color {
  return new THREE.Color(0x05070b);
}
