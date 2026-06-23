import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';

import { useSearchAll, useSourceLabeller } from '@/api/hooks';
import { BookRow } from '@/components/library/book-row';
import { EmptyNote, ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { useSearchStore } from '@/stores/search';

/** Results for the desktop search bar, shown as an overlay over the content (no
 * route change). Selecting a result navigates away, which clears the query. */
export function SearchResults() {
  const { t } = useTranslation();
  const query = useSearchStore((s) => s.query);
  const [debounced, setDebounced] = useState(query.trim());

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { books, isFetching, error } = useSearchAll(debounced);
  const sourceOf = useSourceLabeller();

  return (
    <ScrollView
      className="flex-1 bg-gray-200 dark:bg-gray-800"
      contentContainerClassName="gap-2 p-6"
      keyboardShouldPersistTaps="handled"
    >
      {isFetching ? (
        <Spinner center />
      ) : error ? (
        <ErrorNote message={t('library.searchResults.failed')} />
      ) : books.length === 0 ? (
        <EmptyNote message={t('library.searchResults.noResults', { query: debounced })} />
      ) : (
        books.map((b) => (
          <BookRow
            key={`${b.connectionId}:${b.library_id}:${b.rel_path}`}
            book={b}
            connectionId={b.connectionId}
            source={sourceOf(b.connectionId, b.library_id, b.connectionName)}
            also={b.also}
          />
        ))
      )}
    </ScrollView>
  );
}
