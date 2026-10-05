import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, type TextInput } from 'react-native';

import { useSearchAll, useSourceLabeller } from '@/api/hooks';
import { BookRow } from '@/components/library/book-row';
import { BookRowSkeletonList } from '@/components/library/search-results';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorNote } from '@/components/ui/query-state';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useSearchStore } from '@/stores/search';

export default function SearchScreen() {
  const { t } = useTranslation();
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  // Bumped by the top bar's omnisearch (a native tablet): focus the field, whether or not
  // this tab was already open. A first mount takes the focus through `autoFocus`.
  const focusRequest = useSearchStore((s) => s.focusRequest);
  const inputRef = useRef<TextInput>(null);
  useEffect(() => {
    if (focusRequest > 0) inputRef.current?.focus();
  }, [focusRequest]);
  // Debounce so we don't query on every keystroke.
  const debounced = useDebouncedValue(query.trim(), 300);

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
      <Input
        ref={inputRef}
        placeholder={t('search.placeholder')}
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        autoFocus
      />

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
