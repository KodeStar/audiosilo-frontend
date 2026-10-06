import { useEffect, useRef } from 'react';
import { ScrollView, type TextInput, View } from 'react-native';

import { useMiniPlayerInset } from '@/components/player/mini-player';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useRecentSearches, useSearchStore } from '@/stores/search';

import { SearchField } from './search-field';
import { SearchIdle } from './search-idle';
import { SearchResultsView } from './search-results-view';
import { useSearch } from './use-search';

/** Search after the typing settles (the palette waits 200 ms; a phone keyboard is slower). */
const DEBOUNCE_MS = 300;

/**
 * The Search tab (STYLEGUIDE section 9, prototype `SearchPage`): the field, then either
 * the recent searches and Browse cards (nothing typed) or the grouped results across
 * every server (`useSearch`). The query lives in `useSearchStore` so it survives a
 * remount; the shell clears it on leaving the tab.
 */
export function SearchScreen() {
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  // Bumped by the top bar's omnisearch (a native tablet): focus the field, whether or not
  // this tab was already open. A first mount takes the focus through `autoFocus`.
  const focusRequest = useSearchStore((s) => s.focusRequest);
  const inputRef = useRef<TextInput>(null);
  useEffect(() => {
    if (focusRequest > 0) inputRef.current?.focus();
  }, [focusRequest]);
  const hydrateRecent = useRecentSearches((s) => s.hydrate);
  const remember = useRecentSearches((s) => s.remember);
  useEffect(hydrateRecent, [hydrateRecent]);

  const typed = query.trim();
  const debounced = useDebouncedValue(typed, DEBOUNCE_MS);
  const results = useSearch(debounced);
  const paddingBottom = useMiniPlayerInset();

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-5 p-4 lg:px-8"
      contentContainerStyle={{ paddingBottom }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <SearchField ref={inputRef} value={query} onChangeText={setQuery} autoFocus />
      <View>
        {!typed ? (
          <SearchIdle onPick={setQuery} />
        ) : (
          // Until the first pause the results are the previous query's (or, from
          // nothing, the loading state of this one).
          <SearchResultsView
            query={debounced || typed}
            results={results}
            pending={debounced !== typed}
            onOpened={() => remember(debounced || typed)}
          />
        )}
      </View>
    </ScrollView>
  );
}
