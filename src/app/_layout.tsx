import { PortalHost } from '@rn-primitives/portal';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '@/api/provider';
import { BookEndedListener } from '@/components/player/book-ended-listener';
import { ShakeToExtendListener } from '@/components/player/shake-to-extend-listener';
import { ShellToastHost } from '@/components/shell/shell-toast-host';
import { RootInsetsProvider } from '@/components/ui/overlay';
import { engine } from '@/downloads/engine';
import { startKeepAhead } from '@/downloads/keep-ahead-controller';
import { useDownloads } from '@/downloads/store';
import '@/i18n';
import { LanguageProvider } from '@/i18n/language-provider';
import { useAppResume } from '@/lib/app-resume';
import { migrateStorage } from '@/lib/storage-migration';
import { startAutoSleep } from '@/playback/auto-sleep-controller';
import { startDriftWatch } from '@/playback/drift-controller';
import '@/lib/register-sw';
// Web: render `role="button"` as `<div role="button">` instead of a real `<button>`
// (which nests illegally and hits an older-Safari flex bug), and let Space activate
// role-bearing pressables (tab, radio, switch...). All top-level imports evaluate before
// the first render, so this patches RNW in time. No-op on native.
import '@/lib/rnw-button-fix';
import { useLibrarySelection } from '@/stores/library-selection';
import { useSeriesOrderings } from '@/stores/series-orderings';
import { useSession } from '@/stores/session';
import { useSettings } from '@/stores/settings';
import { ThemeProvider } from '@/theme/theme-provider';
import { useThemeColors } from '@/theme/use-theme-colors';

export const unstable_settings = {
  anchor: '(app)',
};

/**
 * The navigator, themed. Lives below ThemeProvider so it can paint each native
 * screen's container with the resolved background - otherwise stack and modal
 * transitions (and the swipe-back gesture) flash the default white card.
 */
function RootNavigator() {
  const { background } = useThemeColors();
  return (
    <>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: background } }}>
        <Stack.Screen name="(app)" />
        <Stack.Screen name="player" options={{ presentation: 'fullScreenModal' }} />
        <Stack.Screen name="finished" options={{ presentation: 'fullScreenModal' }} />
      </Stack>
      {/* Root-level so it covers every layout (phone modal + wide desktop): drives the
          end-of-book flow when a book reaches its natural end. */}
      <BookEndedListener />
      {/* A shake must keep the listener going while the phone is locked
          and no player screen is mounted. */}
      <ShakeToExtendListener />
    </>
  );
}

export default function RootLayout() {
  const hydrate = useSession((s) => s.hydrate);
  const hydrateSettings = useSettings((s) => s.hydrate);
  const hydrateDownloads = useDownloads((s) => s.hydrate);
  const hydrateSeriesOrderings = useSeriesOrderings((s) => s.hydrate);
  const hydrateLibrarySelection = useLibrarySelection((s) => s.hydrate);
  useEffect(() => {
    void (async () => {
      // Reconcile storage left incompatible by a version bump BEFORE the stores read it,
      // so none loads records keyed on now-invalid connection ids. Two independent axes:
      // `authReset` (connection identity scheme changed - everyone re-pairs) and
      // `cacheReset` (disposable download/progress cache schema changed - logins intact).
      // A no-op after the first post-bump launch. Guarded so a keychain/storage hiccup can
      // never skip hydration below - that would strand the app on 'loading' forever
      // (and defeat hydrate()'s own fail-safe).
      let didReset = false;
      try {
        // The one memoised launch migration (ThemeProvider awaits the same run).
        const { authReset, cacheReset } = await migrateStorage();
        didReset = authReset || cacheReset;
      } catch (e) {
        console.warn('[storage] stale-state reset failed', e);
      }
      // Whenever either axis reset, the on-disk downloaded files no longer match the
      // registry (auth wipe orphans them; a cache-schema bump invalidates them), so wipe
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
      void hydrateSeriesOrderings();
      void hydrateLibrarySelection();
    })();
  }, [hydrate, hydrateSettings, hydrateDownloads, hydrateSeriesOrderings, hydrateLibrarySelection]);

  // The nightly auto sleep timer. Framework-free (subscriptions, no rendering), so it is
  // started here rather than mounted as a component that renders null - this is simply
  // where the app's lifetime is expressed. Its own effect, not the bootstrap one above:
  // that one is async and returns nothing, and pairing start with teardown in a single
  // expression is what keeps the subscriptions from leaking. It must run whether or not
  // the player modal is open, since the timer has to arm for a book started from the
  // mini player, the library, or a lock-screen play.
  useEffect(() => startAutoSleep(), []);

  // "Fell asleep": the bookmark and the "You drifted off" prompt after a sleep timer
  // stopped a book nobody was awake for. Framework-free like the auto sleep timer.
  useEffect(() => startDriftWatch(), []);

  // "Keep the next books ready" (downloads the books after the loaded one when the
  // listener opted in). Framework-free like the auto sleep timer; see the controller.
  useEffect(() => startKeepAhead(), []);

  // On returning to the foreground: refresh data, and (Android) reset to Home if the
  // app was swiped away from recents. See @/lib/app-resume.
  useAppResume();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {/* The window's insets, for every overlay wherever it is opened from. */}
        <RootInsetsProvider>
          <LanguageProvider>
            <ThemeProvider>
              <ApiProvider>
                <RootNavigator />
                <StatusBar style="auto" />
                {/* The native outlet for the portal-based overlays (Dialog, Select, menus,
                  popovers: @rn-primitives). LAST, so portaled content stacks above every
                  screen, and inside the providers it reads (theme, i18n, query client).
                  Web overlays portal into document.body instead. Toasts sit above it,
                  lifted clear of the shell's bottom chrome. */}
                <PortalHost />
                <ShellToastHost />
              </ApiProvider>
            </ThemeProvider>
          </LanguageProvider>
        </RootInsetsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
