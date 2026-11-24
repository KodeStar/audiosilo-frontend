import { useState } from 'react';

/**
 * The largest top inset seen for this window size, so the room above a screen holds while
 * the status bar is hidden (the reader's immersive mode, fe#246: an Android window's top
 * inset drops to nothing with it, which would lay the page out again). Each size keeps its
 * own (a rotation measures the new one afresh, and a rotation back finds the old one, even
 * with the status bar hidden by then). Pass the insets' own frame (`useSafeAreaFrame`), which
 * comes with them: the window's dimensions come apart from the insets, and a size would
 * hold the last orientation's inset.
 */
export function useHeldTopInset(top: number, window: { width: number; height: number }): number {
  const key = `${window.width}x${window.height}`;
  const [held, setHeld] = useState<Record<string, number>>(() => ({ [key]: top }));
  const seen = held[key] ?? 0;
  // Kept only when there is room to hold: a size with no inset (every size on the web) adds
  // no key and no render.
  if (top > seen) setHeld({ ...held, [key]: top });
  return Math.max(seen, top);
}
