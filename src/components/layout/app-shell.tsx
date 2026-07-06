import { usePathname } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { MiniPlayer } from '@/components/player/mini-player';
import { PlayerView } from '@/components/player/player-view';
import { WIDE_BREAKPOINT } from '@/lib/layout';
import { clearScrollMemory } from '@/lib/scroll-memory';
import { usePlayer } from '@/playback/store';
import { useSearchStore } from '@/stores/search';

import { AppHeader } from './app-header';
import { NavBar } from './app-nav';
import { ContentColumn } from './content-column';
import { OfflineBanner } from './offline-banner';

/**
 * Responsive chrome around the routed screen:
 * - wide (web/tablet): left sidebar, content with an always-available search bar
 *   (results overlay in place), and a right detail panel provided per-screen.
 * - phone: header on top, content, bottom tab bar.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;
  const pathname = usePathname();
  const setQuery = useSearchStore((s) => s.setQuery);
  const playing = usePlayer((s) => s.nowPlaying != null);

  // The mini-player floats just above the bottom nav. The nav's rendered height
  // includes the bottom safe-area inset (iOS home indicator), so we measure it
  // and offset the bar by that - a fixed offset left it hidden behind the nav on
  // iOS. Until the first layout, estimate from the inset so it never starts under.
  const insets = useSafeAreaInsets();
  const [navHeight, setNavHeight] = useState<number | null>(null);
  const navOffset = navHeight ?? 64 + insets.bottom;

  // Clear the search when navigating (e.g. after picking a result), so the
  // overlay closes and the bar resets.
  useEffect(() => {
    setQuery('');
  }, [pathname, setQuery]);

  // Content routes are flat (`/book/[libraryId]`, `/library/[libraryId]`), so the
  // pathname is already the logical content path (the connection rides in a query param).
  //
  // The book screen owns its own two-pane layout (chapters + a player/detail
  // panel) and renders its own content column, so the shell just gives it the
  // sidebar - no full-width search bar across its panel, no duplicate player.
  const onBook = pathname.startsWith('/book');

  // Remembered browse scroll positions only make sense while moving within the
  // library (drilling into folders/books and back). Leaving the section - Home,
  // Settings, etc. - forgets them, so re-entering the library starts at the top.
  const inBrowse = pathname.startsWith('/library') || onBook;
  useEffect(() => {
    if (!inBrowse) clearScrollMemory();
  }, [inBrowse]);

  let content: ReactNode;
  if (wide && onBook) {
    content = (
      <View className="flex-1 flex-row bg-gray-200 dark:bg-gray-800">
        <NavBar orientation="sidebar" />
        <View className="flex-1">
          <OfflineBanner />
          {children}
        </View>
      </View>
    );
  } else if (wide) {
    // Three columns when something is playing: sidebar | content | player panel.
    // The content column is flex-1, so it narrows to make room for the player
    // (and its search bar resizes with it) instead of the player overlaying it.
    content = (
      <View className="flex-1 flex-row bg-gray-200 dark:bg-gray-800">
        <NavBar orientation="sidebar" />
        <View className="flex-1">
          <OfflineBanner />
          <ContentColumn>{children}</ContentColumn>
        </View>
        {playing ? (
          <View className="w-[380px] border-l border-gray-100 dark:border-gray-750">
            <PlayerView />
          </View>
        ) : null}
      </View>
    );
  } else {
    content = (
      <View className="flex-1 relative bg-gray-200 dark:bg-gray-800">
        <AppHeader />
        <OfflineBanner />
        <View className="flex-1">{children}</View>
        {/* Phone book screen has no inline player (that's the wide-only right panel),
            so the mini player belongs here too - it self-hides when nothing's loaded.
            It floats above the nav (whose measured height feeds its bottom offset). */}
        <MiniPlayer bottomOffset={navOffset} />
        <SafeAreaView
          edges={['bottom']}
          className="bg-gray-200 dark:bg-gray-800"
          onLayout={(e) => setNavHeight(e.nativeEvent.layout.height)}
        >
          <NavBar orientation="bottom" />
        </SafeAreaView>
      </View>
    );
  }

  return content;
}
