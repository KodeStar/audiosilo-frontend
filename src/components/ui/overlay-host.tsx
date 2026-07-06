import { type ReactNode, useEffect } from 'react';
import { BackHandler } from 'react-native';

/**
 * A dismissable host for an overlay (a Sheet, a dialog card).
 *
 * THE JOURNEY (why this renders IN PLACE and is neither an RN Modal, a portal, nor
 * a cross-tree outlet):
 * - react-native-web's `Modal` renders NOTHING in this app's web build - with
 *   `visible` true no node is appended to the document and the children never mount,
 *   so every dialog/sheet routed through it was silently broken on web.
 * - Every attempt to render the overlay OUTSIDE its mount subtree failed in the live
 *   web build and none was root-caused in this React 19 / RN-web 0.21 / reanimated 4 /
 *   NativeWind stack: a react-dom `createPortal` COMMITS its content and is then torn
 *   down within the same instant; a context "outlet" (registering the node with a
 *   provider high in the shell) never presented.
 * - The ONLY overlay mechanism proven to work here is a plain absolute-positioned View
 *   rendered IN PLACE, in the ordinary tree (the player's inline sheets prove it).
 *
 * So this host simply renders its children in place when visible. That is the CONSUMER
 * CONTRACT: an OverlayHost (and anything built on it - Sheet, ModalCard) MUST be mounted
 * at SCREEN level - never inside a card, a Pressable, or a clipped/transformed container -
 * or the overlay will be clipped to that ancestor instead of covering the screen.
 *
 * Dismissal is owned here: Android hardware-back and web Escape both call
 * `onRequestClose`, registered only while visible.
 */
export function OverlayHost({
  visible,
  onRequestClose,
  children,
}: {
  visible: boolean;
  onRequestClose: () => void;
  children: ReactNode;
}) {
  // Android hardware-back closes (registered only while visible so it doesn't shadow
  // other handlers when closed).
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onRequestClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onRequestClose]);

  // Web Escape closes, matching the old Modal's onRequestClose. SSR-guarded (routes
  // are rendered in Node during the static export, where there is no `document`).
  useEffect(() => {
    if (!visible || typeof document === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onRequestClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [visible, onRequestClose]);

  if (!visible) return null;
  return <>{children}</>;
}
