import * as THREE from 'three';

/**
 * The catch of light that runs down a blade.
 *
 * WHAT IT IS FOR. A sharp edge is not a shape, it is a behaviour of light: the thing that reads as "keen"
 * is a specular line so narrow it is almost a wire, travelling as the geometry turns under a source. The
 * blades here are 1 m of near-mirror steel (`roughness: 0.18, metalness: 1`) and the turntable moves the
 * CAMERA rather than the model, so nothing sweeps a highlight across them on its own -- the environment map
 * sits still in the blade's own frame and the edge stays a flat grey bar. This puts the sweep back.
 *
 * WHY IN THE SHADER AND NOT AS A LIGHT. A moving light bright enough to streak one blade also lights the
 * hip, the glove and the coat behind it, and the highlight it leaves is the width of the source rather than
 * the width of an edge. Adding emissive per fragment, keyed to a coordinate ALONG the blade, gives a streak
 * whose width is a property of the effect instead of a property of the scene, costs one varying, and cannot
 * touch anything but the two meshes it is installed on.
 *
 * WHY THE AXIS IS MEASURED AND NOT ASSUMED. Both swords hang across the body at an angle: `sword-l` spans
 * 0.81 m in Y and 0.95 m in Z, so no cardinal axis is the blade, the bounding box's longest side is a
 * diagonal artefact, and a sweep along either would cross the edge at a slant. The direction is taken from
 * the geometry itself as its first principal component, which for a long thin object IS its length.
 */

export type BladeGlint = { update(dt: number): void };

/** Seconds between one sweep and the next. Long enough to read as a catch of light, not a pulse. */
const PERIOD_S = 3.9;

/** How long a single sweep takes to cross the blade. Fast: a glint is caught, not watched. */
const SWEEP_S = 0.40;

/** Streak half-width, as a fraction of blade length. The core is a third of this again. */
const BAND = 0.115;

/** Emissive gain at the core of the streak. */
const STRENGTH = 2.4;

/** Slightly cool, because the steel is cool and a warm streak reads as a different material. */
const COLOUR = new THREE.Color(0.62, 0.72, 0.86);

/**
 * The blade's own long axis, and where its tip is.
 *
 * The first principal component of the vertex cloud, by power iteration on the covariance matrix -- 24
 * iterations, which is far more than a shape this anisotropic needs. Seeded from the widest bounding-box
 * axis so the iteration starts in the right half-space rather than converging to a sign at random, which
 * would decide tip-versus-hilt by chance.
 */
function principalAxis(position: THREE.BufferAttribute): {
  axis: THREE.Vector3; origin: THREE.Vector3; length: number; sweepEnd: number;
} | null {
  const n = position.count;
  if (n < 16) return null;

  // Mean, and a stride: 28,000 vertices is far more than a direction needs, and every one of them costs.
  const stride = Math.max(1, Math.floor(n / 4000));
  const mean = new THREE.Vector3();
  let taken = 0;
  for (let i = 0; i < n; i += stride) {
    mean.x += position.getX(i); mean.y += position.getY(i); mean.z += position.getZ(i);
    taken += 1;
  }
  mean.multiplyScalar(1 / taken);

  // Covariance, upper triangle only -- it is symmetric.
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < n; i += stride) {
    const dx = position.getX(i) - mean.x;
    const dy = position.getY(i) - mean.y;
    const dz = position.getZ(i) - mean.z;
    xx += dx * dx; xy += dx * dy; xz += dx * dz;
    yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }

  const seed = xx >= yy && xx >= zz ? new THREE.Vector3(1, 0, 0)
    : yy >= zz ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(0, 0, 1);
  const v = seed.clone();
  const out = new THREE.Vector3();
  for (let k = 0; k < 24; k += 1) {
    out.set(
      xx * v.x + xy * v.y + xz * v.z,
      xy * v.x + yy * v.y + yz * v.z,
      xz * v.x + yz * v.y + zz * v.z,
    );
    if (out.lengthSq() < 1e-20) return null;
    v.copy(out).normalize();
  }

  // Project every sampled vertex to find the two ends, and which of them is the tip.
  let lo = Infinity, hi = -Infinity;
  const loPoint = new THREE.Vector3();
  const hiPoint = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i < n; i += stride) {
    p.set(position.getX(i), position.getY(i), position.getZ(i));
    const t = p.dot(v);
    if (t < lo) { lo = t; loPoint.copy(p); }
    if (t > hi) { hi = t; hiPoint.copy(p); }
  }
  const length = hi - lo;
  if (!(length > 1e-4)) return null;

  /**
   * THE TIP IS THE END FURTHER FROM THE BODY, measured as horizontal distance from the model's vertical
   * axis. The hilt is in a hand at the hip; the point is out in the air. Deciding it by the sign the power
   * iteration happened to settle on would have run half the sweeps backwards -- and the brief is explicit
   * that the light travels from the tip inward.
   */
  const tipIsHi = Math.hypot(hiPoint.x, hiPoint.z) >= Math.hypot(loPoint.x, loPoint.z);
  const tip = tipIsHi ? hiPoint : loPoint;
  // Oriented tip -> base, so the sweep parameter is 0 at the tip and 1 at the hilt in both blades.
  const axis = v.clone().multiplyScalar(tipIsHi ? -1 : 1);

  /**
   * WHERE THE EDGE STOPS, found from the width profile rather than assumed.
   *
   * The light belongs on the cutting edge and nowhere else, so the sweep has to end where the blade does
   * -- at the crossguard, with the hand just beyond it. The guard announces itself: a blade holds 17-24 mm
   * off the axis for its whole length and the guard jumps to about 80 mm in a single bucket. Detected
   * rather than hardcoded because the two swords are not the same length and their guards do not sit at the
   * same fraction -- measured at t = 0.75 on the left and 0.71 on the right, and a shared constant would
   * have run one of them into the grip.
   */
  const BUCKETS = 24;
  const widest = new Float32Array(BUCKETS);
  const scratch = new THREE.Vector3();
  for (let i = 0; i < n; i += stride) {
    scratch.set(position.getX(i), position.getY(i), position.getZ(i)).sub(tip);
    const along = scratch.dot(axis);
    const t = along / length;
    if (t < 0 || t >= 1) continue;
    const perp = Math.sqrt(Math.max(0, scratch.lengthSq() - along * along));
    const b = Math.min(BUCKETS - 1, Math.floor(t * BUCKETS));
    if (perp > widest[b]) widest[b] = perp;
  }
  // The blade's own width, as the median over its front half -- a median so a single stray vertex or a
  // decorative notch cannot set the reference the guard is compared against.
  const front = Array.from(widest.slice(1, Math.floor(BUCKETS * 0.55))).filter((w) => w > 0)
    // Numeric comparator: the default sort is lexicographic, which on 0.017 vs 0.0024 picks a median
    // that is not one.
    .sort((a, b) => a - b);
  const bladeWidth = front.length ? front[Math.floor(front.length / 2)] : 0;
  let sweepEnd = 0.80;
  if (bladeWidth > 0) {
    for (let b = Math.floor(BUCKETS * 0.45); b < BUCKETS; b += 1) {
      if (widest[b] > bladeWidth * 2.2) {
        // Stop at the START of the guard's bucket: the streak should die as it reaches the hand, not run
        // into it.
        sweepEnd = b / BUCKETS;
        break;
      }
    }
  }
  return { axis, origin: tip.clone(), length, sweepEnd };
}

