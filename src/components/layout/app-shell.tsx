import { usePathname } from 'expo-router';
import { useEffect, type ReactNode } from 'react';
import { TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SearchResults } from '@/components/library/search-results';
import { MiniPlayer } from '@/components/player/mini-player';
import { Icon } from '@/components/ui/icon';
import { usePlayer } from '@/playback/store';
import { useSearchStore } from '@/stores/search';
import { colors } from '@/theme/tokens';

import { AppHeader } from './app-header';
import { NavBar } from './app-nav';

const WIDE_BREAKPOINT = 1024;

/** The single, always-visible desktop search field. Typing reveals the results
 * overlay in place (no route change); it shrinks while a player is on screen. */
function DesktopSearch() {
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const playing = usePlayer((s) => s.nowPlaying != null);
  return (
    <View className="relative justify-center">
      <View className="absolute bottom-0 left-4 top-0 z-10 justify-center">
        <Icon name="search" size={18} color={colors.dark.textMuted} />
      </View>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search…"
        placeholderTextColor="#9ca3af"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        className={`rounded-xl border border-gray-200 bg-white pl-11 pr-4 font-sans text-base text-gray-700 dark:border-gray-750 dark:bg-gray-840 dark:text-gray-100 ${
          playing ? 'py-2' : 'py-4'
        }`}
      />
    </View>
  );
}

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
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);

  // Clear the search when navigating (e.g. after picking a result), so the
  // overlay closes and the bar resets.
  useEffect(() => {
    setQuery('');
  }, [pathname, setQuery]);

  // The book screen has its own player, so the mini-player is redundant there.
  const showMini = !pathname.startsWith('/book');
  const searching = wide && query.trim().length > 0;

  if (wide) {
    return (
      <View className="flex-1 flex-row bg-gray-200 dark:bg-gray-800">
        <NavBar orientation="sidebar" />
        <View className="flex-1">
          <View className="px-6 pb-2 pt-5">
            <DesktopSearch />
          </View>
          <View className="flex-1">
            {children}
            {searching ? (
              <View className="absolute inset-0">
                <SearchResults />
              </View>
            ) : null}
          </View>
          {showMini && !searching ? <MiniPlayer /> : null}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-gray-200 dark:bg-gray-800">
      <AppHeader />
      <View className="flex-1">{children}</View>
      {showMini ? <MiniPlayer /> : null}
      <SafeAreaView edges={['bottom']} className="bg-gray-200 dark:bg-gray-800">
        <NavBar orientation="bottom" />
      </SafeAreaView>
    </View>
  );
}
