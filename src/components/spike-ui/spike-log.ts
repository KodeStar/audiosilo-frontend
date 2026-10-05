import { useCallback, useRef } from 'react';
import type { LayoutChangeEvent, View } from 'react-native';

/**
 * SPIKE (Phase 0a) instrumentation: logs an opened overlay's box in WINDOW coordinates
 * as `[spike] <name> layout x y w h`, so screenshot automation (Playwright, Maestro,
 * Metro logs) can assert where it landed. `onLayout` alone is parent-relative, so this
 * re-measures with `measureInWindow`.
 */
export function useSpikeLayoutLog(name: string) {
  const ref = useRef<View>(null);
  const onLayout = useCallback(
    (_e: LayoutChangeEvent) => {
      // Defer a frame: on native the portaled content is positioned after its first
      // layout pass (rn-primitives measures the trigger, then lays the content out).
      requestAnimationFrame(() => {
        ref.current?.measureInWindow((x, y, w, h) => {
          console.log(
            `[spike] ${name} layout ${Math.round(x)} ${Math.round(y)} ${Math.round(w)} ${Math.round(h)}`,
          );
        });
      });
    },
    [name],
  );
  return { ref, onLayout };
}
