import { useState } from 'react';

/**
 * The largest top inset seen for this window size, so the room above a screen holds while
 * the status bar is hidden (the reader's immersive mode, fe#246: an Android window's top
 * inset drops to nothing with it, which would lay the page out again). A new window size
 * (a rotation) measures it afresh.
 */
export function useHeldTopInset(top: number, window: { width: number; height: number }): number {
  const { width, height } = window;
  const [held, setHeld] = useState({ width, height, top });
  const sameWindow = held.width === width && held.height === height;
  if (!sameWindow || top > held.top) setHeld({ width, height, top });
  return sameWindow ? Math.max(held.top, top) : top;
}
