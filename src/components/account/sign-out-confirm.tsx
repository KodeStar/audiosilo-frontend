import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { ModalCard } from '@/components/ui/modal-card';
import { Text } from '@/components/ui/text';

/**
 * Confirmation shown before signing out a user who has no durable way back in (no
 * password and no recovery code). It offers to set a recovery credential instead
 * of stranding them. Presentational only — the caller decides what each action
 * does (both the Settings screen and the sidebar mint and reveal a recovery code).
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
    <ModalCard visible={visible} onRequestClose={onCancel}>
      <Text variant="title">Sign out?</Text>
      <Text variant="muted">
        You don’t have a password or recovery code set. Without one you’ll need a new invite from
        your admin to sign back in on this server.
      </Text>
      <View className="gap-2">
        <Button title="Set a recovery code" icon="qrcode" onPress={onSetRecovery} />
        <Button title="Sign out anyway" variant="secondary" icon="logout" onPress={onSignOut} />
        <Button title="Cancel" variant="ghost" onPress={onCancel} />
      </View>
    </ModalCard>
  );
}
