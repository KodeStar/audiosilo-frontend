import { useQueryClient } from '@tanstack/react-query';

import { type MergedBook, useSearchAll } from '@/api/hooks';

import {
  type CharacterMatches,
  matchCharacters,
  matchNamed,
  type PersonHit,
  type SeriesHit,
} from './search-model';
import { useCharacterSources, usePeopleSources } from './use-search-sources';

/** One group's state, for its own loading and error lines (a failing group never hides
 * the others). `supported` false: no server can answer it, so it is left out. */
export type GroupState = {
  supported: boolean | undefined;
  isLoading: boolean;
  isError: boolean;
  retry: () => void;
};

export type SearchResults = {
  books: MergedBook[];
  booksState: GroupState;
  series: SeriesHit[];
  authors: PersonHit[];
  narrators: PersonHit[];
  peopleState: GroupState;
  characters: CharacterMatches;
  charactersState: GroupState;
  /** Every group has answered (or failed). */
  settled: boolean;
  /** Results shown (the unmet characters are not results). */
  total: number;
};

/**
 * Everything Search finds for a (debounced) query, across every server: books from the
 * servers' search (deduplicated, "Also on"), series and people matched on the device
 * against every library's browse lists, and characters the listener has met
 * (`matchCharacters`). Shared by the Search screen and the web palette; `limit` caps the
 * named groups (the palette shows three of each).
 */
export function useSearch(
  query: string,
  { limit, refetchProgress }: { limit?: number; refetchProgress?: boolean } = {},
): SearchResults {
  const q = query.trim();
  const qc = useQueryClient();
  const search = useSearchAll(q);
  const people = usePeopleSources(q.length > 0);
  const characterSources = useCharacterSources(q.length > 0, { refetchProgress });

  // Matched on every render: the lists are small, and their arrays are rebuilt by
  // `useQueries` each render anyway.
  const named = {
    series: matchNamed(people.series, q, limit),
    authors: matchNamed(people.authors, q, limit),
    narrators: matchNamed(people.narrators, q, limit),
  };
  const characters = matchCharacters(characterSources.books, q, limit);

  const booksState: GroupState = {
    supported: true,
    isLoading: search.isFetching,
    isError: !!search.error,
    retry: () =>
      void qc.refetchQueries({
        predicate: (query) => query.queryKey[0] === 'search' && query.queryKey[2] === q,
      }),
  };
  const peopleState: GroupState = {
    supported: people.supported,
    isLoading: people.isLoading,
    isError: people.isError,
    retry: people.retry,
  };
  const charactersState: GroupState = {
    supported: characterSources.supported,
    isLoading: characterSources.isLoading,
    isError: characterSources.isError,
    retry: characterSources.retry,
  };

  return {
    books: q ? search.books : [],
    booksState,
    ...named,
    peopleState,
    characters,
    charactersState,
    settled: !booksState.isLoading && !peopleState.isLoading && !charactersState.isLoading,
    total:
      (q ? search.books.length : 0) +
      named.series.length +
      named.authors.length +
      named.narrators.length +
      characters.hits.length,
  };
}
