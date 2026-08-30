import * as THREE from 'three';
import type { Viewer } from './scene';

/**
 * "Look through the optic" mode.
 *
 * Entirely socket-driven: a model opts in by publishing a `scope-sight-line` socket carrying an
 * `optic` userData block. Nothing here knows it is looking at a rifle, so any future demo with a
 * sighting device gets the same behaviour for free.
 *
 * The clear field of view is not painted or faked. Seen from the eye station the tube's own wall
 * faces away from the camera and is removed by normal backface culling, so once the two lens discs
 * are hidden the bore is genuinely see-through. That is why this needs no cutaway geometry and no
 * second render target.
 *
 * The reticle is built with DOM/SVG element factories rather than markup strings: the two labels are
 * caller-supplied, so they go in as text nodes and can never be parsed as markup.
 */

export interface OpticSocket extends THREE.Object3D {
  userData: {
    socket?: { id: string; axis: number[] };
    optic?: { fovDegrees?: number; eyeReliefFromOcular?: number };
    [key: string]: unknown;
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const EASE = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Meshes hidden while scoped: lens discs would otherwise fill the entire narrow field. */
const LENS_HINT = /glass|lens/i;

/** Reticle strokes, in the 0-100 viewBox: [x1, y1, x2, y2]. */
const CROSSHAIR: Array<[number, number, number, number]> = [
  [50, 4, 50, 40], [50, 60, 50, 96], [4, 50, 40, 50], [60, 50, 96, 50],
];
const HASHES: Array<[number, number, number, number]> = [
  [46.5, 58, 53.5, 58], [47.5, 66, 52.5, 66], [46.5, 74, 53.5, 74], [47.5, 82, 52.5, 82],
  [42, 46.5, 42, 53.5], [34, 47.5, 34, 52.5], [26, 46.5, 26, 53.5],
  [58, 46.5, 58, 53.5], [66, 47.5, 66, 52.5], [74, 46.5, 74, 53.5],
];

function svg(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function buildOverlay(): HTMLDivElement {
  const el = document.createElement('div');
  el.dataset.scopeOverlay = 'true';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = [
    'position:absolute', 'inset:0', 'pointer-events:none',
    'opacity:0', 'transition:opacity 220ms ease', 'z-index:2',
  ].join(';');

  // The eyepiece surround is a radial gradient rather than an SVG mask so it stays crisp at any DPR
  // and costs nothing to composite.
  const surround = document.createElement('div');
  surround.style.cssText = 'position:absolute;inset:0;background:radial-gradient(circle at 50% 50%,'
    + 'rgba(0,0,0,0) 0,rgba(0,0,0,0) min(37vh,37vw),'
    + 'rgba(0,0,0,0.55) calc(min(37vh,37vw) + 1px),'
    + 'rgba(0,0,0,0.97) calc(min(37vh,37vw) + 3.2vh),'
    + 'rgba(0,0,0,0.99) 100%)';
  el.appendChild(surround);

  const root = svg('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'xMidYMid meet' });
  root.setAttribute('style', 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);'
    + 'width:min(74vh,74vw);height:min(74vh,74vw);overflow:visible');

  const ink = svg('g', {
    stroke: 'rgba(12,16,20,0.92)', fill: 'none', 'stroke-width': '0.45', 'stroke-linecap': 'round',
  });
  for (const [x1, y1, x2, y2] of CROSSHAIR) {
    ink.appendChild(svg('line', { x1: `${x1}`, y1: `${y1}`, x2: `${x2}`, y2: `${y2}` }));
  }
  ink.appendChild(svg('circle', { cx: '50', cy: '50', r: '1.5', 'stroke-width': '0.4' }));
  const hashGroup = svg('g', { 'stroke-width': '0.34' });
  for (const [x1, y1, x2, y2] of HASHES) {
    hashGroup.appendChild(svg('line', { x1: `${x1}`, y1: `${y1}`, x2: `${x2}`, y2: `${y2}` }));
  }
  ink.appendChild(hashGroup);
  root.appendChild(ink);

  el.appendChild(root);
  return el;
}

export interface ScopeModeOptions {
  /** Transition duration in ms. */
  durationMs?: number;
  /** Notifies the host when the optic enters or leaves the look-through state. */
  onActiveChange?: (active: boolean) => void;
}

export interface ScopeMode {
  readonly active: boolean;
  toggle(): void;
  /**
   * Reticle hit effect, played by the host when the model fires while scoped
   * (the reticle is the target). No-op when scope mode is inactive.
   */
  hit(): void;
  dispose(): void;
}

/**
 * Wires scope mode to a viewer. Returns null when the model publishes no sight-line socket, which is
 * the caller's signal to leave its button hidden.
 */
export function createScopeMode(
  viewer: Viewer,
  mount: HTMLElement,
  model: THREE.Object3D,
  socket: OpticSocket | undefined,
  options: ScopeModeOptions = {},
): ScopeMode | null {
  if (!socket) return null;

  const duration = options.durationMs ?? 620;
  const overlay = buildOverlay();
  if (getComputedStyle(mount).position === 'static') mount.style.position = 'relative';
  mount.appendChild(overlay);
  // The hit-effect keyframes target [data-scope-fx], so tag the overlay that
  // carries the fx-on class (its semantic role stays data-scope-overlay).
  overlay.dataset.scopeFx = 'true';

  // --- reticle hit effect -----------------------------------------------------
  // "Fired while scoped" payoff: a four-tick hit marker and expanding ring at
  // the reticle centre, plus a 2px shake of the whole optic view. Driven by CSS keyframes
  // (restarted per shot via class toggle + reflow) so it replays on Chrome,
  // Firefox AND Safari — WAAPI-on-SVG transform animation is a Safari gap.
  const reticleSvg = overlay.querySelector('svg')!;
  const hitFx = svg('g', { 'data-scope-fx-child': 'marker', opacity: '0' });
  const TICK = 4;
  for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    hitFx.appendChild(svg('line', {
      x1: `${50 - dx * TICK}`, y1: `${50 - dy * TICK}`,
      x2: `${50 - dx * TICK * 0.4}`, y2: `${50 - dy * TICK * 0.4}`,
      stroke: 'rgba(255,255,255,0.95)', 'stroke-width': '0.55', 'stroke-linecap': 'round',
    }));
  }
  const hitRing = svg('circle', {
    cx: '50', cy: '50', r: '1.5', fill: 'none',
    stroke: 'rgba(255,255,255,0.9)', 'stroke-width': '0.4', 'data-scope-fx-child': 'ring', opacity: '0',
  });
  hitFx.setAttribute('transform-box', 'fill-box');
  hitFx.setAttribute('transform-origin', 'center');
  hitRing.setAttribute('transform-box', 'fill-box');
  hitRing.setAttribute('transform-origin', 'center');
  reticleSvg.appendChild(hitFx);
  reticleSvg.appendChild(hitRing);
  const fxStyle = document.createElement('style');
  fxStyle.textContent = [
    '@keyframes fx-hit-mark { 0% { opacity: 0 } 15% { opacity: 1 } 100% { opacity: 0 } }',
    '@keyframes fx-hit-grow { 0% { transform: scale(0.55) } 100% { transform: scale(1.45) } }',
    '@keyframes fx-ring { 0% { r: 2; opacity: 0.9 } 100% { r: 15; opacity: 0 } }',
    '@keyframes fx-shake { 0%, 100% { transform: translate(0, 0) } 33% { transform: translate(0.7px, -0.9px) } 66% { transform: translate(-0.5px, 0.6px) } }',
    '[data-scope-fx].fx-on { animation: fx-shake 0.17s ease-out; }',
    '[data-scope-fx].fx-on [data-scope-fx-child="marker"] { animation: fx-hit-mark 0.3s ease-out, fx-hit-grow 0.3s ease-out; }',
    '[data-scope-fx].fx-on [data-scope-fx-child="ring"] { animation: fx-ring 0.42s ease-out; }',
  ].join('\n');
  overlay.appendChild(fxStyle);
  const playHit = (): void => {
    if (!active) return;
    // Class-toggle + forced reflow restarts every keyframe animation, so rapid
    // shots chain cleanly instead of queueing stale ones.
    overlay.classList.remove('fx-on');
    void overlay.getBoundingClientRect();
    overlay.classList.add('fx-on');
  };

  const hiddenLenses: THREE.Object3D[] = [];
  const saved = { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: 0 };
  let active = false;
  let raf = 0;

  function opticPose(): { eye: THREE.Vector3; aim: THREE.Vector3; fov: number } {
    model.updateWorldMatrix(true, true);
    const eye = socket!.getWorldPosition(new THREE.Vector3());
    const axisArray = socket!.userData.socket?.axis ?? [1, 0, 0];
    const axis = new THREE.Vector3(axisArray[0], axisArray[1], axisArray[2])
      .transformDirection(socket!.matrixWorld)
      .normalize();
    // Aim far enough down the axis that the orbit target never lands inside the model.
    const aim = eye.clone().add(axis.multiplyScalar(24));
    return { eye, aim, fov: socket!.userData.optic?.fovDegrees ?? 6.2 };
  }

  function animate(
    toPosition: THREE.Vector3,
    toTarget: THREE.Vector3,
    toFov: number,
    onDone?: () => void,
  ): void {
    cancelAnimationFrame(raf);
    const fromPosition = viewer.camera.position.clone();
    const fromTarget = viewer.controls.target.clone();
    const fromFov = viewer.camera.fov;
    const start = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / duration);
      const k = EASE(t);
      viewer.camera.position.lerpVectors(fromPosition, toPosition, k);
      viewer.controls.target.lerpVectors(fromTarget, toTarget, k);
      viewer.camera.fov = fromFov + (toFov - fromFov) * k;
      viewer.camera.updateProjectionMatrix();
      viewer.controls.update();
      if (t < 1) raf = requestAnimationFrame(step);
      else onDone?.();
    };
    raf = requestAnimationFrame(step);
  }

