import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { ModalCard } from '@/components/ui/modal-card';
import { Text } from '@/components/ui/text';
import { shareText } from '@/lib/share';

/**
 * Shows a freshly minted recovery code in an always-on-top dialog so the one-time
 * secret can't scroll off-screen or be missed below the fold. The server never
 * returns it again, so dismissing the dialog is the only way to clear it — by
 * which point the user has had the chance to copy or share it.
 */
export function RecoveryCodeModal({ code, onClose }: { code: string | null; onClose: () => void }) {
  return (
    <ModalCard visible={code !== null} onRequestClose={onClose}>
      <Text variant="title">Recovery code</Text>
      <Text variant="muted" className="text-xs">
        Save this somewhere safe. Enter it on the connect screen to sign back in on any device. It
        won’t be shown again.
      </Text>
      <Text selectable className="text-center font-roboto-semibold text-lg tracking-wider">
        {code}
      </Text>
      <View className="flex-row gap-2">
        <Button
          title="Share"
          variant="secondary"
          icon="qrcode"
          className="flex-1"
          onPress={() => {
            if (code) void shareText(code);
          }}
        />
        <Button title="Done" variant="ghost" className="flex-1" onPress={onClose} />
      </View>
    </ModalCard>
  );
}
