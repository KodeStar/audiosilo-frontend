import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '@/api/provider';
import { engine } from '@/downloads/engine';
import { useDownloads } from '@/downloads/store';
import '@/i18n';
import { LanguageProvider } from '@/i18n/language-provider';
import { useAppResume } from '@/lib/app-resume';
import '@/lib/register-sw';
// Web: render `role="button"` as `<div role="button">` instead of a real `<button>`
// (which nests illegally and hits an older-Safari flex bug). All top-level imports
// evaluate before the first render, so this patches RNW in time. No-op on native.
import '@/lib/rnw-button-fix';
import { resetStaleStorage, useSession } from '@/stores/session';
import { useSettings } from '@/stores/settings';
import { ThemeProvider, useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

export const unstable_settings = {
  anchor: '(app)',
};

/**
 * The navigator, themed. Lives below ThemeProvider so it can paint each native
 * screen's container with the resolved background - otherwise stack and modal
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
    void (async () => {
      // Clear any state left incompatible by a storage-version bump BEFORE the stores
      // read it, so none loads records keyed on now-invalid connection ids. A no-op
      // after the first post-upgrade launch. Guarded so a keychain/storage hiccup can
      // never skip hydration below - that would strand the app on 'loading' forever
      // (and defeat hydrate()'s own fail-safe).
      let didReset = false;
      try {
        didReset = await resetStaleStorage();
      } catch (e) {
        console.warn('[storage] stale-state reset failed', e);
      }
      // On the id-scheme bump the pre-scoping downloaded files are orphaned on disk
      // (their old paths lack the connectionId segment removeBook now needs), so wipe
      // the whole downloads root once - otherwise they leak, uncounted-for, forever.
      if (didReset && engine.clearAll) {
        try {
          await engine.clearAll();
        } catch {
          // best-effort; orphaned files are non-fatal
        }
      }
      void hydrate();
      void hydrateSettings();
      void hydrateDownloads();
    })();
  }, [hydrate, hydrateSettings, hydrateDownloads]);

  // On returning to the foreground: refresh data, and (Android) reset to Home if the
  // app was swiped away from recents. See @/lib/app-resume.
  useAppResume();

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
