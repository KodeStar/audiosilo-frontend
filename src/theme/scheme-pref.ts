/** The theme preference: an explicit scheme, or follow the OS. */
export type SchemePref = 'light' | 'dark' | 'system';

/** Where the preference is stored (AsyncStorage). */
export const THEME_STORAGE_KEY = 'audiosilo.theme';

const SCHEME_PREFS: readonly SchemePref[] = ['light', 'dark', 'system'];

/** Only a pref this build knows may reach `Uniwind.setTheme`, which throws on any other
 * name - a corrupt or foreign stored value must not keep the app on the splash screen. */
export const isSchemePref = (value: unknown): value is SchemePref =>
  SCHEME_PREFS.includes(value as SchemePref);

/**
 * The preference the launch-time storage migration writes when NOTHING is stored (owner
 * decision 2026-10-05, "System, new installs only"):
 * - an install that was already in use (it predates this rule, when the app was
 *   dark-first): `dark`, so nobody's app turns light after the update;
 * - a NEW install: `system`, also written, so the install does not count as "existing"
 *   (and turn dark) on its next launch once it has a server.
 */
export function defaultSchemePref(existingInstall: boolean): SchemePref {
  return existingInstall ? 'dark' : 'system';
}

/**
 * The theme to apply from what storage holds: a stored pick as is; anything else (an
 * unknown value) `dark`, not written back - the user's next pick overwrites it.
 */
export function restoredSchemePref(saved: unknown): SchemePref {
  return isSchemePref(saved) ? saved : 'dark';
}
