import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, useWindowDimensions } from 'react-native';

import { useSearchAll, useSourceLabeller } from '@/api/hooks';
import { BookRow } from '@/components/library/book-row';
import { BookRowSkeletonList } from '@/components/library/search-results';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorNote } from '@/components/ui/query-state';
import { TextField } from '@/components/ui/text-field';
import { WIDE_BREAKPOINT } from '@/lib/layout';
import { useSearchStore } from '@/stores/search';

export default function SearchScreen() {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const [debounced, setDebounced] = useState(query.trim());

  // Debounce so we don't query on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const { books, isFetching, error } = useSearchAll(debounced);
  const sourceOf = useSourceLabeller();
  const paddingBottom = useMiniPlayerInset();

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-2 p-4 lg:px-8"
      contentContainerStyle={{ paddingBottom }}
      keyboardShouldPersistTaps="handled"
    >
      {/* On desktop the always-visible top bar is the input; on phone we render one here. */}
      {!wide ? (
        <TextField
          placeholder={t('search.placeholder')}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          autoFocus
        />
      ) : null}

      {debounced.length === 0 ? (
        <EmptyState icon="search" title={t('search.promptTitle')} hint={t('search.prompt')} />
      ) : isFetching ? (
        <BookRowSkeletonList />
      ) : error ? (
        <ErrorNote message={t('search.failed')} />
      ) : books.length === 0 ? (
        <EmptyState
          icon="search"
          title={t('search.noResultsTitle')}
          hint={t('search.noResults', { query: debounced })}
        />
      ) : (
        books.map((book) => (
          <BookRow
            key={`${book.connectionId}:${book.library_id}:${book.rel_path}`}
            book={book}
            connectionId={book.connectionId}
            source={sourceOf(book.connectionId, book.library_id, book.connectionName)}
            also={book.also}
          />
        ))
      )}
    </ScrollView>
  );
}
