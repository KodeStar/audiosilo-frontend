/**
 * The web's stand-in for the native shell (`native-shell.tsx`): `src/app/(app)/_layout.tsx`
 * re-exports the shell, and Expo Router loads that file on the web too (it reads every
 * layout file of a group, then renders the most specific one, `_layout.web.tsx`). This
 * keeps the native shell's import graph (NativeTabs, the accessory player, the player's
 * sheets) out of the web's start.
 */
export function NativeAppShell() {
  return null;
}
