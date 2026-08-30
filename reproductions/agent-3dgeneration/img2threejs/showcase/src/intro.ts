const SEEN_KEY = 'img2threejs:intro-seen';

function safeSessionGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSessionSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* private mode / storage disabled — the intro just replays next time, which is harmless */
  }
}

export function hasSeenIntro(): boolean {
  return safeSessionGet(SEEN_KEY) === '1';
}

/**
 * Measured: the hero's own staged entrance (`.home.ready .hero-copy > *`, 0.7s plus delays to
 * 0.41s) has fully settled by ~1.05s. Holding the overlay to 2s meant the fade revealed content
 * that had already finished animating, so the handoff looked static. Ending just as the last hero
 * element lands puts the two animations back in sequence.
 */
const RUN_DURATION_MS = 1250;
const FADE_DURATION_MS = 480;

/**
 * One-time full-viewport brand intro, built from the img2threejs mark itself: the same three
 * "source pixel" swatches and isometric cube as `favicon.svg`, animated through the pipeline's
 * own idea — reference image dissolving into a procedural 3D form — rather than a generic splash.
 *
 * The page underneath is already fully mounted before this runs (see main.ts), so the overlay
 * only ever cross-fades on top of real, laid-out content. There is no blank frame to gap into.
 */
export function runIntro(onDone: () => void): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    safeSessionSet(SEEN_KEY, '1');
    onDone();
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'intro-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `
    <div class="intro-stage">
      <svg class="intro-mark" viewBox="0 0 64 64" width="92" height="92">
        <defs>
          <linearGradient id="intro-top" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#5aa9ff"/><stop offset="1" stop-color="#22d3c8"/>
          </linearGradient>
          <linearGradient id="intro-left" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#22d3c8"/><stop offset="1" stop-color="#0f6e78"/>
          </linearGradient>
          <linearGradient id="intro-right" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#3163d6"/><stop offset="1" stop-color="#182a6b"/>
          </linearGradient>
          <linearGradient id="intro-pix" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#5aa9ff"/><stop offset="1" stop-color="#22d3c8"/>
          </linearGradient>
        </defs>
        <g class="intro-pixels">
          <rect x="6" y="40" width="6" height="6" rx="1.4" fill="url(#intro-pix)" style="--d:0"></rect>
          <rect x="6" y="48" width="6" height="6" rx="1.4" fill="url(#intro-pix)" style="--d:1"></rect>
          <rect x="14" y="48" width="6" height="6" rx="1.4" fill="url(#intro-pix)" style="--d:2"></rect>
        </g>
        <g class="intro-cube">
          <polygon class="intro-face" style="--d:0" points="32,9 53,21 32,33 11,21" fill="url(#intro-top)"></polygon>
          <polygon class="intro-face" style="--d:1" points="11,21 32,33 32,56 11,44" fill="url(#intro-left)"></polygon>
          <polygon class="intro-face" style="--d:2" points="53,21 32,33 32,56 53,44" fill="url(#intro-right)"></polygon>
        </g>
        <path class="intro-glint" d="M30 15 l1.6 3.2 3.2 1.6 -3.2 1.6 -1.6 3.2 -1.6 -3.2 -3.2 -1.6 3.2 -1.6 z" fill="#f4faff"></path>
      </svg>
      <div class="intro-word"><span class="grad">img2threejs</span></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Next frame, so the browser commits the initial (pre-animation) state before the
  // "-run" class flips every animation on — otherwise some browsers fold the two paints
  // into one and the entrance animations never visibly play.
  requestAnimationFrame(() => overlay.classList.add('intro-run'));

  window.setTimeout(() => {
    overlay.classList.add('intro-fade');
    onDone();
    window.setTimeout(() => overlay.remove(), FADE_DURATION_MS);
  }, RUN_DURATION_MS);

  safeSessionSet(SEEN_KEY, '1');
}
