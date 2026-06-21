import type { ReactNode } from 'react';
import { Modal, Pressable } from 'react-native';

/**
 * A centered dialog card over a dimmed backdrop. Tapping the backdrop (or the
 * Android hardware back button) dismisses it; taps inside the card are caught by
 * the inner Pressable so they don't fall through to the backdrop. Extracted so the
 * account dialogs (sign-out warning, recovery code, confirmations) share one
 * implementation instead of each re-rolling the Modal + backdrop scaffold.
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
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onRequestClose}>
      <Pressable className="flex-1 justify-center bg-black/40 p-6" onPress={onRequestClose}>
        <Pressable
          className="gap-4 self-center rounded-2xl bg-gray-100 p-5 dark:bg-gray-840"
          style={{ maxWidth: 420, width: '100%' }}
          onPress={() => {}}
        >
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
