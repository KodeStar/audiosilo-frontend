import { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';

import { useSearch } from '@/api/hooks';
import { BookRow } from '@/components/library/book-row';
import { EmptyNote, ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { useSearchStore } from '@/stores/search';

/** Results for the desktop search bar, shown as an overlay over the content (no
 * route change). Selecting a result navigates away, which clears the query. */
export function SearchResults() {
  const query = useSearchStore((s) => s.query);
  const [debounced, setDebounced] = useState(query.trim());

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { data: results, isFetching, error } = useSearch(debounced);

  return (
    <ScrollView
      className="flex-1 bg-gray-200 dark:bg-gray-800"
      contentContainerClassName="gap-2 p-6"
      keyboardShouldPersistTaps="handled"
    >
      {isFetching ? (
        <Spinner center />
      ) : error ? (
        <ErrorNote message="Search failed." />
      ) : results && results.length === 0 ? (
        <EmptyNote message={`No results for “${debounced}”.`} />
      ) : (
        results?.map((b) => <BookRow key={`${b.library_id}:${b.rel_path}`} book={b} />)
      )}
    </ScrollView>
  );
}
