import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import type { BookmarkLabel } from '@/api/bookmark-labels';
import { resolveClient } from '@/api/connection-clients';
import { addBookmark, qk, useDeleteBookmark, useDeleteNote } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import type { Bookmark, Note } from '@/api/types';
import { startBookInPlace } from '@/components/player/start-book';
import { toast } from '@/components/ui/toast';
import { contentKeyOf } from '@/lib/content-key';
import { formatClock } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { currentNavState, topRootRoute } from '@/lib/root-stack';
import { selectBookKey, usePlayer } from '@/playback/store';

import type { AnnotationTarget } from './editor-model';

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
 * through the book's own connection, then refresh the book's notes and the across-books
 * list. New id and dates, like `restoreBookmark`. */
export async function restoreNote(connectionId: string, note: Note): Promise<Note> {
  const client = resolveClient(connectionId);
  if (!client) throw new Error('connection gone');
  const made = await client.addNote(note.library_id, note.path, note.body, note.position);
  void queryClient.invalidateQueries({ queryKey: qk.myNotes(connectionId) });
  void queryClient.invalidateQueries({
    queryKey: qk.notes(connectionId, note.library_id, note.path),
  });
  return made;
}

/**
 * Delete a bookmark at once, with an Undo toast that puts it back (`restoreBookmark`).
 * Deleting is immediate rather than held for the toast, so another device (and the pins)
 * agree straight away and nothing waits on a timer an app suspend could stop; the cost
 * of Undo is a new date on the bookmark.
 */
export function useDeleteBookmarkWithUndo(connectionId: string, libraryId: number, path: string) {
  const { t } = useTranslation();
  const del = useDeleteBookmark(libraryId, path, connectionId);
  return (bookmark: Bookmark) =>
    del.mutate(bookmark.id, {
      onSuccess: () =>
        toast({
          title: t('annotations.bookmark.deleted'),
          description: formatClock(bookmark.position),
          action: {
            label: t('annotations.undo'),
            onPress: () => {
              restoreBookmark(connectionId, bookmark).catch(() =>
                toast({ title: t('annotations.bookmark.restoreFailed') }),
              );
            },
          },
        }),
      onError: () => toast({ title: t('annotations.bookmark.deleteFailed') }),
    });
}

/** `useDeleteBookmarkWithUndo` for a note. */
export function useDeleteNoteWithUndo(connectionId: string, libraryId: number, path: string) {
  const { t } = useTranslation();
  const del = useDeleteNote(libraryId, path, connectionId);
  return (note: Note) =>
    del.mutate(note.id, {
      onSuccess: () =>
        toast({
          title: t('annotations.note.deleted'),
          description: formatClock(note.position),
          action: {
            label: t('annotations.undo'),
            onPress: () => {
              restoreNote(connectionId, note).catch(() =>
                toast({ title: t('annotations.note.restoreFailed') }),
              );
            },
          },
        }),
      onError: () => toast({ title: t('annotations.note.deleteFailed') }),
    });
}
