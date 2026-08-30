import * as THREE from 'three';

/**
 * Responsive camera framing.
 *
 * A PerspectiveCamera's `fov` is VERTICAL, so the horizontal field of view shrinks with the
 * viewport aspect. The per-demo cameras in `registry.ts` were art-directed against a wide
 * desktop stage (~16:10); on a phone in portrait (aspect ~0.46) the horizontal frame collapses
 * to a third of its authored width and wide subjects — bikes, shotguns, dioramas — fall
 * completely outside the frame. The helpers below compute how far a camera has to be dollied
 * back so the subject fits on BOTH axes, whatever the viewport.
 */

/** True for shadow-catcher planes — huge, invisible, and not part of the subject's silhouette. */
function isShadowCatcher(mesh: THREE.Mesh): boolean {
  const material = mesh.material;
  const materials = Array.isArray(material) ? material : [material];
  return materials.every((mat) => mat instanceof THREE.ShadowMaterial);
}

/**
 * Union bounding box (world space) of every mesh under `object` that contributes to the visible
 * silhouette. Shadow-catcher ground planes (up to 30 units across) and hidden meshes are skipped
 * so they can't inflate the fit and shrink the subject to a dot.
 */
export function meshBounds(object: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();
  object.updateWorldMatrix(true, true);
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!mesh.visible || isShadowCatcher(mesh)) return;
    // Per-mesh geometry bounds (rather than expandByObject) so a skipped descendant is never
    // pulled back in through its parent's subtree.
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox) return;
    meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
    box.union(meshBox);
  });
  return box;
}

/** The subject as a cylinder around the vertical orbit axis through the camera target. */
export interface SubjectExtent {
  /** Largest horizontal distance from the orbit axis — the silhouette half-width at any angle. */
  horizontal: number;
  /** Largest vertical distance from the target. */
  vertical: number;
}

/**
 * Measures `objects` as a cylinder centred on the vertical axis through `target`.
 *
 * Measuring around the orbit target rather than the box centre preserves the authored
 * composition (the subject stays where the demo put it in frame), and a cylinder — rather than a
 * sphere — is what an orbiting camera actually sees: the fit holds at every azimuth without
 * inflating the horizontal requirement with the subject's height.
 */
export function subjectExtent(objects: THREE.Object3D[], target: THREE.Vector3): SubjectExtent {
  const box = new THREE.Box3();
  for (const object of objects) box.union(meshBounds(object));
  if (box.isEmpty()) return { horizontal: 0, vertical: 0 };

  const extent: SubjectExtent = { horizontal: 0, vertical: 0 };
  for (const x of [box.min.x, box.max.x]) {
    for (const z of [box.min.z, box.max.z]) {
      extent.horizontal = Math.max(extent.horizontal, Math.hypot(x - target.x, z - target.z));
    }
  }
  for (const y of [box.min.y, box.max.y]) {
    extent.vertical = Math.max(extent.vertical, Math.abs(y - target.y));
  }
  return extent;
}

/** Viewport aspect the demo cameras in registry.ts were art-directed against (a wide desktop). */
export const REFERENCE_ASPECT = 1.6;

/**
 * Multiplier to apply to a demo's authored camera distance so `aspect` frames the subject the way
 * the reference aspect did. Returns exactly 1 at (and above) the reference aspect, so desktop
 * framing is never touched — including the demos that deliberately crop in tight, whose tightness
 * is measured and carried over rather than "corrected".
 */
export function fitScale(
  extent: SubjectExtent,
  fovDeg: number,
  aspect: number,
  authoredDistance: number,
  reference = REFERENCE_ASPECT,
): number {
  const here = fitDistance(extent, fovDeg, aspect);
  const atReference = fitDistance(extent, fovDeg, Math.max(aspect, reference));
  if (here <= 0 || atReference <= 0 || authoredDistance <= 0) return 1;
  // <1 when the demo framed tighter than a guaranteed fit — i.e. an intentional crop.
  const tightness = Math.min(1, authoredDistance / atReference);
  return Math.max(1, (here * tightness) / authoredDistance);
}

/**
 * Camera distance at which `extent` fits inside both axes of the frame, at any orbit angle.
 *
 * `margin` is the breathing room around the subject. It cancels out for demos that crop
 * deliberately (see `fitScale`), so it only sets how tightly the demos that DO fit are framed.
 */
export function fitDistance(
  extent: SubjectExtent,
  fovDeg: number,
  aspect: number,
  margin = 1.15,
): number {
  const { horizontal, vertical } = extent;
  if (horizontal <= 0 && vertical <= 0) return 0;

  const halfV = (fovDeg * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * Math.max(0.05, aspect));
  // Horizontally the silhouette is a circle of radius `horizontal`, so the tangent-distance
  // formula is exact. Vertically it is a flat extent that can sit up to `horizontal` closer to
  // the camera, which is what that term pays for.
  const forWidth = horizontal / Math.sin(halfH);
  const forHeight = vertical / Math.tan(halfV) + horizontal;
  return Math.max(forWidth, forHeight) * margin;
}
