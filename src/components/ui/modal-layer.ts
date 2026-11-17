import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

/**
 * Screen-reader modality for the in-place sheets (fe#267) and the portaled overlays
 * (fe#305). A `Sheet` renders over the page as its sibling (`OverlayHost`: no portal, no
 * RN Modal); a Dialog, AlertDialog, Select or menu renders into the root `PortalHost`. In
 * both cases the page behind stays in the accessibility tree unless it is told otherwise:
 * - iOS: the sheet's layer is `accessibilityViewIsModal`, which hides its SIBLINGS from
 *   VoiceOver; the page roots also hide themselves (a sheet's layer is not always a
 *   direct sibling of everything behind it).
 * - Android has no modal flag: TalkBack reads every node on screen. The pages behind hide
 *   their subtree (`no-hide-descendants`) while any sheet is open.
 * - The web: the layer is a named `role="dialog"` with `aria-modal`, which screen readers
 *   take as "nothing else is reachable", so the page needs nothing more.
 *
 * Open sheets register here (`useModalLayer`), and so do the portaled overlays while open
 * (their overlay part calls it, or renders `ModalLayerMark` inside the portal, which
 * mounts only while open on native). The page roots read `useBehindModalProps`: the
 * shell's frame (native), the full player's page and the reader's. The web needs no count
 * for the overlays either: Radix hides everything outside an open one (`aria-hidden`).
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

/** Counts a modal layer as open while `active` (a mounted, visible sheet). */
export function useModalLayer(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    change(1);
    return () => change(-1);
  }, [active]);
}

/** `useModalLayer(true)` as a component, for a portal's children: a portal mounts them only
 * while its overlay is open, so the layer counts exactly as long as the overlay shows. */
export function ModalLayerMark(): null {
  useModalLayer(true);
  return null;
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

// The web's props never change (`behindModalProps`), so its page roots never re-render for
// a sheet opening or closing.
const hidesBehind = () => Platform.OS !== 'web' && open > 0;

/** Spread on a page root that sits behind the sheets (see the module doc). */
export function useBehindModalProps(): BehindModalProps {
  return behindModalProps(useSyncExternalStore(subscribe, hidesBehind, () => false));
}
