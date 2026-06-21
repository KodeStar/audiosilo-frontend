import { Modal, Pressable, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * Confirmation shown before signing out a user who has no durable way back in (no
 * password and no recovery code). It offers to set a recovery credential instead
 * of stranding them. Presentational only — the caller decides what each action
 * does (the Settings screen reveals its recovery card; the sidebar routes there).
 */
export function SignOutConfirm({
  visible,
  onSetRecovery,
  onSignOut,
  onCancel,
}: {
  visible: boolean;
  onSetRecovery: () => void;
  onSignOut: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable className="flex-1 justify-center bg-black/40 p-6" onPress={onCancel}>
        <Pressable
          className="gap-4 self-center rounded-2xl bg-gray-100 p-5 dark:bg-gray-840"
          style={{ maxWidth: 420, width: '100%' }}
          onPress={() => {}}
        >
          <Text variant="title">Sign out?</Text>
          <Text variant="muted">
            You don’t have a password or recovery code set. Without one you’ll need a new invite
            from your admin to sign back in on this server.
          </Text>
          <View className="gap-2">
            <Button title="Set a recovery code" icon="qrcode" onPress={onSetRecovery} />
            <Button title="Sign out anyway" variant="secondary" icon="logout" onPress={onSignOut} />
            <Button title="Cancel" variant="ghost" onPress={onCancel} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
