import { PortalHost } from '@rn-primitives/portal';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { startAddressRouting } from '@/api/address-runner';
import { ApiProvider } from '@/api/provider';
import { startCarSync } from '@/car/car-controller';
import { BookEndedListener } from '@/components/player/book-ended-listener';
import { CompanionRevealListener } from '@/components/player/companion/reveal-listener';
import { ShakeToExtendListener } from '@/components/player/shake-to-extend-listener';
import { ShellToastHost } from '@/components/shell/shell-toast-host';
import { RootInsetsProvider } from '@/components/ui/overlay';
import { startKeepAhead } from '@/downloads/keep-ahead-controller';
import { startChapterRefresh } from '@/downloads/store';
import '@/i18n';
import { LanguageProvider } from '@/i18n/language-provider';
import { useAppResume } from '@/lib/app-resume';
import { bootstrapPlayback } from '@/lib/bootstrap';
import { startAutoSleep } from '@/playback/auto-sleep-controller';
import { startDriftWatch } from '@/playback/drift-controller';
import { startJumpUndo } from '@/playback/jump-undo';
import { startPlaceReconcile } from '@/playback/place-reconcile';
import '@/lib/register-sw';
// Web: render `role="button"` as `<div role="button">` instead of a real `<button>`
// (which nests illegally and hits an older-Safari flex bug), and let Space activate
// role-bearing pressables (tab, radio, switch...). All top-level imports evaluate before
// the first render, so this patches RNW in time. No-op on native.
import '@/lib/rnw-button-fix';
import { ThemeProvider } from '@/theme/theme-provider';
import { useThemeColors } from '@/theme/use-theme-colors';
import { startWidgetSync } from '@/widgets/widget-sync';

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
        <Stack.Screen name="year" options={{ presentation: 'fullScreenModal' }} />
      </Stack>
      {/* Root-level so it covers every layout (phone modal + wide desktop): drives the
          end-of-book flow when a book reaches its natural end. */}
      <BookEndedListener />
      {/* "New in Who's who": fires wherever the listener is when the playing book
          crosses into a chapter that introduces someone. */}
      <CompanionRevealListener />
      {/* A shake must keep the listener going while the phone is locked
          and no player screen is mounted. */}
      <ShakeToExtendListener />
    </>
  );
}

export default function RootLayout() {
  // The launch steps every store needs before a screen reads it (the storage migration,
  // then the downloads wipe after a reset, then hydrating the session, settings,
  // downloads, series orderings and library selection), as one memoised run shared with
  // the car's headless task: see `bootstrapPlayback`.
  useEffect(() => {
    void bootstrapPlayback();
  }, []);

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

  // A downloaded book takes the server's changed chapters (a rescan, community chapters)
  // whenever they arrive online, while its audio files are unchanged; see the store.
  useEffect(() => startChapterRefresh(), []);

  // Undo jump: remembers where the listener was after any jump of more than a minute
  // (scrub, chapter tap, lock-screen seek...) for the "Back to 17:26:50" chip. Watches the
  // player's snapshots, so it must run whatever is on screen; see the module.
  useEffect(() => startJumpUndo(), []);

  // A loaded book picked up again (the app back in front, its server back, a play after
  // a long pause) first asks its server whether another device moved its place on, and
  // follows it with an Undo. Framework-free like the others; see the module.
  useEffect(() => startPlaceReconcile(), []);

  // Home and away addresses: picks the address each server is reached at (native only)
  // and keeps the playing book on it. Framework-free like the others; see the module.
  useEffect(() => startAddressRouting(), []);

  // iOS: the Continue listening widget and the sleep timer Live Activity follow the player
  // and the sleep timer (a no-op elsewhere). Framework-free like the others; see the module.
  useEffect(() => startWidgetSync(), []);

  // CarPlay and Android Auto: keeps the car's lists (the car snapshot) current, plays what
  // the car asks for, saves the car's bookmarks and adopts a book the car started. Native
  // only (a no-op on the web and on a binary without the car functions); it waits for the
  // launch steps above itself. Framework-free like the others; see the module. Never
  // stopped (like the car's headless task): the JS runtime outlives this layout on Android
  // (the activity is destroyed, the store and its book live on), and while it runs the car's
  // requests must reach it, never start a book natively under the store's.
  useEffect(() => {
    startCarSync();
  }, []);

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
