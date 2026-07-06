import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, type StyleProp, TextInput, type TextStyle, View } from 'react-native';

import { SearchResults } from '@/components/library/search-results';
import { Icon } from '@/components/ui/icon';
import { useSearchStore } from '@/stores/search';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

// react-native-web renders TextInput as an <input>; its default focus outline is
// the blue ring we want gone (we draw a primary border instead). `outlineStyle`
// isn't in RN's TextStyle, so cast - it's a no-op on native (guarded by Platform).
const webNoOutline = { outlineStyle: 'none' } as unknown as StyleProp<TextStyle>;

/** The single, always-visible desktop search field. Typing reveals the results
 * overlay in place (no route change). It lives in the content column, so it
 * sits above the page (e.g. the breadcrumbs) and never spans the player panel. */
function DesktopSearch() {
  const { t } = useTranslation();
  const { scheme } = useTheme();
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const [focused, setFocused] = useState(false);
  const muted = colors[scheme].textMuted;
  return (
    <View className="relative justify-center">
      <View className="absolute bottom-0 left-4 top-0 z-10 justify-center">
        <Icon name="search" size={18} color={muted} />
      </View>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={t('nav.searchPlaceholder')}
        placeholderTextColor={muted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        // Match TextField's look (radius/paddings/surface); swap the browser's
        // default blue focus outline for a primary ring by suppressing the native
        // outline on web and driving the border colour from focus state.
        style={Platform.OS === 'web' ? webNoOutline : undefined}
        className={[
          'rounded-xl border py-3.5 pl-11 pr-11 font-sans text-base text-gray-700 dark:text-gray-100',
          'bg-gray-100 dark:bg-gray-840',
          focused ? 'border-primary' : 'border-gray-200 dark:border-gray-750',
        ].join(' ')}
      />
      {query.length > 0 ? (
        <Pressable
          onPress={() => setQuery('')}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('search.clear')}
          className="absolute bottom-0 right-3 top-0 z-10 justify-center active:opacity-60"
        >
          <Icon name="close" size={16} color={muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The desktop content column: a persistent search field above the routed page,
 * with the search results overlaying the page in place while typing. Used by the
 * app shell (home/library/etc.) and by the book screen (above its chapters list)
 * so the search bar is above the breadcrumbs everywhere - to the left of, never
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
