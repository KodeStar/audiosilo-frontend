import { Uniwind } from 'uniwind';

import { colors, type ThemeColors } from '@/theme/tokens';

/** Where the Settings > Appearance "High contrast" switch is stored (AsyncStorage). */
export const HIGH_CONTRAST_STORAGE_KEY = 'audiosilo.highContrast';

/** The stored switch: only a stored `true` turns it on; anything else (nothing stored, a
 * corrupt value) is off, which follows the OS. */
export const restoredHighContrast = (saved: unknown): boolean => saved === true;

/**
 * Whether the high-contrast colours are in effect: when the OS asks for more contrast
 * (iOS Increase Contrast, Android high contrast text, web `prefers-contrast: more`) OR
 * the app's switch is on. The switch only adds: off follows the OS, so it never turns
 * off what the device asks for.
 */
export const highContrastActive = (osAsks: boolean, switchOn: boolean): boolean =>
  osAsks || switchOn;

/** A scheme's semantic colours, normal or high contrast (the generated token objects, so
 * the result is stable for a given pair). */
export const themeColors = (scheme: 'light' | 'dark', highContrast: boolean): ThemeColors =>
  highContrast ? colors.highContrast[scheme] : colors[scheme];

/** `brandInk` -> `--color-brand-ink`, `chart1` -> `--color-chart-1`: the Uniwind theme
 * variable a generated token backs (scripts/gen-tokens.mjs `camelName`, reversed). */
export const cssVariableName = (camel: string): string =>
  `--color-${camel.replace(/[A-Z0-9]/g, (c) => `-${c.toLowerCase()}`)}`;

/** The theme variables one scheme's high-contrast set changes (the rest never move), at
 * their normal or high-contrast values, as Uniwind's `updateCSSVariables` takes them. */
export function contrastVariables(
  scheme: 'light' | 'dark',
  highContrast: boolean,
): Record<string, string> {
  const normal = colors[scheme];
  const high = colors.highContrast[scheme];
  const values = highContrast ? high : normal;
  return Object.fromEntries(
    (Object.keys(normal) as (keyof ThemeColors)[])
      .filter((k) => normal[k] !== high[k])
      .map((k) => [cssVariableName(k), values[k]]),
  );
}

// What the theme variables hold now: the CSS starts with the normal colours.
let applied = false;

/**
 * Puts the light and dark theme variables to their normal or high-contrast values, so
 * every themed class (`text-muted-foreground`, `border-input`, a scoped theme's too)
 * follows. Both schemes at once, so a later Light/Dark/System change keeps the contrast.
 * Turning it off writes the normal values back (Uniwind has no "reset"). Writes nothing
 * when the variables already hold what is asked, so a launch without high contrast leaves
 * them alone. Web: rules in Uniwind's own `<style>` (`.light{}` / `.dark{}`), which
 * outrank the layered theme CSS; native: Uniwind's per-theme variable store.
 */
export function applyHighContrast(highContrast: boolean): void {
  if (highContrast === applied) return;
  for (const scheme of ['light', 'dark'] as const) {
    Uniwind.updateCSSVariables(scheme, contrastVariables(scheme, highContrast));
  }
  applied = highContrast;
}
