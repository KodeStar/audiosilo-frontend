import { type RefObject, useEffect, useRef } from 'react';
import type { View } from 'react-native';

/**
 * A right-click, the Menu key or Shift+F10 on the view behind `ref` (a cover tile)
 * calls `onRequest` instead of the browser's own menu: the keyboard and mouse way to a
 * tile's actions, beside the long-press. Nothing is attached while `onRequest` is
 * undefined.
 */
export function useContextMenuRequest(
  ref: RefObject<View | null>,
  onRequest: (() => void) | undefined,
): void {
  const latest = useRef(onRequest);
  useEffect(() => {
    latest.current = onRequest;
  });
  const enabled = !!onRequest;
  useEffect(() => {
    const node = ref.current as unknown as HTMLElement | null;
    if (!enabled || !node || typeof node.addEventListener !== 'function') return;
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      // macOS and Linux fire contextmenu on the button's way DOWN: a menu opened now
      // would take the release as a press on whichever item lands under the pointer.
      // Open it once the button is up (Windows fires on the release: open at once).
      if (e.buttons & 2) {
        window.addEventListener('mouseup', () => latest.current?.(), { once: true });
      } else {
        latest.current?.();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        latest.current?.();
      }
    };
    node.addEventListener('contextmenu', onContextMenu);
    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('contextmenu', onContextMenu);
      node.removeEventListener('keydown', onKeyDown);
    };
  }, [ref, enabled]);
}
