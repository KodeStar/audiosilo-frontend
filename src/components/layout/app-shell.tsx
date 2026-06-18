import { usePathname } from 'expo-router';
import { useEffect, type ReactNode } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MiniPlayer } from '@/components/player/mini-player';
import { PlayerView } from '@/components/player/player-view';
import { usePlayer } from '@/playback/store';
import { useSearchStore } from '@/stores/search';

import { AppHeader } from './app-header';
import { NavBar } from './app-nav';
import { ContentColumn } from './content-column';

const WIDE_BREAKPOINT = 1024;

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

  // Clear the search when navigating (e.g. after picking a result), so the
  // overlay closes and the bar resets.
  useEffect(() => {
    setQuery('');
  }, [pathname, setQuery]);

  // The book screen owns its own two-pane layout (chapters + a player/detail
  // panel) and renders its own content column, so the shell just gives it the
  // sidebar — no full-width search bar across its panel, no duplicate player.
  const onBook = pathname.startsWith('/book');

  if (wide && onBook) {
    return (
      <View className="flex-1 flex-row bg-gray-200 dark:bg-gray-800">
        <NavBar orientation="sidebar" />
        <View className="flex-1">{children}</View>
      </View>
    );
  }

  if (wide) {
    // Three columns when something is playing: sidebar | content | player panel.
    // The content column is flex-1, so it narrows to make room for the player
    // (and its search bar resizes with it) instead of the player overlaying it.
    return (
      <View className="flex-1 flex-row bg-gray-200 dark:bg-gray-800">
        <NavBar orientation="sidebar" />
        <ContentColumn>{children}</ContentColumn>
        {playing ? (
          <View className="w-[380px] border-l border-gray-100 dark:border-gray-750">
            <PlayerView />
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View className="flex-1 bg-gray-200 dark:bg-gray-800">
      <AppHeader />
      <View className="flex-1">{children}</View>
      {!onBook ? <MiniPlayer /> : null}
      <SafeAreaView edges={['bottom']} className="bg-gray-200 dark:bg-gray-800">
        <NavBar orientation="bottom" />
      </SafeAreaView>
    </View>
  );
}
