import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '@/api/provider';
import { useDownloads } from '@/downloads/store';
import { useSession } from '@/stores/session';
import { useSettings } from '@/stores/settings';
import { ThemeProvider } from '@/theme/theme-provider';

export const unstable_settings = {
  anchor: '(app)',
};

export default function RootLayout() {
  const hydrate = useSession((s) => s.hydrate);
  const hydrateSettings = useSettings((s) => s.hydrate);
  const hydrateDownloads = useDownloads((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
    void hydrateSettings();
    void hydrateDownloads();
  }, [hydrate, hydrateSettings, hydrateDownloads]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <ApiProvider>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(app)" />
              <Stack.Screen name="player" options={{ presentation: 'fullScreenModal' }} />
            </Stack>
            <StatusBar style="auto" />
          </ApiProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
