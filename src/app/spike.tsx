import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { SafeAreaView } from '@/components/ui/safe-area-view';
import {
  SpikeDialog,
  SpikeMenu,
  type SpikeOverlay,
  SpikePopover,
  SpikeSelect,
  SpikeSheet,
  SpikeTrigger,
} from '@/components/spike-ui/spike-overlays';
import { Text } from '@/components/spike-ui/text';
import { useTheme } from '@/theme/theme-provider';

/**
 * SPIKE (player redesign Phase 0a, branch spike/player-0a-portals - never merged).
 * Public route (outside the (app) auth guard) exercising react-native-reusables
 * overlays and the @expo/ui BottomSheet. `?open=dialog|menu|popover|select|sheet`
 * auto-opens one on mount for screenshot automation.
 */
export default function SpikeScreen() {
  const { open } = useLocalSearchParams<{ open?: SpikeOverlay }>();
  const { scheme, setPref } = useTheme();
  const [lastAction, setLastAction] = useState('none');
  const [selected, setSelected] = useState('none');

  return (
    <SafeAreaView className="flex-1 bg-background" testID="spike-root">
      <ScrollView contentContainerClassName="gap-6 p-4 pb-40">
        <Text variant="h3">Overlay spike</Text>
        <View className="flex-row flex-wrap items-center gap-3">
          <Pressable
            className="rounded-md bg-primary px-4 py-2"
            accessibilityRole="button"
            accessibilityLabel="Toggle theme"
            testID="spike-theme-toggle"
            onPress={() => setPref(scheme === 'dark' ? 'light' : 'dark')}
          >
            <Text className="text-sm font-medium text-primary-foreground" testID="spike-scheme">
              Theme: {scheme}
            </Text>
          </Pressable>
          <Pressable
            className="rounded-md border border-border bg-card px-4 py-2"
            accessibilityRole="button"
            accessibilityLabel="Open spike modal"
            testID="spike-open-modal"
            onPress={() => router.push('/spike-modal')}
          >
            <SpikeTrigger label="Open native modal" />
          </Pressable>
        </View>

        <View className="gap-3">
          <Text variant="muted">Unclipped</Text>
          <View className="flex-row flex-wrap gap-3">
            <SpikeDialog autoOpen={open === 'dialog'} />
            <SpikeMenu autoOpen={open === 'menu'} onAction={setLastAction} />
            <SpikeSheet autoOpen={open === 'sheet'} />
          </View>
          <Text variant="muted" testID="spike-last-action">
            Last menu action: {lastAction}
          </Text>
        </View>

        {/* The clipped, scrolled container: overlay content must escape it. */}
        <View className="gap-3">
          <Text variant="muted">Inside a clipped, scrolled card</Text>
          <View
            className="h-36 overflow-hidden rounded-lg border border-border bg-card"
            testID="spike-clip-card"
          >
            <ScrollView contentContainerClassName="gap-3 p-3">
              <View className="flex-row flex-wrap items-center gap-3">
                <SpikePopover autoOpen={open === 'popover'} />
                <SpikeSelect autoOpen={open === 'select'} onValue={setSelected} />
              </View>
              <Text variant="muted" testID="spike-selected">
                Selected: {selected}
              </Text>
              <View className="h-40" />
            </ScrollView>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