  return {
    get active() { return active; },

    toggle(): void {
      active = !active;
      options.onActiveChange?.(active);
      if (active) {
        saved.position.copy(viewer.camera.position);
        saved.target.copy(viewer.controls.target);
        saved.fov = viewer.camera.fov;
        // Hide the lens discs: at a ~6 degree field they would fill the frame entirely, and with them
        // gone the tube reads through by backface culling alone.
        model.traverse((o) => {
          if ((o as THREE.Mesh).isMesh && LENS_HINT.test(o.name) && o.visible) {
            o.visible = false;
            hiddenLenses.push(o);
          }
        });
        viewer.controls.enabled = false;
        const { eye, aim, fov } = opticPose();
        animate(eye, aim, fov, () => { overlay.style.opacity = '1'; });
      } else {
        overlay.style.opacity = '0';
        animate(saved.position, saved.target, saved.fov, () => {
          viewer.controls.enabled = true;
          for (const o of hiddenLenses) o.visible = true;
          hiddenLenses.length = 0;
        });
      }
    },

    hit(): void {
      playHit();
    },

    dispose(): void {
      cancelAnimationFrame(raf);
      if (active) {
        active = false;
        options.onActiveChange?.(false);
      }
      overlay.classList.remove('fx-on');
      for (const o of hiddenLenses) o.visible = true;
      hiddenLenses.length = 0;
      overlay.remove();
    },
  };
}
