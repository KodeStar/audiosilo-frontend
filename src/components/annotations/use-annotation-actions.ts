import { router } from 'expo-router';
import type { ParseKeys } from 'i18next';
import { useTranslation } from 'react-i18next';

import type { BookmarkLabel } from '@/api/bookmark-labels';
import { addBookmark, addNote, useDeleteBookmark, useDeleteNote } from '@/api/hooks';
import type { Bookmark, Note } from '@/api/types';
import { startBookInPlace } from '@/components/player/start-book';
import { toast } from '@/components/ui/toast';
import type { AnnotationTarget } from '@/lib/annotation-request';
import { contentKeyOf } from '@/lib/content-key';
import { formatClock } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { currentNavState, topRootRoute } from '@/lib/root-stack';
import { selectBookKey, usePlayer } from '@/playback/store';

/**
 * Jump to a place in a book (a bookmark's or a note's time chip), through the player's
 * own paths, whichever book is playing:
 * - the loaded book seeks there (`seekBook`: a deliberate seek, so the Undo chip offers
 *   the way back after a jump over a minute);
 * - another book on a phone opens the full player there (the route starts it at
 *   `position`), unless the player is already on top;
 * - else (a tablet or desktop, under the docked bar) it starts in place at `position`.
 */
export function useJumpTo(): (target: AnnotationTarget, position: number) => void {
  const phone = useLayout() === 'phone';
  const { t } = useTranslation();
  return (target, position) => {
    const store = usePlayer.getState();
    if (selectBookKey(store) === contentKeyOf(target)) {
      void store.seekBook(position);
      return;
    }
    const at = Math.max(0, Math.round(position));
    // Read at the press: pushing the player over the open one stacks a second player.
    const playerOnTop = topRootRoute(currentNavState()) === 'player';
    if (phone && !playerOnTop) {
      router.push({
        pathname: '/player',
        params: {
          connection: target.connectionId,
          libraryId: String(target.libraryId),
          path: target.path,
          position: String(at),
        },
      });
      return;
    }
    startBookInPlace(target, { position: at }).catch(() => {
      toast({ title: t('annotations.jumpFailed') });
    });
  };
}

/** Put a deleted bookmark back (the delete toast's Undo): the same place, note and label
 * on the same book, through its own connection. The server gives it a new id and date
 * (an undone bookmark reads as just made). A label reaches only a server with
 * `annotations` (the one that gave it). */
export function restoreBookmark(connectionId: string, bookmark: Bookmark): Promise<Bookmark> {
  return addBookmark(
    connectionId,
    bookmark.library_id,
    bookmark.path,
    bookmark.position,
    bookmark.note,
    // A key from the server, so a valid one, even one this player doesn't name.
    bookmark.label ? (bookmark.label as BookmarkLabel) : undefined,
  );
}

/** Put a deleted note back (the delete toast's Undo): the same body at the same place,
 * through the book's own connection. New id and dates, like `restoreBookmark`. */
export function restoreNote(connectionId: string, note: Note): Promise<Note> {
  return addNote(connectionId, note.library_id, note.path, note.body, note.position);
}

/** The row a delete with Undo takes, by kind. */
type UndoRow = { bookmark: Bookmark; note: Note };

/** What a delete with Undo needs per kind: its delete hook, its restore, its copy. */
const UNDO: {
  [K in keyof UndoRow]: {
    useDelete: typeof useDeleteBookmark;
    restore: (connectionId: string, row: UndoRow[K]) => Promise<unknown>;
    copy: Record<'deleted' | 'deleteFailed' | 'restoreFailed', ParseKeys>;
  };
} = {
  bookmark: {
    useDelete: useDeleteBookmark,
    restore: restoreBookmark,
    copy: {
      deleted: 'annotations.bookmark.deleted',
      deleteFailed: 'annotations.bookmark.deleteFailed',
      restoreFailed: 'annotations.bookmark.restoreFailed',
    },
  },
  note: {
    useDelete: useDeleteNote,
    restore: restoreNote,
    copy: {
      deleted: 'annotations.note.deleted',
      deleteFailed: 'annotations.note.deleteFailed',
      restoreFailed: 'annotations.note.restoreFailed',
    },
  },
};

/**
 * Delete a bookmark or a note at once, with an Undo toast that puts it back
 * (`restoreBookmark`, `restoreNote`). Deleting is immediate rather than held for the
 * toast, so another device (and the pins) agree straight away and nothing waits on a
 * timer an app suspend could stop; the cost of Undo is a new date on the row. `kind` is
 * fixed for a caller (it picks the delete hook).
 */
export function useDeleteWithUndo<K extends keyof UndoRow>(
  kind: K,
  connectionId: string,
  libraryId: number,
  path: string,
): (row: UndoRow[K]) => void {
  const { t } = useTranslation();
  const { useDelete, restore, copy } = UNDO[kind];
  const del = useDelete(libraryId, path, connectionId);
  return (row) =>
    del.mutate(row.id, {
      onSuccess: () =>
        toast({
          title: t(copy.deleted),
          description: formatClock(row.position),
          action: {
            label: t('annotations.undo'),
            onPress: () => {
              restore(connectionId, row).catch(() => toast({ title: t(copy.restoreFailed) }));
            },
          },
        }),
      onError: () => toast({ title: t(copy.deleteFailed) }),
    });
}
