import { useFonts } from 'expo-font';

import { FONTS } from './theme-provider';

/**
 * Web: names the Stacks fonts that gate first paint (`FONTS`) where the static export's
 * render reaches them, so each page's HTML carries their `@font-face` rules and preload
 * links (expo-font's static extraction). The browser then fetches them while the app's
 * script loads, and `ThemeProvider`'s `useFonts` finds them registered at its first render
 * instead of adding them then and waiting. Rendered at the root, above the providers that
 * draw nothing until they hydrate (the static render never gets past those). In the
 * browser it registers the same fonts (a no-op once the HTML has).
 */
export function StaticFonts() {
  useFonts(FONTS);
  return null;
}
