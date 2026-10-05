import { type ReactNode, useEffect } from 'react';
import { BackHandler } from 'react-native';

/**
 * A dismissable host for an overlay (a Sheet, a dialog card).
 *
 * THE JOURNEY (why this renders IN PLACE rather than through an RN Modal or a portal):
 * - react-native-web's `Modal` renders NOTHING in this app's web build - with
 *   `visible` true no node is appended to the document and the children never mount,
 *   so every dialog/sheet routed through it was silently broken on web.
 * - Portals DO work in this stack (React 19 / RN-web 0.21 / reanimated 4 / Uniwind).
 *   An earlier attempt saw a react-dom `createPortal` commit its content and tear it
 *   down within the same instant, and a context "outlet" never present. That was not
 *   the portal: React 19's concurrent replays discarded a render-phase setState in our
 *   own `Sheet` (root-caused in e049175), which made every mechanism look broken. The
 *   player redesign's Phase 0a spike (branch spike/player-0a-portals) then proved
 *   react-native-reusables overlays (Radix portals into `document.body` on web, a
 *   `PortalHost` outlet on native) stay mounted, under the real server CSP too.
 *
 * This host still renders its children in place when visible, because today's Sheet and
 * ModalCard are built on it. That is the CONSUMER CONTRACT: an OverlayHost (and anything
 * built on it) MUST be mounted at SCREEN level - never inside a card, a Pressable, or a
 * clipped/transformed container - or the overlay will be clipped to that ancestor
 * instead of covering the screen. A new overlay that must escape a clipped container
 * should use the portal-based primitives (Phase 0b) rather than extend this host.
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
