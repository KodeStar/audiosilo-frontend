import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { SafeAreaView } from '@/components/ui/safe-area-view';
import { SpikeDialog, SpikeSelect, SpikeTrigger } from '@/components/spike-ui/spike-overlays';
import { Text } from '@/components/spike-ui/text';

/**
 * SPIKE (player redesign Phase 0a): presented as a native `fullScreenModal` (registered
 * in the root Stack like the player). Proves react-native-reusables overlays opened
 * from inside a native modal render ABOVE it (iOS: FullWindowOverlay).
 */
export default function SpikeModalScreen() {
  const { open } = useLocalSearchParams<{ open?: 'dialog' | 'select' }>();
  const [selected, setSelected] = useState('none');
  return (
    <SafeAreaView className="flex-1 bg-card" testID="spike-modal-root">
      <View className="flex-1 gap-6 p-4">
        <Text variant="h3">Spike native modal</Text>
        <Pressable
          className="self-start rounded-md border border-border bg-background px-4 py-2"
          accessibilityRole="button"
          accessibilityLabel="Close spike modal"
          testID="spike-modal-close"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/spike'))}
        >
          <SpikeTrigger label="Close modal" />
        </Pressable>
        <View className="flex-row flex-wrap items-center gap-3">
          <SpikeDialog autoOpen={open === 'dialog'} suffix="-modal" />
          <SpikeSelect autoOpen={open === 'select'} suffix="-modal" onValue={setSelected} />
        </View>
        <Text variant="muted" testID="spike-modal-selected">
          Selected: {selected}
        </Text>
      </View>
    </SafeAreaView>
  );
}
