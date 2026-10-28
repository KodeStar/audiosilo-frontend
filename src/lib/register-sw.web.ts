/// <reference lib="dom" />
import { BASE_URL, IS_DEV } from './base-url';

// Registers the PWA service worker (public/sw.js) for offline app shell + offline
// media playback. Web-only; the native counterpart (register-sw.ts) is a no-op.
// Imported for its side effect by the root layout. Service workers require a
// secure context (https or localhost), so this no-ops elsewhere.
//
// In dev we still register (localhost is secure) but pass `?dev=1` so the worker
// only serves downloaded media and leaves the app shell alone - otherwise its
// asset caching would fight Metro's hot reloading.

/** How long after the page has loaded the worker is asked to precache the build. */
export const PRECACHE_DELAY_MS = 5000;

/**
 * The build this page runs, for the worker's address (`?build=`): the names of the page's
 * last bundle script, the entry (it names the route chunks, so its hash changes with
 * them), and of the shared chunk (`__common-<hash>`, most of the app's code, which the
 * entry does not name: a fix there leaves the entry as it was). Both are on every page,
 * so every page of a build names the same worker. In a build whose start scripts are cut
 * into parts (`scripts/web-start-chunks.cjs`) these are the entry's last part and the shared
 * chunk's first (`<name>-<hash>-<n>-<part hash>`). `undefined` without one (dev, a test
 * page).
 */
export function buildId(): string | undefined {
  const names = Array.from(
    document.querySelectorAll<HTMLScriptElement>('script[src*="/_expo/static/js/"]'),
    (script) => script.src.split('/').pop()?.replace(/\.js$/, '') ?? '',
  ).filter(Boolean);
  const entry = names[names.length - 1];
  if (!entry) return undefined;
  const common = names.find((name) => name.startsWith('__common-'));
  return common && common !== entry ? `${entry}.${common}` : entry;
}

/**
 * The worker's address. A production build names itself (`buildId`), so a new deploy is a
 * new address and so a new worker, whose install precaches the new build's chunks: Chrome
 * keeps compiled code for scripts a worker caches while installing, which is what makes a
 * warm start fast (the worker's bytes are the same in every build, so without this it
 * would never install again).
 */
export function workerUrl(): string {
  if (IS_DEV) return `${BASE_URL}/sw.js?dev=1`;
  const build = buildId();
  return `${BASE_URL}/sw.js${build ? `?build=${encodeURIComponent(build)}` : ''}`;
}

/**
 * Asks the active worker to precache this build's chunks (sw.js `precacheBuild`), in case
 * its install could not (offline then): the web build is split by route, and a page whose
 * chunk was never fetched would not boot offline. A while after the start, so its fetches
 * never compete with the first screen's; nothing to do when the build is in already.
 */
export function askPrecache() {
  void navigator.serviceWorker.ready.then(
    (registration) => registration.active?.postMessage({ type: 'precache' }),
    () => undefined,
  );
}

export function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (typeof window !== 'undefined' && !window.isSecureContext) return;

  const register = () => {
    navigator.serviceWorker.register(workerUrl()).catch((err) => {
      console.warn('[sw] registration failed', err);
    });
    if (!IS_DEV) setTimeout(askPrecache, PRECACHE_DELAY_MS);
  };
  // This module runs when the root layout is first required, which is during React's
  // first (scheduled) render: in the static export that is usually AFTER `load` has
  // fired, and a listener added then never runs, so the worker was never registered
  // (no offline shell, and downloads never became playable offline).
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

registerServiceWorker();
