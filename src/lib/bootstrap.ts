import { engine } from '@/downloads/engine';
import { useDownloads } from '@/downloads/store';
import { migrateStorage } from '@/lib/storage-migration';
import { useLibrarySelection } from '@/stores/library-selection';
import { useSeriesOrderings } from '@/stores/series-orderings';
import { useSession } from '@/stores/session';
import { useSettings } from '@/stores/settings';

let pending: Promise<void> | null = null;

/**
 * The launch steps the stores need before anything reads them, as ONE memoised run: the
 * root layout calls it before any screen, and the car's headless task (`AudiosiloCar`,
 * Android: the playback service booted JS with no activity) calls it too. A later activity
 * on the same JS runtime then finds the run done and doesn't repeat it. In order:
 *
 * 1. `migrateStorage()` (itself memoised; ThemeProvider awaits the same run): reconcile
 *    storage left incompatible by a version bump BEFORE any store reads it, so none loads
 *    records keyed on now-invalid connection ids. Two independent axes: `authReset` (the
 *    connection identity scheme changed, everyone re-pairs) and `cacheReset` (the
 *    disposable download/progress cache schema changed, logins intact). Guarded: a
 *    keychain or storage hiccup must never skip the hydration below, which would strand
 *    the app on 'loading' forever.
 * 2. When either axis reset, the downloaded files no longer match the registry (an auth
 *    wipe orphans them; a cache-schema bump invalidates them): wipe the whole downloads
 *    root once, or they leak, uncounted, forever.
 * 3. Hydrate the session, settings, downloads, series orderings and library selection, all
 *    started together in that order. Resolves once each has settled (a store's own hydrate
 *    has its fail-safe; a rejection is logged, never thrown).
 */
export function bootstrapPlayback(): Promise<void> {
  pending ??= run();
  return pending;
}

async function run(): Promise<void> {
  let didReset = false;
  try {
    const { authReset, cacheReset } = await migrateStorage();
    didReset = authReset || cacheReset;
  } catch (e) {
    console.warn('[storage] stale-state reset failed', e);
  }
  if (didReset && engine.clearAll) {
    try {
      await engine.clearAll();
    } catch {
      // best-effort; orphaned files are non-fatal
    }
  }
  const results = await Promise.allSettled([
    useSession.getState().hydrate(),
    useSettings.getState().hydrate(),
    useDownloads.getState().hydrate(),
    useSeriesOrderings.getState().hydrate(),
    useLibrarySelection.getState().hydrate(),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') console.warn('[bootstrap] a store failed to hydrate', r.reason);
  }
}

/** Tests only: forget the memoised run, so the next `bootstrapPlayback` runs again. */
export function forgetBootstrap() {
  pending = null;
}
