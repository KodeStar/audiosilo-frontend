/// <reference lib="dom" />
import { readLanguagePref, resolveLanguage } from '@/i18n/language-provider';

import { BASE_URL, IS_DEV } from './base-url';

// Registers the PWA service worker (public/sw.js) for offline app shell + offline
// media playback. Web-only; the native counterpart (register-sw.ts) is a no-op.
// Imported for its side effect by the root layout. Service workers require a
// secure context (https or localhost), so this no-ops elsewhere.
//
// In dev we still register (localhost is secure) but pass `?dev=1` so the worker
// only serves downloaded media and leaves the app shell alone - otherwise its
// asset caching would fight Metro's hot reloading.

export function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (typeof window !== 'undefined' && !window.isSecureContext) return;

  const register = async () => {
    try {
      // An installing worker cannot read localStorage. Tell it which catalog to keep
      // for an offline launch, even when this visit loaded it before a worker took control.
      const lang = IS_DEV ? 'en' : resolveLanguage(await readLanguagePref());
      const query = IS_DEV ? '?dev=1' : lang === 'en' ? '' : '?lang=' + encodeURIComponent(lang);
      await navigator.serviceWorker.register(BASE_URL + '/sw.js' + query);
    } catch (err) {
      console.warn('[sw] registration failed', err);
    }
  };
  // This module runs when the root layout is first required, which is during React's
  // first (scheduled) render: in the static export that is usually AFTER `load` has
  // fired, and a listener added then never runs, so the worker was never registered
  // (no offline shell, and downloads never became playable offline).
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

registerServiceWorker();
