/**
 * Whether this page load is a headless review/capture run rather than a human visit.
 *
 * The review harness (`scripts/capture-*.mjs`) loads `#/demo/<id>` with flags like `capture=1` /
 * `back=1` / `mask=1` and screenshots as soon as the model reports ready. Two unrelated concerns
 * need to agree on that answer — `main.ts` suppresses the intro overlay and the route cross-fade,
 * and `analytics.ts` must not report a robot's page loads as traffic — so the test lives here
 * rather than being written twice with a chance of drifting apart.
 */
const CAPTURE_FLAGS = ['capture', 'mask', 'back', 'bg', 'reviewWhite'] as const;

export function isCaptureRun(): boolean {
  // Flags ride on the hash (`#/demo/x?capture=1`) as often as on the real query string.
  if (/[?&](capture|mask|back|bg|reviewWhite)=/.test(window.location.hash)) return true;
  const search = new URLSearchParams(window.location.search);
  return CAPTURE_FLAGS.some((key) => search.has(key));
}
