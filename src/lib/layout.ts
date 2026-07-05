/**
 * The single phone -> desktop layout switch. Below this width the app renders its
 * phone layout (bottom nav, single column, full-screen player modal); at or above
 * it the desktop layout (sidebar rail, multi-column grids, docked player).
 *
 * Compared against `useWindowDimensions().width`. Kept in one place so every screen
 * flips at the same threshold - do not re-declare a local `1024` constant.
 */
export const WIDE_BREAKPOINT = 1024;
