import './styles.css';
import { currentRoute, onRouteChange, type Route } from './router';
import { renderWorkbench } from './pages/workbench';
import { renderDemo } from './pages/demo';
import { hasSeenIntro, runIntro } from './intro';
import { isCaptureRun } from './capture-run';
import { initAnalytics, trackPageView } from './analytics';
import { getDemo } from './demos/registry';
import { DRAWERS } from './content';

const app = document.getElementById('app')!;

let cleanupCurrentRoute: (() => void) | null = null;
let firstRender = true;
let pendingTransition: number | null = null;
/** The route the mounted view belongs to, so an in-place exhibit swap does not remount. */
let mountedKind: 'workbench' | 'demo' | null = null;

/**
 * The title reported to GA4 for a route, so the Pages report reads as a list of places on the site
 * rather than eleven thousand rows of the one static `<title>` this single-document app ships with.
 *
 * Only ever a name already on screen — an exhibit title from the registry, a drawer's own heading —
 * never anything derived from what a visitor typed.
 */
function routeTitle(route: Route): string {
  if (route.name === 'demo') return `Viewer — ${getDemo(route.id)?.title ?? route.id}`;
  if (route.name === 'workbench') return `Workbench — ${getDemo(route.id)?.title ?? route.id}`;
  if (route.name === 'drawer') return DRAWERS[route.key]?.title ?? route.key;
  return 'Workbench';
}

function mountRoute(): void {
  const route = currentRoute();

  // `#/x/:id` is the workbench pointed at one exhibit. If the workbench is already mounted, the
  // hash changed because IT changed the hash (or the user hit back), and the workbench swaps
  // models in place — remounting would dispose a live viewer and rebuild it identically.
  if (route.name !== 'demo' && mountedKind === 'workbench') return;

  cleanupCurrentRoute?.();
  cleanupCurrentRoute = null;

  if (route.name === 'demo') {
    mountedKind = 'demo';
    cleanupCurrentRoute = renderDemo(app, route.id);
  } else {
    mountedKind = 'workbench';
    cleanupCurrentRoute = renderWorkbench(app, {
      focusId: route.name === 'workbench' ? route.id : undefined,
      drawer: route.name === 'drawer' ? route.key : undefined,
    });
  }
}

const ROUTE_TRANSITION_MS = 200;

function render(): void {
  if (firstRender) {
    firstRender = false;
    mountRoute();
    // Home only, and never during a capture run: a deep link to an exhibit or the full viewer
    // wants the model, not a splash.
    if (currentRoute().name === 'home' && !isCaptureRun() && !hasSeenIntro()) {
      document.body.classList.add('intro-active');
      runIntro(() => document.body.classList.remove('intro-active'));
    }
    return;
  }

  // An in-place exhibit swap must not fade the page.
  const route = currentRoute();
  if (route.name !== 'demo' && mountedKind === 'workbench') return;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || isCaptureRun()) {
    mountRoute();
    return;
  }

  if (pendingTransition !== null) window.clearTimeout(pendingTransition);
  app.classList.add('route-leaving');
  pendingTransition = window.setTimeout(() => {
    pendingTransition = null;
    mountRoute();
    /**
     * Cleared in the SAME task as the mount, with no `route-entering` step in between.
     *
     * The previous version parked #app at opacity 0 after mounting and removed that class two
     * rAFs later. Measured under an 8x CPU throttle, those callbacks were starved and #app stayed
     * fully transparent long past the mount — so the build loader the detail route had just raised
     * was rendered invisible, which is precisely the blank screen the loader exists to replace.
     * Removing the class here instead lets the existing opacity transition run 0 → 1 on its own,
     * which is the same fade-in without making visibility depend on a frame callback landing.
     */
    app.classList.remove('route-leaving');
  }, ROUTE_TRANSITION_MS);
}

/**
 * Before the first render, so an event fired during mount is queued on `dataLayer` rather than
 * dropped. Sends nothing on a capture run, an automated browser, a non-production host, or for a
 * visitor who has opted out — `analytics.ts` owns all four decisions.
 */
initAnalytics();

onRouteChange(render);
render();
trackPageView(routeTitle(currentRoute()));

/**
 * Page views for the hash router, and the reason they are not inside `render()`: the workbench
 * deliberately does NOT remount when it swaps exhibit or opens a drawer, so `render()` returns
 * early for most route changes on the site. Listening to the route directly is what keeps
 * `#/privacy`, `#/faq` and every `#/x/<exhibit>` in the Pages report.
 *
 * `replaceHashSilently` (the workbench's own URL writes) uses replaceState and fires no
 * `hashchange`, so an in-place exhibit swap does not double-count here — the workbench sends its
 * own `exhibit_view` for that, which is the event that actually describes what happened.
 */
onRouteChange((route) => trackPageView(routeTitle(route)));