/**
 * Install the sweep on one blade.
 *
 * The material is CLONED, and that is not a precaution: at the surface detail level every part of this
 * model shares a single material instance carrying the atlas -- both swords and the hair among them -- so
 * patching in place would have run a steel glint down the ponytail.
 *
 * `phase` offsets one blade against the other; two swords glinting in unison read as one object.
 */
export function createBladeGlint(mesh: THREE.Mesh, phase = 0): BladeGlint | null {
  const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!position) return null;
  const frame = principalAxis(position);
  if (!frame) return null;

  const uniforms = {
    uGlintAxis: { value: frame.axis },
    uGlintOrigin: { value: frame.origin },
    uGlintInvLen: { value: 1 / frame.length },
    // Parked well off the blade, so nothing glows between sweeps.
    uGlintSweep: { value: -9 },
    uGlintBand: { value: BAND },
    uGlintStrength: { value: STRENGTH },
    uGlintColour: { value: COLOUR },
  };

  const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const material = (source as THREE.Material).clone();
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uGlintAxis;
        uniform vec3 uGlintOrigin;
        uniform float uGlintInvLen;
        varying float vGlintT;`)
      // `position` and not `transformed`: the bind-pose coordinate is what stays put along the blade, so
      // the streak keeps its place on the steel however the arm is posed.
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vGlintT = dot(position - uGlintOrigin, uGlintAxis) * uGlintInvLen;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uGlintSweep;
        uniform float uGlintBand;
        uniform float uGlintStrength;
        uniform vec3 uGlintColour;
        varying float vGlintT;`)
      // Added to the emissive term, which is the one channel a light cannot be confused with: it does not
      // depend on a normal, so the streak stays the same width whatever the blade is doing.
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float gd = abs(vGlintT - uGlintSweep);
          // A wire-thin core inside a soft halo. The core is what reads as an edge; the halo is the light
          // coming off it. One term alone reads as either a scratch or a smear.
          float core = 1.0 - smoothstep(0.0, uGlintBand * 0.34, gd);
          float halo = 1.0 - smoothstep(0.0, uGlintBand, gd);
          totalEmissiveRadiance += uGlintColour * uGlintStrength * (core * core + halo * 0.30);
        }`);
  };
  // Without this, three may hand this material the program it compiled for the unpatched original, and
  // the patch silently does nothing.
  material.customProgramCacheKey = () => 'girl-character-3-blade-glint';
  material.needsUpdate = true;
  mesh.material = material;

  let clock = phase;
  return {
    update(dt: number): void {
      // A backgrounded tab returns one huge dt; letting it through would skip whole sweeps.
      clock = (clock + Math.min(dt, 1 / 15)) % PERIOD_S;
      uniforms.uGlintSweep.value = clock < SWEEP_S
        // Eased, because a linear streak reads as a scanline. Slow off the point, quickest across the
        // middle of the blade, settling as it reaches the hand.
        //
        // Scaled by `sweepEnd` so it dies at the crossguard: the grip and the pommel are not edges and a
        // light running over them reads as the whole sword glowing rather than as a sharpened one.
        ? (1 - Math.cos((clock / SWEEP_S) * Math.PI)) * 0.5 * frame.sweepEnd
        : -9;
    },
  };
}
