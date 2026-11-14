import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

/**
 * Screen-reader modality for the in-place sheets (fe#267). A `Sheet` renders over the page
 * as its sibling (`OverlayHost`: no portal, no RN Modal), so the page behind it stays in
 * the accessibility tree unless it is told otherwise:
 * - iOS: the sheet's layer is `accessibilityViewIsModal`, which hides its SIBLINGS from
 *   VoiceOver; the page roots also hide themselves (a sheet's layer is not always a
 *   direct sibling of everything behind it).
 * - Android has no modal flag: TalkBack reads every node on screen. The pages behind hide
 *   their subtree (`no-hide-descendants`) while any sheet is open.
 * - The web: the layer is a named `role="dialog"` with `aria-modal`, which screen readers
 *   take as "nothing else is reachable", so the page needs nothing more.
 *
 * Open sheets register here (`useModalLayer`); the page roots read `useBehindModalProps`:
 * the shell's frame (native), the full player's page and the reader's.
 */

let open = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function change(by: 1 | -1): void {
  open = Math.max(0, open + by);
  for (const l of listeners) l();
}

const anyOpen = () => open > 0;

/** Counts a modal layer as open while `active` (a mounted, visible sheet). */
export function useModalLayer(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    change(1);
    return () => change(-1);
  }, [active]);
}

/** Whether a modal layer is open. */
export function useModalLayerOpen(): boolean {
  return useSyncExternalStore(subscribe, anyOpen, () => false);
}

/** The accessibility props for a page root BEHIND the modal layers: hidden from VoiceOver
 * and TalkBack while one is open. Nothing on the web (`aria-modal` does it there). */
export type BehindModalProps = {
  importantForAccessibility?: 'auto' | 'no-hide-descendants';
  accessibilityElementsHidden?: boolean;
};

/** `BehindModalProps` for `hidden` (pure, for a test and for `useBehindModalProps`). */
export function behindModalProps(hidden: boolean): BehindModalProps {
  if (Platform.OS === 'web') return {};
  return {
    importantForAccessibility: hidden ? 'no-hide-descendants' : 'auto',
    accessibilityElementsHidden: hidden,
  };
}

/** Spread on a page root that sits behind the sheets (see the module doc). */
export function useBehindModalProps(): BehindModalProps {
  return behindModalProps(useModalLayerOpen());
}
