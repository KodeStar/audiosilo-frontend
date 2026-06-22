import { useEffect, useState } from 'react';
import { ScrollView, useWindowDimensions } from 'react-native';

import { useSearchAll } from '@/api/hooks';
import { BookRow } from '@/components/library/book-row';
import { EmptyNote, ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { TextField } from '@/components/ui/text-field';
import { useSearchStore } from '@/stores/search';

const WIDE_BREAKPOINT = 1024;

export default function SearchScreen() {
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

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-0 p-4 lg:px-8"
      keyboardShouldPersistTaps="handled"
    >
      {/* On desktop the always-visible top bar is the input; on phone we render one here. */}
      {!wide ? (
        <TextField
          placeholder="Search titles, authors, series…"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          autoFocus
        />
      ) : null}

      {debounced.length === 0 ? (
        <EmptyNote message="Search titles, authors, and series." />
      ) : isFetching ? (
        <Spinner center />
      ) : error ? (
        <ErrorNote message="Search failed." />
      ) : books.length === 0 ? (
        <EmptyNote message={`No results for “${debounced}”.`} />
      ) : (
        books.map((book) => (
          <BookRow
            key={`${book.connectionId}:${book.library_id}:${book.rel_path}`}
            book={book}
            connectionId={book.connectionId}
            also={book.also}
          />
        ))
      )}
    </ScrollView>
  );
}
