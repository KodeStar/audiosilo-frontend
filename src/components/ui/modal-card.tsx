import type { ReactNode } from 'react';
import { Pressable } from 'react-native';

import { OverlayHost } from './overlay-host';

/**
 * A centered dialog card over a dimmed backdrop. Tapping the backdrop (or the
 * Android hardware back button) dismisses it; taps inside the card are caught by
 * the inner Pressable so they don't fall through to the backdrop. Extracted so the
 * account dialogs (sign-out warning, API-key secret, confirmations) share one
 * implementation instead of each re-rolling the backdrop scaffold.
 *
 * Hosted in an `OverlayHost`, which renders in place (react-native-web's `Modal`
 * renders nothing in this stack, and cross-tree transports failed un-root-caused), so
 * a `ModalCard` MUST be mounted at screen level - never inside a card/Pressable, and
 * never inside a scroll container.
 *
 * The backdrop is `absolute inset-0` (not `flex-1`): OverlayHost renders it inline in
 * the ordinary tree, so a `flex-1` backdrop would only take its flex share of the
 * parent column (splitting the screen with a sibling `flex-1` ScrollView) instead of
 * covering it. Absolute fill covers the whole mounting container regardless of siblings.
 */
export function ModalCard({
  visible,
  onRequestClose,
  children,
}: {
  visible: boolean;
  onRequestClose: () => void;
  children: ReactNode;
}) {
  return (
    <OverlayHost visible={visible} onRequestClose={onRequestClose}>
      <Pressable
        className="absolute inset-0 justify-center bg-black/40 p-6"
        onPress={onRequestClose}
      >
        <Pressable
          className="gap-4 self-center rounded-2xl bg-gray-100 p-5 dark:bg-gray-840"
          style={{ maxWidth: 420, width: '100%' }}
          onPress={() => {}}
        >
          {children}
        </Pressable>
      </Pressable>
    </OverlayHost>
  );
}
