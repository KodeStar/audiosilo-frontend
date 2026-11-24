import { getLocales } from 'expo-localization';
import i18next from 'i18next';
import { AppState } from 'react-native';
import { useSyncExternalStore } from 'react';

/**
 * Active BCP-47 locale for `Intl.*` formatting: the UI language from the i18next singleton,
 * with the device's region when the device names one for that language ("en-GB" for
 * English on a British phone), so dates and numbers read the listener's way ("12 Nov 2026",
 * not "Nov 12, 2026"; fe#204). Lives apart from `./index` (which binds react-i18next) so
 * locale-only consumers like `src/lib/format.ts` don't pull React into their dependency
 * graph.
 */
export function getLocale(): string {
  const language = i18next.language || 'en';
  if (regional?.language !== language) {
    regional = { language, tag: regionalLocale(language, deviceLocales()) };
  }
  return regional.tag;
}

/** The last language's answer: the device's locales are read once per UI language, and again
 * once the app is back in front (the region can change in the device's settings meanwhile). */
let regional: { language: string; tag: string } | null = null;
AppState.addEventListener('change', (state) => {
  if (state === 'active') regional = null;
});

/** Renders `onChange`'s reader again when the UI language changes or the app comes back in
 * front (the device's region may have changed). */
function subscribeLocale(onChange: () => void): () => void {
  i18next.on('languageChanged', onChange);
  const app = AppState.addEventListener('change', (state) => {
    if (state !== 'active') return;
    regional = null;
    onChange();
  });
  return () => {
    i18next.off('languageChanged', onChange);
    app.remove();
  };
}

/** `getLocale()` for a render: a memoized caller's words follow a language switch, and a
 * region changed in the device's settings while the app was away (fe#358). */
export function useLocale(): string {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

function deviceLocales(): { languageTag: string; languageCode: string | null }[] {
  try {
    return getLocales();
  } catch {
    return [];
  }
}

/**
 * The first of the device's locales that is in `language` and names a region, as `Intl`
 * accepts it, else `language` itself: a UI language that is not the device's keeps its own
 * conventions (German chosen on an English phone reads German dates).
 */
export function regionalLocale(
  language: string,
  device: readonly { languageTag: string; languageCode: string | null }[],
): string {
  if (language.includes('-')) return language;
  const mine = device.find((d) => d.languageCode === language && d.languageTag.includes('-'));
  if (!mine) return language;
  try {
    return Intl.DateTimeFormat.supportedLocalesOf(mine.languageTag)[0] ?? language;
  } catch {
    // No usable Intl here: the bare language, as before.
    return language;
  }
}
