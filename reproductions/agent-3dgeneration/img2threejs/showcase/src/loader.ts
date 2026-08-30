/**
 * The branded build loader.
 *
 * Heavy exhibits are genuinely slow: `girl-character` decodes a multi-megabyte encoded Surface-Nets
 * stream and `low-poly-humanoid` evaluates a 2.12M-sample signed-distance field. Until now the
 * detail route showed an empty scene for that whole time and the geometry simply popped in.
 *
 * ONE HONEST LIMITATION, by design rather than oversight: a demo's `build()` is synchronous by
 * contract, so while it runs the main thread is blocked and CSS animation cannot advance — the mark
 * will sit still for those seconds. Two things follow from that, and both are deliberate here:
 *   1. every frozen frame has to look like the logo on purpose, so no stage animates through a
 *      near-invisible or half-collapsed state;
 *   2. the phase line says what is happening, because a still image plus "Precomputing field" reads
 *      as work in progress where a still image alone reads as a hung page.
 * The long stage for the two heavy demos (`prewarm`) DOES yield, so the animation runs there.
 *
 * There is no percentage. Nothing in the pipeline reports progress, and a bar that invents one is
 * worse than no bar.
 */

export interface Loader {
  /** Replaces the phase line. Safe to call after `done()` (no-op). */
  phase(text: string): void;
  /** Fades out and removes the element. Idempotent. */
  done(): void;
}

const FADE_MS = 260;

/** Mounts the loader as an overlay inside `mount`, which must be a positioned element. */
export function createLoader(mount: HTMLElement, initialPhase = 'Building geometry'): Loader {
  const el = document.createElement('div');
  el.className = 'ldr';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <div class="ldr-inner">
      <svg class="ldr-mark" viewBox="0 0 64 64" width="72" height="72" aria-hidden="true">
        <g class="ldr-pixels">
          <rect x="6" y="40" width="6" height="6" rx="1.4" style="--d:0"></rect>
          <rect x="6" y="48" width="6" height="6" rx="1.4" style="--d:1"></rect>
          <rect x="14" y="48" width="6" height="6" rx="1.4" style="--d:2"></rect>
        </g>
        <g class="ldr-cube">
          <polygon class="ldr-top" points="32,9 53,21 32,33 11,21"></polygon>
          <polygon class="ldr-left" points="11,21 32,33 32,56 11,44"></polygon>
          <polygon class="ldr-right" points="53,21 32,33 32,56 53,44"></polygon>
        </g>
      </svg>
      <div class="ldr-phase mono"></div>
      <div class="ldr-bar" aria-hidden="true"><span></span></div>
    </div>
  `;
  const phaseEl = el.querySelector<HTMLElement>('.ldr-phase')!;
  phaseEl.textContent = initialPhase;
  mount.appendChild(el);

  let finished = false;
  return {
    phase(text: string): void {
      if (finished) return;
      phaseEl.textContent = text;
    },
    done(): void {
      if (finished) return;
      finished = true;
      el.classList.add('is-done');
      window.setTimeout(() => el.remove(), FADE_MS);
    },
  };
}

/**
 * Resolves on the viewer's own first-good-frame signal — the flag `Viewer.start()` raises after
 * pending texture loads settle plus a few frames for shader compile and buffer flip. Polled rather
 * than subscribed because it is a plain global with no event, and bounded by `timeoutMs` so a demo
 * that never raises it cannot strand the loader on screen forever.
 */
export function whenViewerReady(timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve) => {
    const w = window as unknown as { __IMG2THREEJS_READY__?: boolean };
    const deadline = performance.now() + timeoutMs;
    const poll = (): void => {
      if (w.__IMG2THREEJS_READY__ === true || performance.now() > deadline) {
        resolve();
        return;
      }
      requestAnimationFrame(poll);
    };
    poll();
  });
}
