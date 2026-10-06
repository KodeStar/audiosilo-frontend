import { useQueries } from '@tanstack/react-query';

import { qk, type SourcedLibrary } from '@/api/hooks';
import { useApis } from '@/api/provider';
import {
  type LibraryGroup,
  resolveLibrarySelection,
  useLibrarySelection,
} from '@/stores/library-selection';

/** One server's libraries, for the picker. */
export type LibraryChoiceGroup = LibraryGroup & { libraries: SourcedLibrary[] };

/**
 * The library the Library tab's browse modes act on, across every signed-in server:
 * the device's stored pick (`useLibrarySelection`) reconciled with the libraries the
 * servers list now (`resolveLibrarySelection`: a pick that is gone falls back to the
 * first library of the first server, an offline server keeps its pick).
 * - `selection` / `library`: what to show (null while there is nothing yet);
 * - `groups`: every server's libraries in connection order, for `LibraryPicker`;
 * - `select`: remember another library.
 * The library lists share `useLibrariesAll`'s cache (`qk.libraries`).
 */
export function useSelectedLibrary() {
  const apis = useApis();
  const stored = useLibrarySelection((s) => s.selection);
  const select = useLibrarySelection((s) => s.select);
  const groups = useQueries({
    queries: apis.map(({ connection, client }) => ({
      queryKey: qk.libraries(connection.id),
      queryFn: () => client.libraries(),
    })),
    combine: (results): LibraryChoiceGroup[] =>
      results.map((r, i) => {
        const { id, name } = apis[i].connection;
        const libraries = (r.data ?? []).map((l): SourcedLibrary => ({
          ...l,
          connectionId: id,
          connectionName: name,
        }));
        return {
          connectionId: id,
          connectionName: name,
          libraries,
          libraryIds: libraries.map((l) => l.id),
          status: r.data ? 'ready' : r.isError ? 'error' : 'loading',
        };
      }),
  });
  const selection = resolveLibrarySelection(stored, groups);
  const library = selection
    ? (groups
        .find((g) => g.connectionId === selection.connectionId)
        ?.libraries.find((l) => l.id === selection.libraryId) ?? null)
    : null;
  return {
    selection,
    library,
    groups,
    select,
    isLoading: groups.some((g) => g.status === 'loading'),
  };
}
