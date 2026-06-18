import { type ReactNode } from 'react';
import { TextInput, View } from 'react-native';

import { SearchResults } from '@/components/library/search-results';
import { Icon } from '@/components/ui/icon';
import { useSearchStore } from '@/stores/search';
import { colors } from '@/theme/tokens';

/** The single, always-visible desktop search field. Typing reveals the results
 * overlay in place (no route change). It lives in the content column, so it
 * sits above the page (e.g. the breadcrumbs) and never spans the player panel. */
function DesktopSearch() {
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
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
        className="rounded-xl border border-gray-200 bg-white py-4 pl-11 pr-4 font-sans text-base text-gray-700 dark:border-gray-750 dark:bg-gray-840 dark:text-gray-100"
      />
    </View>
  );
}

/**
 * The desktop content column: a persistent search field above the routed page,
 * with the search results overlaying the page in place while typing. Used by the
 * app shell (home/library/etc.) and by the book screen (above its chapters list)
 * so the search bar is above the breadcrumbs everywhere — to the left of, never
 * across, any right-hand panel.
 */
export function ContentColumn({ children }: { children: ReactNode }) {
  const searching = useSearchStore((s) => s.query.trim().length > 0);
  return (
    <View className="flex-1">
      <View className="px-8 pb-3 pt-5">
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
    </View>
  );
}
