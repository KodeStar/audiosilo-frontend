/** The theme preference: an explicit scheme, or follow the OS. */
export type SchemePref = 'light' | 'dark' | 'system';

const SCHEME_PREFS: readonly SchemePref[] = ['light', 'dark', 'system'];

/** Only a pref this build knows may reach `Uniwind.setTheme`, which throws on any other
 * name - a corrupt or foreign stored value must not keep the app on the splash screen. */
export const isSchemePref = (value: unknown): value is SchemePref =>
  SCHEME_PREFS.includes(value as SchemePref);

/**
 * The theme to apply at launch, from the stored preference (`saved`, whatever storage
 * held) and whether this install has been used before. Owner decision 2026-10-05,
 * "System, new installs only":
 * - a stored pick is kept as is;
 * - nothing stored on an install that was already in use (it predates this rule, when
 *   the app was dark-first): `dark`, written back once so nobody's app turns light
 *   after the update;
 * - nothing stored on a NEW install: `system`, also written back, so the install does
 *   not count as "existing" (and turn dark) on its next launch once it has a server;
 * - an unknown stored value: `dark`, not written (as before; the user's next pick
 *   overwrites it).
 */
export function initialSchemePref(
  saved: unknown,
  existingInstall: boolean,
): { pref: SchemePref; persist: boolean } {
  if (isSchemePref(saved)) return { pref: saved, persist: false };
  if (saved != null) return { pref: 'dark', persist: false };
  return { pref: existingInstall ? 'dark' : 'system', persist: true };
}
