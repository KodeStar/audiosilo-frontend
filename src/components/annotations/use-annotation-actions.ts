import type { ParseKeys, TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import type { BookmarkLabel } from '@/api/bookmark-labels';
import { addBookmark, addNote, useDeleteBookmark, useDeleteNote } from '@/api/hooks';
import type { Bookmark, Note } from '@/api/types';
import { playFailedToast } from '@/components/player/play-failed';
import { usePlayBook } from '@/components/player/use-play-book';
import { toast } from '@/components/ui/toast';
import type { AnnotationOf, AnnotationTarget } from '@/lib/annotation-request';
import { formatClock } from '@/lib/format';

/**
 * Jump to a place in a book (a bookmark's or a note's time chip, a history span), through
 * the one play path (`usePlayBook` with `at`), whichever book is playing: a phone opens
 * the full player there (unless it is already on top); elsewhere the loaded book jumps
 * there (`seekBook`, so the Undo chip offers the way back) and plays on, and another
 * book starts in place there. Says so when the book can't start.
 */
export function useJumpTo(): (target: AnnotationTarget, position: number) => void {
  const { t } = useTranslation();
  const play = usePlayBook();
  return (target, position) => {
    play(target, { at: { position } }).catch((e: unknown) => {
      playFailedToast(e, t('annotations.jumpFailed'));
    });
  };
}

/** Put a deleted bookmark back (the delete toast's Undo): the same place, note and label
 * on the same book, through its own connection. The server gives it a new id and date
 * (an undone bookmark reads as just made). A label reaches only a server with
 * `annotations` (the one that gave it). */
function restoreBookmark(connectionId: string, bookmark: Bookmark): Promise<Bookmark> {
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
function restoreNote(connectionId: string, note: Note): Promise<Note> {
  return addNote(connectionId, note.library_id, note.path, note.body, note.position);
}

/** A bookmark delete's words (`UNDO`, and a waiting bookmark's delete). */
export const BOOKMARK_DELETE_COPY = {
  deleted: 'annotations.bookmark.deleted',
  deleteFailed: 'annotations.bookmark.deleteFailed',
  restoreFailed: 'annotations.bookmark.restoreFailed',
} as const;

/** What a delete with Undo needs per kind: its delete hook, its restore, its copy. */
const UNDO: {
  [K in keyof AnnotationOf]: {
    useDelete: typeof useDeleteBookmark;
    restore: (connectionId: string, row: AnnotationOf[K]) => Promise<unknown>;
    copy: Record<'deleted' | 'deleteFailed' | 'restoreFailed', ParseKeys>;
  };
} = {
  bookmark: {
    useDelete: useDeleteBookmark,
    restore: restoreBookmark,
    copy: BOOKMARK_DELETE_COPY,
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

/** The toast after a delete: what went, where, and Undo, which puts it back (`restore`) or
 * says it could not. Also a waiting bookmark's (`QueuedBookmarkRow`). */
export function deletedToast(
  t: TFunction,
  copy: { deleted: ParseKeys; restoreFailed: ParseKeys },
  position: number,
  restore: () => Promise<unknown>,
): void {
  toast({
    title: t(copy.deleted),
    description: formatClock(position),
    action: {
      label: t('annotations.undo'),
      onPress: () => {
        restore().catch(() => toast({ title: t(copy.restoreFailed) }));
      },
    },
  });
}

/**
 * Delete a bookmark or a note at once, with an Undo toast that puts it back
 * (`restoreBookmark`, `restoreNote`). Deleting is immediate rather than held for the
 * toast, so another device (and the pins) agree straight away and nothing waits on a
 * timer an app suspend could stop; the cost of Undo is a new date on the row. `kind` is
 * fixed for a caller (it picks the delete hook).
 */
export function useDeleteWithUndo<K extends keyof AnnotationOf>(
  kind: K,
  connectionId: string,
  libraryId: number,
  path: string,
): (row: AnnotationOf[K]) => void {
  const { t } = useTranslation();
  const { useDelete, restore, copy } = UNDO[kind];
  const del = useDelete(libraryId, path, connectionId);
  return (row) =>
    del.mutate(row.id, {
      onSuccess: () => deletedToast(t, copy, row.position, () => restore(connectionId, row)),
      onError: () => toast({ title: t(copy.deleteFailed) }),
    });
}
