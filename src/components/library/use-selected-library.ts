import { useEffect } from 'react';

import { type LibrariesOfServer, type SourcedLibrary, useLibrariesAll } from '@/api/hooks';
import { type LibraryGroup, resolveLibrary, useLibrarySelection } from '@/stores/library-selection';

/** One server's libraries, for the picker (`paused`: its list waits for the network). */
export type LibraryChoiceGroup = LibraryGroup &
  Pick<LibrariesOfServer, 'paused'> & { libraries: SourcedLibrary[] };

/**
 * The library the Library tab's browse modes act on, across every signed-in server:
 * the device's stored pick (`useLibrarySelection`) reconciled with the libraries the
 * servers list now (`resolveLibrary`: a server that has not answered keeps its pick, a
 * pick that is gone falls back on its own server first, and no server's library ever
 * stands in for one whose list is still loading or failed).
 * - `selection` / `library`: what to show (null while there is nothing yet);
 * - `server`: the server the Library is on, the selected library's or, with none to
 *   show, the one whose list it waits for (null: every server answered with none). Its
 *   `status` and `paused` say which state the screen shows for it;
 * - `groups`: every server's libraries in connection order, for `LibraryPicker`;
 * - `select`: remember another library;
 * - `isLoading`: a list is on its way; `offline`: a list waits for the network;
 * - `retryServer`: ask one server again for its list.
 * The library lists are `useLibrariesAll`'s.
 */
export function useSelectedLibrary() {
  const stored = useLibrarySelection((s) => s.selection);
  const select = useLibrarySelection((s) => s.select);
  const all = useLibrariesAll();
  const groups: LibraryChoiceGroup[] = all.groups.map((g) => ({
    ...g,
    libraryIds: g.libraries.map((l) => l.id),
  }));
  const shown = useLibrarySelection((s) => s.shown);
  const hold = useLibrarySelection((s) => s.hold);
  const { selection, waitingOn } = resolveLibrary(stored, groups, shown);
  useEffect(() => {
    if (selection) hold(selection);
  }, [selection?.connectionId, selection?.libraryId]); // eslint-disable-line react-hooks/exhaustive-deps
  const on = selection?.connectionId ?? waitingOn;
  const server = groups.find((g) => g.connectionId === on) ?? null;
  const library = selection
    ? (server?.libraries.find((l) => l.id === selection.libraryId) ?? null)
    : null;
  return {
    selection,
    library,
    server,
    groups,
    select,
    isLoading: all.isLoading,
    offline: all.offline,
    retryServer: all.retryServer,
  };
}
