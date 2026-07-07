import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { useSearchAll, useSourceLabeller } from '@/api/hooks';
import { BookRow } from '@/components/library/book-row';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorNote } from '@/components/ui/query-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useSearchStore } from '@/stores/search';

/** A loading placeholder shaped like a BookRow: a small cover square and two
 * text lines. Shown while a search is in flight so the list mirrors its layout. */
export function BookRowSkeleton() {
  return (
    <View className="flex-row items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 p-2 dark:border-gray-860 dark:bg-gray-840">
      <Skeleton className="h-16 w-16 rounded-lg" />
      <View className="flex-1 gap-2">
        <Skeleton className="h-3.5 w-1/2 rounded" />
        <Skeleton className="h-3 w-1/3 rounded" />
      </View>
    </View>
  );
}

/** A stack of row skeletons for a loading results list. */
export function BookRowSkeletonList({ count = 6 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <BookRowSkeleton key={i} />
      ))}
    </>
  );
}

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
        <BookRowSkeletonList />
      ) : error ? (
        <ErrorNote message={t('library.searchResults.failed')} />
      ) : books.length === 0 ? (
        <EmptyState
          icon="search"
          title={t('search.noResultsTitle')}
          hint={t('search.noResults', { query: debounced })}
        />
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
