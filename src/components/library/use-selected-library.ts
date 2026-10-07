import { useEffect } from 'react';

import { type SourcedLibrary, useLibrariesAll } from '@/api/hooks';
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
 * first library listed, an offline server keeps its pick, and a fallback once shown
 * stays put).
 * - `selection` / `library`: what to show (null while there is nothing yet);
 * - `groups`: every server's libraries in connection order, for `LibraryPicker`;
 * - `select`: remember another library.
 * The library lists are `useLibrariesAll`'s.
 */
export function useSelectedLibrary() {
  const stored = useLibrarySelection((s) => s.selection);
  const select = useLibrarySelection((s) => s.select);
  const groups: LibraryChoiceGroup[] = useLibrariesAll().groups.map((g) => ({
    ...g,
    libraryIds: g.libraries.map((l) => l.id),
  }));
  const shown = useLibrarySelection((s) => s.shown);
  const hold = useLibrarySelection((s) => s.hold);
  const selection = resolveLibrarySelection(stored, groups, shown);
  useEffect(() => {
    if (selection) hold(selection);
  }, [selection?.connectionId, selection?.libraryId]); // eslint-disable-line react-hooks/exhaustive-deps
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
