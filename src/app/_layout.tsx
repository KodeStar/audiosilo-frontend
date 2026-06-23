import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '@/api/provider';
import { useDownloads } from '@/downloads/store';
import '@/i18n';
import { LanguageProvider } from '@/i18n/language-provider';
import '@/lib/register-sw';
import { useSession } from '@/stores/session';
import { useSettings } from '@/stores/settings';
import { ThemeProvider, useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

export const unstable_settings = {
  anchor: '(app)',
};

/**
 * The navigator, themed. Lives below ThemeProvider so it can paint each native
 * screen's container with the resolved background — otherwise stack and modal
 * transitions (and the swipe-back gesture) flash the default white card.
 */
function RootNavigator() {
  const { scheme } = useTheme();
  const background = scheme === 'dark' ? colors.dark.bg : colors.light.bg;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: background } }}>
      <Stack.Screen name="(app)" />
      <Stack.Screen name="player" options={{ presentation: 'fullScreenModal' }} />
    </Stack>
  );
}

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
        <LanguageProvider>
          <ThemeProvider>
            <ApiProvider>
              <RootNavigator />
              <StatusBar style="auto" />
            </ApiProvider>
          </ThemeProvider>
        </LanguageProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
