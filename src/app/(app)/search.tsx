import { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';

import { useSearch } from '@/api/hooks';
import { BookRow } from '@/components/library/book-row';
import { EmptyNote, ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { TextField } from '@/components/ui/text-field';

export default function SearchScreen() {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');

  // Debounce so we don't query on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(input.trim()), 300);
    return () => clearTimeout(t);
  }, [input]);

  const { data: results, isFetching, error } = useSearch(query);

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-3 p-4"
      keyboardShouldPersistTaps="handled"
    >
      <TextField
        placeholder="Search titles, authors, series…"
        value={input}
        onChangeText={setInput}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />

      {query.length === 0 ? null : isFetching ? (
        <Spinner center />
      ) : error ? (
        <ErrorNote message="Search failed." />
      ) : results && results.length === 0 ? (
        <EmptyNote message={`No results for “${query}”.`} />
      ) : (
        results?.map((book) => <BookRow key={`${book.library_id}:${book.rel_path}`} book={book} />)
      )}
    </ScrollView>
  );
}
