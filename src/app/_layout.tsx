import { PortalHost } from '@rn-primitives/portal';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '@/api/provider';
import { KidsRouteGuard } from '@/components/kids/kids-route-guard';
import { DocumentTitle, StaticDocumentTitle } from '@/components/shell/document-title';
import { RootListeners, useRootServices } from '@/components/shell/root-services';
import { ShellToastHost } from '@/components/shell/shell-toast-host';
import { RootInsetsProvider } from '@/components/ui/overlay';
import '@/i18n';
import { LanguageProvider } from '@/i18n/language-provider';
import { useAppResume } from '@/lib/app-resume';
import { bootstrapPlayback } from '@/lib/bootstrap';
import '@/lib/register-sw';
// Web: render `role="button"` as `<div role="button">` instead of a real `<button>`
// (which nests illegally and hits an older-Safari flex bug), and let Space activate
// role-bearing pressables (tab, radio, switch...). All top-level imports evaluate before
// the first render, so this patches RNW in time. No-op on native.
import '@/lib/rnw-button-fix';
import { StaticFonts } from '@/theme/static-fonts';
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
        <Stack.Screen name="year" options={{ presentation: 'fullScreenModal' }} />
        {/* The ebook reader (Bridge Phase 3b). `/read`, never `/reader`: the static export
            would write that route to reader.html, the reader document's own file. */}
        <Stack.Screen name="read" options={{ presentation: 'fullScreenModal' }} />
        {/* "Who's listening?" (Phase 8): chosen, never swiped away. */}
        <Stack.Screen
          name="profiles"
          options={{ presentation: 'fullScreenModal', gestureEnabled: false }}
        />
      </Stack>
      {/* Root-level so they cover every layout (phone modal + wide desktop): the end of a
          book, "New in Who's who", shake to extend. See `RootListeners`. */}
      <RootListeners />
      {/* Kids mode (Phase 8): a kids profile stays on /kids, whatever the route. */}
      <KidsRouteGuard />
      {/* Web: the browser tab names the page, or the book playing. */}
      <DocumentTitle />
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

  // The app's lifetime services: the auto sleep timer, the drift watch, keep-ahead, the
  // chapter refresh, undo jump, the place reconcile, address routing, the widget, the car
  // and Cast (`startRootServices`). Native starts them here; the web once the first screen
  // has painted (their modules load after it). Their own effect, not the bootstrap one
  // above: that one is async and returns nothing, and pairing start with teardown in a
  // single expression is what keeps the subscriptions from leaking.
  useRootServices();

  // On returning to the foreground: refresh data, and (Android) reset to Home if the
  // app was swiped away from recents. See @/lib/app-resume.
  useAppResume();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Web's static HTML: the tab's title before the app (below) hydrates. */}
      <StaticDocumentTitle />
      {/* Web's static HTML: the fonts' @font-face rules and preloads. */}
      <StaticFonts />
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
